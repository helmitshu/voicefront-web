import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { runWithLease } from '../lib/job-lock';
import { releaseNumberForTenant } from '../services/phone-pool.service';

/**
 * Data-retention housekeeping, once a day:
 *
 *  1. PURGE soft-deleted tenants past the recovery window — the deliberate,
 *     delayed hard-delete that makes "delete" both recoverable AND eventually
 *     final (so we don't keep dead customers' PII forever).
 *  2. SCRUB old call PII — null out transcripts and recording URLs on calls
 *     older than the retention window, keeping the billing/analytics metadata.
 *     Limits how long we hold sensitive customer content.
 */

/** How long a soft-deleted workspace is recoverable before it's purged for good. */
const TENANT_PURGE_DAYS = 30;
/** How long call transcripts + recordings are kept before being scrubbed. */
const CALL_PII_RETENTION_DAYS = 365;

async function purgeSoftDeletedTenants(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - TENANT_PURGE_DAYS * 24 * 60 * 60 * 1000);
  const due = await prisma.tenant.findMany({
    where: { deletedAt: { not: null, lt: cutoff } },
    select: { id: true, companyName: true },
  });
  for (const t of due) {
    try {
      await releaseNumberForTenant(t.id);
      await prisma.tenant.delete({ where: { id: t.id } });
      console.log(`[retention] purged soft-deleted workspace "${t.companyName}" (${t.id}).`);
    } catch (err) {
      console.error(`[retention] failed to purge ${t.id}:`, err);
    }
  }
}

async function scrubOldCallPii(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - CALL_PII_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.callLog.updateMany({
    where: {
      startedAt: { lt: cutoff },
      OR: [{ transcript: { not: null } }, { recordingUrl: { not: null } }],
    },
    data: { transcript: null, recordingUrl: null, summary: null },
  });
  if (count > 0) console.log(`[retention] scrubbed PII from ${count} call log(s) older than ${CALL_PII_RETENTION_DAYS}d.`);
}

async function runRetentionScan(): Promise<void> {
  const now = new Date();
  await purgeSoftDeletedTenants(now);
  await scrubOldCallPii(now);
}

export function startRetentionJob(): void {
  // Daily at 03:30 UTC — a quiet hour, offset from the other jobs. Leased so a
  // multi-replica deploy purges/scrubs once, not once per instance. 10-min lease
  // comfortably covers the scan.
  cron.schedule('30 3 * * *', () => {
    void runWithLease('retention-scan', 10 * 60_000, runRetentionScan).catch((err) =>
      console.error('[retention] scan failed:', err),
    );
  });
  console.log('[retention] Data-retention job started (daily at 03:30 UTC).');
}
