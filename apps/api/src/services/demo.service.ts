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

export interface SalesConfig {
  agentName: string;
  founderName: string;
}

export async function getSalesConfig(): Promise<SalesConfig> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: [SALES_AGENT_NAME_KEY, SALES_FOUNDER_NAME_KEY] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.valueEnc]));
  return {
    agentName: map.get(SALES_AGENT_NAME_KEY)?.trim() || SALES_PERSONA.name,
    founderName: map.get(SALES_FOUNDER_NAME_KEY)?.trim() || 'our founder',
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
  await Promise.all(writes);
}
const DEMO_COMPANY = 'Bayview Family Clinic';
const DEMO_TZ = 'America/Vancouver';
const SLOT_MINUTES = 30;
/** Visitor calendars are garbage-collected after this idle window. */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/** Pre-booked slots (tenant-local HH:MM) so the demo day looks real. */
const SEED_SLOTS: Array<{ time: string; name: string }> = [
  { time: '09:00', name: 'Team huddle' },
  { time: '10:30', name: 'M. Alvarez — cleaning' },
  { time: '13:30', name: 'D. Okafor — consult' },
];

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
function nextBusinessDay(hours: BusinessHours, timezone: string, now = new Date()): DemoDay {
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
    };
  }
  // Defensive: a tenant with no open days — fall back to tomorrow 08:00–17:00.
  const fallback = utcToZonedParts(new Date(now.getTime() + 24 * 3600 * 1000), timezone);
  return { date: fallback.date, dayLabel: fallback.date, timezone, open: '08:00', close: '17:00', slotMinutes: SLOT_MINUTES };
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
    data: SEED_SLOTS.map((s) => {
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

/** Starts a fresh isolated visitor session: GCs stale data, seeds the day. */
export async function startDemoSession(): Promise<DemoSession> {
  const bundle = await getOrCreateDemoTenant();
  // Lazy GC: clear out calendars from sessions that have gone cold.
  await prisma.appointment.deleteMany({
    where: { tenantId: bundle.tenant.id, createdAt: { lt: new Date(Date.now() - SESSION_TTL_MS) } },
  });

  const sessionId = `demo_${randomUUID()}`;
  const hours = parseBusinessHours(bundle.settings.businessHours);
  const day = nextBusinessDay(hours, bundle.settings.timezone);
  await seedSession(bundle.tenant.id, sessionId, day, bundle.settings.timezone);

  return { sessionId, bundle, day, appointments: await getDemoAppointments(sessionId) };
}

/** Re-hydrates an existing visitor session (after lead capture) without
 *  re-seeding — returns the same deterministic day plus the live calendar. */
export async function resumeDemoSession(sessionId: string): Promise<DemoSession> {
  const bundle = await getOrCreateDemoTenant();
  const hours = parseBusinessHours(bundle.settings.businessHours);
  const day = nextBusinessDay(hours, bundle.settings.timezone);
  return { sessionId, bundle, day, appointments: await getDemoAppointments(sessionId) };
}

export interface CreateLeadInput {
  sessionId: string;
  name: string;
  email: string;
  phone: string;
  ipCountry: string | null;
  phoneCountry: string | null;
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
      mode: input.mode ?? 'pending',
    },
  });
}

/** Marks which mode a prospect ultimately chose (web | call). Best-effort. */
export async function setLeadMode(leadId: string, mode: string): Promise<void> {
  await prisma.demoLead.update({ where: { id: leadId }, data: { mode } }).catch(() => undefined);
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
  const day = nextBusinessDay(hours, bundle.settings.timezone);
  await seedSession(bundle.tenant.id, sessionId, day, bundle.settings.timezone);
  return { day, appointments: await getDemoAppointments(sessionId) };
}
