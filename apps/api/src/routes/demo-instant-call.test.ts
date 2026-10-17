import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

/**
 * Route-level tests for POST /api/demo/instant-call — the "Call me now"
 * card: one phone number, the sales agent rings the visitor within
 * seconds. Same mocking pattern as the other demo route tests (spies
 * first, vi.mock factories, then the module under test), real HTTP
 * against a throwaway express app with the real error handler.
 *
 * Pinned behaviour:
 *  - the instant switch is a SEPARATE founder toggle from the demo
 *    master switch, and while it is off the endpoint refuses (403
 *    INSTANT_DISABLED) and places nothing;
 *  - the demo master switch off refuses everything (403 DEMO_DISABLED);
 *  - the US/CA geo gate, the per-destination daily cap, and the
 *    caller-ID requirement all apply exactly as on /call;
 *  - the founder's own number is matched by phone alone (there is no
 *    lead email on this path) and gets the higher testing cap;
 *  - a happy path creates a PHONE-ONLY lead (no name, no email —
 *    stored NULL, never placeholder text) with mode 'instant', builds
 *    the phone sales assistant, and places the outbound call from the
 *    country-matched demo number;
 *  - GET /demo/status reports the instant switch alongside the master.
 */

const demoLeadFindMany = vi.fn();
const demoCallCount = vi.fn();

vi.mock('../lib/prisma', () => ({
  prisma: {
    demoLead: {
      findFirst: vi.fn(),
      findMany: (...args: unknown[]) => demoLeadFindMany(...args),
      update: vi.fn().mockResolvedValue({}),
    },
    demoCall: { count: (...args: unknown[]) => demoCallCount(...args) },
  },
}));

const isDemoEnabled = vi.fn();
const isInstantDemoEnabled = vi.fn();
const startDemoSession = vi.fn();
const createDemoLead = vi.fn();
const getDemoNumbers = vi.fn();
const pickDemoCallerId = vi.fn();

vi.mock('../services/demo.service', () => ({
  isDemoEnabled: (...args: unknown[]) => isDemoEnabled(...args),
  isInstantDemoEnabled: (...args: unknown[]) => isInstantDemoEnabled(...args),
  startDemoSession: (...args: unknown[]) => startDemoSession(...args),
  resumeDemoSession: vi.fn(),
  getDemoAppointments: vi.fn().mockResolvedValue([]),
  blockDemoSlot: vi.fn().mockResolvedValue([]),
  resetDemoSession: vi.fn().mockResolvedValue({}),
  createDemoLead: (...args: unknown[]) => createDemoLead(...args),
  setLeadMode: vi.fn().mockResolvedValue(undefined),
  getSalesConfig: vi.fn().mockResolvedValue({ agentName: 'Ava', founderName: 'Hakim', showCalendar: true }),
  getDemoNumbers: (...args: unknown[]) => getDemoNumbers(...args),
  pickDemoCallerId: (...args: unknown[]) => pickDemoCallerId(...args),
  demoSample: () => ({
    company: 'Bayview Family Clinic',
    sampleLabel: 'a dental clinic',
    prospectLabel: 'your clinic',
    appointmentNoun: 'appointment',
  }),
  getDemoScreen: () => null,
  clearDemoScreen: vi.fn(),
  getDemoSummary: () => null,
  clearDemoSummary: vi.fn(),
}));

const placeOutboundCall = vi.fn();
vi.mock('../services/vapi.service', () => ({
  placeOutboundCall: (...args: unknown[]) => placeOutboundCall(...args),
}));

const evaluateGate = vi.fn();
vi.mock('../services/geo.service', () => ({
  evaluateGate: (...args: unknown[]) => evaluateGate(...args),
  detectIpLocation: vi.fn().mockResolvedValue(null),
  // Distinct test IPs per case keep the route's rate limiters out of the way:
  // the geo gate reads the IP from x-forwarded-for here, and express-rate-limit
  // keys on the same header because the test app sets trust proxy.
  clientIp: (req: { headers: Record<string, string | string[] | undefined> }) => {
    const v = req.headers['x-forwarded-for'] ?? req.headers['x-test-ip'];
    return (Array.isArray(v) ? v[0] : v) ?? '1.2.3.4';
  },
}));

const getSettingValue = vi.fn();
vi.mock('../services/platform-config.service', () => ({
  getSettingValue: (...args: unknown[]) => getSettingValue(...args),
}));

import { demoRouter } from './demo.routes';
import { errorHandler } from '../middleware/error';
import { defaultBusinessHours } from '../domain/agent-config';

function fakeSession(sessionId: string) {
  return {
    sessionId,
    bundle: {
      tenant: { id: 'tenant_demo', companyName: 'Bayview Family Clinic', industry: 'CLINIC' },
      settings: {
        displayName: 'Maya',
        systemPrompt: 'You are the demo receptionist.',
        firstMessage: 'Hello, thanks for calling.',
        voicemailGreeting: 'Please leave a message.',
        wrapUpMessage: 'Thanks, bye.',
        businessHours: defaultBusinessHours(),
        timezone: 'America/Vancouver',
        voiceProvider: 'vapi',
        voiceId: 'Emma',
        backgroundSound: 'off',
        forwardingNumbers: null,
        maxCallDurationSeconds: 600,
        silenceTimeoutSeconds: 30,
      },
    },
    day: {
      date: '2026-06-19',
      dayLabel: 'Friday, June 19',
      timezone: 'America/Vancouver',
      open: '08:00',
      close: '17:00',
      slotMinutes: 30,
      industry: 'clinic',
      sampleCompany: 'Bayview Family Clinic',
    },
    appointments: [],
  };
}

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/demo', demoRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no test server address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const US_NUMBER = { id: 'num_us', number: '+15550001111' };
const CA_NUMBER = { id: 'num_ca', number: '+16045550199' };
let ipCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  isDemoEnabled.mockResolvedValue(true);
  isInstantDemoEnabled.mockResolvedValue(true);
  startDemoSession.mockImplementation(async () => fakeSession('demo_instant_1'));
  createDemoLead.mockResolvedValue({ id: 'lead_instant_1' });
  getDemoNumbers.mockResolvedValue({ us: US_NUMBER, ca: CA_NUMBER });
  pickDemoCallerId.mockImplementation((_numbers: unknown, country: string | null) =>
    country === 'CA' ? CA_NUMBER : US_NUMBER,
  );
  placeOutboundCall.mockResolvedValue({ id: 'call_instant_1' });
  getSettingValue.mockImplementation(async (key: string) =>
    key === 'VAPI_PUBLIC_KEY' ? 'pk_test_123' : null,
  );
  evaluateGate.mockResolvedValue({
    callAllowed: true,
    ipCountry: 'US',
    phone: { country: 'US', isNanp: true },
  });
  demoLeadFindMany.mockResolvedValue([]);
  demoCallCount.mockResolvedValue(0);
});

async function instantCall(body: unknown) {
  ipCounter += 1;
  const ip = `10.9.0.${ipCounter}`;
  return fetch(`${base}/api/demo/instant-call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-ip': ip, 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('POST /demo/instant-call', () => {
  it('refuses when the demo master switch is off', async () => {
    isDemoEnabled.mockResolvedValue(false);
    const res = await instantCall({ phone: '+1 604 555 0182' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('DEMO_DISABLED');
    expect(placeOutboundCall).not.toHaveBeenCalled();
    expect(createDemoLead).not.toHaveBeenCalled();
  });

  it('refuses when the instant switch is off, even with the demo on', async () => {
    isInstantDemoEnabled.mockResolvedValue(false);
    const res = await instantCall({ phone: '+1 604 555 0182' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('INSTANT_DISABLED');
    expect(placeOutboundCall).not.toHaveBeenCalled();
    expect(createDemoLead).not.toHaveBeenCalled();
  });

  it('refuses numbers the geo gate does not allow', async () => {
    evaluateGate.mockResolvedValue({
      callAllowed: false,
      ipCountry: 'GB',
      phone: { country: 'GB', isNanp: false },
    });
    const res = await instantCall({ phone: '+44 20 7946 0958' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('CALL_NOT_ALLOWED');
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it('rejects a phone number that cannot be normalized', async () => {
    const res = await instantCall({ phone: 'not-a-number' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('BAD_PHONE');
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it('enforces the per-destination daily cap', async () => {
    demoLeadFindMany.mockResolvedValue([{ demoSessionId: 'demo_old', phone: '+1 604 555 0182' }]);
    demoCallCount.mockResolvedValue(2);
    const res = await instantCall({ phone: '+1 604 555 0182' });
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('NUMBER_CAP');
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it("lets the founder's own number past the standard cap, matched by phone alone", async () => {
    demoLeadFindMany.mockResolvedValue([{ demoSessionId: 'demo_old', phone: '+1 514 431 5049' }]);
    demoCallCount.mockResolvedValue(3); // over the standard cap of 2, under the founder cap of 5
    const res = await instantCall({ phone: '+1 514 431 5049' });
    expect(res.status).toBe(200);
    expect(placeOutboundCall).toHaveBeenCalledTimes(1);
  });

  it('refuses when no demo caller-ID is configured', async () => {
    pickDemoCallerId.mockReturnValue(null);
    const res = await instantCall({ phone: '+1 604 555 0182' });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('NO_DEMO_NUMBER');
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it('places the call and records a phone-only lead with mode instant', async () => {
    const res = await instantCall({ phone: '+1 604 555 0182' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      mode: 'phone',
      callId: 'call_instant_1',
      fromNumber: US_NUMBER.number,
      country: 'US',
    });

    expect(createDemoLead).toHaveBeenCalledTimes(1);
    const leadInput = createDemoLead.mock.calls[0][0];
    expect(leadInput.phone).toBe('+1 604 555 0182');
    expect(leadInput.mode).toBe('instant');
    // Phone-only capture: no name or email is invented for the row.
    expect(leadInput.name ?? null).toBeNull();
    expect(leadInput.email ?? null).toBeNull();

    expect(placeOutboundCall).toHaveBeenCalledTimes(1);
    const callInput = placeOutboundCall.mock.calls[0][0];
    expect(callInput.phoneNumberId).toBe(US_NUMBER.id);
    expect(callInput.customerNumber).toBe('+16045550182');
    expect(callInput.assistant.metadata.demoSessionId).toBe('demo_instant_1');

    // Outbound script: SHE placed this call, so the opener introduces her
    // and the reason for ringing — never an audio check — and the prompt
    // runs the no-screen playbook (she narrates; nothing points at a
    // calendar the prospect cannot see).
    expect(callInput.assistant.firstMessage).toBe(
      'Hi! This is Ava from VoiceFront — you just asked us to call you from our website. Got a couple of minutes?',
    );
    const prompt = callInput.assistant.model.messages[0].content as string;
    expect(prompt).toContain('YOU placed this call');
    expect(prompt).toContain('NO screen in front of them');
    expect(prompt).toContain('who am I talking to?');
    expect(prompt).not.toContain('See the calendar on your screen');
    expect(prompt).not.toContain('click any open slot on your screen');
  });

  it('dials Canadian visitors from the Canadian demo number', async () => {
    evaluateGate.mockResolvedValue({
      callAllowed: true,
      ipCountry: 'CA',
      phone: { country: 'CA', isNanp: true },
    });
    const res = await instantCall({ phone: '+1 604 555 0182' });
    expect(res.status).toBe(200);
    expect((await res.json()).fromNumber).toBe(CA_NUMBER.number);
    expect(placeOutboundCall.mock.calls[0][0].phoneNumberId).toBe(CA_NUMBER.id);
  });
});

describe('GET /demo/status', () => {
  it('reports the instant switch alongside the master switch', async () => {
    isInstantDemoEnabled.mockResolvedValue(false);
    const off = await fetch(`${base}/api/demo/status`);
    expect(await off.json()).toEqual({ enabled: true, instantEnabled: false });

    isInstantDemoEnabled.mockResolvedValue(true);
    const on = await fetch(`${base}/api/demo/status`);
    expect(await on.json()).toEqual({ enabled: true, instantEnabled: true });
  });
});

describe('POST /demo/instant-session', () => {
  async function instantSessionReq(body: unknown) {
    ipCounter += 1;
    const ip = `10.9.1.${ipCounter}`;
    return fetch(`${base}/api/demo/instant-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-ip': ip, 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    });
  }

  it('refuses when the instant switch is off', async () => {
    isInstantDemoEnabled.mockResolvedValue(false);
    const res = await instantSessionReq({});
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('INSTANT_DISABLED');
    expect(startDemoSession).not.toHaveBeenCalled();
  });

  it('runs with the master demo switch OFF: instant is the only demo', async () => {
    isDemoEnabled.mockResolvedValue(false);
    const res = await instantSessionReq({});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publicKey).toBe('pk_test_123');
    expect(body.sessionId).toBe('demo_instant_1');

    // Her outbound script, in the browser: she introduces herself and
    // leads, and she gets NO screen tools — the phone frame shows the
    // transcript, not a panel she drives.
    expect(body.assistant.firstMessage).toBe(
      'Hi! This is Ava from VoiceFront — you just asked us to call you from our website. Got a couple of minutes?',
    );
    const prompt = body.assistant.model.messages[0].content as string;
    expect(prompt).toContain('YOU placed this call');
    expect(prompt).toContain('NO screen in front of them');
    const toolNames = (body.assistant.model.tools ?? []).map(
      (t: { function?: { name?: string } }) => t.function?.name,
    );
    expect(toolNames).not.toContain('set_demo_screen');
    expect(toolNames).not.toContain('show_call_summary');
    expect(toolNames).toContain('bookAppointment');
    // No lead is created: the instant demo collects nothing up front.
    expect(createDemoLead).not.toHaveBeenCalled();
  });

  it('refuses with 503 when the voice key is not configured', async () => {
    getSettingValue.mockResolvedValue(null);
    const res = await instantSessionReq({});
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('VOICE_NOT_CONFIGURED');
    expect(startDemoSession).not.toHaveBeenCalled();
  });
});
