import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

// Set before any import loads config/env (hoisted above the imports).
vi.hoisted(() => {
  process.env.GEMINI_API_KEY = 'test-key-for-team-suite';
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
 *  - a DM stores the owner message and the member's reply;
 *  - a Gemini failure is an honest 502 and stores NO fabricated reply;
 *  - the group channel answers only the @named member;
 *  - the CEO channel stores messages and NEVER calls the model;
 *  - discuss runs two rounds (round 2 carries the agree/challenge
 *    instruction), closes with a SYSTEM auto summary, and leaves the
 *    Decision slot empty until setDecision records a CEO message;
 *  - work items list, create, and change status;
 *  - human pacing: member replies are stored with a future visibleAt
 *    and stay out of the thread view until it passes (the view names
 *    who is pending instead); discuss replies stagger at least 4s
 *    apart in order; owner, CEO and SYSTEM messages are immediate; a
 *    failed model call leaves no message and no pending state;
 *  - model hardening: transient 503s retry (bounded at 3 attempts,
 *    with backoff) and can still land a reply, a persistent 503 ends
 *    in the honest 502, non-transient failures never retry, and a
 *    discuss isolates a member whose turns all fail, continuing with
 *    the rest and telling the summary who could not answer; only a
 *    round 1 where every member fails is a 502.
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
const geminiRequests: Array<{ system: string; contents: any[] }> = [];

const fetchMock = vi.fn(async (url: unknown, init?: { body?: string }) => {
  const u = String(url);
  if (u.includes('generativelanguage.googleapis.com')) {
    const body = JSON.parse(init?.body ?? '{}');
    const system = body.systemInstruction?.parts?.map((p: any) => p.text).join('\n') ?? '';
    geminiRequests.push({ system, contents: body.contents ?? [] });
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
});
// The suite's own HTTP client must bypass the Gemini stub below, so the
// real fetch is captured before the stub replaces the global.
const realFetch = globalThis.fetch.bind(globalThis);
vi.stubGlobal('fetch', fetchMock);

import { teamRouter } from './team.routes';
import { errorHandler } from '../middleware/error';

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

  it('runs a DM: owner message stored, member reply stored and returned', async () => {
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'DM', memberSlug: 'omar' });
    expect(threadRes.status).toBe(201);
    const threadId = threadRes.json.thread.id;

    const res = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'What breaks first if we double demo traffic?',
    });
    expect(res.status).toBe(201);
    expect(res.json.message.authorType).toBe('OWNER');
    expect(res.json.reply.authorType).toBe('MEMBER');
    expect(res.json.reply.authorSlug).toBe('omar');
    expect(res.json.reply.body).toBe('Short member reply.');
    expect(geminiRequests).toHaveLength(1);
    // The persona and the hard rules ride in the system prompt.
    expect(geminiRequests[0].system).toContain('Omar Haddad');
    expect(geminiRequests[0].system).toContain('one idea per message');
  });

  it('surfaces a Gemini failure as 502 and stores no fabricated reply', async () => {
    geminiMode = 'fail';
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'DM', memberSlug: 'priya' });
    const threadId = threadRes.json.thread.id;
    const res = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Score this idea.',
    });
    expect(res.status).toBe(502);
    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    expect(stored).toHaveLength(1);
    expect(stored[0].authorType).toBe('OWNER');
  });

  it('group channel: silence without a mention, the named member answers', async () => {
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'GROUP' });
    const threadId = threadRes.json.thread.id;

    const quiet = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Morning all, pipeline looks thin.',
    });
    expect(quiet.status).toBe(201);
    expect(quiet.json.reply).toBeUndefined();
    expect(geminiRequests).toHaveLength(0);

    const named = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: '@daniel what do the demo numbers say?',
    });
    expect(named.json.reply.authorSlug).toBe('daniel');
    expect(geminiRequests).toHaveLength(1);
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

    const messages = res.json.messages as any[];
    expect(messages[0].authorType).toBe('OWNER');
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

    // Stored right away, carrying a pacing moment inside the clamp.
    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    expect(stored).toHaveLength(2);
    const replyRow = stored.find((m) => m.authorType === 'MEMBER')!;
    expect(replyRow.visibleAt).toBeInstanceOf(Date);
    const delay = replyRow.visibleAt.getTime() - replyRow.createdAt.getTime();
    expect(delay).toBeGreaterThanOrEqual(2_500);
    expect(delay).toBeLessThanOrEqual(25_000);
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
    const view = await call('GET', `/api/admin/team/threads/${threadId}/messages`);
    expect(view.json.messages.map((m: any) => m.authorType)).toEqual(['OWNER']);
    expect(view.json.pending.memberSlugs).toEqual(['layla']);
  });

  it('human pacing: discuss replies are staggered in order, the summary is immediate', async () => {
    geminiResponder = (system) =>
      system.includes('auto summary') ? 'Positions, agreements, open questions.' : 'A short position.';
    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['omar', 'priya'],
    });
    expect(res.status).toBe(201);
    const threadId = res.json.thread.id;

    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    const memberRows = stored.filter((m) => m.authorType === 'MEMBER');
    expect(memberRows).toHaveLength(4);
    const times = memberRows.map((m) => (m.visibleAt as Date).getTime());
    for (const t of times) expect(t).toBeGreaterThan(Date.now());
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(4_000);
    }
    // The SYSTEM summary is never paced.
    const summary = stored.find((m) => m.authorType === 'SYSTEM')!;
    expect(summary.visibleAt ?? null).toBeNull();

    // In the room, only the topic and the summary show; both members
    // are named as still typing.
    const view = await call('GET', `/api/admin/team/threads/${threadId}/messages`);
    expect(view.json.messages.some((m: any) => m.authorType === 'MEMBER')).toBe(false);
    expect([...view.json.pending.memberSlugs].sort()).toEqual(['omar', 'priya']);
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
    expect(res.status).toBe(502);

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
    expect(res.json.reply.body).toBe('Short member reply.');
    // Exactly two model calls: the 503 and the retry that landed.
    expect(geminiRequests).toHaveLength(2);
    expect(db.teamMessage.filter((m) => m.threadId === threadId)).toHaveLength(2);
  }, 15_000);

  it('retry: a persistent 503 ends in an honest 502 with no stored reply', async () => {
    geminiScript = ['fail503', 'fail503', 'fail503', 'fail503'];
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'DM', memberSlug: 'priya' });
    const threadId = threadRes.json.thread.id;

    const res = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Score this idea.',
    });
    expect(res.status).toBe(502);
    // Bounded: three attempts total, then it gives up honestly.
    expect(geminiRequests).toHaveLength(3);
    const stored = db.teamMessage.filter((m) => m.threadId === threadId);
    expect(stored).toHaveLength(1);
    expect(stored[0].authorType).toBe('OWNER');
  }, 20_000);

  it('retry: a non-transient failure (500) is not retried', async () => {
    geminiMode = 'fail';
    const threadRes = await call('POST', '/api/admin/team/threads', { type: 'DM', memberSlug: 'daniel' });
    const threadId = threadRes.json.thread.id;

    const res = await call('POST', `/api/admin/team/threads/${threadId}/messages`, {
      body: 'Pipeline numbers?',
    });
    expect(res.status).toBe(502);
    expect(geminiRequests).toHaveLength(1);
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

  it('discuss isolation: every member failing round 1 is an honest 502', async () => {
    geminiFailFor = () => true;
    const res = await call('POST', '/api/admin/team/discuss', {
      topic: 'Should the demo call clinics back automatically?',
      memberSlugs: ['omar', 'priya'],
    });
    expect(res.status).toBe(502);

    const discussThreads = db.teamThread.filter((t) => t.type === 'DISCUSS');
    expect(discussThreads).toHaveLength(1);
    const stored = db.teamMessage.filter((m) => m.threadId === discussThreads[0].id);
    // Only the owner's topic is stored: no member turns, no summary.
    expect(stored.map((m) => m.authorType)).toEqual(['OWNER']);
    // Two members, three bounded attempts each, and round 2 never ran.
    expect(geminiRequests).toHaveLength(6);
  }, 30_000);

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

    const junk = await call('PATCH', `/api/admin/team/work-items/${created.json.workItem.id}`, {
      status: 'WHATEVER',
    });
    expect(junk.status).toBe(400);
  });
});
