import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import {
  bookAppointment,
  findFreeSlots,
  findUpcomingAppointments,
  updateAppointment,
  utcToZonedParts,
} from './appointment.service';
import { resolveBookingContext } from './providers.service';

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

describe('appointment lookup by phone (reschedule / cancel)', () => {
  const PHONE = '+1 (555) 222-3333';
  const OTHER = '+1 555 999 0000';

  function bookFor(phone: string, time: string, name = 'Jamie Rivera') {
    return bookAppointment({
      tenantId,
      timezone: TZ,
      businessHours: HOURS,
      customerName: name,
      customerPhone: phone,
      date: TEST_DATE,
      time,
      source: 'VOICE_AGENT',
    });
  }

  it('finds an appointment by phone regardless of formatting', async () => {
    await bookFor(PHONE, '09:00');
    await bookFor(OTHER, '10:00');

    const matches = await findUpcomingAppointments({ tenantId, timezone: TZ, phone: '5552223333' });
    expect(matches).toHaveLength(1);
    expect(matches[0].local.time).toBe('09:00');
  });

  it('returns nothing when the phone matches no booking and no name is given', async () => {
    await bookFor(PHONE, '09:00');
    const matches = await findUpcomingAppointments({ tenantId, timezone: TZ, phone: '+1 555 000 1111' });
    expect(matches).toHaveLength(0);
  });

  it('falls back to name when the caller rings from a different line', async () => {
    await bookFor(PHONE, '09:00', 'Dana Lee');
    const matches = await findUpcomingAppointments({
      tenantId,
      timezone: TZ,
      phone: '+1 555 000 1111',
      name: 'dana',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].customerName).toBe('Dana Lee');
  });

  it('reschedules then cancels a looked-up appointment', async () => {
    const booked = await bookFor(PHONE, '09:00');

    const [found] = await findUpcomingAppointments({ tenantId, timezone: TZ, phone: PHONE });
    expect(found.id).toBe(booked.id);

    const moved = await updateAppointment(tenantId, found.id, { date: TEST_DATE, time: '13:00' }, HOURS);
    expect(utcToZonedParts(moved.startsAt, TZ).time).toBe('13:00');

    await updateAppointment(tenantId, found.id, { status: 'CANCELLED' }, null);
    const after = await findUpcomingAppointments({ tenantId, timezone: TZ, phone: PHONE });
    expect(after).toHaveLength(0);
  });
});

describe('per-provider availability and assignment', () => {
  let providerA: string;
  let providerB: string;

  beforeAll(async () => {
    const [a, b] = await Promise.all([
      prisma.provider.create({ data: { tenantId, name: 'Dr. Alice' } }),
      prisma.provider.create({ data: { tenantId, name: 'Dr. Bob' } }),
    ]);
    providerA = a.id;
    providerB = b.id;
  });

  afterAll(async () => {
    await prisma.provider.deleteMany({ where: { tenantId } });
  });

  function bookWith(providerId: string | null, time: string, candidateProviderIds?: string[]) {
    return bookAppointment({
      tenantId,
      timezone: TZ,
      businessHours: HOURS,
      customerName: 'Pat Caller',
      date: TEST_DATE,
      time,
      source: 'VOICE_AGENT',
      providerId,
      candidateProviderIds,
    });
  }

  it('lets two providers hold the same slot', async () => {
    const a = await bookWith(providerA, '10:00');
    const b = await bookWith(providerB, '10:00');
    expect(a.providerId).toBe(providerA);
    expect(b.providerId).toBe(providerB);
  });

  it('still blocks double-booking the same provider', async () => {
    await bookWith(providerA, '10:00');
    await expect(bookWith(providerA, '10:00')).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
  });

  it('auto-assigns the first free provider in the candidate pool', async () => {
    await bookWith(providerA, '10:00'); // A is now busy at 10:00
    const auto = await bookWith(null, '10:00', [providerA, providerB]);
    expect(auto.providerId).toBe(providerB);
  });

  it('rejects when every candidate provider is busy', async () => {
    await bookWith(providerA, '10:00');
    await bookWith(providerB, '10:00');
    await expect(bookWith(null, '10:00', [providerA, providerB])).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
  });

  it('keeps a slot offered until all candidates are booked', async () => {
    await bookWith(providerA, '10:00');
    const partial = await findFreeSlots({
      tenantId,
      timezone: TZ,
      businessHours: HOURS,
      date: TEST_DATE,
      providerIds: [providerA, providerB],
    });
    expect(partial.freeSlots).toContain('10:00'); // B is still free

    await bookWith(providerB, '10:00');
    const full = await findFreeSlots({
      tenantId,
      timezone: TZ,
      businessHours: HOURS,
      date: TEST_DATE,
      providerIds: [providerA, providerB],
    });
    expect(full.freeSlots).not.toContain('10:00');
  });
});

describe('resolveBookingContext', () => {
  let hygienistId: string;
  let cleaningId: string;

  beforeAll(async () => {
    const [dentist, hygienist] = await Promise.all([
      prisma.provider.create({ data: { tenantId, name: 'Dr. Dana' } }),
      prisma.provider.create({ data: { tenantId, name: 'Hank Hygiene' } }),
    ]);
    hygienistId = hygienist.id;
    const cleaning = await prisma.service.create({
      data: {
        tenantId,
        name: 'Cleaning',
        durationMinutes: 45,
        providers: { connect: [{ id: hygienist.id }] },
      },
    });
    cleaningId = cleaning.id;
    void dentist;
  });

  afterAll(async () => {
    await prisma.service.deleteMany({ where: { tenantId } });
    await prisma.provider.deleteMany({ where: { tenantId } });
  });

  it('sets duration and narrows the pool from the service', async () => {
    const ctx = await resolveBookingContext(tenantId, { serviceName: 'cleaning' });
    expect(ctx.serviceId).toBe(cleaningId);
    expect(ctx.durationMinutes).toBe(45);
    expect(ctx.candidateProviderIds).toEqual([hygienistId]);
    expect(ctx.providerId).toBeNull();
  });

  it('honors a named provider qualified for the service', async () => {
    const ctx = await resolveBookingContext(tenantId, { serviceName: 'cleaning', providerName: 'Hank' });
    expect(ctx.providerId).toBe(hygienistId);
  });

  it('declines a named provider not qualified, with a spoken note', async () => {
    const ctx = await resolveBookingContext(tenantId, { serviceName: 'cleaning', providerName: 'Dr. Dana' });
    expect(ctx.providerId).toBeNull();
    expect(ctx.note).toMatch(/doesn't handle/);
  });
});
