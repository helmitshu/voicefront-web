import type { PooledNumber } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { isE164, normalizePhone } from '../lib/phone';

/**
 * Shared pool of pre-provisioned Vapi numbers. The operator adds numbers (each
 * already pointed at our inbound webhook in Vapi); onboarding claims one when a
 * tenant goes live, so signup needs no manual number assignment. Releasing a
 * tenant returns its number to the pool for reuse.
 */

export interface PoolEntry {
  id: string;
  number: string;
  country: string;
  vapiPhoneId: string | null;
  assignedTenantId: string | null;
  assignedAt: string | null;
  createdAt: string;
}

export function toPoolEntry(n: PooledNumber): PoolEntry {
  return {
    id: n.id,
    number: n.number,
    country: n.country,
    vapiPhoneId: n.vapiPhoneId,
    assignedTenantId: n.assignedTenantId,
    assignedAt: n.assignedAt ? n.assignedAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  };
}

export async function listPool(): Promise<PooledNumber[]> {
  return prisma.pooledNumber.findMany({ orderBy: [{ assignedTenantId: 'asc' }, { createdAt: 'asc' }] });
}

/** Count of numbers free to claim — surfaced so the operator can refill in time. */
export async function availableCount(): Promise<number> {
  return prisma.pooledNumber.count({ where: { assignedTenantId: null } });
}

export async function addNumber(input: {
  number: string;
  country?: string;
  vapiPhoneId?: string | null;
}): Promise<PooledNumber> {
  const number = normalizePhone(input.number);
  if (!isE164(number)) {
    throw new HttpError(400, 'Use E.164 format, e.g. +15551234567.', 'BAD_NUMBER');
  }
  const exists = await prisma.pooledNumber.findUnique({ where: { number } });
  if (exists) {
    throw new HttpError(409, 'That number is already in the pool.', 'NUMBER_EXISTS');
  }
  return prisma.pooledNumber.create({
    data: {
      number,
      country: (input.country ?? 'US').toUpperCase().slice(0, 2),
      vapiPhoneId: input.vapiPhoneId ?? null,
    },
  });
}

/** Removes a number from the pool. Refuses while it's assigned to a tenant. */
export async function removeNumber(id: string): Promise<void> {
  const entry = await prisma.pooledNumber.findUnique({ where: { id } });
  if (!entry) throw new HttpError(404, 'Number not found.', 'NOT_FOUND');
  if (entry.assignedTenantId) {
    throw new HttpError(
      409,
      'That number is assigned to a customer. Release it first by deleting the customer or clearing their number.',
      'NUMBER_ASSIGNED',
    );
  }
  await prisma.pooledNumber.delete({ where: { id } });
}

/**
 * Claims the next available pooled number for a tenant and writes it onto their
 * AgentSettings. Idempotent: if the tenant already holds a pooled number (or
 * already has an inbound number set), returns that without claiming another.
 * Returns the assigned E.164 number, or null when the pool is empty.
 *
 * The per-number claim is guarded by a conditional updateMany so two concurrent
 * activations can't grab the same row; we retry a few times against churn.
 */
export async function claimNumberForTenant(tenantId: string): Promise<string | null> {
  // Already has a pooled number? Keep it.
  const held = await prisma.pooledNumber.findUnique({ where: { assignedTenantId: tenantId } });
  if (held) return held.number;

  // Respect a number set by other means (e.g. founder-assigned via Vapi).
  const settings = await prisma.agentSettings.findUnique({
    where: { tenantId },
    select: { inboundPhoneNumber: true },
  });
  if (settings?.inboundPhoneNumber) return settings.inboundPhoneNumber;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await prisma.pooledNumber.findFirst({
      where: { assignedTenantId: null },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return null; // pool empty

    const res = await prisma.pooledNumber.updateMany({
      where: { id: candidate.id, assignedTenantId: null },
      data: { assignedTenantId: tenantId, assignedAt: new Date() },
    });
    if (res.count === 1) {
      await prisma.agentSettings.update({
        where: { tenantId },
        data: { inboundPhoneNumber: candidate.number },
      });
      return candidate.number;
    }
    // Someone else claimed it between read and write — try the next one.
  }
  return null;
}

/**
 * Returns a tenant's pooled number to the pool (and clears it off their
 * settings). Best-effort and safe to call when they hold none. Use when a
 * customer is deleted or cancelled so the number can be reused.
 */
export async function releaseNumberForTenant(tenantId: string): Promise<void> {
  const held = await prisma.pooledNumber.findUnique({ where: { assignedTenantId: tenantId } });
  if (!held) return;
  await prisma.pooledNumber.update({
    where: { id: held.id },
    data: { assignedTenantId: null, assignedAt: null },
  });
  await prisma.agentSettings
    .update({ where: { tenantId }, data: { inboundPhoneNumber: null } })
    .catch(() => undefined); // settings may already be gone on a hard delete
}
