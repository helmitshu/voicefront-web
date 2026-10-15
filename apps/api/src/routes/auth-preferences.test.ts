import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

/**
 * Route-level tests for PATCH /api/auth/preferences — display preferences
 * (app theme, calm mode) saved to the account. Same harness as the other
 * route suites: spies declared first, vi.mock factories, the real auth
 * router on a throwaway express app, exercised over real HTTP. Prisma is
 * an in-memory fake.
 *
 * Pinned behaviour:
 *  - a valid theme persists on the user and is returned both by the PATCH
 *    response and by a later GET /me (the account is the source of truth);
 *  - calmMode persists the same way and does not disturb the saved theme;
 *  - theme sent as null clears the saved choice;
 *  - an invalid theme value is rejected 400 VALIDATION_ERROR and nothing
 *    is written;
 *  - an empty body is rejected 400;
 *  - no Authorization header → 401 and nothing is written.
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
  theme: string | null;
  calmMode: boolean | null;
  tenant: FakeTenant;
}

const users = new Map<string, FakeUser>();

function findUser(args: { where: { id?: string; email?: string } }): FakeUser | null {
  for (const u of users.values()) {
    if (args.where.id && u.id === args.where.id) return u;
    if (args.where.email && u.email === args.where.email) return u;
  }
  return null;
}

const userFindUnique = vi.fn(async (args: { where: { id?: string; email?: string } }) => findUser(args));
const userUpdate = vi.fn(
  async (args: { where: { id: string }; data: { theme?: string | null; calmMode?: boolean | null } }) => {
    const user = users.get(args.where.id);
    if (!user) throw new Error('user missing in fake');
    if (args.data.theme !== undefined) user.theme = args.data.theme;
    if (args.data.calmMode !== undefined) user.calmMode = args.data.calmMode;
    return user;
  },
);

vi.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (args: unknown) => userFindUnique(args as never),
      update: (args: unknown) => userUpdate(args as never),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../lib/jwt', () => ({
  signAccessToken: () => 'signed-token',
  verifyAccessToken: (token: string) => {
    if (token === 'good-token') return { sub: 'user_1', tid: 'tenant_1', role: 'OWNER' };
    throw new Error('invalid token');
  },
}));

vi.mock('../services/platform-admin.service', () => ({
  PLATFORM_TENANT_SLUG: '__platform',
  resolvePlatformRole: vi.fn(async () => null),
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
    isActive: true,
    completedAt: null,
  }),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = vi.fn();
  },
}));

import { authRouter } from './auth.routes';
import { errorHandler } from '../middleware/error';

let server: Server;
let base = '';

function seedUser(): FakeUser {
  const tenant: FakeTenant = {
    id: 'tenant_1',
    companyName: 'Seeded Co',
    slug: 'seeded-co',
    industry: 'CLINIC',
    subscriptionStatus: 'ACTIVE',
    isBlocked: false,
  };
  const user: FakeUser = {
    id: 'user_1',
    tenantId: tenant.id,
    email: 'owner@example.com',
    fullName: 'Seeded User',
    passwordHash: 'seeded-hash',
    role: 'OWNER',
    theme: null,
    calmMode: null,
    tenant,
  };
  users.set(user.id, user);
  return user;
}

async function patchPreferences(body: unknown, token?: string) {
  const res = await fetch(`${base}/api/auth/preferences`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

async function getMe(token: string) {
  const res = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
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
  vi.clearAllMocks();
  seedUser();
});

describe('PATCH /api/auth/preferences', () => {
  it('persists a valid theme and returns it in the response and in GET /me', async () => {
    const patched = await patchPreferences({ theme: 'pearl' }, 'good-token');
    expect(patched.status).toBe(200);
    expect(patched.body.user['theme']).toBe('pearl');
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: 'user_1' }, data: { theme: 'pearl' } });

    const me = await getMe('good-token');
    expect(me.status).toBe(200);
    expect(me.body.user['theme']).toBe('pearl');
  });

  it('persists calmMode without disturbing the saved theme', async () => {
    await patchPreferences({ theme: 'midnight' }, 'good-token');
    const patched = await patchPreferences({ calmMode: true }, 'good-token');
    expect(patched.status).toBe(200);
    expect(patched.body.user['calmMode']).toBe(true);
    expect(patched.body.user['theme']).toBe('midnight');

    const me = await getMe('good-token');
    expect(me.body.user['calmMode']).toBe(true);
    expect(me.body.user['theme']).toBe('midnight');
  });

  it('clears the saved theme when theme is sent as null', async () => {
    await patchPreferences({ theme: 'deepteal' }, 'good-token');
    const patched = await patchPreferences({ theme: null }, 'good-token');
    expect(patched.status).toBe(200);
    expect(patched.body.user['theme']).toBeNull();
  });

  it('rejects an invalid theme value with 400 and writes nothing', async () => {
    const res = await patchPreferences({ theme: 'neon' }, 'good-token');
    expect(res.status).toBe(400);
    expect(res.body.error['code']).toBe('VALIDATION_ERROR');
    expect(userUpdate).not.toHaveBeenCalled();
    expect(users.get('user_1')?.theme).toBeNull();
  });

  it('rejects an empty body with 400', async () => {
    const res = await patchPreferences({}, 'good-token');
    expect(res.status).toBe(400);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request with 401 and writes nothing', async () => {
    const res = await patchPreferences({ theme: 'pearl' });
    expect(res.status).toBe(401);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(users.get('user_1')?.theme).toBeNull();
  });
});
