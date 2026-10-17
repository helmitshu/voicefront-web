import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route tests for Build 2 billing: POST /api/billing/checkout,
 * /checkout/complete, GET /status, POST /portal, and the Stripe webhook.
 * Prisma is an in-memory fake (the real phone-pool teardown runs against
 * it), Stripe is a controllable fake client, JWT is the app's real code.
 * The main test app mounts the webhook's raw body parser BEFORE the JSON
 * parser, exactly like app.ts; a second app mounts JSON first to prove
 * the ordering is what makes signature verification work.
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
  interface FakeUser {
    id: string;
    tenantId: string;
    email: string;
    role: string;
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
    isActive: boolean;
  }
  interface FakePoolNumber {
    id: string;
    number: string;
    assignedTenantId: string | null;
  }
  interface FakeSettings {
    tenantId: string;
    inboundPhoneNumber: string | null;
  }

  const tenants = new Map<string, FakeTenant>();
  const users = new Map<string, FakeUser>();
  const subscriptions = new Map<string, FakeSubscriptionRow>();
  const stripeEvents = new Map<string, { id: string; type: string }>();
  const onboardings = new Map<string, FakeOnboarding>();
  const pool = new Map<string, FakePoolNumber>();
  const settings = new Map<string, FakeSettings>();
  const platformSettings = new Map<string, { key: string; valueEnc: string; updatedBy: string }>();
  const auditEntries: Array<Record<string, unknown>> = [];

  /* ------------------------------ fake Stripe ---------------------------- */
  const prices = new Map<string, { id: string; currency: string }>();
  const stripeSubscriptions = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const sessionCreates: Array<Record<string, unknown>> = [];
  const subscriptionRetrieves: string[] = [];
  let customerSeq = 0;
  let sessionSeq = 0;
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

  class FakeStripe {
    customers = {
      create: (args: Record<string, unknown>) => {
        customerSeq += 1;
        return Promise.resolve({ id: `cus_${customerSeq}`, ...args });
      },
    };
    prices = {
      retrieve: (id: string) => {
        const price = prices.get(id);
        return price ? Promise.resolve(price) : Promise.reject(new Error(`No such price: ${id}`));
      },
    };
    checkout = {
      sessions: {
        create: (args: Record<string, unknown>) => {
          sessionSeq += 1;
          const id = `cs_${sessionSeq}`;
          const session = {
            id,
            url: `https://checkout.stripe.test/${id}`,
            client_reference_id: args.client_reference_id,
            metadata: args.metadata,
            subscription: nextSessionSubscription,
          };
          sessions.set(id, session);
          sessionCreates.push(args);
          return Promise.resolve(session);
        },
        retrieve: (id: string) => {
          const session = sessions.get(id);
          return session
            ? Promise.resolve(session)
            : Promise.reject(new Error(`No such session: ${id}`));
        },
      },
    };
    subscriptions = {
      retrieve: (id: string) => {
        subscriptionRetrieves.push(id);
        const sub = stripeSubscriptions.get(id);
        return sub ? Promise.resolve(sub) : Promise.reject(new Error(`No such subscription: ${id}`));
      },
    };
    billingPortal = {
      sessions: {
        create: (_args: Record<string, unknown>) =>
          Promise.resolve({ url: 'https://billing.stripe.test/portal' }),
      },
    };
    webhooks = {
      constructEvent: (body: Buffer, signature: string, _secret: string) => {
        if (signature !== 'sig_valid') throw new Error('signature mismatch');
        return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      },
    };
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
    user: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(users.get(args.where.id) ?? null),
    },
    subscription: {
      findUnique: (args: {
        where: { tenantId?: string; stripeSubscriptionId?: string; stripeCustomerId?: string };
      }) => {
        const { where } = args;
        if (where.tenantId) return Promise.resolve(subscriptions.get(where.tenantId) ?? null);
        const row = [...subscriptions.values()].find(
          (r) =>
            (where.stripeSubscriptionId !== undefined &&
              r.stripeSubscriptionId === where.stripeSubscriptionId) ||
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
      updateMany: (args: { where: { tenantId: string }; data: Partial<FakeOnboarding> }) => {
        const row = onboardings.get(args.where.tenantId);
        if (row) Object.assign(row, args.data);
        return Promise.resolve({ count: row ? 1 : 0 });
      },
    },
    pooledNumber: {
      findUnique: (args: { where: { assignedTenantId?: string; number?: string; id?: string } }) => {
        const row = [...pool.values()].find(
          (n) =>
            (args.where.assignedTenantId !== undefined && n.assignedTenantId === args.where.assignedTenantId) ||
            (args.where.number !== undefined && n.number === args.where.number) ||
            (args.where.id !== undefined && n.id === args.where.id),
        );
        return Promise.resolve(row ?? null);
      },
      update: (args: { where: { id: string }; data: Partial<FakePoolNumber> }) => {
        const row = pool.get(args.where.id);
        if (!row) return Promise.reject(new Error('pool number missing'));
        Object.assign(row, args.data);
        return Promise.resolve(row);
      },
    },
    agentSettings: {
      findUnique: (args: { where: { tenantId: string } }) =>
        Promise.resolve(settings.get(args.where.tenantId) ?? null),
      update: (args: { where: { tenantId: string }; data: Partial<FakeSettings> }) => {
        const row = settings.get(args.where.tenantId);
        if (!row) return Promise.reject(new Error('settings missing'));
        Object.assign(row, args.data);
        return Promise.resolve(row);
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
        const row = existing ? { ...existing, ...args.update } : { ...args.create };
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

  function seed() {
    tenants.clear();
    users.clear();
    subscriptions.clear();
    stripeEvents.clear();
    onboardings.clear();
    pool.clear();
    settings.clear();
    platformSettings.clear();
    auditEntries.length = 0;
    prices.clear();
    stripeSubscriptions.clear();
    sessions.clear();
    sessionCreates.length = 0;
    subscriptionRetrieves.length = 0;
    customerSeq = 0;
    sessionSeq = 0;
    rowSeq = 0;
    nextSessionSubscription = null;

    tenants.set('tenant_usd', {
      id: 'tenant_usd', pricingRegion: 'USD', subscriptionStatus: 'TRIALING',
      monthlyMinuteLimit: 500, billingExempt: false,
    });
    tenants.set('tenant_cad', {
      id: 'tenant_cad', pricingRegion: 'CAD', subscriptionStatus: 'TRIALING',
      monthlyMinuteLimit: 500, billingExempt: false,
    });
    users.set('user_usd', { id: 'user_usd', tenantId: 'tenant_usd', email: 'owner@alpha.test', role: 'OWNER' });
    users.set('user_usd_manager', { id: 'user_usd_manager', tenantId: 'tenant_usd', email: 'mgr@alpha.test', role: 'MANAGER' });
    users.set('user_usd_agent', { id: 'user_usd_agent', tenantId: 'tenant_usd', email: 'staff@alpha.test', role: 'AGENT' });
    users.set('user_cad', { id: 'user_cad', tenantId: 'tenant_cad', email: 'owner@beta.test', role: 'OWNER' });

    prices.set('price_starter_usd', { id: 'price_starter_usd', currency: 'usd' });
    prices.set('price_starter_cad', { id: 'price_starter_cad', currency: 'cad' });
    prices.set('price_core_usd', { id: 'price_core_usd', currency: 'usd' });
    prices.set('price_core_cad', { id: 'price_core_cad', currency: 'cad' });
    prices.set('price_glove_usd', { id: 'price_glove_usd', currency: 'usd' });
    prices.set('price_glove_cad', { id: 'price_glove_cad', currency: 'cad' });

    onboardings.set('tenant_usd', { tenantId: 'tenant_usd', isActive: true });
    pool.set('pool_1', { id: 'pool_1', number: '+15550001111', assignedTenantId: 'tenant_usd' });
    settings.set('tenant_usd', { tenantId: 'tenant_usd', inboundPhoneNumber: '+15550001111' });
  }

  return {
    tenants, users, subscriptions, stripeEvents, onboardings, pool, settings,
    platformSettings, auditEntries,
    stripeSubscriptions, sessions, sessionCreates, subscriptionRetrieves,
    prisma, FakeStripe, stripeSub, seed,
    setNextSessionSubscription: (id: string | null) => {
      nextSessionSubscription = id;
    },
  };
});

vi.mock('../lib/prisma', () => ({ prisma: state.prisma }));
vi.mock('../services/vapi.service', () => ({
  configurePhoneNumberWebhook: vi.fn().mockResolvedValue(undefined),
  fetchVapiPhoneNumbers: vi.fn().mockResolvedValue([]),
  getVapiPhoneNumber: vi.fn().mockResolvedValue(null),
  createAssistantForTenant: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('stripe', () => ({ default: state.FakeStripe }));

import { billingRouter } from './billing.routes';
import { errorHandler } from '../middleware/error';
import { signAccessToken } from '../lib/jwt';
import { env } from '../config/env';

/* ------------------------------ test servers ------------------------------ */

let server: Server;
let base = '';
let jsonFirstServer: Server;
let jsonFirstBase = '';

const tokenOwner = () => signAccessToken({ userId: 'user_usd', tenantId: 'tenant_usd', role: 'OWNER' });
const tokenManager = () => signAccessToken({ userId: 'user_usd_manager', tenantId: 'tenant_usd', role: 'MANAGER' });
const tokenAgent = () => signAccessToken({ userId: 'user_usd_agent', tenantId: 'tenant_usd', role: 'AGENT' });
const tokenCad = () => signAccessToken({ userId: 'user_cad', tenantId: 'tenant_cad', role: 'OWNER' });

async function listen(app: express.Express): Promise<{ srv: Server; url: string }> {
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('no test server address');
  return { srv, url: `http://127.0.0.1:${addr.port}` };
}

beforeAll(async () => {
  // Mirrors app.ts: raw parser on the webhook path BEFORE the JSON parser.
  const app = express();
  app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use('/api/billing', billingRouter);
  app.use(errorHandler);
  const built = await listen(app);
  server = built.srv;
  base = built.url;

  // The same router behind a JSON-first app: bodies arrive parsed, so the
  // webhook handler never sees raw bytes and signature checks must fail.
  const app2 = express();
  app2.use(express.json());
  app2.use('/api/billing', billingRouter);
  app2.use(errorHandler);
  const built2 = await listen(app2);
  jsonFirstServer = built2.srv;
  jsonFirstBase = built2.url;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => jsonFirstServer.close(() => resolve()));
});

beforeEach(() => {
  state.seed();
});

/* --------------------------------- helpers -------------------------------- */

async function post(path: string, token: string | null, body?: unknown, url = base) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function get(path: string, token: string | null, url = base) {
  const res = await fetch(`${url}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function webhook(event: Record<string, unknown>, signature = 'sig_valid', url = base) {
  const res = await fetch(`${url}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: JSON.stringify(event),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

function sessionCompletedEvent(id = 'evt_complete_1') {
  return {
    id,
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_whatever', subscription: 'sub_1' } },
  };
}

/** Drives tenant_usd into a live TRIALING state through the webhook. */
async function seedLiveTrial() {
  state.stripeSubscriptions.set('sub_1', state.stripeSub());
  const res = await webhook(sessionCompletedEvent());
  expect(res.status).toBe(200);
  expect(state.subscriptions.get('tenant_usd')?.status).toBe('TRIALING');
}

/* --------------------------------- checkout ------------------------------- */

describe('POST /api/billing/checkout', () => {
  it('creates a checkout session for the owner and returns the Stripe URL', async () => {
    const res = await post('/api/billing/checkout', tokenOwner(), { tier: 'CORE' });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('https://checkout.stripe.test/');
    const args = state.sessionCreates[0] as { line_items: Array<{ price: string }> };
    expect(args.line_items).toEqual([{ price: 'price_core_usd', quantity: 1 }]);
  });

  it('is OWNER-only: managers and agents get 403, anonymous gets 401', async () => {
    expect((await post('/api/billing/checkout', tokenManager(), { tier: 'CORE' })).status).toBe(403);
    expect((await post('/api/billing/checkout', tokenAgent(), { tier: 'CORE' })).status).toBe(403);
    expect((await post('/api/billing/checkout', null, { tier: 'CORE' })).status).toBe(401);
    expect(state.sessionCreates).toHaveLength(0);
  });

  it('refuses GROWTH with TIER_NOT_AVAILABLE (waitlist, never sold)', async () => {
    const res = await post('/api/billing/checkout', tokenOwner(), { tier: 'GROWTH' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TIER_NOT_AVAILABLE');
    expect(state.sessionCreates).toHaveLength(0);
  });

  it('rejects a nonsense tier at validation', async () => {
    const res = await post('/api/billing/checkout', tokenOwner(), { tier: 'ENTERPRISE' });
    expect(res.status).toBe(400);
    expect(state.sessionCreates).toHaveLength(0);
  });

  it('cannot be smuggled a price: extra price/amount/currency/region fields are rejected outright', async () => {
    const res = await post('/api/billing/checkout', tokenOwner(), {
      tier: 'CORE',
      price: 'price_starter_usd',
      amount: 1,
      currency: 'cad',
      region: 'CAD',
      pricingRegion: 'CAD',
    });
    expect(res.status).toBe(400);
    expect(state.sessionCreates).toHaveLength(0);
  });

  it('refuses a second checkout while TRIALING with 409 ALREADY_SUBSCRIBED', async () => {
    await seedLiveTrial();
    const res = await post('/api/billing/checkout', tokenOwner(), { tier: 'CORE' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SUBSCRIBED');
  });
});

/* ------------------------------ checkout return ---------------------------- */

describe('POST /api/billing/checkout/complete and GET /api/billing/status', () => {
  it('status starts at NOT_STARTED with billing configured', async () => {
    const res = await get('/api/billing/status', tokenOwner());
    expect(res.status).toBe(200);
    expect(res.body.billing.state).toBe('NOT_STARTED');
    expect(res.body.billing.configured).toBe(true);
    expect(res.body.billing.tier).toBeNull();
  });

  it('status requires auth', async () => {
    expect((await get('/api/billing/status', null)).status).toBe(401);
  });

  it('the return path applies the trial and status reflects it', async () => {
    state.stripeSubscriptions.set('sub_1', state.stripeSub());
    state.setNextSessionSubscription('sub_1');
    const created = await post('/api/billing/checkout', tokenOwner(), { tier: 'CORE' });
    expect(created.status).toBe(200);
    const sessionId = [...state.sessions.keys()][0];

    const res = await post('/api/billing/checkout/complete', tokenOwner(), { sessionId });
    expect(res.status).toBe(200);
    expect(res.body.billing.state).toBe('TRIALING');
    expect(res.body.billing.trialEndsAt).toBe(new Date(1760604800 * 1000).toISOString());
    expect(res.body.billing.monthlyMinuteLimit).toBe(950);

    const status = await get('/api/billing/status', tokenAgent());
    expect(status.body.billing.state).toBe('TRIALING');
  });

  it("refuses to complete another tenant's session", async () => {
    state.stripeSubscriptions.set('sub_1', state.stripeSub());
    state.setNextSessionSubscription('sub_1');
    await post('/api/billing/checkout', tokenOwner(), { tier: 'CORE' });
    const sessionId = [...state.sessions.keys()][0];
    const res = await post('/api/billing/checkout/complete', tokenCad(), { sessionId });
    expect(res.status).toBe(403);
    expect(state.subscriptions.get('tenant_cad')).toBeUndefined();
  });
});

/* ---------------------------------- portal --------------------------------- */

describe('POST /api/billing/portal', () => {
  it('refuses with NO_BILLING_ACCOUNT before any checkout', async () => {
    const res = await post('/api/billing/portal', tokenOwner(), {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_BILLING_ACCOUNT');
  });

  it('returns the portal URL once a customer exists, and is OWNER-only', async () => {
    const created = await post('/api/billing/checkout', tokenOwner(), { tier: 'CORE' });
    expect(created.status).toBe(200);
    const res = await post('/api/billing/portal', tokenOwner(), {});
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://billing.stripe.test/portal');
    expect((await post('/api/billing/portal', tokenAgent(), {})).status).toBe(403);
  });
});

/* ---------------------------------- webhook -------------------------------- */

describe('POST /api/billing/webhook', () => {
  it('applies checkout.session.completed and answers 200', async () => {
    state.stripeSubscriptions.set('sub_1', state.stripeSub());
    const res = await webhook(sessionCompletedEvent());
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(state.subscriptions.get('tenant_usd')?.status).toBe('TRIALING');
    expect(state.tenants.get('tenant_usd')?.monthlyMinuteLimit).toBe(950);
  });

  it('processes a redelivered event only once (ledger) and answers 200 both times', async () => {
    state.stripeSubscriptions.set('sub_1', state.stripeSub());
    const first = await webhook(sessionCompletedEvent());
    const second = await webhook(sessionCompletedEvent());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(state.subscriptionRetrieves).toHaveLength(1); // handler ran once
    expect(state.stripeEvents.size).toBe(1);
  });

  it('rejects a bad signature with 400 and writes nothing', async () => {
    state.stripeSubscriptions.set('sub_1', state.stripeSub());
    const res = await webhook(sessionCompletedEvent(), 'sig_forged');
    expect(res.status).toBe(400);
    expect(state.stripeEvents.size).toBe(0);
    expect(state.subscriptions.get('tenant_usd')).toBeUndefined();
    expect(state.subscriptionRetrieves).toHaveLength(0);
  });

  it('fails closed when the JSON parser ran first (raw body ordering matters)', async () => {
    state.stripeSubscriptions.set('sub_1', state.stripeSub());
    const res = await webhook(sessionCompletedEvent(), 'sig_valid', jsonFirstBase);
    expect(res.status).toBe(400);
    expect(state.subscriptions.get('tenant_usd')).toBeUndefined();
  });

  it('invoice.payment_failed mirrors PAST_DUE and keeps the number and activation', async () => {
    await seedLiveTrial();
    state.stripeSubscriptions.set('sub_1', state.stripeSub({ status: 'past_due' }));
    const res = await webhook({
      id: 'evt_failed_1',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_2',
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(state.subscriptions.get('tenant_usd')?.status).toBe('PAST_DUE');
    expect(state.pool.get('pool_1')?.assignedTenantId).toBe('tenant_usd');
    expect(state.settings.get('tenant_usd')?.inboundPhoneNumber).toBe('+15550001111');
    expect(state.onboardings.get('tenant_usd')?.isActive).toBe(true);
  });

  it('customer.subscription.deleted cancels, releases the number, and deactivates onboarding', async () => {
    await seedLiveTrial();
    const res = await webhook({
      id: 'evt_deleted_1',
      type: 'customer.subscription.deleted',
      data: { object: state.stripeSub({ status: 'canceled' }) },
    });
    expect(res.status).toBe(200);
    expect(state.subscriptions.get('tenant_usd')?.status).toBe('CANCELED');
    expect(state.tenants.get('tenant_usd')?.subscriptionStatus).toBe('CANCELED');
    expect(state.pool.get('pool_1')?.assignedTenantId).toBeNull();
    expect(state.settings.get('tenant_usd')?.inboundPhoneNumber).toBeNull();
    expect(state.onboardings.get('tenant_usd')?.isActive).toBe(false);
  });
});

/* ------------------------------- unconfigured ------------------------------ */

describe('when Stripe keys are unset', () => {
  it('checkout and webhook refuse with 503 and status reports configured: false', async () => {
    const saved = env.STRIPE_SECRET_KEY;
    env.STRIPE_SECRET_KEY = undefined;
    try {
      const checkout = await post('/api/billing/checkout', tokenOwner(), { tier: 'CORE' });
      expect(checkout.status).toBe(503);
      expect(checkout.body.error.code).toBe('BILLING_NOT_CONFIGURED');

      const status = await get('/api/billing/status', tokenOwner());
      expect(status.status).toBe(200);
      expect(status.body.billing.configured).toBe(false);

      const hook = await webhook(sessionCompletedEvent());
      expect(hook.status).toBe(503);
      expect(state.stripeEvents.size).toBe(0);
    } finally {
      env.STRIPE_SECRET_KEY = saved;
    }
  });
});
