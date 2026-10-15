import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

/**
 * Webhook-level tests for simulated-patient calls (Adam proofs and
 * drills), in the route-suite style of inbound-status-update.test.ts:
 * the real inbound router over HTTP, an in-memory Prisma fake, and the
 * real services (calllog, appointment, demo, adam-simulation) running
 * against it.
 *
 * Pinned behaviour:
 *  - an inbound call matching an open run is answered with a TRANSIENT
 *    receptionist carrying the run marker, even when the tenant has a
 *    persistent assistant (whose metadata would lose the run);
 *  - the receptionist's booking during the run lands in the demo sandbox
 *    under the per-run scope, never on the tenant's real calendar;
 *  - neither leg ever writes a tenant CallLog row: stats stay clean;
 *  - at end-of-call the run completes, the sandbox booking is deleted, so
 *    NO live appointment survives a simulated call anywhere;
 *  - a forged run marker refuses every tool.
 */


const state = vi.hoisted(() => {
const HOURS = {
  mon: { enabled: true, open: '08:00', close: '17:00' },
  tue: { enabled: true, open: '08:00', close: '17:00' },
  wed: { enabled: true, open: '08:00', close: '17:00' },
  thu: { enabled: true, open: '08:00', close: '17:00' },
  fri: { enabled: true, open: '08:00', close: '17:00' },
  sat: { enabled: false, open: '09:00', close: '13:00' },
  sun: { enabled: false, open: '09:00', close: '13:00' },
};
const SECRET = 'test-webhook-secret';
const TENANT_ID = 'tenant_1';
const DEMO_TENANT_ID = 'tenant_demo';
const INBOUND_NUMBER = '+14165550100';
const ORIGIN_NUMBER = '+17262019604';
const RUN_ID = 'run_sim_1';
interface FakeRow { [key: string]: unknown }

const callLogs = new Map<string, FakeRow>();
const appointments: FakeRow[] = [];
const jobs: FakeRow[] = [];
const simRuns = new Map<string, FakeRow>();
let apptSeq = 0;

function matches(row: FakeRow, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === 'OR' || key === 'AND') continue;
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('not' in c && value === c.not) return false;
      if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
      if ('gte' in c && !((value as Date) >= (c.gte as Date))) return false;
      if ('gt' in c && !((value as Date) > (c.gt as Date))) return false;
      if ('lt' in c && !((value as Date) < (c.lt as Date))) return false;
      if ('lte' in c && !((value as Date) <= (c.lte as Date))) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

const tenantRow = {
  id: TENANT_ID, companyName: 'Alpha Dental', industry: 'CLINIC',
  isBlocked: false, subscriptionStatus: 'ACTIVE', multiProviderEnabled: false,
  markupBps: 0, slug: 'alpha-dental',
  onboarding: { tenantId: TENANT_ID, isActive: true },
};
const demoTenantRow = {
  id: DEMO_TENANT_ID, companyName: 'Bayview Family Clinic', industry: 'CLINIC',
  isBlocked: false, subscriptionStatus: 'ACTIVE', multiProviderEnabled: false,
  markupBps: 0, slug: 'demo',
  onboarding: { tenantId: DEMO_TENANT_ID, isActive: true },
};

const settingsRow = {
  tenantId: TENANT_ID, displayName: 'Maya', timezone: 'America/Toronto',
  businessHours: HOURS, inboundPhoneNumber: INBOUND_NUMBER,
  monthlyMinuteLimit: 950, assistantId: 'asst_persistent_1',
  rejectAnonymousCallers: false, systemPrompt: 'Answer helpfully.',
  firstMessage: 'Thanks for calling Alpha Dental.', voicemailGreeting: 'Leave a message.',
  wrapUpMessage: null, backgroundSound: null, maxCallDurationSeconds: 600,
  silenceTimeoutSeconds: 30, forwardingNumbers: [], serviceAreaZips: [],
  serviceAreaNote: null, tenant: tenantRow,
};
const demoSettingsRow = {
  ...settingsRow, tenantId: DEMO_TENANT_ID, displayName: 'Maya',
  timezone: 'America/Vancouver', inboundPhoneNumber: null, assistantId: null,
  tenant: demoTenantRow,
};

const fakePrisma = {
  tenant: {
    findUnique: async (args: { where: { id?: string; slug?: string } }) => {
      if (args.where.slug === '__demo') return { ...demoTenantRow, agentSettings: demoSettingsRow };
      if (args.where.id === TENANT_ID) return tenantRow;
      if (args.where.id === DEMO_TENANT_ID) return demoTenantRow;
      return null;
    },
  },
  agentSettings: {
    findUnique: async (args: { where: { tenantId?: string; inboundPhoneNumber?: string } }) => {
      if (args.where.inboundPhoneNumber === INBOUND_NUMBER) return settingsRow;
      if (args.where.tenantId === TENANT_ID) return settingsRow;
      if (args.where.tenantId === DEMO_TENANT_ID) return demoSettingsRow;
      return null;
    },
  },
  onboardingStatus: {
    upsert: async () => ({}),
    create: async () => ({}),
  },
  blockedCaller: { findUnique: async () => null },
  screenedCallLog: { create: async () => ({}) },
  tenantFeature: { findMany: async () => [], findUnique: async () => null },
  document: { findMany: async () => [] },
  provider: { findMany: async () => [] },
  service: { findMany: async () => [] },
  demoLead: { findFirst: async () => null },
  callLog: {
    upsert: async (args: { where: { externalCallId: string }; create: FakeRow; update: FakeRow }) => {
      const existing = callLogs.get(args.where.externalCallId);
      if (existing) { Object.assign(existing, args.update); return existing; }
      const row = { id: `call_${callLogs.size + 1}`, ...args.create, externalCallId: args.where.externalCallId };
      callLogs.set(row.externalCallId as string, row);
      return row;
    },
    findMany: async (args: { where?: Record<string, unknown> }) =>
      [...callLogs.values()].filter((r) => matches(r, args.where ?? {})),
    count: async (args: { where?: Record<string, unknown> }) =>
      [...callLogs.values()].filter((r) => matches(r, args.where ?? {})).length,
    aggregate: async () => ({ _sum: { durationSeconds: 0 } }),
    findUnique: async () => null,
    findFirst: async () => null,
    update: async () => ({}),
  },
  appointment: {
    findMany: async (args: { where?: Record<string, unknown> }) =>
      appointments.filter((r) => matches(r, args.where ?? {})),
    findFirst: async (args: { where?: Record<string, unknown> }) =>
      appointments.find((r) => matches(r, args.where ?? {})) ?? null,
    create: async (args: { data: FakeRow }) => {
      const row = { id: `appt_${++apptSeq}`, status: 'CONFIRMED', ...args.data };
      appointments.push(row);
      return row;
    },
    update: async (args: { where: { id: string }; data: FakeRow }) => {
      const row = appointments.find((r) => r.id === args.where.id);
      if (row) Object.assign(row, args.data);
      return row ?? {};
    },
    deleteMany: async (args: { where: Record<string, unknown> }) => {
      let count = 0;
      for (let i = appointments.length - 1; i >= 0; i -= 1) {
        if (matches(appointments[i]!, args.where)) { appointments.splice(i, 1); count += 1; }
      }
      return { count };
    },
    updateMany: async (args: { where: Record<string, unknown>; data: FakeRow }) => {
      let count = 0;
      for (const row of appointments) {
        if (matches(row, args.where)) { Object.assign(row, args.data); count += 1; }
      }
      return { count };
    },
  },
  jobRequest: {
    create: async (args: { data: FakeRow }) => {
      const row = { id: `job_${jobs.length + 1}`, ...args.data };
      jobs.push(row);
      return row;
    },
    deleteMany: async (args: { where: Record<string, unknown> }) => {
      let count = 0;
      for (let i = jobs.length - 1; i >= 0; i -= 1) {
        if (matches(jobs[i]!, args.where)) { jobs.splice(i, 1); count += 1; }
      }
      return { count };
    },
    findFirst: async () => null,
    update: async () => ({}),
  },
  simulatedCallRun: {
    findFirst: async (args: { where: Record<string, unknown>; orderBy?: { createdAt?: string } }) => {
      const rows = [...simRuns.values()].filter((r) => matches(r, args.where));
      rows.sort((a, b) => (args.orderBy?.createdAt === 'desc'
        ? (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()
        : (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()));
      return rows[0] ?? null;
    },
    findUnique: async (args: { where: { id: string } }) => simRuns.get(args.where.id) ?? null,
    update: async (args: { where: { id: string }; data: FakeRow }) => {
      const row = simRuns.get(args.where.id);
      if (row) Object.assign(row, args.data);
      return row ?? {};
    },
    updateMany: async (args: { where: Record<string, unknown>; data: FakeRow }) => {
      let count = 0;
      for (const row of simRuns.values()) {
        if (matches(row, args.where)) { Object.assign(row, args.data); count += 1; }
      }
      return { count };
    },
  },
  $executeRaw: async () => 0,
  $transaction: async (fn: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>) =>
    typeof fn === 'function' ? fn(fakePrisma) : Promise.all(fn),
};

  return { callLogs, appointments, jobs, simRuns, fakePrisma, SECRET, TENANT_ID, DEMO_TENANT_ID, INBOUND_NUMBER, ORIGIN_NUMBER, RUN_ID };
});

const { callLogs, appointments, jobs, simRuns, fakePrisma, SECRET, TENANT_ID, DEMO_TENANT_ID, INBOUND_NUMBER, ORIGIN_NUMBER, RUN_ID } = state;

vi.mock('../lib/prisma', () => ({ prisma: state.fakePrisma }));

vi.mock('../services/platform-config.service', () => ({
  getSettingValue: vi.fn(async (key: string) =>
    key === 'VAPI_WEBHOOK_SECRET' ? state.SECRET : key === 'PUBLIC_API_URL' ? 'https://api.example.test' : null),
  recordAdminAction: vi.fn(async () => undefined),
}));

import { inboundRouter } from './inbound.routes';
import { errorHandler } from '../middleware/error';
import { getCallStats } from '../services/calllog.service';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/vapi/inbound', inboundRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no test server address');
  base = `http://127.0.0.1:${addr.port}/api/vapi/inbound`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function seedRun() {
  simRuns.set(RUN_ID, {
    id: RUN_ID, tenantId: TENANT_ID, createdByUserId: 'user_a', kind: 'DRILL',
    status: 'PLACED', scenarioTitle: 'Price shopper', scenarioPrompt: 'prompt',
    sourceCallLogId: null, diagnosis: null, fixSummary: null,
    originNumber: ORIGIN_NUMBER, patientCallId: 'vapi_patient_1', receptionistCallId: null,
    resultSummary: null, resultTranscript: null, resultRecordingUrl: null,
    resultSuccessScore: null, resultOutcome: null, resultDurationSeconds: 0,
    patientTranscript: null, patientRecordingUrl: null, cleanupCount: 0,
    createdAt: new Date(), completedAt: null,
  });
}

beforeEach(() => {
  callLogs.clear();
  appointments.length = 0;
  jobs.length = 0;
  simRuns.clear();
  seedRun();
});

async function postWebhook(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const simMetadata = { tenantId: TENANT_ID, channel: 'phone', simulationRunId: RUN_ID, simulationLeg: 'receptionist' };

function assistantRequest() {
  return {
    message: {
      type: 'assistant-request',
      phoneNumber: { number: INBOUND_NUMBER },
      customer: { number: ORIGIN_NUMBER },
      call: { id: 'call_recept_1', customer: { number: ORIGIN_NUMBER } },
    },
  };
}

/** A future weekday (Toronto) at 10:00, formatted for the booking tool. */
function futureWeekday(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  for (let offset = 1; offset < 10; offset += 1) {
    const d = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
    const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    if (parts.weekday && !['Sat', 'Sun'].includes(parts.weekday)) {
      return `${parts.year}-${parts.month}-${parts.day}`;
    }
  }
  throw new Error('no weekday found');
}

function toolCalls(metadata: Record<string, unknown>) {
  return {
    message: {
      type: 'tool-calls',
      call: { id: 'call_recept_1', customer: { number: ORIGIN_NUMBER }, assistant: { metadata } },
      assistant: { metadata },
      phoneNumber: { number: INBOUND_NUMBER },
      toolCallList: [
        {
          id: 'tc_1',
          name: 'bookAppointment',
          arguments: {
            customerName: 'Jordan Ellis', customerPhone: '+12025550147',
            reason: 'Cleaning', date: futureWeekday(), time: '10:00',
          },
        },
      ],
    },
  };
}

function endOfCall(leg: 'patient' | 'receptionist', callId: string) {
  const startedAt = new Date(Date.now() - 120_000);
  const endedAt = new Date(Date.now() - 5_000);
  return {
    message: {
      type: 'end-of-call-report',
      call: {
        id: callId,
        customer: { number: leg === 'receptionist' ? ORIGIN_NUMBER : INBOUND_NUMBER },
        assistant: { metadata: { ...simMetadata, simulationLeg: leg } },
      },
      phoneNumber: { number: INBOUND_NUMBER },
      cost: 0.3,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      endedReason: 'assistant-ended-call',
      analysis: {
        summary: leg === 'receptionist' ? 'Receptionist handled the drill.' : 'Patient leg.',
        structuredData: { appointmentBooked: 'true' },
        successEvaluation: '8',
      },
      artifact: { recordingUrl: 'https://storage.example/sim.wav', transcript: 'AI: Hello.\nUser: Hi.' },
    },
  };
}

describe('simulated calls on the inbound webhook', () => {
  it('answers a matching inbound call with a transient receptionist carrying the marker, not the persistent assistant', async () => {
    const { status, json } = await postWebhook(assistantRequest());
    expect(status).toBe(200);
    expect(json.assistantId).toBeUndefined();
    const assistant = json.assistant as { metadata: Record<string, unknown> };
    expect(assistant).toBeDefined();
    expect(assistant.metadata.simulationRunId).toBe(RUN_ID);
    expect(assistant.metadata.simulationLeg).toBe('receptionist');
    expect(assistant.metadata.tenantId).toBe(TENANT_ID);
    expect(simRuns.get(RUN_ID)!.status).toBe('ANSWERED');
    expect(simRuns.get(RUN_ID)!.receptionistCallId).toBe('call_recept_1');
  });

  it('an ordinary caller (no open run for their number) still gets the persistent assistant', async () => {
    const body = assistantRequest();
    (body.message.customer as { number: string }).number = '+14165550999';
    (body.message.call.customer as { number: string }).number = '+14165550999';
    const { status, json } = await postWebhook(body);
    expect(status).toBe(200);
    expect(json.assistantId).toBe('asst_persistent_1');
    expect(simRuns.get(RUN_ID)!.status).toBe('PLACED');
  });

  it('books into the demo sandbox during the call, and no live appointment survives end-of-call', async () => {
    // The receptionist books during the drill: the write lands sandboxed.
    await postWebhook(assistantRequest());
    const toolResult = await postWebhook(toolCalls(simMetadata));
    expect(toolResult.status).toBe(200);
    const results = (toolResult.json as { results: Array<{ result: string }> }).results;
    expect(results[0]!.result).toContain('Booked');
    expect(appointments).toHaveLength(1);
    expect(appointments[0]!.tenantId).toBe(DEMO_TENANT_ID);
    expect(appointments[0]!.demoSessionId).toBe(`sim_${RUN_ID}`);
    expect(appointments.filter((a) => a.tenantId === TENANT_ID)).toHaveLength(0);

    // The status-update for the run opens NO tenant call row.
    const statusUpdate = {
      message: {
        type: 'status-update', status: 'in-progress',
        call: { id: 'call_recept_1', customer: { number: ORIGIN_NUMBER }, assistant: { metadata: simMetadata } },
        phoneNumber: { number: INBOUND_NUMBER },
        startedAt: new Date().toISOString(),
      },
    };
    expect((await postWebhook(statusUpdate)).status).toBe(200);
    expect(callLogs.size).toBe(0);

    // End-of-call (receptionist leg): the run completes with the score, the
    // sandbox booking is deleted, and still no CallLog exists anywhere.
    expect((await postWebhook(endOfCall('receptionist', 'call_recept_1'))).status).toBe(200);
    const run = simRuns.get(RUN_ID)!;
    expect(run.status).toBe('COMPLETED');
    expect(run.resultSuccessScore).toBe(8);
    expect(appointments).toHaveLength(0);
    expect(callLogs.size).toBe(0);

    // The patient leg's report adds fallback evidence without reviving anything.
    expect((await postWebhook(endOfCall('patient', 'vapi_patient_1'))).status).toBe(200);
    expect(simRuns.get(RUN_ID)!.status).toBe('COMPLETED');
    expect(simRuns.get(RUN_ID)!.patientTranscript).toContain('Hello');
    expect(callLogs.size).toBe(0);

    // Stats for the real tenant see none of it.
    const stats = await getCallStats(TENANT_ID);
    expect(stats.callsLast30Days).toBe(0);
    expect(stats.minutesLast30Days).toBe(0);
  });

  it('refuses every tool when the run marker does not resolve to a run of this tenant', async () => {
    const forged = { ...simMetadata, simulationRunId: 'run_forged' };
    const toolResult = await postWebhook(toolCalls(forged));
    expect(toolResult.status).toBe(200);
    const results = (toolResult.json as { results: Array<{ result: string }> }).results;
    expect(results[0]!.result).toMatch(/can't reach the calendar/i);
    expect(appointments).toHaveLength(0);
  });

  it('refuses tools when the marker names a run belonging to another tenant', async () => {
    simRuns.set('run_other', {
      ...(simRuns.get(RUN_ID) as FakeRow), id: 'run_other', tenantId: 'tenant_someone_else',
    });
    const foreign = { ...simMetadata, simulationRunId: 'run_other' };
    const toolResult = await postWebhook(toolCalls(foreign));
    const results = (toolResult.json as { results: Array<{ result: string }> }).results;
    expect(results[0]!.result).toMatch(/can't reach the calendar/i);
    expect(appointments).toHaveLength(0);
  });
});
