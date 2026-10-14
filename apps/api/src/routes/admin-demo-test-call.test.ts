import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

/**
 * Route-level tests for POST /api/admin/demo/test-call — the owner-only
 * backend trigger for the personalized receptionist demo. Same harness as
 * the other route suites: spies declared first, vi.mock factories, the real
 * routers on a throwaway express app, exercised over real HTTP.
 *
 * Pinned behaviour:
 *  - the platform's existing admin auth is the only gate: no token → 401,
 *    a signed-in non-admin → 403, a SUPPORT operator → 403 (full admin);
 *  - with the demo master toggle off the trigger refuses DEMO_DISABLED and
 *    places nothing;
 *  - the happy path creates the session + lead server-side with the owner
 *    identity, pulls the clinic facts and stores them on the lead, then
 *    places exactly one receptionist call through the same assistant shape
 *    POST /api/demo/call produces — and NEVER consults the per-destination
 *    cap (no DemoLead scan, no DemoCall count);
 *  - a malformed website URL is a 400 and an unreadable one a 422, both
 *    before any lead exists or any call is placed.
 */

const userFindUnique = vi.fn();
const demoLeadUpdate = vi.fn().mockResolvedValue({});
const demoLeadFindMany = vi.fn();
const demoCallCount = vi.fn();

vi.mock('../lib/prisma', () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => userFindUnique(...args) },
    demoLead: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: (...args: unknown[]) => demoLeadFindMany(...args),
      update: (...args: unknown[]) => demoLeadUpdate(...args),
    },
    demoCall: { count: (...args: unknown[]) => demoCallCount(...args) },
  },
}));

vi.mock('../lib/jwt', () => ({
  verifyAccessToken: (token: string) => {
    if (token === 'admin-token') return { sub: 'user_admin', tid: 'tenant_platform', role: 'OWNER' };
    if (token === 'support-token') return { sub: 'user_support', tid: 'tenant_platform', role: 'OWNER' };
    if (token === 'plain-token') return { sub: 'user_plain', tid: 'tenant_x', role: 'OWNER' };
    throw new Error('invalid token');
  },
}));

const resolvePlatformRole = vi.fn();
vi.mock('../services/platform-admin.service', () => ({
  PLATFORM_TENANT_SLUG: '__platform',
  resolvePlatformRole: (...args: unknown[]) => resolvePlatformRole(...args),
  addAdmin: vi.fn(),
  listAdmins: vi.fn().mockResolvedValue([]),
  removeAdmin: vi.fn(),
}));

const recordAdminAction = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/platform-config.service', () => ({
  SETTING_KEYS: [],
  SETTING_META: {},
  assertSettingKey: (key: string) => key,
  getSetting: vi.fn().mockResolvedValue({ value: null, source: 'unset' }),
  getSettingValue: vi.fn().mockResolvedValue('https://api.example.test'),
  maskValue: (v: string) => v,
  recordAdminAction: (...args: unknown[]) => recordAdminAction(...args),
  setSetting: vi.fn().mockResolvedValue(undefined),
  unsetSetting: vi.fn().mockResolvedValue(undefined),
}));

const isDemoEnabled = vi.fn();
const startDemoSession = vi.fn();
const resumeDemoSession = vi.fn();
const createDemoLead = vi.fn();
const setLeadMode = vi.fn().mockResolvedValue(undefined);
const getDemoNumbers = vi.fn();
const pickDemoCallerId = vi.fn();

vi.mock('../services/demo.service', () => ({
  DEMO_TENANT_SLUG: '__demo',
  isDemoEnabled: (...args: unknown[]) => isDemoEnabled(...args),
  setDemoEnabled: vi.fn().mockResolvedValue(undefined),
  startDemoSession: (...args: unknown[]) => startDemoSession(...args),
  resumeDemoSession: (...args: unknown[]) => resumeDemoSession(...args),
  getDemoAppointments: vi.fn().mockResolvedValue([]),
  blockDemoSlot: vi.fn().mockResolvedValue([]),
  resetDemoSession: vi.fn().mockResolvedValue({}),
  createDemoLead: (...args: unknown[]) => createDemoLead(...args),
  setLeadMode: (...args: unknown[]) => setLeadMode(...args),
  getSalesConfig: vi.fn().mockResolvedValue({ agentName: 'Ava', founderName: 'Hakim', showCalendar: true }),
  setSalesConfig: vi.fn().mockResolvedValue(undefined),
  listRecentDemoCalls: vi.fn().mockResolvedValue([]),
  getDemoNumbers: (...args: unknown[]) => getDemoNumbers(...args),
  setDemoNumbers: vi.fn().mockResolvedValue({ us: null, ca: null }),
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
  createAssistantForTenant: vi.fn(),
  createPhoneNumberInVapi: vi.fn(),
  findAssistantPhoneNumber: vi.fn(),
  listVapiPhoneNumbers: vi.fn().mockResolvedValue([]),
  repointAllPhoneNumbers: vi.fn(),
  syncAssistantForTenant: vi.fn(),
  syncAllAssistants: vi.fn(),
  validateAssistant: vi.fn(),
}));

vi.mock('../services/geo.service', () => ({
  evaluateGate: vi.fn().mockResolvedValue({
    callAllowed: true,
    ipCountry: 'CA',
    phone: { country: 'CA', isNanp: true },
  }),
  clientIp: () => '127.0.0.1',
}));

const fetchClinicFacts = vi.fn();
vi.mock('../services/clinic-facts.service', () => ({
  fetchClinicFacts: (...args: unknown[]) => fetchClinicFacts(...args),
}));

vi.mock('../services/features.service', () => ({
  getTenantFeatures: vi.fn().mockResolvedValue([]),
  setFeatureByAdmin: vi.fn(),
}));

vi.mock('../services/founder.service', () => ({
  listFounderEntries: vi.fn().mockResolvedValue([]),
  founderAvailability: vi.fn().mockResolvedValue(null),
  blockFounderTime: vi.fn(),
  removeFounderEntry: vi.fn().mockResolvedValue(undefined),
  getFounderTimezone: vi.fn().mockResolvedValue('America/Vancouver'),
  getFounderCalendarStatus: vi.fn().mockResolvedValue({}),
  buildFounderCalendarAuthUrl: vi.fn().mockResolvedValue(''),
  disconnectFounderCalendar: vi.fn().mockResolvedValue(undefined),
  setFounderCalendarPrefs: vi.fn().mockResolvedValue(undefined),
  getFounderExternalEvents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/access-code.service', () => ({
  generateAccessCode: vi.fn(),
  listAccessCodes: vi.fn().mockResolvedValue([]),
  revokeAccessCode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/leadgen.service', () => ({
  bulkLeads: vi.fn(),
  deleteLead: vi.fn().mockResolvedValue(undefined),
  getLeadStats: vi.fn().mockResolvedValue({}),
  listLeads: vi.fn().mockResolvedValue({ leads: [], total: 0 }),
  scrapeEmailForLead: vi.fn(),
  scrapeEmails: vi.fn(),
  sourceLeads: vi.fn(),
  updateLead: vi.fn(),
}));

vi.mock('../services/outreach.service', () => ({ buildOutreachEmail: vi.fn() }));
vi.mock('../services/mailer.service', () => ({ sendOutreachEmail: vi.fn() }));
vi.mock('../services/usage.service', () => ({ getMonthlyUsage: vi.fn().mockResolvedValue({}) }));
vi.mock('../services/phone-pool.service', () => ({
  addNumber: vi.fn(),
  availableCount: vi.fn().mockResolvedValue(0),
  listPool: vi.fn().mockResolvedValue([]),
  removeNumber: vi.fn().mockResolvedValue(undefined),
  releaseNumberForTenant: vi.fn().mockResolvedValue(undefined),
  toPoolEntry: (n: unknown) => n,
}));
vi.mock('../lib/webhook-url', () => ({
  resolveWebhookUrl: vi.fn().mockResolvedValue({ webhookUrl: null, productionSafe: false, reason: null }),
}));

import { adminRouter } from './admin.routes';
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
      sampleCompany: 'SmileCraft Dental',
    },
    appointments: [],
  };
}

const FACTS = {
  businessName: 'SmileCraft Dental',
  phone: '+1 604 555 0100',
  address: '7980 206A Street, Langley, BC',
  hours: ['Tuesday to Friday, 9:30 AM to 6 PM'],
  services: ['Cleanings', 'Invisalign'],
};

const WEBSITE = 'https://smilecraft.ca/new-patients/';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
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
  recordAdminAction.mockResolvedValue(undefined);
  userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === 'user_admin') return { email: 'helmitshu@gmail.com' };
    if (where.id === 'user_support') return { email: 'support@example.com' };
    if (where.id === 'user_plain') return { email: 'customer@example.com' };
    return null;
  });
  resolvePlatformRole.mockImplementation(async (email: string) => {
    if (email === 'helmitshu@gmail.com') return 'ADMIN';
    if (email === 'support@example.com') return 'SUPPORT';
    return null;
  });
  isDemoEnabled.mockResolvedValue(true);
  startDemoSession.mockImplementation(async () => fakeSession('demo_testcall'));
  resumeDemoSession.mockImplementation(async (sessionId: string) => fakeSession(sessionId));
  createDemoLead.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 'lead_test',
    name: input.name,
    businessName: input.businessName ?? null,
  }));
  fetchClinicFacts.mockResolvedValue(FACTS);
  getDemoNumbers.mockResolvedValue({
    us: { id: 'num_us', number: '+15550001111' },
    ca: { id: 'num_ca', number: '+16045550199' },
  });
  pickDemoCallerId.mockReturnValue({ id: 'num_ca', number: '+16045550199' });
  placeOutboundCall.mockResolvedValue({ id: 'call_test' });
  demoLeadFindMany.mockResolvedValue([]);
  demoCallCount.mockResolvedValue(0);
});

async function postTestCall(body: Record<string, unknown>, token?: string) {
  const res = await fetch(`${base}/api/admin/demo/test-call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('POST /api/admin/demo/test-call', () => {
  it('rejects an unauthenticated request with 401 and places nothing', async () => {
    const { status, json } = await postTestCall({ websiteUrl: WEBSITE });
    expect(status).toBe(401);
    expect(json.error?.code).toBe('UNAUTHENTICATED');
    expect(placeOutboundCall).not.toHaveBeenCalled();
    expect(createDemoLead).not.toHaveBeenCalled();
  });

  it('rejects a signed-in non-admin with 403', async () => {
    const { status, json } = await postTestCall({ websiteUrl: WEBSITE }, 'plain-token');
    expect(status).toBe(403);
    expect(json.error?.code).toBe('FORBIDDEN');
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it('rejects a SUPPORT operator with 403 (full admin only, like the other demo controls)', async () => {
    const { status, json } = await postTestCall({ websiteUrl: WEBSITE }, 'support-token');
    expect(status).toBe(403);
    expect(json.error?.code).toBe('NEEDS_FULL_ADMIN');
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it('refuses with DEMO_DISABLED when the demo master toggle is off', async () => {
    isDemoEnabled.mockResolvedValue(false);
    const { status, json } = await postTestCall({ websiteUrl: WEBSITE }, 'admin-token');
    expect(status).toBe(403);
    expect(json.error?.code).toBe('DEMO_DISABLED');
    expect(fetchClinicFacts).not.toHaveBeenCalled();
    expect(createDemoLead).not.toHaveBeenCalled();
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it('happy path: owner lead, facts pulled and stored, exactly one receptionist call, cap never consulted', async () => {
    const { status, json } = await postTestCall({ websiteUrl: WEBSITE }, 'admin-token');

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.callId).toBe('call_test');
    expect(json.fromNumber).toBe('+16045550199');
    expect(json.sessionId).toBe('demo_testcall');
    expect(json.leadId).toBe('lead_test');
    expect(json.clinicName).toBe('SmileCraft Dental');
    expect(json.facts).toEqual(FACTS);

    // Facts pulled from the given site, then the session + lead created
    // server-side with the owner identity as the prospect.
    expect(fetchClinicFacts).toHaveBeenCalledWith(WEBSITE);
    expect(startDemoSession).toHaveBeenCalledWith('clinic', 'SmileCraft Dental');
    expect(createDemoLead).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'demo_testcall',
        name: 'Hakim',
        email: 'helmitshu@gmail.com',
        phone: '+1 514 431 5049',
        industry: 'clinic',
        businessName: 'SmileCraft Dental',
        websiteUrl: WEBSITE,
      }),
    );
    // The pulled facts are stored on the lead, exactly like /clinic-facts.
    expect(demoLeadUpdate).toHaveBeenCalledWith({
      where: { id: 'lead_test' },
      data: { factsJson: FACTS },
    });
    expect(setLeadMode).toHaveBeenCalledWith('lead_test', 'call');

    // The per-destination cap is never consulted on this route: no lead
    // scan, no completed-call count.
    expect(demoLeadFindMany).not.toHaveBeenCalled();
    expect(demoCallCount).not.toHaveBeenCalled();

    // Exactly one call, to the owner's own number, with the same Maya
    // assistant shape POST /api/demo/call produces for kind receptionist.
    expect(placeOutboundCall).toHaveBeenCalledOnce();
    const arg = placeOutboundCall.mock.calls[0]?.[0] as {
      phoneNumberId: string;
      customerNumber: string;
      assistant: {
        firstMessage: string;
        maxDurationSeconds: number;
        metadata: { demoSessionId?: string };
        model: {
          tools?: Array<{
            type: string;
            server?: { url: string };
            function?: { name: string };
          }>;
        };
      };
    };
    expect(arg.phoneNumberId).toBe('num_ca');
    expect(arg.customerNumber).toBe('+15144315049');
    expect(arg.assistant.firstMessage).toContain('SmileCraft Dental');
    expect(arg.assistant.maxDurationSeconds).toBe(300);
    expect(arg.assistant.metadata.demoSessionId).toBe('demo_testcall');
    const tools = arg.assistant.model.tools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.function?.name).toBe('hold_appointment');
    expect(tools[0]?.server?.url).toBe('https://api.example.test/api/demo/hold');

    // Audited like every other admin mutation.
    expect(recordAdminAction).toHaveBeenCalledWith(
      'helmitshu@gmail.com',
      'demo.testCall',
      'SmileCraft Dental',
      expect.objectContaining({ callId: 'call_test', websiteUrl: WEBSITE }),
    );
  });

  it('rejects a malformed website URL with a clean 400 before anything is created', async () => {
    const { status, json } = await postTestCall({ websiteUrl: 'not a url' }, 'admin-token');
    expect(status).toBe(400);
    expect(json.error?.code).toBe('VALIDATION_ERROR');
    expect(fetchClinicFacts).not.toHaveBeenCalled();
    expect(createDemoLead).not.toHaveBeenCalled();
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it('refuses with 422 when the website yields no facts — no lead, no call', async () => {
    fetchClinicFacts.mockResolvedValue(null);
    const { status, json } = await postTestCall({ websiteUrl: WEBSITE }, 'admin-token');
    expect(status).toBe(422);
    expect(json.error?.code).toBe('FACTS_UNAVAILABLE');
    expect(createDemoLead).not.toHaveBeenCalled();
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });
});
