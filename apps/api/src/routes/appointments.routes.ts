import { Router } from 'express';
import { z } from 'zod';
import type { Appointment } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import {
  bookAppointment,
  findFreeSlots,
  updateAppointment,
  utcToZonedParts,
} from '../services/appointment.service';
import { E164_REGEX, normalizePhone } from '../lib/phone';

export const appointmentsRouter = Router();
appointmentsRouter.use(requireAuth);

/** Tenant-facing appointment shape; sync internals stay server-side. */
interface AppointmentDto {
  id: string;
  customerName: string;
  customerPhone: string | null;
  reason: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  /** Local wall-clock parts for painting the calendar without TZ math client-side. */
  local: { date: string; time: string };
  status: string;
  source: string;
  notes: string | null;
  createdAt: string;
}

function toDto(appointment: Appointment): AppointmentDto {
  const local = utcToZonedParts(appointment.startsAt, appointment.timezone);
  return {
    id: appointment.id,
    customerName: appointment.customerName,
    customerPhone: appointment.customerPhone,
    reason: appointment.reason,
    startsAt: appointment.startsAt.toISOString(),
    endsAt: appointment.endsAt.toISOString(),
    timezone: appointment.timezone,
    local: { date: local.date, time: local.time },
    status: appointment.status,
    source: appointment.source,
    notes: appointment.notes,
    createdAt: appointment.createdAt.toISOString(),
  };
}

const ListQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
});

appointmentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { from, to } = ListQuerySchema.parse(req.query);
    // Pad one day each side so timezone offsets never clip edge appointments;
    // the client filters by the `local.date` field it renders with anyway.
    const fromDate = new Date(`${from}T00:00:00Z`);
    const toDate = new Date(`${to}T23:59:59Z`);
    fromDate.setUTCDate(fromDate.getUTCDate() - 1);
    toDate.setUTCDate(toDate.getUTCDate() + 1);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
      throw new HttpError(400, 'Invalid date range.', 'BAD_RANGE');
    }

    const appointments = await prisma.appointment.findMany({
      where: { tenantId: auth.tenantId, startsAt: { gte: fromDate, lte: toDate } },
      orderBy: { startsAt: 'asc' },
      take: 500,
    });
    res.json({ appointments: appointments.map(toDto) });
  }),
);

appointmentsRouter.get(
  '/availability',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.date);
    const settings = await prisma.agentSettings.findUnique({ where: { tenantId: auth.tenantId } });
    if (!settings) throw new HttpError(409, 'Receptionist settings are missing.', 'SETTINGS_MISSING');
    const slots = await findFreeSlots({
      tenantId: auth.tenantId,
      timezone: settings.timezone,
      businessHours: settings.businessHours,
      date,
    });
    res.json({ availability: slots });
  }),
);

const CreateSchema = z.object({
  customerName: z.string().trim().min(2).max(120),
  customerPhone: z
    .string()
    .trim()
    .transform(normalizePhone)
    .refine((v) => v === '' || E164_REGEX.test(v), 'Use E.164 format, e.g. +15551234567.')
    .optional(),
  reason: z.string().trim().max(500).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.coerce.number().int().min(10).max(240).optional(),
});

appointmentsRouter.post(
  '/',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const input = CreateSchema.parse(req.body);
    const settings = await prisma.agentSettings.findUnique({ where: { tenantId: auth.tenantId } });
    if (!settings) throw new HttpError(409, 'Receptionist settings are missing.', 'SETTINGS_MISSING');

    const appointment = await bookAppointment({
      tenantId: auth.tenantId,
      timezone: settings.timezone,
      businessHours: settings.businessHours,
      customerName: input.customerName,
      customerPhone: input.customerPhone || null,
      reason: input.reason || null,
      date: input.date,
      time: input.time,
      durationMinutes: input.durationMinutes,
      source: 'MANUAL',
    });
    res.status(201).json({ appointment: toDto(appointment) });
  }),
);

const PatchSchema = z
  .object({
    status: z.enum(['CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    durationMinutes: z.coerce.number().int().min(10).max(240),
    customerName: z.string().trim().min(2).max(120),
    customerPhone: z
      .string()
      .trim()
      .transform(normalizePhone)
      .refine((v) => v === '' || E164_REGEX.test(v), 'Use E.164 format.')
      .nullable(),
    reason: z.string().trim().max(500).nullable(),
    notes: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

appointmentsRouter.patch(
  '/:id',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const patch = PatchSchema.parse(req.body);
    const settings = await prisma.agentSettings.findUnique({ where: { tenantId: auth.tenantId } });
    if (!settings) throw new HttpError(409, 'Receptionist settings are missing.', 'SETTINGS_MISSING');
    const appointment = await updateAppointment(auth.tenantId, req.params.id, patch, settings.businessHours);
    res.json({ appointment: toDto(appointment) });
  }),
);
