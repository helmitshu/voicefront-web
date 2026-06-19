import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { getAuth, requireAuth } from '../middleware/auth';
import { getAnalyticsOverview } from '../services/analytics.service';

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

const OverviewQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(365).default(30),
});

analyticsRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { days } = OverviewQuerySchema.parse(req.query);
    const overview = await getAnalyticsOverview(auth.tenantId, days);
    res.json({ overview });
  }),
);
