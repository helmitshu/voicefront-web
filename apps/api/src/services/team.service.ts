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
  /** A discussion debate is still running for this thread. */
  active: boolean;
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
  return { messages, pending: { memberSlugs, nextVisibleAt, active: discussionActive(threadId) } };
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
 * Member replies carry a visibleAt moment and stay out of thread reads
 * until it passes, so the room can show who is "typing". The delay is
 * only a breath: a small beat plus a fast typing shimmer, capped at
 * about two seconds. (An earlier build paced replies at reading speed,
 * 3 to 25 seconds each with a 4 second stagger; the owner experienced
 * that as a slow, broken room, and he was right. Teams replies land
 * when they are ready.) Pacing never alters content.
 */
const PACING_BASE_MS = 350;
const PACING_CHARS_PER_SECOND = 90;
const PACING_MIN_MS = 500;
const PACING_MAX_MS = 2_000;

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

/**
 * Discussions in flight, by thread id. Starting a discussion returns
 * as soon as the thread and the owner's topic are stored; the debate
 * runs in the background and its replies land in the thread as they
 * are generated, where the room's polling picks them up. (The first
 * build ran the whole debate inside the start request: eight or more
 * sequential model conversations before any response, which on a
 * phone read as "the discussion doesn't start".) This registry is
 * what lets the thread view report a live discussion, and what tests
 * await. It is deliberately in-process: the API runs as a single
 * instance, and a restart mid-discussion simply ends the run, with
 * the thread keeping whatever replies already landed.
 */
const runningDiscussions = new Map<string, Promise<void>>();

export function discussionActive(threadId: string): boolean {
  return runningDiscussions.has(threadId);
}

/** Settles when the background debate for a thread ends. Test seam. */
export async function awaitDiscussion(threadId: string): Promise<void> {
  const run = runningDiscussions.get(threadId);
  if (run) await run.catch(() => undefined);
}

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
  const topicMessage = await storeMessage({ threadId: thread.id, authorType: 'OWNER', body: topic });

  const run = runDiscussion({ threadId: thread.id, seated, all, topic }).catch((err) => {
    console.warn(
      `[team] Discussion run failed (thread ${thread.id}): ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  runningDiscussions.set(thread.id, run);
  void run.finally(() => {
    if (runningDiscussions.get(thread.id) === run) runningDiscussions.delete(thread.id);
  });
  return { thread, messages: [topicMessage] };
}

async function runDiscussion(params: {
  threadId: string;
  seated: MemberRow[];
  all: MemberRow[];
  topic: string;
}): Promise<void> {
  const { threadId, seated, all, topic } = params;
  const messages: MessageRow[] = [];
  const names = new Map(all.map((m) => [m.slug, m.name]));
  // Failure isolation: one member's model failing (after the retry
  // layer has had its chances) must not kill the whole discussion.
  // The failed member simply has no message that round; the names are
  // collected so the auto summary can say so plainly.
  const failedToAnswer = new Map<string, string>();
  // Who actually spoke. The auto summary borrows the first seated
  // answerer's key, so it does not have to run on the shared pool
  // (which the members' own traffic may have drained by the time the
  // discussion ends).
  const answered = new Set<string>();
  const ask = async (
    member: MemberRow,
    extra: string,
    snapshot: MessageRow[],
  ): Promise<MessageRow | null> => {
    try {
      const contents = toContents(snapshot.slice(-HISTORY_WINDOW), member.slug, names);
      contents.push({ role: 'user', parts: [{ text: extra }] });
      const text = await runMemberConversation({
        model: member.modelConfig,
        memberSlug: member.slug,
        systemText: memberSystem(member),
        contents,
        functionDeclarations: geminiDeclarationsForMember(member.slug),
        executeTool: (name, args) =>
          invokeTeamTool({ memberSlug: member.slug, threadId }, name, args),
      });
      const stored = await storeMessage({
        threadId,
        authorType: 'MEMBER',
        authorSlug: member.slug,
        body: text,
        visibleAt: pacedVisibleAt(text),
      });
      answered.add(member.slug);
      messages.push(stored);
      return stored;
    } catch (err) {
      console.warn(
        `[team] Discussion turn failed for ${member.slug} (thread ${threadId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      failedToAnswer.set(member.slug, member.name);
      return null;
    }
  };

  // Round 1: positions. The seated members answer in parallel from
  // the same snapshot (the topic alone), so the round takes as long
  // as the slowest member, not the sum of all of them.
  const afterTopic = (await listMessages(threadId)) as MessageRow[];
  const round1 = await Promise.all(
    seated.map((member) =>
      ask(
        member,
        `Discussion topic: ${topic}\n\nGive your position on this topic, in your seat, in a few short lines.`,
        afterTopic,
      ),
    ),
  );
  const round1Answers = round1.filter((m) => m !== null).length;
  // A discussion where nobody could speak is a failure, said plainly
  // in the thread itself, where the owner is already looking; anything
  // short of that continues with who is left.
  if (round1Answers === 0) {
    await storeMessage({
      threadId,
      authorType: 'SYSTEM',
      body: 'No team member could answer just now. Please try again.',
    });
    return;
  }
  // Round 2: each member must agree with one point and challenge
  // another. Same treatment: one shared snapshot (the topic plus every
  // round 1 position), also answered in parallel.
  const afterRound1 = (await listMessages(threadId)) as MessageRow[];
  await Promise.all(seated.map((member) => ask(member, DISCUSS_ROUND2_INSTRUCTION, afterRound1)));

  // Auto summary: authored SYSTEM, labeled, never a member's voice, and
  // it never touches the Decision slot. The summary step is told which
  // members could not answer so it can say so plainly; if the summary
  // call itself fails, a plain SYSTEM note takes its place rather than
  // failing a discussion the members did complete. The call runs on
  // the first answering member's key rather than the shared chain: the
  // shared pool may be drained by the time the discussion ends, and a
  // finished discussion should not lose its summary to that. With no
  // answerer to borrow from it keeps the shared chain (defensive only:
  // the round 1 gate above has already thrown when nobody answered).
  const failedNames = [...failedToAnswer.values()];
  const history = (await listMessages(threadId)) as MessageRow[];
  const transcript = history
    .map((m) => `${m.authorType === 'MEMBER' ? (names.get(m.authorSlug ?? '') ?? m.authorSlug) : m.authorType}: ${m.body}`)
    .join('\n');
  const summaryInput =
    transcript.slice(0, 12_000) +
    (failedNames.length > 0
      ? `\n\nNote: ${failedNames.join(', ')} could not answer in this discussion. Say so plainly in the summary.`
      : '');
  const summarySlug = seated.find((member) => answered.has(member.slug))?.slug;
  let summaryText = '';
  try {
    const parts = await callTeamModel({
      model: seated[0].modelConfig,
      memberSlug: summarySlug,
      systemText:
        'You write a neutral auto summary of a team discussion: each position in one line, where they agreed, what they challenged, and the open questions. Short and plain. You are not a participant and you make no decision.',
      contents: [{ role: 'user', parts: [{ text: summaryInput }] }],
    });
    summaryText = partsToText(parts);
  } catch (err) {
    console.warn(
      `[team] Discussion summary failed (thread ${threadId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!summaryText) {
    summaryText =
      'Auto summary unavailable: the summary step could not be completed for this discussion.' +
      (failedNames.length > 0 ? ` ${failedNames.join(', ')} could not answer.` : '');
  }
  messages.push(
    await storeMessage({
      threadId,
      authorType: 'SYSTEM',
      label: 'AUTO_SUMMARY',
      body: summaryText,
    }),
  );
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
