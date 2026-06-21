import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { unsubscribeLead } from '../services/leadgen.service';

/**
 * Public, unauthenticated endpoint behind the CAN-SPAM unsubscribe link in
 * outreach emails. Idempotent and never errors on a missing lead — the only
 * thing that matters is that the opt-out is recorded.
 */
export const unsubscribeRouter = Router();

const Schema = z.object({ leadId: z.string().trim().min(1).max(64) });

unsubscribeRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { leadId } = Schema.parse(req.body);
    await unsubscribeLead(leadId);
    res.json({ ok: true });
  }),
);
