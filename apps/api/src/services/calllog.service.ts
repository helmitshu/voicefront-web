import type { CallLog, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { deriveCallStatus } from '../domain/call-status';
import { applyMarkup, dollarsToCents } from '../domain/billing';

/**
 * Tenant-facing call shape. Provider cost, provider call id, and the raw
 * recording URL never leave the server — audio streams through the masked
 * media proxy instead.
 */
export interface CallDto {
  id: string;
  channel: string;
  callerNumber: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  costCents: number;
  status: CallLog['status'];
  summary: string | null;
  hasRecording: boolean;
}

export interface CallDetailDto extends CallDto {
  transcript: string | null;
}

export function toCallDto(log: CallLog): CallDto {
  return {
    id: log.id,
    channel: log.channel,
    callerNumber: log.callerNumber,
    startedAt: log.startedAt.toISOString(),
    endedAt: log.endedAt ? log.endedAt.toISOString() : null,
    durationSeconds: log.durationSeconds,
    costCents: log.billedCostCents,
    status: log.status,
    summary: log.summary,
    hasRecording: Boolean(log.recordingUrl),
  };
}

export interface IngestReportInput {
  tenantId: string;
  externalCallId: string;
  channel: 'phone' | 'web';
  callerNumber: string | null;
  startedAt: Date;
  endedAt: Date | null;
  providerCostDollars: number;
  endedReason: string | null;
  summary: string | null;
  transcript: string | null;
  recordingUrl: string | null;
}

/**
 * Persists an end-of-call report. Upsert on the unique external call id makes
 * provider retries and duplicate deliveries idempotent.
 */
export async function ingestEndOfCallReport(input: IngestReportInput): Promise<CallLog> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true, markupBps: true },
  });
  if (!tenant) {
    throw new HttpError(404, 'Unknown tenant for call report', 'TENANT_NOT_FOUND');
  }

  const providerCostCents = dollarsToCents(input.providerCostDollars);
  const billedCostCents = applyMarkup(providerCostCents, tenant.markupBps);
  const durationSeconds =
    input.endedAt && input.endedAt > input.startedAt
      ? Math.round((input.endedAt.getTime() - input.startedAt.getTime()) / 1000)
      : 0;

  const data = {
    tenantId: tenant.id,
    channel: input.channel,
    callerNumber: input.callerNumber,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationSeconds,
    providerCostCents,
    billedCostCents,
    markupBpsApplied: tenant.markupBps,
    status: deriveCallStatus(input.endedReason),
    endedReason: input.endedReason,
    summary: input.summary,
    transcript: input.transcript,
    recordingUrl: input.recordingUrl,
  } satisfies Omit<Prisma.CallLogUncheckedCreateInput, 'externalCallId'>;

  return prisma.callLog.upsert({
    where: { externalCallId: input.externalCallId },
    create: { externalCallId: input.externalCallId, ...data },
    update: data,
  });
}

export interface ListCallsParams {
  tenantId: string;
  page: number;
  perPage: number;
  search?: string;
  sinceDays?: number;
}

export interface ListCallsResult {
  calls: CallDto[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export async function listCalls(params: ListCallsParams): Promise<ListCallsResult> {
  const where: Prisma.CallLogWhereInput = { tenantId: params.tenantId };
  if (params.sinceDays && params.sinceDays > 0) {
    where.startedAt = { gte: new Date(Date.now() - params.sinceDays * 24 * 60 * 60 * 1000) };
  }
  if (params.search && params.search.trim().length > 0) {
    const q = params.search.trim();
    where.OR = [
      { callerNumber: { contains: q } },
      { summary: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [total, rows] = await prisma.$transaction([
    prisma.callLog.count({ where }),
    prisma.callLog.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip: (params.page - 1) * params.perPage,
      take: params.perPage,
    }),
  ]);

  return {
    calls: rows.map(toCallDto),
    page: params.page,
    perPage: params.perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / params.perPage)),
  };
}

export async function getCallForTenant(tenantId: string, callId: string): Promise<CallLog> {
  const log = await prisma.callLog.findFirst({ where: { id: callId, tenantId } });
  if (!log) throw new HttpError(404, 'Call not found', 'CALL_NOT_FOUND');
  return log;
}

export interface CallStats {
  callsLast7Days: number;
  callsLast30Days: number;
  minutesLast30Days: number;
  costCentsLast30Days: number;
  forwardedLast30Days: number;
  afterHoursShare: number; // 0..1 of last-30-day calls handled while closed is not tracked; placeholder uses endedAt nulls
}

export async function getCallStats(tenantId: string): Promise<CallStats> {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // One bounded fetch, reduced in memory: per-tenant 30-day volume is small.
  const rows = await prisma.callLog.findMany({
    where: { tenantId, startedAt: { gte: since30 } },
    select: { startedAt: true, durationSeconds: true, billedCostCents: true, status: true },
    orderBy: { startedAt: 'desc' },
    take: 5000,
  });
  let calls7 = 0;
  let seconds30 = 0;
  let cost30 = 0;
  let forwarded30 = 0;
  for (const row of rows) {
    if (row.startedAt >= since7) calls7 += 1;
    seconds30 += row.durationSeconds;
    cost30 += row.billedCostCents;
    if (row.status === 'FORWARDED') forwarded30 += 1;
  }
  return {
    callsLast7Days: calls7,
    callsLast30Days: rows.length,
    minutesLast30Days: Math.round(seconds30 / 60),
    costCentsLast30Days: cost30,
    forwardedLast30Days: forwarded30,
    afterHoursShare: 0,
  };
}
