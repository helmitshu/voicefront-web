import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http';
import {
  founderAvailability,
  bookFounderCall,
  getFounderTimezone,
} from '../services/founder.service';
import { utcToZonedParts } from '../services/appointment.service';

/**
 * Public, self-service booking for an intro call with the founder. No demo and
 * no auth required — a prospect picks an open slot on the founder's real
 * calendar and leaves their details. It reuses the founder calendar engine, so
 * a booking here lands straight in the admin portal (as a "call" entry) and is
 * protected by the same atomic double-booking guard as the voice agent.
 */
export const bookingRouter = Router();

/** Public endpoints are abuse magnets — cap both reads and writes per IP. */
const readLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' } },
});

const bookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many booking attempts. Please wait a few minutes.', code: 'RATE_LIMITED' } },
});

/** How many days ahead the public booker may see. */
const MAX_DAYS = 21;

/** Adds whole days to a YYYY-MM-DD string (noon-UTC anchor dodges DST edges). */
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

interface DaySlots {
  date: string;
  dayLabel: string;
  open: boolean;
  /** Free "HH:MM" starts in founder-local time. */
  slots: string[];
}

/**
 * Founder availability across the next `days` days, founder-local. Powers the
 * date picker + slot grid: each day is open/closed with its free slots. Days
 * with no remaining slots come back open:true, slots:[] so the UI can grey them.
 */
bookingRouter.get(
  '/slots',
  readLimiter,
  asyncHandler(async (req, res) => {
    const days = Math.min(MAX_DAYS, Math.max(1, Number(req.query.days) || 14));
    const timezone = await getFounderTimezone();
    const today = utcToZonedParts(new Date(), timezone).date;

    // Sequential to keep the advisory-lock-free reads gentle on the DB; the
    // per-day query is tiny and `days` is capped low.
    const out: DaySlots[] = [];
    for (let i = 0; i < days; i += 1) {
      const date = addDays(today, i);
      const avail = await founderAvailability(date);
      out.push({ date, dayLabel: avail.dayLabel, open: avail.open, slots: avail.freeSlots });
    }
    res.json({ timezone, days: out });
  }),
);

const BookSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name').max(80),
  businessType: z.string().trim().min(2, 'Tell us your line of work').max(80),
  phone: z.string().trim().min(5, 'Please enter a phone number').max(40),
  email: z.string().trim().toLowerCase().email('Please enter a valid email').max(120).optional(),
  /** Free-text: anything worth mentioning / whether they need a custom system. */
  notes: z.string().trim().max(800).optional(),
  /** Quick flag surfaced as a tag on the founder's calendar entry. */
  customSystem: z.boolean().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bad date'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Bad time'),
});

/** Books an intro call into the founder's calendar from the public site. */
bookingRouter.post(
  '/',
  bookLimiter,
  asyncHandler(async (req, res) => {
    const body = BookSchema.parse(req.body);

    // Pack everything the founder needs to see at a glance into the calendar
    // entry's reason — business type, custom-system flag, contact email, notes.
    const parts = [body.businessType];
    if (body.customSystem) parts.push('wants a custom system');
    if (body.email) parts.push(body.email);
    if (body.notes) parts.push(body.notes);
    const reason = parts.join(' · ');

    try {
      const entry = await bookFounderCall({
        customerName: body.name,
        customerPhone: body.phone,
        reason,
        date: body.date,
        time: body.time,
        durationMinutes: 30,
      });
      res.status(201).json({
        ok: true,
        timezone: entry.timezone,
        date: entry.local.date,
        time: entry.local.time,
        durationMinutes: entry.durationMinutes,
      });
    } catch (err) {
      // Surface the booking engine's speakable conflict messages as-is so the
      // form can tell the prospect to pick another slot.
      if (err instanceof HttpError) throw err;
      throw new HttpError(500, 'Could not book that time. Please try again.', 'INTERNAL');
    }
  }),
);
