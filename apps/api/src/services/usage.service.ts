import { prisma } from '../lib/prisma';

/**
 * Per-tenant monthly call-minute usage, derived from CallLog (the source of
 * truth — every finished call is ingested there). Used to (1) enforce the
 * monthly minute cap per call so one tenant can't drain the shared provider
 * account, and (2) show tenants + the operator how much they've used.
 */

export interface MonthlyUsage {
  /** Start of the current usage window (1st of the month, UTC). */
  periodStart: string;
  /** Seconds of answered call time so far this period. */
  usedSeconds: number;
  /** Rounded minutes used (usedSeconds / 60). */
  usedMinutes: number;
  /** The tenant's hard cap for the period. */
  limitMinutes: number;
  /** Whole minutes left before the cap (never below 0). */
  remainingMinutes: number;
  /** 0..1 share of the cap consumed (capped at 1). */
  fractionUsed: number;
  /** True once usage has reached or passed the cap. */
  overLimit: boolean;
}

/**
 * First instant of the current calendar month, in UTC. A fixed, predictable
 * boundary ("resets on the 1st") — the few hours of timezone skew don't matter
 * for a cost cap, and it keeps the query a simple indexed range scan.
 */
export function startOfMonthUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Sums answered call seconds for a tenant since the given instant. */
async function usedSecondsSince(tenantId: string, since: Date): Promise<number> {
  const agg = await prisma.callLog.aggregate({
    where: { tenantId, startedAt: { gte: since } },
    _sum: { durationSeconds: true },
  });
  return agg._sum.durationSeconds ?? 0;
}

/** Full usage snapshot for display. */
export async function getMonthlyUsage(
  tenantId: string,
  limitMinutes: number,
  now: Date = new Date(),
): Promise<MonthlyUsage> {
  const periodStart = startOfMonthUTC(now);
  const usedSeconds = await usedSecondsSince(tenantId, periodStart);
  const usedMinutes = Math.round(usedSeconds / 60);
  const remainingMinutes = Math.max(0, limitMinutes - usedMinutes);
  const fractionUsed = limitMinutes > 0 ? Math.min(1, usedSeconds / 60 / limitMinutes) : 1;
  return {
    periodStart: periodStart.toISOString(),
    usedSeconds,
    usedMinutes,
    limitMinutes,
    remainingMinutes,
    fractionUsed,
    overLimit: usedSeconds / 60 >= limitMinutes,
  };
}

/**
 * Fast gate for the call path: true when the tenant has already used its full
 * monthly minute allowance. Compares raw seconds against the cap so we don't
 * let rounding hand out a free extra minute.
 */
export async function isOverMonthlyLimit(
  tenantId: string,
  limitMinutes: number,
  now: Date = new Date(),
): Promise<boolean> {
  const usedSeconds = await usedSecondsSince(tenantId, startOfMonthUTC(now));
  return usedSeconds / 60 >= limitMinutes;
}
