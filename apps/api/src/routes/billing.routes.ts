import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import {
  completeCheckout,
  createCheckoutSession,
  createPortalSession,
  getBillingStatus,
  handleStripeEvent,
  recordStripeEvent,
  startCompedTrial,
  verifyWebhookEvent,
} from '../services/billing.service';

export const billingRouter = Router();

/**
 * Billing is the owner's business: checkout and the customer portal (which
 * exposes invoices and the card's last digits) are OWNER-only. Status is
 * readable by any signed-in role so the dashboard can render for staff.
 */
const ownerOnly = [requireAuth, requireRole('OWNER')];

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts. Please wait a few minutes.', code: 'RATE_LIMITED' } },
});

/**
 * The body schema accepts a tier and nothing else: no price, amount,
 * currency, or region field exists, so a client cannot smuggle a price
 * book. 'GROWTH' is a known tier that is never sold — it gets its own
 * refusal pointing at the waitlist instead of a validation shrug.
 */
const CheckoutSchema = z
  .object({
    tier: z.enum(['STARTER', 'CORE', 'GROWTH']),
    whiteGlove: z.boolean().optional(),
  })
  .strict();

billingRouter.post(
  '/checkout',
  ...ownerOnly,
  checkoutLimiter,
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const body = CheckoutSchema.parse(req.body);
    if (body.tier === 'GROWTH') {
      throw new HttpError(
        400,
        'Growth is not on sale yet. Join the waitlist on the pricing page and we will reach out.',
        'TIER_NOT_AVAILABLE',
      );
    }
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { email: true },
    });
    if (!user) throw new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');
    const result = await createCheckoutSession({
      tenantId: auth.tenantId,
      email: user.email,
      tier: body.tier,
      whiteGlove: body.whiteGlove,
    });
    res.json(result);
  }),
);

const CompleteSchema = z.object({ sessionId: z.string().trim().min(1).max(200) }).strict();

billingRouter.post(
  '/checkout/complete',
  ...ownerOnly,
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { sessionId } = CompleteSchema.parse(req.body);
    const status = await completeCheckout({ tenantId: auth.tenantId, sessionId });
    res.json({ billing: status });
  }),
);

billingRouter.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const status = await getBillingStatus(auth.tenantId);
    res.json({ billing: status });
  }),
);

billingRouter.post(
  '/portal',
  ...ownerOnly,
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const result = await createPortalSession({ tenantId: auth.tenantId });
    res.json(result);
  }),
);

/**
 * The comped trial: start a trial with no card and no Stripe. Same body
 * discipline as checkout (a tier, an optional white-glove flag, nothing
 * else). The service refuses with 403 unless the founder has switched the
 * billing gate off in Admin → Keys & config; with the gate on, this route
 * grants nothing.
 */
const CompedTrialSchema = z
  .object({
    tier: z.enum(['STARTER', 'CORE', 'GROWTH']),
    whiteGlove: z.boolean().optional(),
  })
  .strict();

billingRouter.post(
  '/comped-trial',
  ...ownerOnly,
  checkoutLimiter,
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const body = CompedTrialSchema.parse(req.body);
    if (body.tier === 'GROWTH') {
      throw new HttpError(
        400,
        'Growth is not on sale yet. Join the waitlist on the pricing page and we will reach out.',
        'TIER_NOT_AVAILABLE',
      );
    }
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { email: true },
    });
    if (!user) throw new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');
    const status = await startCompedTrial({
      tenantId: auth.tenantId,
      tier: body.tier,
      whiteGlove: body.whiteGlove,
      actorEmail: user.email,
    });
    res.json({ billing: status });
  }),
);

/**
 * Stripe webhook. Public (Stripe sends no JWT) and mounted in app.ts with
 * a raw body parser on this exact path BEFORE the global JSON parser —
 * signature verification runs over the untouched bytes, and a body that
 * was parsed and re-serialized fails closed with 400 and no state change.
 * The event is recorded in the ledger before dispatch, so a redelivery
 * answers 200 without reprocessing.
 */
billingRouter.post(
  '/webhook',
  asyncHandler(async (req: Request, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signatureHeader = req.headers['stripe-signature'];
    const event = verifyWebhookEvent(rawBody, typeof signatureHeader === 'string' ? signatureHeader : undefined);
    const fresh = await recordStripeEvent(event);
    if (fresh) {
      await handleStripeEvent(event);
    }
    res.json({ received: true });
  }),
);
