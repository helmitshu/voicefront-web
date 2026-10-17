import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

/**
 * Route-level tests for the `status-update` branch of POST /api/vapi/inbound
 * (live call state), in the repo's route-suite style: spies first, vi.mock
 * factories, the real inbound router on a throwaway express app over real
 * HTTP. Prisma is an in-memory fake; the REAL calllog.service runs against
 * it, so the tests cover webhook → ingest → stats end to end.
 *
 * Pinned behaviour:
 *  - `status-update` with status `in-progress` opens a CallLog row with
 *    status IN_PROGRESS and endedAt null, attributed by assistant metadata,
 *    or by the dialed number when metadata carries no tenant;
 *  - a repeat status-update for the same call neither duplicates nor resets
 *    the row, and one arriving after the end-of-call report never clobbers
 *    the finalized call;
 *  - demo-session payloads never create tenant rows (even with a real
 *    tenant id riding in the metadata), unknown numbers and unknown
 *    tenants create nothing;
 *  - an end-of-call report after the in-progress update finalizes the SAME
 *    row (one row total, final status, duration, summary);
 *  - getCallStats excludes the in-progress row while listCalls returns it;
 *  - malformed or non-in-progress status-updates still get a 200, and a
 *    missing webhook secret still gets a 401.
 */

const SECRET = 'test-webhook-secret';
const TENANT_ID = 'tenant_1';
const INBOUND_NUMBER = '+17785550100';
const CALLER_NUMBER = '+16045550182';

interface FakeCallLog {
  id: string;
  externalCallId: string;
  tenantId: string;
  channel: string;
  callerNumber: string | null;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number;
  providerCostCents: number;
  billedCostCents: number;
  markupBpsApplied: number;
  status: string;
  endedReason: string | null;
  summary: string | null;
  transcript: string | null;
  recordingUrl: string | null;
  textBackSentAt: Date | null;
  [key: string]: unknown;
}

const callLogs = new Map<string, FakeCallLog>();
let idSeq = 0;

const tenants = new Map([[TENANT_ID, { id: TENANT_ID, markupBps: 0 }]]);
const settingsByNumber = new Map([
  [INBOUND_NUMBER, { tenantId: TENANT_ID, inboundPhoneNumber: INBOUND_NUMBER }],
]);

const tenantFindUnique = vi.fn(
  async (args: { where: { id: string } }) => tenants.get(args.where.id) ?? null,
);
const agentSettingsFindUnique = vi.fn(async (args: { where: Record<string, string> }) => {
  if (args.where.inboundPhoneNumber) return settingsByNumber.get(args.where.inboundPhoneNumber) ?? null;
  if (args.where.tenantId) {
    for (const s of settingsByNumber.values()) if (s.tenantId === args.where.tenantId) return s;
  }
  return null;
});

function rowMatches(row: FakeCallLog, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === 'OR') continue; // search filters are not exercised here
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('gte' in c && !((value as Date) >= (c.gte as Date))) return false;
      if ('not' in c && value === c.not) return false;
      if ('contains' in c && !(typeof value === 'string' && value.includes(c.contains as string))) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

const callLogUpsert = vi.fn(
  async (args: {
    where: { externalCallId: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }) => {
    const existing = callLogs.get(args.where.externalCallId);
    if (existing) {
      Object.assign(existing, args.update);
      return existing;
    }
    const row: FakeCallLog = {
      id: `call_${++idSeq}`,
      channel: 'phone',
      callerNumber: null,
      endedAt: null,
      durationSeconds: 0,
      providerCostCents: 0,
      billedCostCents: 0,
      markupBpsApplied: 0,
      status: 'UNKNOWN',
      endedReason: null,
      summary: null,
      transcript: null,
      recordingUrl: null,
      textBackSentAt: null,
      ...(args.create as Partial<FakeCallLog>),
      externalCallId: args.where.externalCallId,
    } as FakeCallLog;
    callLogs.set(row.externalCallId, row);
    return row;
  },
);
const callLogFindMany = vi.fn(
  async (args: {
    where?: Record<string, unknown>;
    orderBy?: { startedAt?: string };
    skip?: number;
    take?: number;
  }) => {
    let rows = [...callLogs.values()].filter((r) => rowMatches(r, args.where ?? {}));
    if (args.orderBy?.startedAt === 'desc') {
      rows = rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    }
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take) rows = rows.slice(0, args.take);
    return rows;
  },
);
const callLogCount = vi.fn(
  async (args: { where?: Record<string, unknown> }) =>
    [...callLogs.values()].filter((r) => rowMatches(r, args.where ?? {})).length,
);

vi.mock('../lib/prisma', () => ({
  prisma: {
    tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...(a as [never])) },
    agentSettings: { findUnique: (...a: unknown[]) => agentSettingsFindUnique(...(a as [never])) },
    callLog: {
      upsert: (...a: unknown[]) => callLogUpsert(...(a as [never])),
      findMany: (...a: unknown[]) => callLogFindMany(...(a as [never])),
      count: (...a: unknown[]) => callLogCount(...(a as [never])),
      // Null keeps the fire-and-forget missed-call text-back a no-op.
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
    demoLead: { findFirst: vi.fn(async () => null) },
    appointment: { findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    $transaction: (ops: Array<Promise<unknown>>) => Promise.all(ops),
  },
}));

vi.mock('../services/platform-config.service', () => ({
  getSettingValue: vi.fn(async (key: string) => (key === 'VAPI_WEBHOOK_SECRET' ? SECRET : null)),
}));

import { inboundRouter } from './inbound.routes';
import { errorHandler } from '../middleware/error';
import { getCallStats, listCalls } from '../services/calllog.service';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/vapi/inbound', inboundRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no test server address');
  base = `http://127.0.0.1:${addr.port}/api/vapi/inbound`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  callLogs.clear();
  idSeq = 0;
});

async function postWebhook(body: unknown, secret: string | null = SECRET): Promise<number> {
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-vapi-secret': secret } : {}),
    },
    body: JSON.stringify(body),
  });
  return res.status;
}

/** A realistic Vapi status-update, shaped from the fields the end-of-call parser reads. */
function statusUpdate(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      type: 'status-update',
      status: 'in-progress',
      timestamp: Date.now(),
      call: {
        id: 'call_live_1',
        customer: { number: CALLER_NUMBER },
        assistant: { metadata: { tenantId: TENANT_ID, channel: 'phone' } },
      },
      phoneNumber: { number: INBOUND_NUMBER },
      customer: { number: CALLER_NUMBER },
      startedAt: new Date(Date.now() - 30_000).toISOString(),
      ...overrides,
    },
  };
}

function endOfCallReport(overrides: Record<string, unknown> = {}) {
  const startedAt = new Date(Date.now() - 150_000);
  const endedAt = new Date(Date.now() - 30_000);
  return {
    message: {
      type: 'end-of-call-report',
      call: {
        id: 'call_live_1',
        customer: { number: CALLER_NUMBER },
        assistant: { metadata: { tenantId: TENANT_ID, channel: 'phone' } },
      },
      phoneNumber: { number: INBOUND_NUMBER },
      customer: { number: CALLER_NUMBER },
      cost: 0.42,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      endedReason: 'customer-ended-call',
      analysis: { summary: 'Caller booked a cleaning.' },
      artifact: { recordingUrl: 'https://storage.example/rec.wav', transcript: 'Hello...' },
      ...overrides,
    },
  };
}

describe('status-update in-progress', () => {
  it('opens an IN_PROGRESS row with endedAt null, attributed by assistant metadata', async () => {
    const status = await postWebhook(statusUpdate());
    expect(status).toBe(200);

    expect(callLogs.size).toBe(1);
    const row = callLogs.get('call_live_1');
    expect(row).toBeDefined();
    expect(row!.tenantId).toBe(TENANT_ID);
    expect(row!.status).toBe('IN_PROGRESS');
    expect(row!.endedAt).toBeNull();
    expect(row!.durationSeconds).toBe(0);
    expect(row!.callerNumber).toBe(CALLER_NUMBER);
    expect(row!.channel).toBe('phone');
    // startedAt comes from the payload (30s ago), not from receipt time.
    expect(Date.now() - row!.startedAt.getTime()).toBeGreaterThanOrEqual(30_000);
  });

  it('attributes by the dialed number when metadata carries no tenant', async () => {
    const body = statusUpdate();
    // Formatted number exercises normalizePhone on the lookup path.
    (body.message as Record<string, unknown>).phoneNumber = { number: '+1 778 555 0100' };
    delete (body.message.call.assistant as Record<string, unknown>).metadata;

    expect(await postWebhook(body)).toBe(200);
    const row = callLogs.get('call_live_1');
    expect(row).toBeDefined();
    expect(row!.tenantId).toBe(TENANT_ID);
    expect(row!.status).toBe('IN_PROGRESS');
  });

  it('creates nothing for an unknown dialed number', async () => {
    const body = statusUpdate();
    (body.message as Record<string, unknown>).phoneNumber = { number: '+19995550199' };
    delete (body.message.call.assistant as Record<string, unknown>).metadata;

    expect(await postWebhook(body)).toBe(200);
    expect(callLogs.size).toBe(0);
  });

  it('creates nothing for an unknown tenant id in metadata', async () => {
    const body = statusUpdate();
    (body.message.call.assistant.metadata as Record<string, unknown>).tenantId = 'tenant_ghost';

    expect(await postWebhook(body)).toBe(200);
    expect(callLogs.size).toBe(0);
  });

  it('a repeat status-update neither duplicates nor resets the row', async () => {
    expect(await postWebhook(statusUpdate())).toBe(200);
    const firstStartedAt = callLogs.get('call_live_1')!.startedAt;

    // Second delivery claims a different (later) start; the row must not move.
    const again = statusUpdate({ startedAt: new Date().toISOString() });
    expect(await postWebhook(again)).toBe(200);

    expect(callLogs.size).toBe(1);
    expect(callLogs.get('call_live_1')!.startedAt).toEqual(firstStartedAt);
    expect(callLogs.get('call_live_1')!.status).toBe('IN_PROGRESS');
  });

  it('demo-session payloads never create tenant rows, even with a real tenant id attached', async () => {
    const body = statusUpdate();
    (body.message.call.assistant.metadata as Record<string, unknown>).demoSessionId = 'demo_abc123';

    // Demo traffic rides the secret bypass (peekDemoSessionId), so no header.
    expect(await postWebhook(body, null)).toBe(200);
    expect(callLogs.size).toBe(0);
  });

  it('non-in-progress statuses and malformed payloads are acknowledged without rows', async () => {
    expect(await postWebhook(statusUpdate({ status: 'ended' }))).toBe(200);
    expect(await postWebhook(statusUpdate({ status: 'queued' }))).toBe(200);
    // No call id at all.
    expect(await postWebhook(statusUpdate({ call: { customer: { number: CALLER_NUMBER } } }))).toBe(200);
    // Call is not even an object: the strict schema rejects it, still a 200.
    expect(await postWebhook(statusUpdate({ call: 'garbage' }))).toBe(200);
    expect(callLogs.size).toBe(0);
  });

  it('rejects a non-demo status-update without the webhook secret', async () => {
    expect(await postWebhook(statusUpdate(), null)).toBe(401);
    expect(await postWebhook(statusUpdate(), 'wrong-secret')).toBe(401);
    expect(callLogs.size).toBe(0);
  });
});

describe('finalization and stats', () => {
  it('the end-of-call report finalizes the SAME row, and a late status-update cannot clobber it', async () => {
    expect(await postWebhook(statusUpdate())).toBe(200);
    expect(await postWebhook(endOfCallReport())).toBe(200);

    expect(callLogs.size).toBe(1);
    const row = callLogs.get('call_live_1')!;
    expect(row.status).toBe('COMPLETED');
    expect(row.endedAt).not.toBeNull();
    expect(row.durationSeconds).toBe(120);
    expect(row.summary).toBe('Caller booked a cleaning.');
    expect(row.recordingUrl).toBe('https://storage.example/rec.wav');
    expect(row.billedCostCents).toBe(42);

    // Out-of-order late delivery: the live marker must not resurrect the call.
    expect(await postWebhook(statusUpdate())).toBe(200);
    const after = callLogs.get('call_live_1')!;
    expect(callLogs.size).toBe(1);
    expect(after.status).toBe('COMPLETED');
    expect(after.endedAt).toEqual(row.endedAt);
    expect(after.durationSeconds).toBe(120);
  });

  it('listCalls returns the live row with endedAt null while stats exclude it', async () => {
    // One live call, one finished call for the same tenant.
    expect(await postWebhook(statusUpdate())).toBe(200);
    const finished = statusUpdate();
    (finished.message.call as Record<string, unknown>).id = 'call_done_1';
    expect(await postWebhook(finished)).toBe(200);
    const report = endOfCallReport();
    (report.message.call as Record<string, unknown>).id = 'call_done_1';
    expect(await postWebhook(report)).toBe(200);

    const list = await listCalls({ tenantId: TENANT_ID, page: 1, perPage: 10 });
    expect(list.total).toBe(2);
    const live = list.calls.find((c) => c.id === callLogs.get('call_live_1')!.id);
    expect(live).toBeDefined();
    expect(live!.status).toBe('IN_PROGRESS');
    expect(live!.endedAt).toBeNull();

    const stats = await getCallStats(TENANT_ID);
    expect(stats.callsLast30Days).toBe(1);
    expect(stats.callsLast7Days).toBe(1);
    expect(stats.minutesLast30Days).toBe(2);
    expect(stats.costCentsLast30Days).toBe(42);
  });
});
