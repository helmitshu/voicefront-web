import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http';
import { verifyTurnstile } from './demo.routes';
import { clientIp, parsePublicIp } from '../services/geo.service';
import {
  MAX_TURNS_PER_SESSION,
  PROACTIVE_TRIGGERS,
  PUBLIC_AGENT,
  beginSessionTurn,
  getPublicSession,
  publicChatAvailability,
  resolveVisitorContext,
  runPublicChat,
  runPublicChatStream,
  runPublicProactive,
  startPublicSession,
  type ProactiveTrigger,
  type PublicChatTurnContext,
  type PublicSession,
} from '../services/public-agent.service';

/**
 * Lyla's public surface. No auth, no tenant context: a session is an
 * anonymous, short-lived chat started only after the same Turnstile check
 * the demo lead form uses. The armor lives in services/public-agent.service
 * (per-session turn cap, per-IP daily session cap, global daily circuit
 * breaker); this router adds a plain per-IP rate limit on top.
 *
 * POST /api/public/session          start a chat session (Turnstile-gated)
 * POST /api/public/chat             one chat turn
 * POST /api/public/chat/stream      one chat turn, streamed (SSE)
 * POST /api/public/proactive        one behavior-triggered line (budgeted)
 */

export const publicRouter = Router();

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many requests. Please wait a few minutes.', code: 'RATE_LIMITED' } },
});
publicRouter.use(publicLimiter);

/** The visitor IP, resolved exactly like the geo route: a valid public
 *  `x-visitor-ip` header (sent by the web tier) wins, else the connection
 *  IP the edge sees. */
function requestIp(req: Request): string | null {
  return parsePublicIp(req.headers['x-visitor-ip']) ?? clientIp(req);
}

/** Caps the page-observation state so it stays background color, never a
 *  payload channel: short strings, small arrays, one number. */
const VisitorStateSchema = z
  .object({
    section: z.string().trim().min(1).max(60).optional(),
    dwellSeconds: z.number().min(0).max(86400).optional(),
    sectionsVisited: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
    formState: z.string().trim().min(1).max(40).optional(),
  })
  .optional();

const SessionStartSchema = z.object({
  turnstileToken: z.string().max(2048).optional(),
  referrer: z.string().trim().max(500).optional(),
  localTime: z.string().trim().max(120).optional(),
});

const ChatBodySchema = z.object({
  sessionId: z.string().min(10).max(80).startsWith('lyla_'),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().trim().min(1).max(4000),
      }),
    )
    .min(1)
    .max(20),
  visitorState: VisitorStateSchema,
  referrer: z.string().trim().max(500).optional(),
  localTime: z.string().trim().max(120).optional(),
});

const ProactiveBodySchema = z.object({
  sessionId: z.string().min(10).max(80).startsWith('lyla_'),
  trigger: z.enum(['pricing_dwell', 'form_stall', 'exit_intent']),
  visitorState: VisitorStateSchema,
  referrer: z.string().trim().max(500).optional(),
  localTime: z.string().trim().max(120).optional(),
});

function requireSession(sessionId: string): PublicSession {
  const session = getPublicSession(sessionId);
  if (!session) {
    throw new HttpError(404, 'That chat session has ended. Please start a new one.', 'SESSION_NOT_FOUND');
  }
  return session;
}

function turnContext(req: Request, body: { visitorState?: unknown; referrer?: string; localTime?: string }): PublicChatTurnContext {
  return {
    ip: requestIp(req),
    referrer: body.referrer,
    localTime: body.localTime,
    visitorState: body.visitorState as PublicChatTurnContext['visitorState'],
  };
}

publicRouter.post(
  '/session',
  asyncHandler(async (req, res) => {
    const body = SessionStartSchema.parse(req.body ?? {});
    // Breaker first: a tripped breaker never burns a Turnstile token.
    const availability = publicChatAvailability();
    if (!availability.available) {
      throw new HttpError(503, 'Chat is unavailable right now.', 'CIRCUIT_BREAKER');
    }
    const ip = requestIp(req);
    if (!(await verifyTurnstile(body.turnstileToken, ip))) {
      throw new HttpError(403, 'The bot check did not pass.', 'TURNSTILE_FAILED');
    }
    const visitor = await resolveVisitorContext(ip);
    const session = startPublicSession(ip, visitor);
    res.json({
      sessionId: session.id,
      name: PUBLIC_AGENT.name,
      title: PUBLIC_AGENT.title,
      identityLine: PUBLIC_AGENT.identityLine,
      greeting: PUBLIC_AGENT.greeting,
      visitor: session.visitor,
      turnsLimit: MAX_TURNS_PER_SESSION,
      proactiveTriggers: PROACTIVE_TRIGGERS,
    });
  }),
);

publicRouter.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const body = ChatBodySchema.parse(req.body);
    const session = requireSession(body.sessionId);
    beginSessionTurn(session);
    const result = await runPublicChat({
      session,
      messages: body.messages,
      ctx: turnContext(req, body),
    });
    res.json(result);
  }),
);

publicRouter.post(
  '/chat/stream',
  asyncHandler(async (req, res) => {
    const body = ChatBodySchema.parse(req.body);
    const session = requireSession(body.sessionId);
    beginSessionTurn(session);

    let started = false;
    const send = (event: string, data: unknown) => {
      if (!started) {
        started = true;
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
      }
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* The client went away mid-stream; the turn simply ends. */
      }
    };

    try {
      const result = await runPublicChatStream(
        { session, messages: body.messages, ctx: turnContext(req, body) },
        {
          status: (label) => send('status', { label }),
          delta: (text) => send('delta', { text }),
        },
      );
      send('final', result);
      send('done', {});
      res.end();
    } catch (err) {
      if (!started) throw err;
      const message =
        err instanceof HttpError ? err.message : 'Lyla had trouble answering just now. Please try again.';
      const code = err instanceof HttpError ? err.code : undefined;
      send('error', { message, ...(code ? { code } : {}) });
      res.end();
    }
  }),
);

publicRouter.post(
  '/proactive',
  asyncHandler(async (req, res) => {
    const body = ProactiveBodySchema.parse(req.body);
    const session = requireSession(body.sessionId);
    const result = await runPublicProactive({
      session,
      trigger: body.trigger as ProactiveTrigger,
      ctx: turnContext(req, body),
    });
    res.json(result);
  }),
);
