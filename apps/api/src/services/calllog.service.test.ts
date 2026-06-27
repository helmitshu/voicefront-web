import { describe, it, expect } from 'vitest';
import { normalizeCallOutcome } from './calllog.service';

describe('normalizeCallOutcome', () => {
  it('maps a well-formed extraction onto normalized columns', () => {
    const r = normalizeCallOutcome(
      {
        intent: 'BOOK',
        outcome: 'BOOKED',
        urgency: 'NONE',
        leadQuality: 'HOT',
        appointmentBooked: true,
        callerName: 'Karina',
      },
      '8',
    );
    expect(r).toEqual({
      intent: 'BOOK',
      outcome: 'BOOKED',
      urgency: 'NONE',
      leadQuality: 'HOT',
      appointmentBooked: true,
      successScore: 8,
    });
  });

  it('normalizes case and rejects values outside the allowed enums', () => {
    const r = normalizeCallOutcome({ intent: 'book', outcome: 'maybe', urgency: 'kinda' }, 5);
    expect(r.intent).toBe('BOOK'); // upcased
    expect(r.outcome).toBeNull(); // not an allowed outcome
    expect(r.urgency).toBeNull();
    expect(r.successScore).toBe(5);
  });

  it('clamps an out-of-range or unparseable success score to null', () => {
    expect(normalizeCallOutcome({}, '11').successScore).toBeNull();
    expect(normalizeCallOutcome({}, '0').successScore).toBeNull();
    expect(normalizeCallOutcome({}, 'great').successScore).toBeNull();
    expect(normalizeCallOutcome({}, undefined).successScore).toBeNull();
  });

  it('returns all-null for a missing extraction', () => {
    expect(normalizeCallOutcome(null, null)).toEqual({
      intent: null,
      outcome: null,
      urgency: null,
      leadQuality: null,
      appointmentBooked: null,
      successScore: null,
    });
  });

  it('ignores a non-boolean appointmentBooked', () => {
    expect(normalizeCallOutcome({ appointmentBooked: 'yes' }, null).appointmentBooked).toBeNull();
  });
});
