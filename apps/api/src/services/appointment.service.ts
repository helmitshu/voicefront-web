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
  const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
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
      status: 'CONFIRMED',
      startsAt: { lt: windowEnd },
      endsAt: { gt: windowStart },
    },
    select: { startsAt: true, endsAt: true },
  });

  const freeSlots: string[] = [];
  for (let t = dayHours.open; addMinutes(t, slotMinutes) <= close; t = addMinutes(t, slotMinutes)) {
    const slotStart = zonedToUtc(date, t, timezone);
    const slotEnd = new Date(slotStart.getTime() + slotMinutes * 60_000);
    if (slotStart.getTime() <= now.getTime()) continue; // never offer the past
    const clash = booked.some((b) => b.startsAt < slotEnd && b.endsAt > slotStart);
    if (!clash) freeSlots.push(t);
  }
  return { open: true, freeSlots, dayLabel };
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
}

/**
 * Validates and creates a CONFIRMED appointment. Throws HttpError with a
 * speakable message on conflicts so the voice tool can relay it directly.
 */
export async function bookAppointment(input: BookingInput): Promise<Appointment> {
  const { tenantId, timezone } = input;
  if (!DATE_REGEX.test(input.date)) throw new HttpError(400, 'Date must be YYYY-MM-DD.', 'BAD_DATE');
  if (!TIME_REGEX.test(input.time)) throw new HttpError(400, 'Time must be 24h HH:MM.', 'BAD_TIME');
  const customerName = input.customerName.trim();
  if (customerName.length < 2) throw new HttpError(400, 'Customer name is required.', 'BAD_NAME');

  const durationMinutes = input.durationMinutes ?? DEFAULT_SLOT_MINUTES;
  if (durationMinutes < 10 || durationMinutes > 240) {
    throw new HttpError(400, 'Duration must be between 10 and 240 minutes.', 'BAD_DURATION');
  }

  const now = input.now ?? new Date();
  const startsAt = zonedToUtc(input.date, input.time, timezone);
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

  if (startsAt.getTime() <= now.getTime()) {
    throw new HttpError(409, 'That time is in the past.', 'PAST_SLOT');
  }
  if (startsAt.getTime() > now.getTime() + MAX_BOOKING_DAYS_AHEAD * 24 * 3600_000) {
    throw new HttpError(409, `Bookings are limited to ${MAX_BOOKING_DAYS_AHEAD} days ahead.`, 'TOO_FAR_AHEAD');
  }

  // Must fall inside that local day's business-hours window.
  const hours = parseBusinessHours(input.businessHours);
  const dayHours = hours[weekdayOf(input.date, timezone)];
  const close = dayHours.close > dayHours.open ? dayHours.close : '23:59';
  if (!dayHours.enabled || input.time < dayHours.open || addMinutes(input.time, durationMinutes) > close) {
    throw new HttpError(
      409,
      'That time is outside business hours for that day.',
      'OUTSIDE_HOURS',
    );
  }

  // Serialize per-tenant bookings so two concurrent calls can't double-book:
  // the advisory lock holds for the transaction, then we re-check overlap.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;
    const clash = await tx.appointment.findFirst({
      where: {
        tenantId,
        status: 'CONFIRMED',
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      select: { id: true },
    });
    if (clash) {
      throw new HttpError(409, 'That time was just taken. Please pick another slot.', 'SLOT_TAKEN');
    }
    return tx.appointment.create({
      data: {
        tenantId,
        customerName,
        customerPhone: input.customerPhone?.trim() || null,
        reason: input.reason?.trim() || null,
        startsAt,
        endsAt,
        timezone,
        source: input.source,
        externalCallId: input.externalCallId ?? null,
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

/** Tenant-scoped update; recomputes times when date/time/duration change. */
export async function updateAppointment(
  tenantId: string,
  id: string,
  patch: AppointmentPatch,
): Promise<Appointment> {
  const existing = await prisma.appointment.findFirst({ where: { id, tenantId } });
  if (!existing) throw new HttpError(404, 'Appointment not found.', 'NOT_FOUND');

  const data: Prisma.AppointmentUpdateInput = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.customerName !== undefined) data.customerName = patch.customerName.trim();
  if (patch.customerPhone !== undefined) data.customerPhone = patch.customerPhone?.trim() || null;
  if (patch.reason !== undefined) data.reason = patch.reason?.trim() || null;
  if (patch.notes !== undefined) data.notes = patch.notes?.trim() || null;

  if (patch.date !== undefined || patch.time !== undefined || patch.durationMinutes !== undefined) {
    const current = utcToZonedParts(existing.startsAt, existing.timezone);
    const date = patch.date ?? current.date;
    const time = patch.time ?? current.time;
    if (!DATE_REGEX.test(date)) throw new HttpError(400, 'Date must be YYYY-MM-DD.', 'BAD_DATE');
    if (!TIME_REGEX.test(time)) throw new HttpError(400, 'Time must be 24h HH:MM.', 'BAD_TIME');
    const duration =
      patch.durationMinutes ??
      Math.round((existing.endsAt.getTime() - existing.startsAt.getTime()) / 60_000);
    const startsAt = zonedToUtc(date, time, existing.timezone);
    data.startsAt = startsAt;
    data.endsAt = new Date(startsAt.getTime() + duration * 60_000);
  }

  return prisma.appointment.update({ where: { id }, data });
}

/** Ensures DAY_KEYS stays imported as the canonical weekday source. */
export const WEEKDAYS: readonly DayKey[] = DAY_KEYS;
