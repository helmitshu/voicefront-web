import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Service tests for Stripe billing (Build 2). Prisma is an in-memory fake,
 * Stripe is a controllable fake client, and the real billing service (plus
 * the real onboarding activation gate) runs against both. Env config for
 * the configured case is set here before any module loads; individual
 * tests flip env values to exercise the unconfigured paths.
 */

const state = vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  process.env.STRIPE_PRICE_STARTER_USD = 'price_starter_usd';
  process.env.STRIPE_PRICE_STARTER_CAD = 'price_starter_cad';
  process.env.STRIPE_PRICE_CORE_USD = 'price_core_usd';
  process.env.STRIPE_PRICE_CORE_CAD = 'price_core_cad';
  process.env.STRIPE_PRICE_WHITE_GLOVE_USD = 'price_glove_usd';
  process.env.STRIPE_PRICE_WHITE_GLOVE_CAD = 'price_glove_cad';

  interface FakeTenant {
    id: string;
    pricingRegion: string;
    subscriptionStatus: string;
    monthlyMinuteLimit: number;
    billingExempt: boolean;
  }
  interface FakeSubscriptionRow {
    id: string;
    tenantId: string;
    stripeCustomerId: string;
    stripeSubscriptionId: string | null;
    tier: string;
    pricingRegion: string;
    status: string;
    trialStart: Date | null;
    trialEnd: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
  }
  interface FakeOnboarding {
    tenantId: string;
    hasConfiguredProfile: boolean;
    hasConfiguredPrompt: boolean;
    hasTestedVoice: boolean;
    isActive: boolean;
    completedAt: Date | null;
  }

  const tenants = new Map<string, FakeTenant>();
  const subscriptions = new Map<string, FakeSubscriptionRow>(); // by tenantId
  const stripeEvents = new Map<string, { id: string; type: string }>();
  const onboardings = new Map<string, FakeOnboarding>();
  const platformSettings = new Map<string, { key: string; valueEnc: string; updatedBy: string }>();
  const auditEntries: Array<Record<string, unknown>> = [];

  /* ------------------------------ fake Stripe ---------------------------- */
  const prices = new Map<string, { id: string; currency: string }>();
  const stripeSubscriptions = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const customersCreated: Array<Record<string, unknown>> = [];
  const sessionCreates: Array<Record<string, unknown>> = [];
  const portalCreates: Array<Record<string, unknown>> = [];
  const subscriptionRetrieves: string[] = [];
  let customerSeq = 0;
  let sessionSeq = 0;
  /** Subscription id the next created checkout session "completes" with. */
  let nextSessionSubscription: string | null = null;

  function stripeSub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'trialing',
      metadata: { tenantId: 'tenant_usd', tier: 'CORE' },
      trial_start: 1760000000,
      trial_end: 1760604800,
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_core_usd' }, current_period_end: 1763196800 }] },
      ...overrides,
    };
  }

  const stripeApi = {
    createCustomer: (args: Record<string, unknown>) => {
      customerSeq += 1;
      const customer = { id: `cus_${customerSeq}`, ...args };
      customersCreated.push(customer);
      return Promise.resolve(customer);
    },
    retrievePrice: (id: string) => {
      const price = prices.get(id);
      if (!price) return Promise.reject(new Error(`No such price: ${id}`));
      return Promise.resolve(price);
    },
    createSession: (args: Record<string, unknown>) => {
      sessionSeq += 1;
      const id = `cs_${sessionSeq}`;
      const session = {
        id,
        url: `https://checkout.stripe.test/${id}`,
        client_reference_id: args.client_reference_id,
        metadata: args.metadata,
        subscription: nextSessionSubscription,
        ...args,
      };
      sessions.set(id, session);
      sessionCreates.push(args);
      return Promise.resolve(session);
    },
    retrieveSession: (id: string) => {
      const session = sessions.get(id);
      if (!session) return Promise.reject(new Error(`No such session: ${id}`));
      return Promise.resolve(session);
    },
    retrieveSubscription: (id: string) => {
      subscriptionRetrieves.push(id);
      const sub = stripeSubscriptions.get(id);
      if (!sub) return Promise.reject(new Error(`No such subscription: ${id}`));
      return Promise.resolve(sub);
    },
    createPortal: (args: Record<string, unknown>) => {
      portalCreates.push(args);
      return Promise.resolve({ url: 'https://billing.stripe.test/portal' });
    },
    constructEvent: (body: Buffer, signature: string, _secret: string) => {
      if (signature !== 'sig_valid') throw new Error('signature mismatch');
      return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    },
  };

  class FakeStripe {
    customers = { create: stripeApi.createCustomer };
    prices = { retrieve: stripeApi.retrievePrice };
    checkout = {
      sessions: { create: stripeApi.createSession, retrieve: stripeApi.retrieveSession },
    };
    subscriptions = { retrieve: stripeApi.retrieveSubscription };
    billingPortal = { sessions: { create: stripeApi.createPortal } };
    webhooks = { constructEvent: stripeApi.constructEvent };
  }

  /* ------------------------------ fake Prisma ---------------------------- */
  let rowSeq = 0;
  const prisma = {
    tenant: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(tenants.get(args.where.id) ?? null),
      update: (args: { where: { id: string }; data: Partial<FakeTenant> }) => {
        const row = tenants.get(args.where.id);
        if (!row) return Promise.reject(new Error('tenant missing'));
        Object.assign(row, args.data);
        return Promise.resolve(row);
      },
    },
    subscription: {
      findUnique: (args: {
        where: { tenantId?: string; stripeSubscriptionId?: string; stripeCustomerId?: string };
      }) => {
        const { where } = args;
        if (where.tenantId) return Promise.resolve(subscriptions.get(where.tenantId) ?? null);
        const row = [...subscriptions.values()].find(
          (r) =>
            (where.stripeSubscriptionId !== undefined && r.stripeSubscriptionId === where.stripeSubscriptionId) ||
            (where.stripeCustomerId !== undefined && r.stripeCustomerId === where.stripeCustomerId),
        );
        return Promise.resolve(row ?? null);
      },
      upsert: (args: {
        where: { tenantId: string };
        create: Omit<FakeSubscriptionRow, 'id'>;
        update: Partial<FakeSubscriptionRow>;
      }) => {
        const existing = subscriptions.get(args.where.tenantId);
        if (existing) {
          Object.assign(existing, args.update);
          return Promise.resolve(existing);
        }
        rowSeq += 1;
        const row: FakeSubscriptionRow = { id: `brow_${rowSeq}`, ...args.create };
        subscriptions.set(args.where.tenantId, row);
        return Promise.resolve(row);
      },
      create: (args: { data: Omit<FakeSubscriptionRow, 'id'> }) => {
        rowSeq += 1;
        const row: FakeSubscriptionRow = { id: `brow_${rowSeq}`, ...args.data };
        subscriptions.set(args.data.tenantId, row);
        return Promise.resolve(row);
      },
      update: (args: { where: { tenantId: string }; data: Partial<FakeSubscriptionRow> }) => {
        const row = subscriptions.get(args.where.tenantId);
        if (!row) return Promise.reject(new Error('subscription missing'));
        Object.assign(row, args.data);
        return Promise.resolve(row);
      },
    },
    stripeEvent: {
      create: (args: { data: { id: string; type: string } }) => {
        if (stripeEvents.has(args.data.id)) {
          const err = new Error('unique violation') as Error & { code: string };
          err.code = 'P2002';
          return Promise.reject(err);
        }
        stripeEvents.set(args.data.id, args.data);
        return Promise.resolve(args.data);
      },
    },
    onboardingStatus: {
      findUnique: (args: { where: { tenantId: string } }) =>
        Promise.resolve(onboardings.get(args.where.tenantId) ?? null),
      create: (args: { data: { tenantId: string } }) => {
        const row: FakeOnboarding = {
          tenantId: args.data.tenantId,
          hasConfiguredProfile: false,
          hasConfiguredPrompt: false,
          hasTestedVoice: false,
          isActive: false,
          completedAt: null,
        };
        onboardings.set(args.data.tenantId, row);
        return Promise.resolve(row);
      },
      update: (args: { where: { tenantId: string }; data: Partial<FakeOnboarding> }) => {
        const row = onboardings.get(args.where.tenantId);
        if (!row) return Promise.reject(new Error('onboarding missing'));
        Object.assign(row, args.data);
        return Promise.resolve(row);
      },
      updateMany: (args: { where: { tenantId: string }; data: Partial<FakeOnboarding> }) => {
        const row = onboardings.get(args.where.tenantId);
        if (row) Object.assign(row, args.data);
        return Promise.resolve({ count: row ? 1 : 0 });
      },
    },
    platformSetting: {
      findUnique: (args: { where: { key: string } }) =>
        Promise.resolve(platformSettings.get(args.where.key) ?? null),
      upsert: (args: {
        where: { key: string };
        create: { key: string; valueEnc: string; updatedBy: string };
        update: { valueEnc: string; updatedBy: string };
      }) => {
        const existing = platformSettings.get(args.where.key);
        const row = existing
          ? { ...existing, ...args.update }
          : { ...args.create };
        platformSettings.set(args.where.key, row);
        return Promise.resolve(row);
      },
    },
    adminAuditLog: {
      create: (args: { data: Record<string, unknown> }) => {
        auditEntries.push(args.data);
        return Promise.resolve(args.data);
      },
    },
  };

  const releaseNumberForTenant = vi.fn((_tenantId: string) => Promise.resolve());
  const claimNumberForTenant = vi.fn((_tenantId: string) => Promise.resolve('+15550001111'));
  const createAssistantForTenant = vi.fn((_tenantId: string) => Promise.resolve());

  function seed() {
    tenants.clear();
    subscriptions.clear();
    stripeEvents.clear();
    onboardings.clear();
    platformSettings.clear();
    auditEntries.length = 0;
    prices.clear();
    stripeSubscriptions.clear();
    sessions.clear();
    customersCreated.length = 0;
    sessionCreates.length = 0;
    portalCreates.length = 0;
    subscriptionRetrieves.length = 0;
    customerSeq = 0;
    sessionSeq = 0;
    rowSeq = 0;
    nextSessionSubscription = null;
    releaseNumberForTenant.mockClear();
    claimNumberForTenant.mockClear();
    createAssistantForTenant.mockClear();

    tenants.set('tenant_usd', {
      id: 'tenant_usd', pricingRegion: 'USD', subscriptionStatus: 'TRIALING',
      monthlyMinuteLimit: 500, billingExempt: false,
    });
    tenants.set('tenant_cad', {
      id: 'tenant_cad', pricingRegion: 'CAD', subscriptionStatus: 'TRIALING',
      monthlyMinuteLimit: 500, billingExempt: false,
    });
    tenants.set('tenant_exempt', {
      id: 'tenant_exempt', pricingRegion: 'USD', subscriptionStatus: 'ACTIVE',
      monthlyMinuteLimit: 500, billingExempt: true,
    });

    prices.set('price_starter_usd', { id: 'price_starter_usd', currency: 'usd' });
    prices.set('price_starter_cad', { id: 'price_starter_cad', currency: 'cad' });
    prices.set('price_core_usd', { id: 'price_core_usd', currency: 'usd' });
    prices.set('price_core_cad', { id: 'price_core_cad', currency: 'cad' });
    prices.set('price_glove_usd', { id: 'price_glove_usd', currency: 'usd' });
    prices.set('price_glove_cad', { id: 'price_glove_cad', currency: 'cad' });

    onboardings.set('tenant_usd', {
      tenantId: 'tenant_usd', hasConfiguredProfile: true, hasConfiguredPrompt: true,
      hasTestedVoice: true, isActive: true, completedAt: new Date(),
    });
  }

  return {
    tenants, subscriptions, stripeEvents, onboardings, platformSettings, auditEntries,
    prices, stripeSubscriptions, sessions,
    customersCreated, sessionCreates, portalCreates, subscriptionRetrieves,
    prisma, FakeStripe, stripeSub,
    releaseNumberForTenant, claimNumberForTenant, createAssistantForTenant,
    seed,
    setNextSessionSubscription: (id: string | null) => {
      nextSessionSubscription = id;
    },
  };
});

vi.mock('../lib/prisma', () => ({ prisma: state.prisma }));
vi.mock('./phone-pool.service', () => ({
  releaseNumberForTenant: state.releaseNumberForTenant,
  claimNumberForTenant: state.claimNumberForTenant,
}));
vi.mock('./vapi.service', () => ({
  createAssistantForTenant: state.createAssistantForTenant,
}));
vi.mock('stripe', () => ({ default: state.FakeStripe }));

import { env } from '../config/env';
import {
  applySubscription,
  assertBillingAllowsActivation,
  completeCheckout,
  createCheckoutSession,
  createPortalSession,
  getBillingStatus,
  handleStripeEvent,
  mapStripeStatus,
  recordStripeEvent,
  tierForPriceId,
} from './billing.service';
import { activate } from './onboarding.service';
import { HttpError } from '../lib/http';

type StripeSubLike = Parameters<typeof applySubscription>[0];

function seedTrialingSubscription(tenantId = 'tenant_usd') {
  const sub = state.stripeSub({ metadata: { tenantId, tier: 'CORE' } });
  state.stripeSubscriptions.set('sub_1', sub);
  return sub;
}

beforeEach(() => {
  state.seed();
});

/* --------------------------------- checkout ------------------------------ */

describe('createCheckoutSession', () => {
  it('builds a USD Core session from the tenant pricingRegion, with a 7-day card-required trial', async () => {
    const { url } = await createCheckoutSession({
      tenantId: 'tenant_usd',
      email: 'owner@alpha.test',
      tier: 'CORE',
    });
    expect(url).toContain('https://checkout.stripe.test/');
    expect(state.sessionCreates).toHaveLength(1);
    const args = state.sessionCreates[0] as {
      line_items: Array<{ price: string }>;
      subscription_data: { trial_period_days: number; metadata: { tenantId: string } };
      payment_method_collection: string;
      client_reference_id: string;
      metadata: { tenantId: string; tier: string };
    };
    expect(args.line_items).toEqual([{ price: 'price_core_usd', quantity: 1 }]);
    expect(args.subscription_data.trial_period_days).toBe(7);
    expect(args.subscription_data.metadata.tenantId).toBe('tenant_usd');
    expect(args.payment_method_collection).toBe('always');
    expect(args.client_reference_id).toBe('tenant_usd');
    expect(args.metadata).toEqual({ tenantId: 'tenant_usd', tier: 'CORE' });
    // The attempt is recorded: a customer exists, no subscription yet.
    const row = state.subscriptions.get('tenant_usd');
    expect(row?.stripeCustomerId).toBe('cus_1');
    expect(row?.stripeSubscriptionId).toBeNull();
    expect(row?.status).toBe('INCOMPLETE');
  });

  it('charges a CAD tenant the CAD Starter price (checkout reads Tenant.pricingRegion)', async () => {
    await createCheckoutSession({ tenantId: 'tenant_cad', email: 'owner@beta.test', tier: 'STARTER' });
    const args = state.sessionCreates[0] as { line_items: Array<{ price: string }> };
    expect(args.line_items).toEqual([{ price: 'price_starter_cad', quantity: 1 }]);
    expect(state.subscriptions.get('tenant_cad')?.pricingRegion).toBe('CAD');
  });

  it('adds the white glove one-time price beside the subscription when requested', async () => {
    await createCheckoutSession({
      tenantId: 'tenant_usd',
      email: 'owner@alpha.test',
      tier: 'CORE',
      whiteGlove: true,
    });
    const args = state.sessionCreates[0] as { line_items: Array<{ price: string }> };
    expect(args.line_items).toEqual([
      { price: 'price_core_usd', quantity: 1 },
      { price: 'price_glove_usd', quantity: 1 },
    ]);
  });

  it('reuses the Stripe customer across attempts instead of creating a second', async () => {
    await createCheckoutSession({ tenantId: 'tenant_usd', email: 'owner@alpha.test', tier: 'CORE' });
    await createCheckoutSession({ tenantId: 'tenant_usd', email: 'owner@alpha.test', tier: 'STARTER' });
    expect(state.customersCreated).toHaveLength(1);
  });

  it('refuses a second checkout while a subscription is trialing', async () => {
    seedTrialingSubscription();
    await applySubscription(state.stripeSubscriptions.get('sub_1') as never);
    await expect(
      createCheckoutSession({ tenantId: 'tenant_usd', email: 'owner@alpha.test', tier: 'CORE' }),
    ).rejects.toMatchObject({ status: 409, code: 'ALREADY_SUBSCRIBED' });
  });

  it('aborts before any session when the configured price is in the wrong currency', async () => {
    const saved = env.STRIPE_PRICE_CORE_CAD;
    env.STRIPE_PRICE_CORE_CAD = 'price_core_usd'; // a USD price pasted into the CAD slot
    try {
      await expect(
        createCheckoutSession({ tenantId: 'tenant_cad', email: 'owner@beta.test', tier: 'CORE' }),
      ).rejects.toMatchObject({ status: 500, code: 'BILLING_MISCONFIGURED' });
      expect(state.sessionCreates).toHaveLength(0);
    } finally {
      env.STRIPE_PRICE_CORE_CAD = saved;
    }
  });

  it('refuses with BILLING_NOT_CONFIGURED when the price id for the tier and region is unset', async () => {
    const saved = env.STRIPE_PRICE_STARTER_CAD;
    env.STRIPE_PRICE_STARTER_CAD = undefined;
    try {
      await expect(
        createCheckoutSession({ tenantId: 'tenant_cad', email: 'owner@beta.test', tier: 'STARTER' }),
      ).rejects.toMatchObject({ status: 503, code: 'BILLING_NOT_CONFIGURED' });
    } finally {
      env.STRIPE_PRICE_STARTER_CAD = saved;
    }
  });

  it('refuses with BILLING_NOT_CONFIGURED when the secret key is unset', async () => {
    const saved = env.STRIPE_SECRET_KEY;
    env.STRIPE_SECRET_KEY = undefined;
    try {
      await expect(
        createCheckoutSession({ tenantId: 'tenant_usd', email: 'owner@alpha.test', tier: 'CORE' }),
      ).rejects.toMatchObject({ status: 503, code: 'BILLING_NOT_CONFIGURED' });
      await expect(createPortalSession({ tenantId: 'tenant_usd' })).rejects.toMatchObject({
        status: 503,
        code: 'BILLING_NOT_CONFIGURED',
      });
      const status = await getBillingStatus('tenant_usd');
      expect(status.configured).toBe(false);
    } finally {
      env.STRIPE_SECRET_KEY = saved;
    }
  });
});

/* ----------------------------- checkout complete -------------------------- */

describe('completeCheckout (the return path)', () => {
  it('applies the subscription: TRIALING, trial end recorded, Core cap of 950', async () => {
    seedTrialingSubscription();
    state.setNextSessionSubscription('sub_1');
    await createCheckoutSession({ tenantId: 'tenant_usd', email: 'owner@alpha.test', tier: 'CORE' });
    const sessionId = [...state.sessions.keys()][0];

    const status = await completeCheckout({ tenantId: 'tenant_usd', sessionId });
    expect(status.state).toBe('TRIALING');
    expect(status.tier).toBe('CORE');
    expect(status.trialEndsAt).toBe(new Date(1760604800 * 1000).toISOString());
    expect(status.monthlyMinuteLimit).toBe(950);

    const tenant = state.tenants.get('tenant_usd');
    expect(tenant?.subscriptionStatus).toBe('TRIALING');
    expect(tenant?.monthlyMinuteLimit).toBe(950);
    const row = state.subscriptions.get('tenant_usd');
    expect(row?.stripeSubscriptionId).toBe('sub_1');
    expect(row?.status).toBe('TRIALING');
  });

  it('sets the Starter cap of 300 minutes', async () => {
    const sub = state.stripeSub({
      id: 'sub_starter',
      metadata: { tenantId: 'tenant_cad', tier: 'STARTER' },
      items: { data: [{ price: { id: 'price_starter_cad' }, current_period_end: 1763196800 }] },
    });
    state.stripeSubscriptions.set('sub_starter', sub);
    state.setNextSessionSubscription('sub_starter');
    await createCheckoutSession({ tenantId: 'tenant_cad', email: 'owner@beta.test', tier: 'STARTER' });
    const sessionId = [...state.sessions.keys()][0];
    const status = await completeCheckout({ tenantId: 'tenant_cad', sessionId });
    expect(status.tier).toBe('STARTER');
    expect(status.monthlyMinuteLimit).toBe(300);
    expect(state.subscriptions.get('tenant_cad')?.pricingRegion).toBe('CAD');
  });

  it("refuses a session that belongs to another tenant's checkout", async () => {
    seedTrialingSubscription();
    state.setNextSessionSubscription('sub_1');
    await createCheckoutSession({ tenantId: 'tenant_usd', email: 'owner@alpha.test', tier: 'CORE' });
    const sessionId = [...state.sessions.keys()][0];
    await expect(
      completeCheckout({ tenantId: 'tenant_cad', sessionId }),
    ).rejects.toMatchObject({ status: 403 });
    expect(state.subscriptions.get('tenant_cad')).toBeUndefined();
  });
});

/* ------------------------------- webhook apply ---------------------------- */

describe('webhook events through handleStripeEvent', () => {
  function sessionCompletedEvent() {
    return {
      id: 'evt_complete_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', subscription: 'sub_1' } },
    } as never;
  }

  it('checkout.session.completed reaches the identical end state as the return path', async () => {
    seedTrialingSubscription();
    await handleStripeEvent(sessionCompletedEvent());
    const row = state.subscriptions.get('tenant_usd');
    expect(row?.status).toBe('TRIALING');
    expect(row?.stripeSubscriptionId).toBe('sub_1');
    expect(state.tenants.get('tenant_usd')?.monthlyMinuteLimit).toBe(950);
    expect(state.tenants.get('tenant_usd')?.subscriptionStatus).toBe('TRIALING');
  });

  it('applying the same subscription twice changes nothing the second time', async () => {
    seedTrialingSubscription();
    await handleStripeEvent(sessionCompletedEvent());
    const afterFirst = { ...state.subscriptions.get('tenant_usd') };
    await handleStripeEvent(sessionCompletedEvent());
    expect(state.subscriptions.get('tenant_usd')).toEqual(afterFirst);
  });

  it('a completed webhook for a second, different subscription id is ignored', async () => {
    seedTrialingSubscription();
    await handleStripeEvent(sessionCompletedEvent());
    const second = state.stripeSub({ id: 'sub_2' });
    state.stripeSubscriptions.set('sub_2', second);
    await handleStripeEvent({
      id: 'evt_complete_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_y', subscription: 'sub_2' } },
    } as never);
    expect(state.subscriptions.get('tenant_usd')?.stripeSubscriptionId).toBe('sub_1');
  });

  it('invoice.paid keeps the mirror ACTIVE after conversion', async () => {
    const sub = state.stripeSub({ status: 'active', trial_start: null, trial_end: null });
    state.stripeSubscriptions.set('sub_1', sub);
    await handleStripeEvent({
      id: 'evt_paid_1',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_1',
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
        },
      },
    } as never);
    expect(state.subscriptions.get('tenant_usd')?.status).toBe('ACTIVE');
    expect(state.tenants.get('tenant_usd')?.subscriptionStatus).toBe('ACTIVE');
  });

  it('invoice.payment_failed mirrors PAST_DUE and does NOT tear anything down', async () => {
    seedTrialingSubscription();
    await handleStripeEvent(sessionCompletedEvent());
    const failed = state.stripeSub({ status: 'past_due' });
    state.stripeSubscriptions.set('sub_1', failed);
    await handleStripeEvent({
      id: 'evt_failed_1',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_2',
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
        },
      },
    } as never);
    expect(state.subscriptions.get('tenant_usd')?.status).toBe('PAST_DUE');
    expect(state.tenants.get('tenant_usd')?.subscriptionStatus).toBe('PAST_DUE');
    // The receptionist keeps answering during Stripe's retry window.
    expect(state.releaseNumberForTenant).not.toHaveBeenCalled();
    expect(state.onboardings.get('tenant_usd')?.isActive).toBe(true);
  });

  it('customer.subscription.deleted cancels and runs the full teardown, idempotently', async () => {
    seedTrialingSubscription();
    await handleStripeEvent(sessionCompletedEvent());
    const deleted = state.stripeSub({ status: 'canceled' });
    const event = {
      id: 'evt_deleted_1',
      type: 'customer.subscription.deleted',
      data: { object: deleted },
    } as never;
    await handleStripeEvent(event);
    expect(state.subscriptions.get('tenant_usd')?.status).toBe('CANCELED');
    expect(state.tenants.get('tenant_usd')?.subscriptionStatus).toBe('CANCELED');
    expect(state.releaseNumberForTenant).toHaveBeenCalledWith('tenant_usd');
    expect(state.onboardings.get('tenant_usd')?.isActive).toBe(false);

    // Running the deleted handler again changes nothing further.
    await handleStripeEvent(event);
    expect(state.tenants.get('tenant_usd')?.subscriptionStatus).toBe('CANCELED');
    expect(state.onboardings.get('tenant_usd')?.isActive).toBe(false);
  });

  it('customer.subscription.updated records cancel-at-period-end without cutting service', async () => {
    seedTrialingSubscription();
    await handleStripeEvent(sessionCompletedEvent());
    const updated = state.stripeSub({ status: 'active', cancel_at_period_end: true });
    await handleStripeEvent({
      id: 'evt_updated_1',
      type: 'customer.subscription.updated',
      data: { object: updated },
    } as never);
    const row = state.subscriptions.get('tenant_usd');
    expect(row?.status).toBe('ACTIVE');
    expect(row?.cancelAtPeriodEnd).toBe(true);
    expect(state.releaseNumberForTenant).not.toHaveBeenCalled();
  });

  it('an incomplete subscription grants nothing', async () => {
    const incomplete = state.stripeSub({ status: 'incomplete' });
    await applySubscription(incomplete as StripeSubLike);
    expect(state.subscriptions.get('tenant_usd')?.status).toBe('INCOMPLETE');
    expect(state.tenants.get('tenant_usd')?.subscriptionStatus).toBe('TRIALING'); // untouched default
    expect(state.tenants.get('tenant_usd')?.monthlyMinuteLimit).toBe(500); // untouched default
  });
});

/* ------------------------------ event ledger ------------------------------ */

describe('recordStripeEvent', () => {
  it('records an event once; a redelivery is reported as already handled', async () => {
    const event = { id: 'evt_ledger_1', type: 'invoice.paid' } as never;
    await expect(recordStripeEvent(event)).resolves.toBe(true);
    await expect(recordStripeEvent(event)).resolves.toBe(false);
  });
});

/* --------------------------------- portal --------------------------------- */

describe('createPortalSession', () => {
  it('returns a portal URL for a tenant with a Stripe customer', async () => {
    seedTrialingSubscription();
    await applySubscription(state.stripeSubscriptions.get('sub_1') as never);
    const { url } = await createPortalSession({ tenantId: 'tenant_usd' });
    expect(url).toBe('https://billing.stripe.test/portal');
    expect(state.portalCreates[0]).toMatchObject({ customer: 'cus_1' });
  });

  it('refuses with NO_BILLING_ACCOUNT when the tenant never checked out', async () => {
    await expect(createPortalSession({ tenantId: 'tenant_cad' })).rejects.toMatchObject({
      status: 409,
      code: 'NO_BILLING_ACCOUNT',
    });
  });
});

/* ----------------------------- activation gate ---------------------------- */

describe('activation billing gate', () => {
  it('refuses activation with no subscription (402 BILLING_REQUIRED) and provisions nothing', async () => {
    state.onboardings.set('tenant_cad', {
      tenantId: 'tenant_cad', hasConfiguredProfile: true, hasConfiguredPrompt: true,
      hasTestedVoice: true, isActive: false, completedAt: null,
    });
    await expect(assertBillingAllowsActivation('tenant_cad')).rejects.toMatchObject({
      status: 402,
      code: 'BILLING_REQUIRED',
    });
    await expect(activate('tenant_cad')).rejects.toBeInstanceOf(HttpError);
    expect(state.claimNumberForTenant).not.toHaveBeenCalled();
    expect(state.createAssistantForTenant).not.toHaveBeenCalled();
    expect(state.onboardings.get('tenant_cad')?.isActive).toBe(false);
  });

  it('lets a billing-exempt tenant activate exactly as before Stripe', async () => {
    state.onboardings.set('tenant_exempt', {
      tenantId: 'tenant_exempt', hasConfiguredProfile: true, hasConfiguredPrompt: true,
      hasTestedVoice: true, isActive: false, completedAt: null,
    });
    const status = await activate('tenant_exempt');
    expect(status.isActive).toBe(true);
    expect(state.claimNumberForTenant).toHaveBeenCalledWith('tenant_exempt');
  });

  it('provisions through the existing helpers once the trial has started', async () => {
    state.onboardings.set('tenant_usd', {
      tenantId: 'tenant_usd', hasConfiguredProfile: true, hasConfiguredPrompt: true,
      hasTestedVoice: true, isActive: false, completedAt: null,
    });
    seedTrialingSubscription();
    await applySubscription(state.stripeSubscriptions.get('sub_1') as never);
    const status = await activate('tenant_usd');
    expect(status.isActive).toBe(true);
    expect(state.claimNumberForTenant).toHaveBeenCalledWith('tenant_usd');
    expect(state.createAssistantForTenant).toHaveBeenCalledWith('tenant_usd');
  });
});

/* --------------------------------- mappings -------------------------------- */

describe('status and tier mappings', () => {
  it('maps Stripe statuses onto the app vocabulary', () => {
    expect(mapStripeStatus('trialing')).toBe('TRIALING');
    expect(mapStripeStatus('active')).toBe('ACTIVE');
    expect(mapStripeStatus('past_due')).toBe('PAST_DUE');
    expect(mapStripeStatus('unpaid')).toBe('PAST_DUE');
    expect(mapStripeStatus('canceled')).toBe('CANCELED');
    expect(mapStripeStatus('incomplete_expired')).toBe('CANCELED');
    expect(mapStripeStatus('incomplete')).toBeNull();
  });

  it('resolves tiers from configured price ids only', () => {
    expect(tierForPriceId('price_core_usd')).toBe('CORE');
    expect(tierForPriceId('price_starter_cad')).toBe('STARTER');
    expect(tierForPriceId('price_glove_usd')).toBeNull();
    expect(tierForPriceId('price_unknown')).toBeNull();
    expect(tierForPriceId(null)).toBeNull();
  });
});
