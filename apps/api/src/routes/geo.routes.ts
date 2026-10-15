import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../lib/http';
import { clientIp, detectIpCountry, parsePublicIp } from '../services/geo.service';

export const geoRouter = Router();

/* The marketing pages render once per visitor, so this gets a generous
 * per-IP budget; the lookup behind it is best-effort and cheap to fail. */
const geoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many requests. Please wait a few minutes.', code: 'RATE_LIMITED' } },
});

/**
 * The visitor's country, resolved by the same geo service the demo gate
 * uses (services/geo.service: X-Forwarded-For, then ipapi.co). This is
 * the single server-side source the public pricing pages read: Canadian
 * visitors see Canadian prices, everyone else sees US prices. Display
 * only, never eligibility: the CAD price book itself is granted by the
 * business verification in services/pricing-region.service.
 *
 * The pricing pages reach this endpoint server-to-server from the web
 * tier, and the browser's X-Forwarded-For chain does not survive that
 * hop, so the web tier sends the visitor IP in a dedicated `x-visitor-ip`
 * header instead. A valid public IP in that header wins; an absent or
 * invalid one falls back to the connection IP exactly as before.
 * Direct browser calls keep working unchanged: they send no header and
 * the API edge sees the real client.
 *
 * Returns { country: null } when the country cannot be determined;
 * callers treat null as "not Canada".
 */
geoRouter.get(
  '/country',
  geoLimiter,
  asyncHandler(async (req, res) => {
    const ip = parsePublicIp(req.headers['x-visitor-ip']) ?? clientIp(req);
    const country = await detectIpCountry(ip);
    res.json({ country });
  }),
);
