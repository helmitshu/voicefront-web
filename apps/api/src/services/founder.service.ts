import type { AgentSettings, Appointment, Tenant } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { industryDefaults } from '../domain/prompt-templates';
import type { BusinessHours, DayKey } from '../domain/agent-config';
import {
  bookAppointment,
  findFreeSlots,
  updateAppointment,
  utcToZonedParts,
  type SlotResult,
} from './appointment.service';

/**
 * The founder's own planning-call calendar. It is just another tenant
 * (`__founder`), so it reuses the entire booking engine — including the
 * atomic double-booking guard. The founder blocks busy times from the admin
 * portal; the sales agent (Ava) books a planning call into a free slot at the
 * end of a successful demo and physically cannot double-book the founder,
 * because a block is a CONFIRMED appointment the overlap check respects.
 */

export const FOUNDER_TENANT_SLUG = '__founder';
const FOUNDER_TZ_KEY = 'FOUNDER_TIMEZONE';
const DEFAULT_FOUNDER_TZ = 'America/Vancouver';

/** Generous bookable window so the founder can block (or be booked) any
 *  reasonable hour, any day. Blocks subtract from this; nothing is bookable
 *  outside it. */
function founderHours(): BusinessHours {
  const day = { enabled: true, open: '08:00', close: '20:00' };
  return (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as DayKey[]).reduce(
    (acc, k) => ({ ...acc, [k]: { ...day } }),
    {} as BusinessHours,
  );
}

export interface FounderBundle {
  tenant: Tenant;
  settings: AgentSettings;
}

/** Lazily provisions the founder's calendar tenant on first use. */
export async function getOrCreateFounderTenant(): Promise<FounderBundle> {
  const existing = await prisma.tenant.findUnique({
    where: { slug: FOUNDER_TENANT_SLUG },
    include: { agentSettings: true },
  });
  if (existing?.agentSettings) {
    return { tenant: existing, settings: existing.agentSettings };
  }

  const tzRow = await prisma.platformSetting.findUnique({ where: { key: FOUNDER_TZ_KEY } });
  const timezone = tzRow?.valueEnc?.trim() || DEFAULT_FOUNDER_TZ;
  const defaults = industryDefaults('CLINIC', { companyName: 'Founder', personaName: 'Ava' });
  const created = await prisma.tenant.create({
    data: {
      companyName: 'VoiceFront — Founder',
      slug: FOUNDER_TENANT_SLUG,
      industry: 'CLINIC',
      agentSettings: {
        create: {
          displayName: 'Ava',
          systemPrompt: defaults.systemPrompt,
          firstMessage: defaults.firstMessage,
          voicemailGreeting: defaults.voicemailGreeting,
          businessHours: founderHours() as unknown as object,
          timezone,
          voiceProvider: 'vapi',
          voiceId: 'Savannah',
        },
      },
    },
    include: { agentSettings: true },
  });
  return { tenant: created, settings: created.agentSettings! };
}

/** Founder-local timezone of the planning-call calendar. */
export async function getFounderTimezone(): Promise<string> {
  const { settings } = await getOrCreateFounderTenant();
  return settings.timezone;
}

export interface FounderEntry {
  id: string;
  /** What it is: a manual block the founder added, or a booked planning call. */
  kind: 'block' | 'call';
  label: string;
  reason: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  /** Local wall-clock parts, so the client paints the grid without TZ math. */
  local: { date: string; time: string };
  durationMinutes: number;
  status: string;
}

function toEntry(a: Appointment): FounderEntry {
  const local = utcToZonedParts(a.startsAt, a.timezone);
  return {
    id: a.id,
    kind: a.source === 'VOICE_AGENT' ? 'call' : 'block',
    label: a.customerName,
    reason: a.reason,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    timezone: a.timezone,
    local: { date: local.date, time: local.time },
    durationMinutes: Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60_000),
    status: a.status,
  };
}

/** Founder's calendar entries (blocks + booked calls) across a date range. */
export async function listFounderEntries(from: string, to: string): Promise<FounderEntry[]> {
  const { tenant } = await getOrCreateFounderTenant();
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T23:59:59Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 1);
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
    throw new HttpError(400, 'Invalid date range.', 'BAD_RANGE');
  }
  const rows = await prisma.appointment.findMany({
    where: { tenantId: tenant.id, startsAt: { gte: fromDate, lte: toDate } },
    orderBy: { startsAt: 'asc' },
    take: 500,
  });
  return rows.map(toEntry);
}

/** Free slots for one founder-local day (the bookable window minus blocks). */
export async function founderAvailability(date: string): Promise<SlotResult> {
  const { tenant, settings } = await getOrCreateFounderTenant();
  return findFreeSlots({
    tenantId: tenant.id,
    timezone: settings.timezone,
    businessHours: settings.businessHours,
    date,
  });
}

export interface FounderBlockInput {
  date: string;
  time: string;
  durationMinutes?: number;
  label?: string;
}

/** Founder blocks a busy slot so Ava (and overlap checks) avoid it. */
export async function blockFounderTime(input: FounderBlockInput): Promise<FounderEntry> {
  const { tenant, settings } = await getOrCreateFounderTenant();
  const appt = await bookAppointment({
    tenantId: tenant.id,
    timezone: settings.timezone,
    businessHours: settings.businessHours,
    customerName: input.label?.trim() || 'Busy',
    date: input.date,
    time: input.time,
    durationMinutes: input.durationMinutes,
    source: 'MANUAL',
  });
  return toEntry(appt);
}

/** Books a planning call for the founder. Throws a speakable error on clash,
 *  so the voice tool can relay "that time's taken" directly to the prospect. */
export async function bookFounderCall(input: {
  customerName: string;
  customerPhone?: string | null;
  reason?: string | null;
  date: string;
  time: string;
  durationMinutes?: number;
  externalCallId?: string | null;
}): Promise<FounderEntry> {
  const { tenant, settings } = await getOrCreateFounderTenant();
  const appt = await bookAppointment({
    tenantId: tenant.id,
    timezone: settings.timezone,
    businessHours: settings.businessHours,
    customerName: input.customerName,
    customerPhone: input.customerPhone ?? null,
    reason: input.reason ?? 'Planning call',
    date: input.date,
    time: input.time,
    durationMinutes: input.durationMinutes ?? 15,
    source: 'VOICE_AGENT',
    externalCallId: input.externalCallId ?? null,
  });
  return toEntry(appt);
}

/** Removes a block or cancels a booked call (founder-side). */
export async function removeFounderEntry(id: string): Promise<void> {
  const { tenant } = await getOrCreateFounderTenant();
  // Status-only cancel never re-validates times, so business hours are unused.
  await updateAppointment(tenant.id, id, { status: 'CANCELLED' }, null);
}
