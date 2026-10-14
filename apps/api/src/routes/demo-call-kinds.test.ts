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
 *  - the founder's own test pair (his lead email AND his own phone number,
 *    both at once) gets 5 calls per 24h instead; either half on its own
 *    stays at 2;
 *  - demoKind 'receptionist' places the call with a Maya assistant dressed
 *    in the clinic's facts (golden voice, clinic opener, 300s cap);
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

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  // Trust the forwarded header so the route's per-IP limiter sees the
  // distinct test IP each postCall sends (without this, every request in
  // the file shares the socket IP and the limiter caps the whole file).
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
  const testIp = `10.99.0.${ipCounter}`;
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

  it('owner test pair (his email + his number) places calls 3, 4 and 5, refused on the 6th', async () => {
    // Mixed case and stray spaces: the email compare trims and lowercases.
    demoLeadFindFirst.mockResolvedValue({ ...LEAD_ROW, email: '  Helmitshu@Gmail.com  ' });
    // Calls to his number are counted through leads carrying that number.
    demoLeadFindMany.mockResolvedValue([{ demoSessionId: 'demo_self', phone: '+15144315049' }]);

    // 2, 3 or 4 calls already placed today: the next one still goes
    // through (those are his 3rd, 4th and 5th). The destination is typed
    // without the country code; the digit comparison must still match.
    for (const placed of [2, 3, 4]) {
      demoCallCount.mockResolvedValue(placed);
      const { status, json } = await postCall({
        sessionId: 'demo_owner',
        leadId: 'lead_1',
        name: 'Hakim',
        phone: '514-431-5049',
        demoKind: 'receptionist',
      });
      expect(status).toBe(200);
      expect(json.callId).toBe('call_abc');
    }
    expect(placeOutboundCall).toHaveBeenCalledTimes(3);

    // 5 already placed: the 6th is refused, same as anyone else's cap.
    demoCallCount.mockResolvedValue(5);
    const { status, json } = await postCall({
      sessionId: 'demo_owner',
      leadId: 'lead_1',
      name: 'Hakim',
      phone: '514-431-5049',
      demoKind: 'receptionist',
    });
    expect(status).toBe(429);
    expect(json.error?.code).toBe('NUMBER_CAP');
    expect(placeOutboundCall).toHaveBeenCalledTimes(3);
  });

  it('owner email with a different destination still caps at 2', async () => {
    demoLeadFindFirst.mockResolvedValue({ ...LEAD_ROW, email: 'helmitshu@gmail.com' });
    demoLeadFindMany.mockResolvedValue([{ demoSessionId: 'demo_other', phone: '+16045550182' }]);
    demoCallCount.mockResolvedValue(2);

    const { status, json } = await postCall({
      sessionId: 'demo_owneremail',
      leadId: 'lead_1',
      name: 'Hakim',
      phone: '+1 (604) 555-0182',
      demoKind: 'receptionist',
    });

    expect(status).toBe(429);
    expect(json.error?.code).toBe('NUMBER_CAP');
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it('a different email calling the owner number still caps at 2', async () => {
    demoLeadFindFirst.mockResolvedValue({ ...LEAD_ROW, email: 'someone.else@example.com' });
    demoLeadFindMany.mockResolvedValue([{ demoSessionId: 'demo_self', phone: '+15144315049' }]);
    demoCallCount.mockResolvedValue(2);

    const { status, json } = await postCall({
      sessionId: 'demo_ownernumber',
      leadId: 'lead_1',
      name: 'Jordan Reyes',
      phone: '+1 (514) 431-5049',
      demoKind: 'receptionist',
    });

    expect(status).toBe(429);
    expect(json.error?.code).toBe('NUMBER_CAP');
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it('receptionist happy path: Maya calls, dressed in the clinic facts, golden voice, 300s cap', async () => {
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
        firstMessageMode?: string;
        maxDurationSeconds: number;
        silenceTimeoutSeconds?: number;
        backchannelingEnabled?: boolean;
        backgroundDenoisingEnabled?: boolean;
        backgroundSound: string;
        startSpeakingPlan?: { waitSeconds: number; smartEndpointingEnabled: boolean };
        stopSpeakingPlan?: {
          numWords: number;
          voiceSeconds: number;
          backoffSeconds: number;
          acknowledgementPhrases?: string[];
        };
        transcriber: {
          provider: string;
          model: string;
          language: string;
          endpointing?: number;
          eotThreshold?: number;
          keywords?: string[];
          keyterm?: string[];
        };
        voice: Record<string, unknown>;
        model: {
          temperature: number;
          messages: Array<{ content: string }>;
          tools?: Array<{
            type: string;
            server?: { url: string; secret?: string };
            function?: {
              name: string;
              parameters?: { properties: Record<string, { enum?: string[] }>; required: string[] };
            };
          }>;
        };
        metadata: { demoSessionId?: string };
      };
    };
    expect(arg.customerNumber).toBe('+16045550182');
    expect(arg.assistant.firstMessage).toContain('Maple Dental Studio');
    expect(arg.assistant.firstMessage).toContain('VoiceFront demo you asked for');
    // The demo agent runs the retuned standard (v2): full voice tuning,
    // not just the id.
    expect(arg.assistant.voice).toEqual({
      provider: '11labs',
      voiceId: 'cgSgspJ2msm6clMCkdW9',
      model: 'eleven_turbo_v2_5',
      stability: 0.4,
      similarityBoost: 0.75,
      style: 0.3,
      useSpeakerBoost: true,
      speed: 1.1,
      optimizeStreamingLatency: 3,
    });
    expect(arg.assistant.maxDurationSeconds).toBe(300);
    expect(arg.assistant.metadata.demoSessionId).toBe('demo_happy');
    // Demo-standard (v2) call mechanics, pinned end to end.
    expect(arg.assistant.model.temperature).toBe(0.55);
    expect(arg.assistant.transcriber.provider).toBe('deepgram');
    expect(arg.assistant.transcriber.model).toBe('flux-general-en');
    expect(arg.assistant.transcriber.language).toBe('en');
    expect(arg.assistant.transcriber.endpointing).toBeUndefined();
    expect(arg.assistant.transcriber.eotThreshold).toBe(0.8);
    // Flux renders the clinic boosts as plain `keyterm` entries.
    expect(arg.assistant.transcriber.keywords).toBeUndefined();
    expect(arg.assistant.transcriber.keyterm).toEqual(
      expect.arrayContaining(['dental', 'cleaning', 'Maya', 'Invisalign', 'Maple', 'Studio']),
    );
    // Smart endpointing stays off so it cannot override Flux's turn
    // detection; the acknowledgement phrases ride in the stop plan.
    expect(arg.assistant.startSpeakingPlan).toEqual({ waitSeconds: 0.3, smartEndpointingEnabled: false });
    expect(arg.assistant.stopSpeakingPlan).toEqual({
      numWords: 2,
      voiceSeconds: 0.2,
      backoffSeconds: 0.6,
      acknowledgementPhrases: ['okay', 'uh-huh', 'yeah', 'mm-hmm'],
    });
    expect(arg.assistant.silenceTimeoutSeconds).toBe(30);
    expect(arg.assistant.backchannelingEnabled).toBe(true);
    // Noise cleaning on the prospect's audio, pinned on the receptionist path.
    expect(arg.assistant.backgroundDenoisingEnabled).toBe(true);
    expect(arg.assistant.backgroundSound).toBe('office');
    expect(arg.assistant.firstMessageMode).toBe('assistant-speaks-first');
    const prompt = arg.assistant.model.messages[0]?.content ?? '';
    expect(prompt).toContain('Maple Dental Studio');
    expect(prompt).toContain('held in this demo');
    // Known data (Call Map v1): the lead's name and the number being
    // dialed ride in as already-known, in their own block, for Maya to
    // confirm rather than collect cold.
    const knownBlock = prompt.slice(prompt.indexOf('WHAT YOU ALREADY KNOW'), prompt.indexOf('STATE 1 — GREET'));
    expect(knownBlock).toContain('The name on the demo request: Jordan Reyes');
    expect(knownBlock).toContain('The number you dialed for this call: +1 604 555 0182');
    expect(knownBlock).toContain('is it the one I just called you on?');
    // The fragment rule rides along: no booking a time off a cut-off word,
    // and a bare approval of a list of times is not a booking either.
    expect(prompt).toContain('NEVER BOOK A TIME THE CALLER DID NOT CLEARLY CHOOSE');
    expect(prompt).toContain('Shall I hold 2 PM for you?');
    expect(prompt).toContain('happy and professional');
    // The v2 delivery guidance rides along: short turns, ellipsis pauses.
    expect(prompt).toContain('Use an ellipsis as your pause button');
    expect(prompt).toContain('one or two short sentences, never a paragraph');
    // Function-gated booking: exactly ONE tool rides on Maya — the hold
    // tool — and the stock booking tools are gone, so a prose "booking" is
    // the only failure mode left and the prompt forbids it.
    const tools = arg.assistant.model.tools ?? [];
    expect(tools).toHaveLength(1);
    const holdTool = tools[0]!;
    expect(holdTool.type).toBe('function');
    expect(holdTool.function?.name).toBe('hold_appointment');
    expect(holdTool.server?.url).toBe('https://api.example.test/api/demo/hold');
    expect(holdTool.server?.secret).toBe('https://api.example.test');
    expect(Object.keys(holdTool.function?.parameters?.properties ?? {}).sort()).toEqual([
      'action',
      'callbackNumber',
      'date',
      'newPatient',
      'patientName',
      'service',
      'time',
    ]);
    expect(holdTool.function?.parameters?.properties.action?.enum).toEqual(['hold', 'change', 'cancel']);
    expect(holdTool.function?.parameters?.required).toEqual(['action']);
    const toolNames = tools.map((t) => t.function?.name);
    expect(toolNames).not.toContain('bookAppointment');
    expect(toolNames).not.toContain('checkAvailability');
    expect(toolNames).not.toContain('findAppointment');
    expect(toolNames).not.toContain('rescheduleAppointment');
    expect(toolNames).not.toContain('cancelAppointment');
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
      assistant: {
        name: string;
        firstMessage: string;
        voice: Record<string, unknown>;
        transcriber: { model: string; endpointing?: number };
        startSpeakingPlan?: { waitSeconds: number; smartEndpointingEnabled: boolean };
        stopSpeakingPlan?: { numWords: number; voiceSeconds: number; backoffSeconds: number };
        model: {
          temperature: number;
          messages: Array<{ content: string }>;
          tools?: Array<{ function?: { name: string } }>;
        };
      };
    };
    expect(arg.assistant.name).toContain('Ava');
    // The hold tool is receptionist-only: Ava keeps the stock booking
    // toolset and never sees hold_appointment.
    const avaToolNames = (arg.assistant.model.tools ?? []).map((t) => t.function?.name);
    expect(avaToolNames).not.toContain('hold_appointment');
    expect(avaToolNames).toContain('bookAppointment');
    // salesOpener with a known first name.
    expect(arg.assistant.firstMessage).toBe('Hi — is this Jordan?');
    expect(arg.assistant.model.messages[0]?.content).toContain('VoiceFront');
    // The golden-parity work must not leak into Ava: her voice, temperature,
    // transcriber and speaking plans stay exactly the builder defaults.
    expect(arg.assistant.voice).toEqual({ provider: 'vapi', voiceId: 'Savannah', version: 2 });
    expect(arg.assistant.model.temperature).toBe(0.65);
    expect(arg.assistant.transcriber.model).toBe('nova-2');
    expect(arg.assistant.transcriber.endpointing).toBeUndefined();
    expect(arg.assistant.startSpeakingPlan).toEqual({ waitSeconds: 0.6, smartEndpointingEnabled: true });
    expect(arg.assistant.stopSpeakingPlan).toEqual({ numWords: 3, voiceSeconds: 0.3, backoffSeconds: 1.0 });
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
