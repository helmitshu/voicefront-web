import cron from 'node-cron';
import { runWithLease } from '../lib/job-lock';
import { isSmsAvailable } from '../services/sms.service';
import { runReactivationScan } from '../services/reactivation.service';

/**
 * Daily recall sweep: texts lapsed customers an invite to rebook. Runs once a
 * day (16:00 UTC ≈ mid-morning in the Americas) so messages land at a civil
 * hour for most tenants. The per-customer throttle lives in the service, so a
 * missed or doubled run never double-texts anyone.
 */
export function startReactivationJob(): void {
  if (!isSmsAvailable()) {
    console.log('[reactivation] Twilio not configured — recall job disabled.');
    return;
  }
  // Daily at 16:00 UTC, leased so only one replica runs the recall sweep — the
  // per-customer throttle already prevents double-texting, but the lease avoids
  // N replicas each doing the full scan.
  cron.schedule('0 16 * * *', () => {
    void runWithLease('reactivation-scan', 10 * 60_000, runReactivationScan).catch((err) =>
      console.error('[reactivation] scan error:', err),
    );
  });
  console.log('[reactivation] Recall job started (daily at 16:00 UTC).');
}
