import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/http';
import { signMediaToken } from '../lib/jwt';
import { getAuth, requireAuth } from '../middleware/auth';
import {
  getCallForTenant,
  getCallStats,
  listCalls,
  toCallDetailDto,
  type CallDetailDto,
} from '../services/calllog.service';
import { getMonthlyUsage } from '../services/usage.service';

export const callsRouter = Router();
callsRouter.use(requireAuth);

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  sinceDays: z.coerce.number().int().min(1).max(365).optional(),
  // Validated again in the service against the enum allow-lists.
  outcome: z.string().trim().max(40).optional(),
  urgency: z.string().trim().max(40).optional(),
  leadQuality: z.string().trim().max(40).optional(),
});

callsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const query = ListQuerySchema.parse(req.query);
    const result = await listCalls({ tenantId: auth.tenantId, ...query });
    res.json(result);
  }),
);

callsRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const [stats, tenant] = await Promise.all([
      getCallStats(auth.tenantId),
      prisma.tenant.findUnique({
        where: { id: auth.tenantId },
        select: { monthlyMinuteLimit: true },
      }),
    ]);
    const usage = await getMonthlyUsage(auth.tenantId, tenant?.monthlyMinuteLimit ?? 500);
    res.json({ stats, usage });
  }),
);

callsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const log = await getCallForTenant(auth.tenantId, req.params.id);
    const call: CallDetailDto = toCallDetailDto(log);
    // The raw recording URL stays server-side; the client gets a short-lived
    // token it can append to the masked media route for <audio> streaming.
    const mediaToken = log.recordingUrl
      ? signMediaToken({ callLogId: log.id, tenantId: auth.tenantId })
      : null;
    res.json({ call, mediaToken });
  }),
);
