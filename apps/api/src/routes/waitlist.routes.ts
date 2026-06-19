import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import { E164_REGEX, normalizePhone } from '../lib/phone';
import {
  addWaitlistEntry,
  listWaitlist,
  removeWaitlistEntry,
  setWaitlistStatus,
  toWaitlistDto,
} from '../services/waitlist.service';

export const waitlistRouter = Router();
waitlistRouter.use(requireAuth);

const ListQuerySchema = z.object({
  status: z.enum(['WAITING', 'NOTIFIED', 'CONVERTED', 'CANCELLED']).optional(),
});

waitlistRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { status } = ListQuerySchema.parse(req.query);
    const rows = await listWaitlist(auth.tenantId, status);
    res.json({ waitlist: rows.map(toWaitlistDto) });
  }),
);

const CreateSchema = z.object({
  customerName: z.string().trim().min(2).max(120),
  customerPhone: z
    .string()
    .trim()
    .transform(normalizePhone)
    .refine((v) => E164_REGEX.test(v), 'Use E.164 format, e.g. +15551234567.'),
  providerId: z.string().optional().nullable(),
  serviceId: z.string().optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
});

waitlistRouter.post(
  '/',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const input = CreateSchema.parse(req.body);
    const entry = await addWaitlistEntry({ tenantId: auth.tenantId, ...input });
    res.status(201).json({ entry: toWaitlistDto(entry) });
  }),
);

const PatchSchema = z.object({
  status: z.enum(['WAITING', 'NOTIFIED', 'CONVERTED', 'CANCELLED']),
});

waitlistRouter.patch(
  '/:id',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { status } = PatchSchema.parse(req.body);
    const entry = await setWaitlistStatus(auth.tenantId, req.params.id, status);
    res.json({ entry: toWaitlistDto(entry) });
  }),
);

waitlistRouter.delete(
  '/:id',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    await removeWaitlistEntry(auth.tenantId, req.params.id);
    res.status(204).end();
  }),
);
