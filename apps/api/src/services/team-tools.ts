import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { MEMBER_TOOL_ACCESS } from './team-content';
import type { TeamFunctionDeclaration } from './team-gemini';

/**
 * The team tool runtime. Members are agents, not chatbots, but their
 * powers are tiered and the tiers are enforced HERE, in code, never in a
 * prompt:
 *
 *  - Tier 1 READ: web search/fetch/watch, VoiceFront business data,
 *    the codebase read-only, the member's own memory.
 *  - Tier 2 DRAFT: work items and stored drafts (per-role draft kinds).
 *    Nothing a draft tool produces is ever sent, pushed, or applied.
 *  - Tier 3 ACT: does not exist. No send/push/spend/settings tool is
 *    registered at all, so there is nothing to call.
 *
 * A member's allowed set is computed server-side from MEMBER_TOOL_ACCESS
 * (their role config): a tool outside the tier is not offered to the model
 * as a function declaration, and a direct call is rejected. EVERY call,
 * including rejections, writes a TeamToolLog row.
 */

export interface TeamToolContext {
  memberSlug: string;
  threadId?: string;
}

export interface TeamToolDef {
  name: string;
  tier: 1 | 2;
  description: string;
  parameters: Record<string, unknown>;
  available: boolean;
  unavailableReason?: string;
  run?: (ctx: TeamToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

/* ------------------------------- web tools ------------------------------ */

const WEB_TIMEOUT_MS = 12_000;
const BROWSER_UA = 'Mozilla/5.0 (compatible; VoiceFrontTeam/1.0; +https://voicefront.app)';

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,text/plain,*/*' },
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** Crude but honest HTML-to-text: drop script/style, strip tags, collapse. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function toolWebSearch(_ctx: TeamToolContext, args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('web_search needs a query.');
  // Keyless search over DuckDuckGo's HTML endpoint. Best effort by design:
  // no paid API, and a rate limit upstream surfaces as an honest error.
  const { status, text } = await fetchText(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  );
  if (status !== 200) throw new Error(`Search upstream returned ${status}.`);
  const results: Array<{ title: string; url: string }> = [];
  const anchor = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(text)) !== null && results.length < 5) {
    let url = match[1];
    try {
      const parsed = new URL(url, 'https://duckduckgo.com');
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) url = decodeURIComponent(uddg);
    } catch {
      /* keep the raw href */
    }
    results.push({ title: htmlToText(match[2]).slice(0, 200), url });
  }
  return {
    query,
    results,
    note: 'Keyless DuckDuckGo HTML search, best effort. Treat titles as leads; fetch a page to cite it.',
  };
}

async function toolWebFetch(_ctx: TeamToolContext, args: Record<string, unknown>) {
  const url = String(args.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('web_fetch needs an http(s) URL.');
  const { status, text } = await fetchText(url);
  if (status !== 200) throw new Error(`Fetching ${url} returned ${status}.`);
  return { url, text: htmlToText(text).slice(0, 8000) };
}

async function toolPageWatch(_ctx: TeamToolContext, args: Record<string, unknown>) {
  const url = String(args.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('page_watch needs an http(s) URL.');
  const { status, text } = await fetchText(url);
  if (status !== 200) throw new Error(`Fetching ${url} returned ${status}.`);
  const contentHash = createHash('sha256').update(htmlToText(text)).digest('hex');
  const existing = await prisma.teamPageWatch.findUnique({ where: { url } });
  if (!existing) {
    await prisma.teamPageWatch.create({
      data: { url, contentHash, lastCheckedAt: new Date() },
    });
    return { url, status: 'first_check', contentHash, note: 'Baseline stored; call again later to detect a change.' };
  }
  const changed = existing.contentHash !== contentHash;
  await prisma.teamPageWatch.update({
    where: { url },
    data: { contentHash, lastCheckedAt: new Date() },
  });
  return {
    url,
    status: changed ? 'changed' : 'unchanged',
    previousHash: existing.contentHash,
    contentHash,
    lastCheckedAt: existing.lastCheckedAt,
  };
}

/* --------------------------- VoiceFront data ---------------------------- */

function clampLimit(raw: unknown, fallback = 10, max = 25): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

async function toolRecentCalls(_ctx: TeamToolContext, args: Record<string, unknown>) {
  const limit = clampLimit(args.limit);
  const tenantSlug = typeof args.tenantSlug === 'string' ? args.tenantSlug.trim() : '';
  const calls = await prisma.callLog.findMany({
    where: tenantSlug ? { tenant: { slug: tenantSlug } } : undefined,
    orderBy: { startedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      callerNumber: true,
      startedAt: true,
      durationSeconds: true,
      status: true,
      outcome: true,
      intent: true,
      appointmentBooked: true,
      successScore: true,
      tenant: { select: { companyName: true, slug: true } },
    },
  });
  return { calls };
}

async function toolCallTranscript(_ctx: TeamToolContext, args: Record<string, unknown>) {
  const callId = String(args.callId ?? '').trim();
  if (!callId) throw new Error('vf_call_transcript needs a callId.');
  const call = await prisma.callLog.findUnique({
    where: { id: callId },
    select: {
      id: true,
      startedAt: true,
      summary: true,
      transcript: true,
      tenant: { select: { companyName: true, slug: true } },
    },
  });
  if (!call) throw new Error(`No call with id ${callId}.`);
  return {
    callId: call.id,
    clinic: call.tenant.companyName,
    startedAt: call.startedAt,
    summary: call.summary,
    transcript: call.transcript ?? null,
    note: call.transcript ? undefined : 'This call has no stored transcript.',
  };
}

async function toolDemoLeads(_ctx: TeamToolContext, args: Record<string, unknown>) {
  const leads = await prisma.demoLead.findMany({
    orderBy: { createdAt: 'desc' },
    take: clampLimit(args.limit),
    select: {
      id: true,
      name: true,
      email: true,
      businessName: true,
      industry: true,
      mode: true,
      websiteUrl: true,
      ipCountry: true,
      createdAt: true,
      demoSessionId: true,
    },
  });
  return { leads };
}

async function toolBookings(_ctx: TeamToolContext, args: Record<string, unknown>) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bookings = await prisma.appointment.findMany({
    where: { startsAt: { gte: since } },
    orderBy: { startsAt: 'asc' },
    take: clampLimit(args.limit),
    select: {
      id: true,
      customerName: true,
      startsAt: true,
      endsAt: true,
      status: true,
      source: true,
      tenant: { select: { companyName: true, slug: true } },
    },
  });
  return { bookings };
}

async function toolTenant(_ctx: TeamToolContext, args: Record<string, unknown>) {
  const slug = String(args.slug ?? '').trim();
  if (!slug) throw new Error('vf_tenant needs a tenant slug.');
  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: {
      id: true,
      companyName: true,
      slug: true,
      industry: true,
      subscriptionStatus: true,
      pricingRegion: true,
      monthlyMinuteLimit: true,
      isBlocked: true,
      createdAt: true,
      onboarding: { select: { isActive: true, completedAt: true } },
      agentSettings: { select: { displayName: true, inboundPhoneNumber: true, timezone: true } },
    },
  });
  if (!tenant) throw new Error(`No tenant with slug ${slug}.`);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const agg = await prisma.callLog.aggregate({
    where: { tenantId: tenant.id, startedAt: { gte: monthStart } },
    _sum: { durationSeconds: true },
    _count: true,
  });
  const minutesUsed = Math.round(((agg._sum.durationSeconds ?? 0) / 60) * 10) / 10;
  return {
    tenant: {
      companyName: tenant.companyName,
      slug: tenant.slug,
      industry: tenant.industry,
      subscriptionStatus: tenant.subscriptionStatus,
      pricingRegion: tenant.pricingRegion,
      isBlocked: tenant.isBlocked,
      createdAt: tenant.createdAt,
      receptionistLive: tenant.onboarding?.isActive ?? false,
      receptionistName: tenant.agentSettings?.displayName ?? null,
      lineNumber: tenant.agentSettings?.inboundPhoneNumber ?? null,
    },
    usage: {
      callsThisMonth: agg._count,
      minutesUsed,
      monthlyMinuteLimit: tenant.monthlyMinuteLimit,
      percentOfCap: tenant.monthlyMinuteLimit
        ? Math.round((minutesUsed / tenant.monthlyMinuteLimit) * 1000) / 10
        : null,
    },
  };
}

async function toolRevenue(_ctx: TeamToolContext) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [byStatus, monthAgg] = await Promise.all([
    prisma.tenant.groupBy({
      by: ['subscriptionStatus'],
      where: { deletedAt: null },
      _count: true,
    }),
    prisma.callLog.aggregate({
      where: { startedAt: { gte: monthStart } },
      _sum: { durationSeconds: true, billedCostCents: true },
      _count: true,
    }),
  ]);
  const counts: Record<string, number> = {};
  for (const row of byStatus) counts[row.subscriptionStatus] = row._count;
  return {
    tenantsByStatus: counts,
    callsThisMonth: monthAgg._count,
    minutesThisMonth: Math.round(((monthAgg._sum.durationSeconds ?? 0) / 60) * 10) / 10,
    billedCentsThisMonth: monthAgg._sum.billedCostCents ?? 0,
    note: 'MRR is not stored per tenant (there is no plan field on a tenant). Multiply ACTIVE tenants by a tier price only as a labeled estimate.',
  };
}

/* ------------------------------ repo (read) ----------------------------- */

/** The repo clone root: src/services -> src -> apps/api -> apps -> root. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const REPO_BLOCKED = /(^|\/)(\.env[^/]*|node_modules|\.git)(\/|$)|credential|secret|\.pem$|\.key$/i;

function jailRepoPath(raw: string): string {
  const rel = raw.replace(/^\/+/, '');
  const resolved = path.resolve(REPO_ROOT, rel);
  if (resolved !== REPO_ROOT && !resolved.startsWith(REPO_ROOT + path.sep)) {
    throw new Error('Path escapes the repository.');
  }
  if (REPO_BLOCKED.test(rel)) {
    throw new Error('That path is blocked (secrets, dependencies, and VCS internals are not readable).');
  }
  return resolved;
}

async function toolRepoList(_ctx: TeamToolContext, args: Record<string, unknown>) {
  const rel = typeof args.path === 'string' ? args.path : '';
  const resolved = jailRepoPath(rel || '.');
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  return {
    path: rel || '.',
    entries: entries
      .filter((entry) => !REPO_BLOCKED.test(entry.name))
      .slice(0, 100)
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' })),
  };
}

async function toolRepoRead(_ctx: TeamToolContext, args: Record<string, unknown>) {
  const rel = String(args.path ?? '').trim();
  if (!rel) throw new Error('repo_read needs a path.');
  const resolved = jailRepoPath(rel);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`${rel} is not a file.`);
  if (stat.size > 256_000) throw new Error(`${rel} is too large to read (${stat.size} bytes).`);
  const buffer = await fs.readFile(resolved);
  if (buffer.includes(0)) throw new Error(`${rel} looks binary; only text files are readable.`);
  return { path: rel, content: buffer.toString('utf8').slice(0, 12_000), truncated: buffer.length > 12_000 };
}

/* --------------------------- memory and drafts -------------------------- */

async function toolMemoryWrite(ctx: TeamToolContext, args: Record<string, unknown>) {
  const body = String(args.body ?? '').trim();
  if (!body) throw new Error('memory_write needs a body.');
  // The note is ALWAYS stored under the calling member. There is no way to
  // write into another member's memory; the slug comes from the context.
  const note = await prisma.teamNote.create({ data: { memberSlug: ctx.memberSlug, body } });
  return { stored: true, noteId: note.id };
}

async function toolMemoryRead(ctx: TeamToolContext, args: Record<string, unknown>) {
  const notes = await prisma.teamNote.findMany({
    where: { memberSlug: ctx.memberSlug },
    orderBy: { createdAt: 'desc' },
    take: clampLimit(args.limit, 10, 50),
    select: { id: true, body: true, createdAt: true },
  });
  return { notes };
}

async function toolCreateWorkItem(ctx: TeamToolContext, args: Record<string, unknown>) {
  const title = String(args.title ?? '').trim();
  if (!title) throw new Error('create_work_item needs a title.');
  const requestedOwner = typeof args.ownerSlug === 'string' ? args.ownerSlug.trim() : '';
  const ownerSlug =
    requestedOwner && requestedOwner in MEMBER_TOOL_ACCESS ? requestedOwner : ctx.memberSlug;
  const item = await prisma.workItem.create({
    data: {
      title: title.slice(0, 200),
      detail: typeof args.detail === 'string' ? args.detail.slice(0, 4000) : null,
      ownerSlug,
      sourceThreadId: ctx.threadId ?? null,
    },
  });
  return { workItem: { id: item.id, title: item.title, ownerSlug: item.ownerSlug, status: item.status } };
}

async function toolCreateDraft(ctx: TeamToolContext, args: Record<string, unknown>) {
  const kind = String(args.kind ?? '').trim().toUpperCase();
  const access = MEMBER_TOOL_ACCESS[ctx.memberSlug];
  if (!access || !access.draftKinds.includes(kind)) {
    throw new HttpError(
      403,
      `${ctx.memberSlug} cannot create ${kind || 'that kind of'} drafts. Allowed kinds: ${access?.draftKinds.join(', ') || 'none'}.`,
      'TOOL_FORBIDDEN',
    );
  }
  const title = String(args.title ?? '').trim();
  const body = String(args.body ?? '').trim();
  if (!title || !body) throw new Error('create_draft needs a title and a body.');
  const draft = await prisma.teamDraft.create({
    data: {
      memberSlug: ctx.memberSlug,
      kind: kind as never,
      title: title.slice(0, 200),
      body: body.slice(0, 20_000),
      sourceThreadId: ctx.threadId ?? null,
    },
  });
  return { draft: { id: draft.id, kind: draft.kind, title: draft.title, note: 'Stored as a draft. Nothing was sent.' } };
}

/* ------------------------------- registry ------------------------------- */

const OBJ = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'OBJECT',
  properties,
  required,
});
const STR = { type: 'STRING' };
const NUM = { type: 'NUMBER' };

export const TEAM_TOOLS: TeamToolDef[] = [
  {
    name: 'web_search',
    tier: 1,
    description: 'Search the public web (keyless, best effort). Returns up to 5 result titles and URLs.',
    parameters: OBJ({ query: STR }, ['query']),
    available: true,
    run: toolWebSearch,
  },
  {
    name: 'web_fetch',
    tier: 1,
    description: 'Fetch a public web page and return its readable text (first 8000 characters).',
    parameters: OBJ({ url: STR }, ['url']),
    available: true,
    run: toolWebFetch,
  },
  {
    name: 'page_watch',
    tier: 1,
    description: 'Fetch a page and compare its content hash with the last check: first_check, unchanged, or changed.',
    parameters: OBJ({ url: STR }, ['url']),
    available: true,
    run: toolPageWatch,
  },
  {
    name: 'page_screenshot',
    tier: 1,
    description: 'Capture a screenshot of a web page.',
    parameters: OBJ({ url: STR }, ['url']),
    available: false,
    unavailableReason:
      'No headless browser exists in this server stack, so screenshots cannot be captured server-side. Declared unavailable rather than faked.',
  },
  {
    name: 'vf_recent_calls',
    tier: 1,
    description: 'List recent receptionist calls across the platform (newest first), optionally for one tenant slug. No recordings or transcripts in the list.',
    parameters: OBJ({ tenantSlug: STR, limit: NUM }),
    available: true,
    run: toolRecentCalls,
  },
  {
    name: 'vf_call_transcript',
    tier: 1,
    description: 'Read one call in full: summary and transcript by call id.',
    parameters: OBJ({ callId: STR }, ['callId']),
    available: true,
    run: toolCallTranscript,
  },
  {
    name: 'vf_demo_leads',
    tier: 1,
    description: 'List the most recent personalized-demo leads (prospects who tried the demo).',
    parameters: OBJ({ limit: NUM }),
    available: true,
    run: toolDemoLeads,
  },
  {
    name: 'vf_bookings',
    tier: 1,
    description: 'List upcoming bookings across tenants (from yesterday forward).',
    parameters: OBJ({ limit: NUM }),
    available: true,
    run: toolBookings,
  },
  {
    name: 'vf_tenant',
    tier: 1,
    description: 'Look up one tenant by slug: company, status, pricing region, receptionist, and this month\u2019s minutes against its cap.',
    parameters: OBJ({ slug: STR }, ['slug']),
    available: true,
    run: toolTenant,
  },
  {
    name: 'vf_revenue',
    tier: 1,
    description: 'Platform aggregates: tenants by subscription status, calls and billed minutes this month. MRR is not stored; see the note in the result.',
    parameters: OBJ({}),
    available: true,
    run: toolRevenue,
  },
  {
    name: 'repo_list',
    tier: 1,
    description: 'List a directory inside the VoiceFront repository (read-only, path-jailed; secrets and node_modules are blocked).',
    parameters: OBJ({ path: STR }),
    available: true,
    run: toolRepoList,
  },
  {
    name: 'repo_read',
    tier: 1,
    description: 'Read a text file inside the VoiceFront repository (read-only, path-jailed; secrets and binaries are blocked).',
    parameters: OBJ({ path: STR }, ['path']),
    available: true,
    run: toolRepoRead,
  },
  {
    name: 'memory_write',
    tier: 1,
    description: 'Store a note in YOUR OWN memory (never another member\u2019s).',
    parameters: OBJ({ body: STR }, ['body']),
    available: true,
    run: toolMemoryWrite,
  },
  {
    name: 'memory_read',
    tier: 1,
    description: 'Read your own recent memory notes.',
    parameters: OBJ({ limit: NUM }),
    available: true,
    run: toolMemoryRead,
  },
  {
    name: 'create_work_item',
    tier: 2,
    description: 'File a work item in the team queue (title, optional detail, optional owner slug). This is how work reaches Cleo; creating one executes nothing.',
    parameters: OBJ({ title: STR, detail: STR, ownerSlug: STR }, ['title']),
    available: true,
    run: toolCreateWorkItem,
  },
  {
    name: 'create_draft',
    tier: 2,
    description:
      'Store a draft (never sent). The kind must be one of your role\u2019s allowed draft kinds.',
    parameters: OBJ({ kind: STR, title: STR, body: STR }, ['kind', 'title', 'body']),
    available: true,
    run: toolCreateDraft,
  },
];

const TOOL_BY_NAME = new Map(TEAM_TOOLS.map((tool) => [tool.name, tool]));

/** Whether this member may call this tool at all (tier + availability). */
export function memberMayUseTool(memberSlug: string, tool: TeamToolDef): boolean {
  const access = MEMBER_TOOL_ACCESS[memberSlug];
  if (!access) return false;
  if (tool.tier > access.maxTier) return false;
  if (tool.name === 'create_draft') return access.draftKinds.length > 0;
  return true;
}

/** The tools offered to the model for this member: allowed AND available. */
export function toolsForMember(memberSlug: string): TeamToolDef[] {
  return TEAM_TOOLS.filter((tool) => tool.available && memberMayUseTool(memberSlug, tool));
}

export function geminiDeclarationsForMember(memberSlug: string): TeamFunctionDeclaration[] {
  return toolsForMember(memberSlug).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function summarize(value: unknown): string {
  if (value instanceof Error) return value.message.slice(0, 300);
  try {
    return JSON.stringify(value)?.slice(0, 300) ?? String(value).slice(0, 300);
  } catch {
    return String(value).slice(0, 300);
  }
}

/**
 * The one door every tool call walks through: tier check in code, run,
 * log. Rejections are logged too, with the reason as the result summary.
 */
export async function invokeTeamTool(
  ctx: TeamToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = TOOL_BY_NAME.get(name);
  const log = async (ok: boolean, resultSummary: string) => {
    await prisma.teamToolLog.create({
      data: {
        memberSlug: ctx.memberSlug,
        tool: name,
        inputSummary: summarize(args),
        resultSummary: resultSummary.slice(0, 1000),
        ok,
      },
    });
  };
  try {
    if (!tool) throw new HttpError(400, `Unknown tool "${name}".`, 'TOOL_UNKNOWN');
    if (!memberMayUseTool(ctx.memberSlug, tool)) {
      throw new HttpError(
        403,
        `Tool "${name}" is outside ${ctx.memberSlug}\u2019s tier. Allowed tools are computed from their role, not from the prompt.`,
        'TOOL_FORBIDDEN',
      );
    }
    if (!tool.available || !tool.run) {
      throw new HttpError(400, tool.unavailableReason ?? `Tool "${name}" is not available.`, 'TOOL_UNAVAILABLE');
    }
    const result = await tool.run(ctx, args ?? {});
    await log(true, summarize(result));
    return result;
  } catch (err) {
    await log(false, summarize(err)).catch(() => undefined);
    throw err;
  }
}
