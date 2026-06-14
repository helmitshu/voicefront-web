import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env';
import { HttpError } from './http';

const AccessTokenPayload = z.object({
  sub: z.string().min(1),
  tid: z.string().min(1),
  role: z.enum(['OWNER', 'MANAGER', 'AGENT']),
  typ: z.literal('access'),
});
export type AccessTokenPayload = z.infer<typeof AccessTokenPayload>;

const MediaTokenPayload = z.object({
  cid: z.string().min(1), // call log id
  tid: z.string().min(1), // tenant id
  typ: z.literal('media'),
});
export type MediaTokenPayload = z.infer<typeof MediaTokenPayload>;

export function signAccessToken(input: { userId: string; tenantId: string; role: AccessTokenPayload['role'] }): string {
  const payload: AccessTokenPayload = {
    sub: input.userId,
    tid: input.tenantId,
    role: input.role,
    typ: 'access',
  };
  // `expiresIn` accepts vercel/ms strings like "7d".
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = decodeOrThrow(token);
  const parsed = AccessTokenPayload.safeParse(decoded);
  if (!parsed.success) {
    throw new HttpError(401, 'Your session is invalid. Please sign in again.', 'INVALID_TOKEN');
  }
  return parsed.data;
}

/** Short-lived token embedded in audio URLs so <audio> can stream without headers. */
export function signMediaToken(input: { callLogId: string; tenantId: string }): string {
  const payload: MediaTokenPayload = { cid: input.callLogId, tid: input.tenantId, typ: 'media' };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.MEDIA_TOKEN_TTL_SECONDS });
}

export function verifyMediaToken(token: string): MediaTokenPayload {
  const decoded = decodeOrThrow(token);
  const parsed = MediaTokenPayload.safeParse(decoded);
  if (!parsed.success) {
    throw new HttpError(401, 'This audio link has expired. Reload the call to get a fresh one.', 'INVALID_TOKEN');
  }
  return parsed.data;
}

function decodeOrThrow(token: string): unknown {
  try {
    return jwt.verify(token, env.JWT_SECRET);
  } catch {
    throw new HttpError(401, 'Your session has expired. Please sign in again.', 'INVALID_TOKEN');
  }
}
