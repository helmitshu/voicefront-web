import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../lib/http';
import { verifyAccessToken, type AccessTokenPayload } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { resolvePlatformRole } from '../services/platform-admin.service';

/**
 * Requires a valid `Authorization: Bearer <jwt>` header and attaches the
 * decoded identity to `req.auth` (typed in src/types/express.d.ts).
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED'));
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) {
    next(new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED'));
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.auth = { userId: payload.sub, tenantId: payload.tid, role: payload.role };
    next();
  } catch (err) {
    next(err);
  }
}

/** Role gate. Must be mounted after `requireAuth`. */
export function requireRole(...roles: Array<AccessTokenPayload['role']>): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED'));
      return;
    }
    if (!roles.includes(req.auth.role)) {
      next(new HttpError(403, 'You do not have permission to do that.', 'FORBIDDEN'));
      return;
    }
    next();
  };
}

/**
 * Founder/operator gate. Must be mounted after `requireAuth`. Access is
 * re-resolved from scratch on every request (env bootstrap admins + the
 * PlatformAdmin table) — a revoked operator loses access immediately, stale
 * JWTs notwithstanding. Admits both ADMIN and SUPPORT; the operator's level
 * is attached as `req.adminRole` for finer gating downstream.
 */
export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) {
    next(new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED'));
    return;
  }
  prisma.user
    .findUnique({ where: { id: req.auth.userId }, select: { email: true } })
    .then(async (user) => {
      if (!user) {
        next(new HttpError(403, 'This area is for platform operators only.', 'FORBIDDEN'));
        return;
      }
      const role = await resolvePlatformRole(user.email);
      if (!role) {
        next(new HttpError(403, 'This area is for platform operators only.', 'FORBIDDEN'));
        return;
      }
      req.adminEmail = user.email;
      req.adminRole = role;
      next();
    })
    .catch(next);
}

/**
 * Stricter gate for full-control actions (API keys, billing, managing other
 * admins). Must be mounted AFTER `requirePlatformAdmin`, which sets adminRole.
 */
export function requireFullAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.adminRole !== 'ADMIN') {
    next(
      new HttpError(
        403,
        'This action needs full admin access. Ask an admin to do it, or to upgrade your access.',
        'NEEDS_FULL_ADMIN',
      ),
    );
    return;
  }
  next();
}

/** Accessor for handlers behind `requirePlatformAdmin`. */
export function getAdminEmail(req: Request): string {
  if (!req.adminEmail) {
    throw new HttpError(403, 'This area is for platform operators only.', 'FORBIDDEN');
  }
  return req.adminEmail;
}

/** Accessor for the operator's access level (behind `requirePlatformAdmin`). */
export function getAdminRole(req: Request): 'ADMIN' | 'SUPPORT' {
  if (!req.adminRole) {
    throw new HttpError(403, 'This area is for platform operators only.', 'FORBIDDEN');
  }
  return req.adminRole;
}

/**
 * Convenience accessor for handlers behind `requireAuth`. Throws (rather than
 * returning undefined) so route code never needs non-null assertions.
 */
export function getAuth(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) {
    throw new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');
  }
  return req.auth;
}
