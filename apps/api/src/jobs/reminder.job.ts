import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { sendReminder, isSmsAvailable } from '../services/sms.service';

/**
 * Scans for confirmed appointments due for an SMS reminder and fires them.
 * Uses a ±10-minute window around the target lead-time, so a 5-minute cron
 * interval guarantees every appointment is caught exactly once.
 *
 * The `reminder*SentAt` timestamps act as idempotency keys — a second pass
 * over the same appointment is a no-op.
 */
async function runReminderScan(): Promise<void> {
  if (!isSmsAvailable()) return;

  const now = new Date();

  // ── 24-hour window ─────────────────────────────────────────────────────────
  const window24hStart = new Date(now.getTime() + 23 * 60 * 60 * 1000 + 50 * 60 * 1000); // +23h50m
  const window24hEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 10 * 60 * 1000);   // +24h10m

  const due24h = await prisma.appointment.findMany({
    where: {
      status: 'CONFIRMED',
      demoSessionId: null,
      customerPhone: { not: null },
      reminder24hSentAt: null,
      startsAt: { gte: window24hStart, lte: window24hEnd },
    },
    select: { id: true },
  });

  // ── 1-hour window ──────────────────────────────────────────────────────────
  const window1hStart = new Date(now.getTime() + 50 * 60 * 1000);  // +50m
  const window1hEnd = new Date(now.getTime() + 70 * 60 * 1000);    // +70m

  const due1h = await prisma.appointment.findMany({
    where: {
      status: 'CONFIRMED',
      demoSessionId: null,
      customerPhone: { not: null },
      reminder1hSentAt: null,
      startsAt: { gte: window1hStart, lte: window1hEnd },
    },
    select: { id: true },
  });

  // Send all reminders concurrently but catch individually so one failure
  // doesn't block the rest.
  await Promise.allSettled([
    ...due24h.map((a) => sendReminder(a.id, '24h').catch((err) => console.error('[sms] 24h reminder failed', a.id, err))),
    ...due1h.map((a) => sendReminder(a.id, '1h').catch((err) => console.error('[sms] 1h reminder failed', a.id, err))),
  ]);
}

/** Start the reminder cron. Call once at server startup. */
export function startReminderJob(): void {
  if (!isSmsAvailable()) {
    console.log('[sms] Twilio not configured — reminder job disabled.');
    return;
  }
  // Every 5 minutes.
  cron.schedule('*/5 * * * *', () => {
    runReminderScan().catch((err) => console.error('[sms] Reminder scan error:', err));
  });
  console.log('[sms] Reminder job started (every 5 min).');
}
