import { z } from 'zod';
import { E164_REGEX } from '../lib/phone';

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DayHoursSchema = z.object({
  enabled: z.boolean(),
  open: z.string().regex(TIME_REGEX, 'Use 24h HH:MM format'),
  close: z.string().regex(TIME_REGEX, 'Use 24h HH:MM format'),
});
export type DayHours = z.infer<typeof DayHoursSchema>;

export const BusinessHoursSchema = z.object({
  mon: DayHoursSchema,
  tue: DayHoursSchema,
  wed: DayHoursSchema,
  thu: DayHoursSchema,
  fri: DayHoursSchema,
  sat: DayHoursSchema,
  sun: DayHoursSchema,
});
export type BusinessHours = z.infer<typeof BusinessHoursSchema>;

export const ForwardingNumberSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().min(1, 'Label is required').max(40),
  number: z.string().regex(E164_REGEX, 'Use international format, e.g. +14155550123'),
  whenToUse: z.string().trim().max(200).default(''),
});
export type ForwardingNumber = z.infer<typeof ForwardingNumberSchema>;

export const ForwardingNumbersSchema = z.array(ForwardingNumberSchema).max(5);

export function defaultBusinessHours(): BusinessHours {
  const weekday: DayHours = { enabled: true, open: '08:00', close: '17:00' };
  const weekend: DayHours = { enabled: false, open: '09:00', close: '13:00' };
  return {
    mon: { ...weekday },
    tue: { ...weekday },
    wed: { ...weekday },
    thu: { ...weekday },
    fri: { ...weekday },
    sat: { ...weekend },
    sun: { ...weekend },
  };
}

/** Safe parse of the JSON column; falls back to defaults if shape drifted. */
export function parseBusinessHours(value: unknown): BusinessHours {
  const parsed = BusinessHoursSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultBusinessHours();
}

export function parseForwardingNumbers(value: unknown): ForwardingNumber[] {
  const parsed = ForwardingNumbersSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Returns the weekday key and "HH:MM" local time for `now` in `timezone`. */
function localParts(now: Date, timezone: string): { day: DayKey; time: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  let weekday = 'Mon';
  let hour = '00';
  let minute = '00';
  for (const part of fmt.formatToParts(now)) {
    if (part.type === 'weekday') weekday = part.value;
    if (part.type === 'hour') hour = part.value;
    if (part.type === 'minute') minute = part.value;
  }
  // Intl can emit "24" for midnight with hour12: false in some locales.
  if (hour === '24') hour = '00';
  const map: Record<string, DayKey> = {
    Mon: 'mon',
    Tue: 'tue',
    Wed: 'wed',
    Thu: 'thu',
    Fri: 'fri',
    Sat: 'sat',
    Sun: 'sun',
  };
  return { day: map[weekday] ?? 'mon', time: `${hour}:${minute}` };
}

const DAY_ORDER: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Evaluates whether the business is open at `now` in the tenant's timezone.
 * Handles overnight windows (close < open spans midnight into the next day).
 */
export function isOpenNow(hours: BusinessHours, timezone: string, now: Date = new Date()): boolean {
  const { day, time } = localParts(now, timezone);
  const today = hours[day];
  if (today.enabled) {
    if (today.close > today.open) {
      if (time >= today.open && time < today.close) return true;
    } else if (today.close !== today.open) {
      // Overnight window starting today (e.g. 18:00 -> 02:00).
      if (time >= today.open) return true;
    }
  }
  // An overnight window opened yesterday may still be running this morning.
  const idx = DAY_ORDER.indexOf(day);
  const yesterday = hours[DAY_ORDER[(idx + 6) % 7] as DayKey];
  if (yesterday.enabled && yesterday.close < yesterday.open && time < yesterday.close) {
    return true;
  }
  return false;
}

const DAY_LABELS: Record<DayKey, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

function to12h(time: string): string {
  const [hStr, m] = time.split(':');
  const h = Number(hStr);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return m === '00' ? `${display} ${suffix}` : `${display}:${m} ${suffix}`;
}

/** "Monday to Friday 8 AM-5 PM; Saturday 9 AM-1 PM; closed Sunday" style text for prompts. */
export function hoursToHumanText(hours: BusinessHours): string {
  const open = DAY_ORDER.filter((d) => hours[d].enabled);
  if (open.length === 0) return 'No regular hours are configured.';
  const parts: string[] = [];
  let i = 0;
  while (i < open.length) {
    let j = i;
    while (
      j + 1 < open.length &&
      DAY_ORDER.indexOf(open[j + 1] as DayKey) === DAY_ORDER.indexOf(open[j] as DayKey) + 1 &&
      hours[open[j + 1] as DayKey].open === hours[open[i] as DayKey].open &&
      hours[open[j + 1] as DayKey].close === hours[open[i] as DayKey].close
    ) {
      j += 1;
    }
    const first = open[i] as DayKey;
    const last = open[j] as DayKey;
    const range = i === j ? DAY_LABELS[first] : `${DAY_LABELS[first]} to ${DAY_LABELS[last]}`;
    parts.push(`${range} ${to12h(hours[first].open)} to ${to12h(hours[first].close)}`);
    i = j + 1;
  }
  return parts.join('; ');
}
