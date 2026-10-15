import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import {
  applyPendingKnowledge,
  applyPendingProposal,
  createDirectSupportTicket,
  filePendingTicket,
  runPendingSimulation,
  runSupportChat,
  runSupportChatStream,
} from '../services/support-agent.service';
import { DRILL_SCENARIOS } from '../services/adam-simulation.service';
import { dismissWeeklyReview } from '../services/adam-knowledge.service';

export const supportRouter = Router();
supportRouter.use(requireAuth);

/**
 * The chat turn pays for a model call, so it gets a budget well below the
 * public geo lookup's: plenty for a human conversation, useless for abuse.
 */
const supportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many requests. Please wait a few minutes.', code: 'RATE_LIMITED' } },
});
supportRouter.use(supportLimiter);

const ChatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().trim().min(1).max(4000),
      }),
    )
    .min(1)
    .max(20),
  /**
   * The app route the user is on, so the agent can anchor answers to that
   * page. Only ever resolved against the server-side page map; an unknown
   * or junk value adds no context and is never an error.
   */
  page: z.string().trim().min(1).max(200).optional(),
});

supportRouter.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { messages, page } = ChatBodySchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { email: true },
    });
    if (!user) throw new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');
    const result = await runSupportChat({
      tenantId: auth.tenantId,
      userId: auth.userId,
      userEmail: user.email,
      userRole: auth.role,
      messages,
      pagePath: page,
    });
    res.json(result);
  }),
);

/**
 * The streamed twin of /chat (same auth, same rate limiter, same chat
 * pipeline). Events, in order: `status` while tools run, `delta` as the
 * reply is generated, one `final` carrying the exact payload /chat
 * returns, then `done`. A failure before the first event is answered with
 * the normal JSON error; a failure mid-stream arrives as an `error` event
 * carrying the same honest message the JSON path would have given.
 */
supportRouter.post(
  '/chat/stream',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { messages, page } = ChatBodySchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { email: true },
    });
    if (!user) throw new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');

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
      const result = await runSupportChatStream(
        {
          tenantId: auth.tenantId,
          userId: auth.userId,
          userEmail: user.email,
          userRole: auth.role,
          messages,
          pagePath: page,
        },
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
        err instanceof HttpError
          ? err.message
          : 'The support assistant had trouble answering just now. Please try again.';
      const code = err instanceof HttpError ? err.code : undefined;
      send('error', { message, ...(code ? { code } : {}) });
      res.end();
    }
  }),
);

const ApplyBodySchema = z.object({
  proposalId: z.string().trim().min(1).max(100),
});

/**
 * The confirmation card's Confirm button. Same gate as the settings routes
 * (owner/manager) and the same apply path as the chat tool: only a proposal
 * the server is holding for this user can be applied.
 */
supportRouter.post(
  '/apply',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { proposalId } = ApplyBodySchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { email: true },
    });
    if (!user) throw new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');
    const applied = await applyPendingProposal({
      tenantId: auth.tenantId,
      userId: auth.userId,
      userEmail: user.email,
      proposalId,
    });
    res.json({ applied: true, summary: applied.summary, assistantMessage: applied.assistantMessage });
  }),
);

const FileTicketBodySchema = z.object({
  proposalId: z.string().trim().min(1).max(100),
});

const ReportBodySchema = z.object({
  category: z.enum(['ISSUE', 'BAD_CALL', 'OTHER']).optional(),
  subject: z.string().trim().min(1).max(140),
  details: z.string().trim().min(1).max(2000),
});

/**
 * The ticket card's "File this ticket" button. Same confirm discipline as
 * /apply (only a server-held proposal for this user can be filed), but no
 * role gate: any signed-in user may report an issue or a bad call.
 */
supportRouter.post(
  '/file-ticket',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { proposalId } = FileTicketBodySchema.parse(req.body);
    const filed = await filePendingTicket({
      tenantId: auth.tenantId,
      userId: auth.userId,
      proposalId,
    });
    res.json({
      filed: true,
      reference: filed.reference,
      summary: filed.summary,
      assistantMessage: filed.assistantMessage,
    });
  }),
);

/**
 * The proof/drill card's Confirm button. Owner/manager only, same as the
 * settings writes: a simulated call spends real call time. The run path
 * (caps, placement, audit) is shared verbatim with the chat tool.
 */
supportRouter.post(
  '/run-simulated-call',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { proposalId } = ApplyBodySchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { email: true },
    });
    if (!user) throw new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');
    const run = await runPendingSimulation({
      tenantId: auth.tenantId,
      userId: auth.userId,
      userEmail: user.email,
      userRole: auth.role,
      proposalId,
    });
    res.json({ ran: true, runId: run.runId, summary: run.summary, assistantMessage: run.assistantMessage });
  }),
);

/**
 * The knowledge card's Confirm button. Owner/manager only. Writes through
 * the same knowledge path as the chat tool's apply (upload, Document row,
 * re-sync) with the audit entry recorded by the service.
 */
supportRouter.post(
  '/apply-knowledge',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { proposalId } = ApplyBodySchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { email: true },
    });
    if (!user) throw new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');
    const applied = await applyPendingKnowledge({
      tenantId: auth.tenantId,
      userId: auth.userId,
      userEmail: user.email,
      proposalId,
    });
    res.json({ applied: true, summary: applied.summary, assistantMessage: applied.assistantMessage });
  }),
);

/** The drill library, for the widget's scenario picker. */
supportRouter.get(
  '/drill-scenarios',
  asyncHandler(async (_req, res) => {
    res.json({
      scenarios: DRILL_SCENARIOS.map((s) => ({ id: s.id, title: s.title, goal: s.goal })),
    });
  }),
);

const DismissReviewBodySchema = z.object({
  reviewId: z.string().trim().min(1).max(100),
});

/** Dismisses the pending weekly knowledge review for this workspace. */
supportRouter.post(
  '/weekly-review/dismiss',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { reviewId } = DismissReviewBodySchema.parse(req.body);
    const dismissed = await dismissWeeklyReview(auth.tenantId, reviewId);
    if (!dismissed) {
      throw new HttpError(404, 'That review is not waiting in this workspace.', 'REVIEW_NOT_FOUND');
    }
    res.json({ dismissed: true });
  }),
);

/**
 * The widget's model-free report form. Tenant and user come only from the
 * JWT; the body cannot choose a workspace, attach a call, or set a status.
 * This path stays available when the model is down, including for a report
 * about the support assistant itself.
 */
supportRouter.post(
  '/report',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const input = ReportBodySchema.parse(req.body);
    const filed = await createDirectSupportTicket({
      tenantId: auth.tenantId,
      userId: auth.userId,
      input,
    });
    res.status(201).json({
      filed: true,
      reference: filed.reference,
      summary: filed.summary,
      assistantMessage: filed.assistantMessage,
    });
  }),
);
