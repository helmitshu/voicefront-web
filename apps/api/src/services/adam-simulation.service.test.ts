import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for Adam's simulated-patient machinery (proofs and drills).
 *
 * The guarantees under test are the ones the feature is sold on:
 *  - scenarios come from call summaries and structured data, never from
 *    raw patient identifiers, and the patient persona carries the hard
 *    rules (fictional identity, never confirm a booking) in its prompt;
 *  - daily caps (3 proofs, 5 drills) and the one-in-flight rule hold;
 *  - capture completes a run from the receptionist leg, falls back to the
 *    patient leg honestly, ignores duplicate deliveries, and the cleanup
 *    removes the run's sandbox rows and cancels any real-calendar leak, so
 *    no live appointment survives a simulated call.
 *
 * Prisma, the Vapi client, platform settings and the demo-tenant bundle
 * are faked; the service logic under test is the real code.
 */

const state = vi.hoisted(() => {
  interface FakeRun {
    id: string;
    tenantId: string;
    createdByUserId: string;
    kind: string;
    status: string;
    scenarioTitle: string;
    scenarioPrompt: string;
    sourceCallLogId: string | null;
    diagnosis: string | null;
    fixSummary: string | null;
    originNumber: string | null;
    patientCallId: string | null;
    receptionistCallId: string | null;
    resultSummary: string | null;
    resultTranscript: string | null;
    resultRecordingUrl: string | null;
    resultSuccessScore: number | null;
    resultOutcome: string | null;
    resultDurationSeconds: number;
    patientTranscript: string | null;
    patientRecordingUrl: string | null;
    cleanupCount: number;
    createdAt: Date;
    completedAt: Date | null;
  }
  interface FakeAppointment {
    id: string;
    tenantId: string;
    demoSessionId: string | null;
    externalCallId: string | null;
    status: string;
  }
  interface FakeJob {
    id: string;
    tenantId: string;
    demoSessionId: string | null;
  }

  const runs = new Map<string, FakeRun>();
  const appointments: FakeAppointment[] = [];
  const jobs: FakeJob[] = [];
  let runSeq = 0;
  const vapiCalls: Array<{ phoneNumberId: string; customerNumber: string; assistant: unknown }> = [];
  let failPlacement = false;

  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [key, cond] of Object.entries(where ?? {})) {
      const value = row[key];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as Record<string, unknown>;
        if ('not' in c && value === c.not) return false;
        if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
        if ('gte' in c && !((value as Date) >= (c.gte as Date))) return false;
      } else if (value !== cond) {
        return false;
      }
    }
    return true;
  }

  return { runs, appointments, jobs, vapiCalls, matches,
    nextRunId: () => `run_${++runSeq}`,
    setFailPlacement: (v: boolean) => { failPlacement = v; },
    shouldFailPlacement: () => failPlacement,
    reset: () => { runs.clear(); appointments.length = 0; jobs.length = 0; vapiCalls.length = 0; failPlacement = false; },
  };
});

vi.mock('../lib/prisma', () => ({
  prisma: {
    simulatedCallRun: {
      create: (args: { data: Record<string, unknown> }) => {
        const row = {
          id: state.nextRunId(),
          sourceCallLogId: null, diagnosis: null, fixSummary: null, originNumber: null,
          patientCallId: null, receptionistCallId: null, resultSummary: null,
          resultTranscript: null, resultRecordingUrl: null, resultSuccessScore: null,
          resultOutcome: null, resultDurationSeconds: 0, patientTranscript: null,
          patientRecordingUrl: null, cleanupCount: 0, completedAt: null,
          createdAt: new Date(),
          ...args.data,
        } as never;
        state.runs.set((row as { id: string }).id, row);
        return Promise.resolve(row);
      },
      findFirst: (args: { where: Record<string, unknown>; orderBy?: { createdAt?: string } }) => {
        let rows = [...state.runs.values()].filter((r) => state.matches(r as never, args.where));
        rows = rows.sort((a, b) =>
          args.orderBy?.createdAt === 'desc'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime());
        return Promise.resolve(rows[0] ?? null);
      },
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(state.runs.get(args.where.id) ?? null),
      count: (args: { where: Record<string, unknown> }) =>
        Promise.resolve([...state.runs.values()].filter((r) => state.matches(r as never, args.where)).length),
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.runs.get(args.where.id);
        if (!row) return Promise.reject(new Error('run missing'));
        Object.assign(row, args.data);
        return Promise.resolve(row);
      },
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of state.runs.values()) {
          if (state.matches(row as never, args.where)) { Object.assign(row, args.data); count += 1; }
        }
        return Promise.resolve({ count });
      },
    },
    agentSettings: {
      findUnique: (args: { where: { tenantId: string } }) =>
        Promise.resolve(
          args.where.tenantId === 'tenant_a'
            ? { tenantId: 'tenant_a', displayName: 'Maya', timezone: 'America/Toronto', inboundPhoneNumber: '+14165550100' }
            : null,
        ),
    },
    tenant: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(args.where.id === 'tenant_a' ? { id: 'tenant_a', companyName: 'Alpha Dental' } : null),
    },
    appointment: {
      deleteMany: (args: { where: Record<string, unknown> }) => {
        let count = 0;
        for (let i = state.appointments.length - 1; i >= 0; i -= 1) {
          if (state.matches(state.appointments[i] as never, args.where)) { state.appointments.splice(i, 1); count += 1; }
        }
        return Promise.resolve({ count });
      },
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of state.appointments) {
          if (state.matches(row as never, args.where)) { Object.assign(row, args.data); count += 1; }
        }
        return Promise.resolve({ count });
      },
    },
    jobRequest: {
      deleteMany: (args: { where: Record<string, unknown> }) => {
        let count = 0;
        for (let i = state.jobs.length - 1; i >= 0; i -= 1) {
          if (state.matches(state.jobs[i] as never, args.where)) { state.jobs.splice(i, 1); count += 1; }
        }
        return Promise.resolve({ count });
      },
    },
    callLog: {
      findFirst: () => Promise.resolve(null),
    },
  },
}));

vi.mock('./vapi.service', () => ({
  placeOutboundCall: (input: { phoneNumberId: string; customerNumber: string; assistant: unknown }) => {
    if (state.shouldFailPlacement()) return Promise.reject(new Error('provider refused the call'));
    state.vapiCalls.push(input);
    return Promise.resolve({ id: 'vapi_patient_call_1', status: 'queued' });
  },
}));

vi.mock('./platform-config.service', () => ({
  getSettingValue: (key: string) =>
    Promise.resolve(key === 'PUBLIC_API_URL' ? 'https://api.example.test' : 'test-secret'),
}));

vi.mock('./demo.service', () => ({
  getDemoNumbers: () =>
    Promise.resolve({ us: { id: 'num_us', number: '+17262019604' }, ca: null }),
  pickDemoCallerId: (
    numbers: { us: { id: string; number: string } | null; ca: { id: string; number: string } | null },
    country: string | null,
  ) => (country === 'CA' && numbers.ca ? numbers.ca : (numbers.us ?? numbers.ca ?? null)),
  getOrCreateDemoTenant: () => {
    const day = { enabled: true, open: '08:00', close: '17:00' };
    const off = { enabled: false, open: '09:00', close: '13:00' };
    return Promise.resolve({
      tenant: { id: 'tenant_demo', companyName: 'Bayview Family Clinic', industry: 'CLINIC', slug: 'demo' },
      settings: {
        tenantId: 'tenant_demo', displayName: 'Maya',
        systemPrompt: 'Answer questions about the clinic helpfully.',
        firstMessage: 'Thanks for calling Bayview Family Clinic, this is Maya.',
        voicemailGreeting: 'Please leave a message.',
        wrapUpMessage: null, backgroundSound: null,
        maxCallDurationSeconds: 600, silenceTimeoutSeconds: 30,
        forwardingNumbers: [],
        businessHours: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: off, sun: off },
        timezone: 'America/Vancouver',
        voiceProvider: 'vapi', voiceId: 'Emma',
      },
    });
  },
}));

import {
  buildCustomDrillScenario,
  buildPatientPrompt,
  buildProofScenario,
  captureSimulationEnd,
  checkSimulationAvailability,
  countSimulationsToday,
  DRILL_SCENARIOS,
  findOpenSimulationRun,
  getDrillScenario,
  placeSimulationRun,
  SIMULATED_PATIENT,
  simulationScopeId,
} from './adam-simulation.service';

beforeEach(() => state.reset());

function seedRun(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `seed_${state.runs.size + 1}`,
    tenantId: 'tenant_a', createdByUserId: 'user_a', kind: 'DRILL', status: 'PLACED',
    scenarioTitle: 'Seeded run', scenarioPrompt: 'prompt', sourceCallLogId: null,
    diagnosis: null, fixSummary: null, originNumber: '+17262019604',
    patientCallId: 'vapi_patient_call_1', receptionistCallId: null,
    resultSummary: null, resultTranscript: null, resultRecordingUrl: null,
    resultSuccessScore: null, resultOutcome: null, resultDurationSeconds: 0,
    patientTranscript: null, patientRecordingUrl: null, cleanupCount: 0,
    createdAt: new Date(), completedAt: null,
    ...overrides,
  } as never;
  state.runs.set((row as { id: string }).id, row);
  return row as {
    id: string; status: string; cleanupCount: number;
    resultSummary: string | null; resultSuccessScore: number | null;
    patientTranscript: string | null;
  };
}

describe('scenario generation (from summaries, never identifiers)', () => {
  it('builds a proof scenario from the summary and outcome, with no caller identity', () => {
    const scenario = buildProofScenario({
      summary: 'Caller asked whether the clinic takes Delta Dental. The agent could not answer and took a message.',
      intent: 'QUESTION',
      outcome: 'MESSAGE_TAKEN',
      appointmentBooked: false,
      successScore: 3,
      structuredData: { topic: 'insurance' },
    });
    expect(scenario.goal).toContain('Delta Dental');
    expect(scenario.beats.join(' ')).toMatch(/could not answer|message/i);
    // The summary is the only source: no name or number can appear.
    expect(scenario.goal).not.toMatch(/\+1|callerName/);
  });

  it('falls back to the outcome when the summary is thin', () => {
    const scenario = buildProofScenario({
      summary: null, intent: 'BOOK', outcome: 'NO_ACTION',
      appointmentBooked: false, successScore: 2, structuredData: null,
    });
    expect(scenario.goal.length).toBeGreaterThan(10);
    expect(scenario.beats.length).toBeGreaterThanOrEqual(3);
  });

  it('the patient prompt carries the hard rules: fictional identity, no real booking', () => {
    const prompt = buildPatientPrompt({
      companyName: 'Alpha Dental',
      receptionistName: 'Maya',
      scenario: getDrillScenario('price_shopper')!,
    });
    expect(prompt).toContain(SIMULATED_PATIENT.name);
    expect(prompt).toContain(SIMULATED_PATIENT.callbackDisplay);
    expect(prompt).toMatch(/never agree to finalize or confirm an appointment booking/i);
    expect(prompt).toMatch(/fictional/i);
  });

  it('ships the five required library scenarios', () => {
    const ids = DRILL_SCENARIOS.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(['angry_billing', 'price_shopper', 'nervous_first_timer', 'insurance_question', 'after_hours_emergency']),
    );
    for (const s of DRILL_SCENARIOS) {
      expect(s.goal.length).toBeGreaterThan(20);
      expect(s.beats.length).toBeGreaterThanOrEqual(3);
      expect(s.blurb.length).toBeGreaterThan(5);
    }
  });

  it('wraps a custom scenario in the standard drill shape', () => {
    const scenario = buildCustomDrillScenario('A parent calling about braces for their teenager, comparing two clinics.');
    expect(scenario.title).toMatch(/custom/i);
    expect(scenario.goal).toContain('braces');
  });
});

describe('caps and availability', () => {
  it('counts today per kind and refuses the fourth proof', async () => {
    for (let i = 0; i < 3; i += 1) seedRun({ kind: 'PROOF', status: 'COMPLETED' });
    expect(await countSimulationsToday('tenant_a', 'PROOF', 'America/Toronto')).toBe(3);
    const availability = await checkSimulationAvailability('tenant_a', 'PROOF', 'America/Toronto');
    expect(availability.ok).toBe(false);
    expect(availability.reason).toMatch(/3 proof calls for today/);
    // Drills have their own budget.
    const drills = await checkSimulationAvailability('tenant_a', 'DRILL', 'America/Toronto');
    expect(drills.ok).toBe(true);
  });

  it('failed runs do not consume the cap', async () => {
    for (let i = 0; i < 3; i += 1) seedRun({ kind: 'PROOF', status: 'FAILED' });
    expect(await countSimulationsToday('tenant_a', 'PROOF', 'America/Toronto')).toBe(0);
  });

  it('one in-flight run blocks the next, whatever the kind', async () => {
    seedRun({ kind: 'DRILL', status: 'PLACED' });
    const availability = await checkSimulationAvailability('tenant_a', 'DRILL', 'America/Toronto');
    expect(availability.ok).toBe(false);
    expect(availability.reason).toMatch(/already running/);
  });
});

describe('placement', () => {
  it('places the patient call to the clinic line from the platform caller-ID', async () => {
    const placed = await placeSimulationRun({
      tenantId: 'tenant_a', userId: 'user_a', kind: 'DRILL',
      scenario: getDrillScenario('angry_billing')!,
    });
    expect(placed.originNumber).toBe('+17262019604');
    expect(placed.receptionistNumber).toBe('+14165550100');
    expect(state.vapiCalls).toHaveLength(1);
    expect(state.vapiCalls[0]!.customerNumber).toBe('+14165550100');
    const assistant = state.vapiCalls[0]!.assistant as {
      metadata: Record<string, unknown>;
      model: { tools: unknown[] };
    };
    expect(assistant.metadata.simulationRunId).toBe(placed.runId);
    expect(assistant.metadata.simulationLeg).toBe('patient');
    expect(assistant.model.tools).toEqual([]);
    const run = state.runs.get(placed.runId)!;
    expect(run.status).toBe('PLACED');
    expect(run.scenarioPrompt).toContain(SIMULATED_PATIENT.name);
  });

  it('marks the run FAILED and throws when placement fails', async () => {
    state.setFailPlacement(true);
    await expect(
      placeSimulationRun({ tenantId: 'tenant_a', userId: 'user_a', kind: 'DRILL', scenario: getDrillScenario('price_shopper')! }),
    ).rejects.toThrow(/provider refused/);
    const run = [...state.runs.values()][0]!;
    expect(run.status).toBe('FAILED');
  });

  it('refuses a fourth proof at placement time too', async () => {
    for (let i = 0; i < 3; i += 1) seedRun({ kind: 'PROOF', status: 'COMPLETED' });
    await expect(
      placeSimulationRun({
        tenantId: 'tenant_a', userId: 'user_a', kind: 'PROOF',
        scenario: buildProofScenario({ summary: 'x', intent: null, outcome: null, appointmentBooked: false, successScore: 1, structuredData: null }),
      }),
    ).rejects.toThrow(/3 proof calls for today/);
    expect(state.vapiCalls).toHaveLength(0);
  });
});

describe('open-run matching', () => {
  it('matches by tenant and origin number, formatting aside', async () => {
    seedRun({ id: 'run_match' });
    const found = await findOpenSimulationRun({ tenantId: 'tenant_a', callerNumber: '+1 (726) 201-9604' });
    expect(found?.id).toBe('run_match');
  });

  it('does not match another tenant, another caller, or a stale run', async () => {
    seedRun({ id: 'run_other_tenant', tenantId: 'tenant_b' });
    seedRun({ id: 'run_other_caller', originNumber: '+19995550100' });
    seedRun({ id: 'run_stale', createdAt: new Date(Date.now() - 11 * 60_000) });
    expect(await findOpenSimulationRun({ tenantId: 'tenant_a', callerNumber: '+17262019604' })).toBeNull();
    expect(await findOpenSimulationRun({ tenantId: 'tenant_a', callerNumber: null })).toBeNull();
  });
});

describe('capture and the no-live-booking guarantee', () => {
  const endInput = (leg: 'patient' | 'receptionist', overrides: Record<string, unknown> = {}) => ({
    runId: 'run_cap', leg,
    externalCallId: leg === 'receptionist' ? 'call_recept_1' : 'vapi_patient_call_1',
    startedAt: new Date(Date.now() - 120_000), endedAt: new Date(),
    summary: 'The receptionist answered the insurance question and offered times.',
    transcript: 'AI: Thanks for calling. User: Do you take Delta Dental?',
    recordingUrl: 'https://storage.example/sim.wav',
    structuredData: { appointmentBooked: 'false' },
    successEvaluation: '8',
    ...overrides,
  });

  it('completes from the receptionist leg, cleans the sandbox, and sweeps a leaked real booking', async () => {
    seedRun({ id: 'run_cap', status: 'ANSWERED', receptionistCallId: 'call_recept_1' });
    const scope = simulationScopeId('run_cap');
    state.appointments.push(
      { id: 'appt_sandbox', tenantId: 'tenant_demo', demoSessionId: scope, externalCallId: 'call_recept_1', status: 'CONFIRMED' },
      { id: 'appt_leak', tenantId: 'tenant_a', demoSessionId: null, externalCallId: 'call_recept_1', status: 'CONFIRMED' },
      { id: 'appt_real', tenantId: 'tenant_a', demoSessionId: null, externalCallId: 'call_someone_else', status: 'CONFIRMED' },
    );
    state.jobs.push({ id: 'job_sandbox', tenantId: 'tenant_demo', demoSessionId: scope });

    await captureSimulationEnd(endInput('receptionist'));

    const run = state.runs.get('run_cap')!;
    expect(run.status).toBe('COMPLETED');
    expect(run.resultSuccessScore).toBe(8);
    // Sandbox rows are gone entirely.
    expect(state.appointments.find((a) => a.id === 'appt_sandbox')).toBeUndefined();
    expect(state.jobs).toHaveLength(0);
    // The leaked real-calendar booking was cancelled, not left live.
    expect(state.appointments.find((a) => a.id === 'appt_leak')!.status).toBe('CANCELLED');
    // An unrelated real booking is untouched.
    expect(state.appointments.find((a) => a.id === 'appt_real')!.status).toBe('CONFIRMED');
    // Nothing CONFIRMED survives that carries the simulated call's id.
    expect(state.appointments.filter((a) => a.externalCallId === 'call_recept_1' && a.status === 'CONFIRMED')).toHaveLength(0);
    expect(run.cleanupCount).toBe(3);
  });

  it('a duplicate receptionist report does not overwrite the first capture', async () => {
    seedRun({ id: 'run_cap', status: 'ANSWERED', receptionistCallId: 'call_recept_1' });
    await captureSimulationEnd(endInput('receptionist'));
    await captureSimulationEnd(endInput('receptionist', { summary: 'SECOND REPORT', successEvaluation: '1' }));
    const run = state.runs.get('run_cap')!;
    expect(run.resultSummary).toContain('insurance question');
    expect(run.resultSuccessScore).toBe(8);
  });

  it('the patient leg ending while still PLACED fails the run honestly', async () => {
    seedRun({ id: 'run_cap', status: 'PLACED' });
    await captureSimulationEnd(endInput('patient', { transcript: 'User: Hello?' }));
    const run = state.runs.get('run_cap')!;
    expect(run.status).toBe('FAILED');
    expect(run.resultSummary).toMatch(/never answered/);
    expect(run.patientTranscript).toContain('Hello?');
  });

  it('the patient leg after completion only adds fallback evidence', async () => {
    seedRun({ id: 'run_cap', status: 'COMPLETED', resultSummary: 'done' });
    await captureSimulationEnd(endInput('patient', { transcript: 'patient words' }));
    const run = state.runs.get('run_cap')!;
    expect(run.status).toBe('COMPLETED');
    expect(run.patientTranscript).toBe('patient words');
  });

  it('an unknown run id is a quiet no-op', async () => {
    await expect(captureSimulationEnd(endInput('receptionist', { runId: 'run_ghost' }))).resolves.toBeUndefined();
  });
});
