import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { getSettingValue } from '../services/platform-config.service';
import { normalizePhone } from '../lib/phone';
import { buildTransientAssistant } from '../domain/assistant-builder';
import { ingestEndOfCallReport } from '../services/calllog.service';
import { isOverMonthlyLimit } from '../services/usage.service';
import { isFeatureEnabled } from '../services/features.service';
import { parseServiceAreaZips } from '../domain/prompt-templates';
import { screenInboundCaller, recordScreenedCall } from '../services/screening.service';
import {
  bookAppointment,
  findFreeSlots,
  findUpcomingAppointments,
  to12h,
  updateAppointment,
  utcToZonedParts,
  type AppointmentMatch,
} from '../services/appointment.service';
import { getOrCreateDemoTenant, captureDemoCall, setDemoScreen, setDemoSummary } from '../services/demo.service';
import { createJobRequest } from '../services/job.service';
import { founderAvailability, bookFounderCall } from '../services/founder.service';
import { resolveBookingContext } from '../services/providers.service';
import { sendBookingConfirmation, maybeSendMissedCallTextBack } from '../services/sms.service';

/**
 * Provider webhook. Two jobs:
 *  1. `assistant-request` — a call just connected on one of our numbers.
 *     Resolve number → tenant, build a transient assistant from their live
 *     settings, return it inline. No assistants are stored provider-side.
 *  2. `end-of-call-report` — persist the finished call (idempotently) with
 *     marked-up pricing so tenants only ever see platform pricing.
 */
export const inboundRouter = Router();

async function secretsMatch(req: Request): Promise<boolean> {
  const raw = req.headers['x-vapi-secret'];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (!provided) return false;
  // Admin-panel override wins; the env var is the fallback.
  const secret = await getSettingValue('VAPI_WEBHOOK_SECRET');
  if (!secret) return false;
  // Hash both sides first: timingSafeEqual requires equal lengths, and
  // hashing avoids leaking length information through thrown errors.
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

const MetadataSchema = z
  .object({
    tenantId: z.string().optional(),
    channel: z.enum(['phone', 'web']).optional(),
    /** Set on landing-page demo assistants to isolate the visitor's calendar. */
    demoSessionId: z.string().optional(),
  })
  .passthrough();

const EnvelopeSchema = z
  .object({ message: z.object({ type: z.string() }).passthrough() })
  .passthrough();

const AssistantRequestSchema = z
  .object({
    type: z.literal('assistant-request'),
    // The VoiceFront number that was dialed — resolves to the tenant.
    phoneNumber: z.object({ number: z.string().optional() }).passthrough().optional(),
    // The caller's own number (when not withheld) — used for spam screening.
    customer: z.object({ number: z.string().optional() }).passthrough().optional(),
    call: z
      .object({
        id: z.string().optional(),
        customer: z.object({ number: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const EndOfCallSchema = z
  .object({
    type: z.literal('end-of-call-report'),
    call: z
      .object({
        id: z.string().optional(),
        customer: z.object({ number: z.string().optional() }).passthrough().optional(),
        assistant: z.object({ metadata: MetadataSchema.optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    assistant: z.object({ metadata: MetadataSchema.optional() }).passthrough().optional(),
    phoneNumber: z.object({ number: z.string().optional() }).passthrough().optional(),
    customer: z.object({ number: z.string().optional() }).passthrough().optional(),
    cost: z.number().optional(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    endedReason: z.string().optional(),
    summary: z.string().optional(),
    analysis: z
      .object({
        summary: z.string().optional(),
        structuredData: z.record(z.unknown()).optional(),
        successEvaluation: z.union([z.string(), z.number()]).optional(),
      })
      .passthrough()
      .optional(),
    artifact: z
      .object({ recordingUrl: z.string().optional(), transcript: z.string().optional() })
      .passthrough()
      .optional(),
    recordingUrl: z.string().optional(),
    transcript: z.string().optional(),
  })
  .passthrough();

/**
 * Tool-call invocations from live calls. The provider has shipped both the
 * flat shape ({id, name, arguments}) and the OpenAI-style nested shape
 * ({id, function: {name, arguments}}); accept either, with arguments as an
 * object or a JSON string.
 */
const ToolCallItemSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    arguments: z.unknown().optional(),
    function: z
      .object({ name: z.string().optional(), arguments: z.unknown().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ToolCallsSchema = z
  .object({
    type: z.literal('tool-calls'),
    toolCallList: z.array(ToolCallItemSchema).optional(),
    toolCalls: z.array(ToolCallItemSchema).optional(),
    assistant: z.object({ metadata: MetadataSchema.optional() }).passthrough().optional(),
    call: z
      .object({
        id: z.string().optional(),
        // The caller's own number — used to find their existing appointment.
        customer: z.object({ number: z.string().optional() }).passthrough().optional(),
        assistant: z.object({ metadata: MetadataSchema.optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    phoneNumber: z.object({ number: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
type ToolCallsMessage = z.infer<typeof ToolCallsSchema>;

const AvailabilityArgsSchema = z.object({
  date: z.string(),
  providerName: z.string().optional(),
  serviceName: z.string().optional(),
});
const BookingArgsSchema = z.object({
  customerName: z.string(),
  customerPhone: z.string().optional(),
  reason: z.string().optional(),
  date: z.string(),
  time: z.string(),
  providerName: z.string().optional(),
  serviceName: z.string().optional(),
});
const FindAppointmentArgsSchema = z.object({
  customerPhone: z.string().optional(),
  customerName: z.string().optional(),
  date: z.string().optional(),
});
const RescheduleArgsSchema = z.object({
  customerPhone: z.string().optional(),
  customerName: z.string().optional(),
  currentDate: z.string().optional(),
  date: z.string(),
  time: z.string(),
});
const CancelArgsSchema = z.object({
  customerPhone: z.string().optional(),
  customerName: z.string().optional(),
  date: z.string().optional(),
});
const JobCaptureArgsSchema = z.object({
  customerName: z.string(),
  customerPhone: z.string().optional(),
  jobType: z.string().optional(),
  // The model is told urgency is required, but default to ROUTINE if it omits it
  // so a missing value never throws and loses the captured job.
  urgency: z.enum(['EMERGENCY', 'URGENT', 'ROUTINE']).optional(),
  description: z.string().optional(),
  serviceAddress: z.string().optional(),
  preferredCallback: z.string().optional(),
});

/** Long-form weekday + date label, spoken back to the caller. */
function formatDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

/** A short, speakable list of candidate appointments for disambiguation. */
function describeMatches(matches: AppointmentMatch[], max = 3): string {
  return matches
    .slice(0, max)
    .map((m) => `${formatDay(m.startsAt, m.timezone)} at ${to12h(m.local.time)}`)
    .join('; ');
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Executes booking tools and returns speakable results — whatever string we
 * return here is what the receptionist says next, so every branch (including
 * failures) must read naturally aloud.
 */
async function handleToolCalls(message: ToolCallsMessage): Promise<Array<{ toolCallId: string; result: string }>> {
  const metadata = message.assistant?.metadata ?? message.call?.assistant?.metadata;
  const demoSessionId = metadata?.demoSessionId ?? null;
  let tenantId = metadata?.tenantId ?? null;
  // Demo calls are clamped to the demo tenant regardless of any tenantId in the
  // (unauthenticated) payload, so a forged demo call can only touch the
  // isolated, auto-expiring demo calendar — never a real customer's.
  if (demoSessionId) {
    tenantId = (await getOrCreateDemoTenant()).tenant.id;
  } else if (!tenantId) {
    const settings = await findTenantByNumber(message.phoneNumber?.number);
    tenantId = settings?.tenantId ?? null;
  }
  const calls = message.toolCallList ?? message.toolCalls ?? [];
  // The caller's own number, used to find the appointment they want to change.
  const callerNumber = message.call?.customer?.number ?? null;
  const settings = tenantId
    ? await prisma.agentSettings.findUnique({
        where: { tenantId },
        include: { tenant: { select: { multiProviderEnabled: true } } },
      })
    : null;
  // Multi-provider routing only engages when the operator enabled it for this
  // tenant; otherwise the calendar is a single shared resource (the simple case).
  const multiProvider = settings?.tenant?.multiProviderEnabled ?? false;

  const results: Array<{ toolCallId: string; result: string }> = [];
  for (const call of calls) {
    const name = call.name ?? call.function?.name ?? '';
    const args = parseToolArguments(call.arguments ?? call.function?.arguments);
    let result: string;
    try {
      // Screen control (web sales demo): Ava drives the prospect's on-screen
      // panel. The browser reacts to the live tool-call event; we also record it
      // here so the calendar poll can reconcile. Independent of tenant settings.
      if (name === 'set_demo_screen') {
        const rawScreen = (args as { screen?: unknown }).screen;
        const screen = typeof rawScreen === 'string' ? rawScreen : '';
        if (demoSessionId && setDemoScreen(demoSessionId, screen)) {
          result = `Showing the ${screen} screen now.`;
        } else {
          result = 'Screen unchanged.';
        }
      } else if (name === 'show_call_summary') {
        // Push Ava's real recap to the on-screen summary panel + show it.
        const a = args as { headline?: unknown; recap?: unknown };
        const headline = typeof a.headline === 'string' ? a.headline : '';
        const recap = typeof a.recap === 'string' ? a.recap : '';
        if (demoSessionId && setDemoSummary(demoSessionId, headline, recap)) {
          setDemoScreen(demoSessionId, 'summary');
          result = 'The summary is on their screen now.';
        } else {
          result = 'Summary unchanged.';
        }
      } else if (name === 'checkFounderAvailability') {
        // Founder planning-call tools target the FOUNDER's own calendar (sales
        // demo close), not the demo clinic — handled independently of settings.
        const { date } = AvailabilityArgsSchema.parse(args);
        const slots = await founderAvailability(date);
        if (!slots.open) {
          result = `The founder isn't available on ${slots.dayLabel}. Offer the next business day instead.`;
        } else if (slots.freeSlots.length === 0) {
          result = `The founder is fully booked on ${slots.dayLabel}. Offer another day.`;
        } else {
          const spoken = slots.freeSlots.map(to12h).join(', ');
          result = `The founder's open times on ${slots.dayLabel}: ${spoken}. Offer two or three closest to what the prospect wants.`;
        }
      } else if (name === 'bookPlanningCall') {
        const booking = BookingArgsSchema.parse(args);
        const entry = await bookFounderCall({
          customerName: booking.customerName,
          customerPhone: booking.customerPhone ?? null,
          reason: booking.reason ?? 'Planning call',
          date: booking.date,
          time: booking.time,
          externalCallId: message.call?.id ?? null,
        });
        const dayLabel = new Intl.DateTimeFormat('en-US', {
          timeZone: entry.timezone,
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        }).format(new Date(entry.startsAt));
        result = `Booked a planning call with the founder for ${entry.label} on ${dayLabel} at ${to12h(entry.local.time)}. Confirm this with the prospect.`;
      } else if (!settings || !tenantId) {
        result = "I'm sorry, I can't reach the calendar right now. Let me take a message instead.";
      } else if (name === 'checkAvailability') {
        const a = AvailabilityArgsSchema.parse(args);
        const ctx = multiProvider
          ? await resolveBookingContext(tenantId, { providerName: a.providerName, serviceName: a.serviceName })
          : null;
        const slots = await findFreeSlots({
          tenantId,
          timezone: settings.timezone,
          businessHours: settings.businessHours,
          date: a.date,
          demoSessionId,
          providerId: ctx?.providerId ?? null,
          providerIds: ctx?.candidateProviderIds,
          slotMinutes: ctx?.durationMinutes ?? undefined,
        });
        const aside = ctx?.note ? `${ctx.note} ` : '';
        if (!slots.open) {
          result = `${aside}The office is closed on ${slots.dayLabel}. Offer the next business day instead.`;
        } else if (slots.freeSlots.length === 0) {
          result = `${aside}${slots.dayLabel} is fully booked. Offer another day.`;
        } else {
          // Return the full list (incl. afternoons) so the agent can match a
          // caller's requested time of day instead of only seeing mornings.
          const spoken = slots.freeSlots.map(to12h).join(', ');
          result = `${aside}All open times on ${slots.dayLabel}: ${spoken}. Offer the ones closest to what the caller asked for (about three).`;
        }
      } else if (name === 'bookAppointment') {
        const booking = BookingArgsSchema.parse(args);
        const ctx = multiProvider
          ? await resolveBookingContext(tenantId, { providerName: booking.providerName, serviceName: booking.serviceName })
          : null;
        const appointment = await bookAppointment({
          tenantId,
          timezone: settings.timezone,
          businessHours: settings.businessHours,
          customerName: booking.customerName,
          customerPhone: booking.customerPhone ?? null,
          reason: booking.reason ?? null,
          date: booking.date,
          time: booking.time,
          source: 'VOICE_AGENT',
          externalCallId: message.call?.id ?? null,
          demoSessionId,
          providerId: ctx?.providerId ?? null,
          candidateProviderIds: ctx?.candidateProviderIds,
          serviceId: ctx?.serviceId ?? null,
          durationMinutes: ctx?.durationMinutes ?? undefined,
        });
        void sendBookingConfirmation(appointment.id).catch(() => {});
        const local = utcToZonedParts(appointment.startsAt, appointment.timezone);
        const dayLabel = new Intl.DateTimeFormat('en-US', {
          timeZone: appointment.timezone,
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        }).format(appointment.startsAt);
        const aside = ctx?.note ? `${ctx.note} ` : '';
        result = `${aside}Booked: ${appointment.customerName} on ${dayLabel} at ${to12h(local.time)}. Confirm this with the caller.`;
      } else if (name === 'findAppointment') {
        const a = FindAppointmentArgsSchema.parse(args);
        const matches = await findUpcomingAppointments({
          tenantId,
          timezone: settings.timezone,
          phone: a.customerPhone ?? callerNumber,
          name: a.customerName ?? null,
          date: a.date ?? null,
          demoSessionId,
        });
        if (matches.length === 0) {
          result =
            "I'm not finding an upcoming appointment under that name or number. Could you double-check the name or phone number it's booked under?";
        } else if (matches.length === 1) {
          const m = matches[0];
          result = `I found it — ${m.customerName} on ${formatDay(m.startsAt, m.timezone)} at ${to12h(m.local.time)}${m.reason ? ` for ${m.reason}` : ''}. Would you like to reschedule or cancel it?`;
        } else {
          result = `I see a few upcoming appointments: ${describeMatches(matches)}. Which one did you mean?`;
        }
      } else if (name === 'rescheduleAppointment') {
        const a = RescheduleArgsSchema.parse(args);
        const matches = await findUpcomingAppointments({
          tenantId,
          timezone: settings.timezone,
          phone: a.customerPhone ?? callerNumber,
          name: a.customerName ?? null,
          date: a.currentDate ?? null,
          demoSessionId,
        });
        if (matches.length === 0) {
          result =
            "I couldn't find that appointment to move. Could you confirm the name or phone number it's booked under?";
        } else if (matches.length > 1) {
          result = `There's more than one upcoming appointment (${describeMatches(matches)}). Which one should I move?`;
        } else {
          const updated = await updateAppointment(
            tenantId,
            matches[0].id,
            { date: a.date, time: a.time },
            settings.businessHours,
          );
          const moved = utcToZonedParts(updated.startsAt, updated.timezone);
          result = `All set — I moved it to ${formatDay(updated.startsAt, updated.timezone)} at ${to12h(moved.time)}. Confirm that back to the caller.`;
        }
      } else if (name === 'cancelAppointment') {
        const a = CancelArgsSchema.parse(args);
        const matches = await findUpcomingAppointments({
          tenantId,
          timezone: settings.timezone,
          phone: a.customerPhone ?? callerNumber,
          name: a.customerName ?? null,
          date: a.date ?? null,
          demoSessionId,
        });
        if (matches.length === 0) {
          result =
            "I'm not finding an upcoming appointment to cancel under that name or number. Could you confirm the details?";
        } else if (matches.length > 1) {
          result = `There's more than one upcoming appointment (${describeMatches(matches)}). Which one should I cancel?`;
        } else {
          const m = matches[0];
          // Status-only cancel; no time validation, so business hours are unused.
          await updateAppointment(tenantId, m.id, { status: 'CANCELLED' }, null);
          result = `Done — I've cancelled the appointment on ${formatDay(m.startsAt, m.timezone)} at ${to12h(m.local.time)}. Is there anything else I can help with?`;
        }
      } else if (name === 'captureJobRequest') {
        const a = JobCaptureArgsSchema.parse(args);
        const job = await createJobRequest({
          tenantId,
          customerName: a.customerName,
          // Fall back to the caller's own number when they don't give one.
          customerPhone: a.customerPhone ?? callerNumber,
          serviceAddress: a.serviceAddress ?? null,
          jobType: a.jobType ?? null,
          urgency: a.urgency ?? 'ROUTINE',
          description: a.description ?? null,
          preferredCallback: a.preferredCallback ?? null,
          source: 'VOICE_AGENT',
          externalCallId: message.call?.id ?? null,
          demoSessionId,
        });
        result =
          job.urgency === 'EMERGENCY'
            ? `Logged as an EMERGENCY — the on-call team is being alerted right now. Reassure ${job.customerName} warmly that someone will reach out right away, then let them get to safety if there's any danger.`
            : `Got it — the job's logged for ${job.customerName}. Let them know someone will follow up${a.preferredCallback ? ` ${a.preferredCallback}` : ' shortly'}, confirm the key details back briefly, and ask if there's anything else.`;
      } else {
        result = `Unknown tool ${name || '(unnamed)'}.`;
      }
    } catch (err) {
      if (err instanceof HttpError) {
        // Service errors are written to be speakable (e.g. "That time was just taken.")
        result = `${err.message} Offer the caller an alternative.`;
      } else if (err instanceof z.ZodError) {
        result = 'Some booking details were missing or malformed. Re-collect the name, date, and time, then try again.';
      } else {
        console.error('[webhook] tool call failed:', err);
        result = "Something went wrong with the calendar. Apologize and take the caller's details as a message.";
      }
    }
    results.push({ toolCallId: call.id, result });
  }
  return results;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function findTenantByNumber(rawNumber: string | undefined) {
  if (!rawNumber) return null;
  const settings = await prisma.agentSettings.findUnique({
    where: { inboundPhoneNumber: normalizePhone(rawNumber) },
    include: { tenant: { include: { onboarding: true } } },
  });
  return settings;
}

/** Pull a demo session id out of the raw webhook body, if present. Public
 * landing-page demo calls carry one and have no webhook secret (we never ship
 * the secret to a browser); they're allowed through but sandboxed to the demo
 * tenant in the handlers below, so a forged demo call can't touch real data. */
function peekDemoSessionId(body: unknown): string | null {
  const msg = (body as { message?: Record<string, unknown> })?.message;
  if (!msg) return null;
  const fromAssistant = (msg.assistant as { metadata?: { demoSessionId?: unknown } })?.metadata?.demoSessionId;
  const fromCall = (msg.call as { assistant?: { metadata?: { demoSessionId?: unknown } } })?.assistant?.metadata
    ?.demoSessionId;
  const id = fromAssistant ?? fromCall;
  return typeof id === 'string' && id.startsWith('demo_') ? id : null;
}

inboundRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const isDemo = peekDemoSessionId(req.body) !== null;
    // Real calls must carry the shared secret; demo calls are sandboxed instead.
    if (!isDemo && !(await secretsMatch(req))) {
      res.status(401).json({ error: { message: 'Invalid webhook secret', code: 'UNAUTHENTICATED' } });
      return;
    }

    const envelope = EnvelopeSchema.safeParse(req.body);
    if (!envelope.success) {
      // Malformed payloads get a 200 so the provider does not retry forever.
      console.warn('[webhook] Unparseable payload received');
      res.status(200).json({});
      return;
    }
    const message = envelope.data.message;

    if (message.type === 'assistant-request') {
      const parsed = AssistantRequestSchema.safeParse(message);
      const number = parsed.success ? parsed.data.phoneNumber?.number : undefined;
      const settings = await findTenantByNumber(number);

      if (!settings) {
        console.warn(`[webhook] assistant-request for unmapped number: ${number ?? 'unknown'}`);
        res.status(200).json({ error: 'This number is not configured with a receptionist yet.' });
        return;
      }
      if (settings.tenant.isBlocked || settings.tenant.subscriptionStatus === 'CANCELED') {
        res.status(200).json({ error: 'This service is currently unavailable.' });
        return;
      }
      if (!settings.tenant.onboarding?.isActive) {
        res.status(200).json({
          error: 'This receptionist has not been activated yet. Please finish setup in your dashboard.',
        });
        return;
      }
      // Protect the shared provider account: once a tenant uses up its monthly
      // minute allowance, stop answering until the cap resets or is raised. We
      // check before handing back an assistant so the call never connects.
      if (await isOverMonthlyLimit(settings.tenantId, settings.tenant.monthlyMinuteLimit)) {
        console.warn(`[webhook] assistant-request refused — tenant ${settings.tenantId} over monthly minute limit`);
        res.status(200).json({
          error: 'This receptionist has reached its monthly call limit. Please try again later.',
        });
        return;
      }

      // Spam screening. Conservative by design: we only refuse on an explicit
      // tenant signal — the caller is on this tenant's own block list, or (when
      // the tenant opted in) the call has no caller ID. Refusing here means the
      // call never connects and burns zero minutes. The bias is always toward
      // connecting: a missed spam call is cheap, a refused real customer isn't.
      const callerNumber =
        parsed.success
          ? parsed.data.call?.customer?.number ?? parsed.data.customer?.number ?? null
          : null;
      const screen = await screenInboundCaller({
        tenantId: settings.tenantId,
        callerNumber,
        rejectAnonymous: settings.rejectAnonymousCallers,
      });
      if (screen.blocked && screen.reason) {
        console.warn(
          `[webhook] assistant-request refused — ${screen.reason} caller for tenant ${settings.tenantId}`,
        );
        // Best-effort log so the tenant can see what was screened; never block
        // the response on it.
        void recordScreenedCall({ tenantId: settings.tenantId, callerNumber, reason: screen.reason });
        res.status(200).json({ error: 'This number is unable to be connected.' });
        return;
      }

      // Prefer the tenant's dedicated persistent assistant when one is
      // provisioned: Vapi loads a warm, pre-built agent (snappier first
      // response, kept in sync on every settings save) instead of one rebuilt
      // from scratch on every call. The quota/block/active gates above still
      // run because the call still routes through this webhook first.
      if (settings.assistantId) {
        res.status(200).json({ assistantId: settings.assistantId });
        return;
      }

      // Fallback: no dedicated assistant yet — build a transient one inline so
      // the receptionist still answers (e.g. before provisioning completes).
      const multiProviderTenant = settings.tenant.multiProviderEnabled;
      const [publicApiUrl, webhookSecret, documents, providers, services] = await Promise.all([
        getSettingValue('PUBLIC_API_URL'),
        getSettingValue('VAPI_WEBHOOK_SECRET'),
        prisma.document.findMany({
          where: { tenantId: settings.tenantId, status: { not: 'failed' } },
          select: { vapiFileId: true },
        }),
        multiProviderTenant
          ? prisma.provider.findMany({
              where: { tenantId: settings.tenantId, active: true },
              orderBy: { name: 'asc' },
              select: { name: true, title: true },
            })
          : Promise.resolve([] as Array<{ name: string; title: string | null }>),
        multiProviderTenant
          ? prisma.service.findMany({
              where: { tenantId: settings.tenantId, active: true },
              orderBy: { name: 'asc' },
              select: { name: true, durationMinutes: true },
            })
          : Promise.resolve([] as Array<{ name: string; durationMinutes: number }>),
      ]);
      // SERVICE_AREA feature: pass the serviced area into the prompt when it's on.
      const serviceAreaOn = await isFeatureEnabled(settings.tenantId, 'SERVICE_AREA');
      const areaZips = serviceAreaOn ? parseServiceAreaZips(settings.serviceAreaZips) : [];
      const assistant = buildTransientAssistant(settings.tenant, settings, 'phone', new Date(), {
        serverUrl: publicApiUrl ? `${publicApiUrl}/api/vapi/inbound` : undefined,
        serverSecret: webhookSecret ?? undefined,
        knowledgeFileIds: documents.map((d) => d.vapiFileId),
        ...(multiProviderTenant && providers.length > 1
          ? { providers, services, offerProviderChoice: settings.offerProviderChoice }
          : {}),
        ...(areaZips.length > 0 ? { serviceArea: { zips: areaZips, note: settings.serviceAreaNote } } : {}),
      });
      res.status(200).json({ assistant });
      return;
    }

    if (message.type === 'tool-calls') {
      const parsed = ToolCallsSchema.safeParse(message);
      if (!parsed.success) {
        console.warn('[webhook] Unparseable tool-calls payload');
        res.status(200).json({ results: [] });
        return;
      }
      const results = await handleToolCalls(parsed.data);
      res.status(200).json({ results });
      return;
    }

    if (message.type === 'end-of-call-report') {
      const parsed = EndOfCallSchema.safeParse(message);
      if (!parsed.success) {
        console.warn('[webhook] Unparseable end-of-call-report');
        res.status(200).json({});
        return;
      }
      const report = parsed.data;

      // Demo calls are never billed as real CallLogs, but we DO capture the
      // transcript/recording so the founder can review how the sales agent did.
      const demoSessionId =
        report.assistant?.metadata?.demoSessionId ?? report.call?.assistant?.metadata?.demoSessionId;
      if (demoSessionId) {
        try {
          await captureDemoCall({
            demoSessionId,
            externalCallId: report.call?.id ?? null,
            startedAt: parseDate(report.startedAt),
            endedAt: parseDate(report.endedAt),
            endedReason: report.endedReason ?? null,
            summary: report.analysis?.summary ?? report.summary ?? null,
            transcript: report.artifact?.transcript ?? report.transcript ?? null,
            recordingUrl: report.artifact?.recordingUrl ?? report.recordingUrl ?? null,
          });
        } catch (err) {
          console.error('[webhook] Failed to capture demo call:', err);
        }
        res.status(200).json({});
        return;
      }

      // Attribution order: assistant metadata (set by us at call start, works
      // for browser tests too) → call.assistant metadata → inbound number.
      const metadata = report.assistant?.metadata ?? report.call?.assistant?.metadata;
      let tenantId = metadata?.tenantId ?? null;
      if (!tenantId) {
        const settings = await findTenantByNumber(report.phoneNumber?.number);
        tenantId = settings?.tenantId ?? null;
      }
      const externalCallId = report.call?.id;

      if (!tenantId || !externalCallId) {
        console.warn(
          `[webhook] Dropping unattributable end-of-call-report (tenant=${tenantId ?? 'none'}, call=${externalCallId ?? 'none'})`,
        );
        res.status(200).json({});
        return;
      }

      const startedAt = parseDate(report.startedAt) ?? new Date();
      const endedAt = parseDate(report.endedAt);
      try {
        const log = await ingestEndOfCallReport({
          tenantId,
          externalCallId,
          channel: metadata?.channel === 'web' ? 'web' : 'phone',
          callerNumber: report.call?.customer?.number ?? report.customer?.number ?? null,
          startedAt,
          endedAt,
          providerCostDollars: report.cost ?? 0,
          endedReason: report.endedReason ?? null,
          summary: report.analysis?.summary ?? report.summary ?? null,
          transcript: report.artifact?.transcript ?? report.transcript ?? null,
          recordingUrl: report.artifact?.recordingUrl ?? report.recordingUrl ?? null,
          structuredData: report.analysis?.structuredData ?? null,
          successEvaluation: report.analysis?.successEvaluation ?? null,
        });
        // Phone calls only: if they hung up without a booking or captured job,
        // text them back so the lead isn't lost (gated by the feature).
        if (metadata?.channel !== 'web') {
          void maybeSendMissedCallTextBack(log.id).catch(() => {});
        }
      } catch (err) {
        // Log but still 200: a poisoned report must not trigger infinite retries.
        console.error('[webhook] Failed to ingest end-of-call-report:', err);
      }
      res.status(200).json({});
      return;
    }

    // status-update and anything else: acknowledge.
    res.status(200).json({});
  }),
);
