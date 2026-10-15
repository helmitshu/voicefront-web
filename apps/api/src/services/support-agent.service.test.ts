import { describe, expect, it } from 'vitest';
import {
  CONFIDENTIALITY_BLOCK,
  buildSupportSystemText,
  expandBookingWindow,
  resolveSupportPage,
} from './support-agent.service';
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

/* ------------------------- v2: page context ------------------------------ */

describe('resolveSupportPage', () => {
  it('resolves a known route', () => {
    expect(resolveSupportPage('/dashboard/calls')?.name).toBe('Calls');
    expect(resolveSupportPage('/dashboard/settings')?.name).toBe('Settings');
    expect(resolveSupportPage('/dashboard')?.name).toBe('Dashboard');
  });

  it('resolves a call detail route to the Calls page', () => {
    expect(resolveSupportPage('/dashboard/calls/abc123')?.name).toBe('Calls');
  });

  it('normalises a trailing slash', () => {
    expect(resolveSupportPage('/dashboard/calendar/')?.name).toBe('Calendar');
  });

  it('returns null for unknown routes and junk input', () => {
    expect(resolveSupportPage('/pricing')).toBeNull();
    expect(resolveSupportPage('/dashboard/nope')).toBeNull();
    expect(resolveSupportPage('')).toBeNull();
    expect(resolveSupportPage(undefined)).toBeNull();
    expect(resolveSupportPage(null)).toBeNull();
  });

  it('is lenient about a missing leading slash', () => {
    expect(resolveSupportPage('dashboard/calls')?.name).toBe('Calls');
  });
});

/* ------------------- v2: prompt assembly (sealed lips) ------------------- */

describe('buildSupportSystemText', () => {
  const base = {
    companyName: 'Alpha Dental',
    industry: 'CLINIC',
    receptionistName: 'Maya',
    timezone: 'America/Toronto',
    currentHoursText: 'Monday to Friday 8 AM to 5 PM',
    page: null,
  };

  it('always carries the confidentiality block', () => {
    const prompt = buildSupportSystemText(base);
    expect(prompt).toContain(CONFIDENTIALITY_BLOCK);
    expect(CONFIDENTIALITY_BLOCK).toContain('CONFIDENTIALITY (never break)');
    expect(CONFIDENTIALITY_BLOCK).toContain('internal pricing, margins, strategy, or roadmaps');
    expect(CONFIDENTIALITY_BLOCK).toContain('vendors, technology, models, or infrastructure');
    expect(CONFIDENTIALITY_BLOCK).toContain('built, trained, or prompted');
    expect(CONFIDENTIALITY_BLOCK).toContain('any other customer, account, or their data');
  });

  it('names the page the user is on when one is resolved', () => {
    const prompt = buildSupportSystemText({
      ...base,
      page: resolveSupportPage('/dashboard/calls'),
    });
    expect(prompt).toContain('CURRENT PAGE:');
    expect(prompt).toContain('the Calls page');
    expect(prompt).toContain('anchor answers to that page first');
  });

  it('adds no page line when no page is resolved', () => {
    const prompt = buildSupportSystemText(base);
    expect(prompt).not.toContain('CURRENT PAGE:');
  });

  it('teaches the ticket flow and task reports', () => {
    const prompt = buildSupportSystemText(base);
    expect(prompt).toContain('propose_ticket');
    expect(prompt).toContain('list_recent_calls');
    expect(prompt).toContain('Task reports:');
    expect(prompt).toContain('Never add promises about response times');
  });
});

/* ------------- red team fix: knowledge honesty and coverage -------------- */

describe('knowledge block coverage and the no-denial rule', () => {
  const prompt = buildSupportSystemText({
    companyName: 'Alpha Dental',
    industry: 'CLINIC',
    receptionistName: 'Maya',
    timezone: 'America/Toronto',
    currentHoursText: 'Monday to Friday 8 AM to 5 PM',
    page: null,
  });

  /**
   * The Settings card titles as rendered on the Settings page. Source:
   * apps/web/src/app/dashboard/settings/page.tsx (the CardHeader title
   * props, in page order). This suite never reads web sources from disk,
   * so the titles are pinned here explicitly: when a card ships or is
   * renamed on that page, update this list and the knowledge block
   * together. The test fails if any title drops out of Adam's knowledge,
   * which is what turns a missing card into a false answer to a clinic.
   */
  const SETTINGS_CARD_TITLES = [
    'Persona',
    'Voice & sound',
    'Call handling instructions',
    'Knowledge documents',
    'Voicemail greeting',
    'Business hours',
    'Average appointment value',
    'Live call transfer',
    'Call length & timing',
    'Your receptionist number',
  ];

  it('names every Settings card in the knowledge block', () => {
    for (const title of SETTINGS_CARD_TITLES) {
      expect(prompt).toContain(title);
    }
  });

  it('describes win-back campaigns (the reactivation texts) truthfully', () => {
    expect(prompt).toContain('Win-back campaigns');
    expect(prompt).toContain('inactivity window');
    expect(prompt).toContain('at most once per lapse');
  });

  it('replaces the flat denial with honest uncertainty and a ticket offer', () => {
    expect(prompt).not.toContain('the product does not do that today');
    expect(prompt).toContain('do not have that detail in front of you');
    expect(prompt).toContain('offer to file a ticket');
  });

  it('still forbids inventing features, prices, or policies', () => {
    expect(prompt).toContain('never invent features, prices, or policies');
  });
});
