import cron from 'node-cron';
import { runWithLease } from '../lib/job-lock';
import { runRescueAlarm } from '../services/call-rescue.service';

/**
 * Success-rate alarm clock (reliability pack). Once an hour it looks at
 * the last RESCUE_ALARM_WINDOW_MINUTES of finalized calls and speaks up
 * in the AI Team group channel when a failure wave forms, so the team
 * learns about it before the clinic does. Thresholds and the 6-hour
 * per-scope dedupe live in call-rescue.service.ts and env.ts; dedupe
 * state is a DB table, so restarts cannot re-alarm.
 *
 * The job is silent on a clean window. A failed tick is logged, never
 * thrown into the scheduler, and locked with the cross-replica lease
 * like every other job.
 */

const LEASE_MS = 10 * 60_000;

export function startCallRescueAlarmJob(): void {
  cron.schedule('5 * * * *', () => {
    void runWithLease('call-rescue-alarm', LEASE_MS, async () => {
      try {
        const result = await runRescueAlarm();
        if (result.alarmsPosted > 0) {
          console.log(
            `[rescue-alarm] posted ${result.alarmsPosted} alarm(s): ${result.scopes
              .map((s) => `${s.scope}=${s.count}`)
              .join(', ')}`,
          );
        }
      } catch (err) {
        console.error('[rescue-alarm] tick failed:', err);
      }
    });
  });
}
