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
  type ReceptionistContext,
} from '../domain/receptionist-demo';
import { fetchClinicFacts, type ClinicFacts } from '../services/clinic-facts.service';
import { utcToZonedParts } from '../services/appointment.service';

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

/**
 * Per-destination daily cap on demo calls (anti-robocall discipline): at
 * most 2 completed demo calls to any one number in 24 hours, across all
 * sessions and both demo kinds.
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

/** Facts stored on a lead come back as untyped JSON — narrow to a plain object. */
function factsFromJson(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Builds Maya — the prospect's OWN receptionist — for the personalized demo.
 * Same session bundle and booking tools as the sales path, but the golden
 * receptionist prompt and voice, no founder/screen tooling, and a hard
 * three-minute cap (this is a taste of the product, not the product).
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
  const publicApiUrl = await getSettingValue('PUBLIC_API_URL');
  const assistant = buildTransientAssistant(session.bundle.tenant, session.bundle.settings, 'phone', now, {
    serverUrl: publicApiUrl ? `${publicApiUrl}/api/vapi/inbound` : undefined,
    systemPromptOverride: composeReceptionistPrompt(ctx),
    assistantName: `Maya · ${clinicName} receptionist (demo)`,
    voice: GOLDEN_DEMO_VOICE,
    backgroundSound: 'office',
    includeFounderBooking: false,
    includeScreenControl: false,
    transcriberKeywords: nameKeywords(prospectName ?? leadRow.name),
  });
  assistant.metadata = { ...assistant.metadata, demoSessionId: session.sessionId };
  assistant.firstMessage = receptionistOpener(ctx);
  // The builder's stock end-call line names the demo tenant, not the clinic.
  assistant.endCallMessage = `Thanks so much for calling ${clinicName}, take care now, bye!`;
  assistant.maxDurationSeconds = 180;
  return assistant;
}

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
      select: { id: true, name: true, businessName: true, factsJson: true },
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

    // Per-destination cap: any number gets at most 2 demo calls a day, no
    // matter how many sessions or IPs ask (see countRecentDemoCallsTo).
    if ((await countRecentDemoCallsTo(customerNumber)) >= 2) {
      throw new HttpError(429, 'This number has already received its demo calls today.', 'NUMBER_CAP');
    }

    const numbers = await getDemoNumbers();
    const callerId = pickDemoCallerId(numbers, gate.ipCountry);
    if (!callerId) {
      throw new HttpError(503, 'Outbound demo calling isn’t set up yet. Try the in-browser test instead.', 'NO_DEMO_NUMBER');
    }

    const session = await resumeDemoSession(body.sessionId);
    let assistant: TransientAssistant;
    if (body.demoKind === 'receptionist') {
      assistant = await buildReceptionistAssistant(session, lead, body.name, body.facts);
    } else {
      ({ assistant } = await buildSalesAssistant(session, body.name, 'phone'));
    }

    const call = await placeOutboundCall({
      phoneNumberId: callerId.id,
      customerNumber,
      assistant,
    });

    if (body.leadId) await setLeadMode(body.leadId, 'call');

    res.json({ ok: true, callId: call.id, fromNumber: callerId.number, country: gate.ipCountry });
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
