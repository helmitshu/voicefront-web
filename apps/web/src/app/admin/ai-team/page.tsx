'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  TeamApi,
  type FailureCase,
  type TeamDraft,
  type TeamMember,
  type TeamMessage,
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

type ActivityTab = 'log' | 'drafts' | 'failures' | 'tools';

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

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TeamMessage[] | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [openingSlug, setOpeningSlug] = useState<string | null>(null);

  const [discussTopic, setDiscussTopic] = useState('');
  const [discussSeats, setDiscussSeats] = useState<Set<string>>(new Set());
  const [discussBusy, setDiscussBusy] = useState(false);

  const [decisionDraft, setDecisionDraft] = useState('');
  const [decisionBusy, setDecisionBusy] = useState(false);

  const [newWorkTitle, setNewWorkTitle] = useState('');
  const [newWorkOwner, setNewWorkOwner] = useState('');
  const [workBusy, setWorkBusy] = useState(false);

  const [activityTab, setActivityTab] = useState<ActivityTab>('drafts');
  const [expandedDraftId, setExpandedDraftId] = useState<string | null>(null);

  const [abilityBusy, setAbilityBusy] = useState<string | null>(null);
  const [abilityResult, setAbilityResult] = useState<string | null>(null);
  const [redTeamPlan, setRedTeamPlan] = useState('');
  const [dossierWebsite, setDossierWebsite] = useState('');
  const [dossierBusiness, setDossierBusiness] = useState('');

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

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
      /* tools tab stays empty */
    }
  }, [loadDrafts, loadToolLog, loadWorkItems]);

  const loadMessages = useCallback(async (threadId: string) => {
    setMessages(null);
    setMessagesError(null);
    try {
      const { messages: rows } = await TeamApi.messages(threadId);
      setMessages(rows);
    } catch (err) {
      setMessages([]);
      setMessagesError(errMessage(err, 'Could not load messages for this thread.'));
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoadError(null);
    try {
      const [{ members: memberRows }, threadRows] = await Promise.all([
        TeamApi.members(),
        loadThreads(),
      ]);
      setMembers(memberRows);
      setDiscussSeats(new Set(memberRows.map((m) => m.slug)));
      if (memberRows.length > 0) setNewWorkOwner((prev) => prev || memberRows[0].slug);
      void threadRows;
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
  }, [messages, sending]);

  const openThread = useCallback(
    (thread: TeamThread) => {
      setSelectedThreadId(thread.id);
      setSendError(null);
      void loadMessages(thread.id);
    },
    [loadMessages],
  );

  async function openThreadByType(type: TeamThread['type'], memberSlug?: string) {
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
  }

  async function handleSend() {
    const body = composer.trim();
    if (!body || !selectedThreadId || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const result = await TeamApi.sendMessage(selectedThreadId, body);
      setComposer('');
      setMessages((prev) => {
        const rows = prev ?? [];
        const next = [...rows, result.message];
        if (result.reply && !next.some((m) => m.id === result.reply!.id)) next.push(result.reply);
        return next;
      });
      void loadThreads().catch(() => undefined);
      void loadActivity();
    } catch (err) {
      const message = errMessage(err, 'That message could not be sent. No reply was generated.');
      setSendError(message);
      toast(message, 'error');
      // Reload from the server so we only ever show real, stored messages.
      void loadMessages(selectedThreadId);
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
      void loadMessages(selectedThreadId);
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
      toast('Discussion started.', 'success');
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

  function threadLabel(thread: TeamThread): string {
    if (thread.type === 'DM') return memberName(thread.memberSlug);
    if (thread.type === 'GROUP') return 'Group channel';
    if (thread.type === 'CEO') return 'Cleo (CEO channel)';
    return thread.topic ?? thread.title ?? 'Discussion';
  }

  function threadSubLabel(thread: TeamThread): string {
    if (thread.type === 'DM') return 'Direct message';
    if (thread.type === 'GROUP') return 'Everyone in one channel';
    if (thread.type === 'CEO') return 'Talk to Cleo';
    return thread.title ?? 'Discussion';
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

  const sortedThreads = [...threads].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">AI Team</h2>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
          These are AI team members who talk and draft; execution stays with Cleo. Talk to them,
          start a discussion, and queue work here. Nothing they draft ships on its own.
        </p>
      </div>

      {/* Member cards */}
      {members.length === 0 ? (
        <EmptyState
          title="No AI team members yet"
          description="When the team is configured, each member will show up here with a photo, role, and status line."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {members.map((member) => (
            <button
              key={member.slug}
              type="button"
              onClick={() => void openThreadByType('DM', member.slug)}
              className="group rounded-[18px] border border-line bg-card p-5 text-left shadow-card transition-shadow duration-200 hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              <div className="flex items-start gap-3.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={member.avatarPath}
                  alt={member.name}
                  className="h-14 w-14 shrink-0 rounded-2xl object-cover ring-1 ring-line"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{member.name}</p>
                  <p className="mt-0.5 text-xs font-medium text-signal-deep">{member.role}</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{member.statusLine}</p>
                </div>
              </div>
              <p className="mt-3 text-xs font-medium text-ink-muted group-hover:text-ink">
                {openingSlug === member.slug ? 'Opening…' : 'Open direct message →'}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* Chat: thread list + open thread */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <Card padded={false} className="overflow-hidden">
          <div className="px-5 pt-5">
            <CardHeader title="Channels" description="Pick a thread, or start one from a member card above." />
          </div>
          <div className="flex flex-col gap-1 px-3 pb-4">
            <button
              type="button"
              onClick={() => void openThreadByType('GROUP')}
              className="rounded-xl px-3 py-2.5 text-left text-sm font-medium text-ink transition-colors hover:bg-paper"
            >
              Group channel
              <span className="block text-xs font-normal text-ink-muted">Everyone in one channel</span>
            </button>
            <button
              type="button"
              onClick={() => void openThreadByType('CEO')}
              className="rounded-xl px-3 py-2.5 text-left text-sm font-medium text-ink transition-colors hover:bg-paper"
            >
              Cleo (CEO channel)
              <span className="block text-xs font-normal text-ink-muted">Talk to Cleo</span>
            </button>
            {sortedThreads.length === 0 ? (
              <p className="px-3 py-3 text-xs leading-relaxed text-ink-muted">
                No threads yet. Open a member above, the group channel, or the CEO channel to start.
              </p>
            ) : (
              sortedThreads.map((thread) => {
                const active = thread.id === selectedThreadId;
                return (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => openThread(thread)}
                    className={`rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
                      active ? 'bg-signal-soft/70 text-ink' : 'text-ink hover:bg-paper'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{threadLabel(thread)}</span>
                      <Badge tone={thread.type === 'DISCUSS' ? 'warning' : 'neutral'}>
                        {thread.type}
                      </Badge>
                    </span>
                    <span className="mt-0.5 block truncate text-xs font-normal text-ink-muted">
                      {thread.type === 'DISCUSS' && thread.topic ? thread.topic : threadSubLabel(thread)}
                      {' · '}
                      {formatDateTime(thread.updatedAt)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        <Card padded={false} className="flex min-h-[480px] flex-col overflow-hidden">
          {!selectedThread ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                title="No thread open"
                description="Choose a channel on the left, or click a team member above to open their direct messages."
              />
            </div>
          ) : (
            <>
              <div className="border-b border-line/60 px-6 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-display text-[17px] font-semibold tracking-tight text-ink">
                    {threadLabel(selectedThread)}
                  </h3>
                  <Badge tone="neutral">{selectedThread.type}</Badge>
                </div>
                {selectedThread.type === 'CEO' && (
                  <p className="mt-1 text-sm text-ink-muted">Cleo, real, replies are not instant</p>
                )}
                {selectedThread.type === 'GROUP' && (
                  <p className="mt-1 text-sm text-ink-muted">@name a member to get their answer.</p>
                )}
                {selectedThread.type === 'DM' && (
                  <p className="mt-1 text-sm text-ink-muted">
                    Direct message with {memberName(selectedThread.memberSlug)}
                    {memberBySlug.get(selectedThread.memberSlug ?? '')?.role
                      ? ` · ${memberBySlug.get(selectedThread.memberSlug ?? '')!.role}`
                      : ''}
                  </p>
                )}
                {selectedThread.type === 'DISCUSS' && selectedThread.topic && (
                  <p className="mt-1 text-sm text-ink-muted">Topic: {selectedThread.topic}</p>
                )}
              </div>

              {selectedThread.type === 'DISCUSS' && (
                <div className="border-b border-line/60 bg-paper/60 px-6 py-4">
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
                </div>
              )}

              <div className="flex-1 overflow-y-auto px-6 py-4">
                {messages === null ? (
                  <div className="flex h-40 items-center justify-center">
                    <Spinner className="h-5 w-5 text-signal" />
                  </div>
                ) : messagesError ? (
                  <EmptyState title="Couldn't load messages" description={messagesError} />
                ) : messages.length === 0 ? (
                  <p className="py-8 text-center text-sm text-ink-muted">
                    No messages yet. Say hello below.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-4">
                    {messages.map((message) => {
                      const isOwner = message.authorType === 'OWNER';
                      const isSystem = message.authorType === 'SYSTEM';
                      return (
                        <li key={message.id} className={`flex flex-col ${isOwner ? 'items-end' : 'items-start'}`}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`text-xs font-semibold ${isSystem ? 'text-ink-muted' : 'text-ink'}`}
                            >
                              {authorLabel(message)}
                            </span>
                            {message.label === 'AUTO_SUMMARY' && <Badge tone="signal">Auto summary</Badge>}
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
                {sending && (
                  <p className="mt-4 flex items-center gap-2 text-sm text-ink-muted">
                    <Spinner className="h-4 w-4 text-signal" /> Waiting for a reply…
                  </p>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="border-t border-line/60 px-6 py-4">
                {sendError && (
                  <p role="alert" className="mb-3 rounded-xl border border-danger/30 bg-danger-soft/50 px-3.5 py-2.5 text-sm text-ink">
                    {sendError}
                  </p>
                )}
                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <Textarea
                      rows={2}
                      placeholder={
                        selectedThread.type === 'GROUP'
                          ? 'Message the group… @name a member to get their answer.'
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
                <p className="mt-2 text-xs text-ink-muted">Enter to send, Shift+Enter for a new line.</p>
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Discuss starter */}
      <Card>
        <CardHeader
          title="Start a discussion"
          description="Give the team a topic. Seated members weigh in, and Cleo records the decision in the thread."
        />
        <Textarea
          label="Topic"
          rows={3}
          placeholder="What should the team discuss?"
          value={discussTopic}
          onChange={(e) => setDiscussTopic(e.target.value)}
        />
        {members.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-4">
            {members.map((member) => (
              <label key={member.slug} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
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
        <div className="mt-4">
          <Button loading={discussBusy} onClick={() => void handleDiscuss()}>
            Start discussion
          </Button>
        </div>
      </Card>

      {/* Work queue */}
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

      {/* Abilities */}
      <Card>
        <CardHeader
          title="Abilities"
          description="One-click runs. Results land as drafts or work items below, ready for review."
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
                return `Board pack drafted: “${r.draft.title}” by ${memberName(r.draft.memberSlug)}. See Drafts below.`;
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
                    return `Red-team filed as a Priya QA draft: “${r.draft.title}”. See Drafts below.`;
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
                    return `Clinic dossier drafted: “${r.draft.title}” by ${memberName(r.draft.memberSlug)}. See Drafts below.`;
                  });
                }}
              >
                Build clinic dossier
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* Team activity */}
      <Card padded={false}>
        <div className="px-6 pt-5">
          <CardHeader title="Team activity" description="Tool runs, drafts, and the failure museum." />
          <div className="mb-4 flex flex-wrap gap-2">
            {(
              [
                { key: 'drafts', label: `Drafts (${drafts.length})` },
                { key: 'log', label: `Tool log (${toolLog.length})` },
                { key: 'tools', label: `Tools (${tools.length})` },
                { key: 'failures', label: `Failure museum (${failureCases.length})` },
              ] as Array<{ key: ActivityTab; label: string }>
            ).map((tab) => (
              <Button
                key={tab.key}
                size="sm"
                variant={activityTab === tab.key ? 'primary' : 'secondary'}
                onClick={() => setActivityTab(tab.key)}
              >
                {tab.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="px-6 pb-6">
          {activityTab === 'drafts' &&
            (drafts.length === 0 ? (
              <p className="text-sm text-ink-muted">No drafts yet. Abilities and discussions create drafts here.</p>
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
            ))}

          {activityTab === 'log' &&
            (toolLog.length === 0 ? (
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
            ))}

          {activityTab === 'tools' &&
            (tools.length === 0 ? (
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
                    {Object.entries(memberTools)
                      .filter(([, list]) => list.includes(tool.name))
                      .map(([slug]) => slug).length > 0 && (
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
            ))}

          {activityTab === 'failures' &&
            (failureCases.length === 0 ? (
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
            ))}
        </div>
      </Card>
    </div>
  );
}
