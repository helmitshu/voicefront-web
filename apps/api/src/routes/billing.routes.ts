import express, { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { logger } from '../lib/logger';
import { corsOrigins } from '../config/env';
import { getAuth, requireAuth } from '../middleware/auth';
import { getStripe } from '../lib/stripe';
import { getSettingValue } from '../services/platform-config.service';
import { clientIp, detectIpCountry } from '../services/geo.service';
import {
  createBillingPortalSession,
  createCheckoutSession,
  getBillingState,
  handleStripeEvent,
} from '../services/billing.service';

const TENANT_BILLING_SELECT = {
  id: true,
  subscriptionStatus: true,
  stripeSubscriptionId: true,
  planId: true,
  billingCurrency: true,
  trialEndsAt: true,
  createdAt: true,
} as const;

/** Resolve the web app base URL for Checkout return links. Prefer the request's
 *  Origin when it's an allowed CORS origin; else the first configured origin. */
function webBaseUrl(req: express.Request): string {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && corsOrigins.includes(origin)) return origin;
  return corsOrigins[0] ?? 'http://localhost:3000';
}

/* ----------------------------- Stripe webhook ----------------------------- */
/* Mounted BEFORE express.json so the raw body is available for signature
 * verification. Stripe is the source of truth; we just mirror state here.     */
export const billingWebhookRouter = Router();

billingWebhookRouter.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const [stripe, secret] = await Promise.all([getStripe(), getSettingValue('STRIPE_WEBHOOK_SECRET')]);
    const sig = req.headers['stripe-signature'];
    if (!stripe || !secret || typeof sig !== 'string') {
      res.status(503).json({ error: { message: 'Billing is not configured.', code: 'BILLING_NOT_CONFIGURED' } });
      return;
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, sig, secret);
    } catch (err) {
      logger.warn({ err }, 'stripe webhook signature verification failed');
      res.status(400).json({ error: { message: 'Invalid signature.', code: 'BAD_SIGNATURE' } });
      return;
    }
    try {
      await handleStripeEvent(event);
    } catch (err) {
      // Log but 200 so Stripe doesn't hammer retries on a transient app error;
      // the next lifecycle event (or a manual sync) will reconcile.
      logger.error({ err, type: event.type }, 'stripe webhook handling failed');
    }
    res.json({ received: true });
  }),
);

/* --------------------------- customer billing API ------------------------- */
export const billingRouter = Router();
billingRouter.use(requireAuth);

billingRouter.get(
  '/state',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const tenant = await prisma.tenant.findUnique({ where: { id: auth.tenantId }, select: TENANT_BILLING_SELECT });
    if (!tenant) throw new HttpError(404, 'Workspace not found.', 'NOT_FOUND');
    res.json({ billing: await getBillingState(tenant) });
  }),
);

billingRouter.post(
  '/checkout',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { email: true } });
    if (!user) throw new HttpError(401, 'Account not found.', 'UNAUTHENTICATED');
    const country = await detectIpCountry(clientIp(req));
    const base = webBaseUrl(req);
    const url = await createCheckoutSession({
      tenantId: auth.tenantId,
      email: user.email,
      country,
      successUrl: `${base}/onboarding?billing=success`,
      cancelUrl: `${base}/dashboard/billing?billing=cancel`,
    });
    res.json({ url });
  }),
);

billingRouter.post(
  '/portal',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const url = await createBillingPortalSession(auth.tenantId, `${webBaseUrl(req)}/dashboard/billing`);
    res.json({ url });
  }),
);
