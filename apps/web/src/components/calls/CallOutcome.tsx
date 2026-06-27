import { Badge, type BadgeTone } from '@/components/ui/Card';
import type { CallDto, CallDetailDto } from '@/lib/api';

// Label + colour for each AI-extracted enum. Kept here so the list and the
// detail page render outcomes identically.
const OUTCOME_META: Record<string, { label: string; tone: BadgeTone }> = {
  BOOKED: { label: 'Booked', tone: 'success' },
  RESCHEDULED: { label: 'Rescheduled', tone: 'signal' },
  CANCELLED: { label: 'Cancelled', tone: 'warning' },
  JOB_LOGGED: { label: 'Job logged', tone: 'success' },
  MESSAGE_TAKEN: { label: 'Message taken', tone: 'neutral' },
  TRANSFERRED: { label: 'Transferred', tone: 'signal' },
  NO_ACTION: { label: 'No action', tone: 'warning' },
};

const INTENT_LABEL: Record<string, string> = {
  BOOK: 'Booking',
  RESCHEDULE: 'Reschedule',
  CANCEL: 'Cancellation',
  JOB_REQUEST: 'Job request',
  QUESTION: 'Question',
  OTHER: 'Other',
};

const URGENCY_META: Record<string, { label: string; tone: BadgeTone }> = {
  EMERGENCY: { label: 'Emergency', tone: 'danger' },
  URGENT: { label: 'Urgent', tone: 'warning' },
  ROUTINE: { label: 'Routine', tone: 'neutral' },
};

const LEAD_META: Record<string, { label: string; tone: BadgeTone }> = {
  HOT: { label: 'Hot lead', tone: 'success' },
  WARM: { label: 'Warm lead', tone: 'signal' },
  COLD: { label: 'Cold lead', tone: 'neutral' },
};

function scoreTone(score: number): BadgeTone {
  return score >= 8 ? 'success' : score >= 5 ? 'warning' : 'danger';
}

/** True when the call has any AI outcome worth showing (older calls have none). */
export function hasOutcome(call: CallDto): boolean {
  return Boolean(call.outcome || call.urgency || call.leadQuality || call.successScore != null);
}

/** Compact inline chips — used in the call list and detail header. */
export function CallOutcomeChips({ call, showScore = false }: { call: CallDto; showScore?: boolean }) {
  const outcome = call.outcome ? OUTCOME_META[call.outcome] : null;
  const urgency = call.urgency && call.urgency !== 'NONE' ? URGENCY_META[call.urgency] : null;
  const lead = call.leadQuality && call.leadQuality !== 'NA' ? LEAD_META[call.leadQuality] : null;
  if (!outcome && !urgency && !lead && !(showScore && call.successScore != null)) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {urgency && <Badge tone={urgency.tone} dot>{urgency.label}</Badge>}
      {outcome && <Badge tone={outcome.tone}>{outcome.label}</Badge>}
      {lead && <Badge tone={lead.tone}>{lead.label}</Badge>}
      {showScore && call.successScore != null && (
        <Badge tone={scoreTone(call.successScore)}>Quality {call.successScore}/10</Badge>
      )}
    </div>
  );
}

function structuredString(data: Record<string, unknown> | null, key: string): string | null {
  const v = data?.[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** Full outcome panel for the call detail page. Renders nothing if no data. */
export function CallOutcomePanel({ call }: { call: CallDetailDto }) {
  const intent = call.intent ? (INTENT_LABEL[call.intent] ?? call.intent) : null;
  const callerName = structuredString(call.structuredData, 'callerName');
  const callbackNumber = structuredString(call.structuredData, 'callbackNumber');
  const topic = structuredString(call.structuredData, 'topic');

  const rows: Array<{ label: string; value: string }> = [];
  if (callerName) rows.push({ label: 'Caller', value: callerName });
  if (topic) rows.push({ label: 'About', value: topic });
  if (intent) rows.push({ label: 'Reason', value: intent });
  if (callbackNumber) rows.push({ label: 'Callback', value: callbackNumber });

  if (!hasOutcome(call) && rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      <CallOutcomeChips call={call} showScore />
      {rows.length > 0 && (
        <dl className="flex flex-col divide-y divide-line/60">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
              <dt className="text-[13px] text-ink-muted">{r.label}</dt>
              <dd className="text-right text-[13px] font-medium text-ink">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
