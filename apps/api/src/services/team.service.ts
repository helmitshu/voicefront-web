import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import {
  DISCUSS_ROUND2_INSTRUCTION,
  TEAM_MEMBERS,
  VOICEFRONT_CONTEXT_PACK,
  type TeamMemberSeed,
} from './team-content';
import {
  callTeamModel,
  partsToText,
  runMemberConversation,
  type TeamGeminiContent,
} from './team-gemini';
import { geminiDeclarationsForMember, invokeTeamTool } from './team-tools';

/**
 * The team room's conversation engine.
 *
 * - A DM is one member, one thread. The prompt is the member's persona,
 *   the shared VoiceFront context pack, and the thread history (trimmed,
 *   with a rolling summary when the thread grows long). One Gemini call
 *   answers, with the member's tier-allowed tools available to it.
 * - The group channel answers only when the owner @names a member.
 * - The CEO thread is a mailbox, not a model: messages are stored, no
 *   Gemini call is ever made for it. Cleo reads and answers it from
 *   Muse at human rhythm.
 * - Discuss runs two rounds and an auto summary. The Decision slot on a
 *   discussion is written ONLY by setDecision, which records a
 *   CEO-authored message; no member or summary path touches it.
 *   Discuss turns are failure-isolated: one member's model failure
 *   costs that member that round, never the whole discussion, and the
 *   summary says who could not answer. Only a round 1 where every
 *   seated member fails is a 502.
 * - A model failure throws an honest 502. A fabricated reply is worse
 *   than an error, so nothing here invents member text.
 * - Member replies are paced like people: each is stored with a
 *   visibleAt moment (see pacedVisibleAt) and thread reads hold it
 *   back until then, naming who is still typing via a pending
 *   indicator. Owner, CEO and SYSTEM messages are always immediate.
 */

type MemberRow = {
  slug: string;
  name: string;
  role: string;
  avatarPath: string;
  personaPrompt: string;
  modelConfig: string;
  statusLine: string;
};

const HISTORY_WINDOW = 20;
const SUMMARY_TRIGGER = 26;

/* ------------------------------- members -------------------------------- */

export async function ensureTeamMembers(): Promise<MemberRow[]> {
  const members: MemberRow[] = [];
  for (const seed of TEAM_MEMBERS) {
    const member = await prisma.teamMember.upsert({
      where: { slug: seed.slug },
      create: { ...seed },
      update: {
        name: seed.name,
        role: seed.role,
        avatarPath: seed.avatarPath,
        personaPrompt: seed.personaPrompt,
        modelConfig: seed.modelConfig,
        statusLine: seed.statusLine,
      },
    });
    members.push(member);
  }
  return members;
}

export async function getMember(slug: string): Promise<MemberRow> {
  const member = await prisma.teamMember.findUnique({ where: { slug } });
  if (member) return member;
  const seed: TeamMemberSeed | undefined = TEAM_MEMBERS.find((m) => m.slug === slug);
  if (!seed) throw new HttpError(404, `No team member "${slug}".`, 'NOT_FOUND');
  return prisma.teamMember.create({ data: { ...seed } });
}

/* ------------------------------- threads -------------------------------- */

export async function listThreads() {
  return prisma.teamThread.findMany({ orderBy: { updatedAt: 'desc' }, take: 100 });
}

export async function getOrCreateThread(params: {
  type: 'DM' | 'GROUP' | 'CEO';
  memberSlug?: string;
}) {
  if (params.type === 'DM') {
    if (!params.memberSlug) throw new HttpError(400, 'A DM thread needs a memberSlug.', 'BAD_REQUEST');
    const member = await getMember(params.memberSlug);
    const existing = await prisma.teamThread.findFirst({
      where: { type: 'DM', memberSlug: member.slug },
    });
    if (existing) return existing;
    return prisma.teamThread.create({
      data: { type: 'DM', memberSlug: member.slug, title: member.name },
    });
  }
  const existing = await prisma.teamThread.findFirst({ where: { type: params.type } });
  if (existing) return existing;
  return prisma.teamThread.create({
    data: {
      type: params.type,
      title: params.type === 'CEO' ? 'Cleo (CEO)' : 'Team channel',
    },
  });
}

export async function getThread(threadId: string) {
  const thread = await prisma.teamThread.findUnique({ where: { id: threadId } });
  if (!thread) throw new HttpError(404, 'Thread not found.', 'NOT_FOUND');
  return thread;
}

/**
 * The full stored history, hidden replies included. Internal only:
 * prompt building and summaries must see the real conversation, never
 * the paced view.
 */
export async function listMessages(threadId: string) {
  await getThread(threadId);
  return prisma.teamMessage.findMany({
    where: { threadId },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
}

export type ThreadPending = {
  /** Slugs of members with a reply still on its way, in reply order. */
  memberSlugs: string[];
  /** When the next hidden reply lands, or null when nothing is pending. */
  nextVisibleAt: Date | null;
};

/**
 * What the room shows: member replies whose visibleAt has not passed
 * yet are held back, and the pending indicator names who is still
 * "typing" and when the next reply lands, so the UI can show it.
 */
export async function getThreadView(
  threadId: string,
): Promise<{ messages: MessageRow[]; pending: ThreadPending }> {
  const all = (await listMessages(threadId)) as MessageRow[];
  const now = new Date();
  const isHidden = (m: MessageRow) =>
    m.authorType === 'MEMBER' && m.visibleAt !== null && m.visibleAt > now;
  const messages = all.filter((m) => !isHidden(m));
  const waiting = all.filter(isHidden);
  const memberSlugs: string[] = [];
  for (const m of waiting) {
    if (m.authorSlug && !memberSlugs.includes(m.authorSlug)) memberSlugs.push(m.authorSlug);
  }
  const nextVisibleAt =
    waiting.length > 0
      ? new Date(Math.min(...waiting.map((m) => (m.visibleAt as Date).getTime())))
      : null;
  return { messages, pending: { memberSlugs, nextVisibleAt } };
}

type MessageRow = {
  id: string;
  threadId: string;
  authorType: string;
  authorSlug: string | null;
  label: string | null;
  body: string;
  visibleAt: Date | null;
  createdAt: Date;
};

/* ---------------------------- human pacing ------------------------------ */

/**
 * Member replies land at a human pace, not machine pace. A reply is
 * stored right away (so history and summaries see the real conversation)
 * but carries a visibleAt moment and stays out of thread reads until it
 * passes. The delay is a thinking beat plus typing time at roughly 18
 * characters per second, clamped so short replies still feel considered
 * and long ones never stall the room. Pacing never alters content.
 */
const PACING_BASE_MS = 1_500;
const PACING_CHARS_PER_SECOND = 18;
const PACING_MIN_MS = 3_000;
const PACING_MAX_MS = 25_000;
/** Minimum gap between one member reply becoming visible and the next. */
const PACING_STAGGER_MS = 4_000;

export function pacedVisibleAt(body: string, notBefore?: Date | null): Date {
  const typingMs = (body.length / PACING_CHARS_PER_SECOND) * 1_000;
  const delay = Math.min(
    PACING_MAX_MS,
    Math.max(PACING_MIN_MS, PACING_BASE_MS + typingMs),
  );
  const at = Date.now() + delay;
  return new Date(notBefore && notBefore.getTime() > at ? notBefore.getTime() : at);
}

async function storeMessage(params: {
  threadId: string;
  authorType: 'OWNER' | 'MEMBER' | 'CEO' | 'SYSTEM';
  authorSlug?: string | null;
  label?: string | null;
  body: string;
  visibleAt?: Date | null;
}): Promise<MessageRow> {
  const message = await prisma.teamMessage.create({
    data: {
      threadId: params.threadId,
      authorType: params.authorType,
      authorSlug: params.authorSlug ?? null,
      label: params.label ?? null,
      body: params.body,
      visibleAt: params.visibleAt ?? null,
    },
  });
  await prisma.teamThread.update({
    where: { id: params.threadId },
    data: { updatedAt: new Date() },
  });
  return message as MessageRow;
}

/* ---------------------------- prompt building ---------------------------- */

function memberSystem(member: MemberRow, threadSummary?: string | null): string {
  const parts = [member.personaPrompt, '', VOICEFRONT_CONTEXT_PACK];
  if (threadSummary) {
    parts.push('', `Earlier in this conversation (summary, so you do not lose the thread): ${threadSummary}`);
  }
  return parts.join('\n');
}

function toContents(
  messages: MessageRow[],
  answeringSlug: string,
  memberNames: Map<string, string>,
): TeamGeminiContent[] {
  return messages.map((message) => {
    if (message.authorType === 'MEMBER' && message.authorSlug === answeringSlug) {
      return { role: 'model', parts: [{ text: message.body }] };
    }
    if (message.authorType === 'MEMBER') {
      const name = memberNames.get(message.authorSlug ?? '') ?? message.authorSlug ?? 'A teammate';
      return { role: 'user', parts: [{ text: `[${name}]: ${message.body}` }] };
    }
    if (message.authorType === 'SYSTEM') {
      return { role: 'user', parts: [{ text: `[Auto summary]: ${message.body}` }] };
    }
    if (message.authorType === 'CEO') {
      return { role: 'user', parts: [{ text: `[Cleo, CEO]: ${message.body}` }] };
    }
    return { role: 'user', parts: [{ text: message.body }] };
  });
}

/**
 * Rolling summary: once a thread outgrows the window, the older part is
 * summarized into thread.contextSummary by a neutral summarizer call, so
 * the member keeps the start of the conversation instead of silently
 * forgetting it. Best effort: on failure the raw window is used and the
 * summary stays for a later retry.
 */
async function refreshSummaryIfNeeded(threadId: string, member: MemberRow): Promise<string | null> {
  const thread = await getThread(threadId);
  if (thread.contextSummary) return thread.contextSummary;
  const total = await prisma.teamMessage.count({ where: { threadId } });
  if (total <= SUMMARY_TRIGGER) return null;
  const older = await prisma.teamMessage.findMany({
    where: { threadId },
    orderBy: { createdAt: 'asc' },
    take: total - HISTORY_WINDOW,
  });
  if (older.length === 0) return null;
  try {
    const parts = await callTeamModel({
      model: member.modelConfig,
      memberSlug: member.slug,
      systemText:
        'You summarize a work conversation in at most 120 words: decisions made, facts stated, open questions. Plain text, no preamble.',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: older
                .map((m) => `${m.authorType}${m.authorSlug ? ` (${m.authorSlug})` : ''}: ${m.body}`)
                .join('\n'),
            },
          ],
        },
      ],
    });
    const summary = partsToText(parts);
    if (summary) {
      await prisma.teamThread.update({ where: { id: threadId }, data: { contextSummary: summary } });
      return summary;
    }
  } catch (err) {
    console.warn(`[team] Rolling summary failed for thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

async function memberReply(params: {
  thread: { id: string; contextSummary: string | null };
  member: MemberRow;
  history: MessageRow[];
  /** Earliest moment this reply may become visible (stagger chaining). */
  notBefore?: Date | null;
}): Promise<MessageRow> {
  const members = await ensureTeamMembers();
  const names = new Map(members.map((m) => [m.slug, m.name]));
  const summary = await refreshSummaryIfNeeded(params.thread.id, params.member);
  const window = params.history.slice(-HISTORY_WINDOW);
  const text = await runMemberConversation({
    model: params.member.modelConfig,
    memberSlug: params.member.slug,
    systemText: memberSystem(params.member, summary ?? params.thread.contextSummary),
    contents: toContents(window, params.member.slug, names),
    functionDeclarations: geminiDeclarationsForMember(params.member.slug),
    executeTool: (name, args) =>
      invokeTeamTool({ memberSlug: params.member.slug, threadId: params.thread.id }, name, args),
  });
  return storeMessage({
    threadId: params.thread.id,
    authorType: 'MEMBER',
    authorSlug: params.member.slug,
    body: text,
    visibleAt: pacedVisibleAt(text, params.notBefore),
  });
}

/* ------------------------------ posting --------------------------------- */

function mentionedMember(body: string, members: MemberRow[]): MemberRow | null {
  const mentions = [...body.matchAll(/@([a-zA-Z]+)/g)].map((m) => m[1].toLowerCase());
  for (const mention of mentions) {
    const hit = members.find(
      (member) =>
        member.slug === mention || member.name.toLowerCase().split(' ')[0] === mention,
    );
    if (hit) return hit;
  }
  return null;
}

export async function postMessage(
  threadId: string,
  params: { body: string; authorType?: 'OWNER' | 'CEO' },
): Promise<{ message: MessageRow; reply?: MessageRow }> {
  const body = params.body?.trim();
  if (!body) throw new HttpError(400, 'A message needs a body.', 'BAD_REQUEST');
  const thread = await getThread(threadId);
  const authorType = params.authorType ?? 'OWNER';

  if (authorType === 'CEO') {
    // Cleo posting from Muse. Only meaningful in the CEO channel;
    // it never triggers a model call anywhere.
    if (thread.type !== 'CEO') {
      throw new HttpError(400, 'CEO-authored messages belong in the CEO channel.', 'BAD_REQUEST');
    }
    const message = await storeMessage({ threadId, authorType: 'CEO', authorSlug: 'cleo', body });
    return { message };
  }

  const message = await storeMessage({ threadId, authorType: 'OWNER', body });

  if (thread.type === 'CEO') {
    // The CEO channel is a mailbox. Stored, never answered by a model.
    return { message };
  }

  if (thread.type === 'DM') {
    if (!thread.memberSlug) throw new HttpError(500, 'DM thread has no member.', 'THREAD_BROKEN');
    const member = await getMember(thread.memberSlug);
    const history = (await listMessages(threadId)) as MessageRow[];
    const reply = await memberReply({ thread, member, history });
    return { message, reply };
  }

  if (thread.type === 'GROUP') {
    const members = await ensureTeamMembers();
    const target = mentionedMember(body, members);
    if (!target) return { message };
    const history = (await listMessages(threadId)) as MessageRow[];
    const reply = await memberReply({ thread, member: target, history });
    return { message, reply };
  }

  // DISCUSS threads collect owner messages without auto-replies; the
  // debate itself runs through startDiscussion.
  return { message };
}

/* ------------------------------- discuss -------------------------------- */

export async function startDiscussion(params: {
  topic: string;
  memberSlugs?: string[];
}): Promise<{ thread: unknown; messages: MessageRow[] }> {
  const topic = params.topic?.trim();
  if (!topic) throw new HttpError(400, 'A discussion needs a topic.', 'BAD_REQUEST');
  const all = await ensureTeamMembers();
  const seated = params.memberSlugs && params.memberSlugs.length > 0
    ? all.filter((member) => params.memberSlugs!.includes(member.slug))
    : all;
  if (seated.length === 0) throw new HttpError(400, 'A discussion needs at least one seated member.', 'BAD_REQUEST');

  const thread = await prisma.teamThread.create({
    data: { type: 'DISCUSS', title: topic.slice(0, 120), topic },
  });
  const messages: MessageRow[] = [];
  messages.push(
    await storeMessage({ threadId: thread.id, authorType: 'OWNER', body: topic }),
  );

  const names = new Map(all.map((m) => [m.slug, m.name]));
  // Replies surface one person at a time: each member's visibleAt is
  // chained at least PACING_STAGGER_MS after the previous reply's, so
  // the thread reads like people taking turns, not a wall landing at
  // once.
  let nextNotBefore: Date | null = null;
  // Failure isolation: one member's model failing (after the retry
  // layer has had its chances) must not kill the whole discussion.
  // The failed member simply has no message that round; the names are
  // collected so the auto summary can say so plainly.
  const failedToAnswer = new Map<string, string>();
  const ask = async (member: MemberRow, extra: string): Promise<MessageRow | null> => {
    try {
      const history = (await listMessages(thread.id)) as MessageRow[];
      const contents = toContents(history.slice(-HISTORY_WINDOW), member.slug, names);
      contents.push({ role: 'user', parts: [{ text: extra }] });
      const text = await runMemberConversation({
        model: member.modelConfig,
        memberSlug: member.slug,
        systemText: memberSystem(member),
        contents,
        functionDeclarations: geminiDeclarationsForMember(member.slug),
        executeTool: (name, args) =>
          invokeTeamTool({ memberSlug: member.slug, threadId: thread.id }, name, args),
      });
      const stored = await storeMessage({
        threadId: thread.id,
        authorType: 'MEMBER',
        authorSlug: member.slug,
        body: text,
        visibleAt: pacedVisibleAt(text, nextNotBefore),
      });
      if (stored.visibleAt) {
        nextNotBefore = new Date(stored.visibleAt.getTime() + PACING_STAGGER_MS);
      }
      messages.push(stored);
      return stored;
    } catch (err) {
      console.warn(
        `[team] Discussion turn failed for ${member.slug} (thread ${thread.id}): ${err instanceof Error ? err.message : String(err)}`,
      );
      failedToAnswer.set(member.slug, member.name);
      return null;
    }
  };

  // Round 1: positions.
  let round1Answers = 0;
  for (const member of seated) {
    if (await ask(member, `Discussion topic: ${topic}\n\nGive your position on this topic, in your seat, in a few short lines.`)) {
      round1Answers += 1;
    }
  }
  // A discussion where nobody could speak is a failure, honestly
  // reported; anything short of that continues with who is left.
  if (round1Answers === 0) {
    throw new HttpError(502, 'No team member could answer just now. Please try again.', 'MODEL_ERROR');
  }
  // Round 2: each member must agree with one point and challenge another.
  for (const member of seated) {
    await ask(member, DISCUSS_ROUND2_INSTRUCTION);
  }

  // Auto summary: authored SYSTEM, labeled, never a member's voice, and
  // it never touches the Decision slot. The summary step is told which
  // members could not answer so it can say so plainly; if the summary
  // call itself fails, a plain SYSTEM note takes its place rather than
  // failing a discussion the members did complete.
  const failedNames = [...failedToAnswer.values()];
  const history = (await listMessages(thread.id)) as MessageRow[];
  const transcript = history
    .map((m) => `${m.authorType === 'MEMBER' ? (names.get(m.authorSlug ?? '') ?? m.authorSlug) : m.authorType}: ${m.body}`)
    .join('\n');
  const summaryInput =
    transcript.slice(0, 12_000) +
    (failedNames.length > 0
      ? `\n\nNote: ${failedNames.join(', ')} could not answer in this discussion. Say so plainly in the summary.`
      : '');
  let summaryText = '';
  try {
    const parts = await callTeamModel({
      model: seated[0].modelConfig,
      systemText:
        'You write a neutral auto summary of a team discussion: each position in one line, where they agreed, what they challenged, and the open questions. Short and plain. You are not a participant and you make no decision.',
      contents: [{ role: 'user', parts: [{ text: summaryInput }] }],
    });
    summaryText = partsToText(parts);
  } catch (err) {
    console.warn(
      `[team] Discussion summary failed (thread ${thread.id}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!summaryText) {
    summaryText =
      'Auto summary unavailable: the summary step could not be completed for this discussion.' +
      (failedNames.length > 0 ? ` ${failedNames.join(', ')} could not answer.` : '');
  }
  messages.push(
    await storeMessage({
      threadId: thread.id,
      authorType: 'SYSTEM',
      label: 'AUTO_SUMMARY',
      body: summaryText,
    }),
  );

  const finalThread = await getThread(thread.id);
  return { thread: finalThread, messages };
}

/**
 * The Decision slot. Only this function writes thread.decision, and it
 * records the decision as a CEO-authored message: the API voices (members,
 * summaries) can never fill it. Cleo calls this from Muse.
 */
export async function setDecision(threadId: string, decision: string) {
  const text = decision?.trim();
  if (!text) throw new HttpError(400, 'A decision needs text.', 'BAD_REQUEST');
  const thread = await getThread(threadId);
  if (thread.type !== 'DISCUSS') {
    throw new HttpError(400, 'Only discussions carry a decision slot.', 'BAD_REQUEST');
  }
  await storeMessage({ threadId, authorType: 'CEO', authorSlug: 'cleo', body: text });
  return prisma.teamThread.update({
    where: { id: threadId },
    data: { decision: text, decisionAt: new Date() },
  });
}

/* ------------------------------ work items ------------------------------- */

export async function listWorkItems() {
  return prisma.workItem.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
}

export async function createWorkItem(params: {
  title: string;
  detail?: string;
  ownerSlug: string;
  sourceThreadId?: string;
}) {
  const title = params.title?.trim();
  if (!title) throw new HttpError(400, 'A work item needs a title.', 'BAD_REQUEST');
  await getMember(params.ownerSlug); // validates the owner is a real member
  return prisma.workItem.create({
    data: {
      title: title.slice(0, 200),
      detail: params.detail?.slice(0, 4000) ?? null,
      ownerSlug: params.ownerSlug,
      sourceThreadId: params.sourceThreadId ?? null,
    },
  });
}

const WORK_ITEM_STATUSES = ['QUEUED', 'IN_PROGRESS', 'DONE'] as const;

export async function updateWorkItemStatus(id: string, status: string) {
  if (!(WORK_ITEM_STATUSES as readonly string[]).includes(status)) {
    throw new HttpError(400, `Status must be one of ${WORK_ITEM_STATUSES.join(', ')}.`, 'BAD_REQUEST');
  }
  const existing = await prisma.workItem.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'Work item not found.', 'NOT_FOUND');
  return prisma.workItem.update({ where: { id }, data: { status: status as never } });
}
