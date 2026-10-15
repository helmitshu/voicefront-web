import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

/**
 * Route-level tests for GET /api/admin/tickets — the platform team's inbox
 * for tickets customers file through the in-app support agent (Adam). Same
 * harness as the other admin route suites: spies and vi.mock factories, the
 * real adminRouter on a throwaway express app, exercised over real HTTP.
 *
 * Pinned behaviour:
 *  - full admins only: no token → 401, a signed-in non-admin → 403, and a
 *    SUPPORT operator → 403 (a ticket can carry a customer's call details);
 *  - a full admin sees the tickets newest first with their references,
 *    categories, tenant, filer, and the attached call when there is one;
 *  - status and tenant filters reach the query; a junk status is a 400.
 */

const userFindUnique = vi.fn();
const ticketFindMany = vi.fn();

vi.mock('../lib/prisma', () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => userFindUnique(...args) },
    supportTicket: { findMany: (...args: unknown[]) => ticketFindMany(...args) },
  },
}));

vi.mock('../lib/jwt', () => ({
  verifyAccessToken: (token: string) => {
    if (token === 'admin-token') return { sub: 'user_admin', tid: 'tenant_platform', role: 'OWNER' };
    if (token === 'support-token') return { sub: 'user_support', tid: 'tenant_platform', role: 'OWNER' };
    if (token === 'plain-token') return { sub: 'user_plain', tid: 'tenant_x', role: 'OWNER' };
    throw new Error('invalid token');
  },
}));

const resolvePlatformRole = vi.fn();
vi.mock('../services/platform-admin.service', () => ({
  PLATFORM_TENANT_SLUG: '__platform',
  resolvePlatformRole: (...args: unknown[]) => resolvePlatformRole(...args),
  addAdmin: vi.fn(),
  listAdmins: vi.fn().mockResolvedValue([]),
  removeAdmin: vi.fn(),
}));

vi.mock('../services/platform-config.service', () => ({
  SETTING_KEYS: [],
  SETTING_META: {},
  assertSettingKey: (key: string) => key,
  getSetting: vi.fn().mockResolvedValue({ value: null, source: 'unset' }),
  getSettingValue: vi.fn().mockResolvedValue('https://api.example.test'),
  maskValue: (v: string) => v,
  recordAdminAction: vi.fn().mockResolvedValue(undefined),
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
  getSalesConfig: vi.fn().mockResolvedValue({ agentName: 'Ava', founderName: 'Hakim', showCalendar: true }),
  setSalesConfig: vi.fn().mockResolvedValue(undefined),
  listRecentDemoCalls: vi.fn().mockResolvedValue([]),
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

vi.mock('../services/geo.service', () => ({
  evaluateGate: vi.fn().mockResolvedValue({ callAllowed: true, ipCountry: 'CA', phone: { country: 'CA', isNanp: true } }),
  clientIp: () => '127.0.0.1',
}));

vi.mock('../services/clinic-facts.service', () => ({
  fetchClinicFacts: vi.fn(),
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

vi.mock('../services/access-code.service', () => ({
  generateAccessCode: vi.fn(),
  listAccessCodes: vi.fn().mockResolvedValue([]),
  revokeAccessCode: vi.fn().mockResolvedValue(undefined),
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

import { adminRouter } from './admin.routes';
import { errorHandler } from '../middleware/error';

const TICKET_ROWS = [
  {
    id: 'ticketrow00000000002',
    tenantId: 'tenant_b',
    createdByUserId: 'user_b',
    category: 'BAD_CALL',
    subject: 'Receptionist booked the wrong day',
    details: 'Caller asked for Tuesday, got Wednesday.',
    callLogId: 'call_b1',
    status: 'OPEN',
    createdAt: new Date('2026-10-15T09:30:00Z'),
    updatedAt: new Date('2026-10-15T09:30:00Z'),
    tenant: { id: 'tenant_b', companyName: 'Beta Dental' },
    createdBy: { id: 'user_b', email: 'owner@beta.test', fullName: 'Bea Beta' },
    callLog: { id: 'call_b1', startedAt: new Date('2026-10-14T17:20:00Z'), callerNumber: '+16045550155' },
  },
  {
    id: 'ticketrow00000000001',
    tenantId: 'tenant_a',
    createdByUserId: 'user_a',
    category: 'ISSUE',
    subject: 'Calls page will not load',
    details: 'The list spins forever.',
    callLogId: null,
    status: 'OPEN',
    createdAt: new Date('2026-10-15T08:10:00Z'),
    updatedAt: new Date('2026-10-15T08:10:00Z'),
    tenant: { id: 'tenant_a', companyName: 'Alpha Dental' },
    createdBy: { id: 'user_a', email: 'owner@alpha.test', fullName: 'Al Alpha' },
    callLog: null,
  },
];

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
  vi.clearAllMocks();
  userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === 'user_admin') return { email: 'helmitshu@gmail.com' };
    if (where.id === 'user_support') return { email: 'support@example.com' };
    if (where.id === 'user_plain') return { email: 'customer@example.com' };
    return null;
  });
  resolvePlatformRole.mockImplementation(async (email: string) => {
    if (email === 'helmitshu@gmail.com') return 'ADMIN';
    if (email === 'support@example.com') return 'SUPPORT';
    return null;
  });
  ticketFindMany.mockResolvedValue(TICKET_ROWS);
});

async function getTickets(path: string, token?: string) {
  const res = await fetch(`${base}/api/admin${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('GET /api/admin/tickets', () => {
  it('rejects a request with no token', async () => {
    const res = await getTickets('/tickets');
    expect(res.status).toBe(401);
    expect(ticketFindMany).not.toHaveBeenCalled();
  });

  it('rejects a signed-in non-admin', async () => {
    const res = await getTickets('/tickets', 'plain-token');
    expect(res.status).toBe(403);
    expect(ticketFindMany).not.toHaveBeenCalled();
  });

  it('rejects a SUPPORT operator (full admins only)', async () => {
    const res = await getTickets('/tickets', 'support-token');
    expect(res.status).toBe(403);
    expect(ticketFindMany).not.toHaveBeenCalled();
  });

  it('lists tickets for a full admin, newest first, with references and call links', async () => {
    const res = await getTickets('/tickets', 'admin-token');
    expect(res.status).toBe(200);
    expect(res.json.tickets).toHaveLength(2);
    const [first, second] = res.json.tickets;
    expect(first.reference).toBe('VF-000002');
    expect(first.category).toBe('BAD_CALL');
    expect(first.categoryLabel).toBe('Problem with a call');
    expect(first.tenant.companyName).toBe('Beta Dental');
    expect(first.createdBy.email).toBe('owner@beta.test');
    expect(first.call?.id).toBe('call_b1');
    expect(second.reference).toBe('VF-000001');
    expect(second.categoryLabel).toBe('Support issue');
    expect(second.call).toBeNull();
    // Newest first is the query the service issues.
    expect(ticketFindMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
  });

  it('passes status and tenant filters through to the query', async () => {
    const res = await getTickets('/tickets?status=OPEN&tenantId=tenant_b', 'admin-token');
    expect(res.status).toBe(200);
    expect(ticketFindMany.mock.calls[0][0].where).toEqual({ status: 'OPEN', tenantId: 'tenant_b' });
  });

  it('rejects a junk status filter with a 400', async () => {
    const res = await getTickets('/tickets?status=BOGUS', 'admin-token');
    expect(res.status).toBe(400);
    expect(ticketFindMany).not.toHaveBeenCalled();
  });
});
