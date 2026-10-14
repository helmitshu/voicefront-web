import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { asyncHandler, HttpError } from '../lib/http';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { getSettingValue } from '../services/platform-config.service';
import { buildTransientAssistant, type CallChannel, type TransientAssistant } from '../domain/assistant-builder';
import { E164_REGEX } from '../lib/phone';
import {
  startDemoSession,
  resumeDemoSession,
  getDemoAppointments,
  blockDemoSlot,
  resetDemoSession,
  isDemoEnabled,
  createDemoLead,
  setLeadMode,
  getSalesConfig,
  getDemoNumbers,
  pickDemoCallerId,
  demoSample,
  getDemoScreen,
  clearDemoScreen,
  getDemoSummary,
  clearDemoSummary,
} from '../services/demo.service';
import { placeOutboundCall } from '../services/vapi.service';
import { evaluateGate, clientIp } from '../services/geo.service';
import {
  composeSalesPrompt,
  salesOpener,
  salesSummaryPrompt,
  SALES_PERSONA,
  type SalesContext,
} from '../domain/sales-agent';
import {
  composeReceptionistPrompt,
  receptionistOpener,
  sanitizeDemoText,
  sanitizeReceptionistFacts,
  GOLDEN_DEMO_VOICE,
  GOLDEN_DEMO_TEMPERATURE,
  GOLDEN_DEMO_TRANSCRIBER,
  GOLDEN_DEMO_START_SPEAKING_PLAN,
  GOLDEN_DEMO_STOP_SPEAKING_PLAN,
  GOLDEN_DEMO_SILENCE_TIMEOUT_SECONDS,
  GOLDEN_DEMO_KEYWORDS,
  type ReceptionistContext,
} from '../domain/receptionist-demo';
import { fetchClinicFacts, type ClinicFacts } from '../services/clinic-facts.service';
import { to12h, utcToZonedParts } from '../services/appointment.service';

/**
 * PUBLIC (no auth) endpoints behind the interactive landing-page demo. They
 * expose only the Vapi *public* web key (safe by design) and an isolated,
 * throwaway demo calendar — never any real tenant data.
 */

/* ------------------------- abuse protection ------------------------- */
/* These endpoints are fully public and the outbound "get a call" flow spends
 * real Vapi minutes, so they get layered limits: per-IP throttles on the
 * expensive actions plus a per-session cap so rotating session ids doesn't
 * help an attacker. */

const leadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many demo requests. Please wait a few minutes.', code: 'RATE_LIMITED' } },
});

const callIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many demo calls. Please wait a while before trying again.', code: 'RATE_LIMITED' } },
});

const callSessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  keyGenerator: (req) =>
    `${clientIp(req) ?? 'unknown'}:${(req.body as { sessionId?: unknown } | undefined)?.sessionId ?? 'none'}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'This demo session has used its calls. Start a fresh demo to try again.', code: 'RATE_LIMITED' } },
});

/**
 * Cloudflare Turnstile check for the lead form (bot protection on the entry
 * gate). Env-gated: when TURNSTILE_SECRET_KEY is unset the check is skipped
 * and a warning is logged once in production so the gap stays visible.
 */
let turnstileWarned = false;
export async function verifyTurnstile(token: string | undefined, ip: string | null): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (env.NODE_ENV === 'production' && !turnstileWarned) {
      turnstileWarned = true;
      console.warn('[demo] TURNSTILE_SECRET_KEY is not set — lead form has no bot check.');
    }
    return true;
  }
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
export const demoRouter = Router();

const SessionSchema = z.object({ sessionId: z.string().min(3).max(80).startsWith('demo_') });
const BlockSchema = SessionSchema.extend({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

/** First name only, for a natural greeting ("Hi Sarah, ..."). */
function firstName(name?: string): string | null {
  const f = (name ?? '').trim().split(/\s+/)[0];
  return f && /^[a-zA-Z][a-zA-Z'’-]*$/.test(f) ? f : null;
}

/**
 * Deepgram `keywords` (word:intensity) to boost recognition of the prospect's
 * name — their name is the one word most likely to be unusual and mis-heard,
 * and getting it wrong sours the whole call. Intensity 2 nudges without
 * over-biasing common words.
 */
function nameKeywords(name?: string): string[] {
  return (name ?? '')
    .trim()
    .split(/\s+/)
    .filter((tok) => /^[a-zA-Z][a-zA-Z'’-]{1,}$/.test(tok))
    .slice(0, 3)
    .map((tok) => `${tok}:2`);
}

/** Coerces a typed phone into strict E.164, assuming NANP (+1) when no code. */
function toE164(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '').replace(/^00/, '');
  let e164: string;
  if (hadPlus) e164 = `+${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else e164 = `+${digits}`;
  return E164_REGEX.test(e164) ? e164 : null;
}

/**
 * Builds Ava — her human sales persona + playbook + voice — wired with the
 * demo's booking tools, founder-booking tools, and webhook routing. Shared by
 * the in-browser test ('web') and the outbound "Get a call" flow ('phone').
 */
async function buildSalesAssistant(
  session: Awaited<ReturnType<typeof startDemoSession>>,
  name: string | undefined,
  channel: CallChannel,
) {
  const tz = session.bundle.settings.timezone;
  const now = new Date();
  const localToday = {
    date: utcToZonedParts(now, tz).date,
    weekday: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now),
  };
  const publicApiUrl = await getSettingValue('PUBLIC_API_URL');
  const sales = await getSalesConfig();
  const sample = demoSample(session.day.industry);
  const salesCtx: SalesContext = {
    agentName: sales.agentName,
    founderName: sales.founderName,
    companyName: 'VoiceFront',
    prospectFirstName: firstName(name),
    timezone: tz,
    localToday,
    displayDay: { date: session.day.date, label: session.day.dayLabel },
    // Only the in-browser demo has a screen for Ava to drive.
    screenControl: channel === 'web',
    sample: {
      // The prospect's own business name (if they typed one) wins over the
      // generic industry placeholder — already resolved onto the demo day.
      businessName: session.day.sampleCompany,
      ownName: session.day.sampleCompany !== sample.company,
      sampleLabel: sample.sampleLabel,
      prospectLabel: sample.prospectLabel,
      appointmentNoun: sample.appointmentNoun,
    },
  };

  const assistant = buildTransientAssistant(session.bundle.tenant, session.bundle.settings, channel, now, {
    serverUrl: publicApiUrl ? `${publicApiUrl}/api/vapi/inbound` : undefined,
    systemPromptOverride: composeSalesPrompt(salesCtx),
    assistantName: `${sales.agentName} · VoiceFront sales`,
    voice: { provider: SALES_PERSONA.voiceProvider, voiceId: SALES_PERSONA.voiceId },
    backgroundSound: 'office',
    includeFounderBooking: true,
    // Web demo only: Ava drives the prospect's on-screen panel directly.
    includeScreenControl: channel === 'web',
    // Help the transcriber hear the prospect's (often unusual) name correctly,
    // so Ava isn't working from a garbled spelling.
    transcriberKeywords: nameKeywords(name),
    summaryPrompt: salesSummaryPrompt(salesCtx),
  });
  assistant.metadata = { ...assistant.metadata, demoSessionId: session.sessionId };
  assistant.firstMessage = salesOpener(salesCtx);
  return { assistant, sales };
}

/**
 * Normalizes a phone to its last 10 digits so the same destination matches
 * across formats ("+1 (604) 555-0182" vs "6045550182").
 */
function phoneKey(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.slice(-10);
}

/** Default per-destination cap: demo calls to one number in 24 hours. */
const DEMO_CALLS_PER_NUMBER_PER_DAY = 2;

/**
 * Founder testing allowance: when the demo lead is the founder himself,
 * testing against his own phone, the per-destination cap rises so he can
 * iterate on the demo without locking himself out (his instruction, after
 * the default cap refused his third test call of the day). BOTH halves
 * must match at once — his email on the lead AND his own number as the
 * destination — because triggering the higher cap requires receiving the
 * calls on the founder's own phone: a stranger typing his email with
 * their number, or his number with their email, gains nothing and stays
 * at the default cap.
 */
export const DEMO_OWNER_EMAIL = 'helmitshu@gmail.com';
export const DEMO_OWNER_PHONE = '+1 514 431 5049';
const DEMO_OWNER_CALLS_PER_DAY = 5;

/** True when this call is the founder testing the demo against himself. */
function isDemoOwnerTest(leadEmail: string | null | undefined, customerNumber: string): boolean {
  const email = (leadEmail ?? '').trim().toLowerCase();
  return email === DEMO_OWNER_EMAIL && phoneKey(customerNumber) === phoneKey(DEMO_OWNER_PHONE);
}

/**
 * Per-destination daily cap on demo calls (anti-robocall discipline): at
 * most DEMO_CALLS_PER_NUMBER_PER_DAY completed demo calls to any one
 * number in 24 hours, across all sessions and both demo kinds (the
 * founder's own test pair gets DEMO_OWNER_CALLS_PER_DAY, see
 * isDemoOwnerTest).
 *
 * Approximation, by schema: DemoCall rows carry no destination number (they
 * are written at call end from the webhook), so the count joins through
 * DemoLead.phone — leads created in the last 24h whose normalized number
 * matches, then DemoCall rows on those sessions in the same window. Calls
 * still in flight have no DemoCall row yet and are not counted; the IP and
 * session rate limiters above bound that gap.
 */
async function countRecentDemoCallsTo(customerNumber: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const target = phoneKey(customerNumber);
  if (!target) return 0;
  const leads = await prisma.demoLead.findMany({
    where: { createdAt: { gte: since } },
    select: { demoSessionId: true, phone: true },
  });
  const sessionIds = [
    ...new Set(leads.filter((l) => phoneKey(l.phone) === target).map((l) => l.demoSessionId)),
  ];
  if (sessionIds.length === 0) return 0;
  return prisma.demoCall.count({
    where: { demoSessionId: { in: sessionIds }, createdAt: { gte: since } },
  });
}

/**
 * Transcriber boosts for the receptionist demo: the golden dental set, plus
 * tokens from the clinic's own name and the prospect's name — the words most
 * likely to be mis-heard on the call. Deduped case-insensitively (the clinic
 * name often contributes its own "Dental").
 */
function receptionistKeywords(clinicName: string, prospectName?: string): string[] {
  const byWord = new Map<string, string>();
  for (const kw of [...GOLDEN_DEMO_KEYWORDS, ...nameKeywords(clinicName), ...nameKeywords(prospectName)]) {
    const word = kw.split(':')[0]?.toLowerCase();
    if (word && !byWord.has(word)) byWord.set(word, kw);
  }
  return [...byWord.values()];
}

/** Facts stored on a lead come back as untyped JSON — narrow to a plain object. */
function factsFromJson(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Builds Maya — the prospect's OWN receptionist — for the personalized demo.
 * Same session bundle as the sales path, but her booking tools are swapped
 * for the single function-gated hold_appointment tool, and she runs the
 * retuned demo standard (v2): the golden prompt and guardrails, with the
 * voice, the Deepgram Flux transcriber, and the speaking plans adjusted
 * past the production golden agent per the human-likeness research. All of
 * it is pinned explicitly so the demo can never silently drift back to
 * builder defaults. No founder/screen tooling, and a hard five-minute cap
 * (this is a taste of the product, not the product).
 */
async function buildReceptionistAssistant(
  session: Awaited<ReturnType<typeof startDemoSession>>,
  leadRow: { name: string; businessName: string | null; factsJson: unknown },
  prospectName: string | undefined,
  confirmedFacts: ClinicFacts | undefined,
): Promise<TransientAssistant> {
  const tz = session.bundle.settings.timezone;
  const now = new Date();
  const localToday = {
    date: utcToZonedParts(now, tz).date,
    weekday: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now),
  };
  const storedFacts = factsFromJson(leadRow.factsJson) as ClinicFacts | null;
  // The prospect's confirm-step edits win over what the scraper stored; both
  // are re-sanitized here regardless of what the client sent.
  const facts = sanitizeReceptionistFacts(confirmedFacts ?? storedFacts);
  const clinicName =
    sanitizeDemoText(confirmedFacts?.businessName, 60) ||
    sanitizeDemoText(storedFacts?.businessName, 60) ||
    sanitizeDemoText(leadRow.businessName, 60) ||
    'the clinic';
  const ctx: ReceptionistContext = {
    clinicName,
    facts,
    prospectFirstName: firstName(prospectName ?? leadRow.name),
    timezone: tz,
    localToday,
    displayDay: { date: session.day.date, label: session.day.dayLabel },
  };
  const [publicApiUrl, webhookSecret] = await Promise.all([
    getSettingValue('PUBLIC_API_URL'),
    getSettingValue('VAPI_WEBHOOK_SECRET'),
  ]);
  const assistant = buildTransientAssistant(session.bundle.tenant, session.bundle.settings, 'phone', now, {
    serverUrl: publicApiUrl ? `${publicApiUrl}/api/vapi/inbound` : undefined,
    // Function-gated booking: the hold_appointment tool replaces the stock
    // booking tools, and its calls land on POST /demo/hold below, which
    // verifies the webhook secret strictly and enforces one live hold per
    // call. Without a public API URL the tool has nowhere to call home, so
    // the assistant falls back to the standard booking tools (the same
    // graceful fallback shape as serverUrl).
    holdAppointment: publicApiUrl
      ? { serverUrl: `${publicApiUrl}/api/demo/hold`, serverSecret: webhookSecret ?? undefined }
      : undefined,
    systemPromptOverride: composeReceptionistPrompt(ctx),
    assistantName: `Maya · ${clinicName} receptionist (demo)`,
    voice: GOLDEN_DEMO_VOICE,
    backgroundSound: 'office',
    includeFounderBooking: false,
    includeScreenControl: false,
    // Demo standard (v2): pin Maya's retuned call mechanics explicitly,
    // not builder defaults. Flux takes an end-of-turn threshold, not the
    // Nova endpointing timer, and smart endpointing stays off in the start
    // plan so it cannot override Flux's own turn detection.
    temperature: GOLDEN_DEMO_TEMPERATURE,
    transcriberModel: GOLDEN_DEMO_TRANSCRIBER.model,
    transcriberEotThreshold: GOLDEN_DEMO_TRANSCRIBER.eotThreshold,
    startSpeakingPlan: GOLDEN_DEMO_START_SPEAKING_PLAN,
    stopSpeakingPlan: GOLDEN_DEMO_STOP_SPEAKING_PLAN,
    silenceTimeoutSeconds: GOLDEN_DEMO_SILENCE_TIMEOUT_SECONDS,
    // Noise cleaning on the prospect's audio, pinned explicitly: Maya
    // hears the caller through street and office noise, not raw phone audio.
    backgroundDenoisingEnabled: true,
    transcriberKeywords: receptionistKeywords(clinicName, prospectName ?? leadRow.name),
  });
  assistant.metadata = { ...assistant.metadata, demoSessionId: session.sessionId };
  assistant.firstMessage = receptionistOpener(ctx);
  // The builder's stock end-call line names the demo tenant, not the clinic.
  assistant.endCallMessage = `Thanks so much for calling ${clinicName}, take care now, bye!`;
  assistant.maxDurationSeconds = 300;
  return assistant;
}

/**
 * The shared tail of every outbound receptionist demo call: resume the
 * session, build Maya dressed in the lead's facts, and dial. The public
 * /call handler reaches it after its gates (geo, caps, caller-ID pick);
 * the owner test-call trigger (placeOwnerDemoTestCall below) reaches it
 * directly. Caller-ID selection stays with the caller — both go through
 * getDemoNumbers + pickDemoCallerId.
 */
async function placeReceptionistDemoCall(input: {
  sessionId: string;
  lead: { name: string; businessName: string | null; factsJson: unknown };
  prospectName?: string;
  confirmedFacts?: ClinicFacts;
  customerNumber: string;
  callerId: { id: string; number: string };
}): Promise<{ callId: string; fromNumber: string }> {
  const session = await resumeDemoSession(input.sessionId);
  const assistant = await buildReceptionistAssistant(
    session,
    input.lead,
    input.prospectName,
    input.confirmedFacts,
  );
  const call = await placeOutboundCall({
    phoneNumberId: input.callerId.id,
    customerNumber: input.customerNumber,
    assistant,
  });
  return { callId: call.id, fromNumber: input.callerId.number };
}

export interface OwnerDemoTestCallInput {
  websiteUrl: string;
  /** Overrides default to the owner's own identity (see DEMO_OWNER_*). */
  name?: string;
  email?: string;
  phone?: string;
  businessName?: string;
}

export interface OwnerDemoTestCallResult {
  ok: true;
  callId: string;
  fromNumber: string;
  sessionId: string;
  leadId: string;
  /** The clinic name Maya will answer with. */
  clinicName: string;
  /** The facts pulled from the clinic website and stored on the lead. */
  facts: ClinicFacts;
}

/**
 * Owner-only backend trigger behind POST /api/admin/demo/test-call: places
 * the personalized receptionist demo with ONE server-side call — no landing
 * form, no Turnstile, no geo gate, and the per-destination cap is never
 * consulted (the admin gate is the protection here, and the destination is
 * the owner's own phone). Everything else mirrors the public flow: same
 * master-toggle and personalized-demo switches, same session + lead
 * creation, same clinic-facts pull stored on the lead, and the call itself
 * goes through placeReceptionistDemoCall, the exact tail /call uses.
 */
export async function placeOwnerDemoTestCall(
  input: OwnerDemoTestCallInput,
): Promise<OwnerDemoTestCallResult> {
  if (!(await isDemoEnabled())) {
    throw new HttpError(403, 'The demo is currently turned off.', 'DEMO_DISABLED');
  }
  if (env.PERSONALIZED_DEMO_ENABLED === 'false') {
    throw new HttpError(403, 'The personalized demo is currently turned off.', 'PERSONALIZED_DEMO_DISABLED');
  }
  const name = input.name?.trim() || 'Hakim';
  const email = input.email?.trim() || DEMO_OWNER_EMAIL;
  const phone = input.phone?.trim() || DEMO_OWNER_PHONE;
  const customerNumber = toE164(phone);
  if (!customerNumber) {
    throw new HttpError(400, "That phone number doesn't look right. Double-check it and try again.", 'BAD_PHONE');
  }

  // Facts first: a site we cannot read places no call and creates no lead.
  const facts = await fetchClinicFacts(input.websiteUrl);
  if (!facts) {
    throw new HttpError(
      422,
      'Could not pull any facts from that website. Check the URL and try again.',
      'FACTS_UNAVAILABLE',
    );
  }
  const businessName = input.businessName?.trim() || facts.businessName || null;

  const session = await startDemoSession('clinic', businessName);
  const lead = await createDemoLead({
    sessionId: session.sessionId,
    name,
    email,
    phone,
    // The owner's own test identity: a Canadian number, dialled from Canada.
    ipCountry: 'CA',
    phoneCountry: 'CA',
    industry: 'clinic',
    businessName,
    websiteUrl: input.websiteUrl,
  });
  // Same store /clinic-facts performs, so the call wears exactly these facts.
  await prisma.demoLead.update({
    where: { id: lead.id },
    data: { factsJson: facts as unknown as Prisma.InputJsonValue },
  });

  const numbers = await getDemoNumbers();
  const callerId = pickDemoCallerId(numbers, 'CA');
  if (!callerId) {
    throw new HttpError(503, 'Outbound demo calling isn’t set up yet. Try the in-browser test instead.', 'NO_DEMO_NUMBER');
  }

  const { callId, fromNumber } = await placeReceptionistDemoCall({
    sessionId: session.sessionId,
    lead: { name: lead.name, businessName: lead.businessName, factsJson: facts },
    prospectName: name,
    customerNumber,
    callerId,
  });
  await setLeadMode(lead.id, 'call');

  return {
    ok: true,
    callId,
    fromNumber,
    sessionId: session.sessionId,
    leadId: lead.id,
    clinicName: sanitizeDemoText(facts.businessName, 60) || businessName || 'the clinic',
    facts,
  };
}

/* ------------------- function-gated demo holds ------------------- */
/*
 * POST /demo/hold — the endpoint behind Maya's hold_appointment tool.
 *
 * Why this exists: prompt rules alone could not stop the demo agent from
 * "booking" in prose (on a real test call she silently held TWO pretend
 * appointments side by side). So the hold is server state now: a hold
 * exists only when this endpoint creates a DemoHold row, and it enforces
 * exactly one live hold per call.
 *
 * Auth + correlation follow the platform's webhook discipline, but
 * stricter than the main /api/vapi/inbound webhook: the tool carries the
 * webhook secret in its own server config (the receptionist assistant is
 * only ever built server-side, never shipped to a browser), so a missing
 * or wrong secret is a hard 401 — no demo-sandbox bypass here. The call
 * is then correlated to a demo session by the assistant metadata Vapi
 * echoes back (demoSessionId, stamped at build time) plus the Vapi call
 * id; a session with no captured DemoLead row is refused in-band with a
 * speakable result, never a raw error the model could read aloud. No
 * public rate limiter on this route — it is a webhook, and the secret
 * plus session correlation are the gate.
 */

const HoldToolCallSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    function: z
      .object({ name: z.string().optional(), arguments: z.unknown().optional() })
      .passthrough()
      .optional(),
    arguments: z.unknown().optional(),
  })
  .passthrough();

const HoldMetadataSchema = z.object({ demoSessionId: z.string().optional() }).passthrough();

const HoldEnvelopeSchema = z
  .object({
    message: z
      .object({
        type: z.string(),
        toolCallList: z.array(HoldToolCallSchema).optional(),
        toolCalls: z.array(HoldToolCallSchema).optional(),
        assistant: z.object({ metadata: HoldMetadataSchema.optional() }).passthrough().optional(),
        call: z
          .object({
            id: z.string().optional(),
            assistant: z.object({ metadata: HoldMetadataSchema.optional() }).passthrough().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** Constant-time secret check, mirroring the inbound webhook's discipline. */
async function holdSecretMatches(req: import('express').Request): Promise<boolean> {
  const raw = req.headers['x-vapi-secret'];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (!provided) return false;
  const secret = await getSettingValue('VAPI_WEBHOOK_SECRET');
  if (!secret) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

const HOLD_UNAVAILABLE =
  "The hold didn't go through just now. Apologize briefly, take the caller's name and number as a message, and tell them the clinic will confirm the appointment.";
const HOLD_DETAILS_MISSING =
  'Some details were missing, so nothing was held. Ask the caller to confirm the service, the day, and the time, then call hold_appointment again.';

function parseHoldArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* fall through to empty */
    }
  }
  return {};
}

/** Strict YYYY-MM-DD that is also a real calendar date. */
function validHoldDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const validHoldTime = (time: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(time);

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return 'th';
  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

/**
 * The canonical one-line summary every hold confirmation uses, built only
 * from validated, stored fields: "a cleaning on Wednesday, October 14th at
 * 2 PM". The weekday and month come from the date itself (UTC math, so no
 * timezone lookup can shift the day), and the time renders like the rest
 * of the platform ("2 PM", not "2:00 PM").
 */
function holdSummary(hold: { service: string | null; date: string | null; time: string | null }): string {
  const service = hold.service?.trim() || 'appointment';
  const article = /^[aeiou]/i.test(service) ? 'an' : 'a';
  const [y, mo, d] = (hold.date ?? '').split('-').map(Number);
  const when = new Date(Date.UTC(y || 1970, (mo || 1) - 1, d || 1, 12));
  // Formatted separately: one format call with both fields orders them
  // "October Wednesday" in en-US, but the summary reads "Wednesday, October".
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(when);
  const month = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(when);
  const dayLabel = `${weekday}, ${month}`;
  const time12 = to12h(hold.time ?? '').replace(':00 ', ' ');
  return `${article} ${service} on ${dayLabel} ${d}${ordinalSuffix(d ?? 1)} at ${time12}`;
}

interface DemoHoldFields {
  service: string | null;
  date: string | null;
  time: string | null;
  patientName: string | null;
  callbackNumber: string | null;
  status: string;
}

/**
 * Applies one hold_appointment call to the call's DemoHold row and returns
 * the speakable tool result. Every refusal is a sentence the model can act
 * on; nothing here throws toward the caller.
 */
async function applyHold(
  demoSessionId: string,
  externalCallId: string,
  rawArgs: Record<string, unknown>,
): Promise<string> {
  const action = sanitizeDemoText(rawArgs.action, 10);
  const service = sanitizeDemoText(rawArgs.service, 60);
  const date = sanitizeDemoText(rawArgs.date, 10);
  const time = sanitizeDemoText(rawArgs.time, 5);
  const patientName = sanitizeDemoText(rawArgs.patientName, 60);
  const callbackNumber = sanitizeDemoText(rawArgs.callbackNumber, 32);

  const existing = (await prisma.demoHold.findUnique({
    where: { externalCallId },
  })) as (DemoHoldFields & { id: string }) | null;
  const live = existing && existing.status !== 'CANCELLED' ? existing : null;

  if (action === 'hold') {
    if (!service || !validHoldDate(date) || !validHoldTime(time)) return HOLD_DETAILS_MISSING;
    if (live) {
      return (
        `A hold already exists on this call: ${holdSummary(live)}. Nothing new was booked. ` +
        'Ask the caller one question: shall I change it to the new time, or keep the existing hold? ' +
        'Only call hold_appointment again with action "change" if they clearly say yes.'
      );
    }
    const fields = {
      service,
      date,
      time,
      patientName: patientName || null,
      callbackNumber: callbackNumber || null,
      status: 'ACTIVE',
    };
    const row = existing
      ? await prisma.demoHold.update({ where: { externalCallId }, data: fields })
      : await prisma.demoHold.create({ data: { demoSessionId, externalCallId, ...fields } });
    return `Hold created: ${holdSummary(row)}. Confirm it to the caller using exactly that summary.`;
  }

  if (action === 'change') {
    if (!live) {
      return 'There is no hold on this call to change yet. Collect the details and place the first hold with action "hold" before changing anything.';
    }
    if (!validHoldDate(date) || !validHoldTime(time)) {
      return 'The new day or time was missing or unclear, so the hold was not changed. Ask the caller to confirm the new day and time, then call hold_appointment again.';
    }
    const row = await prisma.demoHold.update({
      where: { externalCallId },
      data: {
        date,
        time,
        ...(service ? { service } : {}),
        ...(patientName ? { patientName } : {}),
        ...(callbackNumber ? { callbackNumber } : {}),
        status: 'CHANGED',
      },
    });
    return `Hold changed: ${holdSummary(row)}. Confirm it to the caller using exactly that summary.`;
  }

  if (action === 'cancel') {
    if (!live) return 'There is no hold on this call to cancel. Nothing was changed.';
    const before = holdSummary(live);
    await prisma.demoHold.update({ where: { externalCallId }, data: { status: 'CANCELLED' } });
    return `Cancelled: ${before}. Let the caller know that hold is cancelled.`;
  }

  return HOLD_DETAILS_MISSING;
}

demoRouter.post(
  '/hold',
  asyncHandler(async (req, res) => {
    if (!(await holdSecretMatches(req))) {
      res.status(401).json({ error: { message: 'Invalid webhook secret', code: 'UNAUTHENTICATED' } });
      return;
    }
    const parsed = HoldEnvelopeSchema.safeParse(req.body ?? {});
    const message = parsed.success ? parsed.data.message : undefined;
    const calls = message?.toolCallList ?? message?.toolCalls ?? [];
    const demoSessionId =
      message?.assistant?.metadata?.demoSessionId ?? message?.call?.assistant?.metadata?.demoSessionId;
    const externalCallId = message?.call?.id;
    // A tool call is honored only for a session the demo flow actually
    // created (a captured DemoLead row) — anything else is refused in-band.
    const knownSession =
      demoSessionId && externalCallId
        ? await prisma.demoLead.findFirst({ where: { demoSessionId }, select: { id: true } })
        : null;
    const results: Array<{ toolCallId: string; result: string }> = [];
    for (const call of calls) {
      const name = call.name ?? call.function?.name;
      let result: string;
      if (!knownSession || !demoSessionId || !externalCallId || name !== 'hold_appointment') {
        result = HOLD_UNAVAILABLE;
      } else {
        try {
          result = await applyHold(demoSessionId, externalCallId, parseHoldArguments(call.arguments ?? call.function?.arguments));
        } catch {
          result = HOLD_UNAVAILABLE;
        }
      }
      results.push({ toolCallId: call.id, result });
    }
    res.json({ results });
  }),
);

/** Whether the landing-page demo is currently switched on (founder toggle). */
demoRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json({ enabled: await isDemoEnabled() });
  }),
);

const LeadSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(160),
  phone: z.string().trim().min(7).max(32),
  industry: z.enum(['clinic', 'contractor', 'other']).default('other'),
  businessName: z.string().trim().max(60).optional(),
  /** The clinic's website, for the personalized receptionist demo. The
   *  server fetches it (SSRF-guarded) via /demo/clinic-facts after this
   *  lead is created; it is never fetched from an unauthenticated URL alone. */
  websiteUrl: z.string().trim().url().max(300).optional(),
  /** Cloudflare Turnstile token from the lead form; verified when configured. */
  turnstileToken: z.string().max(2048).optional(),
});

/**
 * Lead capture + geo gating: the demo's entry gate. Records the prospect,
 * spins up their isolated calendar, and returns which modes they may use —
 * "Test on web" always, "Get a call" only for US/CA visitors or +1 numbers.
 */
demoRouter.post(
  '/lead',
  leadLimiter,
  asyncHandler(async (req, res) => {
    if (!(await isDemoEnabled())) {
      throw new HttpError(403, 'The demo is currently turned off.', 'DEMO_DISABLED');
    }
    const { name, email, phone, industry, businessName, websiteUrl, turnstileToken } = LeadSchema.parse(req.body ?? {});
    if (!(await verifyTurnstile(turnstileToken, clientIp(req)))) {
      throw new HttpError(403, 'Bot check failed. Please try again.', 'BOT_CHECK_FAILED');
    }
    const gate = await evaluateGate(clientIp(req), phone);
    const session = await startDemoSession(industry, businessName ?? null);
    const lead = await createDemoLead({
      sessionId: session.sessionId,
      name,
      email,
      phone,
      ipCountry: gate.ipCountry,
      phoneCountry: gate.phone.country,
      industry,
      businessName,
      websiteUrl: websiteUrl ?? null,
    });
    res.json({
      leadId: lead.id,
      sessionId: session.sessionId,
      name,
      phone,
      industry,
      callAllowed: gate.callAllowed,
      ipCountry: gate.ipCountry,
      phoneCountry: gate.phone.country,
      day: session.day,
      appointments: session.appointments,
    });
  }),
);

const ClinicFactsSchema = z.object({
  sessionId: z.string().min(3).max(80).startsWith('demo_'),
  websiteUrl: z.string().trim().url().max(300),
});

/**
 * Pulls public facts from the lead's clinic website for the personalized
 * demo. Session-gated exactly like /call: the URL is only ever fetched for
 * a session the demo flow actually created, and the fetch itself is
 * SSRF-guarded (see clinic-facts.service). The result (or null) is stored
 * on the lead; the prospect confirms or corrects it before the call, and
 * /call re-sanitizes whatever it ends up using.
 */
demoRouter.post(
  '/clinic-facts',
  leadLimiter,
  asyncHandler(async (req, res) => {
    if (!(await isDemoEnabled())) {
      throw new HttpError(403, 'The demo is currently turned off.', 'DEMO_DISABLED');
    }
    const body = ClinicFactsSchema.parse(req.body ?? {});
    const lead = await prisma.demoLead.findFirst({
      where: { demoSessionId: body.sessionId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!lead) {
      throw new HttpError(403, 'Start the demo from the website first.', 'UNKNOWN_SESSION');
    }
    const facts = await fetchClinicFacts(body.websiteUrl);
    await prisma.demoLead.update({
      where: { id: lead.id },
      data: {
        factsJson: facts === null ? Prisma.JsonNull : (facts as unknown as Prisma.InputJsonValue),
      },
    });
    res.json({ facts });
  }),
);

const StartSchema = z.object({
  /** Reuse the session created at lead capture (preferred); else a fresh one. */
  sessionId: z.string().min(3).max(80).startsWith('demo_').optional(),
  leadId: z.string().min(1).max(40).optional(),
  name: z.string().trim().max(80).optional(),
});

/** Start a session: returns the public key, a demo assistant, and the calendar. */
demoRouter.post(
  '/session',
  asyncHandler(async (req, res) => {
    if (!(await isDemoEnabled())) {
      throw new HttpError(403, 'The demo is currently turned off.', 'DEMO_DISABLED');
    }
    const publicKey = await getSettingValue('VAPI_PUBLIC_KEY');
    if (!publicKey) {
      throw new HttpError(503, 'The live demo is not configured on this server yet.', 'VOICE_NOT_CONFIGURED');
    }

    const body = StartSchema.parse(req.body ?? {});
    const session = body.sessionId ? await resumeDemoSession(body.sessionId) : await startDemoSession();
    // Fresh call: drop any screen/recap Ava set on a prior call for this
    // session, so the panel starts on 'intro' and the poll won't restore stale
    // state.
    clearDemoScreen(session.sessionId);
    clearDemoSummary(session.sessionId);

    const { assistant, sales } = await buildSalesAssistant(session, body.name, 'web');

    // Record that this prospect went with the in-browser test.
    if (body.leadId) await setLeadMode(body.leadId, 'web');

    res.json({
      publicKey,
      assistant,
      sessionId: session.sessionId,
      day: session.day,
      appointments: session.appointments,
      showCalendar: sales.showCalendar,
    });
  }),
);

const CallSchema = z.object({
  sessionId: z.string().min(3).max(80).startsWith('demo_'),
  leadId: z.string().min(1).max(40).optional(),
  name: z.string().trim().max(80).optional(),
  phone: z.string().trim().min(7).max(32),
  /** Which demo the prospect asked for: Ava's pitch (default) or Maya
   *  answering as their own clinic's receptionist. */
  demoKind: z.enum(['sales', 'receptionist']).default('sales'),
  /** The facts the prospect confirmed on the review step. Length caps
   *  mirror the prompt sanitizer; the server re-sanitizes regardless. */
  facts: z
    .object({
      businessName: z.string().max(60).optional(),
      hours: z.array(z.string().max(120)).max(7).optional(),
      services: z.array(z.string().max(60)).max(12).optional(),
      address: z.string().max(120).optional(),
      phone: z.string().max(32).optional(),
    })
    .optional(),
});

/**
 * Outbound "Get a call": dials the prospect with Ava as the agent. Re-runs the
 * geo gate (US/CA IP or +1 number) so only eligible prospects can trigger a
 * call, picks the caller-ID by country (CA number for Canadians, US otherwise),
 * and places the call through Vapi with the same transient sales assistant.
 */
demoRouter.post(
  '/call',
  callIpLimiter,
  callSessionLimiter,
  asyncHandler(async (req, res) => {
    if (!(await isDemoEnabled())) {
      throw new HttpError(403, 'The demo is currently turned off.', 'DEMO_DISABLED');
    }
    const body = CallSchema.parse(req.body ?? {});

    // The call must belong to a session the demo flow actually created (lead
    // captured on the site). Forged session ids can't spend Vapi minutes.
    const lead = await prisma.demoLead.findFirst({
      where: { demoSessionId: body.sessionId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, email: true, businessName: true, factsJson: true },
    });
    if (!lead) {
      throw new HttpError(403, 'Start the demo from the website first.', 'UNKNOWN_SESSION');
    }
    if (body.demoKind === 'receptionist' && env.PERSONALIZED_DEMO_ENABLED === 'false') {
      throw new HttpError(403, 'The personalized demo is currently turned off.', 'PERSONALIZED_DEMO_DISABLED');
    }

    const gate = await evaluateGate(clientIp(req), body.phone);
    if (!gate.callAllowed) {
      throw new HttpError(403, 'Outbound demo calls are only available in the US and Canada right now.', 'CALL_NOT_ALLOWED');
    }
    const customerNumber = toE164(body.phone);
    if (!customerNumber) {
      throw new HttpError(400, "That phone number doesn't look right. Double-check it and try again.", 'BAD_PHONE');
    }

    // Per-destination cap: any number gets at most
    // DEMO_CALLS_PER_NUMBER_PER_DAY demo calls a day, no matter how many
    // sessions or IPs ask (see countRecentDemoCallsTo). The founder's own
    // test pair (his lead email + his phone) gets DEMO_OWNER_CALLS_PER_DAY.
    const callCap = isDemoOwnerTest(lead.email, customerNumber)
      ? DEMO_OWNER_CALLS_PER_DAY
      : DEMO_CALLS_PER_NUMBER_PER_DAY;
    if ((await countRecentDemoCallsTo(customerNumber)) >= callCap) {
      throw new HttpError(429, 'This number has already received its demo calls today.', 'NUMBER_CAP');
    }

    const numbers = await getDemoNumbers();
    const callerId = pickDemoCallerId(numbers, gate.ipCountry);
    if (!callerId) {
      throw new HttpError(503, 'Outbound demo calling isn’t set up yet. Try the in-browser test instead.', 'NO_DEMO_NUMBER');
    }

    let callId: string;
    if (body.demoKind === 'receptionist') {
      ({ callId } = await placeReceptionistDemoCall({
        sessionId: body.sessionId,
        lead,
        prospectName: body.name,
        confirmedFacts: body.facts,
        customerNumber,
        callerId,
      }));
    } else {
      const session = await resumeDemoSession(body.sessionId);
      const { assistant } = await buildSalesAssistant(session, body.name, 'phone');
      const call = await placeOutboundCall({
        phoneNumberId: callerId.id,
        customerNumber,
        assistant,
      });
      callId = call.id;
    }

    if (body.leadId) await setLeadMode(body.leadId, 'call');

    res.json({ ok: true, callId, fromNumber: callerId.number, country: gate.ipCountry });
  }),
);

/** Poll the visitor's live calendar (drives the on-screen booking updates).
 *  Also returns the screen Ava last switched to, so the panel can reconcile if
 *  the browser missed her live set_demo_screen tool-call event. */
demoRouter.get(
  '/appointments',
  asyncHandler(async (req, res) => {
    const { sessionId } = SessionSchema.parse({ sessionId: req.query.sessionId });
    res.json({
      appointments: await getDemoAppointments(sessionId),
      screen: getDemoScreen(sessionId),
      summary: getDemoSummary(sessionId),
    });
  }),
);

/** Visitor blocks a slot, then asks the agent to book it — to see the refusal. */
demoRouter.post(
  '/block',
  asyncHandler(async (req, res) => {
    const { sessionId, date, time } = BlockSchema.parse(req.body ?? {});
    res.json({ appointments: await blockDemoSlot(sessionId, date, time) });
  }),
);

/** Reset the visitor's calendar back to its seeded starting point. */
demoRouter.post(
  '/reset',
  asyncHandler(async (req, res) => {
    const { sessionId } = SessionSchema.parse(req.body ?? {});
    res.json(await resetDemoSession(sessionId));
  }),
);
