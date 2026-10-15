'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '@/lib/api';
import { LYLA_PERSONA, lylaInitials } from './lyla-persona';

/**
 * Lyla, the landing page host. Mounted ONLY by the marketing layout.
 *
 * Quiet on load: her face sits minimized in the corner, no auto-open, no
 * popups. She watches the page the way a good host watches a room
 * (section in view, dwell, the demo form's state, repeat visits, exit
 * intent) and the behavior engine below may speak first at most twice a
 * session, once per trigger, and only while the chat is closed. Two
 * dismissals mute her for the session.
 *
 * She is a separate agent from Adam: this widget talks only to
 * /api/public/*, which has no auth and no tenant context. When her chat
 * cannot start (Turnstile refused, breaker tripped, model unconfigured),
 * the panel says so plainly and points at the demo form, which always
 * works.
 */

/* ------------------------------ API shapes ----------------------------- */

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

type PageAction =
  | { type: 'guide_to_section'; section: 'demo' | 'how' | 'pricing' | 'faq' | 'book' }
  | { type: 'highlight_plan'; plan: 'starter' | 'core' }
  | { type: 'prefill_demo'; fields: { name?: string; email?: string; phone?: string; website?: string } }
  | { type: 'start_demo' }
  | { type: 'open_signup'; plan: 'starter' | 'core' };

interface PublicChatResult {
  reply: string;
  actions: PageAction[];
  sessionId: string;
  turnsUsed: number;
  turnsLeft: number;
}

interface VisitorState {
  section?: string;
  dwellSeconds?: number;
  sectionsVisited?: string[];
  formState?: string;
}

type ProactiveTrigger = 'pricing_dwell' | 'form_stall' | 'exit_intent';

class LylaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'LylaApiError';
  }
}

/** Her canned proactive lines, used only when the model call itself
 *  cannot happen. They mirror the API's fallbacks. */
const PROACTIVE_FALLBACK_LINES: Record<ProactiveTrigger, string> = {
  pricing_dwell:
    'Want a hand picking between the two plans? Tell me when your calls go unanswered and I will point you at the right one.',
  form_stall: 'Want me to finish that with you here? Give me the details and I will type them in.',
  exit_intent: 'Before you go, want the demo link by email so you can hear her on your own time?',
};

/* --------------------------- SSE (sibling parser) ---------------------- */
/* The same wire protocol as the support widget's stream: status, delta,
 * final, done, error. A sibling implementation on purpose, so Adam's
 * widget is never touched by Lyla's changes. */

type LylaStreamEvent =
  | { type: 'status'; label: string }
  | { type: 'delta'; text: string }
  | { type: 'final'; result: PublicChatResult }
  | { type: 'error'; message: string; code?: string }
  | { type: 'done' };

export function parseLylaStreamEvents(buffer: string): { events: LylaStreamEvent[]; rest: string } {
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? '';
  const events: LylaStreamEvent[] = [];
  for (const block of blocks) {
    let eventName = '';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
    }
    if (!eventName || dataLines.length === 0) continue;
    try {
      const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
      if (eventName === 'status' && typeof data.label === 'string') {
        events.push({ type: 'status', label: data.label });
      } else if (eventName === 'delta' && typeof data.text === 'string') {
        events.push({ type: 'delta', text: data.text });
      } else if (eventName === 'final') {
        events.push({ type: 'final', result: data as unknown as PublicChatResult });
      } else if (eventName === 'error' && typeof data.message === 'string') {
        events.push({ type: 'error', message: data.message, code: typeof data.code === 'string' ? data.code : undefined });
      } else if (eventName === 'done') {
        events.push({ type: 'done' });
      }
    } catch {
      /* A malformed block is skipped; the stream carries on. */
    }
  }
  return { events, rest };
}

/* ----------------------------- page actions ---------------------------- */

function ringElement(el: HTMLElement): void {
  const previousShadow = el.style.boxShadow;
  const previousTransition = el.style.transition;
  el.style.transition = 'box-shadow 300ms ease';
  el.style.boxShadow = '0 0 0 3px rgba(13, 148, 136, 0.6), 0 0 0 7px rgba(13, 148, 136, 0.18)';
  window.setTimeout(() => {
    el.style.boxShadow = previousShadow;
    el.style.transition = previousTransition;
  }, 2600);
}

function scrollAndRing(el: HTMLElement | null, ringDelayMs = 500): void {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => ringElement(el), ringDelayMs);
}

/**
 * Executes the page actions Lyla returned, in order, after her reply has
 * rendered. Small and DOM-only on purpose: the web app has no test
 * runner, so this stays a thin shell over three primitives (scroll and
 * ring, a window event the demo form listens for, and navigation).
 */
export function executeLylaActions(actions: PageAction[]): void {
  for (const action of actions) {
    switch (action.type) {
      case 'guide_to_section':
        scrollAndRing(document.getElementById(action.section));
        break;
      case 'highlight_plan': {
        const pricing = document.getElementById('pricing');
        pricing?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const card = document.querySelector<HTMLElement>(`[data-plan="${action.plan}"]`);
        if (card) window.setTimeout(() => ringElement(card), 500);
        break;
      }
      case 'prefill_demo': {
        scrollAndRing(document.getElementById('demo'));
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('lyla:prefill', { detail: action.fields }));
        }, 350);
        break;
      }
      case 'start_demo': {
        document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('lyla:start-demo'));
        }, 600);
        break;
      }
      case 'open_signup':
        window.location.href = `/register?plan=${action.plan}`;
        break;
    }
  }
}

/* ------------------------------ Turnstile ------------------------------ */

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

interface LylaTurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

function turnstileApi(): LylaTurnstileApi | undefined {
  return (window as unknown as { turnstile?: LylaTurnstileApi }).turnstile;
}

/**
 * The same bot check the demo lead form uses, rendered the same way
 * (explicit render, script loaded at most once per page). Lyla needs one
 * token to start a chat session; tokens are single-use, so the widget is
 * reset after every session start attempt. When no site key is
 * configured this renders nothing and the token stays null, exactly like
 * the demo form.
 */
function LylaTurnstile({
  onToken,
  resetRef,
  visible,
}: {
  onToken: (token: string | null) => void;
  resetRef: React.MutableRefObject<(() => void) | null>;
  visible: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let cancelled = false;
    const renderWidget = () => {
      const api = turnstileApi();
      if (cancelled || widgetIdRef.current || !containerRef.current || !api) return;
      widgetIdRef.current = api.render(containerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(null),
        'error-callback': () => onTokenRef.current(null),
      });
      resetRef.current = () => {
        const current = turnstileApi();
        if (widgetIdRef.current && current) current.reset(widgetIdRef.current);
      };
    };
    if (turnstileApi()) {
      renderWidget();
    } else {
      let script = document.querySelector<HTMLScriptElement>('script[data-turnstile-script]');
      if (!script) {
        script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.dataset.turnstileScript = '';
        document.head.appendChild(script);
      }
      script.addEventListener('load', renderWidget);
    }
    return () => {
      cancelled = true;
      resetRef.current = null;
      const api = turnstileApi();
      if (widgetIdRef.current && api) api.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [resetRef]);

  if (!TURNSTILE_SITE_KEY) return null;
  return (
    <div
      ref={containerRef}
      aria-hidden={!visible}
      className={
        visible
          ? 'flex justify-center px-4 py-2'
          : 'pointer-events-none absolute bottom-24 right-6 -z-10 h-16 w-[300px] overflow-hidden opacity-0'
      }
    />
  );
}

/* ------------------------------- avatar -------------------------------- */

function LylaAvatar({ sizeClass }: { sizeClass: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-full bg-teal-700 font-display font-semibold text-white`}
        aria-hidden
      >
        {lylaInitials(LYLA_PERSONA.name)}
      </span>
    );
  }
  return (
    <img
      src={LYLA_PERSONA.avatarPath}
      alt={LYLA_PERSONA.name}
      className={`${sizeClass} shrink-0 rounded-full object-cover`}
      onError={() => setFailed(true)}
    />
  );
}

/* --------------------------- behavior engine --------------------------- */

const OBSERVED_SECTIONS = ['demo', 'how', 'pricing', 'faq', 'book', 'sample-call'];
const PRICING_DWELL_TRIGGER_SECONDS = 20;
const FORM_STALL_SECONDS = 12;
const MAX_PROACTIVE_PER_SESSION = 2;

interface BehaviorState {
  section: string | null;
  sectionSince: number;
  dwellBySection: Map<string, number>;
  visitedOrder: string[];
  visitCounts: Map<string, number>;
  formFocused: boolean;
  formHasInput: boolean;
  formLastKeystrokeAt: number;
  exitIntent: boolean;
}

function freshBehavior(): BehaviorState {
  return {
    section: null,
    sectionSince: Date.now(),
    dwellBySection: new Map(),
    visitedOrder: [],
    visitCounts: new Map(),
    formFocused: false,
    formHasInput: false,
    formLastKeystrokeAt: 0,
    exitIntent: false,
  };
}

function formStateOf(b: BehaviorState): string {
  if (b.formHasInput) {
    return Date.now() - b.formLastKeystrokeAt >= FORM_STALL_SECONDS * 1000 ? 'stalled' : 'partial';
  }
  return b.formFocused ? 'focused' : 'untouched';
}

function buildVisitorState(b: BehaviorState): VisitorState {
  let dwellSeconds: number | undefined;
  if (b.section) {
    const banked = b.dwellBySection.get(b.section) ?? 0;
    dwellSeconds = Math.round(banked + (Date.now() - b.sectionSince) / 1000);
  }
  return {
    section: b.section ?? undefined,
    dwellSeconds,
    sectionsVisited: b.visitedOrder.slice(0, 12),
    formState: formStateOf(b),
  };
}

function sectionDwellSeconds(b: BehaviorState, section: string): number {
  const banked = b.dwellBySection.get(section) ?? 0;
  const live = b.section === section ? (Date.now() - b.sectionSince) / 1000 : 0;
  return banked + live;
}

/* -------------------------------- widget ------------------------------- */

type SessionPhase = 'idle' | 'starting' | 'ready' | 'unavailable';

export function LylaWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [streamText, setStreamText] = useState('');
  const [sessionPhase, setSessionPhase] = useState<SessionPhase>('idle');
  const [turnsExhausted, setTurnsExhausted] = useState(false);
  const [proactiveNote, setProactiveNote] = useState<{ trigger: ProactiveTrigger; line: string } | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const greetingRef = useRef<string>(LYLA_PERSONA.greeting);
  const turnstileTokenRef = useRef<string | null>(null);
  const turnstileResetRef = useRef<(() => void) | null>(null);
  const behaviorRef = useRef<BehaviorState>(freshBehavior());
  const proactiveFiredRef = useRef<Set<ProactiveTrigger>>(new Set());
  const proactiveUsedRef = useRef(0);
  const proactiveDismissalsRef = useRef(0);
  const proactiveMutedRef = useRef(false);
  const proactiveBusyRef = useRef(false);
  const openRef = useRef(false);
  const sendingRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const streamTargetRef = useRef('');
  const streamShownRef = useRef(0);
  const revealFrameRef = useRef<number | null>(null);
  const scrollBoxRef = useRef<HTMLDivElement | null>(null);

  openRef.current = open;
  sendingRef.current = sending;
  messagesRef.current = messages;

  /* ------------------------- session lifecycle ------------------------ */

  const startSession = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    setSessionPhase((phase) => (phase === 'ready' ? phase : 'starting'));
    try {
      const res = await fetch(`${API_URL}/api/public/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          turnstileToken: turnstileTokenRef.current ?? undefined,
          referrer: document.referrer || undefined,
          localTime: new Date().toLocaleString(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
        throw new LylaApiError(res.status, body.error?.message ?? 'Chat is unavailable right now.', body.error?.code);
      }
      const data = (await res.json()) as { sessionId: string; greeting?: string };
      sessionIdRef.current = data.sessionId;
      if (typeof data.greeting === 'string' && data.greeting) greetingRef.current = data.greeting;
      setSessionPhase('ready');
      return data.sessionId;
    } catch {
      setSessionPhase('unavailable');
      return null;
    } finally {
      // Turnstile tokens are single-use: whatever happened, the next
      // start attempt needs a fresh challenge.
      turnstileTokenRef.current = null;
      turnstileResetRef.current?.();
    }
  }, []);

  // Opening the panel starts the session (once) and seeds her greeting.
  // When a bot check is configured, the first attempt can race the
  // challenge token, so a failed start gets one delayed retry before the
  // panel settles into its unavailable state.
  const attemptStart = useCallback(async (): Promise<void> => {
    let id = await startSession();
    if (!id && TURNSTILE_SITE_KEY) {
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      id = await startSession();
    }
    if (!id) return;
    setMessages((current) =>
      current.length === 0 ? [{ role: 'assistant', text: greetingRef.current }] : current,
    );
  }, [startSession]);

  useEffect(() => {
    if (!open) return;
    // Opening the chat spends any pending exit intent: she never fires
    // the exit save the moment the visitor closes the panel again.
    behaviorRef.current.exitIntent = false;
    let cancelled = false;
    void (async () => {
      await attemptStart();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [open, attemptStart]);

  /* --------------------------- behavior watch ------------------------- */

  useEffect(() => {
    const behavior = behaviorRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = entry.target.id;
          if (!id || id === behavior.section) continue;
          const now = Date.now();
          if (behavior.section) {
            const elapsed = (now - behavior.sectionSince) / 1000;
            behavior.dwellBySection.set(
              behavior.section,
              (behavior.dwellBySection.get(behavior.section) ?? 0) + elapsed,
            );
          }
          behavior.section = id;
          behavior.sectionSince = now;
          behavior.visitCounts.set(id, (behavior.visitCounts.get(id) ?? 0) + 1);
          if (!behavior.visitedOrder.includes(id)) behavior.visitedOrder.push(id);
        }
      },
      { threshold: 0.35 },
    );
    for (const id of OBSERVED_SECTIONS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    const inDemoForm = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && Boolean(target.closest('#demo'));
    const onFocusIn = (event: FocusEvent) => {
      if (inDemoForm(event.target)) behavior.formFocused = true;
    };
    const onInput = (event: Event) => {
      if (!inDemoForm(event.target)) return;
      behavior.formFocused = true;
      behavior.formHasInput = true;
      behavior.formLastKeystrokeAt = Date.now();
    };
    const onMouseLeave = (event: MouseEvent) => {
      if (event.clientY <= 0) behavior.exitIntent = true;
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('input', onInput);
    if (window.matchMedia('(pointer: fine)').matches) {
      document.addEventListener('mouseleave', onMouseLeave);
    }
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('input', onInput);
      document.removeEventListener('mouseleave', onMouseLeave);
    };
  }, []);

  /* ------------------------- proactive scheduler ---------------------- */

  const requestProactive = useCallback(async (trigger: ProactiveTrigger) => {
    if (proactiveBusyRef.current) return;
    proactiveBusyRef.current = true;
    try {
      const sessionId = await startSession();
      if (!sessionId) {
        // No session (bot check or breaker): her canned line costs no
        // model call, so it may still offer help. The local budget below
        // has already been spent by the caller either way.
        setProactiveNote({ trigger, line: PROACTIVE_FALLBACK_LINES[trigger] });
        return;
      }
      try {
        const res = await fetch(`${API_URL}/api/public/proactive`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            trigger,
            visitorState: buildVisitorState(behaviorRef.current),
            referrer: document.referrer || undefined,
            localTime: new Date().toLocaleString(),
          }),
        });
        if (!res.ok) throw new Error('proactive refused');
        const data = (await res.json()) as { line: string | null };
        if (data.line) setProactiveNote({ trigger, line: data.line });
      } catch {
        setProactiveNote({ trigger, line: PROACTIVE_FALLBACK_LINES[trigger] });
      }
    } finally {
      proactiveBusyRef.current = false;
    }
  }, [startSession]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      // Manners, enforced here in code: never while the chat is open,
      // never mid-send, never after two dismissals, never past budget,
      // never twice for the same trigger.
      if (openRef.current || sendingRef.current || proactiveMutedRef.current) return;
      if (proactiveUsedRef.current >= MAX_PROACTIVE_PER_SESSION) return;
      if (proactiveNote) return;
      const behavior = behaviorRef.current;
      const fired = proactiveFiredRef.current;
      let trigger: ProactiveTrigger | null = null;
      if (behavior.exitIntent && !fired.has('exit_intent')) {
        trigger = 'exit_intent';
        behavior.exitIntent = false;
      } else if (
        behavior.section === 'pricing' &&
        sectionDwellSeconds(behavior, 'pricing') >= PRICING_DWELL_TRIGGER_SECONDS &&
        !fired.has('pricing_dwell')
      ) {
        trigger = 'pricing_dwell';
      } else if (formStateOf(behavior) === 'stalled' && !fired.has('form_stall')) {
        trigger = 'form_stall';
      }
      if (!trigger) return;
      fired.add(trigger);
      proactiveUsedRef.current += 1;
      void requestProactive(trigger);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [proactiveNote, requestProactive]);

  const dismissProactive = useCallback(() => {
    setProactiveNote(null);
    proactiveDismissalsRef.current += 1;
    if (proactiveDismissalsRef.current >= 2) proactiveMutedRef.current = true;
  }, []);

  const openFromProactive = useCallback(() => {
    if (proactiveNote) {
      setMessages((current) =>
        current.some((m) => m.text === proactiveNote.line)
          ? current
          : [...current, { role: 'assistant' as const, text: proactiveNote.line }],
      );
    }
    setProactiveNote(null);
    setOpen(true);
  }, [proactiveNote]);

  /* ------------------------------ chatting ---------------------------- */

  const stopReveal = useCallback(() => {
    if (revealFrameRef.current !== null) {
      cancelAnimationFrame(revealFrameRef.current);
      revealFrameRef.current = null;
    }
    streamTargetRef.current = '';
    streamShownRef.current = 0;
    setStreamText('');
  }, []);

  const pumpReveal = useCallback(() => {
    if (revealFrameRef.current !== null) return;
    const step = () => {
      const target = streamTargetRef.current;
      const shown = streamShownRef.current;
      if (shown >= target.length) {
        revealFrameRef.current = null;
        return;
      }
      const remaining = target.length - shown;
      const stepSize = Math.min(48, Math.max(2, Math.ceil(remaining / 8)));
      const next = Math.min(target.length, shown + stepSize);
      streamShownRef.current = next;
      setStreamText(target.slice(0, next));
      revealFrameRef.current = requestAnimationFrame(step);
    };
    revealFrameRef.current = requestAnimationFrame(step);
  }, []);

  const applyResult = useCallback(
    (result: PublicChatResult) => {
      stopReveal();
      setStreamStatus(null);
      setMessages((current) => [...current, { role: 'assistant', text: result.reply }]);
      if (result.turnsLeft <= 0) setTurnsExhausted(true);
      if (result.actions.length > 0) {
        window.setTimeout(() => executeLylaActions(result.actions), 60);
      }
    },
    [stopReveal],
  );

  const chatRequestBody = useCallback(
    (sessionId: string, history: ChatMessage[]) => ({
      sessionId,
      messages: history.slice(-20),
      visitorState: buildVisitorState(behaviorRef.current),
      referrer: document.referrer || undefined,
      localTime: new Date().toLocaleString(),
    }),
    [],
  );

  const streamChat = useCallback(
    async (sessionId: string, history: ChatMessage[]): Promise<PublicChatResult> => {
      const res = await fetch(`${API_URL}/api/public/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chatRequestBody(sessionId, history)),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
        throw new LylaApiError(res.status, body.error?.message ?? 'Lyla had trouble answering just now.', body.error?.code);
      }
      if (!res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        throw new LylaApiError(0, 'Streaming unavailable.', 'STREAM_UNAVAILABLE');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let final: PublicChatResult | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        if (done) buffer += decoder.decode();
        const { events, rest } = parseLylaStreamEvents(buffer);
        buffer = rest;
        for (const event of events) {
          if (event.type === 'status') {
            stopReveal();
            setStreamStatus(event.label);
          } else if (event.type === 'delta') {
            setStreamStatus(null);
            streamTargetRef.current += event.text;
            pumpReveal();
          } else if (event.type === 'final') {
            final = event.result;
          } else if (event.type === 'error') {
            throw new LylaApiError(502, event.message, event.code);
          }
        }
        if (done) break;
      }
      if (!final) throw new LylaApiError(0, 'Stream ended early.', 'STREAM_INCOMPLETE');
      return final;
    },
    [chatRequestBody, pumpReveal, stopReveal],
  );

  const plainChat = useCallback(
    async (sessionId: string, history: ChatMessage[]): Promise<PublicChatResult> => {
      const res = await fetch(`${API_URL}/api/public/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chatRequestBody(sessionId, history)),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
        throw new LylaApiError(res.status, body.error?.message ?? 'Lyla had trouble answering just now.', body.error?.code);
      }
      return (await res.json()) as PublicChatResult;
    },
    [chatRequestBody],
  );

  const sendText = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sendingRef.current || turnsExhausted) return;
      const sessionId = sessionIdRef.current ?? (await startSession());
      if (!sessionId) {
        setMessages((current) => [
          ...current,
          { role: 'user', text },
          {
            role: 'assistant',
            text: 'Chat is not available right now. The demo form on this page will get you straight in.',
          },
        ]);
        return;
      }
      const userMessage: ChatMessage = { role: 'user', text };
      const history = [...messagesRef.current, userMessage];
      setMessages(history);
      setInput('');
      setSending(true);
      try {
        let result: PublicChatResult;
        try {
          result = await streamChat(sessionId, history);
        } catch {
          result = await plainChat(sessionId, history);
        }
        applyResult(result);
      } catch (err) {
        stopReveal();
        setStreamStatus(null);
        const message =
          err instanceof LylaApiError ? err.message : 'Lyla had trouble answering just now. Please try again.';
        if (err instanceof LylaApiError && err.code === 'SESSION_TURN_LIMIT') setTurnsExhausted(true);
        if (err instanceof LylaApiError && err.code === 'SESSION_NOT_FOUND') {
          // The server forgot this session (expiry): the next send starts
          // a fresh one instead of failing against a dead id.
          sessionIdRef.current = null;
          setSessionPhase('idle');
        }
        setMessages((current) => [...current, { role: 'assistant', text: message }]);
      } finally {
        setSending(false);
      }
    },
    [applyResult, plainChat, startSession, stopReveal, streamChat, turnsExhausted],
  );

  useEffect(() => {
    const box = scrollBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages, streamText, streamStatus, open]);

  /* -------------------------------- render ---------------------------- */

  return (
    <>
      {/* Proactive bubble: one short line, dismissible, never a popup. */}
      {proactiveNote && !open && (
        <div className="fixed bottom-24 right-4 z-40 w-[min(92vw,320px)] rounded-2xl border border-line bg-white p-4 shadow-lift sm:right-6">
          <div className="flex items-start gap-3">
            <LylaAvatar sizeClass="h-9 w-9 text-[13px]" />
            <p className="flex-1 text-[13.5px] leading-relaxed text-ink">{proactiveNote.line}</p>
            <button
              type="button"
              onClick={dismissProactive}
              aria-label="Dismiss"
              className="rounded-full px-1 text-ink-muted transition-colors hover:text-ink"
            >
              ✕
            </button>
          </div>
          <button
            type="button"
            onClick={openFromProactive}
            className="mt-3 w-full rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-transform hover:-translate-y-0.5"
          >
            Chat with {LYLA_PERSONA.name}
          </button>
        </div>
      )}

      {/* Minimized pill: her face and name, quiet until tapped. */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-4 z-40 flex items-center gap-3 rounded-full border border-line bg-white py-2 pl-2 pr-4 shadow-lift transition-transform hover:-translate-y-0.5 sm:right-6"
          aria-label={`Chat with ${LYLA_PERSONA.name}, ${LYLA_PERSONA.role}`}
        >
          <span className="relative">
            <LylaAvatar sizeClass="h-10 w-10 text-sm" />
            <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-teal-500 ring-2 ring-white" />
          </span>
          <span className="text-left">
            <span className="block text-[13.5px] font-semibold leading-tight text-ink">{LYLA_PERSONA.name}</span>
            <span className="block text-[11.5px] leading-tight text-ink-muted">{LYLA_PERSONA.role}</span>
          </span>
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-5 right-4 z-40 flex h-[min(560px,calc(100dvh-6rem))] w-[min(92vw,380px)] flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-lift sm:right-6">
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <LylaAvatar sizeClass="h-10 w-10 text-sm" />
            <div className="flex-1">
              <p className="text-[14px] font-semibold leading-tight text-ink">{LYLA_PERSONA.name}</p>
              <p className="text-[11.5px] leading-tight text-ink-muted">{LYLA_PERSONA.role}</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Minimize chat"
              className="rounded-full px-2 py-1 text-ink-muted transition-colors hover:text-ink"
            >
              ✕
            </button>
          </div>

          <LylaTurnstile
            onToken={(token) => {
              turnstileTokenRef.current = token;
            }}
            resetRef={turnstileResetRef}
            visible={sessionPhase === 'starting'}
          />

          <div ref={scrollBoxRef} className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-4">
            {sessionPhase === 'unavailable' ? (
              <div className="rounded-2xl rounded-bl-md bg-paper px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink">
                Chat is not available right now. The demo form on this page will get you straight in, it
                takes about a minute.
                <span className="mt-2 flex gap-4">
                  <button
                    type="button"
                    onClick={() => document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth' })}
                    className="font-semibold text-teal-700 underline"
                  >
                    Take me to the demo
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSessionPhase('idle');
                      void attemptStart();
                    }}
                    className="font-semibold text-teal-700 underline"
                  >
                    Try chat again
                  </button>
                </span>
              </div>
            ) : (
              <>
                {messages.map((message, index) => (
                  <div
                    key={index}
                    className={
                      message.role === 'user'
                        ? 'max-w-[85%] self-end rounded-2xl rounded-br-md bg-ink px-3.5 py-2.5 text-[13.5px] leading-relaxed text-white'
                        : 'max-w-[85%] self-start rounded-2xl rounded-bl-md bg-paper px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink'
                    }
                  >
                    {message.text}
                  </div>
                ))}
                {streamStatus && (
                  <p className="self-start px-1 text-[12px] italic text-ink-muted">{streamStatus}…</p>
                )}
                {streamText && (
                  <div className="max-w-[85%] self-start rounded-2xl rounded-bl-md bg-paper px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink">
                    {streamText}
                  </div>
                )}
                {sending && !streamStatus && !streamText && (
                  <p className="self-start px-1 text-[12px] italic text-ink-muted">{LYLA_PERSONA.name} is typing…</p>
                )}
              </>
            )}
          </div>

          <form
            className="flex items-center gap-2 border-t border-line px-3 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              void sendText(input);
            }}
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={turnsExhausted ? 'Message limit reached for this chat' : `Ask ${LYLA_PERSONA.name} anything…`}
              disabled={sessionPhase === 'unavailable' || turnsExhausted}
              className="flex-1 rounded-full border border-line bg-white px-4 py-2.5 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-muted/70 focus:border-teal-600 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={sending || !input.trim() || sessionPhase === 'unavailable' || turnsExhausted}
              className="rounded-full bg-ink px-4 py-2.5 text-[13.5px] font-semibold text-white transition-opacity disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </div>
      )}

      {/* The bot check also needs to exist while the panel is closed, so a
          proactive-triggered session start can find a token. */}
      {!open && (
        <LylaTurnstile
          onToken={(token) => {
            turnstileTokenRef.current = token;
          }}
          resetRef={turnstileResetRef}
          visible={false}
        />
      )}
    </>
  );
}
