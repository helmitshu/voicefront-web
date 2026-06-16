import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http';
import { getSettingValue } from '../services/platform-config.service';
import { buildTransientAssistant } from '../domain/assistant-builder';
import {
  startDemoSession,
  getDemoAppointments,
  blockDemoSlot,
  resetDemoSession,
} from '../services/demo.service';

/**
 * PUBLIC (no auth) endpoints behind the interactive landing-page demo. They
 * expose only the Vapi *public* web key (safe by design) and an isolated,
 * throwaway demo calendar — never any real tenant data.
 */
export const demoRouter = Router();

const SessionSchema = z.object({ sessionId: z.string().min(3).max(80).startsWith('demo_') });
const BlockSchema = SessionSchema.extend({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

const DEMO_OPENER =
  "Hi there, you've reached Bayview Family Clinic — this is Maya. This is a live demo, so go ahead and book an appointment, or try to catch me out. What can I do for you?";

/** Start a session: returns the public key, a demo assistant, and the calendar. */
demoRouter.post(
  '/session',
  asyncHandler(async (_req, res) => {
    const publicKey = await getSettingValue('VAPI_PUBLIC_KEY');
    if (!publicKey) {
      throw new HttpError(503, 'The live demo is not configured on this server yet.', 'VOICE_NOT_CONFIGURED');
    }

    const session = await startDemoSession();
    const publicApiUrl = await getSettingValue('PUBLIC_API_URL');

    const assistant = buildTransientAssistant(session.bundle.tenant, session.bundle.settings, 'web', new Date(), {
      // Booking tool-calls must reach our webhook to hit the demo calendar.
      serverUrl: publicApiUrl ? `${publicApiUrl}/api/vapi/inbound` : undefined,
    });
    // Tag the assistant so tool-calls land on THIS visitor's isolated calendar,
    // and give it a guiding opener that invites the prospect to test it.
    assistant.metadata = { ...assistant.metadata, demoSessionId: session.sessionId };
    assistant.firstMessage = DEMO_OPENER;

    res.json({
      publicKey,
      assistant,
      sessionId: session.sessionId,
      day: session.day,
      appointments: session.appointments,
    });
  }),
);

/** Poll the visitor's live calendar (drives the on-screen booking updates). */
demoRouter.get(
  '/appointments',
  asyncHandler(async (req, res) => {
    const { sessionId } = SessionSchema.parse({ sessionId: req.query.sessionId });
    res.json({ appointments: await getDemoAppointments(sessionId) });
  }),
);

/** Visitor blocks a slot, then asks the agent to book it — to see the refusal. */
demoRouter.post(
  '/block',
  asyncHandler(async (req, res) => {
    const { sessionId, date, time } = BlockSchema.parse(req.body ?? {});
    res.json({ appointments: await blockDemoSlot(sessionId, date, time) });
  }),
);

/** Reset the visitor's calendar back to its seeded starting point. */
demoRouter.post(
  '/reset',
  asyncHandler(async (req, res) => {
    const { sessionId } = SessionSchema.parse(req.body ?? {});
    res.json(await resetDemoSession(sessionId));
  }),
);
