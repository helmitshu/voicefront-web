import { Prisma, type Appointment } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { DAY_KEYS, parseBusinessHours, type BusinessHours, type DayKey } from '../domain/agent-config';

export const DEFAULT_SLOT_MINUTES = 30;
/** How far ahead the voice agent may book. */
export const MAX_BOOKING_DAYS_AHEAD = 60;

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes the given IANA timezone is ahead of UTC at `date`. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) parts[part.type] = part.value;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** Converts a wall-clock date+time in `timeZone` to the actual UTC instant. */
export function zonedToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const guess = new Date(`${dateStr}T${timeStr}:00Z`);
  let offset = tzOffsetMs(guess, timeZone);
  let result = new Date(guess.getTime() - offset);
  // One refinement pass handles DST transitions near the guess.
  const refined = tzOffsetMs(result, timeZone);
  if (refined !== offset) result = new Date(guess.getTime() - refined);
  return result;
}

/** "YYYY-MM-DD" + "HH:MM" + weekday of a UTC instant, in `timeZone`. */
export function utcToZonedParts(
  date: Date,
  timeZone: string,
): { date: string; time: string; day: DayKey } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) parts[part.type] = part.value;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const dayMap: Record<string, DayKey> = {
    Mon: 'mon',
    Tue: 'tue',
    Wed: 'wed',
    Thu: 'thu',
    Fri: 'fri',
    Sat: 'sat',
    Sun: 'sun',
  };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    day: dayMap[parts.weekday] ?? 'mon',
  };
}

export function to12h(time: string): string {
  const [hStr, m] = time.split(':');
  const h = Number(hStr);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${m} ${suffix}`;
}

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  // Deliberately NOT modulo-24: this is used for monotonic comparisons against a
  // day's close time and to step the availability grid. Wrapping past midnight
  // (e.g. 23:30 + 30 → 00:00) would make "<= close" true forever and spin the
  // slot loop — and let a booking that ends after midnight pass the hours check.
  // A 24h-style overrun yields "24:15", which still compares correctly as text.
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function weekdayOf(dateStr: string, timeZone: string): DayKey {
  // Noon avoids any chance of the date shifting across the day boundary.
  return utcToZonedParts(zonedToUtc(dateStr, '12:00', timeZone), timeZone).day;
}

export interface SlotQuery {
  tenantId: string;
  timezone: string;
  businessHours: unknown;
  date: string; // YYYY-MM-DD in tenant timezone
  slotMinutes?: number;
  now?: Date;
  /** Landing-page demo only: scope availability to one visitor's session. */
  demoSessionId?: string | null;
  /** A specific provider the caller asked for — availability is theirs alone. */
  providerId?: string | null;
  /** Candidate providers to check when no specific one was requested: a time is
   *  offerable if ANY of them is free (first-available). Omitted/empty falls back
   *  to the single shared resource (null provider) — the solo/no-provider case. */
  providerIds?: string[];
}

export interface SlotResult {
  open: boolean;
  /** "HH:MM" starts, in tenant-local time, that are inside hours and unbooked. */
  freeSlots: string[];
  dayLabel: string;
}

/**
 * Free slots for one local day: business-hours window minus CONFIRMED
 * appointments, on a fixed grid. Overnight windows are clamped to the
 * same-day portion — receptionists book within the day the caller asked for.
 */
export async function findFreeSlots(query: SlotQuery): Promise<SlotResult> {
  const { tenantId, timezone, date } = query;
  if (!DATE_REGEX.test(date)) {
    throw new HttpError(400, 'Date must be YYYY-MM-DD.', 'BAD_DATE');
  }
  const slotMinutes = query.slotMinutes ?? DEFAULT_SLOT_MINUTES;
  const now = query.now ?? new Date();
  const hours: BusinessHours = parseBusinessHours(query.businessHours);
  const day = weekdayOf(date, timezone);
  const dayHours = hours[day];
  const dayLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(zonedToUtc(date, '12:00', timezone));

  if (!dayHours.enabled) return { open: false, freeSlots: [], dayLabel };

  const close = dayHours.close > dayHours.open ? dayHours.close : '23:59';
  const windowStart = zonedToUtc(date, dayHours.open, timezone);
  const windowEnd = zonedToUtc(date, close, timezone);

  const booked = await prisma.appointment.findMany({
    where: {
      tenantId,
      demoSessionId: query.demoSessionId ?? null,
      status: 'CONFIRMED',
      startsAt: { lt: windowEnd },
      endsAt: { gt: windowStart },
    },
    select: { startsAt: true, endsAt: true, providerId: true },
  });

  // Whose calendars to consider: a named provider, else the candidate pool, else
  // the single shared resource (null) for solo/no-provider businesses.
  const candidates = candidateProviders(query.providerId, query.providerIds);

  const freeSlots: string[] = [];
  for (let t = dayHours.open; addMinutes(t, slotMinutes) <= close; t = addMinutes(t, slotMinutes)) {
    const slotStart = zonedToUtc(date, t, timezone);
    const slotEnd = new Date(slotStart.getTime() + slotMinutes * 60_000);
    if (slotStart.getTime() <= now.getTime()) continue; // never offer the past
    // Offerable if at least one candidate provider has nothing overlapping it.
    const free = candidates.some(
      (p) => !booked.some((b) => b.providerId === p && b.startsAt < slotEnd && b.endsAt > slotStart),
    );
    if (free) freeSlots.push(t);
  }
  return { open: true, freeSlots, dayLabel };
}

/**
 * Resolves the set of provider "buckets" a booking or availability check should
 * consider: a single named provider, otherwise the candidate pool, otherwise
 * `[null]` — the shared single resource used by solo/no-provider businesses.
 */
function candidateProviders(
  providerId: string | null | undefined,
  providerIds: string[] | undefined,
): Array<string | null> {
  if (providerId) return [providerId];
  if (providerIds && providerIds.length > 0) return providerIds;
  return [null];
}

export interface BookingInput {
  tenantId: string;
  timezone: string;
  businessHours: unknown;
  customerName: string;
  customerPhone?: string | null;
  reason?: string | null;
  date: string; // YYYY-MM-DD tenant-local
  time: string; // HH:MM tenant-local
  durationMinutes?: number;
  source: 'VOICE_AGENT' | 'MANUAL';
  externalCallId?: string | null;
  now?: Date;
  /** Landing-page demo only: tags the booking to one visitor's session. */
  demoSessionId?: string | null;
  /** Book this specific provider (the caller named one). Takes precedence. */
  providerId?: string | null;
  /** Auto-assign among these qualified providers when none was named: the first
   *  one free at the slot gets it. Omitted/empty → single shared resource. */
  candidateProviderIds?: string[];
  /** The service booked (sets which provider pool and is recorded on the row). */
  serviceId?: string | null;
}

export interface BookingWindowInput {
  date: string; // YYYY-MM-DD tenant-local
  time: string; // HH:MM tenant-local
  durationMinutes: number;
  timezone: string;
  businessHours: unknown;
  now?: Date;
}

/**
 * Validates a desired appointment window (format, duration bounds, lead-time,
 * business hours) and resolves it to a concrete UTC start/end. Pure — no DB —
 * so every write path (voice agent, manual create, manual reschedule) shares
 * exactly one set of rules. Throws HttpError with speakable messages.
 */
export function resolveBookingWindow(input: BookingWindowInput): { startsAt: Date; endsAt: Date } {
  const { date, time, durationMinutes, timezone } = input;
  if (!DATE_REGEX.test(date)) throw new HttpError(400, 'Date must be YYYY-MM-DD.', 'BAD_DATE');
  if (!TIME_REGEX.test(time)) throw new HttpError(400, 'Time must be 24h HH:MM.', 'BAD_TIME');
  if (durationMinutes < 10 || durationMinutes > 240) {
    throw new HttpError(400, 'Duration must be between 10 and 240 minutes.', 'BAD_DURATION');
  }

  const now = input.now ?? new Date();
  const startsAt = zonedToUtc(date, time, timezone);
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

  if (startsAt.getTime() <= now.getTime()) {
    throw new HttpError(409, 'That time is in the past.', 'PAST_SLOT');
  }
  if (startsAt.getTime() > now.getTime() + MAX_BOOKING_DAYS_AHEAD * 24 * 3600_000) {
    throw new HttpError(409, `Bookings are limited to ${MAX_BOOKING_DAYS_AHEAD} days ahead.`, 'TOO_FAR_AHEAD');
  }

  // Must fall inside that local day's business-hours window.
  const hours = parseBusinessHours(input.businessHours);
  const dayHours = hours[weekdayOf(date, timezone)];
  const close = dayHours.close > dayHours.open ? dayHours.close : '23:59';
  if (!dayHours.enabled || time < dayHours.open || addMinutes(time, durationMinutes) > close) {
    throw new HttpError(409, 'That time is outside business hours for that day.', 'OUTSIDE_HOURS');
  }

  return { startsAt, endsAt };
}

export interface OverlapParams {
  tenantId: string;
  demoSessionId: string | null;
  startsAt: Date;
  endsAt: Date;
  /** Exclude this appointment from the clash search (i.e. when rescheduling it). */
  excludeId?: string;
  /** Scope the clash to one provider's calendar. `null` = the shared resource;
   *  `undefined` = don't filter by provider (any provider counts). */
  providerId?: string | null;
}

/** Prisma filter for a CONFIRMED appointment that overlaps [startsAt, endsAt). */
export function overlapWhere(params: OverlapParams): Prisma.AppointmentWhereInput {
  return {
    tenantId: params.tenantId,
    demoSessionId: params.demoSessionId,
    status: 'CONFIRMED',
    ...(params.excludeId ? { id: { not: params.excludeId } } : {}),
    ...(params.providerId !== undefined ? { providerId: params.providerId } : {}),
    startsAt: { lt: params.endsAt },
    endsAt: { gt: params.startsAt },
  };
}

/** Demo sessions lock on tenant+session so unrelated visitors never block each other. */
function lockKeyFor(tenantId: string, demoSessionId: string | null): string {
  return demoSessionId ? `${tenantId}:${demoSessionId}` : tenantId;
}

/** True if a CONFIRMED appointment already occupies the window. Run under the lock. */
async function providerHasClash(tx: Prisma.TransactionClient, params: OverlapParams): Promise<boolean> {
  const clash = await tx.appointment.findFirst({ where: overlapWhere(params), select: { id: true } });
  return clash !== null;
}

/** Throws SLOT_TAKEN if the window is occupied for the given provider scope. */
async function assertSlotFree(tx: Prisma.TransactionClient, params: OverlapParams): Promise<void> {
  if (await providerHasClash(tx, params)) {
    throw new HttpError(409, 'That time was just taken. Please pick another slot.', 'SLOT_TAKEN');
  }
}

/**
 * Validates and creates a CONFIRMED appointment. Throws HttpError with a
 * speakable message on conflicts so the voice tool can relay it directly.
 */
export async function bookAppointment(input: BookingInput): Promise<Appointment> {
  const { tenantId, timezone } = input;
  const customerName = input.customerName.trim();
  if (customerName.length < 2) throw new HttpError(400, 'Customer name is required.', 'BAD_NAME');

  const durationMinutes = input.durationMinutes ?? DEFAULT_SLOT_MINUTES;
  const { startsAt, endsAt } = resolveBookingWindow({
    date: input.date,
    time: input.time,
    durationMinutes,
    timezone,
    businessHours: input.businessHours,
    now: input.now,
  });

  const demoSessionId = input.demoSessionId ?? null;
  const candidates = candidateProviders(input.providerId, input.candidateProviderIds);
  // Serialize bookings so two concurrent calls can't double-book: the advisory
  // lock holds for the transaction, then we assign the first candidate provider
  // who's actually free at this slot (or the shared resource when there are none).
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKeyFor(tenantId, demoSessionId)}))`;
    let chosen: string | null | undefined;
    for (const providerId of candidates) {
      if (!(await providerHasClash(tx, { tenantId, demoSessionId, startsAt, endsAt, providerId }))) {
        chosen = providerId;
        break;
      }
    }
    if (chosen === undefined) {
      throw new HttpError(409, 'That time was just taken. Please pick another slot.', 'SLOT_TAKEN');
    }
    return tx.appointment.create({
      data: {
        tenantId,
        providerId: chosen,
        serviceId: input.serviceId ?? null,
        customerName,
        customerPhone: input.customerPhone?.trim() || null,
        reason: input.reason?.trim() || null,
        startsAt,
        endsAt,
        timezone,
        source: input.source,
        externalCallId: input.externalCallId ?? null,
        demoSessionId,
      },
    });
  });
}

export type AppointmentPatch = Partial<{
  status: 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
  date: string;
  time: string;
  durationMinutes: number;
  customerName: string;
  customerPhone: string | null;
  reason: string | null;
  notes: string | null;
}>;

/**
 * Tenant-scoped update; recomputes times when date/time/duration change. A
 * reschedule runs the same validation as a fresh booking (business hours,
 * lead-time) and re-checks for overlap under the advisory lock — so a manual
 * edit can't double-book the very calendar the voice agent protects.
 * `businessHours` is the tenant's current settings, used to validate new times.
 */
export async function updateAppointment(
  tenantId: string,
  id: string,
  patch: AppointmentPatch,
  businessHours: unknown,
): Promise<Appointment> {
  const existing = await prisma.appointment.findFirst({ where: { id, tenantId } });
  if (!existing) throw new HttpError(404, 'Appointment not found.', 'NOT_FOUND');

  const data: Prisma.AppointmentUpdateInput = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.customerName !== undefined) data.customerName = patch.customerName.trim();
  if (patch.customerPhone !== undefined) data.customerPhone = patch.customerPhone?.trim() || null;
  if (patch.reason !== undefined) data.reason = patch.reason?.trim() || null;
  if (patch.notes !== undefined) data.notes = patch.notes?.trim() || null;

  const timeChanged =
    patch.date !== undefined || patch.time !== undefined || patch.durationMinutes !== undefined;

  let startsAt = existing.startsAt;
  let endsAt = existing.endsAt;
  if (timeChanged) {
    const current = utcToZonedParts(existing.startsAt, existing.timezone);
    const durationMinutes =
      patch.durationMinutes ??
      Math.round((existing.endsAt.getTime() - existing.startsAt.getTime()) / 60_000);
    ({ startsAt, endsAt } = resolveBookingWindow({
      date: patch.date ?? current.date,
      time: patch.time ?? current.time,
      durationMinutes,
      timezone: existing.timezone,
      businessHours,
    }));
    data.startsAt = startsAt;
    data.endsAt = endsAt;
  }

  // The double-booking guard only matters when the result will occupy the
  // calendar as CONFIRMED and either its time moved or it's being un-cancelled
  // onto a slot that may now be taken. Status-only edits (cancel, complete,
  // no-show) and note tweaks skip the lock entirely.
  const finalStatus = patch.status ?? existing.status;
  const becomesConfirmed = patch.status === 'CONFIRMED' && existing.status !== 'CONFIRMED';
  const becomesCancelled = patch.status === 'CANCELLED' && existing.status !== 'CANCELLED';
  const needsOverlapCheck = finalStatus === 'CONFIRMED' && (timeChanged || becomesConfirmed);

  let updated: Appointment;
  if (!needsOverlapCheck) {
    updated = await prisma.appointment.update({ where: { id }, data });
  } else {
    const { demoSessionId, providerId } = existing;
    updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKeyFor(tenantId, demoSessionId)}))`;
      // Clash check stays within this appointment's own provider's calendar.
      await assertSlotFree(tx, { tenantId, demoSessionId, startsAt, endsAt, excludeId: id, providerId });
      return tx.appointment.update({ where: { id }, data });
    });
  }

  // A real (non-demo) cancellation frees a slot — let the next person on the
  // waitlist know. Fire-and-forget; the dynamic import keeps the service graph
  // acyclic (appointment → waitlist → sms → appointment).
  if (becomesCancelled && !updated.demoSessionId) {
    void import('./waitlist.service')
      .then((m) => m.notifyWaitlistForOpening(updated))
      .catch((err) => console.error('[waitlist] opening notification failed', err));
  }

  return updated;
}

export interface AppointmentMatch {
  id: string;
  customerName: string;
  customerPhone: string | null;
  reason: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  local: { date: string; time: string };
}

/** Last 10 digits of a phone, so formatting differences never block a match. */
function phoneTail(value: string | null | undefined): string {
  const d = (value ?? '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

/**
 * Upcoming CONFIRMED appointments a caller might want to change or cancel.
 * Identified primarily by the phone the booking is under (matched on the last
 * 10 digits, defaulting to the caller's number), with a name fallback for when
 * the caller is on a different line, and an optional day filter to disambiguate.
 * Returns soonest-first; an empty array means "nothing found under that caller".
 */
export async function findUpcomingAppointments(params: {
  tenantId: string;
  timezone: string;
  phone?: string | null;
  name?: string | null;
  date?: string | null;
  demoSessionId?: string | null;
  now?: Date;
}): Promise<AppointmentMatch[]> {
  const now = params.now ?? new Date();
  const pool = await prisma.appointment.findMany({
    where: {
      tenantId: params.tenantId,
      demoSessionId: params.demoSessionId ?? null,
      status: 'CONFIRMED',
      endsAt: { gt: now },
    },
    orderBy: { startsAt: 'asc' },
    take: 50,
  });

  const tail = phoneTail(params.phone);
  // Phone is the strong identifier: when given, only its matches survive.
  let matches = tail.length >= 7 ? pool.filter((r) => phoneTail(r.customerPhone) === tail) : pool;

  const name = params.name?.trim().toLowerCase() ?? '';
  if (name.length >= 2) {
    if (matches.length === 0) {
      // Caller may be ringing from a different line than they booked on.
      matches = pool.filter((r) => r.customerName.toLowerCase().includes(name));
    } else {
      const byName = matches.filter((r) => r.customerName.toLowerCase().includes(name));
      if (byName.length > 0) matches = byName;
    }
  }

  if (params.date && DATE_REGEX.test(params.date)) {
    const byDate = matches.filter((r) => utcToZonedParts(r.startsAt, r.timezone).date === params.date);
    if (byDate.length > 0) matches = byDate;
  }

  return matches.map((r) => ({
    id: r.id,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    reason: r.reason,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    timezone: r.timezone,
    local: utcToZonedParts(r.startsAt, r.timezone),
  }));
}

/** Ensures DAY_KEYS stays imported as the canonical weekday source. */
export const WEEKDAYS: readonly DayKey[] = DAY_KEYS;
