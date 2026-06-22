import { Router, type Request } from 'express';
import { asyncHandler } from '../lib/http';
import { getRingTwiml, handleAccept, handleStatusCallback } from '../services/dispatch.service';

/**
 * Public Twilio voice webhooks for on-call dispatch. Unauthenticated by design
 * — Twilio calls them — but every request carries a per-dispatch token in the
 * URL that the service verifies, so only callbacks for a real dispatch can
 * drive it. The TwiML legs return XML; the status leg just acknowledges.
 */
export const dispatchRouter = Router();

function tokenOf(req: Request): string | undefined {
  const t = req.query.token;
  return typeof t === 'string' ? t : undefined;
}

function indexOf(req: Request): number {
  const n = Number(req.params.index);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

dispatchRouter.post(
  '/twiml/:dispatchId/:index',
  asyncHandler(async (req, res) => {
    const xml = await getRingTwiml(req.params.dispatchId, indexOf(req), tokenOf(req));
    res.type('text/xml').send(xml);
  }),
);

dispatchRouter.post(
  '/accept/:dispatchId/:index',
  asyncHandler(async (req, res) => {
    const digits = typeof req.body?.Digits === 'string' ? req.body.Digits : undefined;
    const xml = await handleAccept(req.params.dispatchId, indexOf(req), tokenOf(req), digits);
    res.type('text/xml').send(xml);
  }),
);

dispatchRouter.post(
  '/status/:dispatchId/:index',
  asyncHandler(async (req, res) => {
    const status = typeof req.body?.CallStatus === 'string' ? req.body.CallStatus : undefined;
    await handleStatusCallback(req.params.dispatchId, indexOf(req), tokenOf(req), status);
    res.status(204).end();
  }),
);
