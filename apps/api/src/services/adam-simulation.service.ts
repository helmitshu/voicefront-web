import type { SimulatedCallRun } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { normalizePhone } from '../lib/phone';
import { signMediaToken } from '../lib/jwt';
import { getSettingValue } from './platform-config.service';
import { getDemoNumbers, getOrCreateDemoTenant, pickDemoCallerId } from './demo.service';
import { placeOutboundCall } from './vapi.service';
import { buildTransientAssistant, type TransientAssistant } from '../domain/assistant-builder';
import { normalizeCallOutcome } from './calllog.service';
import { utcToZonedParts, zonedToUtc } from './appointment.service';

/**
 * Simulated-patient calls for the support agent (Adam): Fix and Prove
 * (phase 1) and Patient Drills (phase 2).
 *
 * The mechanism reuses the platform's existing call machinery end to end:
 *  - The patient is a TRANSIENT assistant built by the same builder the
 *    demo uses, carrying a per-run scenario prompt. It dials the
 *    workspace's OWN receptionist number from the platform demo caller-ID
 *    (the exact placeOutboundCall path the sales demo uses), so no real
 *    person's phone is ever dialed: the call is assistant-to-assistant.
 *  - Both legs carry `simulationRunId` in their assistant metadata — the
 *    demo marker pattern (demoSessionId) extended. The webhook matches the
 *    inbound leg to its open run (tenant resolved by the dialed number,
 *    caller matched to the run's origin number) and answers it with a
 *    transient receptionist built from the tenant's LIVE settings, so a
 *    proof replays against the receptionist as she is NOW, fix included.
 *  - Results are captured on the SimulatedCallRun row by the webhook.
 *    Simulated calls never become tenant CallLogs, so they cannot enter
 *    patient stats, monthly usage minutes, or ROI math.
 *  - During the call the receptionist's booking/job tools are clamped to
 *    a sandbox scope (the demo tenant + a per-run demoSessionId), exactly
 *    like the landing-page demo clamps its calendar. The finalizer deletes
 *    those sandbox rows, and also cancels any real-calendar appointment
 *    that somehow carries the receptionist leg's call id (by design there
 *    are none — the sweep is the belt to the sandbox's braces, and the
 *    count lands on the run so it is never silent).
 *
 * PHI discipline: scenarios are generated from call SUMMARIES and
 * structured data only, never raw patient identifiers. The simulated
 * patient is a fictional person with a made-up 555-01XX callback number,
 * and its script forbids confirming a booking.
 */

export type SimulationKind = 'PROOF' | 'DRILL';

/** Per-tenant daily caps, enforced at propose time and again at run time. */
export const SIMULATION_DAILY_CAPS: Record<SimulationKind, number> = { PROOF: 3, DRILL: 5 };

/** A run whose call never lands inside this window is timed out lazily. */
const RUN_TIMEOUT_MS = 15 * 60_000;
/** A second run for the same workspace cannot be placed while one is open. */
const IN_FLIGHT_WINDOW_MS = 10 * 60_000;

/** The fictional patient. 202-555-0147 is inside the reserved 555-01XX
 *  fictional range, so the number can never belong to a real person. */
export const SIMULATED_PATIENT = {
  name: 'Jordan Ellis',
  callbackDisplay: '+1 (202) 555-0147',
  voice: { provider: 'vapi', voiceId: 'Elliot' },
} as const;

/** The sandbox scope a run's bookings/jobs are written under. */
export function simulationScopeId(runId: string): string {
  return `sim_${runId}`;
}

/* --------------------------- scenario sources ---------------------------- */

export interface SimulationScenario {
  title: string;
  /** What the simulated patient is trying to do, in plain words. */
  goal: string;
  /** Numbered beats the patient works through, in order. */
  beats: string[];
}

const PATIENT_HARD_RULES = [
  'HARD RULES, never break these:',
  '- Never agree to finalize or confirm an appointment booking. If the receptionist offers a time, say it sounds good but you need to check your schedule and will call back to confirm. The call must end with nothing booked.',
  '- Never give real personal information. Your name and callback number above are fictional test details; if asked for anything else (insurance member id, date of birth, payment details), say you do not have it with you.',
  '- Keep the whole call under about three minutes. Work through your beats in order, one at a time, and let the receptionist answer fully before you speak again.',
  '- When your goal is reached, or it is clear the receptionist cannot help with it, thank her warmly and end the call.',
  '- Stay in character as an ordinary patient the whole call. Never mention that you are an AI, a test, or a simulation.',
].join('\n');

/** Assembles the simulated patient's system prompt from a scenario. */
export function buildPatientPrompt(params: {
  companyName: string;
  receptionistName: string;
  scenario: SimulationScenario;
}): string {
  return [
    `You are ${SIMULATED_PATIENT.name}, a patient calling ${params.companyName}. You are speaking with their receptionist, ${params.receptionistName}, on a normal phone call.`,
    `Your callback number, if she asks, is ${SIMULATED_PATIENT.callbackDisplay}.`,
    '',
    `YOUR GOAL: ${params.scenario.goal}`,
    '',
    'HOW THE CALL SHOULD GO:',
    ...params.scenario.beats.map((b, i) => `${i + 1}. ${b}`),
    '',
    PATIENT_HARD_RULES,
  ].join('\n');
}

/**
 * What the original caller wanted, in one line, from the call's summary and
 * structured data. Summaries are the receptionist's own recap, so this is
 * safe to hand the simulated patient; raw identifiers never enter a
 * scenario (the caller name and number are deliberately not read here).
 */
function callerGoalFromCall(call: {
  summary: string | null;
  intent: string | null;
  outcome: string | null;
  structuredData: unknown;
}): string {
  const sd =
    call.structuredData && typeof call.structuredData === 'object'
      ? (call.structuredData as Record<string, unknown>)
      : {};
  const topic = typeof sd.topic === 'string' && sd.topic.trim() ? sd.topic.trim() : null;
  const firstSentence = (call.summary ?? '').split(/(?<=[.!?])\s+/)[0]?.trim() ?? '';
  if (firstSentence) return firstSentence;
  if (topic) return `You called about: ${topic}.`;
  if (call.intent === 'BOOK') return 'You called to book an appointment.';
  if (call.intent === 'QUESTION') return 'You called with a question for the clinic.';
  return 'You called the clinic for help.';
}

/** Where the original call went wrong, in one line, from its outcome data. */
function failureFromCall(call: {
  outcome: string | null;
  intent: string | null;
  appointmentBooked: boolean | null;
  successScore: number | null;
}): string {
  if (call.intent === 'BOOK' && call.appointmentBooked !== true) {
    return 'Last time, the caller never got booked even though that is what they called for.';
  }
  if (call.outcome === 'NO_ACTION') {
    return 'Last time, the call ended with nothing done for the caller.';
  }
  if (call.outcome === 'MESSAGE_TAKEN') {
    return 'Last time, the receptionist could only take a message instead of helping directly.';
  }
  if (call.successScore !== null && call.successScore <= 4) {
    return `Last time, the call was scored ${call.successScore} out of 10 for how it was handled.`;
  }
  return 'Last time, the call did not go well.';
}

/**
 * Builds the replay scenario for a proof from the original call's summary
 * and structured outcome. Pure and exported: the scenario is the contract
 * between Adam's diagnosis and the simulated patient.
 */
export function buildProofScenario(call: {
  summary: string | null;
  intent: string | null;
  outcome: string | null;
  appointmentBooked: boolean | null;
  successScore: number | null;
  structuredData: unknown;
}): SimulationScenario {
  const goal = callerGoalFromCall(call);
  const failure = failureFromCall(call);
  return {
    title: 'Replay of the call that went wrong',
    goal,
    beats: [
      `Call the clinic and ask for the same thing as the original caller: ${goal}`,
      'If the receptionist asks clarifying questions, answer them the way an ordinary patient would, briefly and naturally.',
      `${failure} Push politely for a real resolution this time, the way the original caller would have wanted.`,
      'Do not mention the earlier call. To you, this is your first call.',
    ],
  };
}

/* ------------------------------ drill library ---------------------------- */

export interface DrillScenario extends SimulationScenario {
  id: string;
  /** One line the owner reads in the picker. */
  blurb: string;
}

export const DRILL_SCENARIOS: DrillScenario[] = [
  {
    id: 'angry_billing',
    title: 'Angry caller disputing a bill',
    blurb: 'A patient is upset about a charge they did not expect.',
    goal: 'You received a bill for more than you were quoted and you are frustrated. You want an explanation and the charge reviewed.',
    beats: [
      'Open upset but not abusive: you were quoted one amount and billed noticeably more.',
      'Ask what the extra charge is for, and do not accept a vague answer; ask twice if you have to.',
      'Ask what can be done about it: a review, a callback from the office manager, or an itemized bill.',
      'If she stays calm and gives you a concrete next step, let yourself settle and thank her.',
    ],
  },
  {
    id: 'price_shopper',
    title: 'Price shopper comparing cleanings',
    blurb: 'A caller comparing your cleaning price with two other clinics.',
    goal: 'You are calling around for the price of a standard cleaning before you choose a clinic.',
    beats: [
      'Ask directly what a cleaning costs for a new patient.',
      'Mention another clinic quoted you less, and ask what is included in this clinic\'s price.',
      'Ask about any new-patient specials or payment options.',
      'Say you are deciding today between two clinics, and see what she offers to help you choose.',
    ],
  },
  {
    id: 'nervous_first_timer',
    title: 'Nervous first-time patient',
    blurb: 'An anxious caller who has avoided dentists for years.',
    goal: 'You have not seen a dentist in about five years and you are embarrassed and nervous. You want a gentle first checkup.',
    beats: [
      'Admit you are nervous and have avoided the dentist for years; ask if that is a problem.',
      'Ask what the first visit involves and whether it will hurt.',
      'Ask whether the dentist is gentle with anxious patients.',
      'If she makes you feel safe, lean toward booking, but follow the rule and do not confirm a booking.',
    ],
  },
  {
    id: 'insurance_question',
    title: 'Caller asking about insurance',
    blurb: 'A caller whose plan the clinic may or may not take.',
    goal: 'You want to know whether the clinic takes your insurance before you book anything.',
    beats: [
      'Ask whether the clinic takes your dental plan; name it as "Delta Dental" when she asks which one.',
      'If she is unsure, ask how patients usually confirm coverage.',
      'Ask what a first visit costs if you end up paying out of pocket.',
      'Ask what happens to the appointment if coverage turns out not to apply.',
    ],
  },
  {
    id: 'after_hours_emergency',
    title: 'After-hours emergency toothache',
    blurb: 'A caller in pain outside office hours, testing the urgent path.',
    goal: 'You have a severe toothache that started tonight and you need help fast.',
    beats: [
      'Say right away that this is urgent: severe tooth pain, getting worse.',
      'Ask whether anyone can see you tonight or first thing in the morning.',
      'Ask what you should do tonight if nobody can see you.',
      'If she offers an urgent transfer or an emergency callback path, take it seriously and follow her lead.',
    ],
  },
];

export function getDrillScenario(id: string): DrillScenario | null {
  return DRILL_SCENARIOS.find((s) => s.id === id) ?? null;
}

/** Builds a drill scenario from the owner's free-text description. */
export function buildCustomDrillScenario(text: string): SimulationScenario {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return {
    title: 'Custom drill',
    goal: cleaned,
    beats: [
      `Call the clinic and play this situation: ${cleaned}`,
      'React naturally to what the receptionist says, the way a real patient in this situation would.',
      'Push politely for a clear resolution, and notice whether she offers one.',
    ],
  };
}

/* ------------------------------ run storage ------------------------------ */

/** Start of the workspace-local calendar day containing `now`. */
function startOfTenantDay(timezone: string, now: Date): Date {
  const local = utcToZonedParts(now, timezone);
  return zonedToUtc(local.date, '00:00', timezone);
}

/** Runs of one kind already created today (workspace-local) for a tenant. */
export async function countSimulationsToday(
  tenantId: string,
  kind: SimulationKind,
  timezone: string,
  now: Date = new Date(),
): Promise<number> {
  return prisma.simulatedCallRun.count({
    where: {
      tenantId,
      kind,
      status: { not: 'FAILED' },
      createdAt: { gte: startOfTenantDay(timezone, now) },
    },
  });
}

async function hasInFlightRun(tenantId: string, now: Date): Promise<boolean> {
  const open = await prisma.simulatedCallRun.findFirst({
    where: {
      tenantId,
      status: { in: ['PLACED', 'ANSWERED'] },
      createdAt: { gte: new Date(now.getTime() - IN_FLIGHT_WINDOW_MS) },
    },
    select: { id: true },
  });
  return open !== null;
}

export interface SimulationAvailability {
  ok: boolean;
  /** Plain-words reason, fit for Adam to relay, when ok is false. */
  reason?: string;
  proofsUsedToday: number;
  drillsUsedToday: number;
}

/**
 * Everything that must be true before a run may be proposed: the tenant has
 * a receptionist line, the platform has a caller-ID to originate from, the
 * daily cap has room, and no other run for this workspace is in flight.
 */
export async function checkSimulationAvailability(
  tenantId: string,
  kind: SimulationKind,
  timezone: string,
): Promise<SimulationAvailability> {
  const [settings, numbers, proofsUsedToday, drillsUsedToday, inFlight] = await Promise.all([
    prisma.agentSettings.findUnique({
      where: { tenantId },
      select: { inboundPhoneNumber: true },
    }),
    getDemoNumbers(),
    countSimulationsToday(tenantId, 'PROOF', timezone),
    countSimulationsToday(tenantId, 'DRILL', timezone),
    hasInFlightRun(tenantId, new Date()),
  ]);
  const used = kind === 'PROOF' ? proofsUsedToday : drillsUsedToday;
  const base = { proofsUsedToday, drillsUsedToday };
  if (!settings?.inboundPhoneNumber) {
    return { ...base, ok: false, reason: 'This workspace does not have a receptionist line set up yet, so there is no number for the simulated patient to call.' };
  }
  if (!pickDemoCallerId(numbers, null)) {
    return { ...base, ok: false, reason: 'Simulated calls are not configured on the platform yet (no caller-ID number is assigned for them).' };
  }
  if (inFlight) {
    return { ...base, ok: false, reason: 'A simulated call for this workspace is already running. Give it a minute to finish first.' };
  }
  if (used >= SIMULATION_DAILY_CAPS[kind]) {
    return {
      ...base,
      ok: false,
      reason: `This workspace has used its ${SIMULATION_DAILY_CAPS[kind]} ${kind === 'PROOF' ? 'proof' : 'drill'} calls for today. The cap resets tomorrow.`,
    };
  }
  return { ...base, ok: true };
}

/* --------------------------- patient assistant --------------------------- */

/**
 * Builds the simulated patient as a transient assistant through the same
 * builder the demo uses (with the sales path's systemPromptOverride slot),
 * then strips everything a patient must not have: no booking tools, no
 * stock end-call message, and the receptionist greets first because the
 * patient is the caller. Metadata carries the run marker both legs are
 * captured by.
 */
async function buildPatientAssistant(params: {
  runId: string;
  tenantId: string;
  scenario: SimulationScenario;
  companyName: string;
  receptionistName: string;
}): Promise<TransientAssistant> {
  const bundle = await getOrCreateDemoTenant();
  const [publicApiUrl, webhookSecret] = await Promise.all([
    getSettingValue('PUBLIC_API_URL'),
    getSettingValue('VAPI_WEBHOOK_SECRET'),
  ]);
  const assistant = buildTransientAssistant(bundle.tenant, bundle.settings, 'phone', new Date(), {
    serverUrl: publicApiUrl ? `${publicApiUrl}/api/vapi/inbound` : undefined,
    // The patient leg is NOT a demo payload, so it gets no secret bypass:
    // its server messages must carry the real webhook secret.
    serverSecret: webhookSecret ?? undefined,
    systemPromptOverride: buildPatientPrompt({
      companyName: params.companyName,
      receptionistName: params.receptionistName,
      scenario: params.scenario,
    }),
    assistantName: `Simulated patient · ${params.scenario.title}`.slice(0, 40),
    voice: { provider: SIMULATED_PATIENT.voice.provider, voiceId: SIMULATED_PATIENT.voice.voiceId },
  });
  assistant.metadata = {
    tenantId: params.tenantId,
    channel: 'phone',
    simulationRunId: params.runId,
    simulationLeg: 'patient',
  };
  // The receptionist answers and greets first; the patient waits.
  assistant.firstMessageMode = 'assistant-waits-for-user';
  assistant.firstMessage = '';
  // A patient with booking tools could act on the clinic; it gets none.
  assistant.model.tools = [];
  // No stock goodbye in the clinic's name: the patient owns its own close.
  delete assistant.endCallMessage;
  // A drill is a taste, not a shift: cap the call well under a real one.
  assistant.maxDurationSeconds = 240;
  return assistant;
}

/* ------------------------------ run lifecycle ---------------------------- */

export interface PlaceSimulationInput {
  tenantId: string;
  userId: string;
  kind: SimulationKind;
  scenario: SimulationScenario;
  sourceCallLogId?: string | null;
  diagnosis?: string | null;
  fixSummary?: string | null;
}

export interface PlacedSimulation {
  runId: string;
  status: string;
  patientCallId: string;
  receptionistNumber: string;
  originNumber: string;
}

/**
 * Creates the run row and places the patient call. Re-checks availability
 * at run time (the cap and the in-flight rule are enforced here, not just
 * at propose time, so a stale proposal can never sneak a call past them).
 * A placement failure marks the run FAILED and throws, so Adam relays the
 * real problem instead of announcing a call that never happened.
 */
export async function placeSimulationRun(input: PlaceSimulationInput): Promise<PlacedSimulation> {
  const [tenant, settings] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: input.tenantId },
      select: { companyName: true },
    }),
    prisma.agentSettings.findUnique({ where: { tenantId: input.tenantId } }),
  ]);
  if (!tenant || !settings) {
    throw new HttpError(409, 'Receptionist settings are missing for this workspace.', 'SETTINGS_MISSING');
  }
  if (!settings.inboundPhoneNumber) {
    throw new HttpError(
      409,
      'This workspace does not have a receptionist line set up yet, so there is no number for the simulated patient to call.',
      'SIMULATION_NO_LINE',
    );
  }

  const availability = await checkSimulationAvailability(input.tenantId, input.kind, settings.timezone);
  if (!availability.ok) {
    throw new HttpError(409, availability.reason ?? 'Simulated calls are unavailable right now.', 'SIMULATION_UNAVAILABLE');
  }

  const numbers = await getDemoNumbers();
  const callerId = pickDemoCallerId(numbers, null);
  if (!callerId) {
    throw new HttpError(409, 'Simulated calls are not configured on the platform yet.', 'SIMULATION_UNAVAILABLE');
  }

  const run = await prisma.simulatedCallRun.create({
    data: {
      tenantId: input.tenantId,
      createdByUserId: input.userId,
      kind: input.kind,
      status: 'PLACED',
      scenarioTitle: input.scenario.title,
      scenarioPrompt: '',
      sourceCallLogId: input.sourceCallLogId ?? null,
      diagnosis: input.diagnosis ?? null,
      fixSummary: input.fixSummary ?? null,
      originNumber: callerId.number,
    },
  });

  try {
    const patientAssistant = await buildPatientAssistant({
      runId: run.id,
      tenantId: input.tenantId,
      scenario: input.scenario,
      companyName: tenant.companyName,
      receptionistName: settings.displayName,
    });
    await prisma.simulatedCallRun.update({
      where: { id: run.id },
      data: { scenarioPrompt: patientAssistant.model.messages[0]?.content ?? '' },
    });
    const call = await placeOutboundCall({
      phoneNumberId: callerId.id,
      customerNumber: settings.inboundPhoneNumber,
      assistant: patientAssistant,
    });
    const updated = await prisma.simulatedCallRun.update({
      where: { id: run.id },
      data: { patientCallId: call.id },
    });
    return {
      runId: updated.id,
      status: updated.status,
      patientCallId: call.id,
      receptionistNumber: settings.inboundPhoneNumber,
      originNumber: callerId.number,
    };
  } catch (err) {
    await prisma.simulatedCallRun
      .update({ where: { id: run.id }, data: { status: 'FAILED', completedAt: new Date() } })
      .catch(() => undefined);
    throw err;
  }
}

/**
 * Matches an inbound call to its open run: the tenant is already resolved
 * (by the dialed number) by the webhook, so a run matches when it belongs
 * to that tenant, is still PLACED, is fresh, and the caller is the number
 * the patient leg was placed from. Returns null for ordinary calls.
 */
export async function findOpenSimulationRun(params: {
  tenantId: string;
  callerNumber: string | null;
  now?: Date;
}): Promise<SimulatedCallRun | null> {
  if (!params.callerNumber) return null;
  const now = params.now ?? new Date();
  const caller = normalizePhone(params.callerNumber);
  const run = await prisma.simulatedCallRun.findFirst({
    where: {
      tenantId: params.tenantId,
      status: 'PLACED',
      createdAt: { gte: new Date(now.getTime() - IN_FLIGHT_WINDOW_MS) },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!run || !run.originNumber) return null;
  return normalizePhone(run.originNumber) === caller ? run : null;
}

/** Marks a run answered by its receptionist leg (assistant-request time). */
export async function markSimulationAnswered(runId: string, receptionistCallId: string | null): Promise<void> {
  await prisma.simulatedCallRun.updateMany({
    where: { id: runId, status: 'PLACED' },
    data: { status: 'ANSWERED', receptionistCallId: receptionistCallId ?? undefined },
  });
}

/** Tenant-scoped run read. Another workspace's run id returns null. */
export async function getSimulationRun(tenantId: string, runId: string): Promise<SimulatedCallRun | null> {
  return prisma.simulatedCallRun.findFirst({ where: { id: runId, tenantId } });
}

/** Unscoped run read for the webhook, which resolves runs by id alone. */
export async function getSimulationRunById(runId: string): Promise<SimulatedCallRun | null> {
  return prisma.simulatedCallRun.findUnique({ where: { id: runId } });
}

/* --------------------------- result capture ------------------------------ */

export interface SimulationEndInput {
  runId: string;
  leg: 'patient' | 'receptionist';
  externalCallId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  summary: string | null;
  transcript: string | null;
  recordingUrl: string | null;
  structuredData?: Record<string, unknown> | null;
  successEvaluation?: string | number | null;
}

/**
 * Deletes the run's sandbox rows (demo tenant, per-run scope) and cancels
 * any real-calendar appointment carrying the receptionist leg's call id.
 * Returns how many rows were removed or cancelled.
 */
async function finalizeSimulationCleanup(run: SimulatedCallRun): Promise<number> {
  const scope = simulationScopeId(run.id);
  let cleaned = 0;
  try {
    const bundle = await getOrCreateDemoTenant();
    const [appointments, jobs] = await Promise.all([
      prisma.appointment.deleteMany({ where: { tenantId: bundle.tenant.id, demoSessionId: scope } }),
      prisma.jobRequest.deleteMany({ where: { tenantId: bundle.tenant.id, demoSessionId: scope } }),
    ]);
    cleaned += appointments.count + jobs.count;
  } catch (err) {
    console.error('[simulation] sandbox cleanup failed:', err);
  }
  if (run.receptionistCallId) {
    // Belt and braces: the tool-call clamp makes this a no-op by design,
    // but if any path ever wrote a real booking for this call, it does not
    // survive the run.
    const leaked = await prisma.appointment.updateMany({
      where: {
        tenantId: run.tenantId,
        externalCallId: run.receptionistCallId,
        demoSessionId: null,
        status: 'CONFIRMED',
      },
      data: { status: 'CANCELLED' },
    });
    cleaned += leaked.count;
  }
  return cleaned;
}

/**
 * Captures one leg's end-of-call report onto the run. The receptionist leg
 * is canonical: it completes the run and triggers cleanup. The patient leg
 * is fallback evidence; if it ends and the receptionist never answered,
 * the run fails honestly instead of hanging forever.
 */
export async function captureSimulationEnd(input: SimulationEndInput): Promise<void> {
  const run = await getSimulationRunById(input.runId);
  if (!run) return;

  if (input.leg === 'patient') {
    await prisma.simulatedCallRun.update({
      where: { id: run.id },
      data: {
        patientCallId: run.patientCallId ?? input.externalCallId ?? undefined,
        patientTranscript: input.transcript ?? run.patientTranscript,
        patientRecordingUrl: input.recordingUrl ?? run.patientRecordingUrl,
        ...(run.status === 'PLACED'
          ? { status: 'FAILED', completedAt: new Date(), resultSummary: 'The receptionist line never answered the simulated call.' }
          : {}),
      },
    });
    return;
  }

  // Receptionist leg.
  if (run.status === 'COMPLETED') return; // duplicate delivery: first capture wins
  const outcome = normalizeCallOutcome(input.structuredData, input.successEvaluation);
  const durationSeconds =
    input.startedAt && input.endedAt
      ? Math.max(0, Math.round((input.endedAt.getTime() - input.startedAt.getTime()) / 1000))
      : 0;
  const withCallId = input.externalCallId
    ? { ...run, receptionistCallId: run.receptionistCallId ?? input.externalCallId }
    : run;
  const cleanupCount = await finalizeSimulationCleanup(withCallId);
  await prisma.simulatedCallRun.update({
    where: { id: run.id },
    data: {
      status: 'COMPLETED',
      receptionistCallId: withCallId.receptionistCallId,
      resultSummary: input.summary,
      resultTranscript: input.transcript,
      resultRecordingUrl: input.recordingUrl,
      resultSuccessScore: outcome.successScore,
      resultOutcome: outcome.outcome,
      resultDurationSeconds: durationSeconds,
      cleanupCount,
      completedAt: new Date(),
    },
  });
}

/* ----------------------------- presentation ------------------------------ */

export interface SimulationPresentation {
  runId: string;
  kind: SimulationKind;
  status: string;
  scenarioTitle: string;
  diagnosis: string | null;
  fixSummary: string | null;
  cleanupCount: number;
  before: {
    callId: string;
    when: string;
    successScore: number | null;
    outcome: string | null;
    summary: string | null;
    /** Signed media token for the recording, or null when there is none. */
    mediaToken: string | null;
  } | null;
  after: {
    successScore: number | null;
    outcome: string | null;
    summary: string | null;
    transcript: string | null;
    transcriptAvailable: boolean;
    durationSeconds: number;
    mediaToken: string | null;
  } | null;
  /** Set when the run is still in flight, or ended without a result. */
  note: string | null;
}

/**
 * The before/after bundle Adam presents. Applies the lazy timeout: a run
 * still open past the window is marked TIMED_OUT so nobody waits on a call
 * that will never report.
 */
export async function getSimulationPresentation(
  tenantId: string,
  runId: string,
  now: Date = new Date(),
): Promise<SimulationPresentation | null> {
  let run = await getSimulationRun(tenantId, runId);
  if (!run) return null;

  if (
    (run.status === 'PLACED' || run.status === 'ANSWERED') &&
    now.getTime() - run.createdAt.getTime() > RUN_TIMEOUT_MS
  ) {
    run = await prisma.simulatedCallRun.update({
      where: { id: run.id },
      data: { status: 'TIMED_OUT', completedAt: now },
    });
  }

  const settings = await prisma.agentSettings.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  const timezone = settings?.timezone ?? 'UTC';

  let before: SimulationPresentation['before'] = null;
  if (run.sourceCallLogId) {
    const call = await prisma.callLog.findFirst({
      where: { id: run.sourceCallLogId, tenantId },
      select: {
        id: true, startedAt: true, successScore: true, outcome: true, summary: true, recordingUrl: true,
      },
    });
    if (call) {
      before = {
        callId: call.id,
        when: new Intl.DateTimeFormat('en-US', {
          timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        }).format(call.startedAt),
        successScore: call.successScore,
        outcome: call.outcome,
        summary: call.summary,
        mediaToken: call.recordingUrl ? signMediaToken({ callLogId: call.id, tenantId }) : null,
      };
    }
  }

  const transcript = run.resultTranscript ?? run.patientTranscript;
  const completed = run.status === 'COMPLETED';
  const after: SimulationPresentation['after'] = completed
    ? {
        successScore: run.resultSuccessScore,
        outcome: run.resultOutcome,
        summary: run.resultSummary,
        transcript,
        transcriptAvailable: typeof transcript === 'string' && transcript.trim().length > 0,
        durationSeconds: run.resultDurationSeconds,
        mediaToken: (run.resultRecordingUrl ?? run.patientRecordingUrl)
          ? signMediaToken({ callLogId: run.id, tenantId })
          : null,
      }
    : null;

  let note: string | null = null;
  if (run.status === 'PLACED' || run.status === 'ANSWERED') {
    note = 'The simulated call is still running. Ask me again in a moment and I will have the result.';
  } else if (run.status === 'TIMED_OUT') {
    note = 'The simulated call never reported back, so there is no result to grade. The run is closed.';
  } else if (run.status === 'FAILED') {
    note = run.resultSummary ?? 'The simulated call could not be completed.';
  }

  return {
    runId: run.id,
    kind: run.kind as SimulationKind,
    status: run.status,
    scenarioTitle: run.scenarioTitle,
    diagnosis: run.diagnosis,
    fixSummary: run.fixSummary,
    cleanupCount: run.cleanupCount,
    before,
    after,
    note,
  };
}
