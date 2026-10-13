import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

/**
 * Route-level tests for the two demo kinds on POST /api/demo/call, following
 * the repo's mocking pattern (spies declared first, vi.mock factories, then
 * the module under test). The router is mounted on a throwaway express app
 * with the real error handler, and exercised over real HTTP.
 *
 * Pinned behaviour:
 *  - the per-destination cap (2 demo calls per number per 24h) refuses with
 *    429 NUMBER_CAP before any call is placed, for either kind;
 *  - demoKind 'receptionist' places the call with a Maya assistant dressed
 *    in the clinic's facts (golden voice, clinic opener, 180s cap);
 *  - no demoKind still builds the sales assistant (Ava), unchanged;
 *  - a forged session id is still 403 UNKNOWN_SESSION.
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
const getSalesConfig = vi.fn();
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
  getSalesConfig: (...args: unknown[]) => getSalesConfig(...args),
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

vi.mock('../services/geo.service', () => ({
  evaluateGate: vi.fn().mockResolvedValue({
    callAllowed: true,
    ipCountry: 'CA',
    phone: { country: 'CA', isNanp: true },
  }),
  // Distinct test IPs per case keep the route's rate limiters out of the way.
  clientIp: (req: { headers: Record<string, string | string[] | undefined> }) => {
    const v = req.headers['x-test-ip'];
    return (Array.isArray(v) ? v[0] : v) ?? '1.2.3.4';
  },
}));

vi.mock('../services/platform-config.service', () => ({
  getSettingValue: vi.fn().mockResolvedValue('https://api.example.test'),
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
  businessName: 'Maple Dental Studio',
  factsJson: {
    businessName: 'Maple Dental Studio',
    hours: ['Monday to Friday, 8 AM to 5 PM'],
    services: ['Cleanings', 'Crowns'],
    address: '2145 West 4th Avenue, Vancouver',
    phone: '+1 604 555 0182',
  },
};

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
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

beforeEach(() => {
  vi.clearAllMocks();
  demoLeadUpdate.mockResolvedValue({});
  setLeadMode.mockResolvedValue(undefined);
  isDemoEnabled.mockResolvedValue(true);
  demoLeadFindFirst.mockResolvedValue(LEAD_ROW);
  demoLeadFindMany.mockResolvedValue([]);
  demoCallCount.mockResolvedValue(0);
  resumeDemoSession.mockImplementation(async (sessionId: string) => fakeSession(sessionId));
  getSalesConfig.mockResolvedValue({ agentName: 'Ava', founderName: 'Sam', showCalendar: true });
  getDemoNumbers.mockResolvedValue({
    us: { id: 'num_us', number: '+15550001111' },
    ca: { id: 'num_ca', number: '+16045550199' },
  });
  pickDemoCallerId.mockReturnValue({ id: 'num_ca', number: '+16045550199' });
  placeOutboundCall.mockResolvedValue({ id: 'call_abc' });
});

let ipCounter = 0;
async function postCall(body: Record<string, unknown>) {
  ipCounter += 1;
  const res = await fetch(`${base}/api/demo/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-ip': `10.99.0.${ipCounter}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('POST /api/demo/call demo kinds', () => {
  it('refuses with 429 NUMBER_CAP once the number has had its 2 demo calls in 24h', async () => {
    // One matching lead in the window, and 2 completed demo calls on it.
    demoLeadFindMany.mockResolvedValue([{ demoSessionId: 'demo_other', phone: '+16045550182' }]);
    demoCallCount.mockResolvedValue(2);

    const { status, json } = await postCall({
      sessionId: 'demo_capcase',
      leadId: 'lead_1',
      name: 'Jordan Reyes',
      phone: '+1 (604) 555-0182',
      demoKind: 'receptionist',
    });

    expect(status).toBe(429);
    expect(json.error?.code).toBe('NUMBER_CAP');
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it('receptionist happy path: Maya calls, dressed in the clinic facts, golden voice, 180s cap', async () => {
    const { status, json } = await postCall({
      sessionId: 'demo_happy',
      leadId: 'lead_1',
      name: 'Jordan Reyes',
      phone: '+1 (604) 555-0182',
      demoKind: 'receptionist',
      facts: {
        businessName: 'Maple Dental Studio',
        hours: ['Monday to Friday, 8 AM to 5 PM'],
        services: ['Cleanings', 'Crowns'],
        address: '2145 West 4th Avenue, Vancouver',
      },
    });

    expect(status).toBe(200);
    expect(json.callId).toBe('call_abc');
    expect(placeOutboundCall).toHaveBeenCalledOnce();
    const arg = placeOutboundCall.mock.calls[0]?.[0] as {
      customerNumber: string;
      assistant: {
        firstMessage: string;
        maxDurationSeconds: number;
        voice: { provider: string; voiceId: string };
        model: { messages: Array<{ content: string }> };
        metadata: { demoSessionId?: string };
      };
    };
    expect(arg.customerNumber).toBe('+16045550182');
    expect(arg.assistant.firstMessage).toContain('Maple Dental Studio');
    expect(arg.assistant.firstMessage).toContain('VoiceFront demo you asked for');
    expect(arg.assistant.voice).toEqual({ provider: '11labs', voiceId: 'cgSgspJ2msm6clMCkdW9' });
    expect(arg.assistant.maxDurationSeconds).toBe(180);
    expect(arg.assistant.metadata.demoSessionId).toBe('demo_happy');
    const prompt = arg.assistant.model.messages[0]?.content ?? '';
    expect(prompt).toContain('Maple Dental Studio');
    expect(prompt).toContain('held in this demo');
  });

  it('receptionist with a long clinic name still places the call, assistant name within Vapi\u2019s 40-char cap', async () => {
    // 58 characters: under the API's own 60-char input cap, but the composed
    // assistant name ("Maya · <clinic> receptionist (demo)") runs to 85 and
    // Vapi rejects names over 40, which used to fail the call step outright.
    const longName = 'Modern Top Rated Dentist And Orthodontics Center Vancouver';
    const { status, json } = await postCall({
      sessionId: 'demo_longname',
      leadId: 'lead_1',
      name: 'Jordan Reyes',
      phone: '+1 (604) 555-0182',
      demoKind: 'receptionist',
      facts: {
        businessName: longName,
        hours: ['Monday to Friday, 8 AM to 5 PM'],
        services: ['Cleanings', 'Crowns'],
        address: '2145 West 4th Avenue, Vancouver',
      },
    });

    expect(status).toBe(200);
    expect(json.callId).toBe('call_abc');
    expect(placeOutboundCall).toHaveBeenCalledOnce();
    const arg = placeOutboundCall.mock.calls[0]?.[0] as {
      assistant: { name: string; firstMessage: string };
    };
    expect(arg.assistant.name.length).toBeLessThanOrEqual(40);
    // Only the Vapi display name is capped; the clinic identity the caller
    // hears (opener, prompt, facts) keeps the full name.
    expect(arg.assistant.firstMessage).toContain(longName);
  });

  it('without demoKind, still builds the sales assistant (Ava) exactly as before', async () => {
    const { status, json } = await postCall({
      sessionId: 'demo_sales',
      leadId: 'lead_1',
      name: 'Jordan Reyes',
      phone: '+1 (604) 555-0182',
    });

    expect(status).toBe(200);
    expect(json.callId).toBe('call_abc');
    expect(placeOutboundCall).toHaveBeenCalledOnce();
    const arg = placeOutboundCall.mock.calls[0]?.[0] as {
      assistant: { name: string; firstMessage: string; model: { messages: Array<{ content: string }> } };
    };
    expect(arg.assistant.name).toContain('Ava');
    // salesOpener with a known first name.
    expect(arg.assistant.firstMessage).toBe('Hi — is this Jordan?');
    expect(arg.assistant.model.messages[0]?.content).toContain('VoiceFront');
  });

  it('still refuses a forged session with 403 UNKNOWN_SESSION', async () => {
    demoLeadFindFirst.mockResolvedValue(null);
    const { status, json } = await postCall({
      sessionId: 'demo_forged',
      name: 'Jordan Reyes',
      phone: '+1 (604) 555-0182',
    });
    expect(status).toBe(403);
    expect(json.error?.code).toBe('UNKNOWN_SESSION');
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });
});
