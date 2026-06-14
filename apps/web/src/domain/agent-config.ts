import { z } from 'zod';

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export const DAY_LABELS: Record<DayKey, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DayHoursSchema = z.object({
  enabled: z.boolean(),
  open: z.string().regex(TIME_REGEX, 'Use HH:MM'),
  close: z.string().regex(TIME_REGEX, 'Use HH:MM'),
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

export const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export const ForwardingNumberSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(2, 'Add a label').max(40),
  number: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s().-]/g, ''))
    .pipe(z.string().regex(E164_REGEX, 'Use international format, e.g. +15551234567')),
  whenToUse: z.string().trim().max(200),
});
export type ForwardingNumber = z.infer<typeof ForwardingNumberSchema>;

/** Common IANA timezones for the settings selector. */
export const TIMEZONE_OPTIONS = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'Australia/Sydney',
] as const;

export function timezoneShortLabel(tz: string): string {
  const city = tz.split('/').pop() ?? tz;
  return city.replace(/_/g, ' ');
}
