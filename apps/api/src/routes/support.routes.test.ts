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
  process.env.TWILIO_ACCOUNT_SID = 'AC-test';
  process.env.TWILIO_AUTH_TOKEN = 'test-twilio-token';
  process.env.TWILIO_FROM_NUMBER = '+14165550100';

  interface FakeSettings {
    tenantId: string;
    displayName: string;
    businessHours: unknown;
    timezone: string;
    inboundPhoneNumber: string | null;
    smsEnabled: boolean;
    smsConfirmation: boolean;
    smsReminder24h: boolean;
    smsReminder1h: boolean;
    smsWaitlist: boolean;
    reactivationEnabled: boolean;
    reactivationInactivityDays: number;
    rejectAnonymousCallers: boolean;
    serviceAreaZips: unknown;
    serviceAreaNote: string | null;
    onCallRoster: unknown;
    dispatchEscalationSeconds: number;
    avgAppointmentValue: number;
    systemPrompt: string;
  }
  interface FakeTenant {
    id: string;
    companyName: string;
    industry: string;
    subscriptionStatus: string;
    monthlyMinuteLimit: number;
    featureFlags?: unknown;
  }
  interface FakeTenantFeature {
    tenantId: string;
    feature: string;
    entitled: boolean;
    selfManage: boolean;
    enabled: boolean;
  }
  interface FakeCalendarConnection {
    id: string;
    tenantId: string;
    provider: string;
    accountEmail: string | null;
    writeEnabled: boolean;
    blockBusy: boolean;
    lastError: string | null;
    createdAt: Date;
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
    endedAt: Date | null;
    endedReason: string | null;
    callerNumber: string | null;
    channel: string;
    status: string;
    outcome: string | null;
    intent: string | null;
    urgency: string | null;
    leadQuality: string | null;
    appointmentBooked: boolean;
    rescueNeeded: boolean;
    rescueReason: string | null;
    summary: string | null;
    transcript: string | null;
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
  const tenantFeatures: FakeTenantFeature[] = [];
  const calendarConnections: FakeCalendarConnection[] = [];
  const tickets: FakeTicket[] = [];
  let ticketSeq = 0;
  interface FakeSimRun {
    id: string; tenantId: string; createdByUserId: string; kind: string; status: string;
    scenarioTitle: string; scenarioPrompt: string; sourceCallLogId: string | null;
    diagnosis: string | null; fixSummary: string | null; originNumber: string | null;
    patientCallId: string | null; receptionistCallId: string | null;
    resultSummary: string | null; resultTranscript: string | null; resultRecordingUrl: string | null;
    resultSuccessScore: number | null; resultOutcome: string | null; resultDurationSeconds: number;
    patientTranscript: string | null; patientRecordingUrl: string | null;
    cleanupCount: number; createdAt: Date; completedAt: Date | null;
  }
  const simRuns: FakeSimRun[] = [];
  let simRunSeq = 0;
  const weeklyReviews: Array<Record<string, unknown>> = [];
  const servicesList: Array<Record<string, unknown>> = [];
  const providersList: Array<Record<string, unknown>> = [];
  const documentsList: Array<Record<string, unknown>> = [];
  const vapiCalls: Array<Record<string, unknown>> = [];
  const uploads: Array<{ buffer: Buffer; fileName: string; mimeType: string }> = [];

  function rowMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [key, cond] of Object.entries(where ?? {})) {
      const value = row[key];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as Record<string, unknown>;
        if ('not' in c && value === c.not) return false;
        if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
        if ('gte' in c && !((value as Date) >= (c.gte as Date))) return false;
        if ('lt' in c && !((value as Date) < (c.lt as Date))) return false;
      } else if (value !== cond) {
        return false;
      }
    }
    return true;
  }
  const auditCalls: Array<{ email: string; action: string; target: string | null; detail: unknown }> = [];
  const geminiScript: unknown[] = [];
  const geminiRequests: Array<{ contents: unknown; systemInstruction?: { parts: Array<{ text: string }> } }> = [];

  const settingsExtras = () => ({
    avgAppointmentValue: 0,
    systemPrompt: '',
    smsEnabled: true,
    smsConfirmation: true,
    smsReminder24h: true,
    smsReminder1h: false,
    smsWaitlist: false,
    reactivationEnabled: false,
    reactivationInactivityDays: 180,
    rejectAnonymousCallers: true,
    serviceAreaZips: [],
    serviceAreaNote: null,
    onCallRoster: [],
    dispatchEscalationSeconds: 120,
  });

  function seed() {
    tenants.clear();
    settings.clear();
    users.clear();
    calls.clear();
    tenantFeatures.length = 0;
    calendarConnections.length = 0;
    tickets.length = 0;
    ticketSeq = 0;
    simRuns.length = 0;
    simRunSeq = 0;
    weeklyReviews.length = 0;
    servicesList.length = 0;
    providersList.length = 0;
    documentsList.length = 0;
    vapiCalls.length = 0;
    uploads.length = 0;
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
      timezone: 'America/Toronto', inboundPhoneNumber: '+14165550100', ...settingsExtras(),
      avgAppointmentValue: 250,
      systemPrompt: 'We accept Delta Dental. A cleaning costs $180 for existing patients.',
    });
    settings.set('tenant_b', {
      tenantId: 'tenant_b', displayName: 'Ava', businessHours: defaultHours(),
      timezone: 'America/Vancouver', inboundPhoneNumber: '+16045550199', ...settingsExtras(),
      avgAppointmentValue: 200, systemPrompt: '',
    });
    servicesList.push(
      { tenantId: 'tenant_a', name: 'Cleaning', durationMinutes: 60, description: 'Routine hygiene cleaning.', active: true },
      { tenantId: 'tenant_a', name: 'Whitening', durationMinutes: 45, description: null, active: true },
    );
    providersList.push({ tenantId: 'tenant_a', name: 'Dr. Sam Lee', title: 'Dentist', active: true });
    documentsList.push({ tenantId: 'tenant_a', fileName: 'insurance-faq.pdf' });
    tenantFeatures.push({
      tenantId: 'tenant_a', feature: 'MISSED_CALL_TEXTBACK',
      entitled: true, selfManage: true, enabled: true,
    });
    calendarConnections.push({
      id: 'calendar_a', tenantId: 'tenant_a', provider: 'GOOGLE',
      accountEmail: 'frontdesk@alpha.test', writeEnabled: false, blockBusy: true,
      lastError: null, createdAt: new Date('2026-10-01T12:00:00Z'),
    });
    users.set('user_a', { id: 'user_a', tenantId: 'tenant_a', email: 'owner@alpha.test', role: 'OWNER' });
    users.set('user_a_agent', { id: 'user_a_agent', tenantId: 'tenant_a', email: 'staff@alpha.test', role: 'AGENT' });
    users.set('user_b', { id: 'user_b', tenantId: 'tenant_b', email: 'owner@beta.test', role: 'OWNER' });

    calls.set('call_a1', {
      id: 'call_a1', tenantId: 'tenant_a', startedAt: new Date('2026-10-14T19:42:00Z'),
      endedAt: new Date('2026-10-14T19:45:04Z'), endedReason: 'assistant-ended-call',
      callerNumber: '+14165550123', channel: 'phone', status: 'COMPLETED', outcome: 'BOOKED',
      intent: 'BOOK', urgency: 'LOW', leadQuality: 'WARM', appointmentBooked: true,
      rescueNeeded: false, rescueReason: null,
      summary: 'Booked a cleaning for next week.',
      transcript: 'Caller: I need a cleaning. Receptionist: I can help with that.',
      durationSeconds: 184,
      successScore: 4, structuredData: { callerName: 'Jamie Lee' },
    });
    calls.set('call_a2', {
      id: 'call_a2', tenantId: 'tenant_a', startedAt: new Date('2026-10-13T15:05:00Z'),
      endedAt: new Date('2026-10-13T15:06:02Z'), endedReason: 'customer-ended-call',
      callerNumber: '+14165550177', channel: 'phone', status: 'COMPLETED', outcome: 'MESSAGE_TAKEN',
      intent: 'QUESTION', urgency: 'LOW', leadQuality: 'COLD', appointmentBooked: false,
      rescueNeeded: true, rescueReason: 'The call failed (no-answer).',
      summary: 'Asked about parking.', transcript: '', durationSeconds: 62,
      successScore: 8, structuredData: { callerName: 'Pat Ng' },
    });
    calls.set('call_b1', {
      id: 'call_b1', tenantId: 'tenant_b', startedAt: new Date('2026-10-14T17:20:00Z'),
      endedAt: new Date('2026-10-14T17:20:21Z'), endedReason: 'customer-hung-up',
      callerNumber: '+16045550155', channel: 'phone', status: 'COMPLETED', outcome: 'NO_ACTION',
      intent: 'OTHER', urgency: 'HIGH', leadQuality: 'HOT', appointmentBooked: false,
      rescueNeeded: false, rescueReason: null,
      summary: 'Caller hung up.', transcript: 'Caller: This is the other workspace.',
      durationSeconds: 21,
      successScore: 2, structuredData: { callerName: 'Beta Caller' },
    });
  }

  return {
    tenants, settings, users, calls, tenantFeatures, calendarConnections, tickets,
    auditCalls, geminiScript, geminiRequests, seed, defaultHours,
    simRuns, weeklyReviews, servicesList, providersList, documentsList, vapiCalls, uploads,
    rowMatches,
    nextSimRunId: () => `simrun_${++simRunSeq}`,
  };
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
    tenantFeature: {
      findMany: (args: { where: { tenantId: string } }) =>
        Promise.resolve(state.tenantFeatures.filter((f) => f.tenantId === args.where.tenantId)),
    },
    calendarConnection: {
      findMany: (args: { where: { tenantId: string } }) =>
        Promise.resolve(state.calendarConnections.filter((c) => c.tenantId === args.where.tenantId)),
    },
    callLog: {
      aggregate: () => Promise.resolve({ _sum: { durationSeconds: 30 * 60 } }),
      findMany: (args: {
        where: { tenantId: string; startedAt?: { gte?: Date; lt?: Date } };
        take?: number;
      }) => {
        const rows = [...state.calls.values()]
          .filter((c) => c.tenantId === args.where.tenantId)
          .filter((c) => {
            const st = (args.where as { status?: { not?: string } }).status;
            return !st?.not || c.status !== st.not;
          })
          .filter((c) => !args.where.startedAt?.gte || c.startedAt >= args.where.startedAt.gte)
          .filter((c) => !args.where.startedAt?.lt || c.startedAt < args.where.startedAt.lt)
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
          .slice(0, args.take ?? 10);
        return Promise.resolve(rows);
      },
      findFirst: (args: { where: { id: string; tenantId: string } }) => {
        const row = state.calls.get(args.where.id);
        return Promise.resolve(row && row.tenantId === args.where.tenantId ? row : null);
      },
    },
    simulatedCallRun: {
      create: (args: { data: Record<string, unknown> }) => {
        const row = {
          id: state.nextSimRunId(),
          sourceCallLogId: null, diagnosis: null, fixSummary: null, originNumber: null,
          patientCallId: null, receptionistCallId: null, resultSummary: null,
          resultTranscript: null, resultRecordingUrl: null, resultSuccessScore: null,
          resultOutcome: null, resultDurationSeconds: 0, patientTranscript: null,
          patientRecordingUrl: null, cleanupCount: 0, completedAt: null,
          createdAt: new Date(),
          ...args.data,
        } as (typeof state.simRuns)[number];
        state.simRuns.push(row);
        return Promise.resolve(row);
      },
      findFirst: (args: { where: Record<string, unknown>; orderBy?: { createdAt?: string } }) => {
        const rows = state.simRuns.filter((r) => state.rowMatches(r as never, args.where));
        rows.sort((a, b) => (args.orderBy?.createdAt === 'desc'
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : a.createdAt.getTime() - b.createdAt.getTime()));
        return Promise.resolve(rows[0] ?? null);
      },
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(state.simRuns.find((r) => r.id === args.where.id) ?? null),
      count: (args: { where: Record<string, unknown> }) =>
        Promise.resolve(state.simRuns.filter((r) => state.rowMatches(r as never, args.where)).length),
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.simRuns.find((r) => r.id === args.where.id);
        if (!row) return Promise.reject(new Error('run missing'));
        Object.assign(row, args.data);
        return Promise.resolve(row);
      },
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of state.simRuns) {
          if (state.rowMatches(row as never, args.where)) { Object.assign(row, args.data); count += 1; }
        }
        return Promise.resolve({ count });
      },
    },
    adamWeeklyReview: {
      findFirst: (args: { where: Record<string, unknown> }) =>
        Promise.resolve(state.weeklyReviews.find((r) => state.rowMatches(r, args.where)) ?? null),
      findUnique: (args: { where: { tenantId_weekKey: { tenantId: string; weekKey: string } } }) =>
        Promise.resolve(state.weeklyReviews.find(
          (r) => r.tenantId === args.where.tenantId_weekKey.tenantId && r.weekKey === args.where.tenantId_weekKey.weekKey,
        ) ?? null),
      create: (args: { data: Record<string, unknown> }) => {
        const row = { id: `review_${state.weeklyReviews.length + 1}`, createdAt: new Date(), ...args.data };
        state.weeklyReviews.push(row);
        return Promise.resolve(row);
      },
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of state.weeklyReviews) {
          if (state.rowMatches(row, args.where)) { Object.assign(row, args.data); count += 1; }
        }
        return Promise.resolve({ count });
      },
    },
    service: {
      findMany: (args: { where: { tenantId: string } }) =>
        Promise.resolve(state.servicesList.filter((r) => r.tenantId === args.where.tenantId)),
    },
    provider: {
      findMany: (args: { where: { tenantId: string } }) =>
        Promise.resolve(state.providersList.filter((r) => r.tenantId === args.where.tenantId)),
    },
    document: {
      findMany: (args: { where: { tenantId: string } }) =>
        Promise.resolve(state.documentsList.filter((r) => r.tenantId === args.where.tenantId)),
      create: (args: { data: Record<string, unknown> }) => {
        const row = { id: `doc_${state.documentsList.length + 1}`, ...args.data };
        state.documentsList.push(row);
        return Promise.resolve(row);
      },
    },
    appointment: {
      deleteMany: () => Promise.resolve({ count: 0 }),
      updateMany: () => Promise.resolve({ count: 0 }),
    },
    jobRequest: {
      deleteMany: () => Promise.resolve({ count: 0 }),
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
  placeOutboundCall: (input: Record<string, unknown>) => {
    state.vapiCalls.push(input);
    return Promise.resolve({ id: 'vapi_patient_1', status: 'queued' });
  },
  uploadFileToVapi: (buffer: Buffer, fileName: string, mimeType: string) => {
    state.uploads.push({ buffer, fileName, mimeType });
    return Promise.resolve({ id: 'vapi_file_1', status: 'processed' });
  },
}));

vi.mock('../services/demo.service', () => {
  const day = { enabled: true, open: '08:00', close: '17:00' };
  const off = { enabled: false, open: '09:00', close: '13:00' };
  return {
    getDemoNumbers: () => Promise.resolve({ us: { id: 'num_us', number: '+17262019604' }, ca: null }),
    pickDemoCallerId: (
      numbers: { us: { id: string; number: string } | null; ca: { id: string; number: string } | null },
      country: string | null,
    ) => (country === 'CA' && numbers.ca ? numbers.ca : (numbers.us ?? numbers.ca ?? null)),
    getOrCreateDemoTenant: () => Promise.resolve({
      tenant: { id: 'tenant_demo', companyName: 'Bayview Family Clinic', industry: 'CLINIC', slug: '__demo' },
      settings: {
        tenantId: 'tenant_demo', displayName: 'Maya',
        systemPrompt: 'Answer helpfully.', firstMessage: 'Hello.', voicemailGreeting: 'Leave a message.',
        wrapUpMessage: null, backgroundSound: null, maxCallDurationSeconds: 600,
        silenceTimeoutSeconds: 30, forwardingNumbers: [],
        businessHours: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: off, sun: off },
        timezone: 'America/Vancouver', voiceProvider: 'vapi', voiceId: 'Emma',
      },
    }),
  };
});

vi.mock('../services/platform-config.service', () => ({
  recordAdminAction: (email: string, action: string, target: string | null, detail: unknown) => {
    state.auditCalls.push({ email, action, target, detail });
    return Promise.resolve();
  },
  getSettingValue: () => Promise.resolve(null),
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
function statusReply(status: number) {
  return { __status: status, error: { message: 'temporary model failure' } };
}
/** A scripted Gemini SSE stream: one frame per parts array. */
function streamReply(frames: Array<Array<Record<string, unknown>>>) {
  return { __stream: frames };
}
/** A scripted Gemini SSE stream that breaks after its frames are read. */
function streamErrorReply(frames: Array<Array<Record<string, unknown>>>) {
  return { __streamError: frames };
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
  const status =
    next && typeof next === 'object' && '__status' in next
      ? Number((next as { __status: unknown }).__status)
      : 200;
  if (status === 200 && next && typeof next === 'object' && ('__stream' in next || '__streamError' in next)) {
    const breakAfter = '__streamError' in next;
    const frames = [
      ...(((next as { __stream?: unknown[]; __streamError?: unknown[] }).__stream ??
        (next as { __streamError?: unknown[] }).__streamError) as Array<Array<Record<string, unknown>>>),
    ];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const parts = frames.shift();
        if (parts) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts } }] })}\n\n`),
          );
        } else if (breakAfter) {
          controller.error(new Error('socket reset mid-stream'));
        } else {
          controller.close();
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  return new Response(JSON.stringify(next), {
    status,
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

async function reportDirect(token: string, input: Record<string, unknown>) {
  const res = await realFetch(`${base}/api/support/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
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

  it('list_calls_in_range carries the rescue flag and reason so Adam can answer callback questions', async () => {
    state.geminiScript.push(
      callReply('list_calls_in_range', {}),
      textReply('One call still needs a callback.'),
    );
    const res = await chat(tokenA(), 'Which calls need a callback?');
    expect(res.status).toBe(200);
    const seen = JSON.stringify(state.geminiRequests);
    expect(seen).toContain('call_a2');
    expect(seen).toContain('"rescueNeeded":true');
    expect(seen).toContain('The call failed (no-answer).');
    // The booked call in the same list is reported clean.
    expect(seen).toContain('"rescueNeeded":false');
  });

  it('get_call_details carries the rescue flag and reason for the flagged call', async () => {
    state.geminiScript.push(
      callReply('get_call_details', { callLogId: 'call_a2' }),
      textReply('That call needs a callback.'),
    );
    const res = await chat(tokenA(), 'Tell me about that failed call.');
    expect(res.status).toBe(200);
    const seen = JSON.stringify(state.geminiRequests);
    expect(seen).toContain('"rescueNeeded":true');
    expect(seen).toContain('The call failed (no-answer).');
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

/* --------------------- tools round: state, calls, retry ------------------ */

describe('support agent tools round', () => {
  it('workspace state tool reflects this workspace resolved feature, calendar, and SMS state', async () => {
    state.geminiScript.push(callReply('get_workspace_state', {}), textReply('Here is the live state.'));
    const res = await chat(tokenA(), 'Are calendar sync, SMS, and missed-call text-back on here?');
    expect(res.status).toBe(200);
    const [workspace] = toolResultsShownToModel();
    const missed = (workspace?.features as Array<Record<string, any>>).find(
      (f) => f.key === 'MISSED_CALL_TEXTBACK',
    );
    expect(missed?.effective).toBe(true);
    expect(workspace?.sms).toMatchObject({
      platformConfigured: true,
      workspaceEnabled: true,
      effective: true,
      bookingConfirmations: true,
      reminder1h: false,
    });
    expect(workspace?.calendar).toMatchObject({
      anyConnected: true,
      inboundBusyBlockingConfigured: true,
      outboundWriteConfigured: false,
      twoWaySyncConfigured: false,
    });
    expect(workspace?.calendar.connections[0]).toMatchObject({
      provider: 'GOOGLE',
      accountEmail: 'frontdesk@alpha.test',
    });
    expect(workspace?.setup?.missedCallTextBack?.featureEffective).toBe(true);
    expect(workspace?.setup?.serviceArea?.active).toBe(false);
  });

  it('call list tool returns a date range with outcomes and success scores', async () => {
    state.geminiScript.push(
      callReply('list_calls_in_range', { startDate: '2026-10-13', endDate: '2026-10-14', limit: 25 }),
      textReply('Here are the calls in that range.'),
    );
    const res = await chat(tokenA(), 'Show my calls from October 13 to 14.');
    expect(res.status).toBe(200);
    const [range] = toolResultsShownToModel();
    expect(range?.count).toBe(2);
    expect(range?.successScoreMeaning).toContain('1-to-10 success evaluation');
    expect(range?.calls.map((c: Record<string, any>) => c.id)).toEqual(['call_a1', 'call_a2']);
    expect(range?.calls[0]).toMatchObject({ outcome: 'BOOKED', successScore: 4 });
    expect(range?.calls[1]).toMatchObject({ outcome: 'MESSAGE_TAKEN', successScore: 8 });
  });

  it('call detail tool returns the full summary and transcript for a call in this workspace', async () => {
    state.geminiScript.push(
      callReply('get_call_details', { callLogId: 'call_a1' }),
      textReply('Here is that call in detail.'),
    );
    const res = await chat(tokenA(), 'Read me the worst call in detail.');
    expect(res.status).toBe(200);
    const [detail] = toolResultsShownToModel();
    expect(detail).toMatchObject({
      id: 'call_a1',
      outcome: 'BOOKED',
      successScore: 4,
      summary: 'Booked a cleaning for next week.',
      transcript: 'Caller: I need a cleaning. Receptionist: I can help with that.',
      transcriptAvailable: true,
    });
  });

  it('call detail tool returns nothing for another tenant call id', async () => {
    state.geminiScript.push(
      callReply('get_call_details', { callLogId: 'call_b1' }),
      textReply('I cannot read that call.'),
    );
    const res = await chat(tokenA(), 'Read that call.');
    expect(res.status).toBe(200);
    const [detail] = toolResultsShownToModel();
    expect(detail?.status).toBe('error');
    expect(String(detail?.error)).toContain('not in this workspace');
    expect(JSON.stringify(state.geminiRequests)).not.toContain('This is the other workspace.');
    expect(JSON.stringify(state.geminiRequests)).not.toContain('Beta Caller');
  });

  it('retries a 503 once and returns the successful answer', async () => {
    state.geminiScript.push(statusReply(503), textReply('Recovered after the spike.'));
    const res = await chat(tokenA(), 'Are you there?');
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Recovered after the spike.');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('gives up honestly after the bounded 429 retries', async () => {
    state.geminiScript.push(statusReply(429), statusReply(429), statusReply(429));
    const res = await chat(tokenA(), 'Are you there?');
    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe('MODEL_ERROR');
    expect(res.body.error?.message).toContain('had trouble answering');
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it('files a direct report without the model and scopes it to the JWT tenant', async () => {
    const res = await reportDirect(tokenA(), {
      subject: 'Adam gave a wrong answer',
      details: 'Adam told me SMS was off, but our confirmation texts are sending.',
      tenantId: 'tenant_b',
    });
    expect(res.status).toBe(201);
    expect(res.body.filed).toBe(true);
    expect(res.body.reference).toBe(`VF-${state.tickets[0].id.slice(-6).toUpperCase()}`);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0]).toMatchObject({
      tenantId: 'tenant_a',
      createdByUserId: 'user_a',
      category: 'ISSUE',
      subject: 'Adam gave a wrong answer',
      callLogId: null,
      status: 'OPEN',
    });
  });
});

/* ---------------- Adam's inventions: proofs, drills, weekly upgrade ---- */

async function runSimulatedCall(token: string, proposalId: string) {
  const res = await realFetch(`${base}/api/support/run-simulated-call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ proposalId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function applyKnowledge(token: string, proposalId: string) {
  const res = await realFetch(`${base}/api/support/apply-knowledge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ proposalId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function dismissReview(token: string, reviewId: string) {
  const res = await realFetch(`${base}/api/support/weekly-review/dismiss`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ reviewId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('support agent inventions (proofs, drills, weekly upgrade)', () => {
  it('runs a proposed drill end to end: propose in chat, confirm by REST, result in chat', async () => {
    state.geminiScript.push(
      callReply('propose_drill', { scenarioId: 'price_shopper' }),
      textReply('Want me to run that drill?'),
    );
    const proposed = await chat(tokenA(), 'Run a price shopper drill');
    expect(proposed.status).toBe(200);
    expect(proposed.body.pendingProposal?.kind).toBe('drill');
    expect(proposed.body.pendingProposal?.summary).toContain('few minutes of real call time');
    const proposalId = proposed.body.pendingProposal.proposalId as string;

    const run = await runSimulatedCall(tokenA(), proposalId);
    expect(run.status).toBe(200);
    expect(run.body.ran).toBe(true);
    expect(state.simRuns).toHaveLength(1);
    expect(state.simRuns[0]).toMatchObject({ tenantId: 'tenant_a', kind: 'DRILL', status: 'PLACED' });
    expect(state.vapiCalls).toHaveLength(1);
    expect(state.vapiCalls[0]).toMatchObject({ customerNumber: '+14165550100', phoneNumberId: 'num_us' });
    expect(state.auditCalls.some((a) => a.action === 'support_agent.simulation_run')).toBe(true);

    // The webhook would capture the finished call; here the row is moved
    // to its completed state directly, then Adam reports it in chat.
    Object.assign(state.simRuns[0]!, {
      status: 'COMPLETED',
      resultSuccessScore: 8,
      resultOutcome: 'BOOKED',
      resultSummary: 'She quoted the cleaning price and offered two times.',
      resultTranscript: 'AI: A cleaning is $180. User: That sounds good.',
      resultRecordingUrl: 'https://storage.example/drill.wav',
      resultDurationSeconds: 95,
    });
    state.geminiScript.push(
      callReply('get_simulation_result', {}),
      textReply('She scored 8 of 10.'),
    );
    const reported = await chat(tokenA(), 'How did the drill go?');
    expect(reported.status).toBe(200);
    expect(reported.body.simulationResult?.status).toBe('COMPLETED');
    expect(reported.body.simulationResult?.after?.successScore).toBe(8);
    expect(reported.body.simulationResult?.after?.mediaToken).toBeTruthy();
  });

  it('gates the run by role and by tenant', async () => {
    state.geminiScript.push(
      callReply('propose_drill', { scenarioId: 'angry_billing' }),
      textReply('Ready when you are.'),
    );
    const proposed = await chat(tokenA(), 'Drill please');
    const proposalId = proposed.body.pendingProposal.proposalId as string;

    // Front-desk staff cannot spend call time.
    expect((await runSimulatedCall(tokenAAgent(), proposalId)).status).toBe(403);
    // Another workspace cannot run this workspace's held proposal.
    expect((await runSimulatedCall(tokenB(), proposalId)).status).toBe(409);
    expect(state.simRuns).toHaveLength(0);
    // The owner still can.
    expect((await runSimulatedCall(tokenA(), proposalId)).status).toBe(200);
    expect(state.simRuns).toHaveLength(1);
  });

  it('proposes a proof for a call of this workspace, and refuses another workspace\'s call', async () => {
    state.geminiScript.push(
      callReply('propose_proof', {
        callLogId: 'call_a1',
        diagnosis: 'She never offered the morning slots the caller asked for.',
        fixSummary: 'Booking window widened to 8 AM.',
      }),
      textReply('Shall I run the proof?'),
    );
    const proposed = await chat(tokenA(), 'That call scored 4. I widened the window. Prove it.');
    expect(proposed.body.pendingProposal?.kind).toBe('proof');
    expect(proposed.body.pendingProposal?.summary).toContain('Proof call');
    expect(proposed.body.pendingProposal?.summary).toContain('success score 4 of 10');

    state.geminiScript.push(
      callReply('propose_proof', {
        callLogId: 'call_b1',
        diagnosis: 'Bad call.',
        fixSummary: 'Fixed.',
      }),
      textReply('That call is not in this workspace.'),
    );
    const foreign = await chat(tokenA(), 'Prove the beta call');
    expect(foreign.body.pendingProposal).toBeNull();
    const shown = JSON.stringify(toolResultsShownToModel());
    expect(shown).toContain('does not belong to this workspace');
  });

  it('enforces the daily proof cap at propose time', async () => {
    for (let i = 0; i < 3; i += 1) {
      state.simRuns.push({
        id: `seed_proof_${i}`, tenantId: 'tenant_a', createdByUserId: 'user_a', kind: 'PROOF',
        status: 'COMPLETED', scenarioTitle: 'Earlier proof', scenarioPrompt: '',
        sourceCallLogId: 'call_a1', diagnosis: 'd', fixSummary: 'f', originNumber: '+17262019604',
        patientCallId: null, receptionistCallId: null, resultSummary: null, resultTranscript: null,
        resultRecordingUrl: null, resultSuccessScore: null, resultOutcome: null, resultDurationSeconds: 0,
        patientTranscript: null, patientRecordingUrl: null, cleanupCount: 0,
        createdAt: new Date(), completedAt: new Date(),
      });
    }
    state.geminiScript.push(
      callReply('propose_proof', { callLogId: 'call_a1', diagnosis: 'd', fixSummary: 'f' }),
      textReply('The proof cap is used up for today.'),
    );
    const res = await chat(tokenA(), 'One more proof');
    expect(res.body.pendingProposal).toBeNull();
    expect(JSON.stringify(toolResultsShownToModel())).toContain('3 proof calls for today');
  });

  it('serves the drill library over REST', async () => {
    const res = await realFetch(`${base}/api/support/drill-scenarios`, {
      headers: { authorization: `Bearer ${tokenA()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenarios: Array<{ id: string }> };
    expect(body.scenarios.map((s) => s.id)).toEqual(
      expect.arrayContaining(['angry_billing', 'price_shopper', 'nervous_first_timer', 'insurance_question', 'after_hours_emergency']),
    );
  });

  it('scans for unanswered questions, drafts from the clinic records, and applies through the knowledge path', async () => {
    state.calls.set('call_a9', {
      id: 'call_a9', tenantId: 'tenant_a', startedAt: new Date(Date.now() - 60 * 60 * 1000),
      endedAt: new Date(), endedReason: 'customer-ended-call', callerNumber: '+14165550111',
      channel: 'phone', status: 'COMPLETED', outcome: 'NO_ACTION', intent: 'QUESTION',
      urgency: 'LOW', leadQuality: 'WARM', appointmentBooked: false,
      summary: null,
      transcript: 'Caller: Do you take Delta Dental?\nReceptionist: I don\'t know, I can take a message.',
      durationSeconds: 45, successScore: 3, structuredData: {},
    });
    state.geminiScript.push(callReply('scan_unanswered_questions', {}), textReply('Here are the gaps.'));
    const scanned = await chat(tokenA(), 'What could she not answer this week?');
    expect(scanned.status).toBe(200);
    const scanShown = JSON.stringify(toolResultsShownToModel());
    expect(scanShown).toContain('Insurance coverage');
    expect(scanShown).toContain('Delta Dental');

    state.geminiScript.push(
      callReply('propose_knowledge_addition', {
        topic: 'Insurance coverage',
        title: 'Insurance we accept',
        content: 'We accept Delta Dental. A cleaning costs $180 for existing patients.',
      }),
      textReply('Add this to her knowledge?'),
    );
    const proposed = await chat(tokenA(), 'Draft it from our records');
    expect(proposed.body.pendingProposal?.kind).toBe('knowledge_addition');
    const proposalId = proposed.body.pendingProposal.proposalId as string;

    const applied = await applyKnowledge(tokenA(), proposalId);
    expect(applied.status).toBe(200);
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0]!.fileName).toBe('adam-knowledge-insurance-we-accept.md');
    expect(state.documentsList.some((d) => d.fileName === 'adam-knowledge-insurance-we-accept.md')).toBe(true);
    expect(state.auditCalls.some((a) => a.action === 'support_agent.knowledge_addition')).toBe(true);
  });

  it('refuses a knowledge draft that invents a price', async () => {
    state.geminiScript.push(
      callReply('propose_knowledge_addition', {
        topic: 'Prices and cost',
        title: 'Whitening price',
        content: 'Whitening costs $499 per session.',
      }),
      textReply('I cannot add that.'),
    );
    const res = await chat(tokenA(), 'Add the whitening price');
    expect(res.body.pendingProposal).toBeNull();
    const shown = JSON.stringify(toolResultsShownToModel());
    expect(shown).toContain('$499');
    expect(shown).toContain('does not appear anywhere');
    expect(state.uploads).toHaveLength(0);
  });

  it('surfaces a pending weekly review in chat and dismisses it tenant-scoped', async () => {
    state.weeklyReviews.push({
      id: 'review_1', tenantId: 'tenant_a', weekKey: '2026-W42',
      gaps: [], gapCount: 3, status: 'PENDING', createdAt: new Date(),
    });
    state.geminiScript.push(textReply('Hello. By the way, your weekly review is ready.'));
    const first = await chat(tokenA(), 'Hi Adam');
    expect(first.body.weeklyReview).toMatchObject({ reviewId: 'review_1', gapCount: 3 });
    expect(systemTextsShownToModel().join('')).toContain('Weekly knowledge review');

    // Another workspace cannot dismiss it; staff cannot either.
    expect((await dismissReview(tokenB(), 'review_1')).status).toBe(404);
    expect((await dismissReview(tokenAAgent(), 'review_1')).status).toBe(403);
    expect((await dismissReview(tokenA(), 'review_1')).status).toBe(200);
    expect(state.weeklyReviews[0]).toMatchObject({ status: 'DISMISSED' });

    state.geminiScript.push(textReply('Hello again.'));
    const second = await chat(tokenA(), 'Hi again');
    expect(second.body.weeklyReview).toBeNull();
  });
});

/* --------------- analysis digest + turn-cap headroom -------------------- */

describe('support agent analysis digest', () => {
  const novemberCall = (overrides: Record<string, unknown>) => ({
    tenantId: 'tenant_a',
    endedAt: new Date('2026-11-03T15:00:00Z'),
    endedReason: 'assistant-ended-call',
    callerNumber: '+14165550001',
    channel: 'phone',
    status: 'COMPLETED',
    leadQuality: 'COLD',
    appointmentBooked: false,
    durationSeconds: 60,
    structuredData: {},
    ...overrides,
  });

  it('computes the digest in one pass: distribution, average, worst calls, truncation', async () => {
    state.calls.set('call_n1', novemberCall({
      id: 'call_n1', startedAt: new Date('2026-11-03T14:00:00Z'),
      outcome: 'NO_ACTION', intent: 'QUESTION', urgency: 'HIGH',
      summary: 'Worst call summary.', transcript: 'x'.repeat(5000), successScore: 2,
    }) as never);
    state.calls.set('call_n2', novemberCall({
      id: 'call_n2', startedAt: new Date('2026-11-03T13:00:00Z'),
      outcome: 'MESSAGE_TAKEN', intent: 'BOOK', urgency: 'LOW',
      summary: 'Second worst summary.', transcript: 'short transcript', successScore: 3,
    }) as never);
    state.calls.set('call_n3', novemberCall({
      id: 'call_n3', startedAt: new Date('2026-11-03T12:00:00Z'),
      outcome: 'BOOKED', intent: 'BOOK', urgency: 'LOW', appointmentBooked: true,
      summary: 'Great call.', transcript: 'Booked happily.', successScore: 9,
    }) as never);
    state.calls.set('call_n4', novemberCall({
      id: 'call_n4', startedAt: new Date('2026-11-03T11:00:00Z'),
      outcome: 'BOOKED', intent: null, urgency: null, appointmentBooked: true,
      summary: null, transcript: null, successScore: null,
    }) as never);
    state.calls.set('call_n5', novemberCall({
      id: 'call_n5', startedAt: new Date('2026-11-03T10:00:00Z'),
      outcome: null, intent: 'QUESTION', urgency: 'HIGH',
      summary: null, transcript: null, successScore: null,
    }) as never);

    state.geminiScript.push(
      callReply('analyze_call_quality', { startDate: '2026-11-01', endDate: '2026-11-30' }),
      textReply('Here is the analysis.'),
    );
    const res = await chat(tokenA(), 'Analyze all my calls and tell me what needs addressing.');
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Here is the analysis.');

    const [digest] = toolResultsShownToModel();
    expect(digest?.totalCalls).toBe(5);
    expect(digest?.scoredCalls).toBe(3);
    expect(digest?.unscoredCalls).toBe(2);
    expect(digest?.averageSuccessScore).toBe(4.7);
    expect(digest?.bookedCalls).toBe(2);
    expect(digest?.outcomeCounts).toEqual([
      { value: 'BOOKED', count: 2 },
      { value: 'MESSAGE_TAKEN', count: 1 },
      { value: 'NO_ACTION', count: 1 },
      { value: 'UNRECORDED', count: 1 },
    ]);
    expect(digest?.intentCounts).toEqual([
      { value: 'BOOK', count: 2 },
      { value: 'QUESTION', count: 2 },
      { value: 'UNRECORDED', count: 1 },
    ]);
    expect(digest?.urgencyCounts).toEqual([
      { value: 'HIGH', count: 2 },
      { value: 'LOW', count: 2 },
      { value: 'UNRECORDED', count: 1 },
    ]);
    expect(digest?.worstCalls.map((c: Record<string, any>) => c.id)).toEqual([
      'call_n1', 'call_n2', 'call_n3',
    ]);
    expect(digest?.worstCalls[0]).toMatchObject({
      successScore: 2,
      summary: 'Worst call summary.',
      transcriptAvailable: true,
      transcriptTruncated: true,
    });
    expect(digest?.worstCalls[0].transcript).toHaveLength(4000);
    expect(digest?.worstCallTranscriptsCappedAtChars).toBe(4000);
    expect(digest?.analysisCapped).toBe(false);
  });

  it('only ever digests the caller workspace calls', async () => {
    state.geminiScript.push(
      callReply('analyze_call_quality', { startDate: '2026-10-01', endDate: '2026-10-31' }),
      textReply('Your digest.'),
    );
    const res = await chat(tokenB(), 'Analyze my calls.');
    expect(res.status).toBe(200);
    const [digest] = toolResultsShownToModel();
    expect(digest?.totalCalls).toBe(1);
    expect(digest?.scoredCalls).toBe(1);
    expect(digest?.averageSuccessScore).toBe(2);
    expect(digest?.worstCalls.map((c: Record<string, any>) => c.id)).toEqual(['call_b1']);
    expect(JSON.stringify(state.geminiRequests)).not.toContain('call_a1');
    expect(JSON.stringify(state.geminiRequests)).not.toContain('Booked a cleaning for next week.');
  });

  it('answers a whole-log analysis in two model rounds through the digest tool', async () => {
    state.geminiScript.push(callReply('analyze_call_quality', {}), textReply('Analysis complete.'));
    const res = await chat(
      tokenA(),
      'Analyze all my call logs and tell me issues that need to be addressed.',
    );
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Analysis complete.');
    // One tool round plus the summarizing round: the whole-log question
    // that used to die at the turn cap now finishes in two model calls.
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('allows longer tool conversations under the raised turn cap', async () => {
    for (let i = 0; i < 7; i += 1) state.geminiScript.push(callReply('get_booking_window', {}));
    state.geminiScript.push(textReply('Done after several checks.'));
    const res = await chat(tokenA(), 'Check my hours, then check them again a few times.');
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Done after several checks.');
  });
});

/* --------------------------- streamed chat ------------------------------ */

async function chatStream(token: string, text: string) {
  const res = await realFetch(`${base}/api/support/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ role: 'user', text }] }),
  });
  const raw = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', raw };
}

function sseEvents(raw: string): Array<{ event: string; data: Record<string, any> }> {
  return raw
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event:'))?.slice('event:'.length).trim() ?? '';
      const dataText = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice('data:'.length).trim())
        .join('\n');
      return { event, data: (dataText ? JSON.parse(dataText) : {}) as Record<string, any> };
    });
}

describe('support agent streaming', () => {
  it('streams the reply as deltas that reassemble into the final payload', async () => {
    state.geminiScript.push(streamReply([[{ text: 'Your calls ' }], [{ text: 'look strong.' }]]));
    const res = await chatStream(tokenA(), 'How are my calls doing?');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');
    const events = sseEvents(res.raw);
    expect(events.map((e) => e.event)).toEqual(['delta', 'delta', 'final', 'done']);
    expect(events[0].data).toEqual({ text: 'Your calls ' });
    expect(events[1].data).toEqual({ text: 'look strong.' });
    expect(events[2].data).toMatchObject({
      reply: 'Your calls look strong.',
      pendingProposal: null,
      simulationResult: null,
      weeklyReview: null,
    });
  });

  it('emits friendly status events while tools run, before the deltas', async () => {
    state.geminiScript.push(
      streamReply([
        [{ functionCall: { name: 'analyze_call_quality', args: { startDate: '2026-11-01', endDate: '2026-11-30' } } }],
      ]),
      streamReply([[{ text: 'Digest read. ' }], [{ text: 'Two issues stand out.' }]]),
    );
    const res = await chatStream(tokenA(), 'Analyze my calls.');
    expect(res.status).toBe(200);
    const events = sseEvents(res.raw);
    expect(events.map((e) => e.event)).toEqual(['status', 'delta', 'delta', 'final', 'done']);
    expect(events[0].data).toEqual({ label: 'Analyzing your calls' });
    const final = events.find((e) => e.event === 'final');
    expect(final?.data.reply).toBe('Digest read. Two issues stand out.');
    // The digest itself reached the model as a tool result on its next turn.
    expect(toolResultsShownToModel().some((r) => typeof r?.totalCalls === 'number')).toBe(true);
  });

  it('surfaces a mid-stream failure as an error event with the honest message', async () => {
    state.geminiScript.push(streamErrorReply([[{ text: 'Partial ans' }]]));
    const res = await chatStream(tokenA(), 'How are my calls doing?');
    expect(res.status).toBe(200);
    const events = sseEvents(res.raw);
    expect(events.map((e) => e.event)).toEqual(['delta', 'error']);
    expect(events[0].data).toEqual({ text: 'Partial ans' });
    expect(events[1].data.message).toContain('had trouble answering');
    expect(events[1].data.code).toBe('MODEL_ERROR');
  });

  it('falls back to the plain call when the provider refuses streaming', async () => {
    state.geminiScript.push(
      statusReply(400),
      callReply('get_booking_window', {}),
      statusReply(400),
      textReply('Answered without streaming.'),
    );
    const res = await chatStream(tokenA(), 'When can patients book?');
    expect(res.status).toBe(200);
    const events = sseEvents(res.raw);
    expect(events.some((e) => e.event === 'delta')).toBe(false);
    const final = events.find((e) => e.event === 'final');
    expect(final?.data.reply).toBe('Answered without streaming.');
    // Each of the two turns tried the stream first, then the plain call.
    expect(fetchStub).toHaveBeenCalledTimes(4);
  });

  it('retries a 503 before the stream opens, then streams', async () => {
    state.geminiScript.push(statusReply(503), streamReply([[{ text: 'Recovered.' }]]));
    const res = await chatStream(tokenA(), 'Are you there?');
    expect(res.status).toBe(200);
    const events = sseEvents(res.raw);
    expect(events.find((e) => e.event === 'final')?.data.reply).toBe('Recovered.');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('answers a failure before streaming starts with the normal JSON error', async () => {
    state.geminiScript.push(statusReply(500), statusReply(500));
    const res = await chatStream(tokenA(), 'Hello?');
    expect(res.status).toBe(502);
    expect(res.contentType).toContain('application/json');
    expect(res.raw).not.toContain('event:');
    const body = JSON.parse(res.raw) as Record<string, any>;
    expect(body.error?.code).toBe('MODEL_ERROR');
    expect(body.error?.message).toContain('had trouble answering');
  });

  it('rejects unauthenticated stream requests', async () => {
    const res = await realFetch(`${base}/api/support/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', text: 'hi' }] }),
    });
    expect(res.status).toBe(401);
  });
});
