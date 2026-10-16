import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

// Set before any import loads config/env (hoisted above the imports).
// Omar and Priya carry their own keys so the suite can see which key a
// call ran on; Daniel and Layla deliberately have none, so their calls
// fall back to the shared key.
vi.hoisted(() => {
  process.env.GEMINI_API_KEY = 'test-key-for-team-suite';
  process.env.TEAM_GEMINI_API_KEY_OMAR = 'omar-key-for-team-suite';
  process.env.TEAM_GEMINI_API_KEY_PRIYA = 'priya-key-for-team-suite';
});

/**
 * Route-level tests for the AI Team room (/api/admin/team/*). Same harness
 * as the other admin suites: an in-memory fake Prisma, mocked jwt and
 * platform-role resolution, the real teamRouter on a throwaway express
 * app over real HTTP, and a stubbed global fetch standing in for Gemini.
 *
 * Pinned behaviour:
 *  - founder gate: no token -> 401, signed-in non-admin -> 403;
 *  - members seed from the roster on first read;
 *  - posting is instant (Phase 2a): a DM or channel post returns the
 *    stored owner message as soon as it is stored, and the reply work
 *    runs in the background (the suite awaits it through awaitReply);
 *    the post provably returns while the member model is still gated;
 *  - a failed background reply stores NO fabricated reply, and the
 *    thread's in-flight signal (pending.active) clears;
 *  - the group channel floor (Phase 2a): a message naming nobody is a
 *    standup and every member answers once, failure-isolated, and
 *    standup replies never chain; a @named member answers alone, and
 *    if their reply @names another member that member answers too
 *    (handoffs), bounded at 2 hops per owner message;
 *  - the CEO channel stores messages and NEVER calls the model;
 *  - discuss runs two rounds (round 2 carries the agree/challenge
 *    instruction), closes with a SYSTEM auto summary, and leaves the
 *    Decision slot empty until setDecision records a CEO message;
 *  - discuss follow-up rounds (Phase 2a.1): an owner message in a
 *    discussion is answered in the background by the members seated
 *    in that thread (the seating is derived from who has authored
 *    there, in first-spoke order; a thread where no member has ever
 *    authored seats the whole team), one answer each, with
 *    channel-style handoffs bounded per round (2 hops, 8 member
 *    messages) and the caps resetting on every new owner message; a
 *    message posted mid-debate chains after the debate settles;
 *    follow-ups never regenerate the summary or touch the Decision
 *    slot; a round where everyone fails leaves the honest SYSTEM
 *    note and no fabricated replies; the post returns before the
 *    round completes;
 *  - work items list, create, and change status across the full
 *    lifecycle (QUEUED, ASSIGNED, IN_PROGRESS, DONE, BLOCKED);
 *  - human pacing: member replies are stored with a near-future
 *    visibleAt (a breath, never more than about two seconds) and stay
 *    out of the thread view until it passes (the view names who is
 *    pending instead); owner, CEO and SYSTEM messages are immediate;
 *    a failed model call leaves no message and no pending state;
 *  - discuss starts instantly: the start call returns the thread and
 *    the topic while the debate runs in the background (the suite
 *    awaits it through awaitDiscussion); both rounds answer in
 *    parallel from a shared snapshot per round;
 *  - model hardening: transient 503s retry (bounded at 3 attempts per
 *    key, with backoff) and can still land a reply; when a member's own
 *    key is exhausted the interactive call is retried once on the
 *    shared key (the fallback is pinned in team-gemini.test.ts), and
 *    only when both keys fail does the reply honestly not land;
 *    non-transient failures never retry, and a discuss isolates a
 *    member whose turns all fail, continuing with the rest and
 *    telling the summary who could not answer; a round 1 where every
 *    member fails leaves an honest SYSTEM note in the thread instead
 *    of a failed start;
 *  - discuss summary key: the auto summary runs on the first answering
 *    member's own key (seen on the fetch stub's x-goog-api-key header),
 *    not the shared chain, and falls back to the shared key when that
 *    member has no key of their own.
 */

type Row = Record<string, any>;

const { db, fakePrisma } = vi.hoisted(() => {
  const db: Record<string, Row[]> = {
    teamMember: [],
    teamThread: [],
    teamMessage: [],
    workItem: [],
    teamToolLog: [],
    teamDraft: [],
    teamNote: [],
    failureCase: [],
    teamPageWatch: [],
    teamRun: [],
    callLog: [],
    demoLead: [],
    demoCall: [],
    tenant: [],
    appointment: [],
  };

  let seq = 0;

  function compare(a: any, b: any): number {
    const av = a instanceof Date ? a.getTime() : a;
    const bv = b instanceof Date ? b.getTime() : b;
    if (av === bv) return 0;
    if (av === undefined || av === null) return -1;
    if (bv === undefined || bv === null) return 1;
    return av < bv ? -1 : 1;
  }

  function matches(row: Row, where: any): boolean {
    if (!where) return true;
    for (const [key, value] of Object.entries(where)) {
      if (key === 'OR') {
        if (!(value as any[]).some((sub) => matches(row, sub))) return false;
        continue;
      }
      if (key === 'AND') {
        if (!(value as any[]).every((sub) => matches(row, sub))) return false;
        continue;
      }
      const actual = row[key];
      if (value === null) {
        if (actual !== null && actual !== undefined) return false;
        continue;
      }
      if (typeof value === 'object' && !(value instanceof Date)) {
        const v = value as Record<string, any>;
        if ('in' in v) {
          if (!v.in.includes(actual)) return false;
          continue;
        }
        if ('not' in v) {
          if (v.not === null) {
            if (actual === null || actual === undefined) return false;
          } else if (typeof v.not === 'object') {
            if (matches(actual ?? {}, v.not)) return false;
          } else if (actual === v.not) return false;
          continue;
        }
        if ('gte' in v || 'gt' in v || 'lte' in v || 'lt' in v) {
          if ('gte' in v && compare(actual, v.gte) < 0) return false;
          if ('gt' in v && compare(actual, v.gt) <= 0) return false;
          if ('lte' in v && compare(actual, v.lte) > 0) return false;
          if ('lt' in v && compare(actual, v.lt) >= 0) return false;
          continue;
        }
        if ('is' in v) {
          if (v.is === null) {
            if (actual !== null && actual !== undefined) return false;
          } else if (!matches(actual ?? {}, v.is)) return false;
          continue;
        }
        if (!matches(actual ?? {}, v)) return false;
        continue;
      }
      if (actual !== value) return false;
    }
    return true;
  }

  function makeDelegate(table: string) {
    const findManyImpl = (args: any = {}) => {
      let rows = db[table].filter((row) => matches(row, args.where));
      if (args.distinct) {
        const fields = Array.isArray(args.distinct) ? args.distinct : [args.distinct];
        const seen = new Set<string>();
        rows = rows.filter((row) => {
          const key = fields.map((f: string) => String(row[f])).join('|');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      if (args.orderBy) {
        const [field, dir] = Object.entries(args.orderBy)[0] as [string, any];
        const direction = typeof dir === 'object' ? dir?.sort : dir;
        rows = [...rows].sort((a, b) => compare(a[field], b[field]) * (direction === 'desc' ? -1 : 1));
      }
      if (args.take) rows = rows.slice(0, args.take);
      return rows.map((row) => ({ ...row }));
    };
    return {
      findMany: vi.fn(async (args: any = {}) => findManyImpl(args)),
      findFirst: vi.fn(async (args: any = {}) => findManyImpl({ ...args, take: 1 })[0] ?? null),
      findUnique: vi.fn(
        async (args: any = {}) => db[table].find((row) => matches(row, args.where)) ?? null,
      ),
      create: vi.fn(async (args: any = {}) => {
        // Mirror the Prisma column defaults the services rely on.
        const defaults: Row =
          table === 'workItem'
            ? { status: 'QUEUED' }
            : table === 'teamMember'
              ? { modelConfig: 'gemini-3.8-flash' }
              : table === 'teamThread'
                ? { decision: null, decisionAt: null, contextSummary: null, memberSlug: null, topic: null }
                : {};
        const row: Row = {
          id: args.data.id ?? `id_${table}_${++seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...defaults,
          ...args.data,
        };
        db[table].push(row);
        return { ...row };
      }),
      update: vi.fn(async (args: any = {}) => {
        const row = db[table].find((r) => matches(r, args.where));
        if (!row) throw new Error(`No ${table} row to update`);
        Object.assign(row, args.data, { updatedAt: new Date() });
        return { ...row };
      }),
      upsert: vi.fn(async (args: any = {}) => {
        const existing = db[table].find((r) => matches(r, args.where));
        if (existing) {
          // Prisma ignores undefined values in an update; mirror that.
          const clean = Object.fromEntries(
            Object.entries(args.update ?? {}).filter(([, v]) => v !== undefined),
          );
          Object.assign(existing, clean, { updatedAt: new Date() });
          return { ...existing };
        }
        const defaults: Row = table === 'teamMember' ? { modelConfig: 'gemini-3.8-flash' } : {};
        const row: Row = {
          id: `id_${table}_${++seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...defaults,
          ...args.create,
        };
        db[table].push(row);
        return { ...row };
      }),
      count: vi.fn(async (args: any = {}) => db[table].filter((row) => matches(row, args.where)).length),
      aggregate: vi.fn(async (args: any = {}) => {
        const rows = db[table].filter((row) => matches(row, args.where));
        const sum: Record<string, number> = {};
        for (const field of Object.keys(args._sum ?? {})) {
          sum[field] = rows.reduce((total, row) => total + (row[field] ?? 0), 0);
        }
        return { _sum: sum, _count: rows.length };
      }),
      groupBy: vi.fn(async (args: any = {}) => {
        const rows = db[table].filter((row) => matches(row, args.where));
        const field = args.by[0];
        const groups = new Map<unknown, number>();
        for (const row of rows) groups.set(row[field], (groups.get(row[field]) ?? 0) + 1);
        return [...groups.entries()].map(([value, count]) => ({ [field]: value, _count: count }));
      }),
    };
  }

  const fakePrisma: Record<string, any> = {
    user: {
      findUnique: vi.fn(async (args: any) => {
        if (args.where.id === 'user_admin') return { email: 'founder@example.com' };
        if (args.where.id === 'user_plain') return { email: 'clinic@example.com' };
        return null;
      }),
    },
  };
  for (const table of Object.keys(db)) fakePrisma[table] = makeDelegate(table);
  return { db, fakePrisma };
});

vi.mock('../lib/prisma', () => ({ prisma: fakePrisma }));

vi.mock('../lib/jwt', () => ({
  verifyAccessToken: (token: string) => {
    if (token === 'admin-token') return { sub: 'user_admin', tid: 'tenant_platform', role: 'OWNER' };
    if (token === 'plain-token') return { sub: 'user_plain', tid: 'tenant_x', role: 'OWNER' };
    throw new Error('invalid token');
  },
}));

vi.mock('../services/platform-admin.service', () => ({
  PLATFORM_TENANT_SLUG: '__platform',
  resolvePlatformRole: async (email: string) => (email === 'founder@example.com' ? 'ADMIN' : null),
  addAdmin: vi.fn(),
  listAdmins: vi.fn().mockResolvedValue([]),
  removeAdmin: vi.fn(),
}));

/* ------------------------------ Gemini stub ----------------------------- */

let geminiMode: 'ok' | 'fail' = 'ok';
let geminiResponder: (systemText: string, contents: any[]) => string = () => 'Short member reply.';
/** One-shot scripted responses, consumed in order before anything else. */
let geminiScript: Array<'fail503'> = [];
/** Persistent 503 for any call this predicate matches (member isolation). */
let geminiFailFor: ((system: string, contents: any[]) => boolean) | null = null;
/**
 * A gate the Gemini stub waits behind, for the deferred-model test:
 * while it is set, no model call completes until it is released.
 */
let geminiGate: Promise<void> | null = null;
let releaseGeminiGate: (() => void) | null = null;
const geminiRequests: Array<{ system: string; contents: any[]; apiKey: string | undefined }> = [];

const fetchMock = vi.fn(
  async (url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      if (geminiGate) await geminiGate;
      const body = JSON.parse(init?.body ?? '{}');
      const system = body.systemInstruction?.parts?.map((p: any) => p.text).join('\n') ?? '';
      geminiRequests.push({
        system,
        contents: body.contents ?? [],
        apiKey: init?.headers?.['x-goog-api-key'],
      });
      const scripted = geminiScript.length > 0 ? geminiScript.shift() : null;
      if (
        scripted === 'fail503' ||
        (geminiFailFor !== null && geminiFailFor(system, body.contents ?? []))
      ) {
        return {
          ok: false,
          status: 503,
          text: async () => 'This model is currently experiencing high demand',
          json: async () => ({}),
        };
      }
      if (geminiMode === 'fail') {
        return { ok: false, status: 500, text: async () => 'upstream down', json: async () => ({}) };
      }
      const text = geminiResponder(system, body.contents ?? []);
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
        text: async () => '',
      };
    }
    return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) };
  },
);
// The suite's own HTTP client must bypass the Gemini stub below, so the
// real fetch is captured before the stub replaces the global.
const realFetch = globalThis.fetch.bind(globalThis);
vi.stubGlobal('fetch', fetchMock);

import { teamRouter } from './team.routes';
import { errorHandler } from '../middleware/error';
import { awaitDiscussion, awaitReply } from '../services/team.service';

let server: Server;
let base = '';

async function call(
  method: string,
  path: string,
  body?: unknown,
  token = 'admin-token',
): Promise<{ status: number; json: any }> {
  const res = await realFetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', teamRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  for (const table of Object.keys(db)) db[table] = [];
  geminiRequests.length = 0;
  geminiMode = 'ok';
  geminiScript = [];
  geminiFailFor = null;
  geminiGate = null;
  releaseGeminiGate = null;
  geminiResponder = () => 'Short member reply.';
  fetchMock.mockClear();
});

describe('AI Team routes', () => {
  it('rejects requests with no token (401) and non-admins (403)', async () => {
    const noToken = await call('GET', '/api/admin/team/members', undefined, '');
    expect(noToken.status).toBe(401);
    const plain = await call('GET', '/api/admin/team/members', undefined, 'plain-token');
    expect(plain.status).toBe(403);
  });

  it('seeds and returns the four members', async () => {
    const res = await call('GET', '/api/admin/team/members');
    expect(res.status).toBe(200);
    expect(res.json.members.map((m: any) => m.slug)).toEqual(['omar', 'priya', 'daniel', 'layla']);
    expect(res.json.members[0].modelConfig).toBe('gemini-3.8-flash');
    // Seeding is idempotent: a second read creates no duplicates.
    await call('GET', '/api/admin/team/members');
    expect(db.teamMember).toHaveLength(4);
  });

  it('runs a DM: the post returns the stored message, the reply lands in the background', async () => {
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'DM', memberSlug: 'omar' });
    expect(threadRes.status).toBe(201);
    const threadId = threadRes.json.thread.id;

    const res = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'What breaks first if we double demo traffic?',
    });
    expect(res.status).toBe(201);
    expect(res.json.message.authorType).toBe('OWNER');
    // Posting no longer waits for the reply: none comes back with it.
    expect(res.json.reply).toBeUndefined();

    await awaitReply(threadId);
    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    expect(stored).toHaveLength(2);
    const reply = stored.find((m) => m.authorType === 'MEMBER')!;
    expect(reply.authorSlug).toBe('omar');
    expect(reply.body).toBe('Short member reply.');
    expect(geminiRequests).toHaveLength(1);
    // The persona and the hard rules ride in the system prompt.
    expect(geminiRequests[0].system).toContain('Omar Haddad');
    expect(geminiRequests[0].system).toContain('one idea per message');
  });

  it('a failed background reply stores no fabricated reply, and the post itself still succeeds', async () => {
    geminiMode = 'fail';
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'DM', memberSlug: 'priya' });
    const threadId = threadRes.json.thread.id;
    const res = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Score this idea.',
    });
    expect(res.status).toBe(201);
    await awaitReply(threadId);
    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    expect(stored).toHaveLength(1);
    expect(stored[0].authorType).toBe('OWNER');
    // The in-flight signal cleared with the failed run.
    const view = await call('GET', `/api/admin/team/threads/${threadId}/messages`);
    expect(view.json.pending.active).toBe(false);
  });

  it('the post provably returns before the reply: the model is gated, the post still lands', async () => {
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'GROUP' });
    const threadId = threadRes.json.thread.id;

    geminiGate = new Promise<void>((resolve) => {
      releaseGeminiGate = resolve;
    });
    const postPromise = call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: '@omar are you there?',
    });
    const outcome = await Promise.race([
      postPromise.then(() => 'returned'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1_000)),
    ]);
    // The model has not answered anything (it cannot, it is gated),
    // yet the post already returned with the message stored.
    expect(outcome).toBe('returned');
    const res = await postPromise;
    expect(res.status).toBe(201);
    expect(db.teamMessage.filter((m) => m.threadId === threadId)).toHaveLength(1);
    // While the reply is in flight the thread says so.
    const view = await call('GET', `/api/admin/team/threads/${threadId}/messages`);
    expect(view.json.pending.active).toBe(true);

    releaseGeminiGate!();
    geminiGate = null;
    await awaitReply(threadId);
    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    expect(stored).toHaveLength(2);
    expect(stored[1].authorSlug).toBe('omar');
  }, 15_000);

  it('group channel: no mention is a standup, every member answers once; a mention wakes one', async () => {
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'GROUP' });
    const threadId = threadRes.json.thread.id;

    const standup = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Morning all, pipeline looks thin.',
    });
    expect(standup.status).toBe(201);
    expect(standup.json.reply).toBeUndefined();
    await awaitReply(threadId);
    const afterStandup = db.teamMessage.filter((m) => m.threadId === threadId);
    const standupReplies = afterStandup.filter((m) => m.authorType === 'MEMBER');
    expect(standupReplies.map((m) => m.authorSlug)).toEqual(['omar', 'priya', 'daniel', 'layla']);
    expect(geminiRequests).toHaveLength(4);

    const named = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: '@daniel what do the demo numbers say?',
    });
    expect(named.status).toBe(201);
    await awaitReply(threadId);
    const afterNamed = db.teamMessage.filter((m) => m.threadId === threadId);
    expect(afterNamed.filter((m) => m.authorType === 'MEMBER')).toHaveLength(5);
    expect(afterNamed[afterNamed.length - 1].authorSlug).toBe('daniel');
    expect(geminiRequests).toHaveLength(5);
  });

  it('group standup: one member failing does not block the others', async () => {
    geminiFailFor = (system) => system.includes('Priya Nair');
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'GROUP' });
    const threadId = threadRes.json.thread.id;

    await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Standup, everyone.',
    });
    await awaitReply(threadId);
    const replies = db.teamMessage.filter(
      (m) => m.threadId === threadId && m.authorType === 'MEMBER',
    );
    expect(replies.map((m) => m.authorSlug)).toEqual(['omar', 'daniel', 'layla']);
  }, 30_000);

  it('group handoffs: a reply naming the next member hands off, and the chain stops at two hops', async () => {
    geminiResponder = (system) => {
      if (system.includes('Omar Haddad')) return '@priya over to you.';
      if (system.includes('Priya Nair')) return '@daniel your turn.';
      if (system.includes('Daniel Osei')) return '@layla wrap it up.';
      return 'Done.';
    };
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'GROUP' });
    const threadId = threadRes.json.thread.id;

    await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: '@omar kick this off.',
    });
    await awaitReply(threadId);
    const replies = db.teamMessage.filter(
      (m) => m.threadId === threadId && m.authorType === 'MEMBER',
    );
    // Omar (the mention), Priya (hop 1), Daniel (hop 2). Daniel naming
    // Layla would be hop 3: the cap cuts it, Layla never answers.
    expect(replies.map((m) => m.authorSlug)).toEqual(['omar', 'priya', 'daniel']);
    expect(geminiRequests).toHaveLength(3);
  });

  it('group standup replies never chain into handoffs', async () => {
    geminiResponder = (system) =>
      system.includes('Omar Haddad') ? '@priya look at this.' : 'Noted.';
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'GROUP' });
    const threadId = threadRes.json.thread.id;

    await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Quick standup.',
    });
    await awaitReply(threadId);
    const replies = db.teamMessage.filter(
      (m) => m.threadId === threadId && m.authorType === 'MEMBER',
    );
    // Exactly the four standup replies: Omar naming Priya did not earn
    // her a second turn.
    expect(replies).toHaveLength(4);
    expect(replies.filter((m) => m.authorSlug === 'priya')).toHaveLength(1);
  });

  it('CEO channel stores messages and never calls the model', async () => {
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'CEO' });
    const threadId = threadRes.json.thread.id;

    const res = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Cleo, decide the pricing page headline this week.',
    });
    expect(res.status).toBe(201);
    expect(res.json.reply).toBeUndefined();
    expect(geminiRequests).toHaveLength(0);

    const ceoReply = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Decided: keep the current headline.',
      authorType: 'CEO',
    });
    expect(ceoReply.status).toBe(201);
    expect(ceoReply.json.message.authorType).toBe('CEO');
    expect(geminiRequests).toHaveLength(0);
  });

  it('discuss: two rounds, agree/challenge in round 2, SYSTEM summary, empty decision', async () => {
    geminiResponder = (system) =>
      system.includes('auto summary') ? 'Positions, agreements, open questions.' : 'A short position.';
    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['omar', 'priya'],
    });
    expect(res.status).toBe(201);
    const thread = res.json.thread;
    expect(thread.type).toBe('DISCUSS');
    expect(thread.decision).toBeNull();

    // The start returns the moment the topic is stored; the debate
    // itself runs in the background and is awaited here.
    const startMessages = res.json.messages as any[];
    expect(startMessages).toHaveLength(1);
    expect(startMessages[0].authorType).toBe('OWNER');
    await awaitDiscussion(thread.id);

    const messages = db.teamMessage.filter((m) => m.threadId === thread.id);
    const memberMessages = messages.filter((m) => m.authorType === 'MEMBER');
    expect(memberMessages).toHaveLength(4); // 2 members x 2 rounds
    const summary = messages[messages.length - 1];
    expect(summary.authorType).toBe('SYSTEM');
    expect(summary.label).toBe('AUTO_SUMMARY');

    // Round 2 prompts must carry the agree/challenge instruction.
    const round2 = geminiRequests.filter((req) =>
      JSON.stringify(req.contents).includes('challenge'),
    );
    expect(round2.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(round2[0].contents)).toContain('agree');

    // The decision slot fills only through the decision endpoint (a CEO
    // authored message), never from the discussion itself.
    const decision = await call('POST', `/api/admin/team/threads/${thread.id}/decision`, {
      decision: 'No automatic callbacks. The demo stays visitor-initiated.',
    });
    expect(decision.status).toBe(200);
    expect(decision.json.thread.decision).toContain('No automatic callbacks');
    const stored = db.teamMessage.filter((m) => m.threadId === thread.id);
    expect(stored.some((m) => m.authorType === 'CEO')).toBe(true);
  });

  it('human pacing: a DM reply is hidden until visibleAt, pending names the member', async () => {
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'DM', memberSlug: 'omar' });
    const threadId = threadRes.json.thread.id;

    const res = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'How long to ship the fix?',
    });
    expect(res.status).toBe(201);
    await awaitReply(threadId);

    // Stored right away, carrying a pacing moment inside the clamp.
    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    expect(stored).toHaveLength(2);
    const replyRow = stored.find((m) => m.authorType === 'MEMBER')!;
    expect(replyRow.visibleAt).toBeInstanceOf(Date);
    const delay = replyRow.visibleAt.getTime() - replyRow.createdAt.getTime();
    expect(delay).toBeGreaterThanOrEqual(400);
    expect(delay).toBeLessThanOrEqual(2_000);
    // The owner message itself is never paced.
    expect(stored.find((m) => m.authorType === 'OWNER')!.visibleAt ?? null).toBeNull();

    // Before visibleAt: the reply is absent and the pending indicator
    // names Omar and points at the reply's own visibleAt.
    const before = await call('GET', `/api/admin/team/threads/${threadId}/messages`);
    expect(before.json.messages.map((m: any) => m.authorType)).toEqual(['OWNER']);
    expect(before.json.pending.memberSlugs).toEqual(['omar']);
    expect(new Date(before.json.pending.nextVisibleAt).getTime()).toBe(replyRow.visibleAt.getTime());

    // Once the moment passes, the reply appears and nothing is pending.
    replyRow.visibleAt = new Date(Date.now() - 1_000);
    const after = await call('GET', `/api/admin/team/threads/${threadId}/messages`);
    expect(after.json.messages.map((m: any) => m.authorType)).toEqual(['OWNER', 'MEMBER']);
    expect(after.json.pending.memberSlugs).toEqual([]);
    expect(after.json.pending.nextVisibleAt).toBeNull();
  });

  it('human pacing: a group reply pends for the named member only', async () => {
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'GROUP' });
    const threadId = threadRes.json.thread.id;

    await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: '@layla what does the research say?',
    });
    await awaitReply(threadId);
    const view = await call('GET', `/api/admin/team/threads/${threadId}/messages`);
    expect(view.json.messages.map((m: any) => m.authorType)).toEqual(['OWNER']);
    expect(view.json.pending.memberSlugs).toEqual(['layla']);
  });

  it('human pacing: discuss replies land within about two seconds, the summary is immediate', async () => {
    geminiResponder = (system) =>
      system.includes('auto summary') ? 'Positions, agreements, open questions.' : 'A short position.';
    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['omar', 'priya'],
    });
    expect(res.status).toBe(201);
    const threadId = res.json.thread.id;
    await awaitDiscussion(threadId);

    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    const memberRows = stored.filter((m) => m.authorType === 'MEMBER');
    expect(memberRows).toHaveLength(4);
    // Every reply's pacing delay is a breath: at least a beat, never
    // more than about two seconds past its own store moment.
    for (const row of memberRows) {
      const delay = (row.visibleAt as Date).getTime() - row.createdAt.getTime();
      expect(delay).toBeGreaterThanOrEqual(400);
      expect(delay).toBeLessThanOrEqual(2_000);
    }
    // The SYSTEM summary is never paced.
    const summary = stored.find((m) => m.authorType === 'SYSTEM')!;
    expect(summary.visibleAt ?? null).toBeNull();

    // In the room right after the run, the member replies are still a
    // breath away; both members are named as typing, and the debate
    // itself is over (no longer active).
    const view = await call('GET', `/api/admin/team/threads/${threadId}/messages`);
    expect(view.json.messages.some((m: any) => m.authorType === 'MEMBER')).toBe(false);
    expect([...view.json.pending.memberSlugs].sort()).toEqual(['omar', 'priya']);
    expect(view.json.pending.active).toBe(false);
  });

  it('human pacing: CEO channel messages are immediate and never pending', async () => {
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'CEO' });
    const threadId = threadRes.json.thread.id;

    await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Cleo, decide the pricing page headline this week.',
    });
    await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Decided: keep the current headline.',
      authorType: 'CEO',
    });

    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    expect(stored).toHaveLength(2);
    for (const row of stored) expect(row.visibleAt ?? null).toBeNull();

    const view = await call('GET', `/api/admin/team/threads/${threadId}/messages`);
    expect(view.json.messages).toHaveLength(2);
    expect(view.json.pending.memberSlugs).toEqual([]);
    expect(view.json.pending.nextVisibleAt).toBeNull();
    // The channel still never touches the model.
    expect(geminiRequests).toHaveLength(0);
  });

  it('human pacing: a failed model call leaves no message and no pending state', async () => {
    geminiMode = 'fail';
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'DM', memberSlug: 'priya' });
    const threadId = threadRes.json.thread.id;
    const res = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Score this idea.',
    });
    // The post lands; the background reply is what fails.
    expect(res.status).toBe(201);
    await awaitReply(threadId);

    const view = await call('GET', `/api/admin/team/threads/${threadId}/messages`);
    expect(view.json.messages.map((m: any) => m.authorType)).toEqual(['OWNER']);
    expect(view.json.pending.memberSlugs).toEqual([]);
    expect(view.json.pending.nextVisibleAt).toBeNull();
  });

  it('retry: a 503 then a success still answers the DM', async () => {
    geminiScript = ['fail503'];
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'DM', memberSlug: 'omar' });
    const threadId = threadRes.json.thread.id;

    const res = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Status on the fix?',
    });
    expect(res.status).toBe(201);
    await awaitReply(threadId);
    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    expect(stored).toHaveLength(2);
    expect(stored[1].body).toBe('Short member reply.');
    // Exactly two model calls: the 503 and the retry that landed.
    expect(geminiRequests).toHaveLength(2);
  }, 15_000);

  it('retry: a persistent 503 on both keys stores no reply after the bounded attempts and the fallback pass', async () => {
    geminiFailFor = () => true;
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'DM', memberSlug: 'priya' });
    const threadId = threadRes.json.thread.id;

    const res = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Score this idea.',
    });
    expect(res.status).toBe(201);
    await awaitReply(threadId);
    // Bounded: three attempts on Priya's own key, then the shared-key
    // fallback pass of three more, then it gives up honestly.
    expect(geminiRequests).toHaveLength(6);
    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    expect(stored).toHaveLength(1);
    expect(stored[0].authorType).toBe('OWNER');
  }, 30_000);

  it('retry: a non-transient failure (500) is not retried', async () => {
    geminiMode = 'fail';
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'DM', memberSlug: 'daniel' });
    const threadId = threadRes.json.thread.id;

    const res = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Pipeline numbers?',
    });
    expect(res.status).toBe(201);
    await awaitReply(threadId);
    expect(geminiRequests).toHaveLength(1);
    expect(db.teamMessage.filter((m) => m.threadId === threadId)).toHaveLength(1);
  });

  it('discuss isolation: one member failing every turn does not kill the discussion', async () => {
    geminiResponder = (system) =>
      system.includes('auto summary') ? 'Positions and open questions.' : 'A short position.';
    // Priya's model is down hard: every one of her calls 503s, retries
    // included. Omar's calls are untouched (her name is only in her own
    // persona prompt, which is what the predicate keys on).
    geminiFailFor = (system) => system.includes('Priya Nair');

    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['omar', 'priya'],
    });
    expect(res.status).toBe(201);
    expect(res.json.thread.decision).toBeNull();
    const threadId = res.json.thread.id;
    await awaitDiscussion(threadId);

    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    const memberRows = stored.filter((m) => m.authorType === 'MEMBER');
    // Omar answered both rounds; Priya simply has no message.
    expect(memberRows).toHaveLength(2);
    expect(memberRows.every((m) => m.authorSlug === 'omar')).toBe(true);
    const summary = stored.find((m) => m.authorType === 'SYSTEM');
    expect(summary?.label).toBe('AUTO_SUMMARY');

    // The summary step was told, in its input, that Priya could not answer.
    const summaryCall = geminiRequests.find((r) => r.system.includes('auto summary'));
    expect(summaryCall).toBeDefined();
    expect(JSON.stringify(summaryCall!.contents)).toContain('Priya Nair could not answer');
  }, 30_000);

  it("discuss summary key: the summary runs on the first answering member's own key", async () => {
    geminiResponder = (system) =>
      system.includes('auto summary') ? 'Positions and open questions.' : 'A short position.';
    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['omar', 'priya'],
    });
    expect(res.status).toBe(201);
    await awaitDiscussion(res.json.thread.id);

    // Both members answered and Omar is seated first, so the summary
    // borrows his key rather than running on the shared chain.
    const summaryCall = geminiRequests.find((r) => r.system.includes('auto summary'));
    expect(summaryCall).toBeDefined();
    expect(summaryCall!.apiKey).toBe('omar-key-for-team-suite');
    // Sanity: the members' own turns ran on their own keys.
    expect(geminiRequests.find((r) => r.system.includes('Omar Haddad'))!.apiKey).toBe(
      'omar-key-for-team-suite',
    );
    expect(geminiRequests.find((r) => r.system.includes('Priya Nair'))!.apiKey).toBe(
      'priya-key-for-team-suite',
    );
  });

  it('discuss summary key: falls back to the shared key when the answering member has none of their own', async () => {
    geminiResponder = (system) =>
      system.includes('auto summary') ? 'Positions and open questions.' : 'A short position.';
    // Omar is seated first but his model is down for every turn; Layla
    // answers both rounds. The summary borrows the first answerer, who
    // is Layla, and Layla has no key of her own in this suite, so the
    // summary lands on the shared key, never on the failed seat's key.
    geminiFailFor = (system) => system.includes('Omar Haddad');

    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['omar', 'layla'],
    });
    expect(res.status).toBe(201);
    await awaitDiscussion(res.json.thread.id);

    const summaryCall = geminiRequests.find((r) => r.system.includes('auto summary'));
    expect(summaryCall).toBeDefined();
    expect(summaryCall!.apiKey).toBe('test-key-for-team-suite');
    // Layla's own turns ran on the shared chain too (no key of her own).
    const laylaCall = geminiRequests.find((r) => r.system.includes('Layla Mansour'));
    expect(laylaCall).toBeDefined();
    expect(laylaCall!.apiKey).toBe('test-key-for-team-suite');
  }, 30_000);

  it('discuss isolation: every member failing round 1 leaves an honest note in the thread', async () => {
    geminiFailFor = () => true;
    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['omar', 'priya'],
    });
    // The start itself succeeds; the failure surfaces in the thread.
    expect(res.status).toBe(201);
    const threadId = res.json.thread.id;
    await awaitDiscussion(threadId);

    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    // The topic, then a plain SYSTEM note: no member turns, no summary.
    expect(stored.map((m) => m.authorType)).toEqual(['OWNER', 'SYSTEM']);
    expect(stored[1].body).toContain('could answer just now');
    expect(stored[1].label ?? null).toBeNull();
    // Two members, three bounded attempts each on their own key plus
    // the shared-key fallback pass of three more (every key is failing
    // here), and round 2 never ran.
    expect(geminiRequests).toHaveLength(12);
  }, 60_000);

  it('discuss follow-up: after the debate, the owner talks back and the seated members answer', async () => {
    geminiResponder = (system) =>
      system.includes('auto summary') ? 'Positions, agreements, open questions.' : 'A short position.';
    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['daniel', 'omar'],
    });
    expect(res.status).toBe(201);
    const threadId = res.json.thread.id;
    await awaitDiscussion(threadId);

    const before = db.teamMessage.filter((m) => m.threadId === threadId);
    // The seating derivation, mirrored from the stored thread: the
    // members who have spoken here, in the order they first spoke.
    const seatedOrder: string[] = [];
    for (const m of before) {
      if (m.authorType === 'MEMBER' && m.authorSlug && !seatedOrder.includes(m.authorSlug)) {
        seatedOrder.push(m.authorSlug);
      }
    }
    expect(seatedOrder).toHaveLength(2);

    const post = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'And what about clinics that never pick up the first call?',
    });
    expect(post.status).toBe(201);
    expect(post.json.reply).toBeUndefined();
    await awaitReply(threadId);

    const after = db.teamMessage.filter((m) => m.threadId === threadId);
    const ownerIndex = after.findIndex(
      (m) => m.authorType === 'OWNER' && m.body.startsWith('And what about'),
    );
    const roundReplies = after.slice(ownerIndex + 1).filter((m) => m.authorType === 'MEMBER');
    // Exactly one answer per seated member, in thread order. Priya
    // and Layla never spoke in this thread, so they are not seated
    // and do not answer.
    expect(roundReplies.map((m) => m.authorSlug)).toEqual(seatedOrder);
    // A follow-up round is conversation, not a new verdict: the
    // formal summary is not regenerated and the Decision slot is
    // untouched.
    expect(after.filter((m) => m.label === 'AUTO_SUMMARY')).toHaveLength(1);
    expect(db.teamThread.find((t) => t.id === threadId)?.decision).toBeNull();
  });

  it('discuss follow-up: the per-round caps bind, and the next owner message resets them', async () => {
    // Every member's reply names the next member, so handoff chains
    // keep spending the round's message budget until the cap cuts in.
    geminiResponder = (system) => {
      if (system.includes('auto summary')) return 'Positions and open questions.';
      if (system.includes('Omar Haddad')) return '@priya your take.';
      if (system.includes('Priya Nair')) return '@daniel your take.';
      if (system.includes('Daniel Osei')) return '@layla your take.';
      if (system.includes('Layla Mansour')) return '@omar your take.';
      return 'Noted.';
    };
    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Where does the first clinic stall?',
    });
    expect(res.status).toBe(201);
    const threadId = res.json.thread.id;
    await awaitDiscussion(threadId);

    const memberCount = () =>
      db.teamMessage.filter((m) => m.threadId === threadId && m.authorType === 'MEMBER').length;
    const baseline = memberCount();
    expect(baseline).toBe(8); // 4 members x 2 debate rounds

    await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Keep going, all of you.',
    });
    await awaitReply(threadId);
    // The round's budget is 8 member messages: base answers plus
    // handoffs spend it down and the round stops there, one seated
    // member never gets a base turn.
    expect(memberCount() - baseline).toBe(8);

    await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'One more round.',
    });
    await awaitReply(threadId);
    // The founder's rule: a fresh owner message starts a fresh round
    // with a fresh budget, so the room answers fully again instead
    // of staying capped by the earlier round's traffic.
    expect(memberCount() - baseline).toBe(16);
  }, 30_000);

  it('discuss follow-up: an owner message posted mid-debate is answered after the debate settles', async () => {
    geminiResponder = (system) =>
      system.includes('auto summary') ? 'Positions and open questions.' : 'A short position.';
    geminiGate = new Promise<void>((resolve) => {
      releaseGeminiGate = resolve;
    });
    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['omar', 'priya'],
    });
    expect(res.status).toBe(201);
    const threadId = res.json.thread.id;

    // The debate is gated mid-flight; the owner's follow-up still
    // posts instantly and is stored, never dropped.
    const post = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'One more angle: what about weekends?',
    });
    expect(post.status).toBe(201);
    expect(
      db.teamMessage.filter((m) => m.threadId === threadId && m.authorType === 'OWNER'),
    ).toHaveLength(2);

    releaseGeminiGate!();
    geminiGate = null;
    await awaitDiscussion(threadId);
    await awaitReply(threadId);

    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    const summaryIndex = stored.findIndex((m) => m.label === 'AUTO_SUMMARY');
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    // The debate ran whole: its four member turns all land before
    // the summary, nothing interleaved with them.
    const debateMembers = stored.slice(0, summaryIndex).filter((m) => m.authorType === 'MEMBER');
    expect(debateMembers).toHaveLength(4);
    // The follow-up round ran after the debate settled: one answer
    // per seated member, stored after the summary.
    const roundReplies = stored.slice(summaryIndex + 1).filter((m) => m.authorType === 'MEMBER');
    expect(roundReplies.map((m) => m.authorSlug).sort()).toEqual(['omar', 'priya']);
  }, 15_000);

  it('discuss follow-up: every member failing leaves the honest note and no fake replies', async () => {
    geminiResponder = (system) =>
      system.includes('auto summary') ? 'Positions and open questions.' : 'A short position.';
    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['omar', 'priya'],
    });
    const threadId = res.json.thread.id;
    await awaitDiscussion(threadId);
    const baseline = db.teamMessage.filter((m) => m.threadId === threadId).length;

    geminiFailFor = () => true;
    const post = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Are you still there?',
    });
    expect(post.status).toBe(201);
    await awaitReply(threadId);

    const after = db.teamMessage.filter((m) => m.threadId === threadId);
    const newRows = after.slice(baseline);
    // The owner's message, then one honest SYSTEM note. No member
    // reply was fabricated out of the failures.
    expect(newRows.map((m) => m.authorType)).toEqual(['OWNER', 'SYSTEM']);
    expect(newRows[1].body).toContain('could answer just now');
    expect(newRows[1].label ?? null).toBeNull();
  }, 60_000);

  it('discuss follow-up: the post returns before the round completes (the model is gated)', async () => {
    geminiResponder = (system) =>
      system.includes('auto summary') ? 'Positions and open questions.' : 'A short position.';
    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['omar', 'priya'],
    });
    const threadId = res.json.thread.id;
    await awaitDiscussion(threadId);

    geminiGate = new Promise<void>((resolve) => {
      releaseGeminiGate = resolve;
    });
    const postPromise = call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Final word, each of you?',
    });
    const outcome = await Promise.race([
      postPromise.then(() => 'returned'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1_000)),
    ]);
    // The model has answered nothing (it cannot, it is gated), yet
    // the post already returned with the message stored.
    expect(outcome).toBe('returned');
    const post = await postPromise;
    expect(post.status).toBe(201);
    // While the round is in flight the thread says so, through the
    // same pending signal the typing UI already reads.
    const view = await call('GET', `/api/admin/team/threads/${threadId}/messages`);
    expect(view.json.pending.active).toBe(true);

    releaseGeminiGate!();
    geminiGate = null;
    await awaitReply(threadId);
    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    const ownerIndex = stored.findIndex(
      (m) => m.authorType === 'OWNER' && m.body.startsWith('Final word'),
    );
    const roundReplies = stored.slice(ownerIndex + 1).filter((m) => m.authorType === 'MEMBER');
    expect(roundReplies.map((m) => m.authorSlug).sort()).toEqual(['omar', 'priya']);
  }, 15_000);

  it('discuss follow-up: a thread where nobody ever spoke seats the whole team', async () => {
    // The debate dies at the door: every member fails round 1, so no
    // member has ever authored a message in this thread.
    geminiFailFor = () => true;
    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['omar', 'priya'],
    });
    expect(res.status).toBe(201);
    const threadId = res.json.thread.id;
    await awaitDiscussion(threadId);
    expect(
      db.teamMessage.filter((m) => m.threadId === threadId && m.authorType === 'MEMBER'),
    ).toHaveLength(0);

    geminiFailFor = null;
    const post = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Trying again: where does the first clinic stall?',
    });
    expect(post.status).toBe(201);
    await awaitReply(threadId);
    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    const ownerIndex = stored.findIndex(
      (m) => m.authorType === 'OWNER' && m.body.startsWith('Trying again'),
    );
    const roundReplies = stored.slice(ownerIndex + 1).filter((m) => m.authorType === 'MEMBER');
    // With no authorship to derive seating from, the whole team is
    // seated, in team order, including the two members the debate
    // itself never seated.
    expect(roundReplies.map((m) => m.authorSlug)).toEqual(['omar', 'priya', 'daniel', 'layla']);
  }, 60_000);

  it('work items: create, list, and move status', async () => {
    await call('GET', '/api/admin/team/members');
    const created = await call('POST', '/api/admin/team/work-items', {
      title: 'Write the recall-campaign pre-mortem',
      ownerSlug: 'priya',
    });
    expect(created.status).toBe(201);
    expect(created.json.workItem.status).toBe('QUEUED');

    const list = await call('GET', '/api/admin/team/work-items');
    expect(list.json.workItems).toHaveLength(1);

    const moved = await call('PATCH', `/api/admin/team/work-items/${created.json.workItem.id}`, {
      status: 'IN_PROGRESS',
    });
    expect(moved.json.workItem.status).toBe('IN_PROGRESS');

    // The Phase 2a lifecycle values move through the same endpoint.
    const assigned = await call('PATCH', `/api/admin/team/work-items/${created.json.workItem.id}`, {
      status: 'ASSIGNED',
    });
    expect(assigned.json.workItem.status).toBe('ASSIGNED');
    const blocked = await call('PATCH', `/api/admin/team/work-items/${created.json.workItem.id}`, {
      status: 'BLOCKED',
    });
    expect(blocked.json.workItem.status).toBe('BLOCKED');

    const junk = await call('PATCH', `/api/admin/team/work-items/${created.json.workItem.id}`, {
      status: 'WHATEVER',
    });
    expect(junk.status).toBe(400);
  });
});
