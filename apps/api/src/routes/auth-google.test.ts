import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

/**
 * Route-level tests for POST /api/auth/google — "Continue with Google"
 * (Google Identity Services ID-token flow). Same harness as the other route
 * suites: spies declared first, vi.mock factories, the real auth router on a
 * throwaway express app, exercised over real HTTP. The Google verifier is
 * the mocked google-auth-library (no network); prisma is an in-memory fake.
 *
 * Pinned behaviour:
 *  - GOOGLE_CLIENT_ID unset → 503 GOOGLE_AUTH_NOT_CONFIGURED, verifier untouched;
 *  - invalid token → 401 GOOGLE_TOKEN_INVALID;
 *  - verified token whose email is missing or unverified → 401
 *    GOOGLE_EMAIL_UNVERIFIED;
 *  - valid token + new email → creates tenant + OWNER user + onboarding +
 *    settings (mirroring /register), 201, in the exact login response shape;
 *  - a selected CLINIC/CONSTRUCTION industry is honored and invite-gated
 *    exactly like /register; an absent industry defaults to CONSTRUCTION;
 *  - valid token + existing email → 200 sign-in, no duplicate user;
 *  - suspended tenant → 403 ACCOUNT_SUSPENDED, same as password login;
 *  - the founder email keeps platform admin (buildMe resolves it by email).
 */

interface FakeTenant {
  id: string;
  companyName: string;
  slug: string;
  industry: string;
  subscriptionStatus: string;
  isBlocked: boolean;
}
interface FakeUser {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  passwordHash: string;
  role: string;
  tenant: FakeTenant;
}

const users = new Map<string, FakeUser>();
const tenants = new Map<string, FakeTenant>();
let idSeq = 0;

function findUser(args: { where: { id?: string; email?: string } }): FakeUser | null {
  for (const u of users.values()) {
    if (args.where.id && u.id === args.where.id) return u;
    if (args.where.email && u.email === args.where.email) return u;
  }
  return null;
}

const userFindUnique = vi.fn(async (args: { where: { id?: string; email?: string } }) => findUser(args));
const tenantCreate = vi.fn(
  async (args: { data: { companyName: string; industry: string; slug: string } }) => {
    const tenant: FakeTenant = {
      id: `tenant_${++idSeq}`,
      companyName: args.data.companyName,
      slug: args.data.slug,
      industry: args.data.industry,
      subscriptionStatus: 'TRIALING',
      isBlocked: false,
    };
    tenants.set(tenant.id, tenant);
    return tenant;
  },
);
const userCreate = vi.fn(
  async (args: {
    data: { tenantId: string; email: string; fullName: string; passwordHash: string; role: string };
  }) => {
    const tenant = tenants.get(args.data.tenantId);
    if (!tenant) throw new Error('tenant missing in fake');
    const user: FakeUser = {
      id: `user_${++idSeq}`,
      tenantId: args.data.tenantId,
      email: args.data.email,
      fullName: args.data.fullName,
      passwordHash: args.data.passwordHash,
      role: args.data.role,
      tenant,
    };
    users.set(user.id, user);
    return user;
  },
);
const onboardingCreate = vi.fn(async () => ({}));
const agentSettingsCreate = vi.fn(async () => ({}));

const txFake = {
  tenant: { create: (args: unknown) => tenantCreate(args as never) },
  user: { create: (args: unknown) => userCreate(args as never) },
  onboardingStatus: { create: (args: unknown) => onboardingCreate(args as never) },
  agentSettings: { create: (args: unknown) => agentSettingsCreate(args as never) },
};

vi.mock('../lib/prisma', () => ({
  prisma: {
    user: { findUnique: (args: unknown) => userFindUnique(args as never) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txFake),
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

vi.mock('../services/onboarding.service', () => ({
  getOnboarding: vi.fn(async () => ({})),
  toOnboardingView: () => ({
    hasConfiguredProfile: false,
    hasConfiguredPrompt: false,
    hasTestedVoice: false,
    isActive: false,
    completedAt: null,
  }),
}));

const verifyIdToken = vi.fn();
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = (...args: unknown[]) => verifyIdToken(...args);
  },
}));

import { authRouter } from './auth.routes';
import { errorHandler } from '../middleware/error';
import { env, inviteOnlyIndustries } from '../config/env';
import { verifyAccessToken } from '../lib/jwt';

const FOUNDER_EMAIL = 'helmitshu@gmail.com';
const CLIENT_ID = 'test-google-client-id';

let server: Server;
let base = '';

function seedUser(email: string, opts: { blocked?: boolean; fullName?: string } = {}): FakeUser {
  const tenant: FakeTenant = {
    id: `tenant_${++idSeq}`,
    companyName: 'Seeded Co',
    slug: `seeded-${idSeq}`,
    industry: 'CLINIC',
    subscriptionStatus: 'ACTIVE',
    isBlocked: opts.blocked ?? false,
  };
  tenants.set(tenant.id, tenant);
  const user: FakeUser = {
    id: `user_${++idSeq}`,
    tenantId: tenant.id,
    email,
    fullName: opts.fullName ?? 'Seeded User',
    passwordHash: 'seeded-hash',
    role: 'OWNER',
    tenant,
  };
  users.set(user.id, user);
  return user;
}

function googlePayload(payload: Record<string, unknown>) {
  return { getPayload: () => payload };
}

async function postGoogle(credential: unknown, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  users.clear();
  tenants.clear();
  vi.clearAllMocks();
  inviteOnlyIndustries.splice(0, inviteOnlyIndustries.length, 'CLINIC');
  (env as { GOOGLE_CLIENT_ID?: string }).GOOGLE_CLIENT_ID = CLIENT_ID;
  resolvePlatformRole.mockImplementation(async (email: string) =>
    email === FOUNDER_EMAIL ? 'ADMIN' : null,
  );
});

afterEach(() => {
  (env as { GOOGLE_CLIENT_ID?: string }).GOOGLE_CLIENT_ID = undefined;
});

describe('POST /api/auth/google', () => {
  it('refuses 503 when GOOGLE_CLIENT_ID is unset, without calling the verifier', async () => {
    (env as { GOOGLE_CLIENT_ID?: string }).GOOGLE_CLIENT_ID = undefined;
    const { status, body } = await postGoogle('any-token');
    expect(status).toBe(503);
    expect(body.error.code).toBe('GOOGLE_AUTH_NOT_CONFIGURED');
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects an invalid token 401', async () => {
    verifyIdToken.mockRejectedValue(new Error('bad token'));
    const { status, body } = await postGoogle('garbage');
    expect(status).toBe(401);
    expect(body.error.code).toBe('GOOGLE_TOKEN_INVALID');
    expect(users.size).toBe(0);
  });

  it('rejects an unverified email 401', async () => {
    verifyIdToken.mockResolvedValue(
      googlePayload({ email: 'person@example.com', email_verified: false, name: 'Person' }),
    );
    const { status, body } = await postGoogle('tok');
    expect(status).toBe(401);
    expect(body.error.code).toBe('GOOGLE_EMAIL_UNVERIFIED');
    expect(users.size).toBe(0);
  });

  it('rejects a token with no email 401', async () => {
    verifyIdToken.mockResolvedValue(googlePayload({ email_verified: true, name: 'No Email' }));
    const { status, body } = await postGoogle('tok');
    expect(status).toBe(401);
    expect(body.error.code).toBe('GOOGLE_EMAIL_UNVERIFIED');
    expect(users.size).toBe(0);
  });

  it('creates the workspace for a new user and issues a token (201)', async () => {
    verifyIdToken.mockResolvedValue(
      googlePayload({ email: 'New.Person@Example.com', email_verified: true, name: 'New Person' }),
    );
    const { status, body } = await postGoogle('valid-token');

    expect(status).toBe(201);
    expect(verifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ audience: CLIENT_ID, idToken: 'valid-token' }),
    );
    // Email normalized exactly like /register; one user, one tenant.
    expect(users.size).toBe(1);
    expect(tenants.size).toBe(1);
    const created = [...users.values()][0];
    expect(created.email).toBe('new.person@example.com');
    expect(created.fullName).toBe('New Person');
    expect(created.role).toBe('OWNER');
    // No industry in the request keeps the CONSTRUCTION default.
    expect(created.tenant.industry).toBe('CONSTRUCTION');
    expect(body.tenant.industry).toBe('CONSTRUCTION');
    // A real hash of an unknown random secret — never the raw credential.
    expect(created.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(onboardingCreate).toHaveBeenCalledTimes(1);
    expect(agentSettingsCreate).toHaveBeenCalledTimes(1);
    // Login-identical response shape, and the token is a real access token.
    expect(body.user.email).toBe('new.person@example.com');
    expect(body.user.isPlatformAdmin).toBe(false);
    expect(body.tenant.companyName).toBe('New Person');
    expect(body.onboarding.isActive).toBe(false);
    const claims = verifyAccessToken(body.token as unknown as string);
    expect(claims.sub).toBe(created.id);
    expect(claims.tid).toBe(created.tenantId);
  });

  it('honors a CLINIC industry selection when that industry is open', async () => {
    inviteOnlyIndustries.splice(0, inviteOnlyIndustries.length);
    verifyIdToken.mockResolvedValue(
      googlePayload({ email: 'clinic@example.com', email_verified: true, name: 'Clinic Owner' }),
    );
    const { status, body } = await postGoogle('valid-token', { industry: 'CLINIC' });

    expect(status).toBe(201);
    expect(body.tenant.industry).toBe('CLINIC');
    expect([...tenants.values()][0].industry).toBe('CLINIC');
    expect(tenantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ industry: 'CLINIC' }),
      }),
    );
  });

  it('enforces the invite gate for a selected invite-only industry', async () => {
    verifyIdToken.mockResolvedValue(
      googlePayload({ email: 'clinic@example.com', email_verified: true, name: 'Clinic Owner' }),
    );
    const { status, body } = await postGoogle('valid-token', { industry: 'CLINIC' });

    expect(status).toBe(403);
    expect(body.error.code).toBe('CODE_REQUIRED');
    expect(users.size).toBe(0);
    expect(tenants.size).toBe(0);
    expect(tenantCreate).not.toHaveBeenCalled();
  });

  it('lets an operator create a workspace in a selected invite-only industry', async () => {
    verifyIdToken.mockResolvedValue(
      googlePayload({ email: FOUNDER_EMAIL, email_verified: true, name: 'Founder' }),
    );
    const { status, body } = await postGoogle('valid-token', { industry: 'CLINIC' });

    expect(status).toBe(201);
    expect(body.tenant.industry).toBe('CLINIC');
    expect(body.user.isPlatformAdmin).toBe(true);
    expect(body.user.adminRole).toBe('ADMIN');
  });

  it('rejects an invalid industry 400 before verifying the token', async () => {
    const { status, body } = await postGoogle('valid-token', { industry: 'DENTAL' });

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(users.size).toBe(0);
    expect(tenants.size).toBe(0);
  });

  it('signs in an existing user with an industry field without creating a duplicate (200)', async () => {
    const seeded = seedUser('person@example.com', { fullName: 'Existing Person' });
    verifyIdToken.mockResolvedValue(
      googlePayload({ email: 'person@example.com', email_verified: true, name: 'Existing Person' }),
    );
    const { status, body } = await postGoogle('valid-token', { industry: 'CLINIC' });

    expect(status).toBe(200);
    expect(users.size).toBe(1);
    expect(tenantCreate).not.toHaveBeenCalled();
    expect(body.user.id).toBe(seeded.id);
    const claims = verifyAccessToken(body.token as unknown as string);
    expect(claims.sub).toBe(seeded.id);
  });

  it('refuses a suspended workspace 403, same as password login', async () => {
    seedUser('blocked@example.com', { blocked: true });
    verifyIdToken.mockResolvedValue(
      googlePayload({ email: 'blocked@example.com', email_verified: true, name: 'Blocked' }),
    );
    const { status, body } = await postGoogle('valid-token');
    expect(status).toBe(403);
    expect(body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('keeps platform admin for the founder email (existing account)', async () => {
    seedUser(FOUNDER_EMAIL, { fullName: 'Founder' });
    verifyIdToken.mockResolvedValue(
      googlePayload({ email: FOUNDER_EMAIL, email_verified: true, name: 'Founder' }),
    );
    const { status, body } = await postGoogle('valid-token');
    expect(status).toBe(200);
    expect(body.user.isPlatformAdmin).toBe(true);
    expect(body.user.adminRole).toBe('ADMIN');
  });

  it('keeps platform admin for the founder email (brand-new account)', async () => {
    verifyIdToken.mockResolvedValue(
      googlePayload({ email: FOUNDER_EMAIL, email_verified: true, name: 'Founder' }),
    );
    const { status, body } = await postGoogle('valid-token');
    expect(status).toBe(201);
    expect(body.user.isPlatformAdmin).toBe(true);
    expect(body.user.adminRole).toBe('ADMIN');
  });
});
