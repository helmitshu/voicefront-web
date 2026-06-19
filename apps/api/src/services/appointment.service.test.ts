import { describe, it, expect } from 'vitest';
import { HttpError } from '../lib/http';
import { defaultBusinessHours } from '../domain/agent-config';
import {
  to12h,
  zonedToUtc,
  utcToZonedParts,
  resolveBookingWindow,
  overlapWhere,
} from './appointment.service';

/** Runs `fn` and returns the HttpError code it throws, or undefined if it didn't. */
function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpError ? err.code : `NON_HTTP:${String(err)}`;
  }
  return undefined;
}

describe('to12h', () => {
  it('formats 24h times as 12h', () => {
    expect(to12h('00:00')).toBe('12:00 AM');
    expect(to12h('09:05')).toBe('9:05 AM');
    expect(to12h('12:00')).toBe('12:00 PM');
    expect(to12h('13:30')).toBe('1:30 PM');
    expect(to12h('23:45')).toBe('11:45 PM');
  });
});

describe('timezone conversion', () => {
  it('converts EDT (summer) wall-clock to UTC', () => {
    // New York is UTC-4 in July.
    expect(zonedToUtc('2025-07-01', '09:00', 'America/New_York').toISOString()).toBe(
      '2025-07-01T13:00:00.000Z',
    );
  });

  it('converts EST (winter) wall-clock to UTC', () => {
    // New York is UTC-5 in January.
    expect(zonedToUtc('2025-01-15', '09:00', 'America/New_York').toISOString()).toBe(
      '2025-01-15T14:00:00.000Z',
    );
  });

  it('round-trips back to the same local parts', () => {
    const utc = zonedToUtc('2025-07-01', '09:00', 'America/New_York');
    const parts = utcToZonedParts(utc, 'America/New_York');
    expect(parts).toEqual({ date: '2025-07-01', time: '09:00', day: 'tue' });
  });

  it('handles the spring-forward DST boundary', () => {
    // 2025-03-09 02:00 EST jumps to 03:00 EDT. A 09:00 booking is firmly EDT.
    expect(zonedToUtc('2025-03-09', '09:00', 'America/New_York').toISOString()).toBe(
      '2025-03-09T13:00:00.000Z',
    );
  });
});

describe('resolveBookingWindow', () => {
  const tz = 'America/New_York';
  const hours = defaultBusinessHours(); // weekdays 08:00-17:00, weekend closed
  // Tuesday 2025-07-01 08:00 EDT.
  const now = new Date('2025-07-01T12:00:00.000Z');

  it('accepts a valid in-hours slot and resolves UTC start/end', () => {
    const { startsAt, endsAt } = resolveBookingWindow({
      date: '2025-07-02',
      time: '10:00',
      durationMinutes: 30,
      timezone: tz,
      businessHours: hours,
      now,
    });
    expect(startsAt.toISOString()).toBe('2025-07-02T14:00:00.000Z');
    expect(endsAt.toISOString()).toBe('2025-07-02T14:30:00.000Z');
  });

  it('rejects times in the past', () => {
    expect(
      thrownCode(() =>
        resolveBookingWindow({ date: '2025-06-01', time: '10:00', durationMinutes: 30, timezone: tz, businessHours: hours, now }),
      ),
    ).toBe('PAST_SLOT');
  });

  it('rejects times beyond the booking horizon', () => {
    expect(
      thrownCode(() =>
        resolveBookingWindow({ date: '2025-12-01', time: '10:00', durationMinutes: 30, timezone: tz, businessHours: hours, now }),
      ),
    ).toBe('TOO_FAR_AHEAD');
  });

  it('rejects slots before opening or running past close', () => {
    expect(
      thrownCode(() =>
        resolveBookingWindow({ date: '2025-07-02', time: '07:00', durationMinutes: 30, timezone: tz, businessHours: hours, now }),
      ),
    ).toBe('OUTSIDE_HOURS');
    // 16:45 + 30m = 17:15, past the 17:00 close.
    expect(
      thrownCode(() =>
        resolveBookingWindow({ date: '2025-07-02', time: '16:45', durationMinutes: 30, timezone: tz, businessHours: hours, now }),
      ),
    ).toBe('OUTSIDE_HOURS');
  });

  it('rejects closed days', () => {
    // 2025-07-05 is a Saturday (closed by default).
    expect(
      thrownCode(() =>
        resolveBookingWindow({ date: '2025-07-05', time: '10:00', durationMinutes: 30, timezone: tz, businessHours: hours, now }),
      ),
    ).toBe('OUTSIDE_HOURS');
  });

  it('validates format and duration bounds', () => {
    const base = { time: '10:00', durationMinutes: 30, timezone: tz, businessHours: hours, now };
    expect(thrownCode(() => resolveBookingWindow({ ...base, date: '07/02/2025' }))).toBe('BAD_DATE');
    expect(thrownCode(() => resolveBookingWindow({ ...base, date: '2025-07-02', time: '25:00' }))).toBe('BAD_TIME');
    expect(thrownCode(() => resolveBookingWindow({ ...base, date: '2025-07-02', durationMinutes: 5 }))).toBe('BAD_DURATION');
    expect(thrownCode(() => resolveBookingWindow({ ...base, date: '2025-07-02', durationMinutes: 300 }))).toBe('BAD_DURATION');
  });
});

describe('overlapWhere', () => {
  const startsAt = new Date('2025-07-02T14:00:00.000Z');
  const endsAt = new Date('2025-07-02T14:30:00.000Z');

  it('builds a CONFIRMED, tenant-scoped overlap filter', () => {
    const where = overlapWhere({ tenantId: 't1', demoSessionId: null, startsAt, endsAt });
    expect(where.tenantId).toBe('t1');
    expect(where.demoSessionId).toBeNull();
    expect(where.status).toBe('CONFIRMED');
    expect(where.startsAt).toEqual({ lt: endsAt });
    expect(where.endsAt).toEqual({ gt: startsAt });
    // No appointment is excluded for a fresh booking.
    expect('id' in where).toBe(false);
  });

  it('excludes the appointment being rescheduled', () => {
    const where = overlapWhere({ tenantId: 't1', demoSessionId: null, startsAt, endsAt, excludeId: 'appt-9' });
    expect(where.id).toEqual({ not: 'appt-9' });
  });
});
