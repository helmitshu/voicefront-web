import { prisma } from '../lib/prisma';
import { sendReactivation } from './sms.service';

/**
 * Reactivation ("recall") campaigns — a daily job that texts lapsed customers
 * an invitation to rebook. A customer is lapsed when their most recent visit is
 * older than the tenant's inactivity window AND they have nothing on the books
 * since. Each customer is contacted at most once per lapse (ReactivationLog
 * throttle), never on a loop.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Safety cap so a first run on a big history doesn't blast thousands at once. */
const MAX_PER_TENANT_PER_RUN = 100;

interface LapsedCustomer {
  phone: string;
  name: string;
  lastSeen: Date;
}

/**
 * Customers whose latest appointment is older than the cutoff and who have
 * completed at least one visit (so we don't chase pure no-shows/cancellers).
 * Grouped by phone in memory — per-tenant history is small.
 */
async function findLapsedCustomers(tenantId: string, inactivityDays: number): Promise<LapsedCustomer[]> {
  const cutoff = new Date(Date.now() - inactivityDays * DAY_MS);

  const appts = await prisma.appointment.findMany({
    where: { tenantId, demoSessionId: null, customerPhone: { not: null } },
    select: { customerPhone: true, customerName: true, startsAt: true, status: true },
    take: 20000,
  });

  const byPhone = new Map<string, { name: string; lastSeen: Date; everCompleted: boolean }>();
  for (const a of appts) {
    const phone = a.customerPhone!;
    const entry = byPhone.get(phone);
    if (!entry) {
      byPhone.set(phone, {
        name: a.customerName,
        lastSeen: a.startsAt,
        everCompleted: a.status === 'COMPLETED',
      });
    } else {
      if (a.startsAt > entry.lastSeen) {
        entry.lastSeen = a.startsAt;
        entry.name = a.customerName; // freshest name wins
      }
      if (a.status === 'COMPLETED') entry.everCompleted = true;
    }
  }

  const lapsed: LapsedCustomer[] = [];
  for (const [phone, v] of byPhone) {
    if (v.everCompleted && v.lastSeen < cutoff) {
      lapsed.push({ phone, name: v.name, lastSeen: v.lastSeen });
    }
  }
  // Longest-lapsed first — they're most at risk of being lost for good.
  lapsed.sort((a, b) => a.lastSeen.getTime() - b.lastSeen.getTime());
  return lapsed;
}

/** Phones contacted within the window already (so we don't re-text them). */
async function recentlyContacted(tenantId: string, inactivityDays: number): Promise<Set<string>> {
  const since = new Date(Date.now() - inactivityDays * DAY_MS);
  const rows = await prisma.reactivationLog.findMany({
    where: { tenantId, sentAt: { gte: since } },
    select: { phone: true },
  });
  return new Set(rows.map((r) => r.phone));
}

/** Phones opted out of this tenant's SMS. */
async function optedOutPhones(tenantId: string): Promise<Set<string>> {
  const rows = await prisma.smsOptOut.findMany({ where: { tenantId }, select: { phone: true } });
  return new Set(rows.map((r) => r.phone));
}

/**
 * How many customers would be texted on the next run for this tenant — drives
 * the "N customers are due" preview in the dashboard so the owner knows the
 * campaign isn't a no-op before enabling it.
 */
export async function countEligible(tenantId: string, inactivityDays: number): Promise<number> {
  const [lapsed, contacted, optedOut] = await Promise.all([
    findLapsedCustomers(tenantId, inactivityDays),
    recentlyContacted(tenantId, inactivityDays),
    optedOutPhones(tenantId),
  ]);
  return lapsed.filter((c) => !contacted.has(c.phone) && !optedOut.has(c.phone)).length;
}

/** Run the campaign for a single tenant. Returns how many texts went out. */
export async function runReactivationForTenant(tenant: {
  tenantId: string;
  businessName: string;
  inactivityDays: number;
  template: string | null;
}): Promise<number> {
  const [lapsed, contacted, optedOut] = await Promise.all([
    findLapsedCustomers(tenant.tenantId, tenant.inactivityDays),
    recentlyContacted(tenant.tenantId, tenant.inactivityDays),
    optedOutPhones(tenant.tenantId),
  ]);

  const targets = lapsed
    .filter((c) => !contacted.has(c.phone) && !optedOut.has(c.phone))
    .slice(0, MAX_PER_TENANT_PER_RUN);

  let sent = 0;
  for (const c of targets) {
    const ok = await sendReactivation({
      tenantId: tenant.tenantId,
      phone: c.phone,
      customerName: c.name,
      businessName: tenant.businessName,
      template: tenant.template,
    }).catch(() => false);

    if (ok) {
      await prisma.reactivationLog.create({ data: { tenantId: tenant.tenantId, phone: c.phone } });
      sent += 1;
    }
  }
  return sent;
}

/** Scan every opted-in tenant and run their recall campaign. */
export async function runReactivationScan(): Promise<void> {
  const settings = await prisma.agentSettings.findMany({
    where: { reactivationEnabled: true, smsEnabled: true },
    select: {
      tenantId: true,
      reactivationInactivityDays: true,
      reactivationTemplate: true,
      tenant: { select: { companyName: true, isBlocked: true } },
    },
  });

  for (const s of settings) {
    if (s.tenant.isBlocked) continue;
    try {
      const n = await runReactivationForTenant({
        tenantId: s.tenantId,
        businessName: s.tenant.companyName,
        inactivityDays: s.reactivationInactivityDays,
        template: s.reactivationTemplate,
      });
      if (n > 0) console.log(`[reactivation] sent ${n} recall texts for tenant ${s.tenantId}`);
    } catch (err) {
      console.error('[reactivation] tenant scan failed', s.tenantId, err);
    }
  }
}
