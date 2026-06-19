import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import {
  getAdminEmail,
  getAdminRole,
  requireAuth,
  requireFullAdmin,
  requirePlatformAdmin,
} from '../middleware/auth';
import { hashPassword } from '../lib/passwords';
import { randomSuffix, toSlug } from '../lib/slug';
import { defaultBusinessHours } from '../domain/agent-config';
import { industryDefaults, industryPersona } from '../domain/prompt-templates';
import {
  SETTING_KEYS,
  SETTING_META,
  assertSettingKey,
  getSetting,
  maskValue,
  recordAdminAction,
  setSetting,
  unsetSetting,
} from '../services/platform-config.service';
import {
  PLATFORM_TENANT_SLUG,
  addAdmin,
  listAdmins,
  removeAdmin,
} from '../services/platform-admin.service';
import {
  DEMO_TENANT_SLUG,
  isDemoEnabled,
  setDemoEnabled,
  listRecentDemoCalls,
  getSalesConfig,
  setSalesConfig,
  getDemoNumbers,
  setDemoNumbers,
} from '../services/demo.service';
import {
  listFounderEntries,
  founderAvailability,
  blockFounderTime,
  removeFounderEntry,
  getFounderTimezone,
} from '../services/founder.service';
import {
  generateAccessCode,
  listAccessCodes,
  revokeAccessCode,
} from '../services/access-code.service';
import {
  createAssistantForTenant,
  createPhoneNumberInVapi,
  findAssistantPhoneNumber,
  listVapiPhoneNumbers,
  repointAllPhoneNumbers,
  syncAssistantForTenant,
  validateAssistant,
} from '../services/vapi.service';
import { getMonthlyUsage } from '../services/usage.service';
import {
  addNumber,
  availableCount,
  listPool,
  removeNumber,
  releaseNumberForTenant,
  toPoolEntry,
} from '../services/phone-pool.service';

/**
 * Founder control plane. Cross-tenant, gated by requirePlatformAdmin (admits
 * ADMIN + SUPPORT). Full-control actions (keys, billing, managing admins) add
 * requireFullAdmin. Every mutation is audited.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth, requirePlatformAdmin);

/** Reserved internal tenants (staff workspace + landing-page demo) are never
 * shown as customers. */
const NOT_PLATFORM_TENANT = { slug: { notIn: [PLATFORM_TENANT_SLUG, DEMO_TENANT_SLUG] } };

const THIRTY_DAYS_MS = 30 * 24 * 3600_000;

/* -------------------------------- overview -------------------------------- */

adminRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const since30d = new Date(Date.now() - THIRTY_DAYS_MS);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [tenantCount, activeTenantCount, callAgg, callsToday, bookings30d, settingRows, recentCalls] =
      await Promise.all([
        prisma.tenant.count({ where: NOT_PLATFORM_TENANT }),
        prisma.onboardingStatus.count({ where: { isActive: true } }),
        prisma.callLog.aggregate({
          where: { startedAt: { gte: since30d } },
          _count: { id: true },
          _sum: { billedCostCents: true, providerCostCents: true, durationSeconds: true },
        }),
        prisma.callLog.count({ where: { startedAt: { gte: startOfToday } } }),
        prisma.appointment.count({ where: { createdAt: { gte: since30d }, source: 'VOICE_AGENT' } }),
        Promise.all(SETTING_KEYS.map(async (key) => ({ key, resolved: await getSetting(key) }))),
        prisma.callLog.findMany({
          orderBy: { startedAt: 'desc' },
          take: 8,
          select: {
            id: true,
            startedAt: true,
            durationSeconds: true,
            status: true,
            channel: true,
            callerNumber: true,
            billedCostCents: true,
            tenant: { select: { companyName: true } },
          },
        }),
      ]);

    res.json({
      overview: {
        tenants: tenantCount,
        activeReceptionists: activeTenantCount,
        calls30d: callAgg._count.id,
        callsToday,
        minutes30d: Math.round((callAgg._sum.durationSeconds ?? 0) / 60),
        billed30dCents: callAgg._sum.billedCostCents ?? 0,
        providerCost30dCents: callAgg._sum.providerCostCents ?? 0,
        profit30dCents: (callAgg._sum.billedCostCents ?? 0) - (callAgg._sum.providerCostCents ?? 0),
        bookings30d,
        config: settingRows.map(({ key, resolved }) => ({
          key,
          configured: resolved.value !== null,
          source: resolved.source,
        })),
        recentCalls: recentCalls.map((c) => ({
          id: c.id,
          company: c.tenant.companyName,
          startedAt: c.startedAt.toISOString(),
          durationSeconds: c.durationSeconds,
          status: c.status,
          channel: c.channel,
          callerNumber: c.callerNumber,
          billedCents: c.billedCostCents,
        })),
      },
    });
  }),
);

/* -------------------------------- customers -------------------------------- */

adminRouter.get(
  '/tenants',
  asyncHandler(async (_req, res) => {
    const since30d = new Date(Date.now() - THIRTY_DAYS_MS);
    const [tenants, callGroups, upcomingGroups] = await Promise.all([
      prisma.tenant.findMany({
        where: NOT_PLATFORM_TENANT,
        orderBy: { createdAt: 'desc' },
        include: {
          onboarding: { select: { isActive: true } },
          agentSettings: { select: { inboundPhoneNumber: true, voiceProvider: true, voiceId: true } },
          users: { where: { role: 'OWNER' }, select: { email: true, fullName: true }, take: 1 },
          _count: { select: { users: true } },
        },
      }),
      prisma.callLog.groupBy({
        by: ['tenantId'],
        where: { startedAt: { gte: since30d } },
        _count: { id: true },
        _sum: { billedCostCents: true, providerCostCents: true },
      }),
      prisma.appointment.groupBy({
        by: ['tenantId'],
        where: { status: 'CONFIRMED', startsAt: { gte: new Date() } },
        _count: { id: true },
      }),
    ]);

    const callsByTenant = new Map(callGroups.map((g) => [g.tenantId, g]));
    const upcomingByTenant = new Map(upcomingGroups.map((g) => [g.tenantId, g._count.id]));

    res.json({
      tenants: tenants.map((t) => {
        const calls = callsByTenant.get(t.id);
        return {
          id: t.id,
          companyName: t.companyName,
          slug: t.slug,
          industry: t.industry,
          subscriptionStatus: t.subscriptionStatus,
          markupBps: t.markupBps,
          blocked: t.isBlocked,
          receptionistActive: t.onboarding?.isActive ?? false,
          inboundPhoneNumber: t.agentSettings?.inboundPhoneNumber ?? null,
          voice: t.agentSettings ? `${t.agentSettings.voiceProvider}/${t.agentSettings.voiceId}` : null,
          ownerEmail: t.users[0]?.email ?? null,
          ownerName: t.users[0]?.fullName ?? null,
          userCount: t._count.users,
          calls30d: calls?._count.id ?? 0,
          billed30dCents: calls?._sum.billedCostCents ?? 0,
          profit30dCents: (calls?._sum.billedCostCents ?? 0) - (calls?._sum.providerCostCents ?? 0),
          upcomingAppointments: upcomingByTenant.get(t.id) ?? 0,
          createdAt: t.createdAt.toISOString(),
        };
      }),
    });
  }),
);

adminRouter.get(
  '/tenants/:id',
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: {
        onboarding: true,
        agentSettings: true,
        users: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, email: true, fullName: true, role: true, createdAt: true },
        },
      },
    });
    if (!tenant) throw new HttpError(404, 'Workspace not found.', 'NOT_FOUND');

    const [recentCalls, upcomingAppointments, usage] = await Promise.all([
      prisma.callLog.findMany({
        where: { tenantId: tenant.id },
        orderBy: { startedAt: 'desc' },
        take: 10,
        select: {
          id: true,
          startedAt: true,
          durationSeconds: true,
          status: true,
          channel: true,
          callerNumber: true,
          billedCostCents: true,
          summary: true,
        },
      }),
      prisma.appointment.findMany({
        where: { tenantId: tenant.id, startsAt: { gte: new Date() } },
        orderBy: { startsAt: 'asc' },
        take: 10,
        select: {
          id: true,
          customerName: true,
          customerPhone: true,
          startsAt: true,
          status: true,
          source: true,
          reason: true,
        },
      }),
      getMonthlyUsage(tenant.id, tenant.monthlyMinuteLimit),
    ]);

    res.json({
      tenant: {
        id: tenant.id,
        companyName: tenant.companyName,
        slug: tenant.slug,
        industry: tenant.industry,
        subscriptionStatus: tenant.subscriptionStatus,
        markupBps: tenant.markupBps,
        monthlyMinuteLimit: tenant.monthlyMinuteLimit,
        usage,
        blocked: tenant.isBlocked,
        multiProviderEnabled: tenant.multiProviderEnabled,
        multiProviderSelfManage: tenant.multiProviderSelfManage,
        createdAt: tenant.createdAt.toISOString(),
        receptionistActive: tenant.onboarding?.isActive ?? false,
        settings: tenant.agentSettings
          ? {
              displayName: tenant.agentSettings.displayName,
              timezone: tenant.agentSettings.timezone,
              inboundPhoneNumber: tenant.agentSettings.inboundPhoneNumber,
              voiceProvider: tenant.agentSettings.voiceProvider,
              voiceId: tenant.agentSettings.voiceId,
              backgroundSound: tenant.agentSettings.backgroundSound,
              firstMessage: tenant.agentSettings.firstMessage,
              assistantId: tenant.agentSettings.assistantId,
            }
          : null,
        users: tenant.users.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() })),
        recentCalls: recentCalls.map((c) => ({ ...c, startedAt: c.startedAt.toISOString() })),
        upcomingAppointments: upcomingAppointments.map((a) => ({
          ...a,
          startsAt: a.startsAt.toISOString(),
        })),
      },
    });
  }),
);

const TenantPatchSchema = z
  .object({
    subscriptionStatus: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED']),
    receptionistActive: z.boolean(),
    markupBps: z.coerce.number().int().min(0).max(30000),
    monthlyMinuteLimit: z.coerce.number().int().min(0).max(100000),
    blocked: z.boolean(),
    /** Operator entitlement: turn multi-provider booking on/off for this customer. */
    multiProviderEnabled: z.boolean(),
    /** Whether the customer may flip multiProviderEnabled from their own dashboard. */
    multiProviderSelfManage: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

adminRouter.patch(
  '/tenants/:id',
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const patch = TenantPatchSchema.parse(req.body);

    // Billing, suspension, and the multi-provider entitlement are full-admin
    // actions; SUPPORT may only pause/activate.
    const touchesRestricted =
      patch.subscriptionStatus !== undefined ||
      patch.markupBps !== undefined ||
      patch.monthlyMinuteLimit !== undefined ||
      patch.blocked !== undefined ||
      patch.multiProviderEnabled !== undefined ||
      patch.multiProviderSelfManage !== undefined;
    if (touchesRestricted && getAdminRole(req) !== 'ADMIN') {
      throw new HttpError(
        403,
        'Changing billing, subscription, or blocking needs full admin access.',
        'NEEDS_FULL_ADMIN',
      );
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      select: { id: true, companyName: true },
    });
    if (!tenant) throw new HttpError(404, 'Workspace not found.', 'NOT_FOUND');

    if (
      patch.subscriptionStatus !== undefined ||
      patch.markupBps !== undefined ||
      patch.monthlyMinuteLimit !== undefined ||
      patch.blocked !== undefined ||
      patch.multiProviderEnabled !== undefined ||
      patch.multiProviderSelfManage !== undefined
    ) {
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          ...(patch.subscriptionStatus !== undefined ? { subscriptionStatus: patch.subscriptionStatus } : {}),
          ...(patch.markupBps !== undefined ? { markupBps: patch.markupBps } : {}),
          ...(patch.monthlyMinuteLimit !== undefined ? { monthlyMinuteLimit: patch.monthlyMinuteLimit } : {}),
          ...(patch.blocked !== undefined ? { isBlocked: patch.blocked } : {}),
          ...(patch.multiProviderEnabled !== undefined ? { multiProviderEnabled: patch.multiProviderEnabled } : {}),
          ...(patch.multiProviderSelfManage !== undefined
            ? { multiProviderSelfManage: patch.multiProviderSelfManage }
            : {}),
        },
      });
    }
    // Blocking also forces the receptionist offline so calls stop immediately.
    const forceInactive = patch.blocked === true;
    if (patch.receptionistActive !== undefined || forceInactive) {
      await prisma.onboardingStatus.update({
        where: { tenantId: tenant.id },
        data: { isActive: forceInactive ? false : patch.receptionistActive },
      });
    }

    // Toggling the multi-provider entitlement changes the assistant's tools and
    // prompt; re-push it so a persistent (synced) assistant reflects the new mode.
    if (patch.multiProviderEnabled !== undefined) {
      void syncAssistantForTenant(tenant.id).catch(() => {});
    }

    await recordAdminAction(adminEmail, 'tenant.update', tenant.companyName, patch);
    res.json({ ok: true });
  }),
);

/* --------------------------- assistant assignment -------------------------- */
/* Assigning a Vapi assistant to a customer is a full-admin action. Setting an  */
/* ID validates it against Vapi first, then pushes the customer's current       */
/* settings up so the assistant matches immediately.                            */

const AssignAssistantSchema = z.object({
  // Empty string clears the assignment; a value is validated against Vapi.
  assistantId: z.string().trim().max(100),
});

adminRouter.patch(
  '/tenants/:id/assistant',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const { assistantId } = AssignAssistantSchema.parse(req.body);

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      select: { id: true, companyName: true, agentSettings: { select: { id: true } } },
    });
    if (!tenant) throw new HttpError(404, 'Workspace not found.', 'NOT_FOUND');
    if (!tenant.agentSettings) {
      throw new HttpError(409, 'This workspace has no receptionist settings yet.', 'SETTINGS_MISSING');
    }

    if (assistantId.length === 0) {
      // Unassign — the workspace falls back to the transient-assistant flow.
      await prisma.agentSettings.update({
        where: { tenantId: tenant.id },
        data: { assistantId: null },
      });
      await recordAdminAction(adminEmail, 'assistant.unassign', tenant.companyName, {});
      return res.json({ assistantId: null, assistantName: null, synced: false });
    }

    // Confirm the assistant is real before storing it (clear error otherwise).
    const assistant = await validateAssistant(assistantId);

    await prisma.agentSettings.update({
      where: { tenantId: tenant.id },
      data: { assistantId },
    });

    // Pull the phone number Vapi has attached to this assistant and store it,
    // so the customer's portal shows their number without anyone typing it.
    let phoneNumber: string | null = null;
    let phoneNote: string | null = null;
    const foundNumber = await findAssistantPhoneNumber(assistantId);
    if (foundNumber) {
      try {
        await prisma.agentSettings.update({
          where: { tenantId: tenant.id },
          data: { inboundPhoneNumber: foundNumber },
        });
        phoneNumber = foundNumber;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          phoneNote = `Vapi has ${foundNumber} on this assistant, but it’s already assigned to another customer here.`;
        } else {
          throw err;
        }
      }
    } else {
      phoneNote =
        'No phone number is attached to this assistant in Vapi yet. Attach one to the assistant in Vapi, then assign again to pull it in.';
    }

    // Push current settings so the assistant immediately matches the workspace.
    const sync = await syncAssistantForTenant(tenant.id);

    await recordAdminAction(adminEmail, 'assistant.assign', tenant.companyName, {
      assistantId,
      assistantName: assistant.name ?? null,
      synced: sync.synced,
      phoneNumber,
    });
    return res.json({
      assistantId,
      assistantName: assistant.name ?? null,
      synced: sync.synced,
      syncNote: sync.reason ?? null,
      phoneNumber,
      phoneNote,
    });
  }),
);

/* Auto-provision a fresh dedicated Vapi assistant from the workspace's current
 * settings (no manual cloning). No-op if one is already assigned.             */
adminRouter.post(
  '/tenants/:id/assistant/create',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      select: { id: true, companyName: true, agentSettings: { select: { assistantId: true } } },
    });
    if (!tenant) throw new HttpError(404, 'Workspace not found.', 'NOT_FOUND');
    if (tenant.agentSettings?.assistantId) {
      return res.json({ assistantId: tenant.agentSettings.assistantId, created: false });
    }

    const assistantId = await createAssistantForTenant(tenant.id);
    await recordAdminAction(adminEmail, 'assistant.create', tenant.companyName, { assistantId });
    return res.json({ assistantId, created: true });
  }),
);

/* Re-push the workspace's current settings to its persistent Vapi assistant —
 * useful after a template change so existing customers pick it up.           */
adminRouter.post(
  '/tenants/:id/assistant/sync',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      select: { id: true, companyName: true, agentSettings: { select: { assistantId: true } } },
    });
    if (!tenant) throw new HttpError(404, 'Workspace not found.', 'NOT_FOUND');
    if (!tenant.agentSettings?.assistantId) {
      // Transient workspaces rebuild on every call — nothing to push.
      return res.json({ synced: false, reason: 'This workspace has no dedicated assistant (transient flow).' });
    }
    const result = await syncAssistantForTenant(tenant.id);
    await recordAdminAction(adminEmail, 'assistant.sync', tenant.companyName, { synced: result.synced });
    return res.json(result);
  }),
);

adminRouter.post(
  '/tenants/:id/users/:userId/reset-password',
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const user = await prisma.user.findFirst({
      where: { id: req.params.userId, tenantId: req.params.id },
      select: { id: true, email: true, tenant: { select: { companyName: true } } },
    });
    if (!user) throw new HttpError(404, 'User not found in that workspace.', 'NOT_FOUND');

    // Readable one-time password; the user should change it after signing in.
    const tempPassword = `Reset-${randomBytes(6).toString('base64url')}`;
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(tempPassword) },
    });

    await recordAdminAction(adminEmail, 'user.reset_password', user.email, {
      company: user.tenant.companyName,
    });
    // Returned exactly once; never stored or logged in plaintext.
    res.json({ tempPassword, email: user.email });
  }),
);

/* ----------------------------- create customer ----------------------------- */
/* Spin up a whole workspace (tenant + owner login + settings). Full-admin.    */

const CreateTenantSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name is too short').max(80),
  industry: z.enum(['CLINIC', 'CONSTRUCTION']),
  ownerName: z.string().trim().min(2, 'Please enter the owner’s name').max(80),
  ownerEmail: z.string().trim().toLowerCase().email('Please enter a valid email'),
});

adminRouter.post(
  '/tenants',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const body = CreateTenantSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: body.ownerEmail } });
    if (existing) throw new HttpError(409, 'An account with this email already exists.', 'EMAIL_TAKEN');

    // One-time owner password for the founder to hand off.
    const tempPassword = `Welcome-${randomBytes(6).toString('base64url')}`;
    const passwordHash = await hashPassword(tempPassword);
    const persona = industryPersona(body.industry);
    const defaults = industryDefaults(body.industry, {
      companyName: body.companyName,
      personaName: persona.personaName,
    });

    // Tenant + owner + onboarding + settings are one atomic unit. Retry on slug
    // collisions with a random suffix (mirrors self-serve registration).
    const baseSlug = toSlug(body.companyName);
    let created: { tenantId: string } | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSuffix()}`;
      try {
        const tenantId = await prisma.$transaction(async (tx) => {
          const tenant = await tx.tenant.create({
            data: { companyName: body.companyName, industry: body.industry, slug },
          });
          await tx.user.create({
            data: {
              tenantId: tenant.id,
              email: body.ownerEmail,
              fullName: body.ownerName,
              passwordHash,
              role: 'OWNER',
            },
          });
          await tx.onboardingStatus.create({ data: { tenantId: tenant.id } });
          await tx.agentSettings.create({
            data: {
              tenantId: tenant.id,
              displayName: persona.personaName,
              voiceId: persona.voiceId,
              systemPrompt: defaults.systemPrompt,
              firstMessage: defaults.firstMessage,
              voicemailGreeting: defaults.voicemailGreeting,
              businessHours: defaultBusinessHours() as unknown as Prisma.InputJsonValue,
              forwardingNumbers: [] as unknown as Prisma.InputJsonValue,
            },
          });
          return tenant.id;
        });
        created = { tenantId };
      } catch (err) {
        lastError = err;
        const code = (err as { code?: unknown })?.code;
        const target = (err as { meta?: { target?: unknown } })?.meta?.target;
        const slugCollision = code === 'P2002' && Array.isArray(target) && target.includes('slug');
        if (!slugCollision) throw err;
      }
    }
    if (!created) {
      throw lastError instanceof Error
        ? lastError
        : new HttpError(500, 'Could not create the workspace. Please try again.', 'INTERNAL');
    }

    await recordAdminAction(adminEmail, 'tenant.create', body.companyName, { ownerEmail: body.ownerEmail });
    res.status(201).json({ tenantId: created.tenantId, email: body.ownerEmail, tempPassword });
  }),
);

adminRouter.delete(
  '/tenants/:id',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      select: { id: true, companyName: true, slug: true },
    });
    if (!tenant) throw new HttpError(404, 'Workspace not found.', 'NOT_FOUND');
    if (tenant.slug === PLATFORM_TENANT_SLUG) {
      throw new HttpError(403, 'The platform workspace cannot be deleted.', 'FORBIDDEN');
    }
    // Return any pooled number to inventory before the cascade removes the
    // tenant (the pool link is a plain column, not an FK, so it won't cascade).
    await releaseNumberForTenant(tenant.id);
    // Cascades to users, onboarding, settings, call logs, and appointments.
    await prisma.tenant.delete({ where: { id: tenant.id } });
    await recordAdminAction(adminEmail, 'tenant.delete', tenant.companyName, {});
    res.json({ ok: true });
  }),
);

/* -------------------------- invite user to workspace ----------------------- */
/* Adds a login to a customer workspace and returns a one-time password.       */

const InviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('Please enter a valid email'),
  fullName: z.string().trim().min(2, 'Please enter a name').max(80),
  role: z.enum(['OWNER', 'MANAGER', 'AGENT']),
});

adminRouter.post(
  '/tenants/:id/users',
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const body = InviteUserSchema.parse(req.body);

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      select: { id: true, companyName: true, slug: true },
    });
    if (!tenant) throw new HttpError(404, 'Workspace not found.', 'NOT_FOUND');
    if (tenant.slug === PLATFORM_TENANT_SLUG) {
      throw new HttpError(403, 'Use the Team page to manage platform staff.', 'FORBIDDEN');
    }
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw new HttpError(409, 'An account with this email already exists.', 'EMAIL_TAKEN');

    const tempPassword = `Welcome-${randomBytes(6).toString('base64url')}`;
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: body.email,
        fullName: body.fullName,
        passwordHash: await hashPassword(tempPassword),
        role: body.role,
      },
    });

    await recordAdminAction(adminEmail, 'user.invite', body.email, {
      company: tenant.companyName,
      role: body.role,
    });
    res.status(201).json({ email: body.email, role: body.role, tempPassword });
  }),
);

/* --------------------------------- settings -------------------------------- */
/* API keys & config are full-admin only — SUPPORT operators never see them.   */

adminRouter.get(
  '/settings',
  requireFullAdmin,
  asyncHandler(async (_req, res) => {
    const settings = await Promise.all(
      SETTING_KEYS.map(async (key) => {
        const meta = SETTING_META[key];
        const resolved = await getSetting(key);
        return {
          key,
          label: meta.label,
          description: meta.description,
          secret: meta.secret,
          placeholder: meta.placeholder,
          source: resolved.source,
          preview: resolved.value === null ? null : meta.secret ? '••••••••' : maskValue(resolved.value),
        };
      }),
    );
    res.json({ settings });
  }),
);

adminRouter.patch(
  '/settings/:key',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const key = assertSettingKey(req.params.key);
    const { value } = z.object({ value: z.string().min(1).max(2000) }).parse(req.body);
    await setSetting(key, value, adminEmail);
    await recordAdminAction(adminEmail, 'config.set', key, {});
    res.json({ ok: true });
  }),
);

adminRouter.delete(
  '/settings/:key',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const key = assertSettingKey(req.params.key);
    await unsetSetting(key);
    await recordAdminAction(adminEmail, 'config.unset', key, {});
    res.json({ ok: true });
  }),
);

/* Re-point every Vapi number's Server URL at this server (PUBLIC_API_URL) —
 * one click to migrate numbers off an old tunnel onto the cloud webhook.      */
adminRouter.post(
  '/migrate-webhooks',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const result = await repointAllPhoneNumbers();
    await recordAdminAction(adminEmail, 'webhooks.repoint', result.serverUrl, {
      updated: result.updated,
      failed: result.failed,
    });
    res.json(result);
  }),
);

/* ----------------------- landing-page demo on/off ------------------------- */

adminRouter.get(
  '/demo',
  requireFullAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ enabled: await isDemoEnabled() });
  }),
);

adminRouter.patch(
  '/demo',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await setDemoEnabled(enabled, adminEmail);
    await recordAdminAction(adminEmail, enabled ? 'demo.enable' : 'demo.disable', 'landing demo', {});
    res.json({ enabled });
  }),
);

/* Sales-agent identity (Ava's name, founder's name) the demo agent uses. */
adminRouter.get(
  '/demo/sales-config',
  requireFullAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await getSalesConfig());
  }),
);

adminRouter.patch(
  '/demo/sales-config',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const body = z
      .object({
        agentName: z.string().trim().min(1).max(40).optional(),
        founderName: z.string().trim().min(1).max(60).optional(),
        showCalendar: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    await setSalesConfig(body, adminEmail);
    await recordAdminAction(adminEmail, 'demo.salesConfig', 'sales agent', body);
    res.json(await getSalesConfig());
  }),
);

/* Recent demo calls (transcripts + recordings) for founder review. */
adminRouter.get(
  '/demo/calls',
  requireFullAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ calls: await listRecentDemoCalls(50) });
  }),
);

/* Outbound caller-ID numbers for the demo (US + CA), chosen from Vapi. */
adminRouter.get(
  '/demo/numbers',
  requireFullAdmin,
  asyncHandler(async (_req, res) => {
    const [available, assigned] = await Promise.all([listVapiPhoneNumbers(), getDemoNumbers()]);
    res.json({ available, assigned });
  }),
);

const DemoNumberSchema = z.object({ id: z.string().min(1), number: z.string().min(3) }).nullable();
adminRouter.patch(
  '/demo/numbers',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const body = z
      .object({ us: DemoNumberSchema.optional(), ca: DemoNumberSchema.optional() })
      .parse(req.body ?? {});
    const assigned = await setDemoNumbers(body, adminEmail);
    await recordAdminAction(adminEmail, 'demo.numbers', 'demo caller-id', body);
    res.json({ assigned });
  }),
);

/* ------------------------- founder planning calendar ------------------------ */
/* The founder's own calendar: they block busy times so the sales agent never   */
/* double-books them when she sets up a planning call.                          */

adminRouter.get(
  '/founder/calendar',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const { from, to } = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(req.query);
    res.json({ entries: await listFounderEntries(from, to), timezone: await getFounderTimezone() });
  }),
);

adminRouter.get(
  '/founder/availability',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.date);
    res.json({ availability: await founderAvailability(date) });
  }),
);

adminRouter.post(
  '/founder/block',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const body = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        durationMinutes: z.coerce.number().int().min(10).max(480).optional(),
        label: z.string().trim().max(120).optional(),
      })
      .parse(req.body ?? {});
    const entry = await blockFounderTime(body);
    await recordAdminAction(adminEmail, 'founder.block', 'founder calendar', body);
    res.status(201).json({ entry });
  }),
);

adminRouter.delete(
  '/founder/calendar/:id',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    await removeFounderEntry(req.params.id);
    await recordAdminAction(adminEmail, 'founder.unblock', req.params.id, {});
    res.json({ ok: true });
  }),
);

/* ------------------------------- access codes ------------------------------- */
/* One-time signup invitations the founder issues after vetting a prospect.     */

adminRouter.get(
  '/access-codes',
  requireFullAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ codes: await listAccessCodes() });
  }),
);

adminRouter.post(
  '/access-codes',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const body = z
      .object({
        label: z.string().trim().max(120).optional(),
        email: z.string().trim().toLowerCase().email().max(120).optional().or(z.literal('')),
      })
      .parse(req.body ?? {});
    const code = await generateAccessCode({
      label: body.label,
      email: body.email || null,
      createdBy: adminEmail,
    });
    await recordAdminAction(adminEmail, 'accessCode.create', code.code, {
      label: code.label,
      email: code.email,
    });
    res.status(201).json({ code });
  }),
);

adminRouter.delete(
  '/access-codes/:id',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    await revokeAccessCode(req.params.id);
    await recordAdminAction(adminEmail, 'accessCode.revoke', req.params.id, {});
    res.json({ ok: true });
  }),
);

/* ------------------------------- team / admins ------------------------------ */
/* Managing operators is full-admin only.                                       */

adminRouter.get(
  '/team',
  requireFullAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ admins: await listAdmins() });
  }),
);

const AddAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email('Please enter a valid email'),
  role: z.enum(['ADMIN', 'SUPPORT']),
});

adminRouter.post(
  '/team',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const { email, role } = AddAdminSchema.parse(req.body);
    const result = await addAdmin(email, role, adminEmail);
    await recordAdminAction(adminEmail, 'admin.grant', email, {
      role,
      created_login: !result.promoted,
    });
    // tempPassword (when present) is returned exactly once; never stored plaintext.
    res.status(201).json(result);
  }),
);

adminRouter.delete(
  '/team/:email',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const target = req.params.email;
    if (target.toLowerCase() === adminEmail.toLowerCase()) {
      throw new HttpError(400, 'You cannot remove your own admin access.', 'CANNOT_REMOVE_SELF');
    }
    await removeAdmin(target);
    await recordAdminAction(adminEmail, 'admin.revoke', target, {});
    res.json({ ok: true });
  }),
);

/* ----------------------------------- audit ---------------------------------- */

adminRouter.get(
  '/audit',
  asyncHandler(async (_req, res) => {
    const entries = await prisma.adminAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({
      entries: entries.map((e) => ({
        id: e.id,
        adminEmail: e.adminEmail,
        action: e.action,
        target: e.target,
        detail: e.detail,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  }),
);

/* ------------------------------ phone number pool --------------------------- */
/* Shared inventory of pre-provisioned Vapi numbers. Customers auto-claim one   */
/* on activation. Adding/removing is a full-admin action.                       */

adminRouter.get(
  '/numbers',
  asyncHandler(async (_req, res) => {
    const [numbers, available] = await Promise.all([listPool(), availableCount()]);
    // Map assigned tenant ids to company names so the UI reads naturally.
    const tenantIds = numbers.map((n) => n.assignedTenantId).filter((id): id is string => Boolean(id));
    const tenants = tenantIds.length
      ? await prisma.tenant.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, companyName: true },
        })
      : [];
    const nameById = new Map(tenants.map((t) => [t.id, t.companyName]));
    res.json({
      available,
      numbers: numbers.map((n) => ({
        ...toPoolEntry(n),
        assignedCompany: n.assignedTenantId ? (nameById.get(n.assignedTenantId) ?? null) : null,
      })),
    });
  }),
);

const AddNumberSchema = z.object({
  number: z.string().trim().min(8).max(20),
  country: z.string().trim().length(2).optional(),
  vapiPhoneId: z.string().trim().max(100).optional(),
});

adminRouter.post(
  '/numbers',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const body = AddNumberSchema.parse(req.body);
    const created = await addNumber(body);
    await recordAdminAction(adminEmail, 'number.add', created.number, {});
    res.status(201).json({ number: toPoolEntry(created) });
  }),
);

adminRouter.delete(
  '/numbers/:id',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    await removeNumber(req.params.id);
    await recordAdminAction(adminEmail, 'number.remove', req.params.id, {});
    res.json({ ok: true });
  }),
);

const CreateNumberSchema = z.object({
  // US area code (3 digits). Optional — Vapi picks any available number when omitted.
  areaCode: z.string().trim().regex(/^\d{3}$/, 'Area code must be 3 digits.').optional(),
});

adminRouter.post(
  '/numbers/create',
  requireFullAdmin,
  asyncHandler(async (req, res) => {
    const adminEmail = getAdminEmail(req);
    const body = CreateNumberSchema.parse(req.body);

    // Create in Vapi with the webhook URL + secret auto-configured. Free Vapi
    // numbers are US-only, so the pool entry is always US.
    const created = await createPhoneNumberInVapi({ areaCode: body.areaCode });

    // Auto-add to the pool with the Vapi phone ID for future reference.
    const pooled = await addNumber({
      number: created.number,
      country: 'US',
      vapiPhoneId: created.id,
    });

    await recordAdminAction(adminEmail, 'number.create', created.number, { vapiPhoneId: created.id });
    res.status(201).json({ number: toPoolEntry(pooled) });
  }),
);
