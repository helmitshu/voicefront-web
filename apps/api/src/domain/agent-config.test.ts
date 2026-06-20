import { describe, it, expect } from 'vitest';
import {
  defaultBusinessHours,
  parseBusinessHours,
  isOpenNow,
  hoursToHumanText,
  type BusinessHours,
} from './agent-config';

describe('parseBusinessHours', () => {
  it('returns defaults for malformed input', () => {
    expect(parseBusinessHours(null)).toEqual(defaultBusinessHours());
    expect(parseBusinessHours({ mon: 'nonsense' })).toEqual(defaultBusinessHours());
  });

  it('passes through a valid object', () => {
    const hours = defaultBusinessHours();
    expect(parseBusinessHours(hours)).toEqual(hours);
  });
});

describe('isOpenNow', () => {
  it('reports open during standard weekday hours', () => {
    const hours = defaultBusinessHours(); // weekdays 08:00-17:00
    // 2025-07-07 is a Monday; 12:00 UTC.
    expect(isOpenNow(hours, 'UTC', new Date('2025-07-07T12:00:00Z'))).toBe(true);
    // 06:00 is before opening.
    expect(isOpenNow(hours, 'UTC', new Date('2025-07-07T06:00:00Z'))).toBe(false);
  });

  it('reports closed on disabled days', () => {
    const hours = defaultBusinessHours();
    // 2025-07-05 is a Saturday (disabled).
    expect(isOpenNow(hours, 'UTC', new Date('2025-07-05T12:00:00Z'))).toBe(false);
  });

  it('handles an overnight window spanning midnight', () => {
    const hours: BusinessHours = defaultBusinessHours();
    hours.mon = { enabled: true, open: '18:00', close: '02:00' }; // overnight
    // Monday 20:00 — inside the open side of the window.
    expect(isOpenNow(hours, 'UTC', new Date('2025-07-07T20:00:00Z'))).toBe(true);
    // Tuesday 01:00 — still inside Monday's window that ran past midnight.
    expect(isOpenNow(hours, 'UTC', new Date('2025-07-08T01:00:00Z'))).toBe(true);
    // Tuesday 12:00 — Tuesday's own hours, well after the overnight window closed.
    expect(isOpenNow(hours, 'UTC', new Date('2025-07-08T12:00:00Z'))).toBe(true); // tue still 08-17
    // Monday 03:00 — before Monday opens and Sunday is disabled.
    expect(isOpenNow(hours, 'UTC', new Date('2025-07-07T03:00:00Z'))).toBe(false);
  });
});

describe('hoursToHumanText', () => {
  it('collapses consecutive identical days into a range', () => {
    expect(hoursToHumanText(defaultBusinessHours())).toBe('Monday to Friday 8 AM to 5 PM');
  });

  it('describes no configured hours', () => {
    const closed = defaultBusinessHours();
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri'] as const) closed[day].enabled = false;
    expect(hoursToHumanText(closed)).toBe('No regular hours are configured.');
  });
});
