import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import { syncAssistantForTenant } from '../services/vapi.service';

/**
 * A persistent (synced) assistant lists the providers/services in its prompt and
 * carries provider-aware tools, so any roster or policy change should re-push it.
 * Best-effort and non-blocking — no-ops for tenants on the transient flow.
 */
function kickResync(tenantId: string): void {
  void syncAssistantForTenant(tenantId).catch(() => {});
}

/**
 * Tenant-facing management of the bookable Providers and Services used by
 * multi-provider mode, plus the customer's view of the entitlement. The
 * platform operator owns whether multi-provider is ON (Tenant.multiProviderEnabled)
 * and whether the customer may toggle it (Tenant.multiProviderSelfManage); the
 * customer always controls offerProviderChoice and the provider/service roster.
 */
export const providersRouter = Router();
providersRouter.use(requireAuth);

interface ProviderDto {
  id: string;
  name: string;
  title: string | null;
  active: boolean;
  serviceIds: string[];
}
interface ServiceDto {
  id: string;
  name: string;
  durationMinutes: number;
  description: string | null;
  active: boolean;
  providerIds: string[];
}
interface ConfigDto {
  /** Operator entitlement — is multi-provider mode on for this tenant. */
  enabled: boolean;
  /** Whether the customer may flip `enabled` themselves. */
  selfManage: boolean;
  /** Customer setting: proactively offer the provider list vs first-available. */
  offerProviderChoice: boolean;
}

/** Keep only ids that actually belong to this tenant — never trust ids from the body. */
async function ownedIds(model: 'provider' | 'service', tenantId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows =
    model === 'provider'
      ? await prisma.provider.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } })
      : await prisma.service.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } });
  return rows.map((r) => r.id);
}

providersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const [providers, services, tenant, settings] = await Promise.all([
      prisma.provider.findMany({
        where: { tenantId },
        orderBy: { name: 'asc' },
        include: { services: { select: { id: true } } },
      }),
      prisma.service.findMany({
        where: { tenantId },
        orderBy: { name: 'asc' },
        include: { providers: { select: { id: true } } },
      }),
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { multiProviderEnabled: true, multiProviderSelfManage: true },
      }),
      prisma.agentSettings.findUnique({ where: { tenantId }, select: { offerProviderChoice: true } }),
    ]);

    const providerDtos: ProviderDto[] = providers.map((p) => ({
      id: p.id,
      name: p.name,
      title: p.title,
      active: p.active,
      serviceIds: p.services.map((s) => s.id),
    }));
    const serviceDtos: ServiceDto[] = services.map((s) => ({
      id: s.id,
      name: s.name,
      durationMinutes: s.durationMinutes,
      description: s.description,
      active: s.active,
      providerIds: s.providers.map((p) => p.id),
    }));
    const config: ConfigDto = {
      enabled: tenant?.multiProviderEnabled ?? false,
      selfManage: tenant?.multiProviderSelfManage ?? false,
      offerProviderChoice: settings?.offerProviderChoice ?? false,
    };
    res.json({ providers: providerDtos, services: serviceDtos, config });
  }),
);

const ConfigPatchSchema = z
  .object({ enabled: z.boolean(), offerProviderChoice: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

providersRouter.patch(
  '/config',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const patch = ConfigPatchSchema.parse(req.body);

    if (patch.enabled !== undefined) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { multiProviderSelfManage: true },
      });
      if (!tenant?.multiProviderSelfManage) {
        throw new HttpError(
          403,
          'Multi-provider mode is managed by the VoiceFront team for your account.',
          'NOT_SELF_MANAGED',
        );
      }
      await prisma.tenant.update({ where: { id: tenantId }, data: { multiProviderEnabled: patch.enabled } });
    }
    if (patch.offerProviderChoice !== undefined) {
      await prisma.agentSettings.update({
        where: { tenantId },
        data: { offerProviderChoice: patch.offerProviderChoice },
      });
    }
    kickResync(tenantId);
    res.json({ ok: true });
  }),
);

const ProviderSchema = z.object({
  name: z.string().trim().min(1, 'A name is required.').max(80),
  title: z.string().trim().max(40).optional().nullable(),
  active: z.boolean().optional(),
  serviceIds: z.array(z.string()).max(50).optional(),
});

providersRouter.post(
  '/',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const input = ProviderSchema.parse(req.body);
    const serviceIds = await ownedIds('service', tenantId, input.serviceIds ?? []);
    const created = await prisma.provider.create({
      data: {
        tenantId,
        name: input.name,
        title: input.title?.trim() || null,
        active: input.active ?? true,
        services: { connect: serviceIds.map((id) => ({ id })) },
      },
      include: { services: { select: { id: true } } },
    });
    kickResync(tenantId);
    res.status(201).json({
      provider: {
        id: created.id,
        name: created.name,
        title: created.title,
        active: created.active,
        serviceIds: created.services.map((s) => s.id),
      },
    });
  }),
);

providersRouter.patch(
  '/:id',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const input = ProviderSchema.partial().parse(req.body);
    const existing = await prisma.provider.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw new HttpError(404, 'Provider not found.', 'NOT_FOUND');

    const updated = await prisma.provider.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.title !== undefined ? { title: input.title?.trim() || null } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.serviceIds !== undefined
          ? { services: { set: (await ownedIds('service', tenantId, input.serviceIds)).map((id) => ({ id })) } }
          : {}),
      },
      include: { services: { select: { id: true } } },
    });
    kickResync(tenantId);
    res.json({
      provider: {
        id: updated.id,
        name: updated.name,
        title: updated.title,
        active: updated.active,
        serviceIds: updated.services.map((s) => s.id),
      },
    });
  }),
);

providersRouter.delete(
  '/:id',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const { count } = await prisma.provider.deleteMany({ where: { id: req.params.id, tenantId } });
    if (count === 0) throw new HttpError(404, 'Provider not found.', 'NOT_FOUND');
    kickResync(tenantId);
    res.json({ ok: true });
  }),
);

const ServiceSchema = z.object({
  name: z.string().trim().min(1, 'A name is required.').max(80),
  durationMinutes: z.coerce.number().int().min(5).max(480),
  description: z.string().trim().max(300).optional().nullable(),
  active: z.boolean().optional(),
  providerIds: z.array(z.string()).max(100).optional(),
});

providersRouter.post(
  '/services',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const input = ServiceSchema.parse(req.body);
    const providerIds = await ownedIds('provider', tenantId, input.providerIds ?? []);
    const created = await prisma.service.create({
      data: {
        tenantId,
        name: input.name,
        durationMinutes: input.durationMinutes,
        description: input.description?.trim() || null,
        active: input.active ?? true,
        providers: { connect: providerIds.map((id) => ({ id })) },
      },
      include: { providers: { select: { id: true } } },
    });
    kickResync(tenantId);
    res.status(201).json({
      service: {
        id: created.id,
        name: created.name,
        durationMinutes: created.durationMinutes,
        description: created.description,
        active: created.active,
        providerIds: created.providers.map((p) => p.id),
      },
    });
  }),
);

providersRouter.patch(
  '/services/:id',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const input = ServiceSchema.partial().parse(req.body);
    const existing = await prisma.service.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw new HttpError(404, 'Service not found.', 'NOT_FOUND');

    const updated = await prisma.service.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.providerIds !== undefined
          ? { providers: { set: (await ownedIds('provider', tenantId, input.providerIds)).map((id) => ({ id })) } }
          : {}),
      },
      include: { providers: { select: { id: true } } },
    });
    kickResync(tenantId);
    res.json({
      service: {
        id: updated.id,
        name: updated.name,
        durationMinutes: updated.durationMinutes,
        description: updated.description,
        active: updated.active,
        providerIds: updated.providers.map((p) => p.id),
      },
    });
  }),
);

providersRouter.delete(
  '/services/:id',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const { count } = await prisma.service.deleteMany({ where: { id: req.params.id, tenantId } });
    if (count === 0) throw new HttpError(404, 'Service not found.', 'NOT_FOUND');
    kickResync(tenantId);
    res.json({ ok: true });
  }),
);
