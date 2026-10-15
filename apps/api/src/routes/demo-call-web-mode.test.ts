import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

/**
 * Route-level tests for the Canadian web mode on POST /api/demo/call,
 * following the repo's mocking pattern (spies declared first, vi.mock
 * factories, then the module under test). The router is mounted on a
 * throwaway express app with the real error handler, over real HTTP.
 *
 * Pinned behaviour:
 *  - a Canadian receptionist demo start answers with a web call (public
 *    key + the same Maya, now carrying the screen tools) and places NO
 *    outbound call;
 *  - the lead is recorded as mode 'web', and whether the phone fallback
 *    exists rides in the response for the page to offer;
 *  - an explicit delivery 'phone' from a Canadian still dials, exactly
 *    as before (it is the microphone fallback the page offers);
 *  - a US receptionist start still dials, with the phone-only Maya (no
 *    screen tools, no screen block in her prompt);
 *  - a Canadian SALES start still dials (the web mode is the
 *    personalized demo only; Ava's demo has its own web path);
 *  - with no Vapi public key configured, a Canadian receptionist start
 *    falls back to dialing rather than failing;
 *  - with no caller-ID configured at all, the web mode still starts and
 *    reports that the phone fallback is unavailable.
 */

const demoLeadFindFirst = vi.fn();
const demoLeadFindMany = vi.fn();
const demoLeadUpdate = vi.fn().mockResolvedValue({});
const demoCallCount = vi.fn();

vi.mock('../lib/prisma', () => ({
  prisma: {
    demoLead: {
      findFirst: (...args: unknown[]) => demoLeadFindFirst(...args),
      findMany: (...args: unknown[]) => demoLeadFindMany(...args),
      update: (...args: unknown[]) => demoLeadUpdate(...args),
    },
    demoCall: { count: (...args: unknown[]) => demoCallCount(...args) },
  },
}));

const isDemoEnabled = vi.fn();
const resumeDemoSession = vi.fn();
const setLeadMode = vi.fn().mockResolvedValue(undefined);
const getDemoNumbers = vi.fn();
const pickDemoCallerId = vi.fn();

vi.mock('../services/demo.service', () => ({
  isDemoEnabled: (...args: unknown[]) => isDemoEnabled(...args),
  startDemoSession: vi.fn(),
  resumeDemoSession: (...args: unknown[]) => resumeDemoSession(...args),
  getDemoAppointments: vi.fn().mockResolvedValue([]),
  blockDemoSlot: vi.fn().mockResolvedValue([]),
  resetDemoSession: vi.fn().mockResolvedValue({}),
  createDemoLead: vi.fn(),
  setLeadMode: (...args: unknown[]) => setLeadMode(...args),
  getSalesConfig: vi.fn().mockResolvedValue({ agentName: 'Ava', founderName: 'Sam', showCalendar: true }),
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
  // Distinct test IPs per case keep the route's rate limiters out of the way.
  clientIp: (req: { headers: Record<string, string | string[] | undefined> }) => {
    const v = req.headers['x-test-ip'];
    return (Array.isArray(v) ? v[0] : v) ?? '1.2.3.4';
  },
}));

const getSettingValue = vi.fn();
vi.mock('../services/platform-config.service', () => ({
  getSettingValue: (key: string) => getSettingValue(key),
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

const LEAD_ROW = {
  id: 'lead_1',
  name: 'Jordan Reyes',
  email: 'jordan@example.com',
  businessName: 'Maple Dental Studio',
  factsJson: {
    businessName: 'Maple Dental Studio',
    hours: ['Monday to Friday, 8 AM to 5 PM'],
    services: ['Cleanings', 'Crowns'],
    address: '2145 West 4th Avenue, Vancouver',
    phone: '+1 604 555 0182',
  },
};

const PUBLIC_KEY = 'vapi_public_test_key';

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

function gateFor(country: string) {
  return {
    callAllowed: true,
    ipCountry: country,
    phone: { country: 'US/CA', isNanp: true },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  demoLeadUpdate.mockResolvedValue({});
  setLeadMode.mockResolvedValue(undefined);
  isDemoEnabled.mockResolvedValue(true);
  demoLeadFindFirst.mockResolvedValue(LEAD_ROW);
  demoLeadFindMany.mockResolvedValue([]);
  demoCallCount.mockResolvedValue(0);
  resumeDemoSession.mockImplementation(async (sessionId: string) => fakeSession(sessionId));
  getDemoNumbers.mockResolvedValue({
    us: { id: 'num_us', number: '+15550001111' },
    ca: { id: 'num_ca', number: '+16045550199' },
  });
  pickDemoCallerId.mockReturnValue({ id: 'num_ca', number: '+16045550199' });
  placeOutboundCall.mockResolvedValue({ id: 'call_abc' });
  evaluateGate.mockResolvedValue(gateFor('CA'));
  getSettingValue.mockImplementation(async (key: string) => {
    if (key === 'VAPI_PUBLIC_KEY') return PUBLIC_KEY;
    return 'https://api.example.test';
  });
});

let ipCounter = 0;
async function postCall(body: Record<string, unknown>) {
  ipCounter += 1;
  const testIp = `10.98.0.${ipCounter}`;
  const res = await fetch(`${base}/api/demo/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-ip': testIp,
      'x-forwarded-for': testIp,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const FACTS = {
  businessName: 'Maple Dental Studio',
  hours: ['Monday to Friday, 8 AM to 5 PM'],
  services: ['Cleanings', 'Crowns'],
  address: '2145 West 4th Avenue, Vancouver',
};

describe('POST /api/demo/call Canadian web mode', () => {
  it('CA receptionist: answers with a web call and places no outbound call', async () => {
    const { status, json } = await postCall({
      sessionId: 'demo_caweb',
      leadId: 'lead_1',
      name: 'Jordan Reyes',
      phone: '+1 (604) 555-0182',
      demoKind: 'receptionist',
      facts: FACTS,
    });

    expect(status).toBe(200);
    expect(json.mode).toBe('web');
    expect(json.publicKey).toBe(PUBLIC_KEY);
    expect(json.sessionId).toBe('demo_caweb');
    expect(json.country).toBe('CA');
    expect(json.callId).toBeUndefined();
    expect(placeOutboundCall).not.toHaveBeenCalled();
    // The demo is recorded as a web demo, not a call.
    expect(setLeadMode).toHaveBeenCalledWith('lead_1', 'web');
    // A caller-ID is configured, so the page may offer the phone fallback.
    expect(json.phoneFallbackAvailable).toBe(true);

    // Same Maya as the phone path: clinic opener, golden voice, facts
    // dressed prompt, metadata stamped with the session.
    const assistant = json.assistant as {
      firstMessage: string;
      maxDurationSeconds: number;
      voice: Record<string, unknown>;
      metadata: { demoSessionId?: string; channel?: string };
      model: {
        messages: Array<{ content: string }>;
        tools?: Array<{ function?: { name: string } }>;
      };
    };
    expect(assistant.firstMessage).toContain('Maple Dental Studio');
    expect(assistant.firstMessage).toContain('VoiceFront demo you asked for');
    expect(assistant.maxDurationSeconds).toBe(300);
    expect(assistant.voice).toMatchObject({ provider: '11labs', voiceId: 'cgSgspJ2msm6clMCkdW9' });
    expect(assistant.metadata.demoSessionId).toBe('demo_caweb');
    expect(assistant.metadata.channel).toBe('web');

    // The booking spine is unchanged: the hold tool rides along, and the
    // stock booking tools stay off her.
    const toolNames = (assistant.model.tools ?? []).map((t) => t.function?.name);
    expect(toolNames).toContain('hold_appointment');
    expect(toolNames).not.toContain('bookAppointment');

    // And now the panel tools ride too, with prompt guidance to use them.
    expect(toolNames).toContain('set_demo_screen');
    expect(toolNames).toContain('show_call_summary');
    const prompt = assistant.model.messages[0]?.content ?? '';
    expect(prompt).toContain('CONTROLLING THEIR SCREEN');
    expect(prompt).toContain('Maple Dental Studio');
    // The callback candidate is confirmed from the form, not from a dial:
    // the phone wording ("the number you dialed") must not appear.
    expect(prompt).toContain('The number they gave on the demo request: +1 604 555 0182');
    expect(prompt).not.toContain('The number you dialed for this call');
  });

  it('CA receptionist with delivery phone: still dials, exactly as before', async () => {
    const { status, json } = await postCall({
      sessionId: 'demo_caphone',
      leadId: 'lead_1',
      name: 'Jordan Reyes',
      phone: '+1 (604) 555-0182',
      demoKind: 'receptionist',
      delivery: 'phone',
      facts: FACTS,
    });

    expect(status).toBe(200);
    expect(json.mode).toBe('phone');
    expect(json.callId).toBe('call_abc');
    expect(placeOutboundCall).toHaveBeenCalledOnce();
    expect(setLeadMode).toHaveBeenCalledWith('lead_1', 'call');
    // The phone Maya carries no screen tools and no screen block.
    const arg = placeOutboundCall.mock.calls[0]?.[0] as {
      assistant: {
        metadata: { channel?: string };
        model: {
          messages: Array<{ content: string }>;
          tools?: Array<{ function?: { name: string } }>;
        };
      };
    };
    expect(arg.assistant.metadata.channel).toBe('phone');
    const toolNames = (arg.assistant.model.tools ?? []).map((t) => t.function?.name);
    expect(toolNames).not.toContain('set_demo_screen');
    expect(arg.assistant.model.messages[0]?.content ?? '').not.toContain('CONTROLLING THEIR SCREEN');
    expect(arg.assistant.model.messages[0]?.content ?? '').toContain(
      'The number you dialed for this call: +1 604 555 0182',
    );
  });

  it('US receptionist: still dials from the US path, mode phone', async () => {
    evaluateGate.mockResolvedValue(gateFor('US'));
    pickDemoCallerId.mockReturnValue({ id: 'num_us', number: '+15550001111' });

    const { status, json } = await postCall({
      sessionId: 'demo_usphone',
      leadId: 'lead_1',
      name: 'Jordan Reyes',
      phone: '+1 (212) 555-0147',
      demoKind: 'receptionist',
      facts: FACTS,
    });

    expect(status).toBe(200);
    expect(json.mode).toBe('phone');
    expect(json.callId).toBe('call_abc');
    expect(json.fromNumber).toBe('+15550001111');
    expect(placeOutboundCall).toHaveBeenCalledOnce();
    expect(setLeadMode).toHaveBeenCalledWith('lead_1', 'call');
  });

  it('CA sales demo: still dials (web mode is the personalized demo only)', async () => {
    const { status, json } = await postCall({
      sessionId: 'demo_casales',
      leadId: 'lead_1',
      name: 'Jordan Reyes',
      phone: '+1 (604) 555-0182',
    });

    expect(status).toBe(200);
    expect(json.mode).toBe('phone');
    expect(json.callId).toBe('call_abc');
    expect(placeOutboundCall).toHaveBeenCalledOnce();
  });

  it('CA receptionist with no public key configured: falls back to dialing', async () => {
    getSettingValue.mockImplementation(async (key: string) =>
      key === 'VAPI_PUBLIC_KEY' ? null : 'https://api.example.test',
    );

    const { status, json } = await postCall({
      sessionId: 'demo_canokey',
      leadId: 'lead_1',
      name: 'Jordan Reyes',
      phone: '+1 (604) 555-0182',
      demoKind: 'receptionist',
      facts: FACTS,
    });

    expect(status).toBe(200);
    expect(json.mode).toBe('phone');
    expect(json.callId).toBe('call_abc');
    expect(placeOutboundCall).toHaveBeenCalledOnce();
  });

  it('CA receptionist with no caller-ID configured: web mode still starts, fallback flagged off', async () => {
    pickDemoCallerId.mockReturnValue(null);

    const { status, json } = await postCall({
      sessionId: 'demo_canofallback',
      leadId: 'lead_1',
      name: 'Jordan Reyes',
      phone: '+1 (604) 555-0182',
      demoKind: 'receptionist',
      facts: FACTS,
    });

    expect(status).toBe(200);
    expect(json.mode).toBe('web');
    expect(json.phoneFallbackAvailable).toBe(false);
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it('CA receptionist still respects the per-destination cap before any mode is chosen', async () => {
    demoLeadFindMany.mockResolvedValue([{ demoSessionId: 'demo_other', phone: '+16045550182' }]);
    demoCallCount.mockResolvedValue(2);

    const { status, json } = await postCall({
      sessionId: 'demo_cacap',
      leadId: 'lead_1',
      name: 'Jordan Reyes',
      phone: '+1 (604) 555-0182',
      demoKind: 'receptionist',
      facts: FACTS,
    });

    expect(status).toBe(429);
    expect(json.error?.code).toBe('NUMBER_CAP');
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });
});
