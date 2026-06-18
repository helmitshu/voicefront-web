import { randomInt } from 'node:crypto';
import type { Prisma, AccessCode } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';

/**
 * One-time invitation codes. The founder generates a code after vetting a
 * prospect (demo / sales call); the prospect must enter it to create an
 * account. A code is spent the instant it's redeemed, inside the signup
 * transaction, so it can never be reused or claimed twice in a race.
 */

// Unambiguous charset — no O/0, I/1, L — so codes are easy to read aloud and type.
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomGroup(len: number): string {
  let out = '';
  for (let i = 0; i < len; i += 1) out += CHARSET[randomInt(CHARSET.length)];
  return out;
}

/** Normalizes user input to the stored form: uppercase, trimmed. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export interface AccessCodeView {
  id: string;
  code: string;
  label: string | null;
  email: string | null;
  createdBy: string;
  used: boolean;
  usedAt: string | null;
  createdAt: string;
}

function toView(c: AccessCode): AccessCodeView {
  return {
    id: c.id,
    code: c.code,
    label: c.label,
    email: c.email,
    createdBy: c.createdBy,
    used: c.usedAt !== null,
    usedAt: c.usedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Mints a fresh code, retrying on the (vanishingly rare) unique collision. */
export async function generateAccessCode(input: {
  label?: string | null;
  email?: string | null;
  createdBy: string;
}): Promise<AccessCodeView> {
  const label = input.label?.trim() || null;
  const email = input.email?.trim().toLowerCase() || null;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = `VF-${randomGroup(4)}-${randomGroup(4)}`;
    try {
      const row = await prisma.accessCode.create({
        data: { code, label, email, createdBy: input.createdBy },
      });
      return toView(row);
    } catch (err) {
      const isDup = (err as { code?: unknown })?.code === 'P2002';
      if (!isDup) throw err;
      // collision — loop and try a new code
    }
  }
  throw new HttpError(500, 'Could not generate a code. Please try again.', 'CODE_GEN_FAILED');
}

/** Recent codes, newest first, for the admin list. */
export async function listAccessCodes(limit = 100): Promise<AccessCodeView[]> {
  const rows = await prisma.accessCode.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map(toView);
}

/** Revokes an unused code. Spent codes are kept as an audit record. */
export async function revokeAccessCode(id: string): Promise<void> {
  const row = await prisma.accessCode.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, 'Code not found.', 'NOT_FOUND');
  if (row.usedAt) throw new HttpError(409, 'That code has already been used.', 'CODE_USED');
  await prisma.accessCode.delete({ where: { id } });
}

/**
 * Atomically redeems a code inside the signup transaction. Returns true only
 * if a still-valid code was consumed — the conditional updateMany (code +
 * usedAt:null) makes the check-and-spend a single race-free step.
 */
export async function consumeAccessCode(
  tx: Prisma.TransactionClient,
  rawCode: string,
  tenantId: string,
): Promise<boolean> {
  const code = normalizeCode(rawCode);
  if (!code) return false;
  const result = await tx.accessCode.updateMany({
    where: { code, usedAt: null },
    data: { usedAt: new Date(), usedByTenantId: tenantId },
  });
  return result.count === 1;
}
