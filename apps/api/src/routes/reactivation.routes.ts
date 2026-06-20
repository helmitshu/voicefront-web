import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import { isSmsAvailable, DEFAULT_REACTIVATION_TEMPLATE } from '../services/sms.service';
import { countEligible } from '../services/reactivation.service';

export const reactivationRouter = Router();
reactivationRouter.use(requireAuth);

reactivationRouter.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const settings = await prisma.agentSettings.findUnique({
      where: { tenantId },
      select: {
        reactivationEnabled: true,
        reactivationInactivityDays: true,
        reactivationTemplate: true,
      },
    });
    if (!settings) throw new HttpError(409, 'Settings missing.', 'SETTINGS_MISSING');

    // How many customers would be texted right now, so the owner can see the
    // campaign isn't a no-op before turning it on.
    const eligibleCount = await countEligible(tenantId, settings.reactivationInactivityDays);

    res.json({
      // Reactivation rides on the SMS pipeline — surface the same availability
      // flag so the UI can explain why it's inert without Twilio.
      available: isSmsAvailable(),
      eligibleCount,
      settings: {
        enabled: settings.reactivationEnabled,
        inactivityDays: settings.reactivationInactivityDays,
        template: settings.reactivationTemplate ?? DEFAULT_REACTIVATION_TEMPLATE,
      },
    });
  }),
);

const PatchSchema = z
  .object({
    enabled: z.boolean(),
    inactivityDays: z.coerce.number().int().min(30).max(730),
    template: z.string().trim().min(10).max(320),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

reactivationRouter.patch(
  '/settings',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const patch = PatchSchema.parse(req.body);
    await prisma.agentSettings.update({
      where: { tenantId },
      data: {
        ...(patch.enabled !== undefined && { reactivationEnabled: patch.enabled }),
        ...(patch.inactivityDays !== undefined && { reactivationInactivityDays: patch.inactivityDays }),
        ...(patch.template !== undefined && {
          reactivationTemplate:
            patch.template === DEFAULT_REACTIVATION_TEMPLATE ? null : patch.template,
        }),
      },
    });
    res.json({ ok: true });
  }),
);
