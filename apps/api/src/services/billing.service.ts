import type { SubscriptionStatus, Tenant } from '@prisma/client';
import type Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { getStripe } from '../lib/stripe';
import { HttpError } from '../lib/http';
import { logger } from '../lib/logger';
import { getSettingValue } from './platform-config.service';
import {
  PROFESSIONAL_PLAN,
  TRIAL_DAYS,
  TRIAL_MINUTE_CAP,
  currencyForCountry,
  type BillingCurrency,
} from '../domain/plans';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Billing is "on" only when a secret key AND a USD price are configured — both
 * are needed to run Checkout. When off, signup and the call gate behave exactly
 * as before (no card required), so the platform ships safely with billing dark.
 */
export async function isBillingEnabled(): Promise<boolean> {
  const [key, price] = await Promise.all([
    getSettingValue('STRIPE_SECRET_KEY'),
    getSettingValue('STRIPE_PRICE_USD'),
  ]);
  return Boolean(key?.trim() && price?.trim());
}

async function priceIdFor(currency: BillingCurrency): Promise<string | null> {
  const usd = (await getSettingValue('STRIPE_PRICE_USD'))?.trim() || null;
  if (currency === 'cad') {
    const cad = (await getSettingValue('STRIPE_PRICE_CAD'))?.trim() || null;
    return cad ?? usd; // fall back to USD if no CAD price configured
  }
  return usd;
}

/** Map a Stripe subscription status onto our coarser enum. */
function mapStatus(s: Stripe.Subscription.Status): SubscriptionStatus {
  switch (s) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    case 'paused':
      return 'PAST_DUE';
    case 'canceled':
    case 'incomplete_expired':
      return 'CANCELED';
    default:
      return 'PAST_DUE';
  }
}

/**
 * Creates a hosted Checkout session for the tenant's subscription with a 30-day
 * trial. `payment_method_collection: 'always'` forces a card even though the
 * first 30 days are free — that's the "card required at signup" requirement.
 * Currency follows the visitor's country (CA → CAD, else USD).
 */
export async function createCheckoutSession(opts: {
  tenantId: string;
  email: string;
  country: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const stripe = await getStripe();
  if (!stripe) throw new HttpError(503, 'Billing is not configured.', 'BILLING_NOT_CONFIGURED');
  const currency = currencyForCountry(opts.country);
  const price = await priceIdFor(currency);
  if (!price) throw new HttpError(503, 'No Stripe price is configured.', 'BILLING_NOT_CONFIGURED');

  const tenant = await prisma.tenant.findUnique({
    where: { id: opts.tenantId },
    select: { stripeCustomerId: true },
  });

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    subscription_data: { trial_period_days: TRIAL_DAYS, metadata: { tenantId: opts.tenantId } },
    payment_method_collection: 'always',
    client_reference_id: opts.tenantId,
    metadata: { tenantId: opts.tenantId, planId: PROFESSIONAL_PLAN.id, currency },
    allow_promotion_codes: true,
    ...(tenant?.stripeCustomerId
      ? { customer: tenant.stripeCustomerId }
      : { customer_email: opts.email }),
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  });
  if (!session.url) throw new HttpError(502, 'Stripe did not return a checkout URL.', 'STRIPE_ERROR');
  return session.url;
}

/** A link to Stripe's hosted billing portal, where the customer manages their
 *  card and plan. Requires the tenant to already have a Stripe customer. */
export async function createBillingPortalSession(tenantId: string, returnUrl: string): Promise<string> {
  const stripe = await getStripe();
  if (!stripe) throw new HttpError(503, 'Billing is not configured.', 'BILLING_NOT_CONFIGURED');
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { stripeCustomerId: true },
  });
  if (!tenant?.stripeCustomerId) {
    throw new HttpError(409, 'No billing account yet — start your subscription first.', 'NO_CUSTOMER');
  }
  const portal = await stripe.billingPortal.sessions.create({
    customer: tenant.stripeCustomerId,
    return_url: returnUrl,
  });
  return portal.url;
}

/** Persist a Stripe subscription's state onto the tenant. The single source of
 *  truth for billing status is always Stripe → mirrored here via webhooks. */
async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const tenantId = sub.metadata?.tenantId;
  if (!tenantId) {
    logger.warn({ sub: sub.id }, 'billing: subscription has no tenantId metadata; skipping');
    return;
  }
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const currency = sub.metadata?.currency;
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      subscriptionStatus: mapStatus(sub.status),
      planId: PROFESSIONAL_PLAN.id,
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
      ...(currency ? { billingCurrency: currency } : {}),
    },
  });
}

/** Handle a verified Stripe webhook event. Only the subscription-lifecycle and
 *  checkout-completed events matter for keeping tenant billing state in sync. */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const stripe = await getStripe();
      if (stripe && typeof session.subscription === 'string') {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        // Carry the tenantId/currency from the session if the sub lacks them.
        sub.metadata = { ...sub.metadata, ...(session.metadata ?? {}) };
        await applySubscription(sub);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      await applySubscription(event.data.object as Stripe.Subscription);
      break;
    }
    default:
      break; // ignore everything else
  }
}

export interface BillingState {
  /** Billing is configured platform-wide. When false, billing never gates. */
  enabled: boolean;
  /** A card/subscription is on file. */
  subscribed: boolean;
  status: SubscriptionStatus;
  planId: string | null;
  currency: string | null;
  trialEndsAt: string | null;
  trialMinutesUsed: number;
  trialMinutesCap: number;
  includedMinutes: number;
  /** False when calls are blocked for a billing reason. */
  canTakeCalls: boolean;
  /** Human reason calls are paused (null when fine). */
  blockedReason: string | null;
}

/** Answered minutes used since the trial began (cap is measured over the trial,
 *  not the calendar month). Trial start = trialEndsAt − 30d, else tenant creation. */
async function trialMinutesUsed(tenantId: string, trialEndsAt: Date | null, createdAt: Date): Promise<number> {
  const trialStart = trialEndsAt ? new Date(trialEndsAt.getTime() - TRIAL_DAYS * DAY_MS) : createdAt;
  const agg = await prisma.callLog.aggregate({
    where: { tenantId, startedAt: { gte: trialStart } },
    _sum: { durationSeconds: true },
  });
  return Math.round((agg._sum.durationSeconds ?? 0) / 60);
}

/** Call-path gate: may this tenant take a call right now, billing-wise? Fetches
 *  the minimal fields and reuses getBillingState, so it's a no-op (allowed) when
 *  billing is disabled platform-wide. */
export async function isCallAllowedForBilling(tenantId: string): Promise<{ allowed: boolean; reason: string | null }> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      subscriptionStatus: true,
      stripeSubscriptionId: true,
      planId: true,
      billingCurrency: true,
      trialEndsAt: true,
      createdAt: true,
    },
  });
  if (!tenant) return { allowed: false, reason: 'Workspace not found.' };
  const state = await getBillingState(tenant);
  return { allowed: state.canTakeCalls, reason: state.blockedReason };
}

/** Full billing state for a tenant — drives the dashboard banner AND the call
 *  gate. When billing is disabled platform-wide, calls are never blocked here. */
export async function getBillingState(
  tenant: Pick<
    Tenant,
    'id' | 'subscriptionStatus' | 'stripeSubscriptionId' | 'planId' | 'billingCurrency' | 'trialEndsAt' | 'createdAt'
  >,
  now: Date = new Date(),
): Promise<BillingState> {
  const enabled = await isBillingEnabled();
  const subscribed = Boolean(tenant.stripeSubscriptionId);
  const base: Omit<BillingState, 'canTakeCalls' | 'blockedReason'> = {
    enabled,
    subscribed,
    status: tenant.subscriptionStatus,
    planId: tenant.planId,
    currency: tenant.billingCurrency,
    trialEndsAt: tenant.trialEndsAt ? tenant.trialEndsAt.toISOString() : null,
    trialMinutesUsed: 0,
    trialMinutesCap: TRIAL_MINUTE_CAP,
    includedMinutes: PROFESSIONAL_PLAN.includedMinutes,
  };

  // Billing dark → never a billing-based block (legacy/manual behavior).
  if (!enabled) {
    return { ...base, canTakeCalls: true, blockedReason: null };
  }

  // No card/subscription yet → signup not finished.
  if (!subscribed) {
    return { ...base, canTakeCalls: false, blockedReason: 'Add a payment method to start your free trial.' };
  }

  if (tenant.subscriptionStatus === 'ACTIVE') {
    return { ...base, canTakeCalls: true, blockedReason: null };
  }

  if (tenant.subscriptionStatus === 'TRIALING') {
    const used = await trialMinutesUsed(tenant.id, tenant.trialEndsAt, tenant.createdAt);
    if (tenant.trialEndsAt && now >= tenant.trialEndsAt) {
      return { ...base, trialMinutesUsed: used, canTakeCalls: false, blockedReason: 'Your free trial has ended.' };
    }
    if (used >= TRIAL_MINUTE_CAP) {
      return {
        ...base,
        trialMinutesUsed: used,
        canTakeCalls: false,
        blockedReason: `Free-trial limit of ${TRIAL_MINUTE_CAP} minutes reached.`,
      };
    }
    return { ...base, trialMinutesUsed: used, canTakeCalls: true, blockedReason: null };
  }

  // PAST_DUE / CANCELED.
  return {
    ...base,
    canTakeCalls: false,
    blockedReason:
      tenant.subscriptionStatus === 'PAST_DUE'
        ? 'Payment is past due — update your card to resume.'
        : 'Subscription canceled.',
  };
}
