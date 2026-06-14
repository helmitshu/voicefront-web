import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { getAuth, requireAuth } from '../middleware/auth';
import {
  activate,
  completeStep,
  getOnboarding,
  ONBOARDING_STEPS,
  toOnboardingView,
} from '../services/onboarding.service';

export const onboardingRouter = Router();
onboardingRouter.use(requireAuth);

onboardingRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const status = await getOnboarding(auth.tenantId);
    res.json({ onboarding: toOnboardingView(status) });
  }),
);

const CompleteStepSchema = z.object({ step: z.enum(ONBOARDING_STEPS) });

onboardingRouter.post(
  '/complete-step',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { step } = CompleteStepSchema.parse(req.body);
    const status = await completeStep(auth.tenantId, step);
    res.json({ onboarding: toOnboardingView(status) });
  }),
);

onboardingRouter.post(
  '/activate',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const status = await activate(auth.tenantId);
    res.json({ onboarding: toOnboardingView(status) });
  }),
);
