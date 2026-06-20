import { prisma } from '../lib/prisma';
import { utcToZonedParts } from './appointment.service';
import { isOpenNow, parseBusinessHours } from '../domain/agent-config';

/**
 * Tenant analytics — aggregated from CallLog + Appointment over a trailing
 * window. Everything here is read-only and tenant-scoped. Volumes per tenant
 * are small (hundreds/month), so we fetch the window once and reduce in memory
 * rather than firing a dozen grouped queries — same pattern as getCallStats.
 */

export interface AnalyticsOverview {
  rangeDays: number;
  /** Total inbound calls in the window. */
  totalCalls: number;
  /** Total appointments booked (created) in the window, excluding demo. */
  totalBookings: number;
  /** Bookings the voice agent made vs. booked manually. */
  bookingsBySource: { voice: number; manual: number };
  /** Current status of bookings created in the window. */
  bookingsByStatus: { confirmed: number; completed: number; cancelled: number; noShow: number };
  /** Share of (completed + no-show) appointments that were no-shows, 0..1. */
  noShowRate: number;
  /** Calls → bookings, 0..1. A rough proxy for receptionist effectiveness. */
  conversionRate: number;
  /** Per-day series for the window (oldest → newest). */
  daily: { date: string; calls: number; bookings: number }[];
  /** Bookings grouped by local hour of day (0..23). */
  byHour: { hour: number; bookings: number }[];
  /** Bookings grouped by local weekday (0=Sun .. 6=Sat). */
  byWeekday: { weekday: number; bookings: number }[];
  /** ROI: dollar value the receptionist captured + after-hours catch. */
  revenue: {
    /** Owner-set average revenue per appointment, whole dollars. */
    avgAppointmentValue: number;
    /** Voice-agent bookings that are confirmed or completed (not cancelled). */
    capturedBookings: number;
    /** capturedBookings × avgAppointmentValue. */
    estimatedRevenue: number;
    /** Calls the agent handled outside business hours (would-be voicemails). */
    afterHoursCalls: number;
    /** Voice bookings made while the business was closed. */
    afterHoursBookings: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD for a Date in UTC (series buckets are keyed by calendar day). */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getAnalyticsOverview(
  tenantId: string,
  rangeDays: number,
): Promise<AnalyticsOverview> {
  const since = new Date(Date.now() - rangeDays * DAY_MS);

  const [calls, bookings, settings] = await Promise.all([
    prisma.callLog.findMany({
      where: { tenantId, startedAt: { gte: since } },
      select: { startedAt: true },
      take: 10000,
    }),
    prisma.appointment.findMany({
      where: { tenantId, demoSessionId: null, createdAt: { gte: since } },
      select: { createdAt: true, startsAt: true, timezone: true, status: true, source: true },
      take: 10000,
    }),
    prisma.agentSettings.findUnique({
      where: { tenantId },
      select: { businessHours: true, timezone: true, avgAppointmentValue: true },
    }),
  ]);

  // ROI inputs: average ticket + a closed/open classifier for "after-hours" catch.
  const avgAppointmentValue = settings?.avgAppointmentValue ?? 0;
  const hours = parseBusinessHours(settings?.businessHours);
  const tz = settings?.timezone ?? 'UTC';
  const isAfterHours = (at: Date) => !isOpenNow(hours, tz, at);
  let afterHoursCalls = 0;
  let afterHoursBookings = 0;
  let capturedBookings = 0;

  // ── Seed the daily series so empty days render as zero, not gaps ──────────
  const dayBuckets = new Map<string, { calls: number; bookings: number }>();
  for (let i = rangeDays - 1; i >= 0; i--) {
    dayBuckets.set(utcDayKey(new Date(Date.now() - i * DAY_MS)), { calls: 0, bookings: 0 });
  }

  for (const c of calls) {
    const bucket = dayBuckets.get(utcDayKey(c.startedAt));
    if (bucket) bucket.calls += 1;
    if (isAfterHours(c.startedAt)) afterHoursCalls += 1;
  }

  const bookingsBySource = { voice: 0, manual: 0 };
  const bookingsByStatus = { confirmed: 0, completed: 0, cancelled: 0, noShow: 0 };
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, bookings: 0 }));
  const byWeekday = Array.from({ length: 7 }, (_, weekday) => ({ weekday, bookings: 0 }));

  for (const b of bookings) {
    const bucket = dayBuckets.get(utcDayKey(b.createdAt));
    if (bucket) bucket.bookings += 1;

    if (b.source === 'VOICE_AGENT') {
      bookingsBySource.voice += 1;
      // Captured = voice bookings that stuck (confirmed/completed, not cancelled).
      if (b.status === 'CONFIRMED' || b.status === 'COMPLETED') capturedBookings += 1;
      if (isAfterHours(b.createdAt)) afterHoursBookings += 1;
    } else bookingsBySource.manual += 1;

    if (b.status === 'CONFIRMED') bookingsByStatus.confirmed += 1;
    else if (b.status === 'COMPLETED') bookingsByStatus.completed += 1;
    else if (b.status === 'CANCELLED') bookingsByStatus.cancelled += 1;
    else if (b.status === 'NO_SHOW') bookingsByStatus.noShow += 1;

    // Hour/weekday use the appointment's local wall-clock (when they come in),
    // not when it was booked — that's what "busiest times" means to an owner.
    const local = utcToZonedParts(b.startsAt, b.timezone);
    const hour = Number(local.time.slice(0, 2));
    if (byHour[hour]) byHour[hour].bookings += 1;
    const weekday = new Date(`${local.date}T12:00:00Z`).getUTCDay();
    if (byWeekday[weekday]) byWeekday[weekday].bookings += 1;
  }

  const daily = Array.from(dayBuckets.entries()).map(([date, v]) => ({
    date,
    calls: v.calls,
    bookings: v.bookings,
  }));

  const attended = bookingsByStatus.completed + bookingsByStatus.noShow;
  const noShowRate = attended > 0 ? bookingsByStatus.noShow / attended : 0;
  const conversionRate = calls.length > 0 ? bookings.length / calls.length : 0;

  return {
    rangeDays,
    totalCalls: calls.length,
    totalBookings: bookings.length,
    bookingsBySource,
    bookingsByStatus,
    noShowRate,
    conversionRate,
    daily,
    byHour,
    byWeekday,
    revenue: {
      avgAppointmentValue,
      capturedBookings,
      estimatedRevenue: capturedBookings * avgAppointmentValue,
      afterHoursCalls,
      afterHoursBookings,
    },
  };
}
