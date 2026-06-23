import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma';
import { findUpcomingAppointments, updateAppointment } from './appointment.service';
import { getCallForTenant } from './calllog.service';
import { listJobRequests, updateJobRequest } from './job.service';

/**
 * Tenant-isolation safety net. IDs are globally unique, so the danger is a
 * tenant-scoped read/write that forgets its `tenantId` filter — letting one
 * customer reach another's data. These tests seed data under tenant B, then
 * assert tenant A's scoped service calls can never see or mutate it. If anyone
 * later drops a tenant filter from one of these paths, CI goes red here.
 *
 * Hits a real Postgres (see vitest.integration.config.ts / `npm run test:integration`).
 */

const TZ = 'America/New_York';
const SHARED_PHONE = '+15557770000'; // same number under both — must still not cross over

let tenantA: string;
let tenantB: string;
let bAppointmentId: string;
let bJobId: string;
let bCallId: string;

async function makeTenant(name: string): Promise<string> {
  const t = await prisma.tenant.create({
    data: {
      companyName: name,
      slug: `iso-${randomUUID()}`,
      industry: 'CONSTRUCTION',
      agentSettings: {
        create: {
          systemPrompt: 'test',
          firstMessage: 'Hi.',
          voicemailGreeting: 'Leave a message.',
          businessHours: {},
          timezone: TZ,
        },
      },
    },
  });
  return t.id;
}

beforeAll(async () => {
  tenantA = await makeTenant('Isolation A');
  tenantB = await makeTenant('Isolation B');

  const start = new Date(Date.now() + 2 * 86_400_000);
  const appt = await prisma.appointment.create({
    data: {
      tenantId: tenantB,
      customerName: 'B Customer',
      customerPhone: SHARED_PHONE,
      startsAt: start,
      endsAt: new Date(start.getTime() + 30 * 60_000),
      timezone: TZ,
    },
  });
  bAppointmentId = appt.id;

  const job = await prisma.jobRequest.create({
    data: { tenantId: tenantB, customerName: 'B Job', customerPhone: SHARED_PHONE, urgency: 'ROUTINE' },
  });
  bJobId = job.id;

  const call = await prisma.callLog.create({
    data: {
      tenantId: tenantB,
      externalCallId: `iso-${randomUUID()}`,
      startedAt: new Date(),
      callerNumber: SHARED_PHONE,
      transcript: 'B private transcript',
    },
  });
  bCallId = call.id;
});

afterAll(async () => {
  // Cascade removes settings, appointments, jobs, call logs.
  if (tenantA) await prisma.tenant.delete({ where: { id: tenantA } }).catch(() => {});
  if (tenantB) await prisma.tenant.delete({ where: { id: tenantB } }).catch(() => {});
  await prisma.$disconnect();
});

describe('tenant isolation', () => {
  it('appointment lookup never returns another tenant’s appointment (even on a shared phone)', async () => {
    const matches = await findUpcomingAppointments({
      tenantId: tenantA,
      timezone: TZ,
      phone: SHARED_PHONE,
      name: null,
      date: null,
      demoSessionId: null,
    });
    expect(matches.find((m) => m.id === bAppointmentId)).toBeUndefined();
    expect(matches).toHaveLength(0);
  });

  it('cannot update another tenant’s appointment by id', async () => {
    await expect(updateAppointment(tenantA, bAppointmentId, { status: 'CANCELLED' }, null)).rejects.toThrow();
    const still = await prisma.appointment.findUnique({ where: { id: bAppointmentId } });
    expect(still?.status).toBe('CONFIRMED'); // untouched
  });

  it('cannot read another tenant’s call log (recording/transcript) by id', async () => {
    await expect(getCallForTenant(tenantA, bCallId)).rejects.toThrow();
  });

  it('job queue never includes another tenant’s job, and it can’t be updated by id', async () => {
    const jobs = await listJobRequests(tenantA);
    expect(jobs.find((j) => j.id === bJobId)).toBeUndefined();
    await expect(updateJobRequest(tenantA, bJobId, { status: 'CONTACTED' })).rejects.toThrow();
  });
});
