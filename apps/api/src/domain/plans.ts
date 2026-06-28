/**
 * Subscription plan + trial definitions. The dollar amounts here are for DISPLAY
 * and margin math; the actual charge is driven by Stripe Price IDs configured in
 * admin (so prices can change in Stripe without a deploy). Provider cost basis is
 * ~$0.145/min (measured from prod call_logs), so overage at $0.39/min is ~2.7×.
 */

/** Free-trial length in days. */
export const TRIAL_DAYS = 30;
/** Hard minute cap during the trial — calls pause once it's hit, even before day 30. */
export const TRIAL_MINUTE_CAP = 200;

export type BillingCurrency = 'usd' | 'cad';

export interface PlanDef {
  /** Internal id (stable). */
  id: string;
  name: string;
  /** Minutes included each billing month before overage applies. */
  includedMinutes: number;
  /** Per-minute charge beyond the included minutes, in cents (USD basis). */
  overagePerMinuteCents: number;
  /** Display list price per month, by currency (whole dollars). CAD carries FX
   *  headroom because the underlying Vapi cost is billed to us in USD. */
  displayPrice: Record<BillingCurrency, number>;
}

/** The single self-serve plan at launch. "Scale" is a contact-us, no Stripe price. */
export const PROFESSIONAL_PLAN: PlanDef = {
  id: 'professional',
  name: 'Professional',
  includedMinutes: 500,
  overagePerMinuteCents: 39,
  displayPrice: { usd: 250, cad: 349 },
};

/** All self-serve plans (one for now). */
export const PLANS: PlanDef[] = [PROFESSIONAL_PLAN];

export function planById(id: string | null | undefined): PlanDef | null {
  return PLANS.find((p) => p.id === id) ?? null;
}

/** Currency for a visitor/customer country code (ISO-3166 alpha-2). CA → CAD. */
export function currencyForCountry(country: string | null | undefined): BillingCurrency {
  return (country ?? '').toUpperCase() === 'CA' ? 'cad' : 'usd';
}
