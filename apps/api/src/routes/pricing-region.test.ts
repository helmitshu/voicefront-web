import express from 'express';
import type { Server } from 'node:http';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * The pricing region is server-owned. These tests pin the lock at the
 * HTTP boundary: a registration cannot smuggle the region in, a profile
 * update cannot set it, a verified Canadian website (or a demo lead
 * that already verified) grants CAD through the service, and only a
 * full platform admin can override it by hand.
 */

interface FakeTenant {
  id: string;
  companyName: string;
  slug: string;
  industry: string;
  subscriptionStatus: string;
  isBlocked: boolean;
  pricingRegion: string;
  pricingRegionSource: string | null;
  pricingRegionVerifiedAt: Date | null;
  onboarding: null;
  agentSettings: null;
  users: FakeUser[];
  _count: { users: number };
  createdAt: Date;
}
interface FakeUser {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: string;
  passwordHash: string;
  googleSub: string | null;
}

const tenants = new Map<string, FakeTenant>();
const users = new Map<string, FakeUser>();
const leads: Array<{ email: string; websiteUrl: string | null; factsJson: unknown; createdAt: Date }> = [];
let seq = 0;

function makeTenant(over: Partial<FakeTenant> & { id: string }): FakeTenant {
  const t: FakeTenant = {
    companyName: 'Clinic',
    slug: `slug-${over.id}`,
    industry: 'CONSTRUCTION',
    subscriptionStatus: 'TRIALING',
    isBlocked: false,
    pricingRegion: 'USD',
    pricingRegionSource: null,
    pricingRegionVerifiedAt: null,
    onboarding: null,
    agentSettings: null,
    users: [],
    _count: { users: 1 },
    createdAt: new Date(),
    ...over,
  };
  return t;
}

function findUser(args: { where: { id?: string; email?: string } }) {
  const w = args.where;
  const user = w.id
    ? users.get(w.id)
    : [...users.values()].find((u) => u.email.toLowerCase() === (w.email ?? '').toLowerCase());
  if (!user) return null;
  return { ...user, tenant: tenants.get(user.tenantId) ?? null };
}

function seed() {
  tenants.clear();
  users.clear();
  leads.length = 0;
  tenants.set('tenant_platform', makeTenant({ id: 'tenant_platform', companyName: 'Platform' }));
  users.set('user_admin', {
    id: 'user_admin', tenantId: 'tenant_platform', email: 'admin@platform.test',
    fullName: 'Admin', role: 'OWNER', passwordHash: 'x', googleSub: null,
  });
  users.set('user_support', {
    id: 'user_support', tenantId: 'tenant_platform', email: 'support@platform.test',
    fullName: 'Support', role: 'OWNER', passwordHash: 'x', googleSub: null,
  });
  tenants.set('tenant_seed', makeTenant({ id: 'tenant_seed', companyName: 'Seed Dental' }));
  users.set('user_seed', {
    id: 'user_seed', tenantId: 'tenant_seed', email: 'owner@seed.test',
    fullName: 'Seed Owner', role: 'OWNER', passwordHash: 'x', googleSub: null,
  });
  const seedTenant = tenants.get('tenant_seed');
  if (seedTenant) seedTenant.users = [users.get('user_seed') as FakeUser];
}

vi.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (args: never) => Promise.resolve(findUser(args)),
      findFirst: (args: never) => Promise.resolve(findUser(args)),
    },
    tenant: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(tenants.get(args.where.id) ?? null),
      findMany: () => Promise.resolve([...tenants.values()]),
      update: (args: { where: { id: string }; data: Partial<FakeTenant> }) => {
        const t = tenants.get(args.where.id);
        if (t) Object.assign(t, args.data);
        return Promise.resolve(t ?? null);
      },
    },
    demoLead: {
      findFirst: (args: { where: { email: { equals: string } } }) => {
        const wanted = args.where.email.equals.toLowerCase();
        const match = [...leads]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .find((l) => l.email.toLowerCase() === wanted);
        return Promise.resolve(
          match ? { factsJson: match.factsJson, websiteUrl: match.websiteUrl } : null,
        );
      },
      findMany: (args: { take?: number }) =>
        Promise.resolve(
          [...leads]
            .filter((l) => l.websiteUrl !== null)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, args.take ?? 50)
            .map((l) => ({ factsJson: l.factsJson, websiteUrl: l.websiteUrl })),
        ),
    },
    callLog: { groupBy: () => Promise.resolve([]) },
    appointment: { groupBy: () => Promise.resolve([]) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        tenant: {
          create: (args: { data: Partial<FakeTenant> }) => {
            const t = makeTenant({ ...args.data, id: `tenant_new_${++seq}` } as Partial<FakeTenant> & { id: string });
            tenants.set(t.id, t);
            return Promise.resolve(t);
          },
        },
        user: {
          create: (args: { data: Partial<FakeUser> }) => {
            const u: FakeUser = {
              id: `user_new_${++seq}`, fullName: '', role: 'OWNER',
              passwordHash: 'x', googleSub: null, ...args.data,
            } as FakeUser;
            users.set(u.id, u);
            const t = tenants.get(u.tenantId);
            if (t) {
              t.users = [u];
              t._count = { users: 1 };
            }
            return Promise.resolve(u);
          },
        },
        onboardingStatus: { create: () => Promise.resolve({}) },
        agentSettings: { create: () => Promise.resolve({}) },
      };
      return fn(tx);
    },
  },
}));

vi.mock('../lib/jwt', () => ({
  signAccessToken: () => 'signed-token',
  signRefreshToken: () => 'signed-refresh',
  verifyAccessToken: (token: string) => {
    if (token === 'owner-token') return { sub: 'user_seed', tid: 'tenant_seed', role: 'OWNER' };
    if (token === 'admin-token') return { sub: 'user_admin', tid: 'tenant_platform', role: 'OWNER' };
    if (token === 'support-token') return { sub: 'user_support', tid: 'tenant_platform', role: 'OWNER' };
    throw new Error('invalid token');
  },
  verifyRefreshToken: () => {
    throw new Error('invalid token');
  },
}));

vi.mock('../services/platform-admin.service', () => ({
  PLATFORM_TENANT_SLUG: '__platform',
  PLATFORM_TENANT_NAME: 'VoiceFront Platform',
  resolvePlatformRole: (email: string) =>
    email === 'admin@platform.test' ? 'ADMIN' : email === 'support@platform.test' ? 'SUPPORT' : null,
  addAdmin: vi.fn(),
  listAdmins: vi.fn().mockResolvedValue([]),
  removeAdmin: vi.fn(),
}));

vi.mock('../services/onboarding.service', () => ({
  getOnboarding: vi.fn().mockResolvedValue({ statusId: 'status_1', tenantId: 'tenant_1' }),
  toOnboardingView: () => ({
    step: 'account', completed: false, industry: 'clinic', receptionistChoice: null,
    phoneChoice: null, hasAssistant: false, hasPhoneNumber: false, forwardingReady: false,
    testCallDone: false, launched: false,
  }),
}));

vi.mock('../services/access-code.service', () => ({
  consumeAccessCode: vi.fn().mockResolvedValue(true),
  generateAccessCode: vi.fn(),
  listAccessCodes: vi.fn().mockResolvedValue([]),
  revokeAccessCode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/google-auth.service', () => ({
  verifyGoogleIdToken: vi.fn(),
}));

const fetchClinicFacts = vi.fn();
vi.mock('../services/clinic-facts.service', () => ({
  fetchClinicFacts: (...args: unknown[]) => fetchClinicFacts(...args),
}));

vi.mock('../services/platform-config.service', () => ({
  SETTING_KEYS: {},
  SETTING_META: {},
  assertSettingKey: vi.fn(),
  getSetting: vi.fn().mockResolvedValue(null),
  getSettingValue: vi.fn().mockResolvedValue(undefined),
  maskValue: (v: string) => v,
  recordAdminAction: vi.fn().mockResolvedValue(undefined),
  setSetting: vi.fn().mockResolvedValue(undefined),
  unsetSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/demo.service', () => ({
  DEMO_TENANT_SLUG: '__demo',
  cancelDemoHold: vi.fn(),
  confirmDemoHold: vi.fn(),
  createDemoLead: vi.fn(),
  getAvailableSlots: vi.fn().mockResolvedValue([]),
  getLeadMode: vi.fn().mockResolvedValue(null),
  listDemoLeads: vi.fn().mockResolvedValue([]),
  placeDemoHoldWithRetry: vi.fn(),
  presentDemoSlots: vi.fn().mockResolvedValue([]),
  resetDemoData: vi.fn().mockResolvedValue(undefined),
  setLeadMode: vi.fn().mockResolvedValue(undefined),
  updateDemoLeadFacts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/vapi.service', () => ({
  placeOutboundCall: vi.fn(),
  createAssistantForTenant: vi.fn(),
  createPhoneNumberInVapi: vi.fn(),
  findAssistantPhoneNumber: vi.fn(),
  listVapiPhoneNumbers: vi.fn().mockResolvedValue([]),
  repointAllPhoneNumbers: vi.fn(),
  syncAssistantForTenant: vi.fn(),
  syncAllAssistants: vi.fn(),
  validateAssistant: vi.fn(),
}));

const detectIpCountry = vi.fn();
vi.mock('../services/geo.service', () => ({
  evaluateGate: vi.fn().mockResolvedValue({ callAllowed: true, ipCountry: 'CA', phone: { country: 'CA', isNanp: true } }),
  clientIp: () => '203.0.113.9',
  detectIpCountry: (...args: unknown[]) => detectIpCountry(...args),
}));

vi.mock('../services/features.service', () => ({
  getTenantFeatures: vi.fn().mockResolvedValue([]),
  setFeatureByAdmin: vi.fn(),
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

import { authRouter } from './auth.routes';
import { adminRouter } from './admin.routes';
import { geoRouter } from './geo.routes';
import { errorHandler } from '../middleware/error';

const CA_FACTS = {
  businessName: 'Maple Dental Studio',
  address: '2145 West 4th Avenue, Vancouver, BC V6B 1A1',
  country: 'CA',
  region: 'BC',
  postalCode: 'V6B 1A1',
};
const US_FACTS = {
  businessName: 'Rainier Dental',
  address: '1200 Pine Street, Seattle, WA 98101',
  country: 'US',
  region: 'WA',
  postalCode: '98101',
};

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/geo', geoRouter);
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
  vi.clearAllMocks();
  seed();
  fetchClinicFacts.mockResolvedValue(null);
  detectIpCountry.mockResolvedValue(null);
});

async function register(body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'Clinic Owner',
      password: 'password123',
      industry: 'CONSTRUCTION',
      companyName: 'Some Business',
      ...body,
    }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('pricing region at registration', () => {
  it('ignores a client-supplied pricingRegion and stays USD', async () => {
    const { status, json } = await register({ email: 'a@one.test', pricingRegion: 'CAD' });
    expect(status).toBe(201);
    expect(json.tenant.pricingRegion).toBe('USD');
    const stored = [...tenants.values()].find((t) => t.companyName === 'Some Business');
    expect(stored?.pricingRegion).toBe('USD');
    expect(stored?.pricingRegionSource).toBeNull();
  });

  it('grants CAD when the registration website verifies as Canadian', async () => {
    fetchClinicFacts.mockResolvedValue(CA_FACTS);
    const { status, json } = await register({
      email: 'owner@mapledental.ca',
      website: 'https://mapledental.ca',
    });
    expect(status).toBe(201);
    expect(json.tenant.pricingRegion).toBe('CAD');
    expect(fetchClinicFacts).toHaveBeenCalledWith('https://mapledental.ca');
    const stored = [...tenants.values()].find((t) => t.id === json.tenant.id);
    expect(stored?.pricingRegionSource).toBe('website');
    expect(stored?.pricingRegionVerifiedAt).toBeInstanceOf(Date);
  });

  it('carries CAD over from a demo lead with the same email, no refetch', async () => {
    leads.push({
      email: 'owner@mapledental.ca',
      websiteUrl: 'https://mapledental.ca',
      factsJson: CA_FACTS,
      createdAt: new Date(),
    });
    const { status, json } = await register({ email: 'owner@mapledental.ca' });
    expect(status).toBe(201);
    expect(json.tenant.pricingRegion).toBe('CAD');
    expect(fetchClinicFacts).not.toHaveBeenCalled();
    const stored = [...tenants.values()].find((t) => t.id === json.tenant.id);
    expect(stored?.pricingRegionSource).toBe('demo-lead');
  });

  it('stays USD when the website verifies as a US business', async () => {
    fetchClinicFacts.mockResolvedValue(US_FACTS);
    const { status, json } = await register({
      email: 'owner@rainierdental.com',
      website: 'https://rainierdental.com',
    });
    expect(status).toBe(201);
    expect(json.tenant.pricingRegion).toBe('USD');
    const stored = [...tenants.values()].find((t) => t.id === json.tenant.id);
    expect(stored?.pricingRegionSource).toBeNull();
  });
});

describe('pricing region cannot be set through profile updates', () => {
  it('rejects a preferences patch that carries only pricingRegion', async () => {
    const res = await fetch(`${base}/api/auth/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner-token' },
      body: JSON.stringify({ pricingRegion: 'CAD' }),
    });
    expect(res.status).toBe(400);
    expect(tenants.get('tenant_seed')?.pricingRegion).toBe('USD');
  });
});

describe('admin override', () => {
  it('lets a full admin set the region and stamps the source', async () => {
    const res = await fetch(`${base}/api/admin/tenants/tenant_seed`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' },
      body: JSON.stringify({ pricingRegion: 'CAD' }),
    });
    expect(res.status).toBe(200);
    const stored = tenants.get('tenant_seed');
    expect(stored?.pricingRegion).toBe('CAD');
    expect(stored?.pricingRegionSource).toBe('admin');
    expect(stored?.pricingRegionVerifiedAt).toBeInstanceOf(Date);

    const list = await fetch(`${base}/api/admin/tenants`, {
      headers: { Authorization: 'Bearer admin-token' },
    });
    const listJson = (await list.json()) as { tenants: Array<Record<string, any>> };
    const row = listJson.tenants.find((t) => t.id === 'tenant_seed');
    expect(row?.pricingRegion).toBe('CAD');
  });

  it('refuses the override for support admins', async () => {
    const res = await fetch(`${base}/api/admin/tenants/tenant_seed`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer support-token' },
      body: JSON.stringify({ pricingRegion: 'CAD' }),
    });
    expect(res.status).toBe(403);
    expect(tenants.get('tenant_seed')?.pricingRegion).toBe('USD');
  });
});

describe('visitor country endpoint', () => {
  it('reports the country from the same geo source the demo gate uses', async () => {
    detectIpCountry.mockResolvedValue('CA');
    const res = await fetch(`${base}/api/geo/country`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ country: 'CA' });
    expect(detectIpCountry).toHaveBeenCalledWith('203.0.113.9');
  });

  it('reports null when the country cannot be resolved', async () => {
    const res = await fetch(`${base}/api/geo/country`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ country: null });
  });
});
