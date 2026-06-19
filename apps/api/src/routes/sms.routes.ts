import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import {
  isSmsAvailable,
  recordOptOut,
  DEFAULT_CONFIRMATION_TEMPLATE,
  DEFAULT_REMINDER_24H_TEMPLATE,
  DEFAULT_REMINDER_1H_TEMPLATE,
} from '../services/sms.service';

export const smsRouter = Router();

// ── Tenant-facing SMS settings ───────────────────────────────────────────────

smsRouter.get(
  '/settings',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const settings = await prisma.agentSettings.findUnique({
      where: { tenantId },
      select: {
        smsEnabled: true,
        smsConfirmation: true,
        smsReminder24h: true,
        smsReminder1h: true,
        smsConfirmationTemplate: true,
        smsReminder24hTemplate: true,
        smsReminder1hTemplate: true,
      },
    });
    if (!settings) throw new HttpError(409, 'Settings missing.', 'SETTINGS_MISSING');
    res.json({
      available: isSmsAvailable(),
      settings: {
        enabled: settings.smsEnabled,
        confirmation: settings.smsConfirmation,
        reminder24h: settings.smsReminder24h,
        reminder1h: settings.smsReminder1h,
        confirmationTemplate: settings.smsConfirmationTemplate ?? DEFAULT_CONFIRMATION_TEMPLATE,
        reminder24hTemplate: settings.smsReminder24hTemplate ?? DEFAULT_REMINDER_24H_TEMPLATE,
        reminder1hTemplate: settings.smsReminder1hTemplate ?? DEFAULT_REMINDER_1H_TEMPLATE,
      },
    });
  }),
);

const SmsPatchSchema = z
  .object({
    enabled: z.boolean(),
    confirmation: z.boolean(),
    reminder24h: z.boolean(),
    reminder1h: z.boolean(),
    confirmationTemplate: z.string().trim().min(10).max(320),
    reminder24hTemplate: z.string().trim().min(10).max(320),
    reminder1hTemplate: z.string().trim().min(10).max(320),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

smsRouter.patch(
  '/settings',
  requireAuth,
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const patch = SmsPatchSchema.parse(req.body);

    await prisma.agentSettings.update({
      where: { tenantId },
      data: {
        ...(patch.enabled !== undefined && { smsEnabled: patch.enabled }),
        ...(patch.confirmation !== undefined && { smsConfirmation: patch.confirmation }),
        ...(patch.reminder24h !== undefined && { smsReminder24h: patch.reminder24h }),
        ...(patch.reminder1h !== undefined && { smsReminder1h: patch.reminder1h }),
        // Store null when the tenant resets to the platform default.
        ...(patch.confirmationTemplate !== undefined && {
          smsConfirmationTemplate:
            patch.confirmationTemplate === DEFAULT_CONFIRMATION_TEMPLATE
              ? null
              : patch.confirmationTemplate,
        }),
        ...(patch.reminder24hTemplate !== undefined && {
          smsReminder24hTemplate:
            patch.reminder24hTemplate === DEFAULT_REMINDER_24H_TEMPLATE
              ? null
              : patch.reminder24hTemplate,
        }),
        ...(patch.reminder1hTemplate !== undefined && {
          smsReminder1hTemplate:
            patch.reminder1hTemplate === DEFAULT_REMINDER_1H_TEMPLATE
              ? null
              : patch.reminder1hTemplate,
        }),
      },
    });
    res.json({ ok: true });
  }),
);

// ── Twilio opt-out webhook (STOP / START replies) ────────────────────────────
// Twilio posts to this URL as application/x-www-form-urlencoded.
// Mount BEFORE express.json() middleware so the raw body is readable;
// in practice express.urlencoded() handles it automatically.

smsRouter.post(
  '/webhook/opt-out',
  asyncHandler(async (req, res) => {
    // Twilio sends: Body, From, To, AccountSid, etc.
    const body: string = (req.body?.Body as string | undefined)?.trim().toUpperCase() ?? '';
    const from: string = (req.body?.From as string | undefined) ?? '';

    if (!from) {
      res.status(200).send('<Response/>');
      return;
    }

    if (body === 'STOP' || body === 'STOPALL' || body === 'UNSUBSCRIBE' || body === 'CANCEL' || body === 'END' || body === 'QUIT') {
      // Opt out from ALL tenants that have texted this number.
      const optedOutTenants = await prisma.smsOptOut.findMany({
        where: { phone: from },
        select: { tenantId: true },
      });
      // Find any tenant appointments with this phone to cover new tenants too.
      const apptTenants = await prisma.appointment.findMany({
        where: { customerPhone: from, demoSessionId: null },
        select: { tenantId: true },
        distinct: ['tenantId'],
      });
      const tenantIds = [
        ...new Set([...optedOutTenants.map((r) => r.tenantId), ...apptTenants.map((r) => r.tenantId)]),
      ];
      await Promise.all(tenantIds.map((id) => recordOptOut(from, id)));
    } else if (body === 'START' || body === 'YES' || body === 'UNSTOP') {
      await prisma.smsOptOut.deleteMany({ where: { phone: from } });
    }

    // Twilio expects TwiML — empty response is fine (no reply message).
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response/>');
  }),
);
