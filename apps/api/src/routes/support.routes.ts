import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import { applyPendingProposal, runSupportChat } from '../services/support-agent.service';

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
});

supportRouter.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { messages } = ChatBodySchema.parse(req.body);
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
    });
    res.json(result);
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
