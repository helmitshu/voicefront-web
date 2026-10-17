import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

/**
 * Route tests for the business name on GET/PATCH /api/agent/settings.
 * The name lives on the Tenant (Tenant.companyName — the dashboard's and
 * the assistant builder's source of truth); the settings endpoints carry
 * it so onboarding's Quick check step can show and correct it in the same
 * save as the rest of the step. Pins: the GET serves the tenant's current
 * name, an OWNER/MANAGER patch renames the tenant, an AGENT is refused,
 * invalid names are refused (mirroring /register's bounds), and a patch
 * without the name leaves the tenant untouched. The DB is faked; JWT
 * signing/verification is the app's real code; the Vapi sync is stubbed.
 */

const storedSettings: Record<string, unknown> = {
  tenantId: 'tenant_a',
  displayName: 'Maya',
  systemPrompt: 'You are the receptionist. Answer warmly and book carefully.',
  firstMessage: 'Thank you for calling. How can I help you today?',
  voicemailGreeting: 'Please leave a message after the tone.',
  businessHours: {},
  forwardingNumbers: [],
  timezone: 'America/Toronto',
  voiceProvider: 'vapi',
  voiceId: 'voice-1',
  backgroundSound: 'off',
  avgAppointmentValue: 200,
  rejectAnonymousCallers: false,
  maxCallDurationSeconds: 600,
  silenceTimeoutSeconds: 30,
  wrapUpMessage: null,
  emergencyAlertPhone: null,
  onCallRoster: [],
  dispatchEscalationSeconds: 120,
  missedCallTemplate: null,
  serviceAreaZips: [],
  serviceAreaNote: null,
  inboundPhoneNumber: null,
  assistantId: null,
  updatedAt: new Date('2026-10-16T00:00:00Z'),
};

const storedTenant = { id: 'tenant_a', companyName: 'Provisional Name' };

const prismaMock: Record<string, any> = vi.hoisted(() => ({
  agentSettings: {
    findUnique: vi.fn(async () => storedSettings),
    update: vi.fn(async (args: any) => ({ ...storedSettings, ...args.data })),
  },
  tenant: {
    findUnique: vi.fn(async () => ({ companyName: storedTenant.companyName })),
    update: vi.fn(async (args: any) => {
      storedTenant.companyName = args.data.companyName;
      return { ...storedTenant };
    }),
  },
}));

vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));

vi.mock('../services/vapi.service', () => ({
  syncAssistantForTenant: vi.fn(async () => ({ synced: false })),
}));

import { agentRouter } from './agent.routes';
import { errorHandler } from '../middleware/error';
import { signAccessToken } from '../lib/jwt';

let server: Server;
let base = '';

function tokenFor(role: 'OWNER' | 'MANAGER' | 'AGENT'): string {
  return signAccessToken({ userId: 'user_1', tenantId: 'tenant_a', role });
}

async function getSettings(role: 'OWNER' | 'MANAGER' | 'AGENT') {
  const res = await fetch(`${base}/api/agent/settings`, {
    headers: { authorization: `Bearer ${tokenFor(role)}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function patchSettings(role: 'OWNER' | 'MANAGER' | 'AGENT', patch: Record<string, unknown>) {
  const res = await fetch(`${base}/api/agent/settings`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${tokenFor(role)}`, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRouter);
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
  storedTenant.companyName = 'Provisional Name';
  prismaMock.agentSettings.findUnique.mockResolvedValue(storedSettings);
  prismaMock.agentSettings.update.mockImplementation(async (args: any) => ({
    ...storedSettings,
    ...args.data,
  }));
  prismaMock.tenant.findUnique.mockImplementation(async () => ({
    companyName: storedTenant.companyName,
  }));
  prismaMock.tenant.update.mockImplementation(async (args: any) => {
    storedTenant.companyName = args.data.companyName;
    return { ...storedTenant };
  });
});

describe('business name on /api/agent/settings', () => {
  it('serves the tenant current business name with the settings', async () => {
    const { status, body } = await getSettings('OWNER');
    expect(status).toBe(200);
    expect(body.settings.companyName).toBe('Provisional Name');
    expect(body.settings.displayName).toBe('Maya');
  });

  it('renames the tenant when the owner patches companyName', async () => {
    const { status, body } = await patchSettings('OWNER', { companyName: 'Bayview Dental Studio' });
    expect(status).toBe(200);
    expect(prismaMock.tenant.update).toHaveBeenCalledWith({
      where: { id: 'tenant_a' },
      data: { companyName: 'Bayview Dental Studio' },
    });
    expect(storedTenant.companyName).toBe('Bayview Dental Studio');
    expect(body.settings.companyName).toBe('Bayview Dental Studio');
  });

  it('lets a manager rename the business too', async () => {
    const { status, body } = await patchSettings('MANAGER', { companyName: 'Manager Renamed Co' });
    expect(status).toBe(200);
    expect(body.settings.companyName).toBe('Manager Renamed Co');
  });

  it('refuses an AGENT role and leaves the tenant untouched', async () => {
    const { status } = await patchSettings('AGENT', { companyName: 'Agent Rename Co' });
    expect(status).toBe(403);
    expect(prismaMock.tenant.update).not.toHaveBeenCalled();
    expect(storedTenant.companyName).toBe('Provisional Name');
  });

  it('refuses empty and over-long names', async () => {
    for (const companyName of ['   ', 'x', 'a'.repeat(81)]) {
      const { status } = await patchSettings('OWNER', { companyName });
      expect(status).toBe(400);
    }
    expect(prismaMock.tenant.update).not.toHaveBeenCalled();
    expect(storedTenant.companyName).toBe('Provisional Name');
  });

  it('leaves the tenant alone when the patch carries no companyName', async () => {
    const { status, body } = await patchSettings('OWNER', { displayName: 'Riley' });
    expect(status).toBe(200);
    expect(prismaMock.tenant.update).not.toHaveBeenCalled();
    expect(body.settings.companyName).toBe('Provisional Name');
    expect(body.settings.displayName).toBe('Riley');
  });
});
