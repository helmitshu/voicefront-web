import { describe, expect, it } from 'vitest';
import { expandBookingWindow } from './support-agent.service';
import { defaultBusinessHours, type BusinessHours } from '../domain/agent-config';

/**
 * Pure tests for the booking-window expansion rules: the propose step is
 * the only door to a change, so its validation is where nonsense dies.
 * (expandBookingWindow throws a ToolError, which is an Error subclass;
 * these tests assert on the message.)
 */

const current = defaultBusinessHours(); // Mon-Fri 08:00-17:00, weekends off

describe('expandBookingWindow', () => {
  it('applies a weekday-mornings window and closes the weekend explicitly', () => {
    const { hours, summary } = expandBookingWindow(current, {
      windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], open: '08:00', close: '12:00' }],
      closedDays: ['sat', 'sun'],
    });
    expect(hours.mon).toEqual({ enabled: true, open: '08:00', close: '12:00' });
    expect(hours.fri).toEqual({ enabled: true, open: '08:00', close: '12:00' });
    expect(hours.sat.enabled).toBe(false);
    expect(hours.sun.enabled).toBe(false);
    expect(summary).toContain('Monday to Friday 8 AM to 12 PM');
  });

  it('leaves days the request does not mention exactly as they were', () => {
    const { hours } = expandBookingWindow(current, {
      windows: [{ days: ['sat'], open: '09:00', close: '13:00' }],
    });
    expect(hours.sat).toEqual({ enabled: true, open: '09:00', close: '13:00' });
    expect(hours.mon).toEqual(current.mon);
    expect(hours.sun).toEqual(current.sun);
  });

  it('rejects a window that ends before it starts', () => {
    expect(() =>
      expandBookingWindow(current, { windows: [{ days: ['mon'], open: '12:00', close: '08:00' }] }),
    ).toThrow(/ends before it starts/);
  });

  it('rejects a zero-length window', () => {
    expect(() =>
      expandBookingWindow(current, { windows: [{ days: ['mon'], open: '09:00', close: '09:00' }] }),
    ).toThrow(/ends before it starts/);
  });

  it('rejects malformed times', () => {
    expect(() =>
      expandBookingWindow(current, { windows: [{ days: ['mon'], open: '8am', close: '12:00' }] }),
    ).toThrow(/24-hour HH:MM/);
  });

  it('rejects a day claimed by two windows', () => {
    expect(() =>
      expandBookingWindow(current, {
        windows: [
          { days: ['mon', 'tue'], open: '08:00', close: '12:00' },
          { days: ['tue'], open: '13:00', close: '17:00' },
        ],
      }),
    ).toThrow(/appears in two different windows/);
  });

  it('rejects an unknown day key', () => {
    expect(() =>
      expandBookingWindow(current, { windows: [{ days: ['funday'], open: '08:00', close: '12:00' }] }),
    ).toThrow(/not a day I recognise/);
  });

  it('rejects an empty change', () => {
    expect(() => expandBookingWindow(current, {})).toThrow(/No change was described/);
  });

  it('refuses a total lockout unless explicitly confirmed', () => {
    const lockout: BusinessHours = JSON.parse(JSON.stringify(current)) as BusinessHours;
    void lockout;
    expect(() =>
      expandBookingWindow(current, { closedDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }),
    ).toThrow(/stop all bookings/);
    const { hours } = expandBookingWindow(current, {
      closedDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      allowLockout: true,
    });
    expect(Object.values(hours).every((d) => !d.enabled)).toBe(true);
  });
});
