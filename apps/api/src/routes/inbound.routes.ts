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
import {
  bookAppointment,
  findFreeSlots,
  to12h,
  utcToZonedParts,
} from '../services/appointment.service';
import { getOrCreateDemoTenant, captureDemoCall } from '../services/demo.service';

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
    phoneNumber: z.object({ number: z.string().optional() }).passthrough().optional(),
    call: z.object({ id: z.string().optional() }).passthrough().optional(),
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
    analysis: z.object({ summary: z.string().optional() }).passthrough().optional(),
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
        assistant: z.object({ metadata: MetadataSchema.optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    phoneNumber: z.object({ number: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
type ToolCallsMessage = z.infer<typeof ToolCallsSchema>;

const AvailabilityArgsSchema = z.object({ date: z.string() });
const BookingArgsSchema = z.object({
  customerName: z.string(),
  customerPhone: z.string().optional(),
  reason: z.string().optional(),
  date: z.string(),
  time: z.string(),
});

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
  const settings = tenantId
    ? await prisma.agentSettings.findUnique({ where: { tenantId } })
    : null;

  const results: Array<{ toolCallId: string; result: string }> = [];
  for (const call of calls) {
    const name = call.name ?? call.function?.name ?? '';
    const args = parseToolArguments(call.arguments ?? call.function?.arguments);
    let result: string;
    try {
      if (!settings || !tenantId) {
        result = "I'm sorry, I can't reach the calendar right now. Let me take a message instead.";
      } else if (name === 'checkAvailability') {
        const { date } = AvailabilityArgsSchema.parse(args);
        const slots = await findFreeSlots({
          tenantId,
          timezone: settings.timezone,
          businessHours: settings.businessHours,
          date,
          demoSessionId,
        });
        if (!slots.open) {
          result = `The office is closed on ${slots.dayLabel}. Offer the next business day instead.`;
        } else if (slots.freeSlots.length === 0) {
          result = `${slots.dayLabel} is fully booked. Offer another day.`;
        } else {
          // Return the full list (incl. afternoons) so the agent can match a
          // caller's requested time of day instead of only seeing mornings.
          const spoken = slots.freeSlots.map(to12h).join(', ');
          result = `All open times on ${slots.dayLabel}: ${spoken}. Offer the ones closest to what the caller asked for (about three).`;
        }
      } else if (name === 'bookAppointment') {
        const booking = BookingArgsSchema.parse(args);
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
        });
        const local = utcToZonedParts(appointment.startsAt, appointment.timezone);
        const dayLabel = new Intl.DateTimeFormat('en-US', {
          timeZone: appointment.timezone,
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        }).format(appointment.startsAt);
        result = `Booked: ${appointment.customerName} on ${dayLabel} at ${to12h(local.time)}. Confirm this with the caller.`;
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
      const [publicApiUrl, webhookSecret, documents] = await Promise.all([
        getSettingValue('PUBLIC_API_URL'),
        getSettingValue('VAPI_WEBHOOK_SECRET'),
        prisma.document.findMany({
          where: { tenantId: settings.tenantId, status: { not: 'failed' } },
          select: { vapiFileId: true },
        }),
      ]);
      const assistant = buildTransientAssistant(settings.tenant, settings, 'phone', new Date(), {
        serverUrl: publicApiUrl ? `${publicApiUrl}/api/vapi/inbound` : undefined,
        serverSecret: webhookSecret ?? undefined,
        knowledgeFileIds: documents.map((d) => d.vapiFileId),
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
        await ingestEndOfCallReport({
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
        });
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
