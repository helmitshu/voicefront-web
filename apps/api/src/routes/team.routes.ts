import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { requireAuth, requirePlatformAdmin } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import {
  createWorkItem,
  ensureTeamMembers,
  getOrCreateThread,
  getThreadView,
  listThreads,
  listWorkItems,
  postMessage,
  setDecision,
  startDiscussion,
  updateWorkItemStatus,
} from '../services/team.service';
import { MEMBER_TOOL_ACCESS } from '../services/team-content';
import { TEAM_TOOLS, invokeTeamTool, memberMayUseTool } from '../services/team-tools';
import {
  buildBoardPack,
  buildClinicDossier,
  listFailureCases,
  runCallScoring,
  runLeakRadar,
  runRedTeam,
  runUptimeCheck,
} from '../services/team-abilities.service';

/**
 * The AI Team room's API. Mounted inside adminRouter (which already
 * applies requireAuth + requirePlatformAdmin); the router applies the
 * same gate itself so it is safe wherever it is mounted. Founder-only:
 * no customer, clinic, or trial user ever reaches these routes.
 *
 * Paths live under /api/admin/team/* per the approved design. They do
 * not collide with the human operator endpoints (GET/POST /api/admin/team
 * and DELETE /api/admin/team/:email manage admin logins; every route
 * here is a distinct sub-path).
 */

export const teamRouter = Router();
teamRouter.use(requireAuth, requirePlatformAdmin);

const postMessageSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  authorType: z.enum(['OWNER', 'CEO']).optional(),
});

const createThreadSchema = z.object({
  type: z.enum(['DM', 'GROUP', 'CEO']),
  memberSlug: z.string().trim().min(1).optional(),
});

const discussSchema = z.object({
  topic: z.string().trim().min(1).max(2000),
  memberSlugs: z.array(z.string().trim().min(1)).max(8).optional(),
});

const decisionSchema = z.object({
  decision: z.string().trim().min(1).max(4000),
});

const workItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  detail: z.string().max(4000).optional(),
  ownerSlug: z.string().trim().min(1),
  sourceThreadId: z.string().optional(),
});

const workItemStatusSchema = z.object({
  status: z.enum(['QUEUED', 'IN_PROGRESS', 'DONE']),
});

const invokeSchema = z.object({
  memberSlug: z.string().trim().min(1),
  tool: z.string().trim().min(1),
  args: z.record(z.unknown()).optional(),
});

/* ------------------------------- members -------------------------------- */

teamRouter.get(
  '/team/members',
  asyncHandler(async (_req, res) => {
    const members = await ensureTeamMembers();
    res.json({
      members: members.map((member) => ({
        slug: member.slug,
        name: member.name,
        role: member.role,
        avatarPath: member.avatarPath,
        modelConfig: member.modelConfig,
        statusLine: member.statusLine,
      })),
    });
  }),
);

/* ------------------------------- threads -------------------------------- */

teamRouter.get(
  '/team/threads',
  asyncHandler(async (_req, res) => {
    res.json({ threads: await listThreads() });
  }),
);

teamRouter.post(
  '/team/threads',
  asyncHandler(async (req, res) => {
    const body = createThreadSchema.parse(req.body ?? {});
    const thread = await getOrCreateThread(body);
    res.status(201).json({ thread });
  }),
);

teamRouter.get(
  '/team/threads/:id/messages',
  asyncHandler(async (req, res) => {
    // The paced view: member replies still inside their human-pacing
    // window are held back, and `pending` names who is typing and when
    // the next reply lands.
    res.json(await getThreadView(req.params.id));
  }),
);

teamRouter.post(
  '/team/threads/:id/messages',
  asyncHandler(async (req, res) => {
    const body = postMessageSchema.parse(req.body ?? {});
    const result = await postMessage(req.params.id, body);
    res.status(201).json(result);
  }),
);

teamRouter.post(
  '/team/threads/:id/decision',
  asyncHandler(async (req, res) => {
    const body = decisionSchema.parse(req.body ?? {});
    const thread = await setDecision(req.params.id, body.decision);
    res.json({ thread });
  }),
);

teamRouter.post(
  '/team/discuss',
  asyncHandler(async (req, res) => {
    const body = discussSchema.parse(req.body ?? {});
    const result = await startDiscussion(body);
    res.status(201).json(result);
  }),
);

/* ------------------------------ work items ------------------------------- */

teamRouter.get(
  '/team/work-items',
  asyncHandler(async (_req, res) => {
    res.json({ workItems: await listWorkItems() });
  }),
);

teamRouter.post(
  '/team/work-items',
  asyncHandler(async (req, res) => {
    const body = workItemSchema.parse(req.body ?? {});
    const workItem = await createWorkItem(body);
    res.status(201).json({ workItem });
  }),
);

teamRouter.patch(
  '/team/work-items/:id',
  asyncHandler(async (req, res) => {
    const body = workItemStatusSchema.parse(req.body ?? {});
    const workItem = await updateWorkItemStatus(req.params.id, body.status);
    res.json({ workItem });
  }),
);

/* --------------------------------- tools --------------------------------- */

teamRouter.get(
  '/team/tools',
  asyncHandler(async (_req, res) => {
    const memberTools: Record<string, string[]> = {};
    for (const slug of Object.keys(MEMBER_TOOL_ACCESS)) {
      memberTools[slug] = TEAM_TOOLS.filter(
        (tool) => tool.available && memberMayUseTool(slug, tool),
      ).map((tool) => tool.name);
    }
    res.json({
      tools: TEAM_TOOLS.map((tool) => ({
        name: tool.name,
        tier: tool.tier,
        description: tool.description,
        available: tool.available,
        ...(tool.unavailableReason ? { reason: tool.unavailableReason } : {}),
      })),
      memberTools,
    });
  }),
);

teamRouter.post(
  '/team/tools/invoke',
  asyncHandler(async (req, res) => {
    const body = invokeSchema.parse(req.body ?? {});
    const result = await invokeTeamTool(
      { memberSlug: body.memberSlug },
      body.tool,
      body.args ?? {},
    );
    res.json({ ok: true, result });
  }),
);

teamRouter.get(
  '/team/tool-log',
  asyncHandler(async (_req, res) => {
    const entries = await prisma.teamToolLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ entries });
  }),
);

teamRouter.get(
  '/team/drafts',
  asyncHandler(async (_req, res) => {
    const drafts = await prisma.teamDraft.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ drafts });
  }),
);

teamRouter.get(
  '/team/failure-cases',
  asyncHandler(async (_req, res) => {
    res.json({ cases: await listFailureCases() });
  }),
);

/* ------------------------------- abilities ------------------------------- */

teamRouter.post(
  '/team/abilities/call-scoring',
  asyncHandler(async (req, res) => {
    const limit = typeof req.body?.limit === 'number' ? req.body.limit : undefined;
    res.json(await runCallScoring({ limit }));
  }),
);

teamRouter.post(
  '/team/abilities/leak-radar',
  asyncHandler(async (_req, res) => {
    res.json(await runLeakRadar());
  }),
);

teamRouter.post(
  '/team/abilities/uptime',
  asyncHandler(async (_req, res) => {
    res.json(await runUptimeCheck());
  }),
);

teamRouter.post(
  '/team/abilities/red-team',
  asyncHandler(async (req, res) => {
    const plan = typeof req.body?.plan === 'string' ? req.body.plan : '';
    const draft = await runRedTeam({ plan });
    res.status(201).json({ draft });
  }),
);

teamRouter.post(
  '/team/abilities/dossier',
  asyncHandler(async (req, res) => {
    const draft = await buildClinicDossier({
      leadId: typeof req.body?.leadId === 'string' ? req.body.leadId : undefined,
      websiteUrl: typeof req.body?.websiteUrl === 'string' ? req.body.websiteUrl : undefined,
      businessName: typeof req.body?.businessName === 'string' ? req.body.businessName : undefined,
    });
    res.status(201).json({ draft });
  }),
);

teamRouter.post(
  '/team/abilities/board-pack',
  asyncHandler(async (_req, res) => {
    const draft = await buildBoardPack();
    res.status(201).json({ draft });
  }),
);
