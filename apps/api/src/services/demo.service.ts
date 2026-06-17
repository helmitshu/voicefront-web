import { randomUUID } from 'node:crypto';
import type { AgentSettings, Appointment, Tenant } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { industryDefaults } from '../domain/prompt-templates';
import { SALES_PERSONA } from '../domain/sales-agent';
import { defaultBusinessHours, parseBusinessHours, type BusinessHours } from '../domain/agent-config';
import { utcToZonedParts, zonedToUtc } from './appointment.service';

/**
 * Powers the public landing-page demo: a real voice call against a shared
 * "demo clinic" tenant, where each visitor gets an isolated, throwaway calendar
 * (keyed by demoSessionId) pre-seeded with a few booked slots so they can watch
 * the agent book, refuse to double-book, and respect business hours — live.
 *
 * Everything reuses the production booking service; only the data is ephemeral.
 */

export const DEMO_TENANT_SLUG = '__demo';

/**
 * Master on/off switch for the public landing-page demo. Stored as a plain
 * 'true'/'false' in a reserved PlatformSetting row (NOT one of the encrypted
 * typed config keys — it isn't a secret). Defaults ON when no row exists.
 */
const DEMO_ENABLED_KEY = 'DEMO_ENABLED';

export async function isDemoEnabled(): Promise<boolean> {
  const row = await prisma.platformSetting.findUnique({ where: { key: DEMO_ENABLED_KEY } });
  return row ? row.valueEnc === 'true' : true;
}

export async function setDemoEnabled(enabled: boolean, adminEmail: string): Promise<void> {
  const valueEnc = enabled ? 'true' : 'false';
  await prisma.platformSetting.upsert({
    where: { key: DEMO_ENABLED_KEY },
    create: { key: DEMO_ENABLED_KEY, valueEnc, updatedBy: adminEmail },
    update: { valueEnc, updatedBy: adminEmail },
  });
}

/**
 * Founder-editable sales-agent identity for the demo (plain text in reserved
 * PlatformSetting rows, same non-secret pattern as DEMO_ENABLED). The admin UI
 * (founder portal) writes these; defaults keep the demo working out of the box.
 */
const SALES_AGENT_NAME_KEY = 'DEMO_SALES_AGENT_NAME';
const SALES_FOUNDER_NAME_KEY = 'DEMO_FOUNDER_NAME';
const SHOW_CALENDAR_KEY = 'DEMO_SHOW_CALENDAR';

export interface SalesConfig {
  agentName: string;
  founderName: string;
  /** Whether the prospect sees the live sample calendar during the demo. */
  showCalendar: boolean;
}

export async function getSalesConfig(): Promise<SalesConfig> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: [SALES_AGENT_NAME_KEY, SALES_FOUNDER_NAME_KEY, SHOW_CALENDAR_KEY] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.valueEnc]));
  return {
    agentName: map.get(SALES_AGENT_NAME_KEY)?.trim() || SALES_PERSONA.name,
    founderName: map.get(SALES_FOUNDER_NAME_KEY)?.trim() || 'our founder',
    // Defaults ON when no row exists.
    showCalendar: map.has(SHOW_CALENDAR_KEY) ? map.get(SHOW_CALENDAR_KEY) === 'true' : true,
  };
}

export async function setSalesConfig(input: Partial<SalesConfig>, adminEmail: string): Promise<void> {
  const writes: Array<Promise<unknown>> = [];
  const upsert = (key: string, valueEnc: string) =>
    prisma.platformSetting.upsert({
      where: { key },
      create: { key, valueEnc, updatedBy: adminEmail },
      update: { valueEnc, updatedBy: adminEmail },
    });
  if (typeof input.agentName === 'string') writes.push(upsert(SALES_AGENT_NAME_KEY, input.agentName.trim()));
  if (typeof input.founderName === 'string') writes.push(upsert(SALES_FOUNDER_NAME_KEY, input.founderName.trim()));
  if (typeof input.showCalendar === 'boolean')
    writes.push(upsert(SHOW_CALENDAR_KEY, input.showCalendar ? 'true' : 'false'));
  await Promise.all(writes);
}
/**
 * Caller-ID numbers for outbound demo calls, chosen by the founder from their
 * Vapi account. Stored as JSON {id, number} in reserved (non-secret)
 * PlatformSetting rows. US prospects are called from the US number, Canadian
 * prospects from the CA number; with only one configured, it's the fallback for
 * everyone allowed a call.
 */
const DEMO_NUMBER_US_KEY = 'DEMO_NUMBER_US';
const DEMO_NUMBER_CA_KEY = 'DEMO_NUMBER_CA';

export interface DemoNumber {
  id: string;
  number: string;
}
export interface DemoNumbers {
  us: DemoNumber | null;
  ca: DemoNumber | null;
}

function parseNumber(raw: string | undefined): DemoNumber | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DemoNumber>;
    if (parsed && typeof parsed.id === 'string' && typeof parsed.number === 'string') {
      return { id: parsed.id, number: parsed.number };
    }
  } catch {
    /* ignore malformed */
  }
  return null;
}

export async function getDemoNumbers(): Promise<DemoNumbers> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: [DEMO_NUMBER_US_KEY, DEMO_NUMBER_CA_KEY] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.valueEnc]));
  return {
    us: parseNumber(map.get(DEMO_NUMBER_US_KEY)),
    ca: parseNumber(map.get(DEMO_NUMBER_CA_KEY)),
  };
}

export async function setDemoNumbers(input: Partial<DemoNumbers>, adminEmail: string): Promise<DemoNumbers> {
  const writes: Array<Promise<unknown>> = [];
  const write = (key: string, value: DemoNumber | null) =>
    prisma.platformSetting.upsert({
      where: { key },
      create: { key, valueEnc: value ? JSON.stringify(value) : '', updatedBy: adminEmail },
      update: { valueEnc: value ? JSON.stringify(value) : '', updatedBy: adminEmail },
    });
  if (input.us !== undefined) writes.push(write(DEMO_NUMBER_US_KEY, input.us));
  if (input.ca !== undefined) writes.push(write(DEMO_NUMBER_CA_KEY, input.ca));
  await Promise.all(writes);
  return getDemoNumbers();
}

/**
 * Picks the caller-ID for an outbound demo call. Canadian prospects get the CA
 * number when configured; everyone else (and Canadians without a CA number yet)
 * fall back to the US number. Returns null when no number is configured at all.
 */
export function pickDemoCallerId(numbers: DemoNumbers, ipCountry: string | null): DemoNumber | null {
  if (ipCountry === 'CA' && numbers.ca) return numbers.ca;
  return numbers.us ?? numbers.ca ?? null;
}

const DEMO_COMPANY = 'Bayview Family Clinic';
const DEMO_TZ = 'America/Vancouver';
const SLOT_MINUTES = 30;
/** Visitor calendars are garbage-collected after this idle window. */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/* --------------------------- agent-driven screen -------------------------- */
// Ava drives the prospect's on-screen panel via the set_demo_screen tool. The
// web client reacts to that tool-call event instantly, but we also stash the
// latest screen here (keyed by session) so the calendar poll can reconcile it —
// a belt-and-suspenders fallback if the client missed the live event. In-memory
// is fine: demo sessions are short-lived and a restart just resets to 'intro'.
const VALID_SCREENS = new Set(['intro', 'booking', 'doublebook', 'summary', 'close']);
const screenBySession = new Map<string, { screen: string; ts: number }>();

/** Records the screen Ava switched a session to (ignores unknown values). */
export function setDemoScreen(sessionId: string, screen: string): boolean {
  if (!VALID_SCREENS.has(screen)) return false;
  screenBySession.set(sessionId, { screen, ts: Date.now() });
  // Opportunistic GC so the map can't grow without bound.
  if (screenBySession.size > 500) {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, v] of screenBySession) if (v.ts < cutoff) screenBySession.delete(id);
  }
  return true;
}

/** The screen a session is currently on, or null if Ava hasn't set one yet. */
export function getDemoScreen(sessionId: string): string | null {
  return screenBySession.get(sessionId)?.screen ?? null;
}

/** Clears a session's screen back to the start (on (re)seed). */
export function clearDemoScreen(sessionId: string): void {
  screenBySession.delete(sessionId);
}

/** A live, call-specific recap Ava pushes to the on-screen summary panel. */
export interface DemoCallSummary {
  headline: string;
  recap: string;
}
const summaryBySession = new Map<string, { summary: DemoCallSummary; ts: number }>();

/** Records the recap Ava wrote for this call (trimmed; ignores empties). */
export function setDemoSummary(sessionId: string, headline: string, recap: string): boolean {
  const h = headline.trim();
  const r = recap.trim();
  if (!h && !r) return false;
  summaryBySession.set(sessionId, { summary: { headline: h, recap: r }, ts: Date.now() });
  if (summaryBySession.size > 500) {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, v] of summaryBySession) if (v.ts < cutoff) summaryBySession.delete(id);
  }
  return true;
}

/** The recap for a session, or null if Ava hasn't pushed one yet. */
export function getDemoSummary(sessionId: string): DemoCallSummary | null {
  return summaryBySession.get(sessionId)?.summary ?? null;
}

/** Clears a session's on-screen recap (on (re)seed / new call). */
export function clearDemoSummary(sessionId: string): void {
  summaryBySession.delete(sessionId);
}

/**
 * The demo runs against a single shared tenant, but each visitor's sample
 * calendar is dressed to match THEIR industry — so a contractor sees a
 * builder's schedule with site estimates, not a dental clinic. This removed
 * the #1 reason prospects bailed mid-demo ("why are you showing me a clinic?").
 */
export type DemoIndustry = 'clinic' | 'contractor' | 'other';

export interface DemoSample {
  /** Name shown atop the sample calendar (e.g. "Summit Build & Remodel"). */
  company: string;
  /** What the on-screen sample IS, in Ava's words ("a dental clinic"). */
  sampleLabel: string;
  /** How Ava refers to the PROSPECT's own business ("your clinic"). */
  prospectLabel: string;
  /** The booking noun Ava uses when she books on screen ("site estimate"). */
  appointmentNoun: string;
  /** Pre-booked slots (tenant-local HH:MM) so the demo day looks real. */
  seeds: Array<{ time: string; name: string }>;
}

const DEMO_SAMPLES: Record<DemoIndustry, DemoSample> = {
  clinic: {
    company: 'Bayview Family Clinic',
    sampleLabel: 'a dental clinic',
    prospectLabel: 'clinic',
    appointmentNoun: 'appointment',
    seeds: [
      { time: '09:00', name: 'Team huddle' },
      { time: '10:30', name: 'M. Alvarez — cleaning' },
      { time: '13:30', name: 'D. Okafor — consult' },
    ],
  },
  contractor: {
    company: 'Summit Build & Remodel',
    sampleLabel: "a contractor's schedule",
    prospectLabel: 'business',
    appointmentNoun: 'site estimate',
    seeds: [
      { time: '09:00', name: 'Crew dispatch' },
      { time: '10:30', name: 'R. Singh — site estimate' },
      { time: '13:30', name: 'Oak St — kitchen walkthrough' },
    ],
  },
  other: {
    company: 'Riverside Studio',
    sampleLabel: 'a local business',
    prospectLabel: 'business',
    appointmentNoun: 'appointment',
    seeds: [
      { time: '09:00', name: 'Morning prep' },
      { time: '10:30', name: 'J. Carter — consult' },
      { time: '13:30', name: 'L. Gomez — appointment' },
    ],
  },
};

/** Coerces any stored/submitted industry string to a known sample preset. */
export function normalizeIndustry(raw?: string | null): DemoIndustry {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'clinic' || v === 'contractor') return v;
  return 'other';
}

export function demoSample(industry?: string | null): DemoSample {
  return DEMO_SAMPLES[normalizeIndustry(industry)];
}

export interface DemoAppointmentView {
  id: string;
  /** Tenant-local "HH:MM" start. */
  time: string;
  label: string;
  /** How it got there — drives styling on the landing page. */
  kind: 'seed' | 'blocked' | 'voice';
}

export interface DemoDay {
  /** YYYY-MM-DD in the demo timezone. */
  date: string;
  /** e.g. "Thursday, June 18". */
  dayLabel: string;
  timezone: string;
  /** The demo day's open window, for rendering the slot grid. */
  open: string;
  close: string;
  slotMinutes: number;
  /** Industry the sample calendar is dressed for ("clinic" | "contractor" | "other"). */
  industry: DemoIndustry;
  /** Name shown atop the sample calendar, matched to the prospect's industry. */
  sampleCompany: string;
}

export interface DemoTenantBundle {
  tenant: Tenant;
  settings: AgentSettings;
}

/** Lazily provisions the shared demo tenant + clinic settings on first use. */
export async function getOrCreateDemoTenant(): Promise<DemoTenantBundle> {
  const existing = await prisma.tenant.findUnique({
    where: { slug: DEMO_TENANT_SLUG },
    include: { agentSettings: true },
  });
  if (existing?.agentSettings) {
    return { tenant: existing, settings: existing.agentSettings };
  }

  const defaults = industryDefaults('CLINIC', { companyName: DEMO_COMPANY, personaName: 'Maya' });
  const created = await prisma.tenant.create({
    data: {
      companyName: DEMO_COMPANY,
      slug: DEMO_TENANT_SLUG,
      industry: 'CLINIC',
      agentSettings: {
        create: {
          displayName: 'Maya',
          systemPrompt: defaults.systemPrompt,
          firstMessage: defaults.firstMessage,
          voicemailGreeting: defaults.voicemailGreeting,
          businessHours: defaultBusinessHours() as unknown as object,
          timezone: DEMO_TZ,
          voiceProvider: 'vapi',
          voiceId: 'Emma',
        },
      },
    },
    include: { agentSettings: true },
  });
  return { tenant: created, settings: created.agentSettings! };
}

/** The next open business day strictly after now, in the demo timezone. */
function nextBusinessDay(
  hours: BusinessHours,
  timezone: string,
  industry: DemoIndustry,
  businessName: string | null,
  now = new Date(),
): DemoDay {
  // The prospect's own business name wins; otherwise a generic industry sample.
  const sampleCompany = businessName?.trim() || DEMO_SAMPLES[industry].company;
  for (let i = 1; i <= 8; i++) {
    const instant = new Date(now.getTime() + i * 24 * 3600 * 1000);
    const parts = utcToZonedParts(instant, timezone);
    const dayHours = hours[parts.day];
    if (!dayHours.enabled) continue;
    const dayLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(zonedToUtc(parts.date, '12:00', timezone));
    return {
      date: parts.date,
      dayLabel,
      timezone,
      open: dayHours.open,
      close: dayHours.close > dayHours.open ? dayHours.close : '17:00',
      slotMinutes: SLOT_MINUTES,
      industry,
      sampleCompany,
    };
  }
  // Defensive: a tenant with no open days — fall back to tomorrow 08:00–17:00.
  const fallback = utcToZonedParts(new Date(now.getTime() + 24 * 3600 * 1000), timezone);
  return {
    date: fallback.date,
    dayLabel: fallback.date,
    timezone,
    open: '08:00',
    close: '17:00',
    slotMinutes: SLOT_MINUTES,
    industry,
    sampleCompany,
  };
}

function mapAppointment(a: Pick<Appointment, 'id' | 'startsAt' | 'timezone' | 'customerName' | 'reason' | 'source'>): DemoAppointmentView {
  const local = utcToZonedParts(a.startsAt, a.timezone);
  const kind: DemoAppointmentView['kind'] =
    a.source === 'VOICE_AGENT' ? 'voice' : a.customerName.startsWith('Blocked') ? 'blocked' : 'seed';
  const label = a.reason ? `${a.customerName} — ${a.reason}` : a.customerName;
  return { id: a.id, time: local.time, label, kind };
}

async function seedSession(tenantId: string, sessionId: string, day: DemoDay, timezone: string): Promise<void> {
  await prisma.appointment.createMany({
    data: DEMO_SAMPLES[day.industry].seeds.map((s) => {
      const startsAt = zonedToUtc(day.date, s.time, timezone);
      return {
        tenantId,
        demoSessionId: sessionId,
        customerName: s.name,
        startsAt,
        endsAt: new Date(startsAt.getTime() + SLOT_MINUTES * 60_000),
        timezone,
        source: 'MANUAL' as const,
        status: 'CONFIRMED' as const,
      };
    }),
  });
}

export interface DemoSession {
  sessionId: string;
  bundle: DemoTenantBundle;
  day: DemoDay;
  appointments: DemoAppointmentView[];
}

/** Reads the industry + business name a session was started for, from its lead. */
async function sessionMeta(sessionId: string): Promise<{ industry: DemoIndustry; businessName: string | null }> {
  const lead = await prisma.demoLead.findFirst({
    where: { demoSessionId: sessionId },
    orderBy: { createdAt: 'desc' },
    select: { industry: true, businessName: true },
  });
  return { industry: normalizeIndustry(lead?.industry), businessName: lead?.businessName ?? null };
}

/** Starts a fresh isolated visitor session: GCs stale data, seeds the day. */
export async function startDemoSession(
  industry: DemoIndustry = 'other',
  businessName: string | null = null,
): Promise<DemoSession> {
  const bundle = await getOrCreateDemoTenant();
  // Lazy GC: clear out calendars from sessions that have gone cold.
  await prisma.appointment.deleteMany({
    where: { tenantId: bundle.tenant.id, createdAt: { lt: new Date(Date.now() - SESSION_TTL_MS) } },
  });

  const sessionId = `demo_${randomUUID()}`;
  const hours = parseBusinessHours(bundle.settings.businessHours);
  const day = nextBusinessDay(hours, bundle.settings.timezone, industry, businessName);
  await seedSession(bundle.tenant.id, sessionId, day, bundle.settings.timezone);

  return { sessionId, bundle, day, appointments: await getDemoAppointments(sessionId) };
}

/** Re-hydrates an existing visitor session (after lead capture) without
 *  re-seeding — returns the same deterministic day plus the live calendar.
 *  The industry + business name are recovered from the session's lead so the
 *  sample stays consistent across the lead → choose → call steps. */
export async function resumeDemoSession(sessionId: string): Promise<DemoSession> {
  const bundle = await getOrCreateDemoTenant();
  const hours = parseBusinessHours(bundle.settings.businessHours);
  const meta = await sessionMeta(sessionId);
  const day = nextBusinessDay(hours, bundle.settings.timezone, meta.industry, meta.businessName);
  return { sessionId, bundle, day, appointments: await getDemoAppointments(sessionId) };
}

export interface CreateLeadInput {
  sessionId: string;
  name: string;
  email: string;
  phone: string;
  ipCountry: string | null;
  phoneCountry: string | null;
  industry?: string;
  businessName?: string | null;
  mode?: string;
}

/** Records a prospect who entered the demo (one row per form submission). */
export async function createDemoLead(input: CreateLeadInput) {
  return prisma.demoLead.create({
    data: {
      demoSessionId: input.sessionId,
      name: input.name,
      email: input.email,
      phone: input.phone,
      ipCountry: input.ipCountry,
      phoneCountry: input.phoneCountry,
      industry: normalizeIndustry(input.industry),
      businessName: input.businessName?.trim() || null,
      mode: input.mode ?? 'pending',
    },
  });
}

/** Marks which mode a prospect ultimately chose (web | call). Best-effort. */
export async function setLeadMode(leadId: string, mode: string): Promise<void> {
  await prisma.demoLead.update({ where: { id: leadId }, data: { mode } }).catch(() => undefined);
}

export interface CaptureDemoCallInput {
  demoSessionId: string;
  externalCallId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  endedReason: string | null;
  summary: string | null;
  transcript: string | null;
  recordingUrl: string | null;
}

/**
 * Persists a finished demo call (transcript, summary, recording) so the founder
 * can review exactly how the sales agent performed. Idempotent on the provider
 * call id. Unlike real CallLogs these aren't billed — they're sales telemetry.
 */
export async function captureDemoCall(input: CaptureDemoCallInput): Promise<void> {
  const durationSeconds =
    input.startedAt && input.endedAt
      ? Math.max(0, Math.round((input.endedAt.getTime() - input.startedAt.getTime()) / 1000))
      : 0;
  const data = {
    demoSessionId: input.demoSessionId,
    durationSeconds,
    endedReason: input.endedReason,
    summary: input.summary,
    transcript: input.transcript,
    recordingUrl: input.recordingUrl,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  };
  if (input.externalCallId) {
    await prisma.demoCall.upsert({
      where: { externalCallId: input.externalCallId },
      create: { externalCallId: input.externalCallId, ...data },
      update: data,
    });
  } else {
    await prisma.demoCall.create({ data });
  }
}

export interface DemoCallWithLead {
  id: string;
  durationSeconds: number;
  endedReason: string | null;
  summary: string | null;
  transcript: string | null;
  recordingUrl: string | null;
  createdAt: Date;
  lead: { name: string; email: string; phone: string; mode: string } | null;
}

/** Recent demo calls joined to their lead, newest first — for the founder view. */
export async function listRecentDemoCalls(limit = 50): Promise<DemoCallWithLead[]> {
  const calls = await prisma.demoCall.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  const leads = await prisma.demoLead.findMany({
    where: { demoSessionId: { in: calls.map((c) => c.demoSessionId) } },
    orderBy: { createdAt: 'asc' },
  });
  const leadBySession = new Map(leads.map((l) => [l.demoSessionId, l]));
  return calls.map((c) => {
    const lead = leadBySession.get(c.demoSessionId);
    return {
      id: c.id,
      durationSeconds: c.durationSeconds,
      endedReason: c.endedReason,
      summary: c.summary,
      transcript: c.transcript,
      recordingUrl: c.recordingUrl,
      createdAt: c.createdAt,
      lead: lead ? { name: lead.name, email: lead.email, phone: lead.phone, mode: lead.mode } : null,
    };
  });
}

export async function getDemoAppointments(sessionId: string): Promise<DemoAppointmentView[]> {
  const rows = await prisma.appointment.findMany({
    where: { demoSessionId: sessionId, status: 'CONFIRMED' },
    orderBy: { startsAt: 'asc' },
    select: { id: true, startsAt: true, timezone: true, customerName: true, reason: true, source: true },
  });
  return rows.map(mapAppointment);
}

/** Visitor blocks a slot from the UI so they can watch the agent refuse it. */
export async function blockDemoSlot(sessionId: string, date: string, time: string): Promise<DemoAppointmentView[]> {
  const bundle = await getOrCreateDemoTenant();
  const startsAt = zonedToUtc(date, time, bundle.settings.timezone);
  const endsAt = new Date(startsAt.getTime() + SLOT_MINUTES * 60_000);
  const existing = await prisma.appointment.findFirst({
    where: { demoSessionId: sessionId, status: 'CONFIRMED', startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
    select: { id: true },
  });
  if (!existing) {
    await prisma.appointment.create({
      data: {
        tenantId: bundle.tenant.id,
        demoSessionId: sessionId,
        customerName: 'Blocked (you)',
        startsAt,
        endsAt,
        timezone: bundle.settings.timezone,
        source: 'MANUAL',
        status: 'CONFIRMED',
      },
    });
  }
  return getDemoAppointments(sessionId);
}

/** Wipes the visitor's calendar back to the seeded starting point. */
export async function resetDemoSession(sessionId: string): Promise<{ day: DemoDay; appointments: DemoAppointmentView[] }> {
  if (!sessionId.startsWith('demo_')) throw new HttpError(400, 'Invalid demo session.', 'BAD_SESSION');
  const bundle = await getOrCreateDemoTenant();
  await prisma.appointment.deleteMany({ where: { demoSessionId: sessionId } });
  const hours = parseBusinessHours(bundle.settings.businessHours);
  const meta = await sessionMeta(sessionId);
  const day = nextBusinessDay(hours, bundle.settings.timezone, meta.industry, meta.businessName);
  await seedSession(bundle.tenant.id, sessionId, day, bundle.settings.timezone);
  return { day, appointments: await getDemoAppointments(sessionId) };
}
