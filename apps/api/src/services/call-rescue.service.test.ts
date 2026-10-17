import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Safe Landing classifier + success-rate alarm tests.
 *
 * The classifier is pure: each provable failure signal alone must flag,
 * a booked call must never flag, and a clean message-only call must
 * never flag. The alarm runs against a mocked prisma: thresholds fire,
 * the 6-hour DB dedupe suppresses repeats, and a clean window is silent.
 */

const prismaMock: Record<string, any> = vi.hoisted(() => ({
  callLog: { findMany: vi.fn(async () => []) },
  demoCall: { count: vi.fn(async () => 0) },
  tenant: { findMany: vi.fn(async () => []) },
  reliabilityAlarm: {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async () => ({})),
  },
  failureCase: { create: vi.fn(async ({ data }: any) => ({ id: 'case_1', ...data })) },
}));

vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));

const postGroupStatusLine = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('./team.service', () => ({ postGroupStatusLine }));

import { classifyCallRescue, runRescueAlarm } from './call-rescue.service';

const base = {
  endedReason: 'customer-ended-call' as string | null,
  transcript: 'Caller: Hello. Receptionist: How can I help?' as string | null,
  durationSeconds: 120,
  appointmentBooked: false,
};

describe('classifyCallRescue', () => {
  it('flags a call.start.error-* transport failure (the founder test-call class)', () => {
    const r = classifyCallRescue({ ...base, endedReason: 'call.start.error-get-transport' });
    expect(r.rescueNeeded).toBe(true);
    expect(r.rescueReason).toContain('call.start.error-get-transport');
  });

  it('flags the rest of the call.start.error family by prefix', () => {
    for (const reason of [
      'call.start.error-vapi-number-outbound-daily-limit',
      'call.start.error-vapi-number-international',
      'call.start.error-get-phone-number',
    ]) {
      expect(classifyCallRescue({ ...base, endedReason: reason }).rescueNeeded).toBe(true);
    }
  });

  it('flags silence-timed-out on its own', () => {
    const r = classifyCallRescue({ ...base, endedReason: 'silence-timed-out' });
    expect(r.rescueNeeded).toBe(true);
    expect(r.rescueReason).toContain('silence');
  });

  it('flags exceeded-max-duration on its own', () => {
    expect(classifyCallRescue({ ...base, endedReason: 'exceeded-max-duration' }).rescueNeeded).toBe(true);
  });

  it('flags assistant-error on its own', () => {
    expect(classifyCallRescue({ ...base, endedReason: 'assistant-error' }).rescueNeeded).toBe(true);
  });

  it('flags a pipeline-error reason', () => {
    expect(
      classifyCallRescue({ ...base, endedReason: 'pipeline-error-openai-llm-failed' }).rescueNeeded,
    ).toBe(true);
  });

  it('flags the reasons the codebase already treats as FAILED (no-answer, did-not-connect)', () => {
    expect(classifyCallRescue({ ...base, endedReason: 'no-answer' }).rescueNeeded).toBe(true);
    expect(classifyCallRescue({ ...base, endedReason: 'did-not-connect' }).rescueNeeded).toBe(true);
  });

  it('flags a dropped call: no transcript and under 15 seconds', () => {
    const r = classifyCallRescue({ ...base, transcript: null, durationSeconds: 5 });
    expect(r.rescueNeeded).toBe(true);
    expect(r.rescueReason).toContain('dropped');
  });

  it('treats a whitespace-only transcript as nothing said', () => {
    expect(
      classifyCallRescue({ ...base, transcript: '   \n ', durationSeconds: 10 }).rescueNeeded,
    ).toBe(true);
  });

  it('does NOT flag a silent call at exactly 15 seconds (boundary is exclusive)', () => {
    expect(
      classifyCallRescue({ ...base, transcript: null, durationSeconds: 15 }).rescueNeeded,
    ).toBe(false);
  });

  it('does NOT flag a silent but longer call with a normal end', () => {
    expect(
      classifyCallRescue({ ...base, transcript: null, durationSeconds: 90 }).rescueNeeded,
    ).toBe(false);
  });

  it('never flags a booked call, even with a failure reason', () => {
    const r = classifyCallRescue({
      endedReason: 'silence-timed-out',
      transcript: null,
      durationSeconds: 3,
      appointmentBooked: true,
    });
    expect(r).toEqual({ rescueNeeded: false, rescueReason: null });
  });

  it('does NOT flag a clean message-only call (transcript, normal end, no booking)', () => {
    const r = classifyCallRescue({
      endedReason: 'assistant-ended-call',
      transcript: 'Caller: Please pass on a message. Receptionist: Of course.',
      durationSeconds: 64,
      appointmentBooked: false,
    });
    expect(r).toEqual({ rescueNeeded: false, rescueReason: null });
  });

  it('does NOT flag when every field is missing but the call ran long', () => {
    expect(
      classifyCallRescue({ endedReason: null, transcript: 'x', durationSeconds: 60, appointmentBooked: false }),
    ).toEqual({ rescueNeeded: false, rescueReason: null });
  });

  it('combines signals into one plain-words reason', () => {
    const r = classifyCallRescue({
      endedReason: 'assistant-error',
      transcript: null,
      durationSeconds: 4,
      appointmentBooked: false,
    });
    expect(r.rescueNeeded).toBe(true);
    expect(r.rescueReason).toContain('assistant-error');
    expect(r.rescueReason).toContain('dropped');
  });
});

/* --------------------------------- alarm -------------------------------- */

const NOW = new Date('2026-10-16T12:00:00Z');

function rescueRow(id: string, tenantId: string) {
  return { id, tenantId };
}

describe('runRescueAlarm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.callLog.findMany.mockResolvedValue([]);
    prismaMock.demoCall.count.mockResolvedValue(0);
    prismaMock.tenant.findMany.mockResolvedValue([]);
    prismaMock.reliabilityAlarm.findUnique.mockResolvedValue(null);
    prismaMock.reliabilityAlarm.upsert.mockResolvedValue({});
    prismaMock.failureCase.create.mockImplementation(async ({ data }: any) => ({ id: 'case_1', ...data }));
  });

  it('stays silent on a clean window: no channel line, no failure case', async () => {
    const out = await runRescueAlarm(NOW);
    expect(out.alarmsPosted).toBe(0);
    expect(postGroupStatusLine).not.toHaveBeenCalled();
    expect(prismaMock.failureCase.create).not.toHaveBeenCalled();
  });

  it('fires the tenant alarm at 3 rescue calls for one tenant and files one failure case', async () => {
    prismaMock.callLog.findMany.mockResolvedValue([
      rescueRow('c1', 'tenant_a'),
      rescueRow('c2', 'tenant_a'),
      rescueRow('c3', 'tenant_a'),
    ]);
    prismaMock.tenant.findMany.mockResolvedValue([{ id: 'tenant_a', companyName: 'Acme Dental' }]);

    const out = await runRescueAlarm(NOW);
    expect(out.alarmsPosted).toBe(1);
    expect(out.scopes).toEqual([{ scope: 'tenant:tenant_a', kind: 'tenant', count: 3 }]);
    expect(postGroupStatusLine).toHaveBeenCalledTimes(1);
    expect(postGroupStatusLine).toHaveBeenCalledWith({
      body: expect.stringContaining('Acme Dental'),
    });
    expect(postGroupStatusLine).toHaveBeenCalledWith({
      body: expect.stringContaining('3 calls'),
    });
    expect(prismaMock.failureCase.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.failureCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ callLogId: 'c1' }),
    });
    // Dedupe state persisted in the DB, keyed by scope.
    expect(prismaMock.reliabilityAlarm.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scope: 'tenant:tenant_a' } }),
    );
  });

  it('does not fire the tenant alarm below threshold', async () => {
    prismaMock.callLog.findMany.mockResolvedValue([
      rescueRow('c1', 'tenant_a'),
      rescueRow('c2', 'tenant_a'),
    ]);
    const out = await runRescueAlarm(NOW);
    expect(out.alarmsPosted).toBe(0);
    expect(postGroupStatusLine).not.toHaveBeenCalled();
  });

  it('fires the platform alarm at 5 rescue calls spread across tenants', async () => {
    prismaMock.callLog.findMany.mockResolvedValue([
      rescueRow('c1', 'tenant_a'),
      rescueRow('c2', 'tenant_a'),
      rescueRow('c3', 'tenant_b'),
      rescueRow('c4', 'tenant_b'),
      rescueRow('c5', 'tenant_c'),
    ]);
    prismaMock.tenant.findMany.mockResolvedValue([
      { id: 'tenant_a', companyName: 'Acme Dental' },
      { id: 'tenant_b', companyName: 'Beta Dental' },
      { id: 'tenant_c', companyName: 'Cedar Dental' },
    ]);
    const out = await runRescueAlarm(NOW);
    expect(out.alarmsPosted).toBe(1);
    expect(out.scopes).toEqual([{ scope: 'platform', kind: 'platform', count: 5 }]);
    expect(postGroupStatusLine).toHaveBeenCalledWith({
      body: expect.stringContaining('platform-wide'),
    });
  });

  it('fires the demo-transport alarm at 2 demo call.start.error failures', async () => {
    prismaMock.demoCall.count.mockResolvedValue(2);
    const out = await runRescueAlarm(NOW);
    expect(out.alarmsPosted).toBe(1);
    expect(out.scopes).toEqual([{ scope: 'demo-transport', kind: 'demo-transport', count: 2 }]);
    expect(postGroupStatusLine).toHaveBeenCalledWith({
      body: expect.stringContaining('transport'),
    });
    // The demo scope filters DemoCall rows on the transport prefix.
    expect(prismaMock.demoCall.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        endedReason: { startsWith: 'call.start.error' },
      }),
    });
  });

  it('dedupes: a scope that alarmed an hour ago posts nothing new', async () => {
    prismaMock.callLog.findMany.mockResolvedValue([
      rescueRow('c1', 'tenant_a'),
      rescueRow('c2', 'tenant_a'),
      rescueRow('c3', 'tenant_a'),
    ]);
    prismaMock.tenant.findMany.mockResolvedValue([{ id: 'tenant_a', companyName: 'Acme Dental' }]);
    prismaMock.reliabilityAlarm.findUnique.mockResolvedValue({
      scope: 'tenant:tenant_a',
      lastAlarmedAt: new Date(NOW.getTime() - 60 * 60 * 1000), // 1h ago, inside the 6h window
      lastCount: 3,
    });
    const out = await runRescueAlarm(NOW);
    expect(out.alarmsPosted).toBe(0);
    expect(postGroupStatusLine).not.toHaveBeenCalled();
    expect(prismaMock.failureCase.create).not.toHaveBeenCalled();
  });

  it('alarms again once the dedupe window has passed', async () => {
    prismaMock.callLog.findMany.mockResolvedValue([
      rescueRow('c1', 'tenant_a'),
      rescueRow('c2', 'tenant_a'),
      rescueRow('c3', 'tenant_a'),
    ]);
    prismaMock.tenant.findMany.mockResolvedValue([{ id: 'tenant_a', companyName: 'Acme Dental' }]);
    prismaMock.reliabilityAlarm.findUnique.mockResolvedValue({
      scope: 'tenant:tenant_a',
      lastAlarmedAt: new Date(NOW.getTime() - 7 * 60 * 60 * 1000), // 7h ago, outside the window
      lastCount: 3,
    });
    const out = await runRescueAlarm(NOW);
    expect(out.alarmsPosted).toBe(1);
    expect(postGroupStatusLine).toHaveBeenCalledTimes(1);
  });
});
