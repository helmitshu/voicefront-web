import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Prisma client BEFORE importing the module under test, so runWithLease
// binds to these spies. We assert leader-election behaviour by controlling what
// the atomic claim INSERT ... RETURNING comes back with.
const queryRaw = vi.fn();
const executeRaw = vi.fn().mockResolvedValue(0);

vi.mock('./prisma', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    $executeRaw: (...args: unknown[]) => executeRaw(...args),
  },
}));
vi.mock('./logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { runWithLease } from './job-lock';

describe('runWithLease', () => {
  beforeEach(() => {
    queryRaw.mockReset();
    executeRaw.mockReset().mockResolvedValue(0);
  });

  it('runs the job and releases when it wins the lease', async () => {
    queryRaw.mockResolvedValue([{ name: 'reminder-scan' }]); // claim succeeded
    const fn = vi.fn().mockResolvedValue(undefined);

    const ran = await runWithLease('reminder-scan', 60_000, fn);

    expect(ran).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
    expect(executeRaw).toHaveBeenCalledOnce(); // released
  });

  it('skips the job when another replica holds the lease', async () => {
    queryRaw.mockResolvedValue([]); // claim returned no row → lease held elsewhere
    const fn = vi.fn().mockResolvedValue(undefined);

    const ran = await runWithLease('reminder-scan', 60_000, fn);

    expect(ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled(); // nothing to release
  });

  it('always releases the lease even if the job throws', async () => {
    queryRaw.mockResolvedValue([{ name: 'dispatch-sweep' }]);
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(runWithLease('dispatch-sweep', 60_000, fn)).rejects.toThrow('boom');
    expect(executeRaw).toHaveBeenCalledOnce(); // released in finally
  });

  it('skips (does not throw) if the lock table is unreachable', async () => {
    queryRaw.mockRejectedValue(new Error('db down'));
    const fn = vi.fn();

    const ran = await runWithLease('retention-scan', 60_000, fn);

    expect(ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
