'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  SupportApi,
  type SupportPendingProposal,
} from '@/lib/api';
import { SUPPORT_PERSONA, personaInitials } from './persona';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
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
 * product questions and can propose real changes (the booking window in
 * v1); a proposed change renders as an inline card and only applies when
 * the user taps Confirm.
 *
 * Placement: desktop bottom-right. On phone screens the app home carries a
 * fixed bottom tab bar, so below `sm` everything rides higher (bottom-24
 * neighbourhood) and the panel height is capped against the space left.
 */
export function SupportWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    msg(
      'assistant',
      `Hi, I'm ${SUPPORT_PERSONA.name} from VoiceFront support. Ask me how anything works, or tell me a change to make, like "only book weekday mornings".`,
    ),
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<SupportPendingProposal | null>(null);
  const [applying, setApplying] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, open]);

  async function onSend(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    const userMsg = msg('user', text);
    const history = [...messages, userMsg].slice(-20);
    setMessages(history);
    setInput('');
    setSending(true);
    try {
      const res = await SupportApi.chat(history.map(({ role, text: t }) => ({ role, text: t })));
      setMessages((prev) => [...prev, msg('assistant', res.reply)]);
      if (res.pendingProposal) setPending(res.pendingProposal);
    } catch (err) {
      const note =
        err instanceof ApiError
          ? err.message
          : 'Something went wrong on my side. Please try that again.';
      setMessages((prev) => [...prev, msg('assistant', note)]);
    } finally {
      setSending(false);
    }
  }

  async function onConfirm() {
    if (!pending || applying) return;
    setApplying(true);
    try {
      const res = await SupportApi.apply(pending.proposalId);
      setMessages((prev) => [...prev, msg('assistant', res.assistantMessage)]);
      setPending(null);
    } catch (err) {
      const note =
        err instanceof ApiError
          ? err.message
          : 'I could not apply that change. Please try again.';
      setMessages((prev) => [...prev, msg('assistant', note)]);
      setPending(null);
    } finally {
      setApplying(false);
    }
  }

  function onCancel() {
    setPending(null);
    setMessages((prev) => [
      ...prev,
      msg('assistant', 'No problem, I left your booking window exactly as it was.'),
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

            {/* Inline confirmation card for a proposed change */}
            {pending && (
              <div className="ml-8 rounded-xl border border-[rgba(20,184,166,0.4)] bg-clinic-soft px-3.5 py-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-signal-deep">
                  Confirm this change
                </p>
                <p className="mt-1 text-[13.5px] leading-relaxed text-ink">{pending.summary}</p>
                <div className="mt-2.5 flex gap-2">
                  <button
                    type="button"
                    onClick={onConfirm}
                    disabled={applying}
                    className="rounded-full bg-clinic px-3.5 py-1.5 text-[13px] font-bold text-white transition-opacity disabled:opacity-60"
                  >
                    {applying ? 'Applying…' : 'Confirm'}
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
          </div>

          {/* Input */}
          <form onSubmit={onSend} className="flex items-center gap-2 border-t border-line px-3 py-2.5">
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
