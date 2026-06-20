import { prisma } from '../lib/prisma';
import { normalizePhone } from '../lib/phone';

export type ScreenReason = 'blocked' | 'anonymous';

export interface ScreeningDecision {
  blocked: boolean;
  reason?: ScreenReason;
}

/**
 * Decides whether to refuse an inbound call BEFORE an assistant is returned, so
 * a refused call never connects and burns zero provider minutes.
 *
 * Deliberately conservative — it only ever refuses on an explicit, tenant-owned
 * signal:
 *   1. the caller is on the tenant's own block list, or
 *   2. there's no caller ID AND the tenant opted into anonymous rejection.
 * Anything ambiguous is allowed through. A false negative (one spam call slips)
 * is cheap; a false positive (a real customer is refused) is invisible and
 * costly, so the bias is always toward connecting the call.
 */
export async function screenInboundCaller(params: {
  tenantId: string;
  callerNumber: string | null | undefined;
  rejectAnonymous: boolean;
}): Promise<ScreeningDecision> {
  const raw = params.callerNumber?.trim();
  // Anonymous / withheld caller id: only refuse when the tenant explicitly
  // opted in — plenty of real customers call with their number withheld.
  if (!raw) {
    return params.rejectAnonymous ? { blocked: true, reason: 'anonymous' } : { blocked: false };
  }
  const phone = normalizePhone(raw);
  const hit = await prisma.blockedCaller.findUnique({
    where: { tenantId_phone: { tenantId: params.tenantId, phone } },
    select: { id: true },
  });
  return hit ? { blocked: true, reason: 'blocked' } : { blocked: false };
}

/**
 * Records a refused call so the tenant can see what was screened out. Best
 * effort: a logging hiccup must never escalate into the call being connected,
 * so callers should `void` this (never await it on the hot path).
 */
export async function recordScreenedCall(params: {
  tenantId: string;
  callerNumber: string | null | undefined;
  reason: ScreenReason;
}): Promise<void> {
  try {
    await prisma.screenedCallLog.create({
      data: {
        tenantId: params.tenantId,
        callerNumber: params.callerNumber ? normalizePhone(params.callerNumber) : null,
        reason: params.reason,
      },
    });
  } catch (err) {
    console.error('[screening] failed to record screened call:', err);
  }
}
