import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { bookAppointment, updateAppointment, utcToZonedParts } from './appointment.service';

/**
 * Integration tests for the double-booking guarantee. These hit a REAL Postgres
 * (the advisory lock + READ COMMITTED visibility can't be exercised in-memory),
 * so they run against a dedicated test database and are kept out of the default
 * `npm test` unit run. See vitest.integration.config.ts / `npm run test:integration`.
 */

const TZ = 'America/New_York';
// Open 24/7 so any future date/time is in-hours; we're testing concurrency, not hours.
const ALWAYS_OPEN = { enabled: true, open: '00:00', close: '23:59' };
const HOURS = {
  mon: ALWAYS_OPEN,
  tue: ALWAYS_OPEN,
  wed: ALWAYS_OPEN,
  thu: ALWAYS_OPEN,
  fri: ALWAYS_OPEN,
  sat: ALWAYS_OPEN,
  sun: ALWAYS_OPEN,
};

// A few days out: comfortably future and well inside the 60-day horizon.
const TEST_DATE = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

let tenantId: string;

function book(time: string) {
  return bookAppointment({
    tenantId,
    timezone: TZ,
    businessHours: HOURS,
    customerName: 'Test Caller',
    date: TEST_DATE,
    time,
    source: 'MANUAL',
  });
}

beforeAll(async () => {
  const tenant = await prisma.tenant.create({
    data: {
      companyName: 'Integration Test Co',
      slug: `inttest-${randomUUID()}`,
      industry: 'CLINIC',
      agentSettings: {
        create: {
          systemPrompt: 'test',
          firstMessage: 'Hi, this is the test line.',
          voicemailGreeting: 'Please leave a message.',
          businessHours: HOURS,
          timezone: TZ,
        },
      },
    },
  });
  tenantId = tenant.id;
});

beforeEach(async () => {
  await prisma.appointment.deleteMany({ where: { tenantId } });
});

afterAll(async () => {
  // Cascade removes agentSettings + appointments.
  if (tenantId) await prisma.tenant.delete({ where: { id: tenantId } });
  await prisma.$disconnect();
});

describe('booking concurrency', () => {
  it('lets only one of two simultaneous bookings take the same slot', async () => {
    const results = await Promise.allSettled([book('10:00'), book('10:00')]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(HttpError);
    expect((rejected[0].reason as HttpError).code).toBe('SLOT_TAKEN');

    const count = await prisma.appointment.count({ where: { tenantId, status: 'CONFIRMED' } });
    expect(count).toBe(1);
  });

  it('refuses a manual reschedule onto a slot another appointment already holds', async () => {
    await book('10:00');
    const b = await book('11:00');

    await expect(updateAppointment(tenantId, b.id, { time: '10:00' }, HOURS)).rejects.toMatchObject({
      code: 'SLOT_TAKEN',
    });
  });

  it('allows rescheduling an appointment without clashing against itself', async () => {
    const a = await book('10:00');

    const moved = await updateAppointment(tenantId, a.id, { time: '12:00' }, HOURS);
    expect(utcToZonedParts(moved.startsAt, TZ).time).toBe('12:00');

    // A non-time edit must not trip the overlap guard either.
    const edited = await updateAppointment(tenantId, a.id, { reason: 'updated reason' }, HOURS);
    expect(edited.reason).toBe('updated reason');
  });

  it('lets only one of two simultaneous reschedules land on the same target slot', async () => {
    const a = await book('10:00');
    const b = await book('11:00');

    const results = await Promise.allSettled([
      updateAppointment(tenantId, a.id, { time: '15:00' }, HOURS),
      updateAppointment(tenantId, b.id, { time: '15:00' }, HOURS),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as HttpError).code).toBe('SLOT_TAKEN');
  });
});
