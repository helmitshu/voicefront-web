import cron from 'node-cron';
import { runWithLease } from '../lib/job-lock';
import { isDispatchVoiceAvailable, sweepStaleDispatches } from '../services/dispatch.service';

/**
 * Safety net for on-call dispatch. Twilio's call-status callbacks drive
 * escalation normally; this sweep catches dispatches left ringing past their
 * timeout because a callback was lost, and escalates them. The current-index
 * guard in the service makes it idempotent, so running every minute is safe.
 */
export function startDispatchJob(): void {
  if (!isDispatchVoiceAvailable()) {
    console.log('[dispatch] Twilio not configured — on-call dispatch sweep disabled.');
    return;
  }
  // Every minute, but only on whichever replica wins the lease — otherwise a
  // scaled API would escalate the same stale dispatch from several instances.
  cron.schedule('* * * * *', () => {
    void runWithLease('dispatch-sweep', 50_000, sweepStaleDispatches).catch((err) =>
      console.error('[dispatch] sweep failed:', err),
    );
  });
  console.log('[dispatch] On-call dispatch escalation sweep started (every minute).');
}
