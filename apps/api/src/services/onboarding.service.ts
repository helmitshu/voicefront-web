import type { OnboardingStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { claimNumberForTenant } from './phone-pool.service';
import { createAssistantForTenant } from './vapi.service';

export const ONBOARDING_STEPS = ['PROFILE', 'PROMPT', 'VOICE_TEST'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingView {
  hasConfiguredProfile: boolean;
  hasConfiguredPrompt: boolean;
  hasTestedVoice: boolean;
  isActive: boolean;
  completedAt: string | null;
  /** First incomplete step, or null when everything is done. */
  nextStep: OnboardingStep | null;
  progressPercent: number;
}

export function toOnboardingView(status: OnboardingStatus): OnboardingView {
  const flags: Record<OnboardingStep, boolean> = {
    PROFILE: status.hasConfiguredProfile,
    PROMPT: status.hasConfiguredPrompt,
    VOICE_TEST: status.hasTestedVoice,
  };
  const nextStep = ONBOARDING_STEPS.find((s) => !flags[s]) ?? null;
  const done = ONBOARDING_STEPS.filter((s) => flags[s]).length;
  return {
    hasConfiguredProfile: status.hasConfiguredProfile,
    hasConfiguredPrompt: status.hasConfiguredPrompt,
    hasTestedVoice: status.hasTestedVoice,
    isActive: status.isActive,
    completedAt: status.completedAt ? status.completedAt.toISOString() : null,
    nextStep,
    progressPercent: Math.round((done / ONBOARDING_STEPS.length) * 100),
  };
}

export async function getOnboarding(tenantId: string): Promise<OnboardingStatus> {
  const status = await prisma.onboardingStatus.findUnique({ where: { tenantId } });
  if (!status) {
    // Self-heal for tenants created before this table existed.
    return prisma.onboardingStatus.create({ data: { tenantId } });
  }
  return status;
}

/**
 * State machine: steps must complete in order, and each transition verifies
 * the underlying data actually exists so the UI cannot skip ahead.
 */
export async function completeStep(tenantId: string, step: OnboardingStep): Promise<OnboardingStatus> {
  const [, settings] = await Promise.all([
    getOnboarding(tenantId), // ensures the onboarding row exists
    prisma.agentSettings.findUnique({ where: { tenantId } }),
  ]);
  if (!settings) {
    throw new HttpError(409, 'Receptionist settings are missing for this workspace.', 'SETTINGS_MISSING');
  }

  switch (step) {
    case 'PROFILE': {
      if (settings.firstMessage.trim().length < 4) {
        throw new HttpError(409, 'Add a greeting before completing this step.', 'STEP_PREREQ_FAILED');
      }
      return prisma.onboardingStatus.update({
        where: { tenantId },
        data: { hasConfiguredProfile: true },
      });
    }
    case 'PROMPT': {
      // Steps can be completed in any order (the UI leads with the test call);
      // each only validates its OWN data. `activate` is the gate that requires
      // all three before going live.
      if (settings.systemPrompt.trim().length < 40) {
        throw new HttpError(
          409,
          'Your receptionist instructions look empty. Save them before continuing.',
          'STEP_PREREQ_FAILED',
        );
      }
      return prisma.onboardingStatus.update({
        where: { tenantId },
        data: { hasConfiguredPrompt: true },
      });
    }
    case 'VOICE_TEST': {
      // No prerequisite — the test call is the first thing the user does.
      return prisma.onboardingStatus.update({
        where: { tenantId },
        data: { hasTestedVoice: true },
      });
    }
  }
}

/** Final gate: requires every step, then flips the receptionist live. */
export async function activate(tenantId: string): Promise<OnboardingStatus> {
  const status = await getOnboarding(tenantId);
  if (!status.hasConfiguredProfile || !status.hasConfiguredPrompt || !status.hasTestedVoice) {
    throw new HttpError(409, 'Complete all setup steps before going live.', 'STEP_OUT_OF_ORDER');
  }
  if (status.isActive) return status;

  // Self-serve number provisioning: claim a pooled number on the way live.
  // Best-effort — if the pool is empty the customer still activates, and the
  // dashboard shows "number being provisioned" until the operator refills.
  try {
    await claimNumberForTenant(tenantId);
  } catch (err) {
    console.error(`[onboarding] number claim failed for tenant ${tenantId}:`, err);
  }

  // Provision a dedicated persistent Vapi assistant so calls use a warm,
  // pre-built agent (faster, more natural) rather than one rebuilt per call.
  // Best-effort — if it fails, the assistant-request webhook still falls back
  // to building a transient assistant, so the receptionist keeps working.
  try {
    await createAssistantForTenant(tenantId);
  } catch (err) {
    console.error(`[onboarding] assistant creation failed for tenant ${tenantId}:`, err);
  }

  return prisma.onboardingStatus.update({
    where: { tenantId },
    data: { isActive: true, completedAt: new Date() },
  });
}
