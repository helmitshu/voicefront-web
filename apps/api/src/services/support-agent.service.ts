import { randomUUID } from 'node:crypto';
import { Prisma, type AgentSettings, type SupportTicketCategory } from '@prisma/client';
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
import { TICKET_CATEGORY_LABELS, ticketReference } from './support-ticket.service';

/**
 * In-app support agent ("Adam"), v2. The founder's job description, and the
 * whole design follows from it: Adam never talks about anything internal to
 * the company (see CONFIDENTIALITY_BLOCK). His job is to
 *   (a) carry out tasks and report them (today: change the booking window,
 *       file a support ticket — both propose-then-confirm, both reported
 *       back with exactly what happened),
 *   (b) answer questions about the page the user is on (the widget sends
 *       the current route; a server-side page map names it in the prompt),
 *   (c) file a ticket for the platform team when the customer has an issue
 *       or a receptionist handled a call badly (BAD_CALL tickets can point
 *       at the CallLog the user picks from their recent calls).
 *
 * The booking window is not a new setting: it is the tenant's existing
 * `AgentSettings.businessHours`, the same server-owned column the
 * receptionist's slot grid (`findFreeSlots`) and booking validator
 * (`resolveBookingWindow`) read on every call, and the same column the
 * dashboard's BusinessHoursEditor writes. A change here is a change Maya
 * genuinely honors. Tickets are real SupportTicket rows the team reads
 * through GET /api/admin/tickets.
 *
 * Change safety model: the model can only PROPOSE. A proposal is expanded
 * and validated server-side and held in a server-side pending slot keyed by
 * (tenant, user). APPLY/FILE only ever acts on a held proposal by id —
 * there is no path for the model or the client to submit an arbitrary
 * payload, and a ticket is never filed from model text alone.
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

/**
 * Sealed lips, as a prompt block. Adam serves the signed-in workspace; the
 * company behind the product is never his subject. This governs what he
 * SAYS — his tools already only ever see the caller's own workspace data.
 * (The block's presence in the assembled prompt is pinned by a test.)
 */
export const CONFIDENTIALITY_BLOCK = [
  'CONFIDENTIALITY (never break):',
  '- You serve the signed-in workspace. You never discuss VoiceFront the company: not its internal operations, team, owners, or finances; not its vendors, technology, models, or infrastructure; not how you or the receptionist are built, trained, or prompted; not internal pricing, margins, strategy, or roadmaps; not any other customer, account, or their data.',
  '- What the product does for THIS workspace (the knowledge block, their settings, their calls, their usage) is fine to share. Company internals are not.',
  '- If asked about any internal matter, decline in one short line and offer what you can do instead: help with the page they are on, a task you can carry out, or a ticket to the team if something is wrong.',
].join('\n');

const AGENT_RULES = [
  'RULES:',
  '- You are a customer care specialist for THIS workspace only. Never mention, compare, or reveal anything about any other business or account.',
  '- Answer product questions from the knowledge block and the workspace context. If something is not in the knowledge block, say plainly that the product does not do that today; never invent features, prices, or policies.',
  '- When the prompt names the page the user is on, anchor answers to that page first: if they say "this page", they mean that one. Only widen to the rest of the product when the question does.',
  '- Your actions are exactly two: change the booking window, and file a ticket for the VoiceFront team. Both run propose then confirm. For any other change, tell the user exactly which Settings card handles it and stop there.',
  '- Booking window flow: when the user asks for a change, call propose_booking_window first. Then show the user the returned summary and ask them to confirm (they can tap Confirm or say yes). NEVER say a change is in effect until apply_booking_window has returned status "applied".',
  '- If the user confirms a pending change in words, call apply_booking_window with the proposalId from the propose result.',
  '- Ticket flow: when the user reports a problem, gather a short subject and the details in their own words, then call propose_ticket. If the report is about a specific call (the receptionist handled a call badly), first call list_recent_calls, work out with the user which call they mean, and pass that call\'s id as callLogId with category BAD_CALL. Then show the returned summary and ask them to confirm (they can tap "File this ticket" or say yes). NEVER say a ticket is filed until file_ticket has returned a reference.',
  '- If the user confirms a pending ticket in words, call file_ticket with the proposalId from the propose_ticket result.',
  '- Task reports: after apply_booking_window or file_ticket succeeds, report exactly what the tool result says happened (the old and new booking window, or the ticket reference and what it is about). Never add promises about response times, fixes, or outcomes.',
  '- If a tool returns an error, relay the problem in plain words and, where it helps, offer a corrected alternative. Do not retry the same failing call unchanged.',
  '- Keep replies short, warm, and plain. No corporate filler. Use the business timezone for all times you mention.',
].join('\n');

/* ----------------------------- page context ----------------------------- */

/**
 * The signed-in app's real pages, keyed by the route the widget sends.
 * Server-side on purpose: the client can only ever *name* a page, the
 * description Adam hears comes from this map, and an unknown route simply
 * adds no page context. Blurbs are what each page actually shows today.
 */
export interface SupportPageInfo {
  name: string;
  blurb: string;
}

export const SUPPORT_PAGE_MAP: Record<string, SupportPageInfo> = {
  '/dashboard': {
    name: 'Dashboard',
    blurb:
      'The home screen: how the receptionist has been doing, live and recent call activity, and the headline numbers for the workspace.',
  },
  '/dashboard/calls': {
    name: 'Calls',
    blurb:
      'Call history: every call with its recording, transcript, summary and outcome. Opening one call shows its full detail page.',
  },
  '/dashboard/calendar': {
    name: 'Calendar',
    blurb:
      'The appointment book: bookings by day. Staff can book, reschedule and cancel manually, and manual bookings respect the business hours.',
  },
  '/dashboard/analytics': {
    name: 'Analytics',
    blurb:
      'Call volume and estimated revenue captured, based on the average appointment value set in Settings.',
  },
  '/dashboard/jobs': {
    name: 'Jobs',
    blurb:
      'The trades job queue: jobs the receptionist captured from calls, sorted by urgency, each with a status the team works through.',
  },
  '/dashboard/waitlist': {
    name: 'Waitlist',
    blurb:
      'People waiting for an appointment slot. When a cancellation opens a time, the next person can be texted if SMS is on.',
  },
  '/dashboard/providers': {
    name: 'Providers & services',
    blurb:
      'The bookable people (dentists, stylists, crews) and the services they offer. Availability and double-booking are tracked per provider.',
  },
  '/dashboard/settings': {
    name: 'Settings',
    blurb:
      'The receptionist and workspace settings cards: Persona, Voice & sound, Call handling instructions, Knowledge documents, Voicemail greeting, Business hours, Average appointment value, Live call transfer, Call length & timing, Your receptionist number, SMS notifications, Calendar connections, Call screening, and Appearance.',
  },
  '/dashboard/account': {
    name: 'Account',
    blurb:
      'The signed-in user and workspace: profile and role, subscription status, usage, and preferences like theme and calm mode.',
  },
};

/**
 * Resolves a client-supplied pathname to a known page. Exact matches win;
 * a nested page under a known section (a single call's detail) anchors to
 * that section. Anything else, including junk, resolves to null — page
 * context is an anchor, never an error.
 */
export function resolveSupportPage(pathname: string | null | undefined): SupportPageInfo | null {
  if (!pathname) return null;
  let p = pathname.trim();
  if (!p) return null;
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  const direct = SUPPORT_PAGE_MAP[p];
  if (direct) return direct;
  if (p.startsWith('/dashboard/calls/')) return SUPPORT_PAGE_MAP['/dashboard/calls'] ?? null;
  return null;
}

/* --------------------------- system prompt ------------------------------ */

/**
 * Assembles Adam's system prompt. Pure and exported so tests can pin what
 * he is told: the confidentiality block is always in, and a resolved page
 * adds exactly one anchoring line while an unknown route adds nothing.
 */
export function buildSupportSystemText(params: {
  companyName: string;
  industry: string;
  receptionistName: string;
  timezone: string;
  currentHoursText: string;
  page: SupportPageInfo | null;
}): string {
  const lines = [
    `You are ${SUPPORT_AGENT.name}, a Customer Care Specialist at VoiceFront, helping the team at ${params.companyName} inside their VoiceFront app.`,
    '',
    KNOWLEDGE_BLOCK,
    '',
    CONFIDENTIALITY_BLOCK,
    '',
  ];
  if (params.page) {
    lines.push(
      'CURRENT PAGE:',
      `- The user is looking at the ${params.page.name} page right now. ${params.page.blurb} When they say "this page", they mean this one.`,
      '',
    );
  }
  lines.push(
    'THIS WORKSPACE (the only account you may discuss or touch):',
    `- Business: ${params.companyName} (${params.industry === 'CONSTRUCTION' ? 'trades' : 'clinic'}).`,
    `- Receptionist name: ${params.receptionistName}.`,
    `- Timezone: ${params.timezone}.`,
    `- Current booking window: ${params.currentHoursText}.`,
    '',
    AGENT_RULES,
  );
  return lines.join('\n');
}

/* ------------------------------ chat types ------------------------------ */

export interface SupportChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** What kind of task a held proposal will carry out when confirmed. */
export type PendingProposalKind = 'booking_window' | 'ticket';

export interface PendingProposalView {
  proposalId: string;
  kind: PendingProposalKind;
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

interface PendingBookingWindowProposal {
  kind: 'booking_window';
  proposalId: string;
  hours: BusinessHours;
  summary: string;
  createdAt: number;
}

interface PendingTicketProposal {
  kind: 'ticket';
  proposalId: string;
  category: SupportTicketCategory;
  subject: string;
  details: string;
  callLogId: string | null;
  summary: string;
  createdAt: number;
}

/**
 * One held proposal per (tenant, user), whichever kind was proposed last:
 * a new propose replaces the old, so there is never ambiguity about what
 * a Confirm tap will do.
 */
type PendingProposal = PendingBookingWindowProposal | PendingTicketProposal;

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
  const proposal: PendingBookingWindowProposal = {
    kind: 'booking_window',
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
    pendingProposal: { proposalId: proposal.proposalId, kind: 'booking_window' as const, summary },
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
  if (!pending || pending.proposalId !== params.proposalId || pending.kind !== 'booking_window') {
    throw new HttpError(
      409,
      'That change is no longer waiting for confirmation. Ask me to set it up again.',
      'PROPOSAL_NOT_FOUND',
    );
  }
  pendingProposals.delete(pendingKey(params.tenantId, params.userId));

  // Read the outgoing window before the write so the task report can state
  // the change as old to new, not just announce the new state.
  const before = await getSettingsOrThrow(params.tenantId);
  const oldText = hoursToHumanText(parseBusinessHours(before.businessHours));

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
  const newText = hoursToHumanText(hours);
  return {
    summary: pending.summary,
    assistantMessage:
      `Done. Booking window changed from ${oldText} to ${newText} (${updated.timezone}). ` +
      `Your receptionist will only offer and book times inside the new window.${syncNote}`,
  };
}

/* ------------------------------- tickets -------------------------------- */

const TICKET_CATEGORIES = ['ISSUE', 'BAD_CALL', 'OTHER'] as const;
const RECENT_CALLS_LIMIT = 10;

/** "Tue, Oct 14 at 3:42 PM" in the workspace's own timezone. */
function formatCallWhen(startedAt: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(startedAt);
  } catch {
    return startedAt.toISOString();
  }
}

function callerNameOf(structuredData: unknown): string | null {
  if (structuredData && typeof structuredData === 'object') {
    const name = (structuredData as Record<string, unknown>).callerName;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

interface CallRowForTickets {
  id: string;
  startedAt: Date;
  callerNumber: string | null;
  structuredData: unknown;
}

/** One-line call description the model (and the ticket summary) can use. */
function describeCall(call: CallRowForTickets, timezone: string): string {
  const name = callerNameOf(call.structuredData);
  const from = call.callerNumber ?? 'an unknown number';
  return `${formatCallWhen(call.startedAt, timezone)} call from ${from}${name ? ` (${name})` : ''}`;
}

async function toolListRecentCalls(tenantId: string, timezone: string): Promise<ToolResult> {
  const calls = await prisma.callLog.findMany({
    where: { tenantId },
    orderBy: { startedAt: 'desc' },
    take: RECENT_CALLS_LIMIT,
    select: {
      id: true,
      startedAt: true,
      callerNumber: true,
      channel: true,
      status: true,
      outcome: true,
      intent: true,
      summary: true,
      durationSeconds: true,
      successScore: true,
      structuredData: true,
    },
  });
  return {
    timezone,
    calls: calls.map((c) => ({
      id: c.id,
      when: describeCall(c, timezone),
      startedAt: c.startedAt.toISOString(),
      callerNumber: c.callerNumber,
      callerName: callerNameOf(c.structuredData),
      channel: c.channel,
      status: c.status,
      outcome: c.outcome,
      intent: c.intent,
      successScore: c.successScore,
      durationSeconds: c.durationSeconds,
      summary: c.summary ? c.summary.slice(0, 240) : null,
    })),
  };
}

export interface ProposeTicketInput {
  category?: string;
  subject?: string;
  details?: string;
  callLogId?: string;
}

/**
 * Validates and holds a ticket proposal. The call a BAD_CALL report points
 * at is re-checked against the caller's own tenant server-side: an id from
 * another workspace (or a made-up one) is rejected, never attached.
 */
async function toolProposeTicket(
  tenantId: string,
  userId: string,
  timezone: string,
  input: ProposeTicketInput,
): Promise<ToolResult & { pendingProposal: PendingProposalView }> {
  const category = (input.category ?? '').trim().toUpperCase();
  if (!(TICKET_CATEGORIES as readonly string[]).includes(category)) {
    throw new ToolError('A ticket needs a category: ISSUE, BAD_CALL or OTHER.');
  }
  const subject = (input.subject ?? '').trim();
  if (!subject) throw new ToolError('A ticket needs a short subject line.');
  if (subject.length > 140) throw new ToolError('The subject is too long. Keep it to one short line.');
  const details = (input.details ?? '').trim();
  if (!details) throw new ToolError('A ticket needs the details: what happened, in the user\'s words.');
  if (details.length > 2000) throw new ToolError('Those details are too long for one ticket. Trim them down.');

  let callLogId: string | null = null;
  let callLabel: string | null = null;
  if (input.callLogId) {
    const call = await prisma.callLog.findFirst({
      where: { id: input.callLogId, tenantId },
      select: { id: true, startedAt: true, callerNumber: true, structuredData: true },
    });
    if (!call) {
      throw new ToolError(
        'That call is not in this workspace\'s call history, so I cannot attach it. Use list_recent_calls and pick one of those.',
      );
    }
    callLogId = call.id;
    callLabel = describeCall(call, timezone);
  }

  const label = TICKET_CATEGORY_LABELS[category as SupportTicketCategory];
  const summary =
    `Ticket for the VoiceFront team. ${label}: "${subject}".` +
    (callLabel ? ` About the ${callLabel}.` : '') +
    ` Details: ${details.length > 280 ? `${details.slice(0, 280)}…` : details}`;

  const proposal: PendingTicketProposal = {
    kind: 'ticket',
    proposalId: randomUUID(),
    category: category as SupportTicketCategory,
    subject,
    details,
    callLogId,
    summary,
    createdAt: Date.now(),
  };
  pendingProposals.set(pendingKey(tenantId, userId), proposal);
  return {
    status: 'pending_confirmation',
    summary,
    pendingProposal: { proposalId: proposal.proposalId, kind: 'ticket', summary },
  };
}

export interface FileTicketResult {
  reference: string;
  summary: string;
  assistantMessage: string;
}

/**
 * Files a held ticket proposal as a real SupportTicket row. Shared by the
 * chat tool (user confirms in words) and the REST "File this ticket"
 * button, under the identical rule as booking applies: the proposal must
 * exist, belong to this (tenant, user), be unexpired, and be a ticket.
 * Any signed-in role may file — reporting a problem is not a settings
 * change, so the owner/manager gate does not apply here.
 */
export async function filePendingTicket(params: {
  tenantId: string;
  userId: string;
  proposalId: string;
}): Promise<FileTicketResult> {
  const pending = readPending(params.tenantId, params.userId);
  if (!pending || pending.proposalId !== params.proposalId || pending.kind !== 'ticket') {
    throw new HttpError(
      409,
      'That ticket is no longer waiting for confirmation. Ask me to write it up again.',
      'PROPOSAL_NOT_FOUND',
    );
  }
  pendingProposals.delete(pendingKey(params.tenantId, params.userId));

  const ticket = await prisma.supportTicket.create({
    data: {
      tenantId: params.tenantId,
      createdByUserId: params.userId,
      category: pending.category,
      subject: pending.subject,
      details: pending.details,
      callLogId: pending.callLogId,
    },
  });
  const reference = ticketReference(ticket.id);
  const label = TICKET_CATEGORY_LABELS[pending.category];
  return {
    reference,
    summary: pending.summary,
    assistantMessage:
      `Filed with the VoiceFront team. Ticket ${reference}: ${label.toLowerCase()}, "${pending.subject}". ` +
      'They can see it now, with the details you confirmed.',
  };
}

/* ------------------------------ Gemini call ----------------------------- */

const GEMINI_MODEL = 'gemini-3.8-flash';
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
  {
    name: 'list_recent_calls',
    description:
      "Lists this workspace's most recent calls (newest first, up to 10) with their ids, times, callers, outcomes and summaries. Use it when the user reports a problem with a specific call, so the ticket can be attached to the exact call they mean. Only this workspace's calls are ever returned.",
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'propose_ticket',
    description:
      'Proposes a support ticket for the VoiceFront team WITHOUT filing it. Categories: ISSUE (something is wrong or broken), BAD_CALL (the receptionist handled a call badly; attach the call by passing callLogId from list_recent_calls), OTHER (anything else). Returns a summary and a proposalId; the ticket is only filed when file_ticket runs for that proposalId after the user confirms.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category: { type: 'STRING', enum: [...TICKET_CATEGORIES], description: 'Ticket category.' },
        subject: { type: 'STRING', description: 'One short line: what the ticket is about.' },
        details: { type: 'STRING', description: "What happened, in the user's own words." },
        callLogId: {
          type: 'STRING',
          description: 'Optional: the id of the call this ticket is about, taken from list_recent_calls.',
        },
      },
      required: ['category', 'subject', 'details'],
    },
  },
  {
    name: 'file_ticket',
    description:
      'Files a ticket that propose_ticket already created, identified by its proposalId. Only call this after the user has confirmed the proposed summary. It cannot file anything that was never proposed.',
    parameters: {
      type: 'OBJECT',
      properties: {
        proposalId: { type: 'STRING', description: 'The proposalId returned by propose_ticket.' },
      },
      required: ['proposalId'],
    },
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
  timezone: string;
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
    case 'list_recent_calls':
      return { result: await toolListRecentCalls(ctx.tenantId, ctx.timezone) };
    case 'propose_ticket': {
      const { pendingProposal, ...result } = await toolProposeTicket(
        ctx.tenantId,
        ctx.userId,
        ctx.timezone,
        args as ProposeTicketInput,
      );
      return { result, pendingProposal };
    }
    case 'file_ticket': {
      // Filing a ticket is open to every signed-in role: reporting that a
      // call went badly is exactly what front-desk staff are here for.
      const proposalId = typeof args.proposalId === 'string' ? args.proposalId : '';
      const filed = await filePendingTicket({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        proposalId,
      });
      return {
        result: {
          status: 'filed',
          reference: filed.reference,
          summary: filed.summary,
          message: filed.assistantMessage,
        },
      };
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
  /** The app route the user is on, as sent by the widget. Resolved
   *  against SUPPORT_PAGE_MAP server-side; unknown routes add nothing. */
  pagePath?: string;
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
  const systemText = buildSupportSystemText({
    companyName: tenant.companyName,
    industry: tenant.industry,
    receptionistName: settings.displayName,
    timezone: settings.timezone,
    currentHoursText: hoursToHumanText(currentHours),
    page: resolveSupportPage(params.pagePath),
  });

  const contents: GeminiContent[] = params.messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text }],
  }));

  const ctx: ToolContext = {
    tenantId: params.tenantId,
    userId: params.userId,
    userEmail: params.userEmail,
    canManage: params.userRole === 'OWNER' || params.userRole === 'MANAGER',
    timezone: settings.timezone,
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
