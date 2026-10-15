import { randomUUID } from 'node:crypto';
import { Prisma, type AgentSettings } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { HttpError } from '../lib/http';
import {
  DAY_KEYS,
  hoursToHumanText,
  parseBusinessHours,
  type BusinessHours,
  type DayKey,
} from '../domain/agent-config';
import { getMonthlyUsage } from './usage.service';
import { syncAssistantForTenant } from './vapi.service';
import { recordAdminAction } from './platform-config.service';

/**
 * In-app support agent ("Adam"): a named support specialist who lives in the
 * signed-in app, answers product questions from a truthful knowledge block,
 * and performs ONE class of real task in v1 — changing the clinic's booking
 * window. The booking window is not a new setting: it is the tenant's
 * existing `AgentSettings.businessHours`, the same server-owned column the
 * receptionist's slot grid (`findFreeSlots`) and booking validator
 * (`resolveBookingWindow`) read on every call, and the same column the
 * dashboard's BusinessHoursEditor writes. A change here is a change Maya
 * genuinely honors.
 *
 * Change safety model: the model can only PROPOSE. A proposal is expanded
 * and validated server-side and held in a server-side pending slot keyed by
 * (tenant, user). APPLY only ever applies a held proposal by id — there is
 * no path for the model or the client to apply an arbitrary payload.
 *
 * The model call follows the platform's existing LLM pattern (Gemini via
 * fetch, key from env.GEMINI_API_KEY, hard timeout, [support-agent] logs),
 * the same shape clinic-facts.service.ts uses for its AI reading layer.
 * Gemini's native function calling carries the tools.
 */

/* ------------------------------- persona -------------------------------- */

/** The support persona. ONE place: rename the agent by editing this name. */
export const SUPPORT_AGENT = {
  name: 'Adam',
} as const;

/* ----------------------------- knowledge -------------------------------- */

/**
 * What the product actually does today, read from the app (dashboard pages,
 * settings cards, feature registry). Nothing planned or aspirational belongs
 * here: if it is not in the product, it is not in this block, and the agent
 * is instructed to say so rather than invent it.
 */
const KNOWLEDGE_BLOCK = [
  'WHAT VOICEFRONT DOES TODAY:',
  '- An AI receptionist answers the business phone line around the clock, books appointments into the VoiceFront calendar, takes messages, and can transfer urgent calls to the forwarding numbers the business configures.',
  '- Booking window: the receptionist only offers and books appointment times inside the business hours (Settings > Business hours). It is one open-to-close window per day; days can be on or off. Every booking path, including manual bookings in the app, is validated against these hours server-side.',
  '- Calls page: every call with its recording, transcript and summary, including live in-progress calls on the dashboard.',
  '- Calendar page: the appointment book. Staff can book, reschedule and cancel manually; manual bookings respect the same business hours.',
  '- Providers page: the bookable people (dentists, stylists, crews). With multiple providers, availability and double-booking are tracked per provider.',
  '- Waitlist page: patients waiting for a slot; when a cancellation opens a time, the next person can be texted if SMS is on.',
  '- Analytics page: call volume and estimated revenue captured, based on the average appointment value set in Settings.',
  '- Settings page cards: Persona (receptionist name and first message), Voice & sound, Call handling instructions, Knowledge documents (files the receptionist can look up on calls), Voicemail greeting, Business hours, Average appointment value, SMS notifications (booking confirmations and reminders, when SMS is enabled for the account), Calendar connections (Google and Microsoft calendars sync two ways), Call screening (a block list, plus an opt-in switch to refuse calls with no caller ID), Appearance (theme and calm mode), and account preferences.',
  '- Usage: the account has a monthly cap on answered call minutes; the agent can report minutes used versus the cap for the current month.',
  '- Optional features exist for some accounts (for example on-call dispatch and service-area checks for trades businesses, missed-call text-back). They are enabled per account; if a feature is not on the account, the agent must not promise it.',
].join('\n');

const AGENT_RULES = [
  'RULES:',
  '- You are a support specialist for THIS workspace only. Never mention, compare, or reveal anything about any other business or account.',
  '- Answer product questions from the knowledge block and the workspace context. If something is not in the knowledge block, say plainly that the product does not do that today; never invent features, prices, or policies.',
  '- The only setting you can change is the booking window (business hours), and only through the propose then apply flow. For any other change, tell the user exactly which Settings card handles it and stop there.',
  '- Booking window flow: when the user asks for a change, call propose_booking_window first. Then show the user the returned summary and ask them to confirm (they can tap Confirm or say yes). NEVER say a change is in effect until apply_booking_window has returned status "applied".',
  '- If the user confirms a pending change in words, call apply_booking_window with the proposalId from the propose result.',
  '- If a tool returns an error, relay the problem in plain words and, where it helps, offer a corrected alternative. Do not retry the same failing call unchanged.',
  '- Keep replies short, warm, and plain. No corporate filler. Use the business timezone for all times you mention.',
].join('\n');

/* ------------------------------ chat types ------------------------------ */

export interface SupportChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface PendingProposalView {
  proposalId: string;
  summary: string;
}

export interface SupportChatResult {
  reply: string;
  /** Set when this turn created a proposal the UI should offer to confirm. */
  pendingProposal: PendingProposalView | null;
}

/** Tool-level failure the model should hear about and relay, not an HTTP error. */
class ToolError extends Error {}

interface ToolResult {
  [key: string]: unknown;
}

/* ------------------------- pending proposals ---------------------------- */

interface PendingProposal {
  proposalId: string;
  hours: BusinessHours;
  summary: string;
  createdAt: number;
}

const PENDING_TTL_MS = 15 * 60_000;
/** One pending proposal per (tenant, user): a new propose replaces the old. */
const pendingProposals = new Map<string, PendingProposal>();

function pendingKey(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

function readPending(tenantId: string, userId: string): PendingProposal | null {
  const key = pendingKey(tenantId, userId);
  const pending = pendingProposals.get(key);
  if (!pending) return null;
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    pendingProposals.delete(key);
    return null;
  }
  return pending;
}

/* --------------------------- window proposal ---------------------------- */

export interface ProposeWindowInput {
  windows?: Array<{ days?: string[]; open?: string; close?: string }>;
  closedDays?: string[];
  allowLockout?: boolean;
}

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function isDayKey(value: string): value is DayKey {
  return (DAY_KEYS as readonly string[]).includes(value);
}

/**
 * Expands a model's window request onto the tenant's current hours and
 * validates it. Pure (no DB) so the rules are unit-testable: days the
 * request does not mention keep their current setting; closedDays are
 * switched off; every named day gets exactly one window. Nonsense is
 * rejected with a plain-words reason the model can relay.
 */
export function expandBookingWindow(
  current: BusinessHours,
  input: ProposeWindowInput,
): { hours: BusinessHours; summary: string } {
  const windows = input.windows ?? [];
  const closedDays = input.closedDays ?? [];
  if (windows.length === 0 && closedDays.length === 0) {
    throw new ToolError('No change was described. Name the days and times to change.');
  }

  const hours: BusinessHours = JSON.parse(JSON.stringify(current)) as BusinessHours;
  const claimed = new Map<DayKey, string>();

  for (const day of closedDays) {
    if (!isDayKey(day)) throw new ToolError(`"${day}" is not a day I recognise. Use mon, tue, wed, thu, fri, sat or sun.`);
    if (claimed.has(day)) throw new ToolError(`The day ${day} was listed twice. Describe each day once.`);
    claimed.set(day, 'closed');
    hours[day] = { ...hours[day], enabled: false };
  }

  for (const window of windows) {
    const days = window.days ?? [];
    if (days.length === 0) throw new ToolError('A booking window needs at least one day.');
    const open = (window.open ?? '').trim();
    const close = (window.close ?? '').trim();
    if (!TIME_REGEX.test(open) || !TIME_REGEX.test(close)) {
      throw new ToolError('Times must be 24-hour HH:MM, like 08:00 or 13:30.');
    }
    if (close <= open) {
      throw new ToolError(
        `The window ${open} to ${close} ends before it starts. Booking windows run within one day, so the close time must be later than the open time.`,
      );
    }
    for (const day of days) {
      if (!isDayKey(day)) throw new ToolError(`"${day}" is not a day I recognise. Use mon, tue, wed, thu, fri, sat or sun.`);
      if (claimed.has(day)) {
        throw new ToolError(`The day ${day} appears in two different windows. Describe each day once.`);
      }
      claimed.set(day, `${open}-${close}`);
      hours[day] = { enabled: true, open, close };
    }
  }

  const enabledDays = DAY_KEYS.filter((d) => hours[d].enabled);
  if (enabledDays.length === 0 && input.allowLockout !== true) {
    throw new ToolError(
      'That would close every day and stop all bookings. If that is really what you want, say so explicitly and I will set it up for confirmation.',
    );
  }

  const summary = `Booking window: ${hoursToHumanText(hours)}. (Currently: ${hoursToHumanText(current)}.)`;
  return { hours, summary };
}

/* ------------------------------ data reads ------------------------------ */

async function getSettingsOrThrow(tenantId: string): Promise<AgentSettings> {
  const settings = await prisma.agentSettings.findUnique({ where: { tenantId } });
  if (!settings) {
    throw new HttpError(409, 'Receptionist settings are missing for this workspace.', 'SETTINGS_MISSING');
  }
  return settings;
}

async function toolGetBookingWindow(tenantId: string): Promise<ToolResult> {
  const settings = await getSettingsOrThrow(tenantId);
  const hours = parseBusinessHours(settings.businessHours);
  return {
    summary: hoursToHumanText(hours),
    timezone: settings.timezone,
    hours,
  };
}

async function toolGetAccountSnapshot(tenantId: string): Promise<ToolResult> {
  const [tenant, settings] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { companyName: true, subscriptionStatus: true, monthlyMinuteLimit: true },
    }),
    prisma.agentSettings.findUnique({
      where: { tenantId },
      select: { displayName: true, inboundPhoneNumber: true, timezone: true },
    }),
  ]);
  if (!tenant) throw new HttpError(404, 'Workspace not found.', 'TENANT_NOT_FOUND');
  const usage = await getMonthlyUsage(tenantId, tenant.monthlyMinuteLimit);
  // Note: there is no plan-name field in the schema (plans are a marketing
  // construct); the snapshot reports the fields that actually exist.
  return {
    businessName: tenant.companyName,
    subscriptionStatus: tenant.subscriptionStatus,
    timezone: settings?.timezone ?? null,
    receptionistName: settings?.displayName ?? null,
    receptionistPhoneNumber: settings?.inboundPhoneNumber ?? null,
    minutesUsedThisMonth: usage.usedMinutes,
    monthlyMinuteCap: usage.limitMinutes,
    minutesRemainingThisMonth: usage.remainingMinutes,
    usagePeriodStart: usage.periodStart,
  };
}

/* --------------------------- propose / apply ---------------------------- */

async function toolProposeBookingWindow(
  tenantId: string,
  userId: string,
  input: ProposeWindowInput,
): Promise<ToolResult & { pendingProposal: PendingProposalView }> {
  const settings = await getSettingsOrThrow(tenantId);
  const current = parseBusinessHours(settings.businessHours);
  const { hours, summary } = expandBookingWindow(current, input);
  const proposal: PendingProposal = {
    proposalId: randomUUID(),
    hours,
    summary,
    createdAt: Date.now(),
  };
  pendingProposals.set(pendingKey(tenantId, userId), proposal);
  return {
    status: 'pending_confirmation',
    summary,
    timezone: settings.timezone,
    pendingProposal: { proposalId: proposal.proposalId, summary },
  };
}

export interface ApplyResult {
  summary: string;
  assistantMessage: string;
}

/**
 * Applies a held proposal. Shared by the chat tool (user confirms in words)
 * and the REST confirm button, so both paths enforce the identical rule: a
 * proposal must exist, belong to this (tenant, user), and be unexpired.
 * Every apply lands in the platform audit log and re-syncs the live
 * assistant, exactly like a dashboard settings save.
 */
export async function applyPendingProposal(params: {
  tenantId: string;
  userId: string;
  userEmail: string;
  proposalId: string;
}): Promise<ApplyResult> {
  const pending = readPending(params.tenantId, params.userId);
  if (!pending || pending.proposalId !== params.proposalId) {
    throw new HttpError(
      409,
      'That change is no longer waiting for confirmation. Ask me to set it up again.',
      'PROPOSAL_NOT_FOUND',
    );
  }
  pendingProposals.delete(pendingKey(params.tenantId, params.userId));

  const updated = await prisma.agentSettings.update({
    where: { tenantId: params.tenantId },
    data: { businessHours: pending.hours as unknown as Prisma.InputJsonValue },
  });

  // The platform audit log is the app's only activity record; the actor is
  // the signed-in user and the detail carries the before/after in words.
  await recordAdminAction(params.userEmail, 'support_agent.booking_window', params.tenantId, {
    summary: pending.summary,
    hours: pending.hours,
  });

  // Best-effort, same as the settings save: a sync hiccup never undoes the
  // change, because the server-side booking rules already read the new
  // hours straight from the database on the next call.
  let syncNote = '';
  try {
    const sync = await syncAssistantForTenant(params.tenantId);
    if (sync.synced === false && sync.reason) syncNote = ` ${sync.reason}`;
  } catch {
    syncNote = '';
  }

  const hours = parseBusinessHours(updated.businessHours);
  return {
    summary: pending.summary,
    assistantMessage:
      `Done. Your booking window is now: ${hoursToHumanText(hours)} (${updated.timezone}). ` +
      `Your receptionist will only offer and book times inside it.${syncNote}`,
  };
}

/* ------------------------------ Gemini call ----------------------------- */

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MODEL_TIMEOUT_MS = 30_000;
const MAX_MODEL_TURNS = 6;

const TOOL_DECLARATIONS = [
  {
    name: 'get_booking_window',
    description:
      "Reads this workspace's current booking window (the business hours the receptionist can book inside), as a plain-language summary plus the structured week.",
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'propose_booking_window',
    description:
      'Proposes a booking-window change WITHOUT applying it. Days not mentioned keep their current setting. Each window names the days it covers and one open and close time (24-hour HH:MM, close later than open, same day). Days to close completely go in closedDays. A proposal that closes every day is a total booking lockout and is refused unless allowLockout is true because the user explicitly confirmed they want all bookings stopped. Returns a summary and a proposalId; the change only takes effect when apply_booking_window runs for that proposalId after the user confirms.',
    parameters: {
      type: 'OBJECT',
      properties: {
        windows: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              days: {
                type: 'ARRAY',
                items: { type: 'STRING', enum: [...DAY_KEYS] },
                description: 'Day keys this window applies to.',
              },
              open: { type: 'STRING', description: 'Open time, 24-hour HH:MM.' },
              close: { type: 'STRING', description: 'Close time, 24-hour HH:MM, later than open.' },
            },
            required: ['days', 'open', 'close'],
          },
        },
        closedDays: {
          type: 'ARRAY',
          items: { type: 'STRING', enum: [...DAY_KEYS] },
          description: 'Days to switch off completely.',
        },
        allowLockout: {
          type: 'BOOLEAN',
          description: 'True only when the user has explicitly confirmed they want every day closed.',
        },
      },
    },
  },
  {
    name: 'apply_booking_window',
    description:
      'Applies a booking-window change that propose_booking_window already created, identified by its proposalId. Only call this after the user has confirmed the proposed summary. It cannot apply anything that was never proposed.',
    parameters: {
      type: 'OBJECT',
      properties: {
        proposalId: { type: 'STRING', description: 'The proposalId returned by propose_booking_window.' },
      },
      required: ['proposalId'],
    },
  },
  {
    name: 'get_account_snapshot',
    description:
      "Reads this workspace's account snapshot: business name, subscription status, receptionist name and phone line, minutes used versus the monthly cap.",
    parameters: { type: 'OBJECT', properties: {} },
  },
];

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: unknown } };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/** One model call, platform pattern: fetch + timeout + logged failures. */
async function callGemini(params: {
  apiKey: string;
  systemText: string;
  contents: GeminiContent[];
}): Promise<GeminiPart[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const res = await fetch(GEMINI_GENERATE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': params.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: params.systemText }] },
        contents: params.contents,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: {
          temperature: 0.3,
          // gemini-2.5-flash thinks before answering by default; this chat
          // is a tool-driven support turn, so thinking is switched off
          // (thinkingBudget 0, the Gemini 2.5 control) to keep replies fast.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[support-agent] Gemini request failed, status ${res.status}: ${body.slice(0, 200)}`);
      throw new HttpError(502, 'The support assistant had trouble answering just now. Please try again.', 'MODEL_ERROR');
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    };
    const parts = data.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) {
      console.warn('[support-agent] Gemini response had no content parts.');
      throw new HttpError(502, 'The support assistant had trouble answering just now. Please try again.', 'MODEL_ERROR');
    }
    return parts;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.warn(
      `[support-agent] Gemini request error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
    throw new HttpError(502, 'The support assistant had trouble answering just now. Please try again.', 'MODEL_ERROR');
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ tool runner ----------------------------- */

interface ToolContext {
  tenantId: string;
  userId: string;
  userEmail: string;
  canManage: boolean;
}

async function runTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: ToolResult; pendingProposal?: PendingProposalView }> {
  switch (name) {
    case 'get_booking_window':
      return { result: await toolGetBookingWindow(ctx.tenantId) };
    case 'get_account_snapshot':
      return { result: await toolGetAccountSnapshot(ctx.tenantId) };
    case 'propose_booking_window': {
      const { pendingProposal, ...result } = await toolProposeBookingWindow(
        ctx.tenantId,
        ctx.userId,
        args as ProposeWindowInput,
      );
      return { result, pendingProposal };
    }
    case 'apply_booking_window': {
      // Settings changes are owner/manager territory, mirroring the
      // settings routes; a held proposal does not widen anyone's role.
      if (!ctx.canManage) {
        throw new ToolError('Only an owner or manager can change the booking window.');
      }
      const proposalId = typeof args.proposalId === 'string' ? args.proposalId : '';
      const applied = await applyPendingProposal({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        userEmail: ctx.userEmail,
        proposalId,
      });
      return { result: { status: 'applied', summary: applied.summary, message: applied.assistantMessage } };
    }
    default:
      throw new ToolError(`Unknown tool "${name}".`);
  }
}

/* ------------------------------- chat turn ------------------------------ */

export async function runSupportChat(params: {
  tenantId: string;
  userId: string;
  userEmail: string;
  userRole: string;
  messages: SupportChatMessage[];
}): Promise<SupportChatResult> {
  const apiKey = (env.GEMINI_API_KEY ?? '').trim() || undefined;
  if (!apiKey) {
    // No silent fallback to another vendor: an environment without the key
    // gets a clean 503 and a visible log line, never a crash or a fake reply.
    console.warn('[support-agent] GEMINI_API_KEY is not configured; support chat is unavailable.');
    throw new HttpError(503, 'Support chat is unavailable right now.', 'SUPPORT_NOT_CONFIGURED');
  }

  const [tenant, settings] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: params.tenantId },
      select: { companyName: true, industry: true },
    }),
    prisma.agentSettings.findUnique({ where: { tenantId: params.tenantId } }),
  ]);
  if (!tenant || !settings) {
    throw new HttpError(409, 'Receptionist settings are missing for this workspace.', 'SETTINGS_MISSING');
  }

  const currentHours = parseBusinessHours(settings.businessHours);
  const systemText = [
    `You are ${SUPPORT_AGENT.name}, a support specialist at VoiceFront, helping the team at ${tenant.companyName} inside their VoiceFront app.`,
    '',
    KNOWLEDGE_BLOCK,
    '',
    'THIS WORKSPACE (the only account you may discuss or touch):',
    `- Business: ${tenant.companyName} (${tenant.industry === 'CONSTRUCTION' ? 'trades' : 'clinic'}).`,
    `- Receptionist name: ${settings.displayName}.`,
    `- Timezone: ${settings.timezone}.`,
    `- Current booking window: ${hoursToHumanText(currentHours)}.`,
    '',
    AGENT_RULES,
  ].join('\n');

  const contents: GeminiContent[] = params.messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text }],
  }));

  const ctx: ToolContext = {
    tenantId: params.tenantId,
    userId: params.userId,
    userEmail: params.userEmail,
    canManage: params.userRole === 'OWNER' || params.userRole === 'MANAGER',
  };

  let pendingProposal: PendingProposalView | null = null;

  for (let turn = 0; turn < MAX_MODEL_TURNS; turn += 1) {
    const parts = await callGemini({ apiKey, systemText, contents });
    const calls = parts.filter((p) => p.functionCall);
    if (calls.length === 0) {
      const text = parts
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('')
        .trim();
      return {
        reply: text || 'Sorry, I did not catch that. Could you say it another way?',
        pendingProposal,
      };
    }

    contents.push({ role: 'model', parts });
    const responses: GeminiPart[] = [];
    for (const call of calls) {
      const name = call.functionCall?.name ?? '';
      const args = call.functionCall?.args ?? {};
      try {
        const { result, pendingProposal: created } = await runTool(ctx, name, args);
        if (created) pendingProposal = created;
        responses.push({ functionResponse: { name, response: { result } } });
      } catch (err) {
        if (err instanceof ToolError) {
          responses.push({
            functionResponse: { name, response: { result: { status: 'error', error: err.message } } },
          });
        } else if (err instanceof HttpError && err.code === 'PROPOSAL_NOT_FOUND') {
          responses.push({
            functionResponse: { name, response: { result: { status: 'error', error: err.message } } },
          });
        } else {
          throw err;
        }
      }
    }
    contents.push({ role: 'user', parts: responses });
  }

  throw new HttpError(502, 'The support assistant took too long over that. Please try again.', 'MODEL_LOOP');
}
