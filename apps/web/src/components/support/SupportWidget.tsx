'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { usePathname } from 'next/navigation';
import {
  ApiError,
  SupportApi,
  api,
  mediaUrl,
  type SupportDrillScenario,
  type SupportPendingProposal,
  type SupportSimulationResult,
} from '@/lib/api';
import { SUPPORT_PERSONA, personaInitials } from './persona';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
}

interface DirectReportResponse {
  filed: boolean;
  reference: string;
  summary: string;
  assistantMessage: string;
}

let nextId = 1;
function msg(role: ChatMessage['role'], text: string): ChatMessage {
  const m = { id: nextId, role, text };
  nextId += 1;
  return m;
}

/** The agent's photo, degrading to initials in a colored circle when the
 *  image is absent or fails to load, so the header never breaks. */
function PersonaAvatar({ sizeClass }: { sizeClass: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        aria-hidden
        className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-full bg-clinic font-bold text-white`}
      >
        {personaInitials(SUPPORT_PERSONA.name)}
      </span>
    );
  }
  return (
    // Plain img on purpose: the avatar is a local public file, and the
    // onError fallback is what makes a missing file harmless.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={SUPPORT_PERSONA.avatarPath}
      alt=""
      onError={() => setFailed(true)}
      className={`${sizeClass} shrink-0 rounded-full object-cover`}
    />
  );
}

/**
 * The floating support agent for the signed-in app: a bubble carrying the
 * agent's face and name that expands into a chat panel. The agent answers
 * questions about the page the user is on (the current route rides along
 * with every chat request) and can propose real tasks: a booking-window
 * change, or a ticket to the VoiceFront team. A proposal renders as an
 * inline card and only happens when the user taps the confirm button.
 *
 * Placement: desktop bottom-right. On phone screens the app home carries a
 * fixed bottom tab bar, so below `sm` everything rides higher (bottom-24
 * neighbourhood) and the panel height is capped against the space left.
 */
export function SupportWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    msg(
      'assistant',
      `${SUPPORT_PERSONA.greeting} Ask me about this page, tell me a change to make, like "only book weekday mornings", or report a problem and I will file a ticket for our team.`,
    ),
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<SupportPendingProposal | null>(null);
  const [applying, setApplying] = useState(false);
  const [simResult, setSimResult] = useState<SupportSimulationResult | null>(null);
  const [weeklyReview, setWeeklyReview] = useState<{ reviewId: string; gapCount: number } | null>(null);
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillScenarios, setDrillScenarios] = useState<SupportDrillScenario[] | null>(null);
  const [customScenario, setCustomScenario] = useState('');
  const [chatFailed, setChatFailed] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportSubject, setReportSubject] = useState('');
  const [reportDetails, setReportDetails] = useState('');
  const [reportError, setReportError] = useState('');
  const [reporting, setReporting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, open]);

  /** Sends one user message (typed, or from a card/picker button) and
   *  folds the turn's attachments back into the panel state. */
  async function sendText(text: string) {
    if (!text || sending) return;
    const userMsg = msg('user', text);
    const history = [...messages, userMsg].slice(-20);
    setMessages(history);
    setSending(true);
    setChatFailed(false);
    setReportOpen(false);
    setReportError('');
    try {
      const res = await SupportApi.chat(
        history.map(({ role, text: t }) => ({ role, text: t })),
        pathname ?? undefined,
      );
      setMessages((prev) => [...prev, msg('assistant', res.reply)]);
      if (res.pendingProposal) setPending(res.pendingProposal);
      if (res.simulationResult) setSimResult(res.simulationResult);
      setWeeklyReview(res.weeklyReview);
    } catch (err) {
      const note =
        err instanceof ApiError
          ? err.message
          : 'Something went wrong on my side. Please try that again.';
      setMessages((prev) => [...prev, msg('assistant', note)]);
      setChatFailed(true);
    } finally {
      setSending(false);
    }
  }

  async function onSend(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    await sendText(text);
  }

  /** Opens the drill picker, loading the library on first use. */
  async function toggleDrills() {
    const next = !drillOpen;
    setDrillOpen(next);
    if (next && drillScenarios === null) {
      try {
        const res = await SupportApi.drillScenarios();
        setDrillScenarios(res.scenarios);
      } catch {
        setDrillScenarios([]);
      }
    }
  }

  async function onDismissReview() {
    if (!weeklyReview) return;
    try {
      await SupportApi.dismissWeeklyReview(weeklyReview.reviewId);
      setWeeklyReview(null);
      setMessages((prev) => [
        ...prev,
        msg('assistant', 'Dismissed. That review will not come up again.'),
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        msg('assistant', 'I could not dismiss that review just now. Please try again.'),
      ]);
    }
  }

  async function onDirectReport(e: FormEvent) {
    e.preventDefault();
    const subject = reportSubject.trim();
    const details = reportDetails.trim();
    if (!subject || !details || reporting) {
      setReportError('Add a short subject and the details, then file the ticket.');
      return;
    }
    setReporting(true);
    setReportError('');
    try {
      // Direct ticket endpoint: no chat request and no model call, so this
      // stays available when the assistant itself is the problem.
      const res = await api<DirectReportResponse>('/api/support/report', {
        method: 'POST',
        body: { subject, details },
      });
      setMessages((prev) => [...prev, msg('assistant', res.assistantMessage)]);
      setReportSubject('');
      setReportDetails('');
      setReportOpen(false);
      setChatFailed(false);
    } catch (err) {
      setReportError(
        err instanceof ApiError
          ? err.message
          : 'I could not file that ticket. Please try again.',
      );
    } finally {
      setReporting(false);
    }
  }

  async function onConfirm() {
    if (!pending || applying) return;
    const kind = pending.kind;
    setApplying(true);
    try {
      const res =
        kind === 'ticket'
          ? await SupportApi.fileTicket(pending.proposalId)
          : kind === 'proof' || kind === 'drill'
            ? await SupportApi.runSimulatedCall(pending.proposalId)
            : kind === 'knowledge_addition'
              ? await SupportApi.applyKnowledge(pending.proposalId)
              : await SupportApi.apply(pending.proposalId);
      setMessages((prev) => [...prev, msg('assistant', res.assistantMessage)]);
      setPending(null);
    } catch (err) {
      const note =
        err instanceof ApiError
          ? err.message
          : kind === 'ticket'
            ? 'I could not file that ticket. Please try again.'
            : kind === 'proof' || kind === 'drill'
              ? 'I could not start that call. Please try again.'
              : kind === 'knowledge_addition'
                ? 'I could not add that to her knowledge. Please try again.'
                : 'I could not apply that change. Please try again.';
      setMessages((prev) => [...prev, msg('assistant', note)]);
      setPending(null);
    } finally {
      setApplying(false);
    }
  }

  function onCancel() {
    if (!pending) return;
    const kind = pending.kind;
    setPending(null);
    setMessages((prev) => [
      ...prev,
      msg(
        'assistant',
        kind === 'ticket'
          ? 'No problem, I did not file that ticket.'
          : kind === 'proof' || kind === 'drill'
            ? 'No problem, I did not run that call.'
            : kind === 'knowledge_addition'
              ? 'No problem, I did not add that to her knowledge.'
              : 'No problem, I left your booking window exactly as it was.',
      ),
    ]);
  }

  return (
    <div className="fixed bottom-[5.75rem] right-4 z-40 sm:bottom-6 sm:right-6">
      {open ? (
        <section
          aria-label={`Chat with ${SUPPORT_PERSONA.name}, ${SUPPORT_PERSONA.role}`}
          className="flex h-[min(560px,calc(100dvh-8rem))] w-[min(92vw,380px)] flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl sm:h-[min(560px,calc(100dvh-3rem))]"
        >
          {/* Persona header */}
          <header className="flex items-center gap-3 border-b border-line px-4 py-3">
            <span className="relative">
              <PersonaAvatar sizeClass="h-10 w-10 text-sm" />
              <span
                aria-hidden
                className="live-dot absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-clinic"
              />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-bold leading-tight text-ink">{SUPPORT_PERSONA.name}</p>
              <p className="text-xs leading-tight text-ink-muted">{SUPPORT_PERSONA.role}</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Minimize support chat"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-ink/[0.06] hover:text-ink"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden className="h-4.5 w-4.5">
                <path d="m5 7.5 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </header>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto px-3.5 py-3.5">
            {messages.map((m) =>
              m.role === 'assistant' ? (
                <div key={m.id} className="flex items-end gap-2">
                  <PersonaAvatar sizeClass="h-6 w-6 text-[10px]" />
                  <p className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-paper px-3 py-2 text-[13.5px] leading-relaxed text-ink">
                    {m.text}
                  </p>
                </div>
              ) : (
                <div key={m.id} className="flex justify-end">
                  <p className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-clinic px-3 py-2 text-[13.5px] leading-relaxed text-white">
                    {m.text}
                  </p>
                </div>
              ),
            )}
            {sending && (
              <p className="pl-8 text-xs italic text-ink-faint">{SUPPORT_PERSONA.name} is typing…</p>
            )}

            {/* Inline confirmation card for a proposed task. The confirm
                button's label names the act: file the ticket, run the proof
                or drill call, add the knowledge, or apply the change. */}
            {pending && (
              <div className="ml-8 rounded-xl border border-[rgba(20,184,166,0.4)] bg-clinic-soft px-3.5 py-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-signal-deep">
                  {pending.kind === 'ticket'
                    ? 'File this ticket'
                    : pending.kind === 'proof'
                      ? 'Run a proof call'
                      : pending.kind === 'drill'
                        ? 'Run a patient drill'
                        : pending.kind === 'knowledge_addition'
                          ? 'Add to her knowledge'
                          : 'Confirm this change'}
                </p>
                <p className="mt-1 text-[13.5px] leading-relaxed text-ink">{pending.summary}</p>
                <div className="mt-2.5 flex gap-2">
                  <button
                    type="button"
                    onClick={onConfirm}
                    disabled={applying}
                    className="rounded-full bg-clinic px-3.5 py-1.5 text-[13px] font-bold text-white transition-opacity disabled:opacity-60"
                  >
                    {applying
                      ? pending.kind === 'ticket'
                        ? 'Filing…'
                        : pending.kind === 'proof' || pending.kind === 'drill'
                          ? 'Starting…'
                          : pending.kind === 'knowledge_addition'
                            ? 'Adding…'
                            : 'Applying…'
                      : pending.kind === 'ticket'
                        ? 'File this ticket'
                        : pending.kind === 'proof'
                          ? 'Run the proof call'
                          : pending.kind === 'drill'
                            ? 'Start the drill'
                            : pending.kind === 'knowledge_addition'
                              ? 'Add to her knowledge'
                              : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    onClick={onCancel}
                    disabled={applying}
                    className="rounded-full border border-line bg-card px-3.5 py-1.5 text-[13px] font-semibold text-ink-muted transition-colors hover:text-ink disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* A simulated call's result: before and after for a proof,
                the graded run for a drill, recordings included. */}
            {simResult && (
              <div className="ml-8 rounded-xl border border-line bg-card px-3.5 py-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-signal-deep">
                  {simResult.kind === 'PROOF' ? 'Proof result' : 'Drill result'}
                </p>
                <p className="mt-1 text-[13.5px] font-semibold leading-relaxed text-ink">
                  {simResult.scenarioTitle}
                </p>
                {simResult.before && (
                  <div className="mt-2">
                    <p className="text-[12.5px] leading-relaxed text-ink-muted">
                      Before{simResult.before.when ? `, ${simResult.before.when}` : ''}
                      {simResult.before.successScore !== null
                        ? `, score ${simResult.before.successScore} of 10`
                        : ', not scored'}
                    </p>
                    {simResult.before.mediaToken && (
                      <audio controls src={mediaUrl(simResult.before.mediaToken)} className="mt-1 w-full" />
                    )}
                  </div>
                )}
                {simResult.after ? (
                  <div className="mt-2">
                    <p className="text-[12.5px] leading-relaxed text-ink-muted">
                      {simResult.before ? 'After' : 'Result'}
                      {simResult.after.successScore !== null
                        ? `, score ${simResult.after.successScore} of 10`
                        : ', not scored'}
                      {typeof simResult.after.durationSeconds === 'number' && simResult.after.durationSeconds > 0
                        ? `, ${Math.round(simResult.after.durationSeconds / 60) || 1} min call`
                        : ''}
                    </p>
                    {simResult.after.mediaToken && (
                      <audio controls src={mediaUrl(simResult.after.mediaToken)} className="mt-1 w-full" />
                    )}
                  </div>
                ) : (
                  simResult.note && (
                    <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">{simResult.note}</p>
                  )
                )}
                {simResult.after && simResult.note && (
                  <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">{simResult.note}</p>
                )}
              </div>
            )}

            {/* The weekly knowledge review, when one is waiting. */}
            {weeklyReview && (
              <div className="ml-8 rounded-xl border border-line bg-card px-3.5 py-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-signal-deep">
                  Weekly knowledge review
                </p>
                <p className="mt-1 text-[13.5px] leading-relaxed text-ink">
                  {weeklyReview.gapCount} patient question{weeklyReview.gapCount === 1 ? '' : 's'} this week
                  had no answer. I can walk you through them and draft the fixes from your own records.
                </p>
                <div className="mt-2.5 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void sendText('Walk me through the weekly review')}
                    disabled={sending}
                    className="rounded-full bg-clinic px-3.5 py-1.5 text-[13px] font-bold text-white transition-opacity disabled:opacity-60"
                  >
                    Walk me through them
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDismissReview()}
                    className="rounded-full border border-line bg-card px-3.5 py-1.5 text-[13px] font-semibold text-ink-muted transition-colors hover:text-ink"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {chatFailed && !reportOpen && (
              <div className="ml-8 rounded-xl border border-line bg-card px-3.5 py-3">
                <p className="text-[13.5px] leading-relaxed text-ink">
                  You can still report this directly to our team, including a problem with me.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setReportError('');
                    setReportOpen(true);
                  }}
                  className="mt-2.5 rounded-full border border-line bg-paper px-3.5 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:border-clinic"
                >
                  Report with a ticket form
                </button>
              </div>
            )}
          </div>

          {reportOpen && (
            <form onSubmit={onDirectReport} className="border-t border-line bg-card px-3.5 py-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-signal-deep">
                Report a problem
              </p>
              <label className="mt-2.5 block text-[12px] font-semibold text-ink" htmlFor="support-report-subject">
                Subject
              </label>
              <input
                id="support-report-subject"
                value={reportSubject}
                onChange={(e) => setReportSubject(e.target.value)}
                maxLength={140}
                className="mt-1 w-full rounded-xl border border-line bg-paper px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-clinic"
                placeholder="What happened?"
              />
              <label className="mt-2.5 block text-[12px] font-semibold text-ink" htmlFor="support-report-details">
                Details
              </label>
              <textarea
                id="support-report-details"
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value)}
                maxLength={2000}
                rows={4}
                className="mt-1 w-full resize-none rounded-xl border border-line bg-paper px-3 py-2 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-clinic"
                placeholder="Tell our team what went wrong."
              />
              {reportError && <p className="mt-2 text-[12.5px] leading-relaxed text-red-700">{reportError}</p>}
              <div className="mt-2.5 flex gap-2">
                <button
                  type="submit"
                  disabled={reporting || reportSubject.trim().length === 0 || reportDetails.trim().length === 0}
                  className="rounded-full bg-clinic px-3.5 py-1.5 text-[13px] font-bold text-white transition-opacity disabled:opacity-60"
                >
                  {reporting ? 'Filing…' : 'File this ticket'}
                </button>
                <button
                  type="button"
                  onClick={() => setReportOpen(false)}
                  disabled={reporting}
                  className="rounded-full border border-line bg-card px-3.5 py-1.5 text-[13px] font-semibold text-ink-muted transition-colors hover:text-ink disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Drill picker: pick a library scenario or describe your own;
              either way it goes through Adam, who proposes it for
              confirmation before anything runs. */}
          {drillOpen && (
            <div className="border-t border-line bg-card px-3.5 py-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-signal-deep">
                Patient drills
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
                A simulated patient calls your receptionist line and plays the scenario. It uses a few
                minutes of real call time, and {SUPPORT_PERSONA.name} grades the call after.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {(drillScenarios ?? []).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    disabled={sending}
                    onClick={() => {
                      setDrillOpen(false);
                      void sendText(`Run a patient drill: ${s.title}`);
                    }}
                    className="rounded-full border border-line bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-clinic disabled:opacity-60"
                  >
                    {s.title}
                  </button>
                ))}
                {drillScenarios === null && (
                  <p className="text-[12.5px] italic text-ink-faint">Loading scenarios…</p>
                )}
              </div>
              <label className="mt-3 block text-[12px] font-semibold text-ink" htmlFor="support-drill-custom">
                Or describe your own scenario
              </label>
              <textarea
                id="support-drill-custom"
                value={customScenario}
                onChange={(e) => setCustomScenario(e.target.value)}
                maxLength={600}
                rows={2}
                className="mt-1 w-full resize-none rounded-xl border border-line bg-paper px-3 py-2 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-clinic"
                placeholder="A parent calling about braces for their teenager…"
              />
              <button
                type="button"
                disabled={sending || customScenario.trim().length < 10}
                onClick={() => {
                  const text = customScenario.trim();
                  setCustomScenario('');
                  setDrillOpen(false);
                  void sendText(`Run a patient drill with my own scenario: ${text}`);
                }}
                className="mt-2 rounded-full bg-clinic px-3.5 py-1.5 text-[13px] font-bold text-white transition-opacity disabled:opacity-60"
              >
                Use this scenario
              </button>
            </div>
          )}

          {/* Input */}
          <div className="flex items-center gap-2 border-t border-line px-3 pt-2.5">
            <button
              type="button"
              onClick={() => void toggleDrills()}
              aria-expanded={drillOpen}
              className="rounded-full border border-line bg-card px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:border-clinic hover:text-ink"
            >
              Practice drills
            </button>
          </div>
          <form onSubmit={onSend} className="flex items-center gap-2 px-3 py-2.5">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Message ${SUPPORT_PERSONA.name}…`}
              aria-label={`Message ${SUPPORT_PERSONA.name}`}
              className="min-w-0 flex-1 rounded-full border border-line bg-paper px-3.5 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-clinic"
            />
            <button
              type="submit"
              disabled={sending || input.trim().length === 0}
              aria-label="Send message"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-clinic text-white transition-opacity disabled:opacity-50"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className="h-4 w-4">
                <path d="M2.5 10.8 17.6 3c.3-.2.7.2.5.5L13.4 17c-.2.4-.8.4-1 0l-1.7-3.9a1 1 0 0 0-.6-.6L6 10.7c-.4-.2-.4-.8 0-1l-3.5 1.1Z" />
              </svg>
            </button>
          </form>
        </section>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Chat with ${SUPPORT_PERSONA.name}, ${SUPPORT_PERSONA.role}`}
          className="flex items-center gap-2.5 rounded-full border border-line bg-card py-2 pl-2 pr-4 shadow-xl transition-transform hover:scale-[1.03]"
        >
          <span className="relative">
            <PersonaAvatar sizeClass="h-9 w-9 text-xs" />
            <span
              aria-hidden
              className="live-dot absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-clinic"
            />
          </span>
          <span className="text-left leading-tight">
            <span className="block text-[13.5px] font-bold text-ink">{SUPPORT_PERSONA.name}</span>
            <span className="block text-[11px] text-ink-muted">{SUPPORT_PERSONA.role}</span>
          </span>
        </button>
      )}
    </div>
  );
}
