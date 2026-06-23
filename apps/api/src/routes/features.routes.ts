import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import { getTenantFeatures, setFeatureEnabledByClient } from '../services/features.service';

/**
 * The customer's view of their gated features. They can see every feature's
 * state (so the UI can show "managed by VoiceFront" when they can't change it)
 * and flip the on/off only for features the operator entitled AND let them
 * self-manage — that rule is enforced server-side in the service.
 */
export const featuresRouter = Router();
featuresRouter.use(requireAuth);

featuresRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const features = await getTenantFeatures(auth.tenantId);
    res.json({ features });
  }),
);

const ToggleSchema = z.object({ enabled: z.boolean() });

featuresRouter.patch(
  '/:feature',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { enabled } = ToggleSchema.parse(req.body);
    const feature = await setFeatureEnabledByClient(auth.tenantId, req.params.feature, enabled);
    res.json({ feature });
  }),
);
