'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  TeamApi,
  type FailureCase,
  type TeamDraft,
  type TeamMember,
  type TeamMessage,
  type TeamPending,
  type TeamThread,
  type TeamToolInfo,
  type TeamToolLogEntry,
  type WorkItem,
  type WorkItemStatus,
} from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';

type View = 'chat' | 'work' | 'drafts' | 'activity' | 'failures' | 'abilities';
type PaneMode = 'thread' | 'new-discuss';

const EMPTY_PENDING: TeamPending = { memberSlugs: [], nextVisibleAt: null, active: false };

const WORK_STATUS_LABEL: Record<WorkItemStatus, string> = {
  QUEUED: 'Queued',
  IN_PROGRESS: 'In progress',
  DONE: 'Done',
};

const WORK_STATUS_TONE: Record<WorkItemStatus, 'neutral' | 'signal' | 'success'> = {
  QUEUED: 'neutral',
  IN_PROGRESS: 'signal',
  DONE: 'success',
};

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function AdminAiTeamPage() {
  const { toast } = useToast();

  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [threads, setThreads] = useState<TeamThread[] | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [toolLog, setToolLog] = useState<TeamToolLogEntry[]>([]);
  const [drafts, setDrafts] = useState<TeamDraft[]>([]);
  const [failureCases, setFailureCases] = useState<FailureCase[]>([]);
  const [tools, setTools] = useState<TeamToolInfo[]>([]);
  const [memberTools, setMemberTools] = useState<Record<string, string[]>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const [view, setView] = useState<View>('chat');
  const [paneMode, setPaneMode] = useState<PaneMode>('thread');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TeamMessage[] | null>(null);
  const [pending, setPending] = useState<TeamPending>(EMPTY_PENDING);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [openingSlug, setOpeningSlug] = useState<string | null>(null);
  /** Mobile only: the conversation is full-screen (Messenger style) unless
   *  the founder taps back, which brings the nav chrome back into view. */
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  /** Mobile only: the discussion details sheet (topic, seated, decision). */
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [discussTopic, setDiscussTopic] = useState('');
  const [discussSeats, setDiscussSeats] = useState<Set<string>>(new Set());
  const [discussBusy, setDiscussBusy] = useState(false);

  const [decisionDraft, setDecisionDraft] = useState('');
  const [decisionBusy, setDecisionBusy] = useState(false);

  const [newWorkTitle, setNewWorkTitle] = useState('');
  const [newWorkOwner, setNewWorkOwner] = useState('');
  const [workBusy, setWorkBusy] = useState(false);

  const [expandedDraftId, setExpandedDraftId] = useState<string | null>(null);

  const [abilityBusy, setAbilityBusy] = useState<string | null>(null);
  const [abilityResult, setAbilityResult] = useState<string | null>(null);
  const [redTeamPlan, setRedTeamPlan] = useState('');
  const [dossierWebsite, setDossierWebsite] = useState('');
  const [dossierBusiness, setDossierBusiness] = useState('');

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const autoOpenedRef = useRef(false);

  const memberBySlug = useMemo(() => {
    const map = new Map<string, TeamMember>();
    for (const m of members ?? []) map.set(m.slug, m);
    return map;
  }, [members]);

  const memberName = useCallback(
    (slug: string | null | undefined): string => {
      if (!slug) return 'Team member';
      return memberBySlug.get(slug)?.name ?? slug;
    },
    [memberBySlug],
  );

  const selectedThread = useMemo(
    () => (threads ?? []).find((t) => t.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  );

  const typingSlugs = useMemo(() => new Set(pending.memberSlugs), [pending]);

  /** Members seated in the open discussion: anyone who has spoken, plus
   *  anyone currently typing. The thread payload carries no participant
   *  list, so this derived set is the only seated set the client can know. */
  const seatedMembers = useMemo(
    () =>
      (members ?? []).filter(
        (m) =>
          (messages ?? []).some(
            (msg) => msg.authorType === 'MEMBER' && msg.authorSlug === m.slug,
          ) || typingSlugs.has(m.slug),
      ),
    [members, messages, typingSlugs],
  );

  /** Mobile Messenger mode: a thread is open and the nav chrome is tucked
   *  away, so the conversation (slim bar, thread, composer) gets the whole
   *  screen. Inert at lg, where the two-pane layout rules. */
  const mobileThreadMode =
    view === 'chat' && paneMode === 'thread' && !!selectedThread && !mobileNavOpen;

  const loadThreads = useCallback(async () => {
    const { threads: rows } = await TeamApi.threads();
    setThreads(rows);
    return rows;
  }, []);

  const loadWorkItems = useCallback(async () => {
    try {
      const { workItems: rows } = await TeamApi.workItems();
      setWorkItems(rows);
    } catch {
      /* section stays empty; main load surfaces API errors */
    }
  }, []);

  const loadDrafts = useCallback(async () => {
    try {
      const { drafts: rows } = await TeamApi.drafts();
      setDrafts(rows);
    } catch {
      /* section stays empty */
    }
  }, []);

  const loadToolLog = useCallback(async () => {
    try {
      const { entries } = await TeamApi.toolLog();
      setToolLog(entries);
    } catch {
      /* section stays empty */
    }
  }, []);

  const loadActivity = useCallback(async () => {
    await Promise.allSettled([loadWorkItems(), loadDrafts(), loadToolLog()]);
    try {
      const { cases } = await TeamApi.failureCases();
      setFailureCases(cases);
    } catch {
      /* section stays empty */
    }
    try {
      const data = await TeamApi.tools();
      setTools(data.tools);
      setMemberTools(data.memberTools);
    } catch {
      /* tools list stays empty */
    }
  }, [loadDrafts, loadToolLog, loadWorkItems]);

  /**
   * Loads the paced thread view: visible messages plus the pending
   * indicator. Silent refreshes (polling) keep the current messages on
   * screen so the pane never flickers back to a spinner.
   */
  const refreshThread = useCallback(async (threadId: string, silent = false) => {
    if (!silent) {
      setMessages(null);
      setMessagesError(null);
    }
    try {
      const { messages: rows, pending: nextPending } = await TeamApi.messages(threadId);
      setMessages(rows);
      setPending(nextPending ?? EMPTY_PENDING);
      setMessagesError(null);
    } catch (err) {
      if (!silent) {
        setMessages([]);
        setPending(EMPTY_PENDING);
        setMessagesError(errMessage(err, 'Could not load messages for this thread.'));
      }
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoadError(null);
    try {
      const [{ members: memberRows }] = await Promise.all([TeamApi.members(), loadThreads()]);
      setMembers(memberRows);
      setDiscussSeats(new Set(memberRows.map((m) => m.slug)));
      if (memberRows.length > 0) setNewWorkOwner((prev) => prev || memberRows[0].slug);
    } catch (err) {
      setLoadError(errMessage(err, 'Could not load the AI team.'));
      setMembers([]);
      setThreads([]);
    }
    await loadActivity();
  }, [loadActivity, loadThreads]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, pending, sending]);

  // While a reply is on its way, or a discussion debate is still
  // running, poll the open thread every 2 seconds so replies land the
  // moment they are ready. The poll stops on its own when nothing is
  // pending and no debate is live.
  const pendingCount = pending.memberSlugs.length;
  const discussionLive = pending.active;
  useEffect(() => {
    if (!selectedThreadId || (pendingCount === 0 && !discussionLive)) return;
    const id = setInterval(() => {
      void refreshThread(selectedThreadId, true);
    }, 2000);
    return () => clearInterval(id);
  }, [selectedThreadId, pendingCount, discussionLive, refreshThread]);

  const openThread = useCallback(
    (thread: TeamThread) => {
      setView('chat');
      setPaneMode('thread');
      setSelectedThreadId(thread.id);
      setPending(EMPTY_PENDING);
      setSendError(null);
      setMobileNavOpen(false);
      setDetailsOpen(false);
      void refreshThread(thread.id);
    },
    [refreshThread],
  );

  const openThreadByType = useCallback(
    async (type: TeamThread['type'], memberSlug?: string) => {
      const busyKey = memberSlug ?? type;
      setOpeningSlug(busyKey);
      try {
        const { thread } = await TeamApi.createThread(
          memberSlug ? { type, memberSlug } : { type },
        );
        setThreads((prev) => {
          const rows = prev ?? [];
          return rows.some((t) => t.id === thread.id) ? rows : [thread, ...rows];
        });
        openThread(thread);
      } catch (err) {
        toast(errMessage(err, 'Could not open that thread.'), 'error');
      } finally {
        setOpeningSlug(null);
      }
    },
    [openThread, toast],
  );

  // Land in the room, Teams style: the group channel opens first.
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (!members || !threads || selectedThreadId) return;
    autoOpenedRef.current = true;
    void openThreadByType('GROUP');
  }, [members, threads, selectedThreadId, openThreadByType]);

  async function handleSend() {
    const body = composer.trim();
    if (!body || !selectedThreadId || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await TeamApi.sendMessage(selectedThreadId, body);
      setComposer('');
      // The owner message is visible immediately; a member reply now
      // arrives at human pace, so refresh the view and let the pending
      // indicator (and its poll) carry it in when it lands.
      await refreshThread(selectedThreadId, true);
      void loadThreads().catch(() => undefined);
      void loadActivity();
    } catch (err) {
      const message = errMessage(err, 'That message could not be sent. No reply was generated.');
      setSendError(message);
      toast(message, 'error');
      // Reload from the server so we only ever show real, stored messages.
      void refreshThread(selectedThreadId);
    } finally {
      setSending(false);
    }
  }

  async function handleRecordDecision() {
    const decision = decisionDraft.trim();
    if (!decision || !selectedThreadId || decisionBusy) return;
    setDecisionBusy(true);
    try {
      const result = await TeamApi.setDecision(selectedThreadId, decision);
      setDecisionDraft('');
      setThreads((prev) =>
        (prev ?? []).map((t) => (t.id === result.thread.id ? result.thread : t)),
      );
      // The decision lands in the thread as a CEO-authored message.
      void refreshThread(selectedThreadId, true);
    } catch (err) {
      toast(errMessage(err, 'That decision could not be recorded.'), 'error');
    } finally {
      setDecisionBusy(false);
    }
  }

  async function handleDiscuss() {
    const topic = discussTopic.trim();
    if (!topic) {
      toast('Write a topic first.', 'error');
      return;
    }
    setDiscussBusy(true);
    try {
      const seats = Array.from(discussSeats);
      const { thread } = await TeamApi.discuss({
        topic,
        ...(seats.length > 0 ? { memberSlugs: seats } : {}),
      });
      toast('Discussion started. Replies land as the team weighs in.', 'success');
      setDiscussTopic('');
      await loadThreads().catch(() => undefined);
      openThread(thread);
      void loadActivity();
    } catch (err) {
      toast(errMessage(err, 'Could not start that discussion.'), 'error');
    } finally {
      setDiscussBusy(false);
    }
  }

  async function handleAddWorkItem() {
    const title = newWorkTitle.trim();
    if (!title) {
      toast('Give the work item a title first.', 'error');
      return;
    }
    if (!newWorkOwner) {
      toast('Pick an owner first.', 'error');
      return;
    }
    setWorkBusy(true);
    try {
      await TeamApi.createWorkItem({ title, ownerSlug: newWorkOwner });
      setNewWorkTitle('');
      toast('Work item added to the queue.', 'success');
      await loadWorkItems();
    } catch (err) {
      toast(errMessage(err, 'Could not add that work item.'), 'error');
    } finally {
      setWorkBusy(false);
    }
  }

  async function handleWorkStatus(item: WorkItem, status: WorkItemStatus) {
    try {
      const { workItem } = await TeamApi.updateWorkItem(item.id, status);
      setWorkItems((prev) => prev.map((w) => (w.id === workItem.id ? workItem : w)));
    } catch (err) {
      toast(errMessage(err, 'Could not update that work item.'), 'error');
    }
  }

  async function runAbility(key: string, fn: () => Promise<string>) {
    setAbilityBusy(key);
    setAbilityResult(null);
    try {
      const summary = await fn();
      setAbilityResult(summary);
      toast(summary, 'success');
      await Promise.allSettled([loadDrafts(), loadWorkItems(), loadToolLog(), loadThreads()]);
    } catch (err) {
      const message = errMessage(err, 'That ability run failed.');
      setAbilityResult(message);
      toast(message, 'error');
    } finally {
      setAbilityBusy(null);
    }
  }

  /** The decision block's inner content, shared by the desktop in-flow
   *  block and the mobile details sheet so both read and record through
   *  the same state and handler. */
  function renderDecisionContent() {
    if (!selectedThread) return null;
    return (
      <>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Decision</p>
        {selectedThread.decision ? (
          <>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink">
              {selectedThread.decision}
            </p>
            {selectedThread.decisionAt && (
              <p className="mt-1 text-xs text-ink-muted">
                Recorded {formatDateTime(selectedThread.decisionAt)}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-muted">
              No decision yet. Only Cleo can record one.
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                value={decisionDraft}
                onChange={(e) => setDecisionDraft(e.target.value)}
                placeholder="Record Cleo's decision"
                className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-muted/70"
              />
              <button
                type="button"
                onClick={() => void handleRecordDecision()}
                disabled={!decisionDraft.trim() || decisionBusy}
                className="shrink-0 rounded-lg bg-ink px-3 py-2 text-sm font-medium text-paper transition hover:opacity-90 disabled:opacity-50"
              >
                {decisionBusy ? 'Recording…' : 'Record decision'}
              </button>
            </div>
          </>
        )}
      </>
    );
  }

  function threadLabel(thread: TeamThread): string {
    if (thread.type === 'DM') return memberName(thread.memberSlug);
    if (thread.type === 'GROUP') return 'Team channel';
    if (thread.type === 'CEO') return 'Cleo (CEO channel)';
    return thread.topic ?? thread.title ?? 'Discussion';
  }

  function authorLabel(message: TeamMessage): string {
    if (message.authorType === 'OWNER') return 'You';
    if (message.authorType === 'CEO') return 'Cleo';
    if (message.authorType === 'SYSTEM') return 'System';
    return memberName(message.authorSlug);
  }

  if (loadError) {
    return (
      <div className="flex animate-fade-up flex-col gap-6">
        <div>
          <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">AI Team</h2>
          <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
            These are AI team members who talk and draft; execution stays with Cleo.
          </p>
        </div>
        <EmptyState title="Couldn't load the AI team" description={loadError} />
      </div>
    );
  }

  if (!members || !threads) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  const discussThreads = threads
    .filter((t) => t.type === 'DISCUSS')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const tabs: Array<{ key: View; label: string }> = [
    { key: 'chat', label: 'Chat' },
    { key: 'work', label: `Work queue (${workItems.length})` },
    { key: 'drafts', label: `Drafts (${drafts.length})` },
    { key: 'activity', label: `Tool log (${toolLog.length})` },
    { key: 'failures', label: `Failure cases (${failureCases.length})` },
    { key: 'abilities', label: 'Abilities' },
  ];

  const railButtonClass = (active: boolean) =>
    `flex shrink-0 items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors lg:w-full lg:shrink ${
      active ? 'bg-signal-soft/70 text-ink' : 'text-ink hover:bg-paper'
    }`;

  return (
    <div className="flex animate-fade-up flex-col gap-5">
      <div
        className={`flex flex-wrap items-end justify-between gap-3 ${mobileThreadMode ? 'hidden lg:flex' : ''}`}
      >
        <div>
          <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">AI Team</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Your team room. They talk and draft here; execution stays with Cleo, and nothing they
            draft ships on its own.
          </p>
        </div>
      </div>

      {/* View tabs: the chat is the room; everything else lives behind these.
          One scrollable row on phones, wrapping only on wide screens. */}
      <div
        className={`${mobileThreadMode ? 'hidden lg:flex' : 'flex'} gap-2 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible [&>*]:shrink-0`}
      >
        {tabs.map((tab) => (
          <Button
            key={tab.key}
            size="sm"
            variant={view === tab.key ? 'primary' : 'secondary'}
            onClick={() => setView(tab.key)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {view === 'chat' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* Rail: channels, then people. On phones it becomes a top strip. */}
          <div
            className={`${mobileThreadMode ? 'hidden lg:flex' : 'flex'} gap-2 overflow-x-auto pb-1 lg:sticky lg:top-4 lg:max-h-[calc(100vh-8rem)] lg:flex-col lg:gap-1 lg:self-start lg:overflow-y-auto lg:rounded-[18px] lg:border lg:border-line lg:bg-card lg:p-3 lg:pb-3 lg:shadow-card`}
          >
            <p className="hidden px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted lg:block">
              Channels
            </p>
            <button
              type="button"
              onClick={() => void openThreadByType('GROUP')}
              className={railButtonClass(paneMode === 'thread' && selectedThread?.type === 'GROUP')}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-signal-soft text-sm font-semibold text-signal-deep">
                #
              </span>
              <span className="hidden min-w-0 sm:block">
                <span className="block truncate text-sm font-medium">Team channel</span>
                <span className="block truncate text-xs text-ink-muted">
                  {selectedThread?.type === 'GROUP' && typingSlugs.size > 0
                    ? `${memberName(pending.memberSlugs[0])} is typing…`
                    : 'Everyone in one channel'}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => void openThreadByType('CEO')}
              className={railButtonClass(paneMode === 'thread' && selectedThread?.type === 'CEO')}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-semibold text-paper">
                C
              </span>
              <span className="hidden min-w-0 sm:block">
                <span className="block truncate text-sm font-medium">Cleo, CEO</span>
                <span className="block truncate text-xs text-ink-muted">Talk to Cleo</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setView('chat');
                setPaneMode('new-discuss');
              }}
              className={railButtonClass(paneMode === 'new-discuss')}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper text-sm font-semibold text-ink ring-1 ring-line">
                +
              </span>
              <span className="hidden min-w-0 sm:block">
                <span className="block truncate text-sm font-medium">Discuss</span>
                <span className="block truncate text-xs text-ink-muted">Start a team discussion</span>
              </span>
            </button>

            <p className="hidden px-2 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted lg:block">
              People
            </p>
            {members.map((member) => {
              const dmThread = threads.find(
                (t) => t.type === 'DM' && t.memberSlug === member.slug,
              );
              const active = paneMode === 'thread' && dmThread?.id === selectedThreadId;
              const typing = typingSlugs.has(member.slug);
              return (
                <button
                  key={member.slug}
                  type="button"
                  onClick={() => void openThreadByType('DM', member.slug)}
                  className={railButtonClass(active)}
                >
                  <span className="relative shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={member.avatarPath}
                      alt={member.name}
                      className="h-9 w-9 rounded-full object-cover ring-1 ring-line"
                    />
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-card ${
                        typing ? 'animate-pulse bg-amber-400' : 'bg-emerald-400'
                      }`}
                    />
                  </span>
                  <span className="hidden min-w-0 sm:block">
                    <span className="block truncate text-sm font-medium">{member.name}</span>
                    <span className="block truncate text-xs text-ink-muted">
                      {openingSlug === member.slug
                        ? 'Opening…'
                        : typing
                          ? 'typing…'
                          : member.statusLine || member.role}
                    </span>
                  </span>
                </button>
              );
            })}

            {discussThreads.length > 0 && (
              <>
                <p className="hidden px-2 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted lg:block">
                  Discussions
                </p>
                {discussThreads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => openThread(thread)}
                    className={railButtonClass(
                      paneMode === 'thread' && thread.id === selectedThreadId,
                    )}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper text-sm font-semibold text-ink ring-1 ring-line">
                      §
                    </span>
                    <span className="hidden min-w-0 sm:block">
                      <span className="block max-w-[180px] truncate text-sm font-medium">
                        {thread.topic ?? thread.title ?? 'Discussion'}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">
                        {formatDateTime(thread.updatedAt)}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>

          {/* Main pane: one conversation at a time. */}
          <Card
            padded={false}
            className={`flex flex-col overflow-hidden ${
              mobileThreadMode
                ? 'h-[calc(100dvh-11rem)] lg:h-auto lg:min-h-[560px]'
                : 'h-[calc(100dvh-17rem)] min-h-[380px] lg:h-auto lg:min-h-[560px]'
            } ${paneMode === 'thread' && selectedThread && mobileNavOpen ? 'hidden lg:flex' : ''}`}
          >
            {paneMode === 'new-discuss' ? (
              <div className="flex flex-1 flex-col p-6">
                <h3 className="font-display text-[17px] font-semibold tracking-tight text-ink">
                  Start a discussion
                </h3>
                <p className="mt-1 text-sm text-ink-muted">
                  Give the team a topic. Seated members weigh in together, replies land as they
                  are ready, an auto summary closes it out, and Cleo records the decision in the
                  thread.
                </p>
                <div className="mt-5">
                  <Textarea
                    label="Topic"
                    rows={3}
                    placeholder="What should the team discuss?"
                    value={discussTopic}
                    onChange={(e) => setDiscussTopic(e.target.value)}
                  />
                </div>
                {members.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-4">
                    {members.map((member) => (
                      <label
                        key={member.slug}
                        className="flex cursor-pointer items-center gap-2 text-sm text-ink"
                      >
                        <input
                          type="checkbox"
                          checked={discussSeats.has(member.slug)}
                          onChange={(e) => {
                            setDiscussSeats((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(member.slug);
                              else next.delete(member.slug);
                              return next;
                            });
                          }}
                          className="h-4 w-4 accent-clinic"
                        />
                        {member.name}
                        <span className="text-xs text-ink-muted">{member.role}</span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="mt-5 flex gap-2">
                  <Button loading={discussBusy} onClick={() => void handleDiscuss()}>
                    Start discussion
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setPaneMode('thread');
                      setMobileNavOpen(false);
                    }}
                  >
                    Back to chat
                  </Button>
                </div>
              </div>
            ) : !selectedThread ? (
              <div className="flex flex-1 items-center justify-center p-6">
                <EmptyState
                  title="Opening the team channel…"
                  description="Pick a channel or a person on the left at any time."
                />
              </div>
            ) : (
              <>
                {/* Mobile top bar, Messenger style: back, who is here, the
                    topic as a one-line title, and (for discussions) the
                    details action. Desktop keeps the full header below. */}
                <div className="flex items-center gap-2.5 border-b border-line/60 px-3 py-2.5 lg:hidden">
                  <button
                    type="button"
                    onClick={() => setMobileNavOpen(true)}
                    aria-label="Back to conversations"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-paper hover:text-ink"
                  >
                    <svg
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      className="h-5 w-5"
                      aria-hidden
                    >
                      <path d="M12.5 4 6.5 10l6 6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {selectedThread.type === 'GROUP' && (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-signal-soft text-sm font-semibold text-signal-deep">
                      #
                    </span>
                  )}
                  {selectedThread.type === 'CEO' && (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-semibold text-paper">
                      C
                    </span>
                  )}
                  {selectedThread.type === 'DM' &&
                    memberBySlug.get(selectedThread.memberSlug ?? '') && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={memberBySlug.get(selectedThread.memberSlug ?? '')!.avatarPath}
                        alt=""
                        className="h-9 w-9 shrink-0 rounded-full object-cover ring-1 ring-line"
                      />
                    )}
                  {selectedThread.type === 'DISCUSS' &&
                    (seatedMembers.length > 0 ? (
                      <span className="flex shrink-0 -space-x-2">
                        {seatedMembers.slice(0, 4).map((m) => (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            key={m.slug}
                            src={m.avatarPath}
                            alt=""
                            className="h-8 w-8 rounded-full object-cover ring-2 ring-card"
                          />
                        ))}
                      </span>
                    ) : (
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper text-sm font-semibold text-ink ring-1 ring-line">
                        §
                      </span>
                    ))}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold leading-tight text-ink">
                      {selectedThread.type === 'DISCUSS'
                        ? (selectedThread.topic ?? 'Discussion')
                        : threadLabel(selectedThread)}
                    </p>
                    <p className="truncate text-xs text-ink-muted">
                      {selectedThread.type === 'DISCUSS'
                        ? 'Team discussion'
                        : selectedThread.type === 'GROUP'
                          ? typingSlugs.size > 0
                            ? `${memberName(pending.memberSlugs[0])} is typing…`
                            : 'Everyone in one channel'
                          : selectedThread.type === 'CEO'
                            ? 'Replies are not instant'
                            : (memberBySlug.get(selectedThread.memberSlug ?? '')?.statusLine ??
                              memberBySlug.get(selectedThread.memberSlug ?? '')?.role ??
                              'Direct message')}
                    </p>
                  </div>
                  {selectedThread.type === 'DISCUSS' && (
                    <button
                      type="button"
                      onClick={() => setDetailsOpen(true)}
                      aria-label="Discussion details and decision"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-paper hover:text-ink"
                    >
                      <svg
                        viewBox="0 0 20 20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        className="h-5 w-5"
                        aria-hidden
                      >
                        <circle cx="10" cy="10" r="7.5" />
                        <path d="M10 9.4V14" strokeLinecap="round" />
                        <circle cx="10" cy="6.1" r="0.5" fill="currentColor" stroke="none" />
                      </svg>
                    </button>
                  )}
                </div>

                <div className="hidden border-b border-line/60 px-6 py-4 lg:block">
                  <div className="flex flex-wrap items-center gap-3">
                    {selectedThread.type === 'DM' &&
                      memberBySlug.get(selectedThread.memberSlug ?? '') && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={memberBySlug.get(selectedThread.memberSlug ?? '')!.avatarPath}
                          alt=""
                          className="h-10 w-10 rounded-full object-cover ring-1 ring-line"
                        />
                      )}
                    <div className="min-w-0">
                      <h3 className="font-display text-[17px] font-semibold tracking-tight text-ink">
                        {threadLabel(selectedThread)}
                      </h3>
                      {selectedThread.type === 'CEO' && (
                        <p className="text-sm text-ink-muted">Cleo, real, replies are not instant</p>
                      )}
                      {selectedThread.type === 'GROUP' && (
                        <p className="text-sm text-ink-muted">
                          Everyone in one channel · @name a member to get their answer.
                        </p>
                      )}
                      {selectedThread.type === 'DM' && (
                        <p className="text-sm text-ink-muted">
                          {memberBySlug.get(selectedThread.memberSlug ?? '')?.role ??
                            'Direct message'}
                        </p>
                      )}
                      {selectedThread.type === 'DISCUSS' && (
                        <p className="text-sm text-ink-muted">Team discussion</p>
                      )}
                    </div>
                  </div>

                  {selectedThread.type === 'DISCUSS' && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                        Seated
                      </span>
                      {seatedMembers.map((m) => (
                        <span
                          key={m.slug}
                          className="flex items-center gap-1.5 rounded-full bg-paper py-1 pl-1 pr-2.5 ring-1 ring-line"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={m.avatarPath}
                            alt=""
                            className="h-5 w-5 rounded-full object-cover"
                          />
                          <span className="text-xs font-medium text-ink">
                            {m.name.split(' ')[0]}
                          </span>
                          {typingSlugs.has(m.slug) && (
                            <span className="text-xs text-ink-muted">typing…</span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {selectedThread.type === 'DISCUSS' && selectedThread.topic && (
                  <div className="hidden border-b border-line/60 bg-paper/60 px-6 py-3.5 lg:block">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                      Topic
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-ink">
                      {selectedThread.topic}
                    </p>
                  </div>
                )}

                {selectedThread.type === 'DISCUSS' && (
                  <div className="hidden border-b border-line/60 bg-paper/60 px-6 py-4 lg:block">
                    {renderDecisionContent()}
                  </div>
                )}

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-5">
                  {messages === null ? (
                    <div className="flex h-40 items-center justify-center">
                      <Spinner className="h-5 w-5 text-signal" />
                    </div>
                  ) : messagesError ? (
                    <EmptyState title="Couldn't load messages" description={messagesError} />
                  ) : messages.length === 0 && pending.memberSlugs.length === 0 ? (
                    <p className="py-8 text-center text-sm text-ink-muted">
                      No messages yet. Say hello below.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-5">
                      {messages.map((message) => {
                        const isOwner = message.authorType === 'OWNER';
                        const isSystem = message.authorType === 'SYSTEM';
                        const member = message.authorSlug
                          ? memberBySlug.get(message.authorSlug)
                          : undefined;
                        return (
                          <li
                            key={message.id}
                            className={`flex flex-col ${isOwner ? 'items-end' : 'items-start'}`}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              {!isOwner && member && (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img
                                  src={member.avatarPath}
                                  alt=""
                                  className="h-6 w-6 rounded-full object-cover ring-1 ring-line"
                                />
                              )}
                              <span
                                className={`text-xs font-semibold ${isSystem ? 'text-ink-muted' : 'text-ink'}`}
                              >
                                {authorLabel(message)}
                              </span>
                              {message.label === 'AUTO_SUMMARY' && (
                                <Badge tone="signal">Auto summary</Badge>
                              )}
                              <span className="text-xs text-ink-muted">
                                {formatDateTime(message.createdAt)}
                              </span>
                            </div>
                            <div
                              className={`mt-1 max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                                isOwner
                                  ? 'bg-signal-soft/70 text-ink'
                                  : isSystem
                                    ? 'bg-paper text-ink-muted'
                                    : 'bg-paper text-ink'
                              }`}
                            >
                              {message.body}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {pending.active && pending.memberSlugs.length === 0 && (
                    <div className="mt-4 flex items-center gap-2.5 text-sm text-ink-muted">
                      {seatedMembers.length > 0 && (
                        <span className="flex shrink-0 -space-x-1.5">
                          {seatedMembers.slice(0, 4).map((m) => (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              key={m.slug}
                              src={m.avatarPath}
                              alt=""
                              className="h-6 w-6 rounded-full object-cover ring-2 ring-card"
                            />
                          ))}
                        </span>
                      )}
                      <Spinner className="h-4 w-4 shrink-0 text-signal" />
                      <span>The team is gathering…</span>
                    </div>
                  )}
                  {pending.memberSlugs.map((slug) => {
                    const member = memberBySlug.get(slug);
                    return (
                      <p key={slug} className="mt-4 flex items-center gap-2 text-sm text-ink-muted">
                        {member && (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={member.avatarPath}
                            alt=""
                            className="h-6 w-6 rounded-full object-cover ring-1 ring-line"
                          />
                        )}
                        {memberName(slug)} is typing
                        <span className="flex items-center gap-1" aria-hidden="true">
                          {[0, 1, 2].map((i) => (
                            <span
                              key={i}
                              className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-muted"
                              style={{ animationDelay: `${i * 0.18}s` }}
                            />
                          ))}
                        </span>
                      </p>
                    );
                  })}
                  {sending && pending.memberSlugs.length === 0 && (
                    <p className="mt-4 flex items-center gap-2 text-sm text-ink-muted">
                      <Spinner className="h-4 w-4 text-signal" /> Sending…
                    </p>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Mobile details sheet: the topic, the seated members, and
                    the decision live behind the top-bar info action, so the
                    chat flow stays clean. Desktop keeps them in flow. */}
                {detailsOpen && selectedThread.type === 'DISCUSS' && (
                  <div
                    className="fixed inset-0 z-50 lg:hidden"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Discussion details"
                  >
                    <button
                      type="button"
                      aria-label="Close details"
                      onClick={() => setDetailsOpen(false)}
                      className="absolute inset-0 h-full w-full bg-black/50"
                    />
                    <div className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-card p-5 pb-8 shadow-card">
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="font-display text-[16px] font-semibold tracking-tight text-ink">
                          Discussion details
                        </h4>
                        <button
                          type="button"
                          onClick={() => setDetailsOpen(false)}
                          aria-label="Close details"
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-paper hover:text-ink"
                        >
                          <svg
                            viewBox="0 0 20 20"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            className="h-5 w-5"
                            aria-hidden
                          >
                            <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
                          </svg>
                        </button>
                      </div>
                      {selectedThread.topic && (
                        <div className="mt-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                            Topic
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink">
                            {selectedThread.topic}
                          </p>
                        </div>
                      )}
                      <div className="mt-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                          Seated
                        </p>
                        {seatedMembers.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {seatedMembers.map((m) => (
                              <span
                                key={m.slug}
                                className="flex items-center gap-1.5 rounded-full bg-paper py-1 pl-1 pr-2.5 ring-1 ring-line"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={m.avatarPath}
                                  alt=""
                                  className="h-5 w-5 rounded-full object-cover"
                                />
                                <span className="text-xs font-medium text-ink">
                                  {m.name.split(' ')[0]}
                                </span>
                                {typingSlugs.has(m.slug) && (
                                  <span className="text-xs text-ink-muted">typing…</span>
                                )}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-1 text-sm text-ink-muted">No one has spoken yet.</p>
                        )}
                      </div>
                      <div className="mt-5 border-t border-line/60 pt-4">
                        {renderDecisionContent()}
                      </div>
                    </div>
                  </div>
                )}

                <div className="border-t border-line/60 px-4 py-3 lg:px-6 lg:py-4">
                  {sendError && (
                    <p
                      role="alert"
                      className="mb-3 rounded-xl border border-danger/30 bg-danger-soft/50 px-3.5 py-2.5 text-sm text-ink"
                    >
                      {sendError}
                    </p>
                  )}
                  <div className="flex items-end gap-3">
                    <div className="flex-1">
                      <Textarea
                        rows={2}
                        placeholder={
                          selectedThread.type === 'GROUP'
                            ? 'Message the team channel… @name a member to get their answer.'
                            : 'Write a message…'
                        }
                        value={composer}
                        onChange={(e) => setComposer(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void handleSend();
                          }
                        }}
                      />
                    </div>
                    <Button loading={sending} onClick={() => void handleSend()}>
                      Send
                    </Button>
                  </div>
                  <p className="mt-2 hidden text-xs text-ink-muted sm:block">
                    Enter to send, Shift+Enter for a new line.
                  </p>
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {view === 'work' && (
        <Card padded={false}>
          <div className="px-6 pt-5">
            <CardHeader
              title="Work queue"
              description="Work the team has queued. Drafting happens here; execution stays with Cleo."
            />
          </div>
          <div className="px-6 pb-2">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Input
                  label="New work item"
                  placeholder="What needs doing?"
                  value={newWorkTitle}
                  onChange={(e) => setNewWorkTitle(e.target.value)}
                />
              </div>
              <div className="sm:w-52">
                <Select
                  label="Owner"
                  value={newWorkOwner}
                  onChange={(e) => setNewWorkOwner(e.target.value)}
                >
                  {members.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button loading={workBusy} onClick={() => void handleAddWorkItem()}>
                Add to queue
              </Button>
            </div>
          </div>
          {workItems.length === 0 ? (
            <p className="px-6 pb-6 pt-2 text-sm text-ink-muted">Nothing queued yet.</p>
          ) : (
            <ul className="divide-y divide-line/60 px-6 pb-4">
              {workItems.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-ink">{item.title}</p>
                      <Badge tone={WORK_STATUS_TONE[item.status]} dot>
                        {WORK_STATUS_LABEL[item.status]}
                      </Badge>
                    </div>
                    {item.detail && (
                      <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">
                        {item.detail}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-ink-muted">
                      Owner: {memberName(item.ownerSlug)} · {formatDateTime(item.createdAt)}
                    </p>
                  </div>
                  <div className="w-40 shrink-0">
                    <Select
                      value={item.status}
                      onChange={(e) => void handleWorkStatus(item, e.target.value as WorkItemStatus)}
                      aria-label={`Status for ${item.title}`}
                    >
                      <option value="QUEUED">Queued</option>
                      <option value="IN_PROGRESS">In progress</option>
                      <option value="DONE">Done</option>
                    </Select>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {view === 'abilities' && (
        <Card>
          <CardHeader
            title="Abilities"
            description="One-click runs. Results land as drafts or work items, ready for review."
          />
          {abilityResult && (
            <p className="mb-4 whitespace-pre-wrap rounded-xl border border-line bg-paper px-4 py-3 text-sm leading-relaxed text-ink">
              {abilityResult}
            </p>
          )}
          <div className="flex flex-wrap gap-2.5">
            <Button
              variant="secondary"
              loading={abilityBusy === 'call-scoring'}
              onClick={() =>
                void runAbility('call-scoring', async () => {
                  const r = await TeamApi.abilityCallScoring();
                  return `Call scoring: scored ${r.scored}, passed ${r.passed}, failed ${r.failed}, drafts created ${r.draftsCreated}.`;
                })
              }
            >
              Score recent calls
            </Button>
            <Button
              variant="secondary"
              loading={abilityBusy === 'leak-radar'}
              onClick={() =>
                void runAbility('leak-radar', async () => {
                  const r = await TeamApi.abilityLeakRadar();
                  const lines = r.leaks.map((l) => `${l.title}: ${l.detail}`).join('\n');
                  return `Leak radar: ${r.leaks.length} leak(s) found, ${r.workItemsCreated} work item(s) created.${lines ? `\n${lines}` : ''}`;
                })
              }
            >
              Run leak radar
            </Button>
            <Button
              variant="secondary"
              loading={abilityBusy === 'uptime'}
              onClick={() =>
                void runAbility('uptime', async () => {
                  const r = await TeamApi.abilityUptime();
                  const lines = r.checks
                    .map((c) => `${c.name}: ${c.ok ? 'OK' : 'FAILED'} (${c.status ?? 'no status'}) ${c.evidence}`)
                    .join('\n');
                  return `Uptime check complete.${r.workItemCreated ? ' A work item was created for a failure.' : ''}${lines ? `\n${lines}` : ''}`;
                })
              }
            >
              Check uptime
            </Button>
            <Button
              variant="secondary"
              loading={abilityBusy === 'board-pack'}
              onClick={() =>
                void runAbility('board-pack', async () => {
                  const r = await TeamApi.abilityBoardPack();
                  return `Board pack drafted: “${r.draft.title}” by ${memberName(r.draft.memberSlug)}. See the Drafts view.`;
                })
              }
            >
              Board pack
            </Button>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div className="flex flex-col gap-3">
              <Textarea
                label="Red-team a plan"
                rows={4}
                placeholder="Paste a plan. Priya (QA) will red-team it and file the result as a draft."
                value={redTeamPlan}
                onChange={(e) => setRedTeamPlan(e.target.value)}
              />
              <div>
                <Button
                  variant="secondary"
                  loading={abilityBusy === 'red-team'}
                  onClick={() => {
                    const plan = redTeamPlan.trim();
                    if (!plan) {
                      toast('Paste a plan first.', 'error');
                      return;
                    }
                    void runAbility('red-team', async () => {
                      const r = await TeamApi.abilityRedTeam(plan);
                      setRedTeamPlan('');
                      return `Red-team filed as a Priya QA draft: “${r.draft.title}”. See the Drafts view.`;
                    });
                  }}
                >
                  Red-team this plan
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <Input
                label="Clinic dossier: website URL"
                placeholder="https://example-dental.com"
                value={dossierWebsite}
                onChange={(e) => setDossierWebsite(e.target.value)}
              />
              <Input
                label="Clinic dossier: business name"
                placeholder="Example Dental"
                value={dossierBusiness}
                onChange={(e) => setDossierBusiness(e.target.value)}
              />
              <div>
                <Button
                  variant="secondary"
                  loading={abilityBusy === 'dossier'}
                  onClick={() => {
                    const websiteUrl = dossierWebsite.trim();
                    const businessName = dossierBusiness.trim();
                    if (!websiteUrl && !businessName) {
                      toast('Add a website URL or a business name first.', 'error');
                      return;
                    }
                    void runAbility('dossier', async () => {
                      const r = await TeamApi.abilityDossier({
                        ...(websiteUrl ? { websiteUrl } : {}),
                        ...(businessName ? { businessName } : {}),
                      });
                      return `Clinic dossier drafted: “${r.draft.title}” by ${memberName(r.draft.memberSlug)}. See the Drafts view.`;
                    });
                  }}
                >
                  Build clinic dossier
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {view === 'drafts' && (
        <Card>
          <CardHeader title="Drafts" description="Everything the team has drafted, waiting for review." />
          {drafts.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No drafts yet. Abilities and discussions create drafts here.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {drafts.map((draft) => {
                const expanded = expandedDraftId === draft.id;
                return (
                  <li key={draft.id} className="rounded-2xl border border-line/70 bg-paper/50 px-4 py-3.5">
                    <button
                      type="button"
                      onClick={() => setExpandedDraftId(expanded ? null : draft.id)}
                      className="flex w-full flex-wrap items-center gap-2 text-left"
                    >
                      <Badge tone="signal">{draft.kind}</Badge>
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                        {draft.title}
                      </span>
                      <span className="text-xs text-ink-muted">
                        {memberName(draft.memberSlug)} · {formatDateTime(draft.createdAt)} ·{' '}
                        {expanded ? 'Hide' : 'Read'}
                      </span>
                    </button>
                    {expanded && (
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
                        {draft.body}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {view === 'activity' && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Tool log" description="Every tool run the team has made, newest first." />
            {toolLog.length === 0 ? (
              <p className="text-sm text-ink-muted">No tool runs logged yet.</p>
            ) : (
              <ul className="divide-y divide-line/60">
                {toolLog.map((entry) => (
                  <li key={entry.id} className="py-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-ink">{memberName(entry.memberSlug)}</span>
                      <span className="font-mono text-xs text-ink">{entry.tool}</span>
                      <Badge tone={entry.ok ? 'success' : 'danger'} dot>
                        {entry.ok ? 'OK' : 'Failed'}
                      </Badge>
                      <span className="text-xs text-ink-muted">{formatDateTime(entry.createdAt)}</span>
                    </div>
                    {entry.inputSummary && (
                      <p className="mt-1 text-xs leading-relaxed text-ink-muted">In: {entry.inputSummary}</p>
                    )}
                    {entry.resultSummary && (
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                        Result: {entry.resultSummary}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Tools" description="What each member may use. Tiers are enforced in code, not prompts." />
            {tools.length === 0 ? (
              <p className="text-sm text-ink-muted">No tools reported by the API yet.</p>
            ) : (
              <ul className="divide-y divide-line/60">
                {tools.map((tool) => (
                  <li key={tool.name} className="py-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-ink">{tool.name}</span>
                      <Badge tone="neutral">{tool.tier}</Badge>
                      <Badge tone={tool.available ? 'success' : 'warning'} dot>
                        {tool.available ? 'Available' : 'Unavailable'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-ink-muted">{tool.description}</p>
                    {!tool.available && tool.reason && (
                      <p className="mt-0.5 text-xs text-ink-muted">{tool.reason}</p>
                    )}
                    {Object.entries(memberTools).filter(([, list]) => list.includes(tool.name))
                      .length > 0 && (
                      <p className="mt-1 text-xs text-ink-muted">
                        Used by:{' '}
                        {Object.entries(memberTools)
                          .filter(([, list]) => list.includes(tool.name))
                          .map(([slug]) => memberName(slug))
                          .join(', ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {view === 'failures' && (
        <Card>
          <CardHeader
            title="Failure cases"
            description="The failure museum: confirmed failures, kept so the team learns from them."
          />
          {failureCases.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No failure cases yet. Real failures get kept here so the team learns from them.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {failureCases.map((failure) => (
                <li key={failure.id} className="rounded-2xl border border-line/70 bg-paper/50 px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-ink">{failure.title}</p>
                    <span className="text-xs text-ink-muted">{formatDateTime(failure.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
                    {failure.description}
                  </p>
                  {failure.callLogId && (
                    <p className="mt-1 font-mono text-xs text-ink-muted">Call: {failure.callLogId}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
