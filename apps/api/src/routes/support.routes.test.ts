import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route tests for the in-app support agent (POST /api/support/chat and
 * /api/support/apply). The DB and the two side-effecting services (Vapi
 * sync, audit log) are faked; the Gemini endpoint is stubbed with a scripted
 * sequence of model responses so the real tool loop runs end to end.
 * JWT signing/verification is the app's real code.
 */

const state = vi.hoisted(() => {
  process.env.GEMINI_API_KEY = 'test-gemini-key';

  interface FakeSettings {
    tenantId: string;
    displayName: string;
    businessHours: unknown;
    timezone: string;
    inboundPhoneNumber: string | null;
  }
  interface FakeTenant {
    id: string;
    companyName: string;
    industry: string;
    subscriptionStatus: string;
    monthlyMinuteLimit: number;
  }
  interface FakeUser {
    id: string;
    tenantId: string;
    email: string;
    role: string;
  }
  interface FakeCall {
    id: string;
    tenantId: string;
    startedAt: Date;
    callerNumber: string | null;
    channel: string;
    status: string;
    outcome: string | null;
    intent: string | null;
    summary: string | null;
    durationSeconds: number;
    successScore: number | null;
    structuredData: unknown;
  }
  interface FakeTicket {
    id: string;
    tenantId: string;
    createdByUserId: string;
    category: string;
    subject: string;
    details: string;
    callLogId: string | null;
    status: string;
  }

  const defaultHours = () => ({
    mon: { enabled: true, open: '08:00', close: '17:00' },
    tue: { enabled: true, open: '08:00', close: '17:00' },
    wed: { enabled: true, open: '08:00', close: '17:00' },
    thu: { enabled: true, open: '08:00', close: '17:00' },
    fri: { enabled: true, open: '08:00', close: '17:00' },
    sat: { enabled: false, open: '09:00', close: '13:00' },
    sun: { enabled: false, open: '09:00', close: '13:00' },
  });

  const tenants = new Map<string, FakeTenant>();
  const settings = new Map<string, FakeSettings>();
  const users = new Map<string, FakeUser>();
  const calls = new Map<string, FakeCall>();
  const tickets: FakeTicket[] = [];
  let ticketSeq = 0;
  const auditCalls: Array<{ email: string; action: string; target: string | null; detail: unknown }> = [];
  const geminiScript: unknown[] = [];
  const geminiRequests: Array<{ contents: unknown; systemInstruction?: { parts: Array<{ text: string }> } }> = [];

  function seed() {
    tenants.clear();
    settings.clear();
    users.clear();
    calls.clear();
    tickets.length = 0;
    ticketSeq = 0;
    auditCalls.length = 0;
    geminiScript.length = 0;
    geminiRequests.length = 0;

    tenants.set('tenant_a', {
      id: 'tenant_a', companyName: 'Alpha Dental', industry: 'CLINIC',
      subscriptionStatus: 'ACTIVE', monthlyMinuteLimit: 950,
    });
    tenants.set('tenant_b', {
      id: 'tenant_b', companyName: 'Beta Dental', industry: 'CLINIC',
      subscriptionStatus: 'TRIALING', monthlyMinuteLimit: 300,
    });
    settings.set('tenant_a', {
      tenantId: 'tenant_a', displayName: 'Maya', businessHours: defaultHours(),
      timezone: 'America/Toronto', inboundPhoneNumber: '+14165550100',
    });
    settings.set('tenant_b', {
      tenantId: 'tenant_b', displayName: 'Ava', businessHours: defaultHours(),
      timezone: 'America/Vancouver', inboundPhoneNumber: '+16045550199',
    });
    users.set('user_a', { id: 'user_a', tenantId: 'tenant_a', email: 'owner@alpha.test', role: 'OWNER' });
    users.set('user_a_agent', { id: 'user_a_agent', tenantId: 'tenant_a', email: 'staff@alpha.test', role: 'AGENT' });
    users.set('user_b', { id: 'user_b', tenantId: 'tenant_b', email: 'owner@beta.test', role: 'OWNER' });

    calls.set('call_a1', {
      id: 'call_a1', tenantId: 'tenant_a', startedAt: new Date('2026-10-14T19:42:00Z'),
      callerNumber: '+14165550123', channel: 'phone', status: 'COMPLETED', outcome: 'BOOKED',
      intent: 'BOOK', summary: 'Booked a cleaning for next week.', durationSeconds: 184,
      successScore: 4, structuredData: { callerName: 'Jamie Lee' },
    });
    calls.set('call_a2', {
      id: 'call_a2', tenantId: 'tenant_a', startedAt: new Date('2026-10-13T15:05:00Z'),
      callerNumber: '+14165550177', channel: 'phone', status: 'COMPLETED', outcome: 'MESSAGE_TAKEN',
      intent: 'QUESTION', summary: 'Asked about parking.', durationSeconds: 62,
      successScore: 8, structuredData: { callerName: 'Pat Ng' },
    });
    calls.set('call_b1', {
      id: 'call_b1', tenantId: 'tenant_b', startedAt: new Date('2026-10-14T17:20:00Z'),
      callerNumber: '+16045550155', channel: 'phone', status: 'COMPLETED', outcome: 'NO_ACTION',
      intent: 'OTHER', summary: 'Caller hung up.', durationSeconds: 21,
      successScore: 2, structuredData: { callerName: 'Beta Caller' },
    });
  }

  return { tenants, settings, users, calls, tickets, auditCalls, geminiScript, geminiRequests, seed, defaultHours };
});

vi.mock('../lib/prisma', () => ({
  prisma: {
    tenant: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(state.tenants.get(args.where.id) ?? null),
    },
    user: {
      findUnique: (args: { where: { id: string } }) => Promise.resolve(state.users.get(args.where.id) ?? null),
    },
    agentSettings: {
      findUnique: (args: { where: { tenantId: string } }) =>
        Promise.resolve(state.settings.get(args.where.tenantId) ?? null),
      update: (args: { where: { tenantId: string }; data: Record<string, unknown> }) => {
        const current = state.settings.get(args.where.tenantId);
        if (!current) return Promise.reject(new Error('settings missing'));
        const next = { ...current, ...args.data };
        state.settings.set(args.where.tenantId, next as never);
        return Promise.resolve(next);
      },
    },
    callLog: {
      aggregate: () => Promise.resolve({ _sum: { durationSeconds: 30 * 60 } }),
      findMany: (args: { where: { tenantId: string }; take?: number }) => {
        const rows = [...state.calls.values()]
          .filter((c) => c.tenantId === args.where.tenantId)
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
          .slice(0, args.take ?? 10);
        return Promise.resolve(rows);
      },
      findFirst: (args: { where: { id: string; tenantId: string } }) => {
        const row = state.calls.get(args.where.id);
        return Promise.resolve(row && row.tenantId === args.where.tenantId ? row : null);
      },
    },
    supportTicket: {
      create: (args: {
        data: {
          tenantId: string; createdByUserId: string; category: string;
          subject: string; details: string; callLogId: string | null;
        };
      }) => {
        const row = {
          id: `ticket${String(state.tickets.length + 1).padStart(19, '0')}`,
          status: 'OPEN',
          ...args.data,
        };
        state.tickets.push(row);
        return Promise.resolve(row);
      },
    },
  },
}));

vi.mock('../services/vapi.service', () => ({
  syncAssistantForTenant: vi.fn().mockResolvedValue({ synced: true }),
}));

vi.mock('../services/platform-config.service', () => ({
  recordAdminAction: (email: string, action: string, target: string | null, detail: unknown) => {
    state.auditCalls.push({ email, action, target, detail });
    return Promise.resolve();
  },
}));

import { supportRouter } from './support.routes';
import { errorHandler } from '../middleware/error';
import { signAccessToken } from '../lib/jwt';
import { parseBusinessHours } from '../domain/agent-config';
import { resolveBookingWindow } from '../services/appointment.service';

/* ------------------------- scripted Gemini ------------------------------ */

function textReply(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}
function callReply(name: string, args: Record<string, unknown>) {
  return { candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] };
}

const realFetch = globalThis.fetch.bind(globalThis);
const fetchStub = vi.fn(async (_url: unknown, init?: { body?: string }) => {
  if (init?.body) {
    try {
      state.geminiRequests.push(
        JSON.parse(init.body) as {
          contents: unknown;
          systemInstruction?: { parts: Array<{ text: string }> };
        },
      );
    } catch {
      /* ignore */
    }
  }
  const next = state.geminiScript.shift() ?? textReply('Scripted reply.');
  return new Response(JSON.stringify(next), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
vi.stubGlobal('fetch', fetchStub);

/* ------------------------------ test server ----------------------------- */

let server: Server;
let base = '';

const tokenA = () => signAccessToken({ userId: 'user_a', tenantId: 'tenant_a', role: 'OWNER' });
const tokenAAgent = () => signAccessToken({ userId: 'user_a_agent', tenantId: 'tenant_a', role: 'AGENT' });
const tokenB = () => signAccessToken({ userId: 'user_b', tenantId: 'tenant_b', role: 'OWNER' });

async function buildServer(
  router: typeof supportRouter,
  handler: typeof errorHandler = errorHandler,
): Promise<{ srv: Server; url: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/support', router);
  app.use(handler);
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('no test server address');
  return { srv, url: `http://127.0.0.1:${addr.port}` };
}

beforeAll(async () => {
  const built = await buildServer(supportRouter);
  server = built.srv;
  base = built.url;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.seed();
  fetchStub.mockClear();
});

async function chat(token: string, text: string, url = base) {
  const res = await realFetch(`${url}/api/support/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ role: 'user', text }] }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function apply(token: string, proposalId: string, url = base) {
  const res = await realFetch(`${url}/api/support/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ proposalId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function chatWithPage(token: string, text: string, page: string) {
  const res = await realFetch(`${base}/api/support/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ role: 'user', text }], page }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function fileTicket(token: string, proposalId: string) {
  const res = await realFetch(`${base}/api/support/file-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ proposalId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** The system prompt text of every Gemini request made so far. */
function systemTextsShownToModel(): string[] {
  return state.geminiRequests.map((r) =>
    (r.systemInstruction?.parts ?? []).map((p) => p.text).join(''),
  );
}

/** The functionResponse payloads the model was shown, across all its turns. */
function toolResultsShownToModel(): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const req of state.geminiRequests) {
    const contents = (req as { contents: Array<{ parts: Array<Record<string, any>> }> }).contents ?? [];
    for (const content of contents) {
      for (const part of content.parts ?? []) {
        if (part.functionResponse) out.push(part.functionResponse.response.result as Record<string, any>);
      }
    }
  }
  return out;
}

/* --------------------------------- tests -------------------------------- */

describe('support agent routes', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await realFetch(`${base}/api/support/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', text: 'hi' }] }),
    });
    expect(res.status).toBe(401);
  });

  it('answers with the caller tenant booking window only', async () => {
    state.geminiScript.push(callReply('get_booking_window', {}), textReply('Your hours are set.'));
    const { status, body } = await chat(tokenA(), 'When can patients book?');
    expect(status).toBe(200);
    expect(body.reply).toBe('Your hours are set.');
    const results = toolResultsShownToModel();
    expect(results).toHaveLength(1);
    expect(results[0]?.timezone).toBe('America/Toronto');
    expect(results[0]?.summary).toContain('Monday to Friday 8 AM to 5 PM');
  });

  it('scopes the account snapshot to the caller tenant', async () => {
    state.geminiScript.push(callReply('get_account_snapshot', {}), textReply('Here is your account.'));
    const { status } = await chat(tokenB(), 'How many minutes have I used?');
    expect(status).toBe(200);
    const [snapshot] = toolResultsShownToModel();
    expect(snapshot?.businessName).toBe('Beta Dental');
    expect(snapshot?.receptionistPhoneNumber).toBe('+16045550199');
    expect(snapshot?.minutesUsedThisMonth).toBe(30);
    expect(snapshot?.monthlyMinuteCap).toBe(300);
    // The other tenant's data never enters the prompt or the tool results.
    expect(JSON.stringify(state.geminiRequests)).not.toContain('Alpha Dental');
    expect(JSON.stringify(state.geminiRequests)).not.toContain('+14165550100');
  });

  it('rejects a nonsense window at propose time and holds nothing to apply', async () => {
    state.geminiScript.push(
      callReply('propose_booking_window', {
        windows: [{ days: ['mon'], open: '12:00', close: '08:00' }],
      }),
      textReply('That window ends before it starts.'),
    );
    const { status, body } = await chat(tokenA(), 'Book Mondays noon to 8 AM.');
    expect(status).toBe(200);
    expect(body.pendingProposal).toBeNull();
    const results = toolResultsShownToModel();
    expect(results[0]?.status).toBe('error');
    expect(String(results[0]?.error)).toMatch(/ends before it starts/);
    const applied = await apply(tokenA(), 'anything');
    expect(applied.status).toBe(409);
    expect(state.auditCalls).toHaveLength(0);
  });

  it('refuses a total lockout unless explicitly confirmed, then allows it as a proposal', async () => {
    state.geminiScript.push(
      callReply('propose_booking_window', {
        closedDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      }),
      textReply('That stops all bookings.'),
    );
    const refused = await chat(tokenA(), 'Close every day.');
    expect(refused.body.pendingProposal).toBeNull();
    expect(String(toolResultsShownToModel()[0]?.error)).toMatch(/stop all bookings/);

    state.geminiScript.push(
      callReply('propose_booking_window', {
        closedDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        allowLockout: true,
      }),
      textReply('Set up for confirmation.'),
    );
    const allowed = await chat(tokenA(), 'Yes, close every day, I am sure.');
    expect(allowed.body.pendingProposal?.proposalId).toBeTruthy();
  });

  it('runs the full propose, confirm, apply flow onto the real availability source', async () => {
    state.geminiScript.push(
      callReply('propose_booking_window', {
        windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], open: '08:00', close: '12:00' }],
        closedDays: ['sat', 'sun'],
      }),
      textReply('Here is the change. Confirm to apply it.'),
    );
    const proposed = await chat(tokenA(), 'Only book weekday mornings.');
    expect(proposed.status).toBe(200);
    const proposalId = proposed.body.pendingProposal?.proposalId as string;
    expect(proposalId).toBeTruthy();
    expect(proposed.body.pendingProposal?.summary).toContain('Monday to Friday 8 AM to 12 PM');

    // A wrong id applies nothing.
    const wrong = await apply(tokenA(), 'not-the-proposal');
    expect(wrong.status).toBe(409);
    expect(parseBusinessHours(state.settings.get('tenant_a')?.businessHours).mon.close).toBe('17:00');

    // The real id applies to AgentSettings.businessHours, the column the
    // receptionist's booking rules read.
    const applied = await apply(tokenA(), proposalId);
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(true);
    const stored = state.settings.get('tenant_a')?.businessHours;
    const hours = parseBusinessHours(stored);
    expect(hours.mon).toEqual({ enabled: true, open: '08:00', close: '12:00' });
    expect(hours.sat.enabled).toBe(false);

    // Proof the receptionist honors it: the shared booking validator now
    // refuses a Saturday slot and a weekday-afternoon slot, and accepts a
    // weekday-morning one. (2026-10-21 is a Wednesday, 2026-10-24 a Saturday.)
    const windowArgs = {
      durationMinutes: 30,
      timezone: 'America/Toronto',
      businessHours: stored,
      now: new Date('2026-10-15T12:00:00Z'),
    };
    expect(() => resolveBookingWindow({ ...windowArgs, date: '2026-10-24', time: '10:00' })).toThrow(
      /outside business hours/,
    );
    expect(() => resolveBookingWindow({ ...windowArgs, date: '2026-10-21', time: '14:00' })).toThrow(
      /outside business hours/,
    );
    expect(resolveBookingWindow({ ...windowArgs, date: '2026-10-21', time: '10:00' }).startsAt).toBeInstanceOf(Date);

    // The audit log carries the apply, exactly once.
    expect(state.auditCalls).toHaveLength(1);
    expect(state.auditCalls[0]?.action).toBe('support_agent.booking_window');
    expect(state.auditCalls[0]?.email).toBe('owner@alpha.test');
    expect(state.auditCalls[0]?.target).toBe('tenant_a');

    // And the agent reads the new window back.
    state.geminiScript.push(callReply('get_booking_window', {}), textReply('Updated hours.'));
    await chat(tokenA(), 'What are my hours now?');
    const results = toolResultsShownToModel();
    const last = results[results.length - 1];
    expect(last?.summary).toContain('Monday to Friday 8 AM to 12 PM');
  });

  it('applies through the chat when the user confirms in words', async () => {
    state.geminiScript.push(
      callReply('propose_booking_window', {
        windows: [{ days: ['sat'], open: '09:00', close: '13:00' }],
      }),
      textReply('Confirm?'),
    );
    const proposed = await chat(tokenA(), 'Open Saturday mornings too.');
    const proposalId = proposed.body.pendingProposal?.proposalId as string;

    state.geminiScript.length = 0;
    state.geminiRequests.length = 0;
    state.geminiScript.push(
      callReply('apply_booking_window', { proposalId }),
      textReply('Done, Saturday mornings are open.'),
    );
    const confirmed = await chat(tokenA(), 'Yes, do it.');
    expect(confirmed.status).toBe(200);
    const results = toolResultsShownToModel();
    expect(results[0]?.status).toBe('applied');
    expect(parseBusinessHours(state.settings.get('tenant_a')?.businessHours).sat).toEqual({
      enabled: true, open: '09:00', close: '13:00',
    });
  });

  it('never lets one tenant apply another tenant proposal', async () => {
    state.geminiScript.push(
      callReply('propose_booking_window', {
        windows: [{ days: ['mon'], open: '09:00', close: '12:00' }],
      }),
      textReply('Confirm?'),
    );
    const proposed = await chat(tokenA(), 'Monday mornings only.');
    const proposalId = proposed.body.pendingProposal?.proposalId as string;
    const stolen = await apply(tokenB(), proposalId);
    expect(stolen.status).toBe(409);
    expect(parseBusinessHours(state.settings.get('tenant_a')?.businessHours).mon.open).toBe('08:00');
    expect(parseBusinessHours(state.settings.get('tenant_b')?.businessHours).mon.open).toBe('08:00');
  });

  it('blocks staff roles from applying a settings change', async () => {
    state.geminiScript.push(
      callReply('propose_booking_window', {
        windows: [{ days: ['mon'], open: '09:00', close: '12:00' }],
      }),
      textReply('Confirm?'),
    );
    const proposed = await chat(tokenA(), 'Monday mornings only.');
    const proposalId = proposed.body.pendingProposal?.proposalId as string;
    const res = await apply(tokenAAgent(), proposalId);
    expect(res.status).toBe(403);
  });

  it('fails cleanly with a 503 when no Gemini key is configured', async () => {
    // A fresh module graph with the key deleted from the environment: the
    // chat endpoint must answer a clean 503 (never crash, never fall back
    // to another vendor), and must not call the model at all.
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    vi.resetModules();
    try {
      const fresh = await import('./support.routes');
      // The fresh module graph has its own HttpError class, so its errors
      // must be rendered by the fresh error handler (instanceof is per-graph).
      const freshError = await import('../middleware/error');
      const built = await buildServer(fresh.supportRouter, freshError.errorHandler);
      try {
        const res = await chat(tokenA(), 'hello', built.url);
        expect(res.status).toBe(503);
        expect(res.body.error?.code).toBe('SUPPORT_NOT_CONFIGURED');
        expect(fetchStub).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve) => built.srv.close(() => resolve()));
      }
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
      vi.resetModules();
    }
  }, 30_000);

  it('rate limits the chat endpoint', async () => {
    vi.resetModules();
    const fresh = await import('./support.routes');
    const built = await buildServer(fresh.supportRouter);
    try {
      let lastStatus = 0;
      for (let i = 0; i < 121; i += 1) {
        const res = await chat(tokenA(), 'hello', built.url);
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(429);
    } finally {
      await new Promise<void>((resolve) => built.srv.close(() => resolve()));
    }
  }, 60_000);
});

/* ------------------------- v2: page context, ----------------------------- */
/* ----------------------- confidentiality, tickets ------------------------ */

describe('support agent v2', () => {
  it('names the page the user is on in the system prompt for a known route', async () => {
    state.geminiScript.push(textReply('You are on the calls page.'));
    const res = await chatWithPage(tokenA(), 'What am I looking at?', '/dashboard/calls');
    expect(res.status).toBe(200);
    const systems = systemTextsShownToModel();
    expect(systems.length).toBeGreaterThan(0);
    expect(systems[0]).toContain('CURRENT PAGE:');
    expect(systems[0]).toContain('the Calls page');
  });

  it('adds no page context for an unknown route, and never errors', async () => {
    state.geminiScript.push(textReply('Hello.'));
    const res = await chatWithPage(tokenA(), 'Hi', '/totally/made-up');
    expect(res.status).toBe(200);
    const systems = systemTextsShownToModel();
    expect(systems[0]).not.toContain('CURRENT PAGE:');
  });

  it('carries the confidentiality block in the system prompt on every chat', async () => {
    state.geminiScript.push(textReply('Hello.'));
    await chat(tokenA(), 'Hi');
    const systems = systemTextsShownToModel();
    expect(systems[0]).toContain('CONFIDENTIALITY (never break)');
    expect(systems[0]).toContain('how you or the receptionist are built');
    expect(systems[0]).toContain('any other customer, account');
  });

  it('list_recent_calls only ever shows the caller workspace calls', async () => {
    state.geminiScript.push(callReply('list_recent_calls', {}), textReply('Here are your recent calls.'));
    const res = await chat(tokenB(), 'Show me my recent calls.');
    expect(res.status).toBe(200);
    const seen = JSON.stringify(state.geminiRequests);
    expect(seen).toContain('call_b1');
    expect(seen).not.toContain('call_a1');
    expect(seen).not.toContain('call_a2');
    expect(seen).not.toContain('Jamie Lee');
  });

  it('proposes a bad-call ticket, holds it unfiled, and files exactly one row on confirm', async () => {
    state.geminiScript.push(
      callReply('list_recent_calls', {}),
      callReply('propose_ticket', {
        category: 'BAD_CALL',
        subject: 'Receptionist was rude to a caller',
        details: 'The caller said the receptionist cut them off twice.',
        callLogId: 'call_a1',
      }),
      textReply('Here is the ticket to check before I file it.'),
    );
    const proposed = await chat(tokenA(), 'Your agent did a bad job on a call yesterday.');
    expect(proposed.status).toBe(200);
    expect(proposed.body.pendingProposal.kind).toBe('ticket');
    expect(proposed.body.pendingProposal.summary).toContain('Problem with a call');
    expect(proposed.body.pendingProposal.summary).toContain('Jamie Lee');
    // Held only: nothing filed until the confirm lands.
    expect(state.tickets).toHaveLength(0);

    const filed = await fileTicket(tokenA(), proposed.body.pendingProposal.proposalId);
    expect(filed.status).toBe(200);
    expect(filed.body.filed).toBe(true);
    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0]).toMatchObject({
      tenantId: 'tenant_a',
      createdByUserId: 'user_a',
      category: 'BAD_CALL',
      subject: 'Receptionist was rude to a caller',
      callLogId: 'call_a1',
      status: 'OPEN',
    });
    // The user is told the reference, derived from the row id.
    expect(filed.body.reference).toBe(`VF-${state.tickets[0].id.slice(-6).toUpperCase()}`);
    expect(filed.body.assistantMessage).toContain(filed.body.reference);

    // Confirming again cannot file a second ticket.
    const again = await fileTicket(tokenA(), proposed.body.pendingProposal.proposalId);
    expect(again.status).toBe(409);
    expect(state.tickets).toHaveLength(1);
  });

  it('rejects a callLogId from another workspace and holds nothing', async () => {
    state.geminiScript.push(
      callReply('propose_ticket', {
        category: 'BAD_CALL',
        subject: 'Bad call',
        details: 'Trying to attach another workspace call.',
        callLogId: 'call_b1',
      }),
      textReply('I could not attach that call.'),
    );
    const res = await chat(tokenA(), 'File a ticket about that call.');
    expect(res.status).toBe(200);
    expect(res.body.pendingProposal).toBeNull();
    expect(JSON.stringify(toolResultsShownToModel())).toContain('not in this workspace');
    expect(state.tickets).toHaveLength(0);
    const filed = await fileTicket(tokenA(), 'whatever');
    expect(filed.status).toBe(409);
    expect(state.tickets).toHaveLength(0);
  });

  it('files a ticket confirmed in words through the file_ticket tool', async () => {
    state.geminiScript.push(
      callReply('propose_ticket', {
        category: 'ISSUE',
        subject: 'Calls page will not load',
        details: 'The calls list spins forever since this morning.',
      }),
      textReply('Shall I file that?'),
    );
    const proposed = await chat(tokenA(), 'The calls page is broken.');
    expect(proposed.body.pendingProposal.kind).toBe('ticket');
    expect(state.tickets).toHaveLength(0);

    state.geminiScript.push(
      callReply('file_ticket', { proposalId: proposed.body.pendingProposal.proposalId }),
      textReply('Filed it for you.'),
    );
    const confirmed = await chat(tokenA(), 'Yes, file it.');
    expect(confirmed.status).toBe(200);
    const results = JSON.stringify(toolResultsShownToModel());
    expect(results).toContain('"status":"filed"');
    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0]).toMatchObject({ category: 'ISSUE', callLogId: null });
  });

  it('lets a non-owner staff user file a ticket (no owner gate on reporting)', async () => {
    state.geminiScript.push(
      callReply('propose_ticket', {
        category: 'OTHER',
        subject: 'Calendar looks wrong',
        details: 'Tomorrow shows appointments we do not have.',
      }),
      textReply('Here is the ticket.'),
    );
    const proposed = await chat(tokenAAgent(), 'Something is off with the calendar.');
    expect(proposed.status).toBe(200);
    const filed = await fileTicket(tokenAAgent(), proposed.body.pendingProposal.proposalId);
    expect(filed.status).toBe(200);
    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0].createdByUserId).toBe('user_a_agent');
  });

  it('never files a booking proposal as a ticket, nor applies a ticket as a booking change', async () => {
    state.geminiScript.push(
      callReply('propose_booking_window', {
        windows: [{ days: ['mon', 'tue'], open: '09:00', close: '12:00' }],
      }),
      textReply('Proposed.'),
    );
    const booking = await chat(tokenA(), 'Book Monday and Tuesday mornings only.');
    const wrong = await fileTicket(tokenA(), booking.body.pendingProposal.proposalId);
    expect(wrong.status).toBe(409);
    expect(state.tickets).toHaveLength(0);

    state.geminiScript.push(
      callReply('propose_ticket', { category: 'ISSUE', subject: 'X', details: 'Y' }),
      textReply('Proposed.'),
    );
    const ticket = await chat(tokenA(), 'I have an issue.');
    const wrongApply = await apply(tokenA(), ticket.body.pendingProposal.proposalId);
    expect(wrongApply.status).toBe(409);
    expect(state.tickets).toHaveLength(0);
    expect(state.settings.get('tenant_a')!.businessHours).toEqual(state.defaultHours());
  });

  it('reports a booking-window apply as old window to new window', async () => {
    state.geminiScript.push(
      callReply('propose_booking_window', {
        windows: [{ days: ['mon', 'tue', 'wed', 'thu'], open: '09:00', close: '17:00' }],
      }),
      textReply('Proposed.'),
    );
    const proposed = await chat(tokenA(), 'Only book Monday to Thursday, 9 to 5.');
    const applied = await apply(tokenA(), proposed.body.pendingProposal.proposalId);
    expect(applied.status).toBe(200);
    expect(applied.body.assistantMessage).toContain('changed from');
    expect(applied.body.assistantMessage).toContain('Monday to Friday 8 AM to 5 PM');
    expect(applied.body.assistantMessage).toContain('Monday to Thursday 9 AM to 5 PM');
  });
});
