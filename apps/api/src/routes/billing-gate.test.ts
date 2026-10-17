import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route tests for the founder's billing-gate switch:
 *  - GET/PATCH /api/admin/billing-gate (full admins only, audited flips);
 *  - POST /api/billing/comped-trial (403 while the gate is on; with the
 *    gate off it starts a no-card trial: exempt + TRIALING + the tier's
 *    minute cap, and the activation gate then lets the workspace live);
 *  - GET /api/billing/status carries { gateEnabled, configured };
 *  - signup while the gate is off creates a billing-exempt tenant, and
 *    while it is on creates an ordinary one (register and Google paths).
 *
 * Prisma is an in-memory fake; platform role resolution, the Google
 * verifier, and the audit writer are spies, in the same style as the
 * other admin/billing route suites. The billing service itself is real.
 */

const state = vi.hoisted(() => {
  interface FakeTenant {
    id: string;
    companyName: string;
    slug: string;
    industry: string;
    subscriptionStatus: string;
    monthlyMinuteLimit: number;
    billingExempt: boolean;
    pricingRegion: string;
    isBlocked: boolean;
  }
  interface FakeUser {
    id: string;
    tenantId: string;
    email: string;
    fullName: string;
    passwordHash: string;
    role: string;
    theme: string | null;
    calmMode: boolean | null;
    tenant: FakeTenant;
  }

  const tenants = new Map<string, FakeTenant>();
  const users = new Map<string, FakeUser>();
  const platformSettings = new Map<string, { key: string; valueEnc: string; updatedBy: string }>();
  const auditCalls: Array<{ adminEmail: string; action: string; target: string | null; detail: unknown }> = [];
  let seq = 0;

  const prisma = {
    tenant: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(tenants.get(args.where.id) ?? null),
      create: (args: { data: Partial<FakeTenant> & { companyName: string; slug: string } }) => {
        seq += 1;
        const tenant: FakeTenant = {
          id: `tenant_${seq}`,
          industry: 'CLINIC',
          subscriptionStatus: 'TRIALING',
          monthlyMinuteLimit: 500,
          billingExempt: false,
          pricingRegion: 'USD',
          isBlocked: false,
          ...args.data,
        } as FakeTenant;
        tenants.set(tenant.id, tenant);
        return Promise.resolve(tenant);
      },
      update: (args: { where: { id: string }; data: Partial<FakeTenant> }) => {
        const row = tenants.get(args.where.id);
        if (!row) return Promise.reject(new Error('tenant missing'));
        Object.assign(row, args.data);
        return Promise.resolve(row);
      },
    },
    user: {
      findUnique: (args: { where: { id?: string; email?: string } }) => {
        const row = [...users.values()].find(
          (u) =>
            (args.where.id !== undefined && u.id === args.where.id) ||
            (args.where.email !== undefined && u.email === args.where.email),
        );
        return Promise.resolve(row ?? null);
      },
      create: (args: {
        data: { tenantId: string; email: string; fullName: string; passwordHash: string; role: string };
      }) => {
        seq += 1;
        const tenant = tenants.get(args.data.tenantId);
        if (!tenant) return Promise.reject(new Error('tenant missing in fake'));
        const user: FakeUser = {
          id: `user_${seq}`,
          theme: null,
          calmMode: null,
          ...args.data,
          tenant,
        };
        users.set(user.id, user);
        return Promise.resolve(user);
      },
    },
    subscription: {
      findUnique: () => Promise.resolve(null),
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
    onboardingStatus: {
      create: (args: { data: { tenantId: string } }) => Promise.resolve({ ...args.data }),
    },
    agentSettings: {
      create: (args: { data: Record<string, unknown> }) => Promise.resolve({ ...args.data }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        tenant: prisma.tenant,
        user: prisma.user,
        onboardingStatus: prisma.onboardingStatus,
        agentSettings: prisma.agentSettings,
      }),
  };

  function seedUser(id: string, email: string, tenantId: string, role = 'OWNER'): FakeUser {
    const tenant = tenants.get(tenantId);
    if (!tenant) throw new Error('seed tenant first');
    const user: FakeUser = {
      id, tenantId, email, fullName: 'Seeded User', passwordHash: 'seeded-hash',
      role, theme: null, calmMode: null, tenant,
    };
    users.set(id, user);
    return user;
  }

  function seed() {
    tenants.clear();
    users.clear();
    platformSettings.clear();
    auditCalls.length = 0;
    seq = 0;

    tenants.set('tenant_platform', {
      id: 'tenant_platform', companyName: 'VoiceFront', slug: '__platform', industry: 'CLINIC',
      subscriptionStatus: 'ACTIVE', monthlyMinuteLimit: 500, billingExempt: true,
      pricingRegion: 'USD', isBlocked: false,
    });
    tenants.set('tenant_tester', {
      id: 'tenant_tester', companyName: 'Tester Dental', slug: 'tester-dental', industry: 'CLINIC',
      subscriptionStatus: 'TRIALING', monthlyMinuteLimit: 500, billingExempt: false,
      pricingRegion: 'USD', isBlocked: false,
    });
    seedUser('user_admin', 'founder@platform.test', 'tenant_platform');
    seedUser('user_support', 'support@platform.test', 'tenant_platform');
    seedUser('user_plain', 'customer@elsewhere.test', 'tenant_tester');
    seedUser('user_owner', 'tester@clinic.test', 'tenant_tester');
    seedUser('user_manager', 'manager@clinic.test', 'tenant_tester', 'MANAGER');
  }

  return { tenants, users, platformSettings, auditCalls, prisma, seed };
});

vi.mock('../lib/prisma', () => ({ prisma: state.prisma }));

vi.mock('../lib/jwt', () => ({
  verifyAccessToken: (token: string) => {
    if (token === 'admin-token') return { sub: 'user_admin', tid: 'tenant_platform', role: 'OWNER' };
    if (token === 'support-token') return { sub: 'user_support', tid: 'tenant_platform', role: 'OWNER' };
    if (token === 'plain-token') return { sub: 'user_plain', tid: 'tenant_tester', role: 'OWNER' };
    if (token === 'owner-token') return { sub: 'user_owner', tid: 'tenant_tester', role: 'OWNER' };
    if (token === 'manager-token') return { sub: 'user_manager', tid: 'tenant_tester', role: 'MANAGER' };
    throw new Error('invalid token');
  },
  signAccessToken: () => 'issued-token',
}));

const resolvePlatformRole = vi.fn(async (email: string) => {
  if (email === 'founder@platform.test') return 'ADMIN' as const;
  if (email === 'support@platform.test') return 'SUPPORT' as const;
  return null;
});
vi.mock('../services/platform-admin.service', () => ({
  PLATFORM_TENANT_SLUG: '__platform',
  resolvePlatformRole: (email: string) => resolvePlatformRole(email),
  addAdmin: vi.fn(),
  listAdmins: vi.fn().mockResolvedValue([]),
  removeAdmin: vi.fn(),
}));

vi.mock('../services/platform-config.service', () => ({
  SETTING_KEYS: [],
  SETTING_META: {},
  assertSettingKey: (key: string) => key,
  getSetting: vi.fn().mockResolvedValue({ value: null, source: 'unset' }),
  getSettingValue: vi.fn().mockResolvedValue(null),
  maskValue: (v: string) => v,
  recordAdminAction: (
    adminEmail: string,
    action: string,
    target: string | null,
    detail: unknown,
  ) => {
    state.auditCalls.push({ adminEmail, action, target, detail });
    return Promise.resolve();
  },
  setSetting: vi.fn().mockResolvedValue(undefined),
  unsetSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/demo.service', () => ({
  DEMO_TENANT_SLUG: '__demo',
  isDemoEnabled: vi.fn().mockResolvedValue(true),
  setDemoEnabled: vi.fn().mockResolvedValue(undefined),
  startDemoSession: vi.fn(),
  resumeDemoSession: vi.fn(),
  getDemoAppointments: vi.fn().mockResolvedValue([]),
  blockDemoSlot: vi.fn().mockResolvedValue([]),
  resetDemoSession: vi.fn().mockResolvedValue({}),
  createDemoLead: vi.fn(),
  setLeadMode: vi.fn().mockResolvedValue(undefined),
  listRecentDemoCalls: vi.fn().mockResolvedValue([]),
  getSalesConfig: vi.fn().mockResolvedValue({ agentName: 'Ava', founderName: 'Founder', showCalendar: true }),
  setSalesConfig: vi.fn().mockResolvedValue(undefined),
  getDemoNumbers: vi.fn().mockResolvedValue({ us: null, ca: null }),
  setDemoNumbers: vi.fn().mockResolvedValue({ us: null, ca: null }),
  pickDemoCallerId: vi.fn(),
  demoSample: () => ({
    company: 'Bayview Family Clinic',
    sampleLabel: 'a dental clinic',
    prospectLabel: 'your clinic',
    appointmentNoun: 'appointment',
  }),
  getDemoScreen: () => null,
  clearDemoScreen: vi.fn(),
  getDemoSummary: () => null,
  clearDemoSummary: vi.fn(),
}));

vi.mock('../services/geo.service', () => ({
  evaluateGate: vi.fn().mockResolvedValue({ callAllowed: true, ipCountry: 'CA', phone: { country: 'CA', isNanp: true } }),
  clientIp: () => '127.0.0.1',
}));

vi.mock('../services/clinic-facts.service', () => ({
  fetchClinicFacts: vi.fn(),
}));

vi.mock('../services/vapi.service', () => ({
  createAssistantForTenant: vi.fn(),
  createPhoneNumberInVapi: vi.fn(),
  fetchVapiPhoneNumbers: vi.fn().mockResolvedValue([]),
  findAssistantPhoneNumber: vi.fn(),
  repointAllPhoneNumbers: vi.fn(),
  syncAssistantForTenant: vi.fn(),
  syncAllAssistants: vi.fn(),
  validateAssistant: vi.fn(),
}));

vi.mock('../services/features.service', () => ({
  getTenantFeatures: vi.fn().mockResolvedValue([]),
  setFeatureByAdmin: vi.fn(),
}));

vi.mock('../services/support-ticket.service', () => ({
  listSupportTickets: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/founder.service', () => ({
  listFounderEntries: vi.fn().mockResolvedValue([]),
  founderAvailability: vi.fn().mockResolvedValue(null),
  blockFounderTime: vi.fn(),
  removeFounderEntry: vi.fn().mockResolvedValue(undefined),
  getFounderTimezone: vi.fn().mockResolvedValue('America/Vancouver'),
  getFounderCalendarStatus: vi.fn().mockResolvedValue({}),
  buildFounderCalendarAuthUrl: vi.fn().mockResolvedValue(''),
  disconnectFounderCalendar: vi.fn().mockResolvedValue(undefined),
  setFounderCalendarPrefs: vi.fn().mockResolvedValue(undefined),
  getFounderExternalEvents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/access-code.service', () => ({
  generateAccessCode: vi.fn(),
  listAccessCodes: vi.fn().mockResolvedValue([]),
  revokeAccessCode: vi.fn().mockResolvedValue(undefined),
  consumeAccessCode: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services/leadgen.service', () => ({
  bulkLeads: vi.fn(),
  deleteLead: vi.fn().mockResolvedValue(undefined),
  getLeadStats: vi.fn().mockResolvedValue({}),
  listLeads: vi.fn().mockResolvedValue({ leads: [], total: 0 }),
  scrapeEmailForLead: vi.fn(),
  scrapeEmails: vi.fn(),
  sourceLeads: vi.fn(),
  updateLead: vi.fn(),
}));

vi.mock('../services/outreach.service', () => ({ buildOutreachEmail: vi.fn() }));
vi.mock('../services/mailer.service', () => ({ sendOutreachEmail: vi.fn() }));
vi.mock('../services/usage.service', () => ({ getMonthlyUsage: vi.fn().mockResolvedValue({}) }));
vi.mock('../services/phone-pool.service', () => ({
  addNumber: vi.fn(),
  availableCount: vi.fn().mockResolvedValue(0),
  listPool: vi.fn().mockResolvedValue([]),
  removeNumber: vi.fn().mockResolvedValue(undefined),
  releaseNumberForTenant: vi.fn().mockResolvedValue(undefined),
  toPoolEntry: (n: unknown) => n,
}));
vi.mock('../lib/webhook-url', () => ({
  resolveWebhookUrl: vi.fn().mockResolvedValue({ webhookUrl: null, productionSafe: false, reason: null }),
}));

vi.mock('../services/onboarding.service', () => ({
  getOnboarding: vi.fn().mockResolvedValue({}),
  toOnboardingView: () => ({
    hasConfiguredProfile: false,
    hasConfiguredPrompt: false,
    hasTestedVoice: false,
    isActive: false,
    completedAt: null,
    nextStep: 'PROFILE',
    progressPercent: 0,
  }),
}));

vi.mock('../services/google-auth.service', () => ({
  verifyGoogleIdToken: vi.fn().mockResolvedValue({
    email: 'google.tester@clinic.test',
    fullName: 'Google Tester',
    profileName: 'Google Tester',
  }),
}));

vi.mock('../services/pricing-region.service', () => ({
  resolveSignupPricingRegion: vi.fn().mockResolvedValue(undefined),
  normalizePricingRegion: (v: unknown) => (v === 'CAD' ? 'CAD' : 'USD'),
}));

import { adminRouter } from './admin.routes';
import { authRouter } from './auth.routes';
import { billingRouter } from './billing.routes';
import { assertBillingAllowsActivation, setBillingGateEnabled } from '../services/billing.service';
import { errorHandler } from '../middleware/error';

/* ------------------------------- test server ------------------------------ */

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/billing', billingRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no test server address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.seed();
});

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

/* ------------------------------ admin switch ------------------------------ */

describe('GET/PATCH /api/admin/billing-gate', () => {
  it('defaults to ON when no setting row exists', async () => {
    const res = await call('GET', '/api/admin/billing-gate', 'admin-token');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it('flips the gate off and on, persisting the row and auditing each flip', async () => {
    const off = await call('PATCH', '/api/admin/billing-gate', 'admin-token', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect(state.platformSettings.get('BILLING_GATE_ENABLED')?.valueEnc).toBe('false');
    expect(state.platformSettings.get('BILLING_GATE_ENABLED')?.updatedBy).toBe('founder@platform.test');

    const read = await call('GET', '/api/admin/billing-gate', 'admin-token');
    expect(read.body.enabled).toBe(false);

    const on = await call('PATCH', '/api/admin/billing-gate', 'admin-token', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
    expect(state.platformSettings.get('BILLING_GATE_ENABLED')?.valueEnc).toBe('true');

    expect(state.auditCalls).toEqual([
      { adminEmail: 'founder@platform.test', action: 'billingGate.disable', target: 'billing gate', detail: {} },
      { adminEmail: 'founder@platform.test', action: 'billingGate.enable', target: 'billing gate', detail: {} },
    ]);
  });

  it('refuses anonymous (401), a signed-in non-admin (403), and a SUPPORT operator (403)', async () => {
    expect((await call('GET', '/api/admin/billing-gate', null)).status).toBe(401);
    expect((await call('PATCH', '/api/admin/billing-gate', null, { enabled: false })).status).toBe(401);
    expect((await call('GET', '/api/admin/billing-gate', 'plain-token')).status).toBe(403);
    expect((await call('PATCH', '/api/admin/billing-gate', 'plain-token', { enabled: false })).status).toBe(403);
    expect((await call('GET', '/api/admin/billing-gate', 'support-token')).status).toBe(403);
    const supportPatch = await call('PATCH', '/api/admin/billing-gate', 'support-token', { enabled: false });
    expect(supportPatch.status).toBe(403);
    expect(supportPatch.body.error.code).toBe('NEEDS_FULL_ADMIN');
    // Nothing flipped and nothing was audited.
    expect(state.platformSettings.has('BILLING_GATE_ENABLED')).toBe(false);
    expect(state.auditCalls).toHaveLength(0);
  });
});

/* ------------------------------ comped trial ------------------------------ */

describe('POST /api/billing/comped-trial', () => {
  it('is refused 403 while the gate is ON, and changes nothing', async () => {
    const res = await call('POST', '/api/billing/comped-trial', 'owner-token', { tier: 'CORE' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BILLING_GATE_ON');
    const tenant = state.tenants.get('tenant_tester');
    expect(tenant?.billingExempt).toBe(false);
    expect(tenant?.monthlyMinuteLimit).toBe(500);
    expect(state.auditCalls).toHaveLength(0);
  });

  it('with the gate OFF, starts a Core comped trial: exempt, TRIALING, 950 minutes, audited', async () => {
    await setBillingGateEnabled(false, 'founder@platform.test');
    const res = await call('POST', '/api/billing/comped-trial', 'owner-token', {
      tier: 'CORE',
      whiteGlove: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.billing.billingExempt).toBe(true);
    expect(res.body.billing.gateEnabled).toBe(false);
    expect(res.body.billing.monthlyMinuteLimit).toBe(950);

    const tenant = state.tenants.get('tenant_tester');
    expect(tenant?.billingExempt).toBe(true);
    expect(tenant?.subscriptionStatus).toBe('TRIALING');
    expect(tenant?.monthlyMinuteLimit).toBe(950);

    expect(state.auditCalls).toEqual([
      {
        adminEmail: 'tester@clinic.test',
        action: 'billing.compedTrial',
        target: 'Tester Dental',
        detail: { tier: 'CORE', whiteGlove: true },
      },
    ]);
  });

  it('sets the Starter cap of 300, and a second call updates the tier and limit', async () => {
    await setBillingGateEnabled(false, 'founder@platform.test');
    const first = await call('POST', '/api/billing/comped-trial', 'owner-token', { tier: 'STARTER' });
    expect(first.status).toBe(200);
    expect(state.tenants.get('tenant_tester')?.monthlyMinuteLimit).toBe(300);

    const second = await call('POST', '/api/billing/comped-trial', 'owner-token', { tier: 'CORE' });
    expect(second.status).toBe(200);
    expect(second.body.billing.monthlyMinuteLimit).toBe(950);
    expect(state.tenants.get('tenant_tester')?.monthlyMinuteLimit).toBe(950);
    expect(state.tenants.get('tenant_tester')?.billingExempt).toBe(true);
    expect(state.auditCalls.filter((a) => a.action === 'billing.compedTrial')).toHaveLength(2);
  });

  it('is OWNER-only: a manager gets 403, anonymous gets 401', async () => {
    await setBillingGateEnabled(false, 'founder@platform.test');
    expect((await call('POST', '/api/billing/comped-trial', 'manager-token', { tier: 'CORE' })).status).toBe(403);
    expect((await call('POST', '/api/billing/comped-trial', null, { tier: 'CORE' })).status).toBe(401);
    expect(state.tenants.get('tenant_tester')?.billingExempt).toBe(false);
  });

  it('refuses GROWTH like checkout does, and rejects unknown body fields', async () => {
    await setBillingGateEnabled(false, 'founder@platform.test');
    const growth = await call('POST', '/api/billing/comped-trial', 'owner-token', { tier: 'GROWTH' });
    expect(growth.status).toBe(400);
    expect(growth.body.error.code).toBe('TIER_NOT_AVAILABLE');
    const smuggled = await call('POST', '/api/billing/comped-trial', 'owner-token', {
      tier: 'CORE',
      amount: 1,
    });
    expect(smuggled.status).toBe(400);
    expect(state.tenants.get('tenant_tester')?.billingExempt).toBe(false);
  });

  it('a comped tenant passes the activation gate; an ordinary tenant still gets 402', async () => {
    await expect(assertBillingAllowsActivation('tenant_tester')).rejects.toMatchObject({
      status: 402,
      code: 'BILLING_REQUIRED',
    });
    await setBillingGateEnabled(false, 'founder@platform.test');
    await call('POST', '/api/billing/comped-trial', 'owner-token', { tier: 'STARTER' });
    await expect(assertBillingAllowsActivation('tenant_tester')).resolves.toBeUndefined();
  });
});

/* ------------------------------- status read ------------------------------ */

describe('GET /api/billing/status', () => {
  it('reports gateEnabled and configured alongside the billing state', async () => {
    const on = await call('GET', '/api/billing/status', 'owner-token');
    expect(on.status).toBe(200);
    expect(on.body.billing.gateEnabled).toBe(true);
    expect(typeof on.body.billing.configured).toBe('boolean');
    expect(on.body.billing.billingExempt).toBe(false);

    await setBillingGateEnabled(false, 'founder@platform.test');
    const off = await call('GET', '/api/billing/status', 'owner-token');
    expect(off.body.billing.gateEnabled).toBe(false);
  });
});

/* --------------------------------- signup --------------------------------- */

describe('signup and the billing gate', () => {
  const registerBody = {
    companyName: 'Gate Test Dental',
    industry: 'CONSTRUCTION',
    fullName: 'Gate Tester',
    email: 'gate.tester@clinic.test',
    password: 'password123',
  };

  it('with the gate OFF, register creates a billing-exempt tenant', async () => {
    await setBillingGateEnabled(false, 'founder@platform.test');
    const res = await call('POST', '/api/auth/register', null, registerBody);
    expect(res.status).toBe(201);
    const created = [...state.tenants.values()].find((t) => t.companyName === 'Gate Test Dental');
    expect(created?.billingExempt).toBe(true);
  });

  it('with the gate ON, register creates an ordinary tenant', async () => {
    const res = await call('POST', '/api/auth/register', null, registerBody);
    expect(res.status).toBe(201);
    const created = [...state.tenants.values()].find((t) => t.companyName === 'Gate Test Dental');
    expect(created?.billingExempt).toBe(false);
  });

  it('with the gate OFF, Google signup creates a billing-exempt tenant', async () => {
    await setBillingGateEnabled(false, 'founder@platform.test');
    const res = await call('POST', '/api/auth/google', null, { credential: 'google-token' });
    expect(res.status).toBe(201);
    const created = [...state.tenants.values()].find((t) => t.companyName === 'Google Tester');
    expect(created?.billingExempt).toBe(true);
  });

  it('with the gate ON, Google signup creates an ordinary tenant', async () => {
    const res = await call('POST', '/api/auth/google', null, { credential: 'google-token' });
    expect(res.status).toBe(201);
    const created = [...state.tenants.values()].find((t) => t.companyName === 'Google Tester');
    expect(created?.billingExempt).toBe(false);
  });
});
