import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';

/**
 * Stable identity for this running API instance. Railway exposes a per-replica
 * id; fall back to a random one so the lock still works locally and in tests.
 */
const INSTANCE_ID = process.env.RAILWAY_REPLICA_ID ?? `local-${randomUUID().slice(0, 8)}`;

/**
 * Atomically claim (or renew an expired) lease for `name` until `until`.
 *
 * The whole decision is a single statement so it's race-safe across replicas:
 * the INSERT wins if no row exists; otherwise the ON CONFLICT update only fires
 * when the existing lease has already expired (`locked_until < now`). If another
 * replica holds a live lease, no row is returned and we back off.
 */
async function claimLease(name: string, until: Date): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>(Prisma.sql`
    INSERT INTO "job_locks" ("name", "locked_until", "owner", "updated_at")
    VALUES (${name}, ${until}, ${INSTANCE_ID}, now())
    ON CONFLICT ("name") DO UPDATE
      SET "locked_until" = EXCLUDED."locked_until",
          "owner"        = EXCLUDED."owner",
          "updated_at"   = now()
      WHERE "job_locks"."locked_until" < now()
    RETURNING "name"
  `);
  return rows.length > 0;
}

/**
 * Best-effort release: expire the lease so the next tick is free immediately,
 * but only if we still own it (a slow run whose lease already expired and was
 * taken over by another replica must not clobber the new holder).
 */
async function releaseLease(name: string): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "job_locks"
    SET "locked_until" = now(), "updated_at" = now()
    WHERE "name" = ${name} AND "owner" = ${INSTANCE_ID}
  `);
}

/**
 * Run `fn` only if THIS replica can claim the lease for `name`. Returns true if
 * we ran (we were the leader this tick), false if another replica held it.
 *
 * Why a lease and not a Postgres advisory session lock: under Prisma's
 * connection pool the acquire and release can land on different pooled
 * connections, so session-scoped advisory locks leak. A time-boxed row lease is
 * pool-agnostic and self-healing — if the leader crashes mid-run, `leaseMs`
 * passes and any replica picks the job up on its next tick.
 *
 * `leaseMs` must comfortably exceed the job's worst-case runtime so a slow run
 * isn't double-started, but stay short enough that a crash doesn't pause the job
 * for too long.
 */
export async function runWithLease(name: string, leaseMs: number, fn: () => Promise<void>): Promise<boolean> {
  const until = new Date(Date.now() + leaseMs);
  let claimed = false;
  try {
    claimed = await claimLease(name, until);
  } catch (err) {
    // If the lock table itself is unreachable, don't silently drop the job on
    // a single-instance deploy — log and skip this tick; the next one retries.
    logger.error({ err, job: name }, 'job-lock: failed to claim lease');
    return false;
  }
  if (!claimed) return false;

  try {
    await fn();
  } finally {
    await releaseLease(name).catch((err) => logger.warn({ err, job: name }, 'job-lock: release failed (lease will expire)'));
  }
  return true;
}
