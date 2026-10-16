import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Runs ledger tests (Phase 2a): trackTeamRun writes the TeamRun row and
 * a TeamToolLog row for every run, marks DONE or FAILED with the
 * summary, rethrows failures so routes keep honest errors, and enforces
 * the scheduled daily cap counted from the ledger itself: at the cap a
 * scheduled run is skipped, the ability never runs, and the ledger row
 * lands FAILED saying the cap was reached. Manual runs are never capped.
 */

const prismaMock: Record<string, any> = vi.hoisted(() => ({
  teamRun: {
    create: vi.fn(async ({ data }: any) => ({ id: 'run_1', ...data })),
    update: vi.fn(async ({ data }: any) => ({ id: 'run_1', ...data })),
    count: vi.fn(async () => 0),
  },
  teamToolLog: {
    create: vi.fn(async ({ data }: any) => ({ id: 'log_1', ...data })),
  },
}));

vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));

import { trackTeamRun, unwrapRun } from './team-runs.service';

describe('trackTeamRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.teamRun.count.mockResolvedValue(0);
    prismaMock.teamRun.create.mockImplementation(async ({ data }: any) => ({ id: 'run_1', ...data }));
    prismaMock.teamRun.update.mockImplementation(async ({ data }: any) => ({ id: 'run_1', ...data }));
  });

  it('a manual run lands DONE with its summary, and a tool log row tells the truth', async () => {
    const out = await trackTeamRun({
      ability: 'leak-radar',
      memberSlug: 'daniel',
      trigger: 'MANUAL',
      fn: async () => ({ result: { leaks: 2 }, summary: 'Leak radar: 2 leak(s) found.' }),
    });

    expect(out.skipped).toBe(false);
    if (!out.skipped) {
      expect(out.result).toEqual({ leaks: 2 });
      expect(unwrapRun(out).summary).toContain('2 leak(s)');
    }
    expect(prismaMock.teamRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ability: 'leak-radar', trigger: 'MANUAL', status: 'RUNNING' }),
      }),
    );
    expect(prismaMock.teamRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DONE', summary: 'Leak radar: 2 leak(s) found.' }),
      }),
    );
    expect(prismaMock.teamToolLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberSlug: 'daniel',
          tool: 'ability:leak-radar',
          ok: true,
          resultSummary: 'Leak radar: 2 leak(s) found.',
        }),
      }),
    );
    // Manual runs never consult the cap.
    expect(prismaMock.teamRun.count).not.toHaveBeenCalled();
  });

  it('a failed run lands FAILED, logs ok:false, and the error is rethrown', async () => {
    await expect(
      trackTeamRun({
        ability: 'uptime',
        memberSlug: 'omar',
        trigger: 'MANUAL',
        fn: async () => {
          throw new Error('health endpoint exploded');
        },
      }),
    ).rejects.toThrow('health endpoint exploded');

    expect(prismaMock.teamRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          summary: 'Failed: health endpoint exploded',
        }),
      }),
    );
    expect(prismaMock.teamToolLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ok: false }) }),
    );
  });

  it('at the cap a scheduled run is skipped, the ability never runs, and the ledger says why', async () => {
    prismaMock.teamRun.count.mockResolvedValue(40);
    const fn = vi.fn(async () => ({ result: 'ran', summary: 'ran' }));

    const out = await trackTeamRun({
      ability: 'leak-radar',
      memberSlug: 'daniel',
      trigger: 'SCHEDULED',
      dailyCap: 40,
      fn,
    });

    expect(out.skipped).toBe(true);
    expect(fn).not.toHaveBeenCalled();
    expect(prismaMock.teamRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          trigger: 'SCHEDULED',
          summary: expect.stringContaining('daily scheduled run cap reached'),
        }),
      }),
    );
    expect(prismaMock.teamToolLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ok: false }) }),
    );
  });

  it('under the cap a scheduled run runs normally', async () => {
    prismaMock.teamRun.count.mockResolvedValue(39);
    const fn = vi.fn(async () => ({ result: 'ran', summary: 'Board pack drafted.' }));

    const out = await trackTeamRun({
      ability: 'board-pack',
      memberSlug: 'layla',
      trigger: 'SCHEDULED',
      dailyCap: 40,
      fn,
    });

    expect(out.skipped).toBe(false);
    expect(fn).toHaveBeenCalledOnce();
    expect(prismaMock.teamRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DONE' }) }),
    );
  });
});
