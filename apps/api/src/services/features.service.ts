import type { Industry } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { env } from '../config/env';
import {
  FEATURES,
  FEATURE_KEYS,
  isFeatureKey,
  type FeatureKey,
  type FeatureRequirement,
} from '../domain/features';

/**
 * Feature entitlement engine. Resolves the three-layer control model
 * (platform availability → operator entitlement → on/off) into a single
 * effective answer, and is the only place the rules live so the admin UI, the
 * client UI, and the runtime enforcement can never drift apart.
 */

/** Which platform prerequisites are currently satisfied (Twilio configured?). */
function platformRequirementsMet(): Record<FeatureRequirement, boolean> {
  const twilio = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
  return { twilioSms: twilio, twilioVoice: twilio };
}

export interface ResolvedFeature {
  key: FeatureKey;
  label: string;
  description: string;
  /** Platform reqs met + offered to this tenant's industry. */
  available: boolean;
  /** Why it's unavailable, for the UI (e.g. "Requires SMS to be configured"). */
  unavailableReason: string | null;
  /** Operator master switch. */
  entitled: boolean;
  /** Operator grant: may the client toggle `enabled` themselves. */
  selfManage: boolean;
  /** The stored on/off. */
  enabled: boolean;
  /** The only thing the runtime cares about: available AND entitled AND enabled. */
  effective: boolean;
}

const REQUIREMENT_LABEL: Record<FeatureRequirement, string> = {
  twilioSms: 'Requires SMS (Twilio) to be configured',
  twilioVoice: 'Requires phone/Twilio to be configured',
};

/**
 * Pure resolution of one feature's effective state from its inputs. Exported so
 * the control matrix can be unit-tested without a database. `effective` is the
 * AND of availability, entitlement, and enabled — the rule the runtime obeys.
 */
export function resolveFeatureState(
  key: FeatureKey,
  industry: Industry,
  row: { entitled: boolean; selfManage: boolean; enabled: boolean } | undefined,
  reqMet: Record<FeatureRequirement, boolean>,
): ResolvedFeature {
  const meta = FEATURES[key];
  const missingReq = meta.requires.find((r) => !reqMet[r]) ?? null;
  const industryOk = meta.industries.includes(industry);
  const available = !missingReq && industryOk;
  const unavailableReason = missingReq
    ? REQUIREMENT_LABEL[missingReq]
    : !industryOk
      ? 'Not offered for this industry'
      : null;

  const entitled = row?.entitled ?? false;
  const selfManage = row?.selfManage ?? false;
  const enabled = row?.enabled ?? false;
  return {
    key,
    label: meta.label,
    description: meta.description,
    available,
    unavailableReason,
    entitled,
    selfManage,
    enabled,
    effective: available && entitled && enabled,
  };
}

/** Resolve every feature for a tenant (for the admin + client toggle UIs). */
export async function getTenantFeatures(tenantId: string): Promise<ResolvedFeature[]> {
  const [tenant, rows] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { industry: true } }),
    prisma.tenantFeature.findMany({ where: { tenantId } }),
  ]);
  if (!tenant) throw new HttpError(404, 'Tenant not found.', 'TENANT_NOT_FOUND');
  const reqMet = platformRequirementsMet();
  const byKey = new Map(rows.map((r) => [r.feature, r]));
  return FEATURE_KEYS.map((key) => resolveFeatureState(key, tenant.industry, byKey.get(key), reqMet));
}

/**
 * The runtime check — the single gate the webhook/dispatch logic calls. Returns
 * true only when the feature is platform-available, operator-entitled, and on.
 * Never trusts anything client-supplied.
 */
export async function isFeatureEnabled(tenantId: string, key: FeatureKey): Promise<boolean> {
  const [tenant, row] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { industry: true } }),
    prisma.tenantFeature.findUnique({ where: { tenantId_feature: { tenantId, feature: key } } }),
  ]);
  if (!tenant) return false;
  return resolveFeatureState(key, tenant.industry, row ?? undefined, platformRequirementsMet()).effective;
}

export interface AdminFeaturePatch {
  entitled?: boolean;
  selfManage?: boolean;
  enabled?: boolean;
}

/** Operator write (admin portal): set any of entitled / selfManage / enabled. */
export async function setFeatureByAdmin(
  tenantId: string,
  key: string,
  patch: AdminFeaturePatch,
): Promise<ResolvedFeature> {
  if (!isFeatureKey(key)) throw new HttpError(400, 'Unknown feature.', 'UNKNOWN_FEATURE');
  await prisma.tenantFeature.upsert({
    where: { tenantId_feature: { tenantId, feature: key } },
    create: {
      tenantId,
      feature: key,
      entitled: patch.entitled ?? false,
      selfManage: patch.selfManage ?? false,
      enabled: patch.enabled ?? false,
    },
    update: {
      ...(patch.entitled !== undefined ? { entitled: patch.entitled } : {}),
      ...(patch.selfManage !== undefined ? { selfManage: patch.selfManage } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    },
  });
  const all = await getTenantFeatures(tenantId);
  return all.find((f) => f.key === key)!;
}

/**
 * Client write (their own dashboard): flip the on/off — but only when the
 * operator has both entitled the feature and granted self-management. Otherwise
 * it's not theirs to change, and we refuse server-side.
 */
export async function setFeatureEnabledByClient(
  tenantId: string,
  key: string,
  enabled: boolean,
): Promise<ResolvedFeature> {
  if (!isFeatureKey(key)) throw new HttpError(400, 'Unknown feature.', 'UNKNOWN_FEATURE');
  const all = await getTenantFeatures(tenantId);
  const current = all.find((f) => f.key === key)!;
  if (!current.available) throw new HttpError(409, 'This feature isn’t available.', 'FEATURE_UNAVAILABLE');
  if (!current.entitled) throw new HttpError(403, 'This feature isn’t enabled for your workspace.', 'FEATURE_NOT_ENTITLED');
  if (!current.selfManage) {
    throw new HttpError(403, 'This feature is managed by VoiceFront for your workspace.', 'FEATURE_NOT_SELF_MANAGED');
  }
  await prisma.tenantFeature.upsert({
    where: { tenantId_feature: { tenantId, feature: key } },
    create: { tenantId, feature: key, entitled: true, enabled },
    update: { enabled },
  });
  return { ...current, enabled, effective: current.available && current.entitled && enabled };
}
