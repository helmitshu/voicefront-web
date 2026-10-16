import cron from 'node-cron';
import { runWithLease } from '../lib/job-lock';
import {
  buildBoardPack,
  runCallScoring,
  runLeakRadar,
  runUptimeCheck,
} from '../services/team-abilities.service';
import { runDailyDigest, runTeamCoordinator } from '../services/team-coordinator.service';
import { trackTeamRun } from '../services/team-runs.service';

/**
 * The team's clock (Phase 2a). The standing abilities stop waiting for
 * a button press and run on a schedule, each run written to the runs
 * ledger as SCHEDULED (which is also where the daily cap is counted,
 * TEAM_DAILY_RUN_CAP per UTC day). Scheduled model calls run on the
 * shared paid key: the coordinator's work drafts pass keyMode
 * 'shared', and the deterministic abilities call no model at all.
 *
 * All times are UTC, matching the other jobs (the API runs on UTC).
 * For America/Vancouver, subtract 8 hours (PST) or 7 (PDT):
 *
 *   Leak radar    daily      13:00 UTC  (5 AM PST / 6 AM PDT)
 *   Uptime check  hourly     :15 UTC
 *   Call scoring  nightly    09:00 UTC  (1 AM PST / 2 AM PDT)
 *   Board pack    Mondays    16:00 UTC  (8 AM PST / 9 AM PDT)
 *   Daily digest  daily      14:00 UTC  (6 AM PST / 7 AM PDT)
 *   Coordinator   every 4h   :30 UTC
 *
 * Every tick takes the cross-replica lease like the other jobs, and a
 * failed tick is logged, never thrown into the scheduler.
 */

const LEASE_MS = 10 * 60_000;

function scheduled(leaseName: string, fn: () => Promise<void>): void {
  void runWithLease(leaseName, LEASE_MS, async () => {
    try {
      await fn();
    } catch (err) {
      console.error(`[team-clock] ${leaseName} failed:`, err);
    }
  });
}

export function startTeamAbilitiesJob(): void {
  cron.schedule('0 13 * * *', () => {
    scheduled('team-leak-radar', async () => {
      const out = await trackTeamRun({
        ability: 'leak-radar',
        memberSlug: 'daniel',
        trigger: 'SCHEDULED',
        fn: async () => {
          const result = await runLeakRadar();
          return {
            result,
            summary: `Leak radar: ${result.leaks.length} leak(s) found, ${result.workItemsCreated} work item(s) created.`,
          };
        },
      });
      if (out.skipped) console.log('[team-clock] leak radar skipped: daily scheduled run cap reached.');
    });
  });

  cron.schedule('15 * * * *', () => {
    scheduled('team-uptime', async () => {
      const out = await trackTeamRun({
        ability: 'uptime',
        memberSlug: 'omar',
        trigger: 'SCHEDULED',
        fn: async () => {
          const result = await runUptimeCheck();
          const failing = result.checks.filter((check) => !check.ok).length;
          return {
            result,
            summary: `Uptime: ${result.checks.length - failing}/${result.checks.length} targets OK${result.workItemCreated ? ', failure filed as a work item' : ''}.`,
          };
        },
      });
      if (out.skipped) console.log('[team-clock] uptime skipped: daily scheduled run cap reached.');
    });
  });

  cron.schedule('0 9 * * *', () => {
    scheduled('team-call-scoring', async () => {
      const out = await trackTeamRun({
        ability: 'call-scoring',
        memberSlug: 'priya',
        trigger: 'SCHEDULED',
        fn: async () => {
          const result = await runCallScoring();
          return { result, summary: result.summary };
        },
      });
      if (out.skipped) console.log('[team-clock] call scoring skipped: daily scheduled run cap reached.');
    });
  });

  cron.schedule('0 16 * * 1', () => {
    scheduled('team-board-pack', async () => {
      const out = await trackTeamRun({
        ability: 'board-pack',
        memberSlug: 'layla',
        trigger: 'SCHEDULED',
        fn: async () => {
          const result = await buildBoardPack();
          return { result, summary: `Board pack drafted: ${result.title}.` };
        },
      });
      if (out.skipped) console.log('[team-clock] board pack skipped: daily scheduled run cap reached.');
    });
  });

  cron.schedule('0 14 * * *', () => {
    scheduled('team-daily-digest', async () => {
      const out = await trackTeamRun({
        ability: 'daily-digest',
        memberSlug: null,
        trigger: 'SCHEDULED',
        fn: async () => {
          const result = await runDailyDigest();
          return { result, summary: result.summary };
        },
      });
      if (out.skipped) console.log('[team-clock] daily digest skipped: daily scheduled run cap reached.');
    });
  });

  cron.schedule('30 */4 * * *', () => {
    scheduled('team-coordinator', async () => {
      const out = await trackTeamRun({
        ability: 'coordinator',
        memberSlug: null,
        trigger: 'SCHEDULED',
        fn: async () => {
          const result = await runTeamCoordinator({ keyMode: 'shared' });
          return { result, summary: result.summary };
        },
      });
      if (out.skipped) console.log('[team-clock] coordinator skipped: daily scheduled run cap reached.');
    });
  });
}
