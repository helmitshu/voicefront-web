import { randomBytes } from 'node:crypto';
import type { PlatformRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { hashPassword } from '../lib/passwords';
import { HttpError } from '../lib/http';
import { platformAdminEmails } from '../config/env';

/**
 * Platform-operator access. Two sources, resolved fresh on every request:
 *   1. Bootstrap superadmins in PLATFORM_ADMIN_EMAILS (env) — always ADMIN,
 *      never stored in the DB, never removable via the UI. This is the
 *      founder's lock-out-proof key.
 *   2. Granted operators in the PlatformAdmin table — added/removed from the
 *      admin panel, each with an ADMIN or SUPPORT role.
 */

/**
 * Reserved tenant that owns staff-only logins. Operators added by email (who
 * don't already have an account) get a User here so they can authenticate.
 * Hidden from the customers list and platform metrics.
 */
export const PLATFORM_TENANT_SLUG = '__platform';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isBootstrapAdmin(email: string): boolean {
  return platformAdminEmails.has(normalizeEmail(email));
}

/** The effective platform role for an email, or null if not an operator. */
export async function resolvePlatformRole(email: string): Promise<PlatformRole | null> {
  if (isBootstrapAdmin(email)) return 'ADMIN';
  const granted = await prisma.platformAdmin.findUnique({
    where: { email: normalizeEmail(email) },
    select: { role: true },
  });
  return granted?.role ?? null;
}

export interface AdminListEntry {
  email: string;
  role: PlatformRole;
  /** 'bootstrap' = from env (the founder), 'granted' = added via the panel. */
  source: 'bootstrap' | 'granted';
  createdBy: string | null;
  createdAt: string | null;
  /** Bootstrap admins can't be revoked from the UI. */
  removable: boolean;
  /** Whether a login (User row) exists for this email yet. */
  hasLogin: boolean;
}

export async function listAdmins(): Promise<AdminListEntry[]> {
  const bootstrap = [...platformAdminEmails];
  const granted = await prisma.platformAdmin.findMany({ orderBy: { createdAt: 'desc' } });

  // Which of these emails can actually log in?
  const allEmails = [...new Set([...bootstrap, ...granted.map((g) => g.email)])];
  const users = await prisma.user.findMany({
    where: { email: { in: allEmails } },
    select: { email: true },
  });
  const withLogin = new Set(users.map((u) => u.email));

  const bootstrapEntries: AdminListEntry[] = bootstrap.map((email) => ({
    email,
    role: 'ADMIN',
    source: 'bootstrap',
    createdBy: null,
    createdAt: null,
    removable: false,
    hasLogin: withLogin.has(email),
  }));

  const grantedEntries: AdminListEntry[] = granted
    // A bootstrap email always wins; don't list it twice.
    .filter((g) => !platformAdminEmails.has(g.email))
    .map((g) => ({
      email: g.email,
      role: g.role,
      source: 'granted',
      createdBy: g.createdBy,
      createdAt: g.createdAt.toISOString(),
      removable: true,
      hasLogin: withLogin.has(g.email),
    }));

  return [...bootstrapEntries, ...grantedEntries];
}

/** Upserts the reserved staff tenant and returns its id. */
async function getOrCreatePlatformTenant(): Promise<string> {
  const tenant = await prisma.tenant.upsert({
    where: { slug: PLATFORM_TENANT_SLUG },
    update: {},
    create: {
      slug: PLATFORM_TENANT_SLUG,
      companyName: 'VoiceFront Platform',
      industry: 'CLINIC',
      subscriptionStatus: 'ACTIVE',
    },
    select: { id: true },
  });
  // Staff operate in /admin, not a tenant dashboard. Mark onboarding complete
  // so the web app's onboarding gate doesn't trap staff on /onboarding.
  await prisma.onboardingStatus.upsert({
    where: { tenantId: tenant.id },
    update: { hasConfiguredProfile: true, hasConfiguredPrompt: true, hasTestedVoice: true, isActive: true },
    create: {
      tenantId: tenant.id,
      hasConfiguredProfile: true,
      hasConfiguredPrompt: true,
      hasTestedVoice: true,
      isActive: true,
      completedAt: new Date(),
    },
  });
  return tenant.id;
}

export interface AddAdminResult {
  email: string;
  role: PlatformRole;
  /** Set only when a brand-new staff login was created. Shown once. */
  tempPassword: string | null;
  /** True when an existing account was promoted (no new login made). */
  promoted: boolean;
}

/**
 * Grant admin access to an email at the given role.
 *  - Existing account → promote in place (no password change).
 *  - New email → create a staff login under the platform tenant and return a
 *    one-time temporary password to hand off.
 */
export async function addAdmin(
  rawEmail: string,
  role: PlatformRole,
  grantedBy: string,
): Promise<AddAdminResult> {
  const email = normalizeEmail(rawEmail);

  if (isBootstrapAdmin(email)) {
    throw new HttpError(
      409,
      'That email is already a permanent admin (set in the server config).',
      'ALREADY_BOOTSTRAP_ADMIN',
    );
  }

  await prisma.platformAdmin.upsert({
    where: { email },
    update: { role },
    create: { email, role, createdBy: grantedBy },
  });

  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser) {
    return { email, role, tempPassword: null, promoted: true };
  }

  // No login yet — create a staff account so they can actually sign in.
  const tempPassword = `Welcome-${randomBytes(6).toString('base64url')}`;
  const tenantId = await getOrCreatePlatformTenant();
  const fullName = email.split('@')[0] || 'Operator';
  await prisma.user.create({
    data: {
      tenantId,
      email,
      fullName,
      passwordHash: await hashPassword(tempPassword),
      // Least-privileged tenant role; platform staff operate via /admin, not
      // the (unused) platform tenant's dashboard.
      role: 'AGENT',
    },
  });

  return { email, role, tempPassword, promoted: false };
}

/**
 * Revoke a granted operator. Bootstrap admins can't be removed here. The staff
 * login (if any) is left intact but loses all admin access immediately — the
 * role is re-resolved from scratch on their next request.
 */
export async function removeAdmin(rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  if (isBootstrapAdmin(email)) {
    throw new HttpError(
      403,
      'This is a permanent admin set in the server config and cannot be removed here.',
      'CANNOT_REMOVE_BOOTSTRAP',
    );
  }
  const existing = await prisma.platformAdmin.findUnique({ where: { email }, select: { email: true } });
  if (!existing) {
    throw new HttpError(404, 'That operator was not found.', 'NOT_FOUND');
  }
  await prisma.platformAdmin.delete({ where: { email } });
}
