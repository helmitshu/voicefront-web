import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import { corsOrigins } from '../config/env';
import { signOAuthStateToken, verifyOAuthStateToken } from '../lib/jwt';
import type { ProviderId } from '../services/calendar/types';
import {
  buildAuthUrl,
  connectFromCode,
  disconnect,
  getCalendarStatus,
  updateConnectionPrefs,
} from '../services/calendar.service';

export const calendarRouter = Router();

const WEB_APP_URL = corsOrigins[0] ?? 'http://localhost:3000';
const SETTINGS_RETURN = `${WEB_APP_URL}/dashboard/settings`;

function parseProvider(raw: string): ProviderId {
  const up = raw.toUpperCase();
  if (up === 'GOOGLE' || up === 'MICROSOFT') return up;
  throw new HttpError(404, 'Unknown calendar provider.', 'UNKNOWN_PROVIDER');
}

/* --------------------------------- status --------------------------------- */

calendarRouter.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    res.json(await getCalendarStatus(tenantId));
  }),
);

/* --------------------------------- connect -------------------------------- */

// Returns the provider consent URL; the SPA then navigates the browser to it.
calendarRouter.get(
  '/:provider/connect',
  requireAuth,
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const provider = parseProvider(req.params.provider);
    const state = signOAuthStateToken({ tenantId, provider });
    const url = await buildAuthUrl(provider, state);
    res.json({ url });
  }),
);

// OAuth redirect target — a plain browser navigation, so NO auth middleware.
// Trust comes from the signed `state` we issued at /connect.
calendarRouter.get(
  '/:provider/callback',
  asyncHandler(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const back = (status: string) =>
      res.redirect(`${SETTINGS_RETURN}?calendar=${status}&provider=${provider.toLowerCase()}`);

    const error = typeof req.query.error === 'string' ? req.query.error : null;
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    if (error || !code || !state) return back('error');

    try {
      const claims = verifyOAuthStateToken(state);
      if (claims.prov !== provider) return back('error');
      await connectFromCode(claims.tid, provider, code);
      return back('connected');
    } catch {
      return back('error');
    }
  }),
);

/* ------------------------------- manage ----------------------------------- */

calendarRouter.post(
  '/:provider/disconnect',
  requireAuth,
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    await disconnect(tenantId, parseProvider(req.params.provider));
    res.json({ ok: true });
  }),
);

const PrefsSchema = z
  .object({ writeEnabled: z.boolean(), blockBusy: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

calendarRouter.patch(
  '/:provider',
  requireAuth,
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const provider = parseProvider(req.params.provider);
    const prefs = PrefsSchema.parse(req.body);
    await updateConnectionPrefs(tenantId, provider, prefs);
    res.json({ ok: true });
  }),
);
