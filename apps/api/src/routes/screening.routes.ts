import { Router } from 'express';
import { z } from 'zod';
import type { BlockedCaller } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import { isE164, normalizePhone } from '../lib/phone';

/**
 * Spam / call-screening management. The actual enforcement happens in the
 * inbound webhook (services/screening.service.ts); these routes just let a
 * tenant curate their own block list and see what was screened out. The
 * anonymous-caller toggle lives on AgentSettings (agent.routes.ts), not here.
 */
export const screeningRouter = Router();
screeningRouter.use(requireAuth);

interface BlockedCallerDto {
  id: string;
  phone: string;
  reason: string | null;
  createdAt: string;
}

function toDto(b: BlockedCaller): BlockedCallerDto {
  return { id: b.id, phone: b.phone, reason: b.reason, createdAt: b.createdAt.toISOString() };
}

screeningRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [blocked, screenedLast30Days, recent] = await Promise.all([
      prisma.blockedCaller.findMany({ where: { tenantId: auth.tenantId }, orderBy: { createdAt: 'desc' } }),
      prisma.screenedCallLog.count({ where: { tenantId: auth.tenantId, createdAt: { gte: since } } }),
      prisma.screenedCallLog.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);
    res.json({
      blocked: blocked.map(toDto),
      screenedLast30Days,
      recent: recent.map((r) => ({
        callerNumber: r.callerNumber,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  }),
);

const BlockSchema = z.object({
  phone: z
    .string()
    .trim()
    .min(1, 'Enter a phone number to block.')
    .transform(normalizePhone)
    .refine(isE164, 'Use a valid phone number, e.g. +15551234567.'),
  reason: z.string().trim().max(200).optional(),
});

screeningRouter.post(
  '/block',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const body = BlockSchema.parse(req.body);

    // Never let a tenant block their own receptionist's number — that would
    // silently refuse every legitimate caller. The single most dangerous
    // false-positive, so we guard it explicitly.
    const settings = await prisma.agentSettings.findUnique({
      where: { tenantId: auth.tenantId },
      select: { inboundPhoneNumber: true },
    });
    if (settings?.inboundPhoneNumber && settings.inboundPhoneNumber === body.phone) {
      throw new HttpError(
        400,
        "That's your receptionist's own number — blocking it would stop all your calls.",
        'CANNOT_BLOCK_OWN',
      );
    }

    const created = await prisma.blockedCaller.upsert({
      where: { tenantId_phone: { tenantId: auth.tenantId, phone: body.phone } },
      create: {
        tenantId: auth.tenantId,
        phone: body.phone,
        reason: body.reason ?? null,
        createdBy: auth.userId,
      },
      update: { reason: body.reason ?? null },
    });
    res.status(201).json({ blocked: toDto(created) });
  }),
);

screeningRouter.delete(
  '/block/:id',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const existing = await prisma.blockedCaller.findFirst({
      where: { id: req.params.id, tenantId: auth.tenantId },
    });
    if (!existing) throw new HttpError(404, 'That number is not on your block list.', 'NOT_FOUND');
    await prisma.blockedCaller.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  }),
);
