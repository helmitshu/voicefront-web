/**
 * The registry of optional, gated product features — the Tier-1 trades
 * capabilities and anything we add later. This is the single source of truth:
 * the DB stores per-tenant state keyed by `FeatureKey`, but the metadata (label,
 * description, platform requirements) lives here in code so a new feature needs
 * no migration.
 *
 * Control model (see TenantFeature in schema.prisma): a feature is "effective"
 * for a tenant only when it is platform-available (its requirements are met)
 * AND the operator has entitled the tenant AND it is enabled.
 */

export const FEATURE_KEYS = [
  'ON_CALL_DISPATCH',
  'MISSED_CALL_TEXTBACK',
  'SERVICE_AREA',
  'FSM_INTEGRATION',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Platform-level prerequisite a feature needs before it can run at all. */
export type FeatureRequirement = 'twilioVoice' | 'twilioSms';

export interface FeatureMeta {
  key: FeatureKey;
  /** Short label for the admin + client toggle UIs. */
  label: string;
  /** One line explaining what it does, shown under the toggle. */
  description: string;
  /** Platform prerequisites; all must be satisfied for the feature to be available. */
  requires: FeatureRequirement[];
  /** Industries this feature is offered to. Trades-first for the Tier-1 set. */
  industries: Array<'CLINIC' | 'CONSTRUCTION'>;
}

export const FEATURES: Record<FeatureKey, FeatureMeta> = {
  ON_CALL_DISPATCH: {
    key: 'ON_CALL_DISPATCH',
    label: 'On-call dispatch & escalation',
    description:
      'When an emergency job comes in, ring your on-call tech, escalate to the next person if there’s no answer, and tell the caller help is on the way.',
    requires: ['twilioVoice'],
    industries: ['CONSTRUCTION'],
  },
  MISSED_CALL_TEXTBACK: {
    key: 'MISSED_CALL_TEXTBACK',
    label: 'Missed-call text-back',
    description:
      'If a call is missed or abandoned, instantly text the caller so the lead isn’t lost to a competitor.',
    requires: ['twilioSms'],
    industries: ['CONSTRUCTION', 'CLINIC'],
  },
  SERVICE_AREA: {
    key: 'SERVICE_AREA',
    label: 'Service-area check',
    description:
      'The receptionist confirms the job address is in your service area before booking, and flags out-of-area calls.',
    requires: [],
    industries: ['CONSTRUCTION'],
  },
  FSM_INTEGRATION: {
    key: 'FSM_INTEGRATION',
    label: 'Field service software',
    description:
      'Connect ServiceTitan, Jobber, or Housecall Pro so captured jobs flow straight into the system your crew already runs on.',
    requires: [],
    industries: ['CONSTRUCTION'],
  },
};

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}
