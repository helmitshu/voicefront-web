import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route tests for Lyla's public surface (POST /api/public/*). No auth
 * exists here by design; the gates are Turnstile on session start, the
 * session armor, and the rate limiter. The DB is faked with the same
 * tripwire as the service tests (a demo lead row is her only write), the
 * geo lookup is module-mocked, and Gemini + Turnstile are fetch-stubbed.
 * Shared-key fallback is what this file runs: LYLA_GEMINI_API_KEY is
 * deliberately unset, so the key on the wire must be GEMINI_API_KEY.
 */

const state = vi.hoisted(() => {
  process.env.GEMINI_API_KEY = 'shared-test-key';
  delete process.env.LYLA_GEMINI_API_KEY;
  process.env.TURNSTILE_SECRET_KEY = 'turnstile-test-secret';
  process.env.TWILIO_ACCOUNT_SID = 'AC-test';
  process.env.TWILIO_AUTH_TOKEN = 'twilio-test';
  process.env.TWILIO_FROM_NUMBER = '+14165550100';

  const leads: Array<Record<string, unknown>> = [];
  const tripwires: Record<string, number> = {};
  const geminiScript: Array<() => Response> = [];
  const geminiRequests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const country = { current: 'CA' as string | null };

  const tripwire = (model: string) => () => {
    tripwires[model] = (tripwires[model] ?? 0) + 1;
    throw new Error(`Lyla must never touch prisma.${model}`);
  };

  return { leads, tripwires, geminiScript, geminiRequests, country, tripwire };
});

vi.mock('../lib/prisma', () => ({
  prisma: {
    demoLead: {
      create: (args: { data: Record<string, unknown> }) => {
        const row = { id: `lead_${state.leads.length + 1}`, ...args.data };
        state.leads.push(row);
        return Promise.resolve(row);
      },
    },
    tenant: { findUnique: state.tripwire('tenant'), findMany: state.tripwire('tenant') },
    user: { findUnique: state.tripwire('user') },
    agentSettings: { findUnique: state.tripwire('agentSettings') },
    callLog: { findMany: state.tripwire('callLog'), findFirst: state.tripwire('callLog') },
    supportTicket: { create: state.tripwire('supportTicket') },
    appointment: { create: state.tripwire('appointment'), findMany: state.tripwire('appointment') },
  },
}));

vi.mock('../services/geo.service', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    detectIpCountry: vi.fn(() => Promise.resolve(state.country.current)),
  };
});

vi.mock('../services/clinic-facts.service', () => ({
  fetchClinicFacts: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../services/vapi.service', () => ({
  syncAssistantForTenant: vi.fn().mockResolvedValue({ synced: true }),
  placeOutboundCall: vi.fn().mockResolvedValue({ id: 'vapi_call_1', status: 'queued' }),
  uploadFileToVapi: vi.fn().mockResolvedValue({ id: 'vapi_file_1', status: 'processed' }),
}));

vi.mock('../services/platform-config.service', () => ({
  getSettingValue: () => Promise.resolve(null),
  recordAdminAction: () => Promise.resolve(),
}));

import { publicRouter } from './public.routes';
import { errorHandler } from '../middleware/error';
import { __resetPublicAgentStateForTests } from '../services/public-agent.service';

function geminiJson(parts: unknown[]): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
const textReply = (text: string) => () => geminiJson([{ text }]);
const callReply = (name: string, args: Record<string, unknown>) => () => geminiJson([{ functionCall: { name, args } }]);
function streamReply(chunks: string[]): Response {
  const body = chunks
    .map((c) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: c }] } }] })}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

let server: Server;
let base = '';

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        state.geminiRequests.push({ url: u, headers: init?.headers ?? {}, body: init?.body ?? '' });
        const next = state.geminiScript.shift();
        if (next) return next();
        return geminiJson([{ text: 'Default reply.' }]);
      }
      if (u.includes('challenges.cloudflare.com/turnstile')) {
        const token = new URLSearchParams(String(init?.body ?? '')).get('response');
        return new Response(JSON.stringify({ success: token === 'good-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // The app under test calls back into this same stub for its own HTTP.
      return realFetch(url, init as never);
    }),
  );
  const app = express();
  app.use(express.json());
  app.use('/api/public', publicRouter);
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

const realFetch = globalThis.fetch.bind(globalThis);

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  __resetPublicAgentStateForTests();
  state.leads.length = 0;
  for (const key of Object.keys(state.tripwires)) delete state.tripwires[key];
  state.geminiScript.length = 0;
  state.geminiRequests.length = 0;
  state.country.current = 'CA';
});

let ipSeq = 10;
function nextIp(): string {
  ipSeq += 1;
  return `203.0.113.${ipSeq}`;
}

async function post(path: string, body: unknown, ip: string): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const res = await realFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* SSE bodies are asserted as text instead */
  }
  return { status: res.status, body: parsed, text };
}

async function startSession(ip: string): Promise<string> {
  const res = await post('/api/public/session', { turnstileToken: 'good-token' }, ip);
  expect(res.status).toBe(200);
  return String(res.body.sessionId);
}

describe('session start', () => {
  it('refuses without a Turnstile token', async () => {
    const res = await post('/api/public/session', {}, nextIp());
    expect(res.status).toBe(403);
    expect((res.body.error as { code?: string })?.code).toBe('TURNSTILE_FAILED');
  });

  it('refuses a failed Turnstile token', async () => {
    const res = await post('/api/public/session', { turnstileToken: 'bad-token' }, nextIp());
    expect(res.status).toBe(403);
    expect((res.body.error as { code?: string })?.code).toBe('TURNSTILE_FAILED');
  });

  it('starts a session for a Canadian visitor with CAD and the web demo path', async () => {
    state.country.current = 'CA';
    const res = await post('/api/public/session', { turnstileToken: 'good-token', referrer: 'google' }, nextIp());
    expect(res.status).toBe(200);
    expect(String(res.body.sessionId)).toMatch(/^lyla_/);
    expect(String(res.body.greeting)).toContain('AI host from VoiceFront');
    expect(res.body.turnsLimit).toBe(12);
    expect(res.body.visitor).toEqual({ country: 'CA', currency: 'CAD', demoPath: 'web' });
  });

  it('starts a session for a US visitor with USD and the phone demo path', async () => {
    state.country.current = 'US';
    const res = await post('/api/public/session', { turnstileToken: 'good-token' }, nextIp());
    expect(res.status).toBe(200);
    expect(res.body.visitor).toEqual({ country: 'US', currency: 'USD', demoPath: 'phone' });
  });

  it('caps sessions per IP per day at 10 over HTTP', async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i += 1) await startSession(ip);
    const res = await post('/api/public/session', { turnstileToken: 'good-token' }, ip);
    expect(res.status).toBe(429);
    expect((res.body.error as { code?: string })?.code).toBe('IP_SESSION_LIMIT');
  });
});

describe('chat', () => {
  it('404s an unknown session', async () => {
    const res = await post(
      '/api/public/chat',
      { sessionId: 'lyla_00000000-0000-0000-0000-000000000000', messages: [{ role: 'user', text: 'Hi' }] },
      nextIp(),
    );
    expect(res.status).toBe(404);
    expect((res.body.error as { code?: string })?.code).toBe('SESSION_NOT_FOUND');
  });

  it('answers a turn and reports the turns left', async () => {
    const ip = nextIp();
    const sessionId = await startSession(ip);
    state.geminiScript.push(textReply('Two plans: Starter and Core.'));
    const res = await post(
      '/api/public/chat',
      { sessionId, messages: [{ role: 'user', text: 'What plans do you have?' }] },
      ip,
    );
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Two plans: Starter and Core.');
    expect(res.body.actions).toEqual([]);
    expect(res.body.turnsUsed).toBe(1);
    expect(res.body.turnsLeft).toBe(11);
  });

  it('runs on the shared key while her dedicated key is unset (the fallback)', async () => {
    const ip = nextIp();
    const sessionId = await startSession(ip);
    state.geminiScript.push(textReply('Hi there.'));
    await post('/api/public/chat', { sessionId, messages: [{ role: 'user', text: 'Hi' }] }, ip);
    expect(state.geminiRequests[0]?.headers['x-goog-api-key']).toBe('shared-test-key');
  });

  it('caps the session at 12 turns over HTTP', async () => {
    const ip = nextIp();
    const sessionId = await startSession(ip);
    for (let i = 0; i < 12; i += 1) {
      const res = await post('/api/public/chat', { sessionId, messages: [{ role: 'user', text: `Q${i}` }] }, ip);
      expect(res.status).toBe(200);
    }
    const res = await post('/api/public/chat', { sessionId, messages: [{ role: 'user', text: 'One more' }] }, ip);
    expect(res.status).toBe(429);
    expect((res.body.error as { code?: string })?.code).toBe('SESSION_TURN_LIMIT');
  });

  it('captures a lead through the full stack, and nothing else is written', async () => {
    const ip = nextIp();
    const sessionId = await startSession(ip);
    state.geminiScript.push(
      callReply('capture_lead', { name: 'Jo Smith', email: 'jo@clinic.ca' }),
      textReply('Saved.'),
    );
    const res = await post(
      '/api/public/chat',
      { sessionId, messages: [{ role: 'user', text: 'Email me: Jo Smith jo@clinic.ca' }] },
      ip,
    );
    expect(res.status).toBe(200);
    expect(state.leads).toHaveLength(1);
    expect(String((state.leads[0] as Record<string, unknown>).demoSessionId)).toMatch(/^lyla_/);
    expect(state.tripwires).toEqual({});
  });
});

describe('streaming chat', () => {
  it('speaks the SSE protocol: delta, final, done', async () => {
    const ip = nextIp();
    const sessionId = await startSession(ip);
    state.geminiScript.push(() => streamReply(['Streamed ', 'reply.']));
    const res = await post(
      '/api/public/chat/stream',
      { sessionId, messages: [{ role: 'user', text: 'Hi' }] },
      ip,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('event: delta');
    expect(res.text).toContain('event: final');
    expect(res.text).toContain('"reply":"Streamed reply."');
    expect(res.text).toContain('event: done');
  });
});

describe('proactive', () => {
  it('serves budgeted lines over HTTP, then goes quiet', async () => {
    const ip = nextIp();
    const sessionId = await startSession(ip);
    state.geminiScript.push(textReply('Plan help, one line.'), textReply('Save line.'));
    const first = await post('/api/public/proactive', { sessionId, trigger: 'pricing_dwell' }, ip);
    expect(first.status).toBe(200);
    expect(first.body.line).toBe('Plan help, one line.');
    const repeat = await post('/api/public/proactive', { sessionId, trigger: 'pricing_dwell' }, ip);
    expect(repeat.body.line).toBeNull();
    const second = await post('/api/public/proactive', { sessionId, trigger: 'exit_intent' }, ip);
    expect(second.body.line).toBe('Save line.');
    const third = await post('/api/public/proactive', { sessionId, trigger: 'form_stall' }, ip);
    expect(third.body.line).toBeNull();
  });
});
