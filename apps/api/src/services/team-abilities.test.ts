import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Standing-ability math tests:
 *  - scoreCallTranscript against fixture transcripts: a clean call
 *    passes all four checks; a broken call fails with the proving line
 *    quoted for each failed check (including the doubled-goodbye bug
 *    the checklist exists to catch).
 *  - computeLeakRadar against fixture rows: abandoned demos, stale
 *    trials, and near-cap tenants, each with real numbers.
 */

const prismaMock: Record<string, any> = vi.hoisted(() => ({
  demoLead: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  demoCall: { findMany: vi.fn() },
  tenant: { findMany: vi.fn(), findUnique: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
  callLog: { findMany: vi.fn(), aggregate: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  teamDraft: { create: vi.fn(async ({ data }: any) => ({ id: 'draft_1', ...data })) },
  failureCase: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: any) => ({ id: 'case_1', ...data })),
    findMany: vi.fn(async () => []),
  },
  workItem: { findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: any) => ({ id: 'wi_1', ...data })) },
}));

vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));

import { computeLeakRadar, scoreCallTranscript } from './team-abilities.service';

const HOUR = 60 * 60 * 1000;

const PASSING_TRANSCRIPT = [
  'AI: Thank you for calling Bayview Dental Studio, this is Maya. How can I help you today?',
  'User: Hi, I need a cleaning next week.',
  'AI: Of course. I can offer Tuesday at 10 in the morning. Does that work for you?',
  'User: Yes, and my number is 604 555 0134.',
  'AI: Let me read that back: 604 555 0134. Is that correct?',
  'User: Yes it is.',
  'AI: You are booked for a cleaning on Tuesday at 10 in the morning. We will see you then.',
  'AI: Thanks for calling Bayview Dental Studio. Have a great day.',
].join('\n');

const FAILING_TRANSCRIPT = [
  'AI: Hello, how can I help you?',
  'User: I want to book a checkup, my number is 778 555 0199.',
  'AI: Great, you are booked for Thursday at 2 in the afternoon.',
  'AI: You are all set, confirmed for Thursday at 2 in the afternoon.',
  'AI: Goodbye.',
  'AI: Goodbye, take care.',
].join('\n');

describe('scoreCallTranscript', () => {
  it('passes a clean call on all four checks', () => {
    const score = scoreCallTranscript(PASSING_TRANSCRIPT, 'Bayview Dental Studio');
    expect(score.passed).toBe(true);
    expect(score.checks.every((c) => c.pass)).toBe(true);
  });

  it('fails a broken call and quotes the proving line for each failure', () => {
    const score = scoreCallTranscript(FAILING_TRANSCRIPT, 'Bayview Dental Studio');
    expect(score.passed).toBe(false);
    const byKey = Object.fromEntries(score.checks.map((c) => [c.key, c]));

    // Greeting never names the clinic; the greeting line itself is the proof.
    expect(byKey.greeting.pass).toBe(false);
    expect(byKey.greeting.provingLine).toContain('Hello, how can I help you');

    // The caller spoke a number that was never read back.
    expect(byKey.numberReadback.pass).toBe(false);

    // Two confirmation lines: the second one is the proving line.
    expect(byKey.doubleBooking.pass).toBe(false);
    expect(byKey.doubleBooking.provingLine).toContain('confirmed for Thursday');

    // The doubled-goodbye bug: the last two lines are both farewells.
    expect(byKey.cleanGoodbye.pass).toBe(false);
    expect(byKey.cleanGoodbye.provingLine).toContain('Goodbye, take care.');
  });
});

describe('computeLeakRadar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const now = Date.now();
    prismaMock.demoLead.findMany.mockResolvedValue([
      { id: 'lead_1', name: 'Dr A', businessName: 'Clinic A', demoSessionId: 'sess_a', createdAt: new Date(now - 5 * HOUR) },
      { id: 'lead_2', name: 'Dr B', businessName: 'Clinic B', demoSessionId: 'sess_b', createdAt: new Date(now - 6 * HOUR) },
      { id: 'lead_3', name: 'Dr C', businessName: 'Clinic C', demoSessionId: 'sess_c', createdAt: new Date(now - 8 * HOUR) },
    ]);
    prismaMock.demoCall.findMany.mockResolvedValue([{ demoSessionId: 'sess_c' }]);

    prismaMock.tenant.findMany.mockImplementation(async (args: any) => {
      // Stale-trial query is the one filtering on createdAt.
      if (args?.where?.createdAt) {
        return [
          { id: 't_1', slug: 'clinic-one', companyName: 'Clinic One', createdAt: new Date(now - 30 * HOUR), onboarding: null },
          { id: 't_2', slug: 'clinic-two', companyName: 'Clinic Two', createdAt: new Date(now - 50 * HOUR), onboarding: { isActive: false } },
        ];
      }
      // Near-cap query.
      return [
        {
          id: 't_3',
          slug: 'busy-clinic',
          companyName: 'Busy Clinic',
          monthlyMinuteLimit: 500,
          agentSettings: { monthlyMinuteLimit: 500 },
        },
      ];
    });
    prismaMock.callLog.aggregate.mockResolvedValue({ _sum: { durationSeconds: 28_800 }, _count: 40 });
  });

  it('computes the three leak kinds with real numbers', async () => {
    const leaks = await computeLeakRadar();
    const byKind = Object.fromEntries(leaks.map((l) => [l.kind, l]));

    expect(byKind.abandoned_demos.count).toBe(2); // 3 leads, 1 actually called
    expect(byKind.abandoned_demos.detail).toContain('never took a call');

    expect(byKind.stale_trials.count).toBe(2);
    expect(byKind.stale_trials.detail).toContain('Clinic One');

    // 28,800 seconds = 480 of 500 minutes = 96% of cap.
    expect(byKind.near_minute_cap.count).toBe(1);
    expect(byKind.near_minute_cap.detail).toContain('480 of 500');
    expect(byKind.near_minute_cap.detail).toContain('96%');
  });

  it('returns no leaks when nothing leaks', async () => {
    prismaMock.demoLead.findMany.mockResolvedValue([]);
    prismaMock.tenant.findMany.mockResolvedValue([]);
    const leaks = await computeLeakRadar();
    expect(leaks).toEqual([]);
  });
});
