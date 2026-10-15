/**
 * Stripe billing (Build 2): self-serve checkout, the 7-day card-required
 * trial, and the subscription mirror the rest of the app reads.
 *
 * Money rules, in one place:
 *  - The charged price comes ONLY from `Tenant.pricingRegion` (the
 *    server-owned price book) resolved through the price ids in env. No
 *    request body can carry a price, amount, currency, or region.
 *  - Starter and Core are sellable; Growth is a waitlist and is refused.
 *  - Stripe owns the trial clock and the money. This module mirrors
 *    Stripe's subscription state into the `subscriptions` table and keeps
 *    `Tenant.subscriptionStatus` (the status the whole app already reads)
 *    in sync. The mirror is convergent: applying the same Stripe state
 *    twice changes nothing, so the checkout return path and the webhook
 *    can race safely and out-of-order events settle on Stripe's truth.
 *  - The hard minute cap is the overage policy: the billing service sets
 *    `Tenant.monthlyMinuteLimit` from the tier and the existing per-call
 *    enforcement does the rest. No metered billing in this build.
 *  - PAST_DUE never cuts service. Only `customer.subscription.deleted`
 *    tears down (number released, onboarding deactivated, status CANCELED).
 *
 * Optional integration, like Twilio and the calendar providers: when the
 * Stripe keys are unset the billing surface refuses cleanly with
 * BILLING_NOT_CONFIGURED and nothing else in the API is affected.
 */

import Stripe from 'stripe';
import { env, corsOrigins } from '../config/env';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { normalizePricingRegion, type PricingRegion } from './pricing-region.service';
import { releaseNumberForTenant } from './phone-pool.service';

export type BillingTier = 'STARTER' | 'CORE';
export type MirrorStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';

const TRIAL_DAYS = 7;

/* ------------------------------ price book ------------------------------ */

interface PriceBookEntry {
  /** Env var holding the Stripe price id for this tier + region. */
  envVar:
    | 'STRIPE_PRICE_STARTER_USD'
    | 'STRIPE_PRICE_STARTER_CAD'
    | 'STRIPE_PRICE_CORE_USD'
    | 'STRIPE_PRICE_CORE_CAD'
    | 'STRIPE_PRICE_WHITE_GLOVE_USD'
    | 'STRIPE_PRICE_WHITE_GLOVE_CAD';
  amountCents: number;
  currency: 'usd' | 'cad';
  minuteCap: number | null;
}

/**
 * The price book in code. Amounts document what the dashboard prices must
 * be (the founder creates them, section 9 of the plan); the ids come from
 * env. Region keys come only from `normalizePricingRegion`.
 */
export const PRICE_BOOK: Record<BillingTier, Record<PricingRegion, PriceBookEntry>> = {
  STARTER: {
    USD: { envVar: 'STRIPE_PRICE_STARTER_USD', amountCents: 29900, currency: 'usd', minuteCap: 300 },
    CAD: { envVar: 'STRIPE_PRICE_STARTER_CAD', amountCents: 39900, currency: 'cad', minuteCap: 300 },
  },
  CORE: {
    USD: { envVar: 'STRIPE_PRICE_CORE_USD', amountCents: 49900, currency: 'usd', minuteCap: 950 },
    CAD: { envVar: 'STRIPE_PRICE_CORE_CAD', amountCents: 59900, currency: 'cad', minuteCap: 950 },
  },
};

export const WHITE_GLOVE_PRICES: Record<PricingRegion, PriceBookEntry> = {
  USD: { envVar: 'STRIPE_PRICE_WHITE_GLOVE_USD', amountCents: 50000, currency: 'usd', minuteCap: null },
  CAD: { envVar: 'STRIPE_PRICE_WHITE_GLOVE_CAD', amountCents: 60000, currency: 'cad', minuteCap: null },
};

export const TIER_MINUTE_CAPS: Record<BillingTier, number> = {
  STARTER: 300,
  CORE: 950,
};

function priceIdFor(entry: PriceBookEntry): string | null {
  const id = env[entry.envVar];
  return id && id.trim().length > 0 ? id : null;
}

/** Which tier a Stripe price id belongs to, per the configured price book. */
export function tierForPriceId(priceId: string | null | undefined): BillingTier | null {
  if (!priceId) return null;
  for (const tier of Object.keys(PRICE_BOOK) as BillingTier[]) {
    for (const region of Object.keys(PRICE_BOOK[tier]) as PricingRegion[]) {
      if (priceIdFor(PRICE_BOOK[tier][region]) === priceId) return tier;
    }
  }
  return null;
}

/* ------------------------------ Stripe client ---------------------------- */

let stripeClient: Stripe | null = null;

/**
 * The configured Stripe client, or null when billing is not set up. Read
 * fresh from env on every call until a client exists, so tests (and a
 * future live-config reload) can flip configuration without a restart of
 * this module.
 */
export function getStripe(): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

export function isBillingConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

function requireStripe(): Stripe {
  const stripe = getStripe();
  if (!stripe) {
    throw new HttpError(
      503,
      'Billing is not set up yet. Please check back soon.',
      'BILLING_NOT_CONFIGURED',
    );
  }
  return stripe;
}

/** Absolute web URL for checkout/portal returns: the origin the API trusts. */
function webBaseUrl(): string {
  return (corsOrigins[0] ?? 'http://localhost:3000').replace(/\/$/, '');
}

/* ------------------------------ status view ------------------------------ */

export interface BillingStatusView {
  configured: boolean;
  /** 'NOT_STARTED' before any checkout, else the mirrored Stripe status. */
  state: string;
  tier: BillingTier | null;
  pricingRegion: PricingRegion;
  status: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  monthlyMinuteLimit: number;
  /** Pre-launch workspaces never pass through billing at all. */
  billingExempt: boolean;
}

export async function getBillingStatus(tenantId: string): Promise<BillingStatusView> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { pricingRegion: true, monthlyMinuteLimit: true, billingExempt: true },
  });
  if (!tenant) throw new HttpError(404, 'Workspace not found.', 'NOT_FOUND');
  const row = await prisma.subscription.findUnique({ where: { tenantId } });
  return {
    configured: isBillingConfigured(),
    state: row ? row.status : 'NOT_STARTED',
    tier: row ? (row.tier as BillingTier) : null,
    pricingRegion: normalizePricingRegion(row?.pricingRegion ?? tenant.pricingRegion),
    status: row ? row.status : null,
    trialEndsAt: row?.trialEnd ? row.trialEnd.toISOString() : null,
    currentPeriodEnd: row?.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    monthlyMinuteLimit: tenant.monthlyMinuteLimit,
    billingExempt: tenant.billingExempt,
  };
}

/* -------------------------------- checkout ------------------------------- */

export async function createCheckoutSession(input: {
  tenantId: string;
  email: string;
  tier: BillingTier;
  whiteGlove?: boolean;
}): Promise<{ url: string }> {
  const stripe = requireStripe();
  const { tenantId, tier } = input;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, pricingRegion: true },
  });
  if (!tenant) throw new HttpError(404, 'Workspace not found.', 'NOT_FOUND');

  const existing = await prisma.subscription.findUnique({ where: { tenantId } });
  if (existing && (existing.status === 'TRIALING' || existing.status === 'ACTIVE')) {
    throw new HttpError(
      409,
      'This workspace already has a subscription. Manage it from Settings instead.',
      'ALREADY_SUBSCRIBED',
    );
  }

  // The price book is chosen here, server-side, from the tenant's locked
  // region. Nothing in the request can influence it.
  const region = normalizePricingRegion(tenant.pricingRegion);
  const entry = PRICE_BOOK[tier][region];
  const priceId = priceIdFor(entry);
  if (!priceId) {
    console.error(`[billing] missing Stripe price id in env: ${entry.envVar}`);
    throw new HttpError(
      503,
      'Billing is not set up yet. Please check back soon.',
      'BILLING_NOT_CONFIGURED',
    );
  }
  // Defense in depth: the configured price must actually be priced in the
  // region's currency, so a price id pasted into the wrong env var fails
  // loudly here instead of charging a Canadian clinic in USD.
  const price = await stripe.prices.retrieve(priceId);
  if (price.currency !== entry.currency) {
    console.error(
      `[billing] price ${priceId} is ${price.currency}, expected ${entry.currency} for ${tier}/${region}`,
    );
    throw new HttpError(500, 'Billing is misconfigured. Please contact support.', 'BILLING_MISCONFIGURED');
  }

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: priceId, quantity: 1 }];
  if (input.whiteGlove) {
    const gloveEntry = WHITE_GLOVE_PRICES[region];
    const glovePriceId = priceIdFor(gloveEntry);
    if (!glovePriceId) {
      console.error(`[billing] missing Stripe price id in env: ${gloveEntry.envVar}`);
      throw new HttpError(
        503,
        'Billing is not set up yet. Please check back soon.',
        'BILLING_NOT_CONFIGURED',
      );
    }
    const glovePrice = await stripe.prices.retrieve(glovePriceId);
    if (glovePrice.currency !== gloveEntry.currency) {
      console.error(
        `[billing] white glove price ${glovePriceId} is ${glovePrice.currency}, expected ${gloveEntry.currency}`,
      );
      throw new HttpError(500, 'Billing is misconfigured. Please contact support.', 'BILLING_MISCONFIGURED');
    }
    lineItems.push({ price: glovePriceId, quantity: 1 });
  }

  // One Stripe customer per tenant, created on the first checkout attempt
  // and reused forever, so an abandoned checkout never spawns a second.
  let customerId = existing?.stripeCustomerId ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: input.email,
      metadata: { tenantId },
    });
    customerId = customer.id;
  }

  // Record the attempt (customer + intended tier/region). Holds no
  // subscription id and grants nothing until a subscription is applied.
  await prisma.subscription.upsert({
    where: { tenantId },
    create: {
      tenantId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: null,
      tier,
      pricingRegion: region,
      status: 'INCOMPLETE',
    },
    update: {
      stripeCustomerId: customerId,
      tier,
      pricingRegion: region,
    },
  });

  const base = webBaseUrl();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: tenantId,
    metadata: { tenantId, tier },
    line_items: lineItems,
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: { tenantId, tier },
    },
    // Card required up front: with a trial and nothing due today, Checkout
    // only collects a payment method when this is set explicitly.
    payment_method_collection: 'always',
    success_url: `${base}/onboarding?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/onboarding?checkout=cancelled`,
  });
  if (!session.url) {
    throw new HttpError(502, 'Stripe did not return a checkout page. Please try again.', 'CHECKOUT_FAILED');
  }
  return { url: session.url };
}

/**
 * The fast return path: the browser comes back from Stripe and we apply the
 * subscription immediately instead of waiting for the webhook. Both paths
 * run the same apply function, so whichever arrives second is a no-op.
 */
export async function completeCheckout(input: {
  tenantId: string;
  sessionId: string;
}): Promise<BillingStatusView> {
  const stripe = requireStripe();
  const session = await stripe.checkout.sessions.retrieve(input.sessionId);
  if (session.client_reference_id !== input.tenantId || session.metadata?.tenantId !== input.tenantId) {
    throw new HttpError(403, 'That checkout does not belong to this workspace.', 'FORBIDDEN');
  }
  const subscriptionId = idOf(session.subscription);
  if (!subscriptionId) {
    throw new HttpError(409, 'That checkout has not finished yet.', 'CHECKOUT_INCOMPLETE');
  }
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await applySubscription(subscription);
  return getBillingStatus(input.tenantId);
}

/* --------------------------------- portal -------------------------------- */

export async function createPortalSession(input: { tenantId: string }): Promise<{ url: string }> {
  const stripe = requireStripe();
  const row = await prisma.subscription.findUnique({ where: { tenantId: input.tenantId } });
  if (!row?.stripeCustomerId) {
    throw new HttpError(409, 'No billing account exists for this workspace yet.', 'NO_BILLING_ACCOUNT');
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: row.stripeCustomerId,
    return_url: `${webBaseUrl()}/dashboard/settings`,
  });
  return { url: session.url };
}

/* ----------------------------- subscription mirror ------------------------ */

/** Stripe's status vocabulary mapped onto the app's. Null = grants nothing. */
export function mapStripeStatus(status: Stripe.Subscription.Status): MirrorStatus | null {
  switch (status) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
    case 'unpaid':
    case 'paused':
      return 'PAST_DUE';
    case 'canceled':
    case 'incomplete_expired':
      return 'CANCELED';
    default:
      // 'incomplete': checkout started but never finished.
      return null;
  }
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function unixToDate(seconds: number | null | undefined): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}

/** Current period end lives on the subscription items in current Stripe APIs. */
function periodEndOf(sub: Stripe.Subscription): Date | null {
  const ends = (sub.items?.data ?? [])
    .map((item) => item.current_period_end)
    .filter((v): v is number => typeof v === 'number');
  return ends.length > 0 ? new Date(Math.max(...ends) * 1000) : null;
}

function tierForSubscription(sub: Stripe.Subscription): BillingTier | null {
  const priceId = sub.items?.data?.[0]?.price?.id;
  const fromPrice = tierForPriceId(priceId);
  if (fromPrice) return fromPrice;
  const meta = sub.metadata?.tier;
  return meta === 'STARTER' || meta === 'CORE' ? meta : null;
}

async function resolveTenantIdForSubscription(sub: Stripe.Subscription): Promise<string | null> {
  const fromMetadata = sub.metadata?.tenantId;
  if (fromMetadata) return fromMetadata;
  const bySubscription = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: sub.id },
    select: { tenantId: true },
  });
  if (bySubscription) return bySubscription.tenantId;
  const customerId = idOf(sub.customer as string | { id: string });
  if (customerId) {
    const byCustomer = await prisma.subscription.findUnique({
      where: { stripeCustomerId: customerId },
      select: { tenantId: true },
    });
    if (byCustomer) return byCustomer.tenantId;
  }
  return null;
}

/**
 * The one apply path. Reads a Stripe subscription's current state and
 * upserts our mirror to match: subscription row, `Tenant.subscriptionStatus`,
 * and the tier's minute cap. Idempotent and order-tolerant by design.
 */
export async function applySubscription(
  sub: Stripe.Subscription,
  opts?: { forceStatus?: MirrorStatus },
): Promise<void> {
  const tenantId = await resolveTenantIdForSubscription(sub);
  if (!tenantId) {
    console.warn(`[billing] subscription ${sub.id} has no resolvable tenant; ignoring`);
    return;
  }
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, pricingRegion: true },
  });
  if (!tenant) {
    console.warn(`[billing] subscription ${sub.id} names unknown tenant ${tenantId}; ignoring`);
    return;
  }
  // Cross-check: a subscription id already recorded for a DIFFERENT tenant
  // is never re-attributed.
  const attributed = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: sub.id },
    select: { tenantId: true },
  });
  if (attributed && attributed.tenantId !== tenantId) {
    console.warn(
      `[billing] subscription ${sub.id} is recorded for tenant ${attributed.tenantId}, event names ${tenantId}; ignoring`,
    );
    return;
  }

  const existing = await prisma.subscription.findUnique({ where: { tenantId } });
  // Double-checkout guard: a tenant already running a different live
  // subscription keeps it; a second completed checkout is ignored and
  // logged for manual cleanup in Stripe.
  if (
    existing?.stripeSubscriptionId &&
    existing.stripeSubscriptionId !== sub.id &&
    (existing.status === 'TRIALING' || existing.status === 'ACTIVE' || existing.status === 'PAST_DUE')
  ) {
    console.warn(
      `[billing] tenant ${tenantId} already runs subscription ${existing.stripeSubscriptionId}; ignoring ${sub.id}`,
    );
    return;
  }

  const customerId = idOf(sub.customer as string | { id: string }) ?? existing?.stripeCustomerId;
  if (!customerId) {
    console.warn(`[billing] subscription ${sub.id} carries no customer; ignoring`);
    return;
  }
  const tier = tierForSubscription(sub) ?? (existing?.tier as BillingTier | undefined) ?? 'CORE';
  const region = existing?.pricingRegion
    ? normalizePricingRegion(existing.pricingRegion)
    : normalizePricingRegion(tenant.pricingRegion);
  const mapped = opts?.forceStatus ?? mapStripeStatus(sub.status);

  if (mapped === null) {
    // Incomplete (checkout never finished): record the ids, grant nothing,
    // and leave every tenant field exactly as it was.
    await prisma.subscription.upsert({
      where: { tenantId },
      create: {
        tenantId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: sub.id,
        tier,
        pricingRegion: region,
        status: 'INCOMPLETE',
        trialStart: unixToDate(sub.trial_start),
        trialEnd: unixToDate(sub.trial_end),
        currentPeriodEnd: periodEndOf(sub),
        cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      },
      update: {
        stripeCustomerId: customerId,
        stripeSubscriptionId: sub.id,
        status: 'INCOMPLETE',
      },
    });
    return;
  }

  await prisma.subscription.upsert({
    where: { tenantId },
    create: {
      tenantId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      tier,
      pricingRegion: region,
      status: mapped,
      trialStart: unixToDate(sub.trial_start),
      trialEnd: unixToDate(sub.trial_end),
      currentPeriodEnd: periodEndOf(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    },
    update: {
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      tier,
      pricingRegion: region,
      status: mapped,
      trialStart: unixToDate(sub.trial_start),
      trialEnd: unixToDate(sub.trial_end),
      currentPeriodEnd: periodEndOf(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    },
  });

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      subscriptionStatus: mapped,
      // The cap follows the tier on every live state. CANCELED keeps the
      // last cap (the inbound gate refuses the calls anyway).
      ...(mapped === 'CANCELED' ? {} : { monthlyMinuteLimit: TIER_MINUTE_CAPS[tier] }),
    },
  });
}

/**
 * The single teardown funnel, run only from `customer.subscription.deleted`:
 * status to CANCELED (the inbound gate refuses calls from that moment), the
 * pooled number returns for the next clinic, and onboarding stops claiming
 * the receptionist is live. Data is never deleted by billing events.
 */
export async function teardownSubscription(tenantId: string): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { subscriptionStatus: 'CANCELED' },
  });
  try {
    await releaseNumberForTenant(tenantId);
  } catch (err) {
    console.error(`[billing] number release failed for tenant ${tenantId}:`, err);
  }
  await prisma.onboardingStatus.updateMany({
    where: { tenantId },
    data: { isActive: false },
  });
}

/* --------------------------------- webhook -------------------------------- */

/**
 * Verifies a webhook delivery over its RAW body. Throws 503 when the
 * webhook secret is unset (the route then processes nothing) and 400 on
 * any signature problem, with no detail leaked either way.
 */
export function verifyWebhookEvent(rawBody: Buffer, signature: string | undefined): Stripe.Event {
  const stripe = getStripe();
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    throw new HttpError(503, 'Billing is not set up yet.', 'BILLING_NOT_CONFIGURED');
  }
  if (!signature) {
    throw new HttpError(400, 'Missing signature.', 'BAD_SIGNATURE');
  }
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new HttpError(400, 'Invalid signature.', 'BAD_SIGNATURE');
  }
}

/**
 * Records the event in the idempotency ledger. Returns false when the
 * event was already recorded (a redelivery): the caller then answers 200
 * without reprocessing.
 */
export async function recordStripeEvent(event: Stripe.Event): Promise<boolean> {
  try {
    await prisma.stripeEvent.create({ data: { id: event.id, type: event.type } });
    return true;
  } catch (err) {
    // Unique-key collision on the event id = already handled.
    if ((err as { code?: unknown })?.code === 'P2002') return false;
    throw err;
  }
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parent = invoice.parent?.subscription_details?.subscription;
  const fromParent = idOf(parent as string | { id: string } | null | undefined);
  if (fromParent) return fromParent;
  // Older invoice shapes carried the id directly on the invoice.
  return idOf((invoice as unknown as { subscription?: string | { id: string } | null }).subscription);
}

/** Dispatches one verified, ledger-recorded event. Unknown types are ignored. */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  const stripe = requireStripe();
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const subscriptionId = idOf(session.subscription);
      if (!subscriptionId) return;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await applySubscription(subscription);
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      await applySubscription(event.data.object as Stripe.Subscription);
      return;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      await applySubscription(subscription);
      const tenantId = await resolveTenantIdForSubscription(subscription);
      if (tenantId) await teardownSubscription(tenantId);
      return;
    }
    case 'invoice.paid': {
      // Conversion proof. The mirror normally already says ACTIVE via
      // subscription.updated; applying the subscription's current state
      // again is the convergent belt to its suspenders.
      const subscriptionId = invoiceSubscriptionId(event.data.object as Stripe.Invoice);
      if (!subscriptionId) return;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await applySubscription(subscription);
      return;
    }
    case 'invoice.payment_failed': {
      // Mirror PAST_DUE and nothing more: Stripe retries, the clinic keeps
      // its receptionist, and only the deleted event ever tears down.
      const subscriptionId = invoiceSubscriptionId(event.data.object as Stripe.Invoice);
      if (!subscriptionId) return;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await applySubscription(subscription, {
        forceStatus: subscription.status === 'canceled' ? undefined : 'PAST_DUE',
      });
      return;
    }
    default:
      return;
  }
}

/* ------------------------------ activation gate --------------------------- */

/**
 * The billing gate inside onboarding activation. Billing-exempt tenants
 * (every pre-launch workspace) pass unconditionally; everyone else needs a
 * subscription in TRIALING or ACTIVE. Runs server-side on every activation
 * call, including hand-crafted ones that skip the wizard.
 */
export async function assertBillingAllowsActivation(tenantId: string): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { billingExempt: true },
  });
  if (!tenant || tenant.billingExempt) return;
  const row = await prisma.subscription.findUnique({
    where: { tenantId },
    select: { status: true },
  });
  if (row && (row.status === 'TRIALING' || row.status === 'ACTIVE')) return;
  throw new HttpError(
    402,
    'Start your free trial before going live. Your card is not charged until the trial ends.',
    'BILLING_REQUIRED',
  );
}

// Re-exported so route modules can validate tiers without importing Stripe types.
export const BILLING_TIERS = ['STARTER', 'CORE'] as const;
