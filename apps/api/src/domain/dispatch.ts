/**
 * Pure on-call dispatch logic — no Twilio, no DB — so the escalation state
 * machine can be exercised in unit tests. The service layer turns these
 * decisions into real calls; the webhooks feed events back in.
 */

export interface OnCallContact {
  name: string;
  phone: string;
}

/** Things that can happen to one ring of one contact. */
export type DispatchEvent = 'accepted' | 'no_answer' | 'declined' | 'failed' | 'timeout';

/** What to do next, decided purely from the dispatch's current state + event. */
export type DispatchAction =
  | { type: 'accept' } // a tech took it — stop, notify the customer
  | { type: 'call'; index: number } // ring the next contact
  | { type: 'exhaust' } // nobody left — final alert to the owner
  | { type: 'noop' }; // dispatch already resolved; ignore late events

export type DispatchStatusLite = 'NOTIFYING' | 'ACCEPTED' | 'EXHAUSTED' | 'CANCELLED';

/**
 * The single escalation rule. An accept ends it; any miss (no answer, decline,
 * failure, or timeout) advances to the next contact, and running off the end of
 * the roster exhausts the dispatch. Late events on an already-resolved dispatch
 * are no-ops so a straggling Twilio callback can't reopen it.
 */
export function nextDispatchAction(
  state: { status: DispatchStatusLite; currentIndex: number; rosterLength: number },
  event: DispatchEvent,
): DispatchAction {
  if (state.status !== 'NOTIFYING') return { type: 'noop' };
  if (event === 'accepted') return { type: 'accept' };
  const next = state.currentIndex + 1;
  return next < state.rosterLength ? { type: 'call', index: next } : { type: 'exhaust' };
}

/** Coerce the AgentSettings JSON roster into a clean, ordered contact list. */
export function parseOnCallRoster(raw: unknown): OnCallContact[] {
  if (!Array.isArray(raw)) return [];
  const out: OnCallContact[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const phone = typeof rec.phone === 'string' ? rec.phone.trim() : '';
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      if (phone) out.push({ name: name || 'On-call tech', phone });
    }
  }
  return out;
}
