import cron from 'node-cron';
import { runWeeklyKnowledgeReviews } from '../services/adam-knowledge.service';
import { runWithLease } from '../lib/job-lock';

/**
 * The Weekly Upgrade trigger: every Monday, scan each live workspace's
 * calls from the last 7 days for questions patients asked that the
 * receptionist could not answer, and park a PENDING review Adam surfaces
 * in his chat. Follows the reactivation job's pattern exactly (node-cron
 * plus the cross-replica lease), so a second replica never double-runs it.
 */
export function startAdamWeeklyReviewJob(): void {
  // Mondays 15:00 UTC: after the weekend's calls are in, early enough in
  // the North American work week for the owner to act on it.
  cron.schedule('0 15 * * 1', () => {
    void runWithLease('adam-weekly-review', 10 * 60_000, async () => {
      try {
        const created = await runWeeklyKnowledgeReviews(new Date());
        console.log(`[adam-weekly] weekly knowledge reviews created: ${created}`);
      } catch (err) {
        console.error('[adam-weekly] weekly knowledge review run failed:', err);
      }
    });
  });
}
