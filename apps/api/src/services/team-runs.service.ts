import { prisma } from '../lib/prisma';
import { env } from '../config/env';

/**
 * The team runs ledger (Phase 2a). Every ability run, manual or
 * scheduled, is wrapped by trackTeamRun, which:
 *
 *  - writes a TeamRun row (RUNNING, then DONE or FAILED with a plain
 *    summary), so the team's work has one ledger the daily digest and
 *    the daily cap both read;
 *  - writes a TeamToolLog row for the run, so the Tool log tab tells
 *    the truth about work that happened outside member tool calls;
 *  - enforces the daily cap on SCHEDULED runs: at most
 *    TEAM_DAILY_RUN_CAP scheduled runs per UTC day, counted from the
 *    ledger itself. A run over the cap is skipped quietly: the ability
 *    never runs, and the ledger row is written FAILED with a summary
 *    saying the cap was reached, so the skip is visible, not silent
 *    in the data. Manual runs are never capped.
 *
 * A failure inside the ability marks the run FAILED, logs it, and the
 * error is rethrown: a route keeps its honest error response and the
 * job wrapper logs and moves on. Nothing here invents a result.
 */

export type TeamRunTriggerName = 'MANUAL' | 'SCHEDULED';

export type TrackedRun<T> =
  | { skipped: false; result: T; summary: string; runId: string }
  | { skipped: true; runId: string };

const SUMMARY_CAP = 4000;

function startOfUtcDay(now: Date): Date {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

/** How many scheduled runs the ledger already holds for this UTC day. */
export async function countScheduledRunsToday(now = new Date()): Promise<number> {
  return prisma.teamRun.count({
    where: { trigger: 'SCHEDULED', startedAt: { gte: startOfUtcDay(now) } },
  });
}

async function writeToolLog(params: {
  memberSlug: string | null;
  ability: string;
  trigger: TeamRunTriggerName;
  ok: boolean;
  summary: string;
}): Promise<void> {
  await prisma.teamToolLog.create({
    data: {
      memberSlug: params.memberSlug ?? 'coordinator',
      tool: `ability:${params.ability}`,
      inputSummary: `trigger: ${params.trigger}`,
      resultSummary: params.summary.slice(0, 1000),
      ok: params.ok,
    },
  });
}

/**
 * Run one ability under the ledger. `fn` does the work and returns the
 * ability's result plus the one-line summary the ledger and the tool
 * log keep. `dailyCap` exists as a test seam; production always reads
 * TEAM_DAILY_RUN_CAP from the environment.
 */
export async function trackTeamRun<T>(params: {
  ability: string;
  memberSlug?: string | null;
  trigger: TeamRunTriggerName;
  dailyCap?: number;
  now?: Date;
  fn: () => Promise<{ result: T; summary: string }>;
}): Promise<TrackedRun<T>> {
  const now = params.now ?? new Date();

  if (params.trigger === 'SCHEDULED') {
    const cap = params.dailyCap ?? env.TEAM_DAILY_RUN_CAP;
    const already = await countScheduledRunsToday(now);
    if (already >= cap) {
      const summary = `Skipped: daily scheduled run cap reached (TEAM_DAILY_RUN_CAP=${cap}).`;
      const run = await prisma.teamRun.create({
        data: {
          ability: params.ability,
          memberSlug: params.memberSlug ?? null,
          trigger: 'SCHEDULED',
          status: 'FAILED',
          summary,
          startedAt: now,
          finishedAt: now,
        },
      });
      await writeToolLog({
        memberSlug: params.memberSlug ?? null,
        ability: params.ability,
        trigger: 'SCHEDULED',
        ok: false,
        summary,
      });
      return { skipped: true, runId: run.id };
    }
  }

  const run = await prisma.teamRun.create({
    data: {
      ability: params.ability,
      memberSlug: params.memberSlug ?? null,
      trigger: params.trigger,
      status: 'RUNNING',
      startedAt: now,
    },
  });
  try {
    const { result, summary } = await params.fn();
    const cleanSummary = summary.slice(0, SUMMARY_CAP);
    await prisma.teamRun.update({
      where: { id: run.id },
      data: { status: 'DONE', summary: cleanSummary, finishedAt: new Date() },
    });
    await writeToolLog({
      memberSlug: params.memberSlug ?? null,
      ability: params.ability,
      trigger: params.trigger,
      ok: true,
      summary: cleanSummary,
    });
    return { skipped: false, result, summary: cleanSummary, runId: run.id };
  } catch (err) {
    const summary = `Failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, SUMMARY_CAP);
    await prisma.teamRun
      .update({ where: { id: run.id }, data: { status: 'FAILED', summary, finishedAt: new Date() } })
      .catch(() => undefined);
    await writeToolLog({
      memberSlug: params.memberSlug ?? null,
      ability: params.ability,
      trigger: params.trigger,
      ok: false,
      summary,
    }).catch(() => undefined);
    throw err;
  }
}

/**
 * The result of a run that cannot have been skipped. Manual runs are
 * never capped, so a route unwraps with this and a skip here would be
 * a programming error, said plainly.
 */
export function unwrapRun<T>(tracked: TrackedRun<T>): { result: T; summary: string } {
  if (tracked.skipped) {
    throw new Error('A manual team run was skipped; manual runs are never capped.');
  }
  return { result: tracked.result, summary: tracked.summary };
}
