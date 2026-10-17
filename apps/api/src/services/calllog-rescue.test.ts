import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Safe Landing finalize integration: ingestEndOfCallReport must stamp
 * rescueNeeded / rescueReason from the classifier, prove bookings from
 * the Appointment table as well as the provider flag, and never let a
 * duplicate report unset a flag a human already cleared. clearCallRescue
 * clears the flag and writes the audit row.
 */

const prismaMock: Record<string, any> = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn(async () => ({ id: 'tenant_a', markupBps: 0 })) },
  appointment: { count: vi.fn(async () => 0) },
  callLog: {
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    upsert: vi.fn(async (args: any) => ({ id: 'call_1', ...args.create })),
    update: vi.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
  },
  adminAuditLog: { create: vi.fn(async () => ({})) },
}));

vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));

import { ingestEndOfCallReport, clearCallRescue } from './calllog.service';

const START = new Date('2026-10-16T15:00:00Z');

function report(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant_a',
    externalCallId: 'vapi_call_1',
    channel: 'phone' as const,
    callerNumber: '+14165550123',
    startedAt: START,
    endedAt: new Date(START.getTime() + 120_000),
    providerCostDollars: 0.2,
    endedReason: 'customer-ended-call',
    summary: 'A call.',
    transcript: 'Caller: Hi. Receptionist: Hello.',
    recordingUrl: null,
    structuredData: null,
    successEvaluation: null,
    ...overrides,
  };
}

function lastUpsert() {
  const calls = prismaMock.callLog.upsert.mock.calls;
  return calls[calls.length - 1][0];
}

describe('ingestEndOfCallReport rescue stamping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.tenant.findUnique.mockResolvedValue({ id: 'tenant_a', markupBps: 0 });
    prismaMock.appointment.count.mockResolvedValue(0);
    prismaMock.callLog.findUnique.mockResolvedValue(null);
    prismaMock.callLog.upsert.mockImplementation(async (args: any) => ({ id: 'call_1', ...args.create }));
  });

  it('flags a transport-failure call on create', async () => {
    await ingestEndOfCallReport(
      report({ endedReason: 'call.start.error-get-transport', transcript: null }),
    );
    const args = lastUpsert();
    expect(args.create.rescueNeeded).toBe(true);
    expect(args.create.rescueReason).toContain('call.start.error-get-transport');
    expect(args.update.rescueNeeded).toBe(true);
  });

  it('does not flag a clean call', async () => {
    await ingestEndOfCallReport(report());
    const args = lastUpsert();
    expect(args.create.rescueNeeded).toBe(false);
    expect(args.create.rescueReason).toBeNull();
  });

  it('does not flag when the provider structured data says booked, despite a failure reason', async () => {
    await ingestEndOfCallReport(
      report({ endedReason: 'silence-timed-out', structuredData: { appointmentBooked: true } }),
    );
    expect(lastUpsert().create.rescueNeeded).toBe(false);
  });

  it('does not flag when a real Appointment row proves the booking', async () => {
    prismaMock.appointment.count.mockResolvedValue(1);
    await ingestEndOfCallReport(report({ endedReason: 'assistant-error' }));
    expect(lastUpsert().create.rescueNeeded).toBe(false);
    expect(prismaMock.appointment.count).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_a', externalCallId: 'vapi_call_1', demoSessionId: null },
    });
  });

  it('first finalize over the live IN_PROGRESS row writes the rescue fields on update', async () => {
    prismaMock.callLog.findUnique.mockResolvedValue({ status: 'IN_PROGRESS' });
    await ingestEndOfCallReport(report({ endedReason: 'no-answer' }));
    const args = lastUpsert();
    expect(args.update.rescueNeeded).toBe(true);
  });

  it('a duplicate report for a finalized call omits rescue fields from update (never unsets a human clear)', async () => {
    prismaMock.callLog.findUnique.mockResolvedValue({ status: 'COMPLETED' });
    await ingestEndOfCallReport(report({ endedReason: 'call.start.error-get-transport', transcript: null }));
    const args = lastUpsert();
    expect(args.create.rescueNeeded).toBe(true); // create branch is inert on conflict
    expect('rescueNeeded' in args.update).toBe(false);
    expect('rescueReason' in args.update).toBe(false);
  });
});

describe('clearCallRescue', () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.callLog.findFirst.mockResolvedValue(storedLog);
    prismaMock.callLog.update.mockImplementation(async (args: any) => ({
      ...storedLog,
      ...args.data,
    }));
    prismaMock.adminAuditLog.create.mockResolvedValue({});
  });

  it('clears the flag and audits the clear with the prior reason', async () => {
    const dto = await clearCallRescue('tenant_a', 'call_1', 'owner@acme.test');
    expect(dto.rescueNeeded).toBe(false);
    expect(dto.rescueReason).toBeNull();
    expect(prismaMock.callLog.update).toHaveBeenCalledWith({
      where: { id: 'call_1' },
      data: { rescueNeeded: false, rescueReason: null },
    });
    expect(prismaMock.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminEmail: 'owner@acme.test',
        action: 'calls.rescue_clear',
        target: 'tenant_a',
        detail: expect.objectContaining({
          callLogId: 'call_1',
          priorReason: 'The call failed (no-answer).',
        }),
      }),
    });
  });

  it('404s for a call in another tenant', async () => {
    prismaMock.callLog.findFirst.mockResolvedValue(null);
    await expect(clearCallRescue('tenant_b', 'call_1', 'owner@beta.test')).rejects.toMatchObject({
      status: 404,
    });
    expect(prismaMock.callLog.update).not.toHaveBeenCalled();
  });
});
