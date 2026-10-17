import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route tests for GET /api/admin/visitor-map:
 *  - full admins only (anonymous 401, non-platform 403, SUPPORT 403);
 *  - visitors are built from stored demo leads + their calls and holds;
 *  - same-city visitors cluster into one point with the right count;
 *  - a country-only visitor is labeled country precision and pinned on the
 *    country centroid, never presented as a precise spot;
 *  - the serialized payload never contains an IP-shaped string, even
 *    though the stored records it was built from contain IP-shaped text
 *    in fields the endpoint must not expose (transcripts, raw facts).
 *
 * Prisma is an in-memory fake and platform role resolution is a spy, in
 * the same style as the billing-gate suite.
 */

const state = vi.hoisted(() => {
  interface FakeUser {
    id: string;
    email: string;
  }
  interface FakeLead {
    id: string;
    demoSessionId: string;
    name: string;
    email: string;
    phone: string;
    ipCountry: string | null;
    ipCity: string | null;
    ipRegion: string | null;
    ipLat: number | null;
    ipLng: number | null;
    phoneCountry: string | null;
    industry: string;
    businessName: string | null;
    websiteUrl: string | null;
    factsJson: unknown;
    mode: string;
    createdAt: Date;
  }
  interface FakeCall {
    id: string;
    demoSessionId: string;
    durationSeconds: number;
    endedReason: string | null;
    summary: string | null;
    transcript: string | null;
    startedAt: Date | null;
    createdAt: Date;
  }
  interface FakeHold {
    id: string;
    demoSessionId: string;
    service: string | null;
    date: string | null;
    time: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }

  const users = new Map<string, FakeUser>();
  const leads: FakeLead[] = [];
  const calls: FakeCall[] = [];
  const holds: FakeHold[] = [];

  const prisma = {
    user: {
      findUnique: (args: { where: { id?: string; email?: string } }) => {
        const row = [...users.values()].find(
          (u) =>
            (args.where.id !== undefined && u.id === args.where.id) ||
            (args.where.email !== undefined && u.email === args.where.email),
        );
        return Promise.resolve(row ?? null);
      },
    },
    platformSetting: {
      findUnique: () => Promise.resolve(null),
    },
    demoLead: {
      findMany: () => Promise.resolve([...leads]),
    },
    demoCall: {
      findMany: (args?: { where?: { demoSessionId?: { in: string[] } } }) => {
        const inList = args?.where?.demoSessionId?.in;
        return Promise.resolve(inList ? calls.filter((c) => inList.includes(c.demoSessionId)) : [...calls]);
      },
    },
    demoHold: {
      findMany: (args?: { where?: { demoSessionId?: { in: string[] } } }) => {
        const inList = args?.where?.demoSessionId?.in;
        return Promise.resolve(inList ? holds.filter((h) => inList.includes(h.demoSessionId)) : [...holds]);
      },
    },
  };

  const day = 24 * 60 * 60 * 1000;
  function seed() {
    users.clear();
    leads.length = 0;
    calls.length = 0;
    holds.length = 0;
    users.set('user_admin', { id: 'user_admin', email: 'founder@platform.test' });
    users.set('user_support', { id: 'user_support', email: 'support@platform.test' });
    users.set('user_plain', { id: 'user_plain', email: 'customer@elsewhere.test' });

    const now = Date.now();
    leads.push(
      {
        id: 'lead_a',
        demoSessionId: 'demo_a',
        name: 'Alice Dental',
        email: 'alice@smiledental.test',
        phone: '+16045550101',
        ipCountry: 'CA',
        ipCity: 'Surrey',
        ipRegion: 'British Columbia',
        ipLat: 49.1,
        ipLng: -122.8,
        phoneCountry: 'CA',
        industry: 'clinic',
        businessName: 'Smile Dental',
        websiteUrl: 'https://smiledental.test',
        factsJson: {
          address: '123 King George Blvd, Surrey, BC',
          services: ['Cleanings', 'Implants'],
          hours: ['Mon-Fri 9-5'],
          // Raw scraped junk that must never reach the payload.
          internalNote: 'edge node 198.51.100.23',
        },
        mode: 'call',
        createdAt: new Date(now - 1 * day),
      },
      {
        id: 'lead_b',
        demoSessionId: 'demo_b',
        name: 'Bob Chen',
        email: 'bob@brighttooth.test',
        phone: '+17785550102',
        ipCountry: 'CA',
        ipCity: 'Surrey',
        ipRegion: 'British Columbia',
        ipLat: 49.1,
        ipLng: -122.8,
        phoneCountry: 'CA',
        industry: 'clinic',
        businessName: 'Bright Tooth',
        websiteUrl: null,
        factsJson: null,
        mode: 'web',
        createdAt: new Date(now - 2 * day),
      },
      {
        id: 'lead_c',
        demoSessionId: 'demo_c',
        name: 'Clara London',
        email: 'clara@londonsmiles.test',
        phone: '+442071234567',
        ipCountry: 'GB',
        ipCity: null,
        ipRegion: null,
        ipLat: null,
        ipLng: null,
        phoneCountry: 'GB',
        industry: 'clinic',
        businessName: null,
        websiteUrl: null,
        factsJson: null,
        mode: 'pending',
        createdAt: new Date(now - 3 * day),
      },
      {
        id: 'lead_d',
        demoSessionId: 'lyla_d',
        name: 'Dana Chat',
        email: 'dana@chatclinic.test',
        phone: '',
        ipCountry: 'US',
        ipCity: null,
        ipRegion: null,
        ipLat: null,
        ipLng: null,
        phoneCountry: null,
        industry: 'other',
        businessName: null,
        websiteUrl: 'https://chatclinic.test',
        factsJson: null,
        mode: 'pending',
        createdAt: new Date(now - 4 * day),
      },
      {
        id: 'lead_e',
        demoSessionId: 'demo_e',
        name: 'Eve Unknown',
        email: 'eve@unknown.test',
        phone: '+12125550103',
        ipCountry: null,
        ipCity: null,
        ipRegion: null,
        ipLat: null,
        ipLng: null,
        phoneCountry: 'US/CA',
        industry: 'other',
        businessName: null,
        websiteUrl: null,
        factsJson: null,
        mode: 'pending',
        createdAt: new Date(now - 10 * day),
      },
      {
        id: 'lead_f',
        demoSessionId: 'demo_f',
        name: 'Fran Paris',
        email: 'fran@parisdental.test',
        phone: '+33123456789',
        ipCountry: null,
        ipCity: null,
        ipRegion: null,
        ipLat: null,
        ipLng: null,
        phoneCountry: 'FR',
        industry: 'clinic',
        businessName: null,
        websiteUrl: null,
        factsJson: null,
        mode: 'pending',
        createdAt: new Date(now - 5 * day),
      },
    );
    calls.push({
      id: 'call_a',
      demoSessionId: 'demo_a',
      durationSeconds: 125,
      endedReason: 'customer-ended-call',
      // IP-shaped text in stored call fields must never leak.
      summary: 'Caller connected from 203.0.113.9 and booked a cleaning.',
      transcript: 'agent: hello\nuser at 203.0.113.9: hi',
      startedAt: new Date(now - 1 * day + 600_000),
      createdAt: new Date(now - 1 * day + 600_000),
    });
    holds.push({
      id: 'hold_a',
      demoSessionId: 'demo_a',
      service: 'Cleaning',
      date: '2026-10-20',
      time: '09:30',
      status: 'ACTIVE',
      createdAt: new Date(now - 1 * day + 900_000),
      updatedAt: new Date(now - 1 * day + 900_000),
    });
  }

  return { prisma, seed };
});

vi.mock('../lib/prisma', () => ({ prisma: state.prisma }));

vi.mock('../lib/jwt', () => ({
  verifyAccessToken: (token: string) => {
    if (token === 'admin-token') return { sub: 'user_admin', tid: 'tenant_platform', role: 'OWNER' };
    if (token === 'support-token') return { sub: 'user_support', tid: 'tenant_platform', role: 'OWNER' };
    if (token === 'plain-token') return { sub: 'user_plain', tid: 'tenant_tester', role: 'OWNER' };
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
  recordAdminAction: vi.fn().mockResolvedValue(undefined),
  setSetting: vi.fn().mockResolvedValue(undefined),
  unsetSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/demo.service', () => ({
  DEMO_TENANT_SLUG: '__demo',
  isDemoEnabled: vi.fn().mockResolvedValue(true),
  setDemoEnabled: vi.fn().mockResolvedValue(undefined),
  listRecentDemoCalls: vi.fn().mockResolvedValue([]),
  getSalesConfig: vi.fn().mockResolvedValue({ agentName: 'Ava', founderName: 'Founder', showCalendar: true }),
  setSalesConfig: vi.fn().mockResolvedValue(undefined),
  getDemoNumbers: vi.fn().mockResolvedValue({ us: null, ca: null }),
  setDemoNumbers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/geo.service', () => ({
  evaluateGate: vi.fn().mockResolvedValue({ callAllowed: true, ipCountry: 'CA', phone: { country: 'CA', isNanp: true } }),
  clientIp: () => '127.0.0.1',
  detectIpLocation: vi.fn().mockResolvedValue(null),
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
  verifyGoogleIdToken: vi.fn(),
}));

vi.mock('../services/pricing-region.service', () => ({
  resolveSignupPricingRegion: vi.fn().mockResolvedValue(undefined),
  normalizePricingRegion: (v: unknown) => (v === 'CAD' ? 'CAD' : 'USD'),
}));

import { adminRouter } from './admin.routes';
import { errorHandler } from '../middleware/error';

/* ------------------------------- test server ------------------------------ */

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
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

async function getMap(token: string | null): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${base}/api/admin/visitor-map`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

/* --------------------------------- tests --------------------------------- */

describe('GET /api/admin/visitor-map', () => {
  it('refuses anonymous (401), a signed-in non-admin (403), and a SUPPORT operator (403)', async () => {
    expect((await getMap(null)).status).toBe(401);
    expect((await getMap('plain-token')).status).toBe(403);
    const support = await getMap('support-token');
    expect(support.status).toBe(403);
    expect(support.body.error.code).toBe('NEEDS_FULL_ADMIN');
  });

  it('builds stats, points, and visitor details from stored demo records', async () => {
    const res = await getMap('admin-token');
    expect(res.status).toBe(200);

    expect(res.body.stats).toEqual({
      totalVisitors: 6,
      locatedVisitors: 5,
      unlocatedVisitors: 1,
      countries: 4,
      last7Days: 5,
    });

    const alice = res.body.visitors.find((v: any) => v.id === 'lead_a');
    expect(alice.displayName).toBe('Alice Dental');
    expect(alice.source).toBe('form');
    expect(alice.phone).toBe('+16045550101');
    expect(alice.businessName).toBe('Smile Dental');
    expect(alice.location.precision).toBe('city');
    expect(alice.location.city).toBe('Surrey');
    expect(alice.location.lat).toBe(49.1);
    expect(alice.callCount).toBe(1);
    expect(alice.holdBooked).toBe(true);
    expect(alice.hold).toEqual({ service: 'Cleaning', date: '2026-10-20', time: '09:30', status: 'ACTIVE' });
    expect(alice.timeline.map((e: any) => e.kind)).toEqual(['lead', 'call', 'hold']);
    expect(alice.businessFacts).toEqual({
      address: '123 King George Blvd, Surrey, BC',
      services: ['Cleanings', 'Implants'],
      hours: ['Mon-Fri 9-5'],
    });

    const dana = res.body.visitors.find((v: any) => v.id === 'lead_d');
    expect(dana.source).toBe('lyla');
    expect(dana.phone).toBeNull();

    const eve = res.body.visitors.find((v: any) => v.id === 'lead_e');
    expect(eve.location).toBeNull();
    expect(eve.country).toBeNull();
  });

  it('clusters same-city visitors and labels country-only pins as country precision', async () => {
    const res = await getMap('admin-token');
    const points = res.body.points as Array<any>;

    const surrey = points.find((p) => p.label.includes('Surrey'));
    expect(surrey).toBeDefined();
    expect(surrey.count).toBe(2);
    expect(surrey.precision).toBe('city');
    expect(surrey.visitorIds.sort()).toEqual(['lead_a', 'lead_b']);
    expect(surrey.lat).toBe(49.1);
    expect(surrey.lng).toBe(-122.8);

    const gb = points.find((p) => p.country === 'GB');
    expect(gb).toBeDefined();
    expect(gb.count).toBe(1);
    expect(gb.precision).toBe('country');
    expect(gb.precisionLabel).toContain('Country level only');
    // GB centroid from the service's static table, not a made-up spot.
    expect(gb.lat).toBe(54.0);
    expect(gb.lng).toBe(-2.5);

    // The phone-country fallback still maps Fran (FR centroid).
    const fr = points.find((p) => p.country === 'FR');
    expect(fr).toBeDefined();
    expect(fr.precision).toBe('country');
  });

  it('never leaks an IP-shaped string or stored call/fact internals', async () => {
    const res = await getMap('admin-token');
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(serialized).not.toContain('203.0.113.9');
    expect(serialized).not.toContain('198.51.100.23');
    expect(serialized).not.toContain('transcript');
    expect(serialized).not.toContain('factsJson');
    expect(serialized).not.toContain('ipLat');
  });
});
