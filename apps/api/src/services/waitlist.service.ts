import type { Appointment, Prisma, Waitlist, WaitlistStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { utcToZonedParts, to12h } from './appointment.service';
import { sendWaitlistOpening } from './sms.service';

/** Tenant-facing waitlist row. */
export interface WaitlistDto {
  id: string;
  customerName: string;
  customerPhone: string;
  providerId: string | null;
  serviceId: string | null;
  note: string | null;
  status: WaitlistStatus;
  notifiedAt: string | null;
  createdAt: string;
}

export function toWaitlistDto(w: Waitlist): WaitlistDto {
  return {
    id: w.id,
    customerName: w.customerName,
    customerPhone: w.customerPhone,
    providerId: w.providerId,
    serviceId: w.serviceId,
    note: w.note,
    status: w.status,
    notifiedAt: w.notifiedAt ? w.notifiedAt.toISOString() : null,
    createdAt: w.createdAt.toISOString(),
  };
}

export async function listWaitlist(
  tenantId: string,
  status?: WaitlistStatus,
): Promise<Waitlist[]> {
  const where: Prisma.WaitlistWhereInput = { tenantId };
  if (status) where.status = status;
  return prisma.waitlist.findMany({
    where,
    // Active entries first, then oldest-waiting at the top (first to be offered).
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    take: 500,
  });
}

export interface AddWaitlistInput {
  tenantId: string;
  customerName: string;
  customerPhone: string;
  providerId?: string | null;
  serviceId?: string | null;
  note?: string | null;
}

export async function addWaitlistEntry(input: AddWaitlistInput): Promise<Waitlist> {
  // Guard provider/service belong to this tenant so a crafted id can't attach
  // an entry to another tenant's resource.
  if (input.providerId) {
    const ok = await prisma.provider.findFirst({
      where: { id: input.providerId, tenantId: input.tenantId },
      select: { id: true },
    });
    if (!ok) throw new HttpError(400, 'Unknown provider.', 'BAD_PROVIDER');
  }
  if (input.serviceId) {
    const ok = await prisma.service.findFirst({
      where: { id: input.serviceId, tenantId: input.tenantId },
      select: { id: true },
    });
    if (!ok) throw new HttpError(400, 'Unknown service.', 'BAD_SERVICE');
  }

  return prisma.waitlist.create({
    data: {
      tenantId: input.tenantId,
      customerName: input.customerName.trim(),
      customerPhone: input.customerPhone.trim(),
      providerId: input.providerId ?? null,
      serviceId: input.serviceId ?? null,
      note: input.note?.trim() || null,
    },
  });
}

export async function setWaitlistStatus(
  tenantId: string,
  id: string,
  status: WaitlistStatus,
): Promise<Waitlist> {
  const existing = await prisma.waitlist.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!existing) throw new HttpError(404, 'Waitlist entry not found.', 'NOT_FOUND');
  return prisma.waitlist.update({ where: { id }, data: { status } });
}

export async function removeWaitlistEntry(tenantId: string, id: string): Promise<void> {
  const existing = await prisma.waitlist.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!existing) throw new HttpError(404, 'Waitlist entry not found.', 'NOT_FOUND');
  await prisma.waitlist.delete({ where: { id } });
}

/**
 * A CONFIRMED appointment was just cancelled, so its slot is free. Find the
 * oldest WAITING entry that fits (wants this provider, or any), text them that
 * a spot opened, and flip them to NOTIFIED. Best-effort and fire-and-forget:
 * called via dynamic import from appointment.service to keep the graph acyclic.
 *
 * We try entries oldest-first and stop at the first one we actually text — an
 * opted-out or un-sendable entry is skipped without consuming the opening.
 */
export async function notifyWaitlistForOpening(appointment: Appointment): Promise<void> {
  // No phone-based reach-out is possible if SMS isn't even on for this tenant.
  const settings = await prisma.agentSettings.findUnique({
    where: { tenantId: appointment.tenantId },
    select: { smsEnabled: true, smsWaitlist: true, smsWaitlistTemplate: true },
  });
  if (!settings?.smsEnabled || !settings.smsWaitlist) return;

  const tenant = await prisma.tenant.findUnique({
    where: { id: appointment.tenantId },
    select: { companyName: true },
  });
  if (!tenant) return;

  // Candidates: WAITING, and either provider-agnostic or wanting this provider.
  const candidates = await prisma.waitlist.findMany({
    where: {
      tenantId: appointment.tenantId,
      status: 'WAITING',
      OR: [{ providerId: null }, { providerId: appointment.providerId ?? undefined }],
    },
    orderBy: { createdAt: 'asc' },
    take: 25,
  });
  if (candidates.length === 0) return;

  const local = utcToZonedParts(appointment.startsAt, appointment.timezone);
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: appointment.timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(appointment.startsAt);
  const timeLabel = to12h(local.time);

  for (const entry of candidates) {
    const sent = await sendWaitlistOpening({
      tenantId: appointment.tenantId,
      phone: entry.customerPhone,
      customerName: entry.customerName,
      businessName: tenant.companyName,
      date: dateLabel,
      time: timeLabel,
      template: settings.smsWaitlistTemplate,
    }).catch(() => false);

    if (sent) {
      await prisma.waitlist.update({
        where: { id: entry.id },
        data: { status: 'NOTIFIED', notifiedAt: new Date() },
      });
      return; // One opening → one notification.
    }
  }
}
