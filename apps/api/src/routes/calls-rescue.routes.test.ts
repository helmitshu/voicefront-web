import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';

/**
 * Route tests for POST /api/calls/:id/rescue-clear (Safe Landing).
 * The DB is faked; JWT signing/verification is the app's real code.
 * Pins the permission contract: AGENT is refused, OWNER and MANAGER
 * clear the flag, and a call from another workspace 404s.
 */

const START = new Date('2026-10-16T15:00:00Z');
const storedLog = {
  id: 'call_1',
  tenantId: 'tenant_a',
  channel: 'phone',
  callerNumber: '+14165550123',
  startedAt: START,
  endedAt: new Date(START.getTime() + 60_000),
  durationSeconds: 60,
  billedCostCents: 25,
  status: 'FAILED',
  summary: 'Dropped.',
  recordingUrl: null,
  intent: null,
  outcome: null,
  urgency: null,
  leadQuality: null,
  appointmentBooked: false,
  successScore: null,
  rescueNeeded: true,
  rescueReason: 'The call failed (no-answer).',
  transcript: null,
  structuredData: null,
};

const prismaMock: Record<string, any> = vi.hoisted(() => ({
  callLog: {
    findFirst: vi.fn(async () => null),
    update: vi.fn(async (args: any) => ({ ...storedLog, ...args.data })),
  },
  user: { findUnique: vi.fn(async () => ({ email: 'owner@acme.test' })) },
  adminAuditLog: { create: vi.fn(async () => ({})) },
}));

vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));

import { callsRouter } from './calls.routes';
import { errorHandler } from '../middleware/error';
import { signAccessToken } from '../lib/jwt';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/calls', callsRouter);
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
  prismaMock.callLog.findFirst.mockImplementation(async (args: any) =>
    args.where.id === 'call_1' && args.where.tenantId === 'tenant_a' ? storedLog : null,
  );
  prismaMock.callLog.update.mockImplementation(async (args: any) => ({ ...storedLog, ...args.data }));
  prismaMock.user.findUnique.mockResolvedValue({ email: 'owner@acme.test' });
  prismaMock.adminAuditLog.create.mockResolvedValue({});
});

const token = (role: 'OWNER' | 'MANAGER' | 'AGENT', tenantId = 'tenant_a', userId = 'user_1') =>
  signAccessToken({ userId, tenantId, role });

async function clear(id: string, auth?: string) {
  const res = await fetch(`${base}/api/calls/${id}/rescue-clear`, {
    method: 'POST',
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('POST /api/calls/:id/rescue-clear', () => {
  it('refuses an AGENT (member) role with 403 and writes nothing', async () => {
    const { status } = await clear('call_1', token('AGENT'));
    expect(status).toBe(403);
    expect(prismaMock.callLog.update).not.toHaveBeenCalled();
  });

  it('allows an OWNER and returns the cleared call', async () => {
    const { status, body } = await clear('call_1', token('OWNER'));
    expect(status).toBe(200);
    expect(body.call.rescueNeeded).toBe(false);
    expect(body.call.rescueReason).toBeNull();
    expect(prismaMock.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'calls.rescue_clear', adminEmail: 'owner@acme.test' }),
    });
  });

  it('allows a MANAGER', async () => {
    const { status } = await clear('call_1', token('MANAGER'));
    expect(status).toBe(200);
  });

  it('404s when the call belongs to another workspace', async () => {
    const { status } = await clear('call_1', token('OWNER', 'tenant_b', 'user_9'));
    expect(status).toBe(404);
    expect(prismaMock.callLog.update).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const { status } = await clear('call_1');
    expect(status).toBe(401);
  });
});
