import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { deriveCallStatus } from '../domain/call-status';

/**
 * Safe landing + success-rate alarm (reliability pack).
 *
 * SAFE LANDING: a failed call must become a saved callback, never a lost
 * caller. At end-of-call finalize time the classifier below decides, from
 * the stored record alone, whether the caller still needs a human
 * callback: the call produced NO appointment and at least one provable
 * failure signal is present. The flag lands on the CallLog
 * (rescueNeeded / rescueReason), the clinic sees a "Needs callback"
 * badge, and an owner/manager clears it once the callback happened.
 *
 * Which calls can even be classified: only tenant CallLog rows ever
 * reach finalize. Demo calls return early in the webhook (captured as
 * DemoCall rows) and simulated calls likewise (captured on their run),
 * so demo and sim traffic can never be flagged, by construction.
 *
 * ALARM: an hourly job (jobs/call-rescue-alarm.job.ts) evaluates the
 * last window of finalized calls and speaks up in the team channel the
 * moment a failure wave forms, before the clinic notices. See
 * runRescueAlarm below.
 */

/* ------------------------------ classifier ------------------------------ */

export interface RescueClassificationInput {
  /** Raw provider endedReason exactly as stored on the CallLog. */
  endedReason: string | null;
  /** Stored transcript; null or whitespace counts as nothing said. */
  transcript: string | null;
  durationSeconds: number;
  /**
   * Whether an appointment came out of this call, proven by the caller
   * (the finalize path): the provider's structured-data flag OR an
   * Appointment row carrying this call's provider id.
   */
  appointmentBooked: boolean;
}

export interface RescueClassification {
  rescueNeeded: boolean;
  /** Plain-words reason naming the signal(s) that fired; null when clean. */
  rescueReason: string | null;
}

/** A call shorter than this with nothing said counts as dropped. */
export const RESCUE_DROPPED_MAX_SECONDS = 15;

/**
 * endedReason values that are failures on their face, exactly as Vapi
 * reports them. `call.start.error-*` is matched by prefix (the family
 * includes -get-transport, -vapi-number-outbound-daily-limit,
 * -vapi-number-international, and friends, the transport class that
 * killed the founder's own test call). Anything else the codebase
 * already treats as an error is caught through deriveCallStatus below:
 * its FAILED bucket (reasons containing error / failed / did-not-
 * connect / no-answer). NOTE: there is deliberately no "a booking tool
 * attempt failed" signal, because tool attempts during a call are not
 * persisted on the stored record, so that signal is not provable.
 */
const EXACT_FAILURE_REASONS = new Set(['silence-timed-out', 'exceeded-max-duration', 'assistant-error']);

function failureSignalFor(endedReason: string | null): string | null {
  if (!endedReason) return null;
  const reason = endedReason.trim();
  const lower = reason.toLowerCase();
  if (lower.startsWith('call.start.error')) {
    return `The call failed to start (${reason}).`;
  }
  if (EXACT_FAILURE_REASONS.has(lower)) {
    if (lower === 'silence-timed-out') return 'The call ended in silence with no booking.';
    if (lower === 'exceeded-max-duration') return 'The call ran to the maximum duration with no booking.';
    return 'The receptionist hit an error mid-call (assistant-error).';
  }
  if (lower.includes('pipeline-error')) {
    return `The call failed in the voice pipeline (${reason}).`;
  }
  if (deriveCallStatus(reason) === 'FAILED') {
    return `The call failed (${reason}).`;
  }
  return null;
}

/**
 * Pure classifier, total over its inputs (it cannot throw on stored
 * data). Conservative by design: a booked call never flags, a clean
 * message-only call never flags, and a single provable signal is
 * required before a human is asked to call anyone back.
 */
export function classifyCallRescue(input: RescueClassificationInput): RescueClassification {
  if (input.appointmentBooked) {
    return { rescueNeeded: false, rescueReason: null };
  }
  const signals: string[] = [];
  const failure = failureSignalFor(input.endedReason);
  if (failure) signals.push(failure);
  const nothingSaid = !input.transcript || input.transcript.trim().length === 0;
  if (nothingSaid && input.durationSeconds < RESCUE_DROPPED_MAX_SECONDS) {
    signals.push(
      `The call dropped after ${Math.max(0, input.durationSeconds)}s with nothing said and no booking.`,
    );
  }
  if (signals.length === 0) {
    return { rescueNeeded: false, rescueReason: null };
  }
  return { rescueNeeded: true, rescueReason: signals.join(' ') };
}

/* -------------------------------- alarm --------------------------------- */

export interface RescueAlarmScopeResult {
  scope: string;
  kind: 'tenant' | 'platform' | 'demo-transport';
  count: number;
}

export interface RescueAlarmRunResult {
  alarmsPosted: number;
  scopes: RescueAlarmScopeResult[];
}

/**
 * Evaluates the last RESCUE_ALARM_WINDOW_MINUTES of finalized calls and
 * raises at most one alarm per scope per RESCUE_ALARM_DEDUPE_HOURS.
 * Alarm conditions (thresholds in env.ts):
 *   - one tenant with RESCUE_ALARM_TENANT_THRESHOLD+ rescue-needed calls
 *   - RESCUE_ALARM_PLATFORM_THRESHOLD+ rescue-needed calls platform-wide
 *   - RESCUE_ALARM_DEMO_TRANSPORT_THRESHOLD+ outbound demo calls ending
 *     in a call.start.error-* transport failure (DemoCall rows: a start
 *     error is by construction a phone-transport failure, web demo
 *     calls have no transport to fail)
 * Each alarm posts ONE templated SYSTEM status line to the AI Team
 * group channel and files one failure case. Dedupe state lives in the
 * ReliabilityAlarm table, never in process memory, so a restart cannot
 * re-alarm a wave already reported. A clean window posts nothing.
 */
export async function runRescueAlarm(now: Date = new Date()): Promise<RescueAlarmRunResult> {
  const windowMinutes = env.RESCUE_ALARM_WINDOW_MINUTES;
  const dedupeMs = env.RESCUE_ALARM_DEDUPE_HOURS * 60 * 60 * 1000;
  const windowStart = new Date(now.getTime() - windowMinutes * 60 * 1000);

  const rescueRows = await prisma.callLog.findMany({
    where: { rescueNeeded: true, endedAt: { gte: windowStart } },
    select: { id: true, tenantId: true },
    orderBy: { endedAt: 'asc' },
    take: 1000,
  });
  const demoTransportErrors = await prisma.demoCall.count({
    where: { endedReason: { startsWith: 'call.start.error' }, createdAt: { gte: windowStart } },
  });

  const perTenant = new Map<string, { count: number; callIds: string[] }>();
  for (const row of rescueRows) {
    const entry = perTenant.get(row.tenantId) ?? { count: 0, callIds: [] };
    entry.count += 1;
    entry.callIds.push(row.id);
    perTenant.set(row.tenantId, entry);
  }

  const tenantIds = [...perTenant.keys()];
  const tenants = tenantIds.length
    ? await prisma.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, companyName: true },
      })
    : [];
  const tenantName = new Map(tenants.map((t) => [t.id, t.companyName]));

  interface Candidate extends RescueAlarmScopeResult {
    body: string;
    caseTitle: string;
    caseDescription: string;
    caseCallLogId: string | null;
  }
  const candidates: Candidate[] = [];

  for (const [tenantId, entry] of perTenant) {
    if (entry.count < env.RESCUE_ALARM_TENANT_THRESHOLD) continue;
    const name = tenantName.get(tenantId) ?? 'A workspace';
    candidates.push({
      scope: `tenant:${tenantId}`,
      kind: 'tenant',
      count: entry.count,
      body: `Reliability alarm: ${name} had ${entry.count} calls in the last ${windowMinutes} minutes end broken with no booking. Each is flagged "Needs callback" in their call history. A failure case was filed.`,
      caseTitle: `Reliability alarm: rescue wave at ${name} (${entry.count} calls in ${windowMinutes}m)`,
      caseDescription: [
        `${entry.count} finalized calls for ${name} (tenant ${tenantId}) were flagged rescue-needed in the ${windowMinutes} minutes before ${now.toISOString()}.`,
        `Call ids: ${entry.callIds.join(', ')}`,
        'Each call is flagged in the tenant call history until an owner or manager clears it after calling back.',
      ].join('\n'),
      caseCallLogId: entry.callIds[0] ?? null,
    });
  }

  if (rescueRows.length >= env.RESCUE_ALARM_PLATFORM_THRESHOLD) {
    candidates.push({
      scope: 'platform',
      kind: 'platform',
      count: rescueRows.length,
      body: `Reliability alarm: ${rescueRows.length} calls platform-wide in the last ${windowMinutes} minutes ended broken with no booking. A failure case was filed.`,
      caseTitle: `Reliability alarm: platform rescue wave (${rescueRows.length} calls in ${windowMinutes}m)`,
      caseDescription: [
        `${rescueRows.length} finalized calls across ${perTenant.size} workspace(s) were flagged rescue-needed in the ${windowMinutes} minutes before ${now.toISOString()}.`,
        `Call ids: ${rescueRows.map((r) => r.id).join(', ')}`,
      ].join('\n'),
      caseCallLogId: rescueRows[0]?.id ?? null,
    });
  }

  if (demoTransportErrors >= env.RESCUE_ALARM_DEMO_TRANSPORT_THRESHOLD) {
    candidates.push({
      scope: 'demo-transport',
      kind: 'demo-transport',
      count: demoTransportErrors,
      body: `Reliability alarm: ${demoTransportErrors} demo calls in the last ${windowMinutes} minutes failed to start (transport errors). A failure case was filed.`,
      caseTitle: `Reliability alarm: demo transport failures (${demoTransportErrors} in ${windowMinutes}m)`,
      caseDescription: [
        `${demoTransportErrors} demo calls captured in the ${windowMinutes} minutes before ${now.toISOString()} ended with a call.start.error-* reason: the outbound transport failed before the call could ring.`,
        'This is the failure class that killed the founder\u2019s own test call (Twilio trial transport). Check the demo number transport first.',
      ].join('\n'),
      caseCallLogId: null,
    });
  }

  // Lazy import: the classifier half of this module is imported by the
  // calllog finalize path, and a static import of the team service
  // would drag the whole team tool graph into that path.
  const { postGroupStatusLine } = await import('./team.service');

  const posted: RescueAlarmScopeResult[] = [];
  for (const candidate of candidates) {
    const state = await prisma.reliabilityAlarm.findUnique({ where: { scope: candidate.scope } });
    if (state && now.getTime() - state.lastAlarmedAt.getTime() < dedupeMs) {
      continue; // This scope already alarmed inside the dedupe window.
    }
    await postGroupStatusLine({ body: candidate.body });
    await prisma.failureCase.create({
      data: {
        title: candidate.caseTitle,
        description: candidate.caseDescription,
        callLogId: candidate.caseCallLogId,
        checksJson: {
          source: 'rescue-alarm',
          kind: candidate.kind,
          scope: candidate.scope,
          count: candidate.count,
          windowMinutes,
        },
      },
    });
    await prisma.reliabilityAlarm.upsert({
      where: { scope: candidate.scope },
      create: { scope: candidate.scope, lastAlarmedAt: now, lastCount: candidate.count },
      update: { lastAlarmedAt: now, lastCount: candidate.count },
    });
    posted.push({ scope: candidate.scope, kind: candidate.kind, count: candidate.count });
  }

  return { alarmsPosted: posted.length, scopes: posted };
}
