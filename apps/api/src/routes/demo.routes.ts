import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http';
import { getSettingValue } from '../services/platform-config.service';
import { buildTransientAssistant, type CallChannel } from '../domain/assistant-builder';
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
} from '../services/demo.service';
import { placeOutboundCall } from '../services/vapi.service';
import { evaluateGate, clientIp } from '../services/geo.service';
import { composeSalesPrompt, salesOpener, SALES_PERSONA, type SalesContext } from '../domain/sales-agent';
import { utcToZonedParts } from '../services/appointment.service';

/**
 * PUBLIC (no auth) endpoints behind the interactive landing-page demo. They
 * expose only the Vapi *public* web key (safe by design) and an isolated,
 * throwaway demo calendar — never any real tenant data.
 */
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
  const salesCtx: SalesContext = {
    agentName: sales.agentName,
    founderName: sales.founderName,
    companyName: 'VoiceFront',
    prospectFirstName: firstName(name),
    timezone: tz,
    localToday,
    displayDay: { date: session.day.date, label: session.day.dayLabel },
  };

  const assistant = buildTransientAssistant(session.bundle.tenant, session.bundle.settings, channel, now, {
    serverUrl: publicApiUrl ? `${publicApiUrl}/api/vapi/inbound` : undefined,
    systemPromptOverride: composeSalesPrompt(salesCtx),
    assistantName: `${sales.agentName} · VoiceFront sales`,
    voice: { provider: SALES_PERSONA.voiceProvider, voiceId: SALES_PERSONA.voiceId },
    backgroundSound: 'office',
    includeFounderBooking: true,
  });
  assistant.metadata = { ...assistant.metadata, demoSessionId: session.sessionId };
  assistant.firstMessage = salesOpener(salesCtx);
  return { assistant, sales };
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
});

/**
 * Lead capture + geo gating: the demo's entry gate. Records the prospect,
 * spins up their isolated calendar, and returns which modes they may use —
 * "Test on web" always, "Get a call" only for US/CA visitors or +1 numbers.
 */
demoRouter.post(
  '/lead',
  asyncHandler(async (req, res) => {
    if (!(await isDemoEnabled())) {
      throw new HttpError(403, 'The demo is currently turned off.', 'DEMO_DISABLED');
    }
    const { name, email, phone } = LeadSchema.parse(req.body ?? {});
    const gate = await evaluateGate(clientIp(req), phone);
    const session = await startDemoSession();
    const lead = await createDemoLead({
      sessionId: session.sessionId,
      name,
      email,
      phone,
      ipCountry: gate.ipCountry,
      phoneCountry: gate.phone.country,
    });
    res.json({
      leadId: lead.id,
      sessionId: session.sessionId,
      name,
      phone,
      callAllowed: gate.callAllowed,
      ipCountry: gate.ipCountry,
      phoneCountry: gate.phone.country,
      day: session.day,
      appointments: session.appointments,
    });
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
});

/**
 * Outbound "Get a call": dials the prospect with Ava as the agent. Re-runs the
 * geo gate (US/CA IP or +1 number) so only eligible prospects can trigger a
 * call, picks the caller-ID by country (CA number for Canadians, US otherwise),
 * and places the call through Vapi with the same transient sales assistant.
 */
demoRouter.post(
  '/call',
  asyncHandler(async (req, res) => {
    if (!(await isDemoEnabled())) {
      throw new HttpError(403, 'The demo is currently turned off.', 'DEMO_DISABLED');
    }
    const body = CallSchema.parse(req.body ?? {});

    const gate = await evaluateGate(clientIp(req), body.phone);
    if (!gate.callAllowed) {
      throw new HttpError(403, 'Outbound demo calls are only available in the US and Canada right now.', 'CALL_NOT_ALLOWED');
    }
    const customerNumber = toE164(body.phone);
    if (!customerNumber) {
      throw new HttpError(400, "That phone number doesn't look right. Double-check it and try again.", 'BAD_PHONE');
    }

    const numbers = await getDemoNumbers();
    const callerId = pickDemoCallerId(numbers, gate.ipCountry);
    if (!callerId) {
      throw new HttpError(503, 'Outbound demo calling isn’t set up yet. Try the in-browser test instead.', 'NO_DEMO_NUMBER');
    }

    const session = await resumeDemoSession(body.sessionId);
    const { assistant } = await buildSalesAssistant(session, body.name, 'phone');

    const call = await placeOutboundCall({
      phoneNumberId: callerId.id,
      customerNumber,
      assistant,
    });

    if (body.leadId) await setLeadMode(body.leadId, 'call');

    res.json({ ok: true, callId: call.id, fromNumber: callerId.number, country: gate.ipCountry });
  }),
);

/** Poll the visitor's live calendar (drives the on-screen booking updates). */
demoRouter.get(
  '/appointments',
  asyncHandler(async (req, res) => {
    const { sessionId } = SessionSchema.parse({ sessionId: req.query.sessionId });
    res.json({ appointments: await getDemoAppointments(sessionId) });
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
