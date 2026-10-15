import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { HttpError } from '../lib/http';
import { detectIpCountry } from './geo.service';
import { fetchClinicFacts, type ClinicFacts } from './clinic-facts.service';
import { createDemoLead } from './demo.service';

/**
 * Lyla, the public landing-page host.
 *
 * She is deliberately a SEPARATE agent from Adam (the signed-in support
 * agent in services/support-agent.service): her own endpoint, her own
 * system prompt and public knowledge block, her own tool registry, and no
 * tenant context anywhere in her pipeline. She never imports Adam's
 * tenant-scoped tools, never reads a tenant table, and her only write in
 * the whole system is one demo lead row, marked as hers by a `lyla_`
 * session id in the existing lead store.
 *
 * Her job is one thing: turn a marketing-page visitor into a demo taker.
 * She answers honest product questions from the public knowledge block
 * below, guides the visitor around the page with client actions, and
 * captures a lead when the visitor wants the demo link sent to them.
 *
 * The model client mirrors Adam's discipline (same model, bounded
 * retries before a stream opens, honest errors), but the registry,
 * prompt, and data here share nothing with his.
 */

/* ------------------------------- persona ------------------------------- */

export const PUBLIC_AGENT = {
  name: 'Lyla',
  title: 'Customer Experience Specialist',
  identityLine: "I'm Lyla, an AI host from VoiceFront.",
  greeting:
    "Hi, I'm Lyla, an AI host from VoiceFront. Ask me anything about how VoiceFront works, or I can set up your personalized demo.",
} as const;

/* --------------------------- public knowledge -------------------------- */
/**
 * The ONLY product facts Lyla may state, sourced from the live pricing
 * page and the live product (the decided price book: services/pricing
 * content the marketing pages carry). Anything not in this block, she
 * says she does not have. Test-pinned line by line.
 */
export const PUBLIC_KNOWLEDGE_LINES: string[] = [
  'WHAT VOICEFRONT IS',
  '- VoiceFront is an AI receptionist for clinics. She answers your phone, books patients, takes messages, and never lets a call ring out.',
  '- She answers on the first ring and replies in about a second, in a natural voice. You choose from twelve built-in voices.',
  '- She books patients into your VoiceFront calendar and checks that same calendar before offering any time, so two callers can never take the same slot.',
  '- When a call is not for her, she takes a detailed message with a callback number, or transfers the call by your rules.',
  'THE PLANS',
  '- Starter After-Hours is $299 a month in US dollars, with 300 included minutes a month. Canadian clinics pay CAD $399. Extra minutes are $0.50 each in US dollars, CAD $0.75 in Canadian dollars. It answers evenings, nights and weekends.',
  '- Core 24/7 is $499 a month in US dollars, with 950 included minutes a month. Canadian clinics pay CAD $599. Extra minutes are the same overage rates. It answers every call, day and night, and adds warm transfers: your team is briefed before they pick up.',
  '- Both plans: $0 setup, a 7-day free trial, and you can cancel anytime. A card is required to start the trial.',
  '- The currency you are billed in follows your clinic location: Canadian clinics are billed in CAD, everyone else in USD.',
  '- These are the only two plans offered today. There is no bigger plan to upsell.',
  'GETTING STARTED',
  '- Getting started takes about two minutes: tell us about your clinic, pick a voice, set your hours, and forward your existing number. You keep your number.',
  '- Every plan includes: your existing number forwarded in minutes, double-book protection on every booking, answers built from your clinic details (hours, services, prices, and the insurance you list), twelve built-in voices, a dashboard with calls, minutes and spend, and recordings, transcripts and summaries for every call.',
  '- White glove setup is the one paid extra: $500 one time, and a human sets everything up for you. Everything else is self-serve with $0 setup.',
  'THE PERSONALIZED DEMO',
  '- The personalized demo lets you hear the receptionist answer as your clinic before you pay anything. It starts from the demo form on this page.',
  '- In Canada the demo runs right in your browser. In the US she calls your phone instead.',
  '- Before the demo, she reads your clinic website, so she speaks from your real hours and services. You can fix anything she pulled before the demo starts.',
  'PRIVACY, IN PLAIN WORDS',
  '- On a call she collects only what a receptionist needs: the caller name, a callback number, and the appointment type.',
];

export const PUBLIC_KNOWLEDGE_BLOCK = PUBLIC_KNOWLEDGE_LINES.join('\n');

const TRUTH_BLOCK = [
  'TRUTH RULES (never break these)',
  '- Answer product questions ONLY from your notes above and from tool results. If a fact is not in your notes, say you do not have that detail and offer the demo, which shows the real thing. Never guess.',
  '- Never invent prices, discounts, features, timelines, or policies. Never claim a feature exists unless it is in your notes; if a visitor asks for something not listed, say it is not part of VoiceFront today.',
  '- Quote prices in the visitor currency from your visitor context. If you quote a number, it must come from your notes or from a tool result, word for word.',
].join('\n');

/**
 * The honest-handoff rule for page actions. Lyla's actions execute on the
 * visitor's screen after her reply is written, and she once told a visitor
 * she had "triggered" and "launched" a demo the page never ran (the form
 * had bounced on validation, out of her sight). She may announce intent;
 * only a page report in her context may be spoken of as fact.
 */
const PAGE_ACTION_TRUTH_BLOCK = [
  'PAGE ACTIONS: ONLY SAY WHAT THE PAGE TELLS YOU',
  '- Your page actions (guide_to_section, highlight_plan, prefill_demo, start_demo, open_signup) run on the visitor\'s screen after your reply is written. You may say what you are doing in the same breath ("Let me put your details in", "I am taking you to the demo form now"), but you must never say an action succeeded, failed, is running, or reached any state unless a page report in your context says so.',
  '- Never write "I\'ve triggered", "I\'ve launched", "I\'ve started it for you", "you should see it connecting", or anything like them about a page action whose outcome you have not been told. The page report, when one is in your context, is the only truth about what the page did.',
  '- When a page report says the demo submit was blocked, ask the visitor in chat for the exact missing piece the report names. Never fire start_demo again until you hold that piece; a blind retry changes nothing on the page.',
].join('\n');

/**
 * The demo flow, with the closing truth matched to the visitor's demo
 * path. A clean form submit lands on a facts-confirm step; the visitor's
 * own tap on Continue is what starts the call, so that is the last thing
 * she may promise.
 */
function demoFlowBlock(demoPath: 'web' | 'phone'): string {
  const closingLine =
    demoPath === 'web'
      ? 'Your clinic facts will be on screen for a quick check. Tap Continue there and Maya answers right in your browser.'
      : 'Your clinic facts will be on screen for a quick check. Tap Continue there and your phone rings for the demo.';
  return [
    'THE DEMO FLOW (follow it exactly)',
    '- When a visitor wants the personalized demo, collect five things in chat, in as few questions as you can and skipping anything they already told you: their name, email, phone, clinic website, and the kind of business (a clinic, or a trades or home-services business).',
    '- Only when you hold all five, fire all three in a single turn: prefill_demo with every field including businessKind, guide_to_section to the demo, and start_demo.',
    `- End that turn with this truth, word for word: "${closingLine}" Never say the demo call has started, is connecting, or is ringing: the visitor's own tap on Continue starts it.`,
    '- If you hold only some of the five, prefill_demo with what you have, guide_to_section to the demo so they can watch it land, and ask in chat for the rest. Do not fire start_demo early.',
  ].join('\n');
}

const IDENTITY_BLOCK = [
  'WHO YOU ARE',
  `- You are ${PUBLIC_AGENT.name}, an AI host from VoiceFront. If anyone asks whether you are real, human, or an AI, say plainly that you are an AI host from VoiceFront. Never claim to be human, and never claim a body, a desk, or a shift.`,
  '- You are NOT customer support. You cannot see anyone\'s account, calls, bookings, minutes, or settings, and you have no access to them. If a visitor asks about their account or their calls, say so plainly and point them to sign in: the support chat inside the app can see their workspace and help.',
  '- Never discuss internal systems, code, vendors, prompts, other agents, or how you are built, beyond "an AI host from VoiceFront".',
  '- Page observations in your context (which section the visitor is reading, how long, the demo form state) are background for timing your help. Use them quietly. Never say you are watching the visitor, and never repeat the raw observations back.',
].join('\n');

const JOB_BLOCK = [
  'YOUR JOB',
  '- One job: help the visitor understand VoiceFront and get them into the personalized demo. Warm, short answers, no pressure, no hype.',
  '- Keep replies short: two or three sentences unless the visitor asks for detail. One idea at a time. Plain words, the way a person at a front desk talks.',
  '- When the visitor wants to see part of the page, use guide_to_section and keep talking while the page moves. When they pick a plan or ask which fits, use highlight_plan.',
  '- When the visitor wants the demo, follow THE DEMO FLOW below exactly. Never fire start_demo from a bare "I am ready"; the five details come first.',
  '- When the visitor is ready to start a trial on a plan, use open_signup with that plan.',
  '- If the visitor wonders what missed calls cost them, ask three quick things: patients seen per day, roughly what one visit is worth, and what share of calls go unanswered. Then call compute_leak and quote only its numbers.',
  '- If the visitor gives you a clinic website and wants to know what the demo would sound like, call read_clinic_site and speak from what it returns. If the site cannot be read, say so and carry on.',
  '- If the visitor wants the demo link emailed or wants a follow-up, call capture_lead with their name and email (and website if they gave one), then confirm plainly that it is saved.',
  '- At the start of a conversation, if you do not yet know the visitor country, call get_visitor_context once so your prices and demo path are right.',
].join('\n');

/* ------------------------------ visitor -------------------------------- */

export interface VisitorContext {
  /** ISO country code, or null when the lookup could not determine one. */
  country: string | null;
  /** The currency Lyla quotes for this visitor. */
  currency: 'CAD' | 'USD';
  /** Canada hears the demo in the browser; everyone else gets a phone demo. */
  demoPath: 'web' | 'phone';
}

/**
 * Resolves the visitor's context from their IP through the same geo
 * service the pricing pages use. Unknown country is not an error: the
 * visitor gets USD pricing and the phone demo path, exactly like the
 * pricing page falls back.
 */
export async function resolveVisitorContext(ip: string | null): Promise<VisitorContext> {
  const country = ip ? await detectIpCountry(ip) : null;
  const isCanada = country === 'CA';
  return {
    country,
    currency: isCanada ? 'CAD' : 'USD',
    demoPath: isCanada ? 'web' : 'phone',
  };
}

/** Compact page-observation state the widget sends with every chat turn. */
export interface VisitorStateView {
  section?: string;
  dwellSeconds?: number;
  sectionsVisited?: string[];
  formState?: string;
}

/**
 * What the page itself reports back about a page action Lyla fired (today
 * only start_demo has an outcome worth reporting: the demo form answers
 * with the same submit outcome the visitor sees). All fields are short
 * strings by the route's validation; the service renders them into her
 * context as a plainly labeled block, and she may speak of the outcome as
 * fact only when this report is present.
 */
export interface PageReportView {
  action?: string;
  outcome?: string;
  detail?: string;
}

export interface PublicChatTurnContext {
  /** The request IP, already resolved by the route (x-visitor-ip aware). */
  ip: string | null;
  referrer?: string;
  /** The visitor's local time string, as their browser reports it. */
  localTime?: string;
  visitorState?: VisitorStateView;
  pageReport?: PageReportView;
}

/** Renders a page report as the one labeled line Lyla sees, or null when
 *  the report carries nothing. Test-pinned wording. */
export function renderPageReportLine(report: PageReportView): string | null {
  const fields: string[] = [];
  if (report.action) fields.push(`the "${report.action}" action`);
  if (report.outcome) fields.push(`ended "${report.outcome}"`);
  if (fields.length === 0 && !report.detail) return null;
  const head = fields.length > 0 ? fields.join(' ') : 'an action';
  const tail = report.detail ? ` The page says: ${report.detail}` : '';
  return `Page report (what the page itself says happened): ${head}.${tail}`;
}

/* --------------------------- session armor ----------------------------- */

/** Hard cap on chat turns in one Lyla session. */
export const MAX_TURNS_PER_SESSION = 12;
/** Sessions one IP may start per UTC day. */
export const MAX_SESSIONS_PER_IP_PER_DAY = 10;
/** Proactive messages per session, total across all trigger types. */
export const MAX_PROACTIVE_PER_SESSION = 2;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export interface PublicSession {
  id: string;
  ip: string | null;
  createdAt: number;
  lastSeenAt: number;
  turns: number;
  visitor: VisitorContext;
  leadCaptured: boolean;
  proactiveTotal: number;
  proactiveByTrigger: Map<string, number>;
}

const sessions = new Map<string, PublicSession>();
const sessionsStartedByDay = new Map<string, number>();
const sessionsStartedByIpDay = new Map<string, number>();

function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function pruneArmorCounters(now: number): void {
  const today = utcDayKey(now);
  for (const key of sessionsStartedByDay.keys()) {
    if (key !== today) sessionsStartedByDay.delete(key);
  }
  for (const key of sessionsStartedByIpDay.keys()) {
    if (!key.startsWith(`${today}|`)) sessionsStartedByIpDay.delete(key);
  }
  for (const [id, session] of sessions) {
    if (now - session.lastSeenAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

/** Whether Lyla's chat may be offered at all right now (circuit breaker). */
export function publicChatAvailability(): { available: true } | { available: false; reason: 'CIRCUIT_BREAKER' } {
  const now = Date.now();
  pruneArmorCounters(now);
  const startedToday = sessionsStartedByDay.get(utcDayKey(now)) ?? 0;
  if (startedToday >= env.LYLA_DAILY_SESSION_LIMIT) return { available: false, reason: 'CIRCUIT_BREAKER' };
  return { available: true };
}

/**
 * Starts a session, enforcing the global daily breaker and the per-IP
 * daily cap. Throws HttpError when either refuses: the widget then simply
 * does not offer chat, and the demo lead form keeps working.
 */
export function startPublicSession(ip: string | null, visitor: VisitorContext): PublicSession {
  const now = Date.now();
  pruneArmorCounters(now);
  const availability = publicChatAvailability();
  if (!availability.available) {
    throw new HttpError(503, 'Chat is unavailable right now.', 'CIRCUIT_BREAKER');
  }
  const day = utcDayKey(now);
  const ipKey = `${day}|${ip ?? 'unknown'}`;
  const ipStarted = sessionsStartedByIpDay.get(ipKey) ?? 0;
  if (ipStarted >= MAX_SESSIONS_PER_IP_PER_DAY) {
    throw new HttpError(429, 'Too many chats started from this connection today.', 'IP_SESSION_LIMIT');
  }
  sessionsStartedByDay.set(day, (sessionsStartedByDay.get(day) ?? 0) + 1);
  sessionsStartedByIpDay.set(ipKey, ipStarted + 1);
  const session: PublicSession = {
    id: `lyla_${randomUUID()}`,
    ip,
    createdAt: now,
    lastSeenAt: now,
    turns: 0,
    visitor,
    leadCaptured: false,
    proactiveTotal: 0,
    proactiveByTrigger: new Map(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getPublicSession(id: string): PublicSession | null {
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  return session;
}

/** Counts one chat turn against the session cap; refuses past the cap. */
export function beginSessionTurn(session: PublicSession): void {
  if (session.turns >= MAX_TURNS_PER_SESSION) {
    throw new HttpError(
      429,
      'You have reached the message limit for this chat. The demo form is right there if you want to keep going.',
      'SESSION_TURN_LIMIT',
    );
  }
  session.turns += 1;
  session.lastSeenAt = Date.now();
}

/**
 * Claims one proactive message slot for a trigger. At most
 * MAX_PROACTIVE_PER_SESSION per session and at most one per trigger type.
 * Enforced here, in code, never left to the model.
 */
export function claimProactive(session: PublicSession, trigger: string): boolean {
  if (session.proactiveTotal >= MAX_PROACTIVE_PER_SESSION) return false;
  if ((session.proactiveByTrigger.get(trigger) ?? 0) >= 1) return false;
  session.proactiveTotal += 1;
  session.proactiveByTrigger.set(trigger, (session.proactiveByTrigger.get(trigger) ?? 0) + 1);
  session.lastSeenAt = Date.now();
  return true;
}

/** Test-only: clears every in-memory session and armor counter. */
export function __resetPublicAgentStateForTests(): void {
  sessions.clear();
  sessionsStartedByDay.clear();
  sessionsStartedByIpDay.clear();
  fallbackKeyWarned = false;
}

/* ------------------------------ leak math ------------------------------ */

export interface LeakQuote {
  patientsPerDay: number;
  averageVisitValue: number;
  missedCallSharePercent: number;
  missedCallsPerDay: number;
  missedCallsPerMonth: number;
  monthlyLoss: number;
  yearlyLoss: number;
}

class ToolError extends Error {}

/**
 * Pure missed-call math. The visitor states the inputs; this function is
 * the only source of the figures Lyla quotes. A month counts 30 days.
 */
export function computeLeakQuote(input: {
  patientsPerDay: unknown;
  averageVisitValue: unknown;
  missedCallSharePercent: unknown;
}): LeakQuote {
  const patientsPerDay = Number(input.patientsPerDay);
  const averageVisitValue = Number(input.averageVisitValue);
  const missedCallSharePercent = Number(input.missedCallSharePercent);
  if (!Number.isFinite(patientsPerDay) || patientsPerDay < 1 || patientsPerDay > 1000) {
    throw new ToolError('patientsPerDay must be a number between 1 and 1000.');
  }
  if (!Number.isFinite(averageVisitValue) || averageVisitValue < 1 || averageVisitValue > 100000) {
    throw new ToolError('averageVisitValue must be a number between 1 and 100000.');
  }
  if (!Number.isFinite(missedCallSharePercent) || missedCallSharePercent < 0 || missedCallSharePercent > 100) {
    throw new ToolError('missedCallSharePercent must be a number between 0 and 100.');
  }
  const missedCallsPerDay = (patientsPerDay * missedCallSharePercent) / 100;
  const missedCallsPerMonthRaw = missedCallsPerDay * 30;
  const monthlyLoss = Math.round(missedCallsPerMonthRaw * averageVisitValue);
  return {
    patientsPerDay,
    averageVisitValue,
    missedCallSharePercent,
    missedCallsPerDay: Math.round(missedCallsPerDay * 10) / 10,
    missedCallsPerMonth: Math.round(missedCallsPerMonthRaw),
    monthlyLoss,
    yearlyLoss: monthlyLoss * 12,
  };
}

/* ---------------------------- page actions ----------------------------- */
/**
 * Actions the widget executes on the page after Lyla's reply renders.
 * The model proposes them through function calls; every payload is
 * validated here, server-side, and anything unknown or malformed is
 * dropped, never forwarded.
 */
/** The demo form's own industry values (DemoIndustry in the web app):
 *  prefill may only ever set one of these, matched exactly. */
export type PublicBusinessKind = 'clinic' | 'contractor' | 'other';

export type PublicPageAction =
  | { type: 'guide_to_section'; section: 'demo' | 'how' | 'pricing' | 'faq' | 'book' }
  | { type: 'highlight_plan'; plan: 'starter' | 'core' }
  | {
      type: 'prefill_demo';
      fields: { name?: string; email?: string; phone?: string; website?: string; businessKind?: PublicBusinessKind };
    }
  | { type: 'start_demo' }
  | { type: 'open_signup'; plan: 'starter' | 'core' };

const GUIDE_SECTIONS = new Set(['demo', 'how', 'pricing', 'faq', 'book']);
const PLAN_KEYS = new Set(['starter', 'core']);
const BUSINESS_KINDS = new Set(['clinic', 'contractor', 'other']);
const CLIENT_ACTION_NAMES = new Set(['guide_to_section', 'highlight_plan', 'prefill_demo', 'start_demo', 'open_signup']);

function cleanField(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

/** Validates one model-proposed page action; returns null to drop it. */
export function validatePageAction(name: string, args: Record<string, unknown>): PublicPageAction | null {
  switch (name) {
    case 'guide_to_section': {
      const section = typeof args.section === 'string' ? args.section : '';
      return GUIDE_SECTIONS.has(section)
        ? { type: 'guide_to_section', section: section as 'demo' | 'how' | 'pricing' | 'faq' | 'book' }
        : null;
    }
    case 'highlight_plan': {
      const plan = typeof args.plan === 'string' ? args.plan : '';
      return PLAN_KEYS.has(plan) ? { type: 'highlight_plan', plan: plan as 'starter' | 'core' } : null;
    }
    case 'open_signup': {
      const plan = typeof args.plan === 'string' ? args.plan : '';
      return PLAN_KEYS.has(plan) ? { type: 'open_signup', plan: plan as 'starter' | 'core' } : null;
    }
    case 'prefill_demo': {
      const fields: {
        name?: string;
        email?: string;
        phone?: string;
        website?: string;
        businessKind?: PublicBusinessKind;
      } = {};
      const name = cleanField(args.name, 120);
      const email = cleanField(args.email, 254);
      const phone = cleanField(args.phone, 40);
      const website = cleanField(args.website, 300);
      if (name) fields.name = name;
      if (email) fields.email = email;
      if (phone) fields.phone = phone;
      if (website) fields.website = website;
      // The business kind is an enum, not free text: only the form's own
      // values pass; anything else is dropped, the field, not the action.
      if (typeof args.businessKind === 'string' && BUSINESS_KINDS.has(args.businessKind)) {
        fields.businessKind = args.businessKind as PublicBusinessKind;
      }
      return Object.keys(fields).length > 0 ? { type: 'prefill_demo', fields } : null;
    }
    case 'start_demo':
      return { type: 'start_demo' };
    default:
      return null;
  }
}

/* --------------------------- Gemini client ----------------------------- */
/* Mirrors the support agent's client discipline exactly: same model,
 * bounded retries (429/503 only, at most 3 attempts, shared 45-second
 * deadline, 30-second per-attempt cap), retries only before a stream
 * opens, and honest errors. Only the log prefix and the human wording of
 * the errors are Lyla's. */

const GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_STREAM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;
const MODEL_TIMEOUT_MS = 30_000;
const MODEL_DEADLINE_MS = 45_000;
const MODEL_MAX_ATTEMPTS = 3;
const MODEL_RETRYABLE_STATUSES = new Set([429, 503]);
const MODEL_RETRY_BACKOFF_MS = [500, 1500];
const MAX_MODEL_TURNS = 10;

const MODEL_ERROR_MESSAGE = 'Lyla had trouble answering just now. Please try again.';

type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: unknown } };
};
type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

let fallbackKeyWarned = false;

/**
 * Lyla's key: her own LYLA_GEMINI_API_KEY when the founder has set it.
 * Until then she falls back to the shared GEMINI_API_KEY and says so once
 * in the logs. The endpoint, prompt, registry, and data separation ships
 * regardless; only the quota pool is shared during the fallback.
 */
export function resolvePublicAgentKey(): string | undefined {
  const dedicated = (env.LYLA_GEMINI_API_KEY ?? '').trim();
  if (dedicated) return dedicated;
  const shared = (env.GEMINI_API_KEY ?? '').trim();
  if (shared) {
    if (!fallbackKeyWarned) {
      fallbackKeyWarned = true;
      console.warn(
        '[public-agent] LYLA_GEMINI_API_KEY is not set; Lyla is using the shared GEMINI_API_KEY until her own key is provisioned.',
      );
    }
    return shared;
  }
  return undefined;
}

function modelRetryDelay(attempt: number): number {
  return MODEL_RETRY_BACKOFF_MS[Math.min(attempt, MODEL_RETRY_BACKOFF_MS.length - 1)] ?? 500;
}

async function waitForModelRetry(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/* --------------------------- tool declarations ------------------------- */

const TOOL_DECLARATIONS = [
  {
    name: 'get_visitor_context',
    description:
      "Get the visitor's resolved context: country, the currency to quote prices in, and which demo path they get (web demo in the browser for Canada, phone demo otherwise). Call once at the start if you do not already know it.",
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'read_clinic_site',
    description:
      "Read the clinic website the visitor gives you, the same reader the personalized demo uses. Returns the clinic facts found there (name, phone, address, hours, services). Never guess facts the reader did not return.",
    parameters: {
      type: 'OBJECT',
      properties: {
        website: { type: 'STRING', description: 'The clinic website URL the visitor provided.' },
      },
      required: ['website'],
    },
  },
  {
    name: 'compute_leak',
    description:
      'Compute what missed calls cost the visitor, from numbers THEY state: patients seen per day, the average value of one visit, and the share of calls that go unanswered (percent). Quote only the figures this returns.',
    parameters: {
      type: 'OBJECT',
      properties: {
        patientsPerDay: { type: 'NUMBER', description: 'Patients the clinic sees per day.' },
        averageVisitValue: { type: 'NUMBER', description: 'Average value of one patient visit, in dollars.' },
        missedCallSharePercent: { type: 'NUMBER', description: 'Share of incoming calls that go unanswered, 0 to 100.' },
      },
      required: ['patientsPerDay', 'averageVisitValue', 'missedCallSharePercent'],
    },
  },
  {
    name: 'capture_lead',
    description:
      "Save the visitor's details as a demo lead so the demo link and follow-up can reach them. This is the only save you can make. Call it only with details the visitor actually gave you in this conversation.",
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: "The visitor's name." },
        email: { type: 'STRING', description: "The visitor's email address." },
        website: { type: 'STRING', description: 'Their clinic website, if they gave one.' },
      },
      required: ['name', 'email'],
    },
  },
  {
    name: 'guide_to_section',
    description:
      'Move the page to a section while you explain it: demo (the demo form), how (how it works), pricing, faq, book (white glove booking).',
    parameters: {
      type: 'OBJECT',
      properties: {
        section: { type: 'STRING', enum: ['demo', 'how', 'pricing', 'faq', 'book'] },
      },
      required: ['section'],
    },
  },
  {
    name: 'highlight_plan',
    description: 'Scroll to pricing and highlight one plan card: starter or core.',
    parameters: {
      type: 'OBJECT',
      properties: { plan: { type: 'STRING', enum: ['starter', 'core'] } },
      required: ['plan'],
    },
  },
  {
    name: 'prefill_demo',
    description:
      'Type details the visitor gave you into the hero demo form for them. Only include fields they actually gave you.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        email: { type: 'STRING' },
        phone: { type: 'STRING' },
        website: { type: 'STRING' },
        businessKind: {
          type: 'STRING',
          enum: ['clinic', 'contractor', 'other'],
          description:
            "The kind of business, in the demo form's own values: clinic for a clinic or practice, contractor for trades or home services, other for anything else.",
        },
      },
    },
  },
  {
    name: 'start_demo',
    description:
      'Submit the demo form, exactly as if the visitor pressed its button themselves. Only call this when you hold all five demo details (see THE DEMO FLOW). The submit lands on a facts-check step; it never starts the call by itself, and you will not know the outcome unless a page report in your context says so.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'open_signup',
    description: 'Open the signup page with a plan preselected: starter or core.',
    parameters: {
      type: 'OBJECT',
      properties: { plan: { type: 'STRING', enum: ['starter', 'core'] } },
      required: ['plan'],
    },
  },
];

/** The complete list of function names in Lyla's registry. Test-pinned:
 *  isolation means this list never grows a tenant-scoped tool. */
export const PUBLIC_TOOL_NAMES: string[] = TOOL_DECLARATIONS.map((t) => t.name);

const TOOL_STATUS_LABELS: Record<string, string> = {
  get_visitor_context: 'Checking where you are visiting from',
  read_clinic_site: 'Reading your clinic website',
  compute_leak: 'Running the numbers',
  capture_lead: 'Saving your details',
};

function toolStatusLabel(name: string): string {
  return TOOL_STATUS_LABELS[name] ?? 'Working on that';
}

/* ------------------------------ model calls ---------------------------- */

async function callGemini(params: {
  apiKey: string;
  systemText: string;
  contents: GeminiContent[];
  withTools?: boolean;
}): Promise<GeminiPart[]> {
  const deadline = Date.now() + MODEL_DEADLINE_MS;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: params.systemText }] },
    contents: params.contents,
    ...(params.withTools === false
      ? {}
      : {
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        }),
    generationConfig: { temperature: 0.3 },
  });

  for (let attempt = 0; attempt < MODEL_MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(MODEL_TIMEOUT_MS, remainingMs));
    try {
      const res = await fetch(GEMINI_GENERATE_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': params.apiKey },
        body,
      });
      if (!res.ok) {
        const responseBody = await res.text().catch(() => '');
        console.warn(
          `[public-agent] Gemini request failed, status ${res.status} (attempt ${attempt + 1}): ${responseBody.slice(0, 200)}`,
        );
        const canRetry = MODEL_RETRYABLE_STATUSES.has(res.status) && attempt + 1 < MODEL_MAX_ATTEMPTS;
        if (canRetry) {
          const delay = modelRetryDelay(attempt);
          if (Date.now() + delay < deadline) {
            await waitForModelRetry(delay);
            continue;
          }
        }
        throw new HttpError(502, MODEL_ERROR_MESSAGE, 'MODEL_ERROR');
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
      };
      const parts = data.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) {
        console.warn('[public-agent] Gemini response had no content parts.');
        throw new HttpError(502, MODEL_ERROR_MESSAGE, 'MODEL_ERROR');
      }
      return parts;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      console.warn(
        `[public-agent] Gemini request error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
      throw new HttpError(502, MODEL_ERROR_MESSAGE, 'MODEL_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }

  throw new HttpError(502, MODEL_ERROR_MESSAGE, 'MODEL_ERROR');
}

/* ------------------------- streamed model call ------------------------- */

export interface PublicChatStreamSink {
  status: (label: string) => void;
  delta: (text: string) => void;
}

/** Streaming was refused before anything reached the visitor; the plain
 *  call may still answer. Mirrors the support agent's contract. */
class StreamUnavailableError extends Error {}

async function consumeGeminiStream(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
  onEvent?: () => void,
): Promise<{ parts: GeminiPart[]; events: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let events = 0;
  let sawFunctionCall = false;
  const functionParts: GeminiPart[] = [];
  const textPieces: string[] = [];

  const handleBlock = (block: string) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const parsed = JSON.parse(data) as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    };
    events += 1;
    onEvent?.();
    const parts = parsed.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (part.functionCall) {
        sawFunctionCall = true;
        functionParts.push(part);
      } else if (typeof part.text === 'string' && part.text) {
        textPieces.push(part.text);
        if (!sawFunctionCall) onText(part.text);
      }
    }
  };

  const drainBuffer = (flush: boolean) => {
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) handleBlock(block);
    if (flush && buffer.trim()) {
      handleBlock(buffer);
      buffer = '';
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) break;
      drainBuffer(false);
    }
    buffer += decoder.decode();
    drainBuffer(true);
  } finally {
    reader.releaseLock();
  }

  const parts: GeminiPart[] = [];
  const fullText = textPieces.join('');
  if (fullText) parts.push({ text: fullText });
  parts.push(...functionParts);
  return { parts, events };
}

async function callGeminiStreamed(
  params: { apiKey: string; systemText: string; contents: GeminiContent[] },
  sink: PublicChatStreamSink,
): Promise<GeminiPart[]> {
  const deadline = Date.now() + MODEL_DEADLINE_MS;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: params.systemText }] },
    contents: params.contents,
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: { temperature: 0.3 },
  });

  for (let attempt = 0; attempt < MODEL_MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(MODEL_TIMEOUT_MS, remainingMs));
    const progress = { events: 0, deltas: 0 };
    try {
      const res = await fetch(GEMINI_STREAM_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': params.apiKey },
        body,
      });
      if (!res.ok) {
        const responseBody = await res.text().catch(() => '');
        console.warn(
          `[public-agent] Gemini stream request failed, status ${res.status} (attempt ${attempt + 1}): ${responseBody.slice(0, 200)}`,
        );
        const canRetry = MODEL_RETRYABLE_STATUSES.has(res.status) && attempt + 1 < MODEL_MAX_ATTEMPTS;
        if (canRetry) {
          const delay = modelRetryDelay(attempt);
          if (Date.now() + delay < deadline) {
            await waitForModelRetry(delay);
            continue;
          }
          throw new HttpError(502, MODEL_ERROR_MESSAGE, 'MODEL_ERROR');
        }
        throw new StreamUnavailableError(`Gemini streaming refused with status ${res.status}.`);
      }
      if (!res.body) {
        throw new StreamUnavailableError('Gemini streaming response had no body.');
      }
      const { parts, events } = await consumeGeminiStream(
        res.body,
        (text) => {
          progress.deltas += 1;
          sink.delta(text);
        },
        () => {
          progress.events += 1;
        },
      );
      if (events === 0) {
        throw new StreamUnavailableError('Gemini streaming response carried no events.');
      }
      return parts;
    } catch (err) {
      if (err instanceof StreamUnavailableError || err instanceof HttpError) throw err;
      console.warn(
        `[public-agent] Gemini stream error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
      if (progress.events > 0 || progress.deltas > 0) {
        throw new HttpError(502, MODEL_ERROR_MESSAGE, 'MODEL_ERROR');
      }
      throw new StreamUnavailableError('Gemini stream failed before the first event.');
    } finally {
      clearTimeout(timer);
    }
  }

  throw new HttpError(502, MODEL_ERROR_MESSAGE, 'MODEL_ERROR');
}

async function callModelTurn(
  params: { apiKey: string; systemText: string; contents: GeminiContent[] },
  sink: PublicChatStreamSink | null,
): Promise<GeminiPart[]> {
  if (!sink) return callGemini(params);
  try {
    return await callGeminiStreamed(params, sink);
  } catch (err) {
    if (err instanceof StreamUnavailableError) {
      console.warn('[public-agent] Gemini streaming unavailable for this turn; using the plain call.');
      return callGemini(params);
    }
    throw err;
  }
}

/* ----------------------------- system text ----------------------------- */

function buildPublicSystemText(params: {
  session: PublicSession;
  ctx: PublicChatTurnContext;
}): string {
  const { visitor } = params.session;
  const lines: string[] = [
    `You are ${PUBLIC_AGENT.name}, ${PUBLIC_AGENT.title} at VoiceFront. ${PUBLIC_AGENT.identityLine}`,
    '',
    JOB_BLOCK,
    '',
    IDENTITY_BLOCK,
    '',
    TRUTH_BLOCK,
    '',
    PAGE_ACTION_TRUTH_BLOCK,
    '',
    demoFlowBlock(visitor.demoPath),
    '',
    'YOUR NOTES (the only product facts you may state)',
    PUBLIC_KNOWLEDGE_BLOCK,
    '',
    'VISITOR CONTEXT (background, resolved by the page, not by the visitor)',
    `- Country: ${visitor.country ?? 'unknown'}. Quote prices in ${visitor.currency}.`,
    visitor.demoPath === 'web'
      ? '- Demo path for this visitor: the demo runs in their browser.'
      : '- Demo path for this visitor: the demo calls their phone.',
  ];
  if (params.ctx.referrer) lines.push(`- They arrived from: ${params.ctx.referrer}`);
  if (params.ctx.localTime) lines.push(`- Their local time: ${params.ctx.localTime}`);
  const state = params.ctx.visitorState;
  if (state) {
    const observed: string[] = [];
    if (state.section) observed.push(`currently reading the "${state.section}" section`);
    if (typeof state.dwellSeconds === 'number') observed.push(`about ${Math.round(state.dwellSeconds)} seconds on this section`);
    if (state.sectionsVisited && state.sectionsVisited.length > 0) {
      observed.push(`sections visited so far: ${state.sectionsVisited.join(', ')}`);
    }
    if (state.formState) observed.push(`demo form state: ${state.formState}`);
    if (observed.length > 0) lines.push(`- Page observation: ${observed.join('; ')}.`);
  }
  if (params.ctx.pageReport) {
    const reportLine = renderPageReportLine(params.ctx.pageReport);
    if (reportLine) lines.push(`- ${reportLine}`);
  }
  return lines.join('\n');
}

/* ------------------------------ tool runner ---------------------------- */

interface PublicToolContext {
  session: PublicSession;
  ctx: PublicChatTurnContext;
}

async function toolReadClinicSite(args: Record<string, unknown>): Promise<{ result: unknown }> {
  const website = typeof args.website === 'string' ? args.website.trim() : '';
  if (!website || website.length > 2048) {
    throw new ToolError('A website address is needed before I can read it.');
  }
  const facts: ClinicFacts | null = await fetchClinicFacts(website);
  if (!facts) {
    return {
      result: {
        status: 'unreadable',
        note: 'That site could not be read just now. Do not guess its facts; the demo reads it again when it starts.',
      },
    };
  }
  return { result: { status: 'ok', facts } };
}

async function toolCaptureLead(
  toolCtx: PublicToolContext,
  args: Record<string, unknown>,
): Promise<{ result: unknown }> {
  const name = typeof args.name === 'string' ? args.name.trim().slice(0, 120) : '';
  const email = typeof args.email === 'string' ? args.email.trim().slice(0, 254) : '';
  const website = typeof args.website === 'string' ? args.website.trim().slice(0, 300) : '';
  if (!name) throw new ToolError('A name is needed to save the lead.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ToolError('That email does not look right; ask the visitor to confirm it.');
  }
  if (toolCtx.session.leadCaptured) {
    return { result: { status: 'already_saved', note: 'This visitor already has a saved lead in this chat.' } };
  }
  // The ONLY write in Lyla's world: one demo lead row in the existing lead
  // store. DemoLead has no source column, so her provenance is the session
  // id itself: every lead she writes carries a `lyla_` session id, which
  // the founder can filter on. The demo form's phone field is required by
  // that store; a chat lead the visitor gave no phone for is saved with an
  // empty phone and mode 'pending', exactly like a form lead that has not
  // picked a demo mode yet.
  await createDemoLead({
    sessionId: `lyla_${randomUUID()}`,
    name,
    email,
    phone: '',
    ipCountry: toolCtx.session.visitor.country,
    phoneCountry: null,
    websiteUrl: website || null,
    mode: 'pending',
  });
  toolCtx.session.leadCaptured = true;
  return {
    result: {
      status: 'saved',
      note: 'The lead is saved. The demo link and follow-up go to the email the visitor gave.',
    },
  };
}

async function runTool(
  toolCtx: PublicToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; action?: PublicPageAction }> {
  if (CLIENT_ACTION_NAMES.has(name)) {
    const action = validatePageAction(name, args);
    if (!action) throw new ToolError('That page action is not available.');
    // Honest wording on purpose: the action is only SENT to the page here.
    // Its outcome is unknown until a page report arrives in a later turn,
    // so the model is never told "done" for something it cannot see.
    return {
      result: {
        status: 'requested',
        note: 'Sent to the page. You do not know the outcome; only a page report in your context says what the page did.',
      },
      action,
    };
  }
  switch (name) {
    case 'get_visitor_context':
      return { result: { status: 'ok', ...toolCtx.session.visitor } };
    case 'read_clinic_site':
      return toolReadClinicSite(args);
    case 'compute_leak':
      return {
        result: {
          status: 'ok',
          currency: toolCtx.session.visitor.currency,
          ...computeLeakQuote({
            patientsPerDay: args.patientsPerDay,
            averageVisitValue: args.averageVisitValue,
            missedCallSharePercent: args.missedCallSharePercent,
          }),
        },
      };
    case 'capture_lead':
      return toolCaptureLead(toolCtx, args);
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

/* ------------------------------- chat ---------------------------------- */

export interface PublicChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface PublicChatResult {
  reply: string;
  actions: PublicPageAction[];
  sessionId: string;
  turnsUsed: number;
  turnsLeft: number;
}

export async function runPublicChat(params: {
  session: PublicSession;
  messages: PublicChatMessage[];
  ctx: PublicChatTurnContext;
}): Promise<PublicChatResult> {
  return executePublicChat(params, null);
}

export async function runPublicChatStream(
  params: { session: PublicSession; messages: PublicChatMessage[]; ctx: PublicChatTurnContext },
  sink: PublicChatStreamSink,
): Promise<PublicChatResult> {
  return executePublicChat(params, sink);
}

async function executePublicChat(
  params: { session: PublicSession; messages: PublicChatMessage[]; ctx: PublicChatTurnContext },
  sink: PublicChatStreamSink | null,
): Promise<PublicChatResult> {
  const apiKey = resolvePublicAgentKey();
  if (!apiKey) {
    console.warn('[public-agent] No Gemini key is configured; public chat is unavailable.');
    throw new HttpError(503, 'Chat is unavailable right now.', 'PUBLIC_AGENT_NOT_CONFIGURED');
  }

  const systemText = buildPublicSystemText({ session: params.session, ctx: params.ctx });
  const contents: GeminiContent[] = params.messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text }],
  }));
  const toolCtx: PublicToolContext = { session: params.session, ctx: params.ctx };
  const actions: PublicPageAction[] = [];

  for (let turn = 0; turn < MAX_MODEL_TURNS; turn += 1) {
    const parts = await callModelTurn({ apiKey, systemText, contents }, sink);
    const calls = parts.filter((p) => p.functionCall);
    if (calls.length === 0) {
      const text = parts
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('')
        .trim();
      return {
        reply: text || 'Sorry, I did not catch that. Could you say it another way?',
        actions,
        sessionId: params.session.id,
        turnsUsed: params.session.turns,
        turnsLeft: Math.max(0, MAX_TURNS_PER_SESSION - params.session.turns),
      };
    }

    contents.push({ role: 'model', parts });
    const responses: GeminiPart[] = [];
    for (const call of calls) {
      const name = call.functionCall?.name ?? '';
      const args = call.functionCall?.args ?? {};
      if (!CLIENT_ACTION_NAMES.has(name)) sink?.status(toolStatusLabel(name));
      try {
        const { result, action } = await runTool(toolCtx, name, args);
        if (action) actions.push(action);
        responses.push({ functionResponse: { name, response: { result } } });
      } catch (err) {
        if (err instanceof ToolError) {
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

  throw new HttpError(502, 'Lyla took too long over that. Please try again.', 'MODEL_LOOP');
}

/* ----------------------------- proactive ------------------------------- */

export type ProactiveTrigger = 'pricing_dwell' | 'form_stall' | 'exit_intent';

export const PROACTIVE_TRIGGERS: ProactiveTrigger[] = ['pricing_dwell', 'form_stall', 'exit_intent'];

/** Her canned line per trigger, used when the model call fails. */
export const PROACTIVE_FALLBACK_LINES: Record<ProactiveTrigger, string> = {
  pricing_dwell:
    'Want a hand picking between the two plans? Tell me when your calls go unanswered and I will point you at the right one.',
  form_stall: 'Want me to finish that with you here? Give me the details and I will type them in.',
  exit_intent: 'Before you go, want the demo link by email so you can hear her on your own time?',
};

const PROACTIVE_GUIDANCE: Record<ProactiveTrigger, string> = {
  pricing_dwell:
    'The visitor has been reading the pricing section for a while. Offer, in one short friendly sentence, to help them pick between Starter After-Hours and Core 24/7 based on when their calls go unanswered.',
  form_stall:
    'The visitor started the demo form and stalled partway. Offer, in one short friendly sentence, to finish it with them right here in the chat.',
  exit_intent:
    'The visitor looks about to leave. In one short friendly sentence, offer to email them the demo link so they can hear the receptionist on their own time.',
};

/**
 * One proactive line for a behavior trigger. The per-session budget is
 * claimed in code before the model is called; when the budget is spent
 * this returns { line: null } and the widget stays quiet. When the model
 * call fails, her canned line for the trigger is used instead.
 */
export async function runPublicProactive(params: {
  session: PublicSession;
  trigger: ProactiveTrigger;
  ctx: PublicChatTurnContext;
}): Promise<{ line: string | null }> {
  if (!claimProactive(params.session, params.trigger)) return { line: null };
  const fallback = PROACTIVE_FALLBACK_LINES[params.trigger];
  const apiKey = resolvePublicAgentKey();
  if (!apiKey) return { line: fallback };
  try {
    const { visitor } = params.session;
    const systemText = [
      `You are ${PUBLIC_AGENT.name}, ${PUBLIC_AGENT.title} at VoiceFront. ${PUBLIC_AGENT.identityLine}`,
      'You are writing ONE short proactive message to a website visitor who has not opened the chat. One sentence, warm, no pressure, no hype. Never say you were watching them.',
      PROACTIVE_GUIDANCE[params.trigger],
      `Visitor context: country ${visitor.country ?? 'unknown'}, prices in ${visitor.currency}, demo path ${visitor.demoPath}.`,
      params.ctx.visitorState?.section
        ? `They are on the "${params.ctx.visitorState.section}" section of the page.`
        : '',
      params.ctx.pageReport ? (renderPageReportLine(params.ctx.pageReport) ?? '') : '',
    ]
      .filter(Boolean)
      .join('\n');
    const parts = await callGemini({
      apiKey,
      systemText,
      contents: [{ role: 'user', parts: [{ text: 'Write the message now.' }] }],
      withTools: false,
    });
    const text = parts
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('')
      .trim();
    return { line: text ? text.slice(0, 300) : fallback };
  } catch (err) {
    console.warn(
      `[public-agent] Proactive line fell back to the canned line: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { line: fallback };
  }
}
