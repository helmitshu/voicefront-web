'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '@/lib/api';
import { LYLA_PERSONA, lylaInitials } from './lyla-persona';

/**
 * Lyla, the landing page host. Mounted ONLY by the marketing layout.
 *
 * Quiet on load: her face sits minimized in the corner, no auto-open.
 * Five seconds into the session she greets the room once with a small
 * preview card; past that, she watches the page the way a good host
 * watches a room (section in view, dwell, the demo form's state, repeat
 * visits, exit intent) and the behavior engine below may speak first at
 * most twice a session, once per trigger, welcome included, and only
 * while the chat is closed. Two dismissals mute her for the session.
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
  | {
      type: 'prefill_demo';
      fields: {
        name?: string;
        email?: string;
        phone?: string;
        website?: string;
        /** The demo form's own industry values. */
        businessKind?: 'clinic' | 'contractor' | 'other';
      };
    }
  | { type: 'start_demo' }
  | { type: 'open_signup'; plan: 'starter' | 'core' };

/** What the page itself reports back about an action Lyla fired. Sent
 *  once, on her next chat or proactive call, so she may only ever speak
 *  of an outcome the page actually reported. Mirrors the API's shape. */
interface PageReport {
  action: string;
  outcome: string;
  detail?: string;
}

/** Maps the demo form's submit outcome (the 'lyla:demo-status' event
 *  detail) into the report shape Lyla's context carries. Pure, like the
 *  stream parser, so the mapping stays reviewable without a DOM. */
export function pageReportFromDemoStatus(detail: unknown): PageReport {
  const outcome = (detail ?? {}) as { ok?: unknown; view?: unknown; reason?: unknown };
  if (outcome.ok === true) {
    return {
      action: 'start_demo',
      outcome: 'submitted',
      detail:
        outcome.view === 'confirm'
          ? 'The form shows the facts-check step now.'
          : outcome.view === 'choose'
            ? 'The form shows the demo choice step now.'
            : undefined,
    };
  }
  if (outcome.ok === false) {
    return {
      action: 'start_demo',
      outcome: 'blocked',
      detail: typeof outcome.reason === 'string' && outcome.reason ? outcome.reason : undefined,
    };
  }
  return { action: 'start_demo', outcome: 'unknown' };
}

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

type ProactiveTrigger = 'welcome' | 'pricing_dwell' | 'form_stall' | 'exit_intent';

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

/** Her welcome line, word for word. The welcome is a local greeting,
 *  never an API proactive call (the public agent's trigger list has no
 *  welcome), so this text is the only line that trigger can show. */
const WELCOME_MESSAGE =
  "Hi, I'm Lyla, an AI host from VoiceFront. I can answer questions or set up your personalized demo.";

/** Her canned proactive lines, used only when the model call itself
 *  cannot happen. They mirror the API's fallbacks; the welcome entry is
 *  the welcome line itself, for completeness of the record. */
const PROACTIVE_FALLBACK_LINES: Record<ProactiveTrigger, string> = {
  welcome: WELCOME_MESSAGE,
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

/* ------------------------- guided page movement ------------------------ */
/* Lyla does not teleport the visitor: she walks the page to the target
 * with an eased scroll while a cutout overlay dims the rest of the room,
 * then sets a spotlight on the target for a breath (the .lyla-spotlight
 * keyframes in globals.css: a soft teal ring, a gentle scale, a shadow
 * pulse). The visitor can take the page back at any moment: a wheel or
 * touch input cancels the move mid-flight. Every run cleans up after
 * itself, on arrival, on interruption, on a second action, and on
 * unmount. When motion is not welcome (prefers-reduced-motion or the
 * app's calm mode), a guide is a plain instant scroll and nothing else. */

const GUIDE_MIN_MS = 600;
const GUIDE_MAX_MS = 1400;
const GUIDE_SPOTLIGHT_MS = 2400;
/** Matches the html scroll-padding-top (7rem) anchor navigation uses. */
const GUIDE_TOP_OFFSET_PX = 112;

function motionSettled(): boolean {
  return (
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.dataset.calm === 'true'
  );
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

interface GuidingHooks {
  onGuidingChange?: (guiding: boolean) => void;
}

/** The running guide's cleanup, so a second action (or the widget
 *  unmounting) can end the current move before starting anything new. */
let activeGuideCleanup: (() => void) | null = null;

export function cancelActiveGuide(): void {
  activeGuideCleanup?.();
}

function guideToElement(
  el: HTMLElement | null,
  options?: { block?: 'start' | 'center'; hooks?: GuidingHooks },
): void {
  if (!el) return;
  cancelActiveGuide();
  const block = options?.block ?? 'start';
  const hooks = options?.hooks;
  if (motionSettled()) {
    // Instant path: the stylesheet also stills every animation, so no
    // overlay, no spotlight, no guiding state, just the jump. The html
    // scroll-behavior is overridden for this call only, because the
    // global smooth setting would otherwise animate the jump anyway.
    const html = document.documentElement;
    const previousBehavior = html.style.scrollBehavior;
    html.style.scrollBehavior = 'auto';
    el.scrollIntoView({ block });
    html.style.scrollBehavior = previousBehavior;
    return;
  }

  hooks?.onGuidingChange?.(true);
  document.body.classList.add('lyla-guiding');

  // The dim: a fixed cutout whose giant shadow darkens everything but
  // the hole over the target. It tracks the target every frame, because
  // the target travels while the page scrolls beneath it.
  const overlay = document.createElement('div');
  overlay.className = 'lyla-guide-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.opacity = '0';
  document.body.appendChild(overlay);
  const placeOverlay = () => {
    const rect = el.getBoundingClientRect();
    const pad = 10;
    const left = Math.max(8, rect.left - pad);
    const top = Math.max(8, rect.top - pad);
    const right = Math.min(window.innerWidth - 8, rect.right + pad);
    const bottom = Math.min(window.innerHeight - 8, rect.bottom + pad);
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.style.width = `${Math.max(0, right - left)}px`;
    overlay.style.height = `${Math.max(0, bottom - top)}px`;
  };
  placeOverlay();
  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
  });

  // Manual smooth scrolling for the length of the move; the page's own
  // anchors get their smooth behavior back the moment it ends.
  const html = document.documentElement;
  const previousBehavior = html.style.scrollBehavior;
  html.style.scrollBehavior = 'auto';

  const startY = window.scrollY;
  const startRect = el.getBoundingClientRect();
  const destY =
    block === 'center'
      ? startY + startRect.top - Math.max(0, (window.innerHeight - startRect.height) / 2)
      : startY + startRect.top - GUIDE_TOP_OFFSET_PX;
  const distance = Math.abs(destY - startY);
  const duration = Math.round(Math.min(GUIDE_MAX_MS, Math.max(GUIDE_MIN_MS, 500 + distance * 0.4)));

  let frame = 0;
  let spotlightTimer = 0;
  let overlayTimer = 0;
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(frame);
    window.clearTimeout(spotlightTimer);
    window.clearTimeout(overlayTimer);
    window.removeEventListener('wheel', onInterrupt);
    window.removeEventListener('touchstart', onInterrupt);
    document.body.classList.remove('lyla-guiding');
    el.classList.remove('lyla-spotlight');
    overlay.remove();
    html.style.scrollBehavior = previousBehavior;
    if (activeGuideCleanup === cleanup) activeGuideCleanup = null;
    hooks?.onGuidingChange?.(false);
  };
  const onInterrupt = () => cleanup();
  window.addEventListener('wheel', onInterrupt, { passive: true });
  window.addEventListener('touchstart', onInterrupt, { passive: true });
  activeGuideCleanup = cleanup;

  if (distance < 8) {
    // Already there: skip the travel, settle with the spotlight alone.
    overlay.style.opacity = '0';
    overlayTimer = window.setTimeout(() => overlay.remove(), 340);
    el.classList.add('lyla-spotlight');
    spotlightTimer = window.setTimeout(cleanup, GUIDE_SPOTLIGHT_MS);
    return;
  }
  const startAt = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - startAt) / duration);
    window.scrollTo(0, startY + (destY - startY) * easeInOutCubic(t));
    placeOverlay();
    if (t < 1) {
      frame = requestAnimationFrame(step);
      return;
    }
    // Arrived: the dim lifts and the target takes the spotlight.
    overlay.style.opacity = '0';
    overlayTimer = window.setTimeout(() => overlay.remove(), 340);
    el.classList.add('lyla-spotlight');
    spotlightTimer = window.setTimeout(cleanup, GUIDE_SPOTLIGHT_MS);
  };
  frame = requestAnimationFrame(step);
}

/** Cleanup for a still-pending demo-status listener, so a second
 *  start_demo never leaves the first one's listener (or timer) behind. */
let pendingDemoStatusCleanup: (() => void) | null = null;

/**
 * Executes the page actions Lyla returned, in order, after her reply has
 * rendered. Small and DOM-only on purpose: the web app has no test
 * runner, so this stays a thin shell over three primitives (the guided
 * move above, a window event the demo form listens for, and navigation).
 * Guided moves report their run through onGuidingChange, so her
 * presence can show that she is showing the visitor around.
 *
 * For start_demo the hooks carry the honest handoff: onStartDemo steps
 * her panel aside so the visitor can see the form she just submitted
 * (on mobile the panel covers it), and onDemoStatus receives the form's
 * own report of what the submit did, or a 'no-report' outcome when the
 * form never answers.
 */
export function executeLylaActions(
  actions: PageAction[],
  hooks?: {
    onStartDemo?: () => void;
    onDemoStatus?: (report: PageReport) => void;
    onGuidingChange?: (guiding: boolean) => void;
  },
): void {
  for (const action of actions) {
    switch (action.type) {
      case 'guide_to_section':
        guideToElement(document.getElementById(action.section), { hooks });
        break;
      case 'highlight_plan': {
        const card = document.querySelector<HTMLElement>(`[data-plan="${action.plan}"]`);
        if (card) {
          guideToElement(card, { block: 'center', hooks });
        } else {
          guideToElement(document.getElementById('pricing'), { hooks });
        }
        break;
      }
      case 'prefill_demo': {
        guideToElement(document.getElementById('demo'), { hooks });
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('lyla:prefill', { detail: action.fields }));
        }, 350);
        break;
      }
      case 'start_demo': {
        hooks?.onStartDemo?.();
        guideToElement(document.getElementById('demo'), { hooks });
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('lyla:start-demo'));
          if (!hooks?.onDemoStatus) return;
          const onDemoStatus = hooks.onDemoStatus;
          pendingDemoStatusCleanup?.();
          const cleanup = () => {
            window.removeEventListener('lyla:demo-status', onStatus);
            window.clearTimeout(timer);
            if (pendingDemoStatusCleanup === cleanup) pendingDemoStatusCleanup = null;
          };
          const onStatus = (event: Event) => {
            cleanup();
            onDemoStatus(pageReportFromDemoStatus((event as CustomEvent<unknown>).detail));
          };
          const timer = window.setTimeout(() => {
            cleanup();
            onDemoStatus({ action: 'start_demo', outcome: 'no-report' });
          }, 6000);
          pendingDemoStatusCleanup = cleanup;
          window.addEventListener('lyla:demo-status', onStatus);
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
          ? 'flex shrink-0 justify-center px-4 py-2'
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

/**
 * Her working indicator: her face and three lifting dots, with the
 * current tool status as a quiet label when the stream provides one.
 * Replaces every plain-text spinner in the panel, so "she is working"
 * always looks like her, never like a system message.
 */
function LylaTyping({ label }: { label?: string }) {
  return (
    <div
      className="lyla-msg flex max-w-[85%] items-center gap-2.5 self-start rounded-2xl rounded-bl-md bg-paper px-3.5 py-2.5"
      role="status"
      aria-label={label ? `${LYLA_PERSONA.name}: ${label}` : `${LYLA_PERSONA.name} is typing`}
    >
      <LylaAvatar sizeClass="h-6 w-6 text-[10px]" />
      <span className="flex items-center gap-1" aria-hidden>
        <span className="lyla-dot" />
        <span className="lyla-dot" style={{ animationDelay: '0.15s' }} />
        <span className="lyla-dot" style={{ animationDelay: '0.3s' }} />
      </span>
      {label && <span className="text-[12px] italic text-ink-muted">{label}…</span>}
    </div>
  );
}

/* --------------------------- behavior engine --------------------------- */

const OBSERVED_SECTIONS = ['demo', 'how', 'pricing', 'faq', 'book', 'sample-call'];
const PRICING_DWELL_TRIGGER_SECONDS = 20;
const FORM_STALL_SECONDS = 12;
const MAX_PROACTIVE_PER_SESSION = 2;
/** Her welcome lands five seconds after the session's first marketing
 *  page view. The moment and its spending live in sessionStorage, so
 *  moving between marketing pages neither restarts the clock nor fires
 *  the greeting twice. */
const WELCOME_DELAY_MS = 5000;
const WELCOME_START_KEY = 'lyla-welcome-started-at';
const WELCOME_DONE_KEY = 'lyla-welcome-done';
/** She is not sitting in the corner when a session starts: the pill
 *  only settles in once her first proactive card has resolved (or a
 *  panel visit has ended). Once settled, this sessionStorage flag
 *  keeps her present from load on the session's later pages; a new
 *  session starts hidden again. */
const REVEALED_KEY = 'lyla-revealed';

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
  /** Whether she has introduced herself this session. False at a
   *  session's first load (nothing of her is on screen until her
   *  first card arrives); the mount effect below restores it from
   *  sessionStorage on later pages of the session. */
  const [revealed, setRevealed] = useState(false);
  /** True while one of her guided page moves is running. */
  const [guiding, setGuiding] = useState(false);
  /** The panel's mount machine: it stays mounted for the length of its
   *  close transition, shown once the opening frame has painted. */
  const [panelMounted, setPanelMounted] = useState(false);
  const [panelShown, setPanelShown] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  /** The page's latest unreported action outcome; rides exactly one
   *  chat or proactive call, then is spent. */
  const pageReportRef = useRef<PageReport | null>(null);
  const greetingRef = useRef<string>(LYLA_PERSONA.greeting);
  const turnstileTokenRef = useRef<string | null>(null);
  const turnstileTokenAtRef = useRef<number>(0);
  const turnstileResetRef = useRef<(() => void) | null>(null);
  const behaviorRef = useRef<BehaviorState>(freshBehavior());
  const proactiveFiredRef = useRef<Set<ProactiveTrigger>>(new Set());
  const proactiveUsedRef = useRef(0);
  const proactiveDismissalsRef = useRef(0);
  const proactiveMutedRef = useRef(false);
  const proactiveBusyRef = useRef(false);
  /** Mirror of the proactive card on screen, for the welcome timer,
   *  which fires outside the scheduler's render scope. */
  const proactiveNoteRef = useRef<{ trigger: ProactiveTrigger; line: string } | null>(null);
  /** The welcome has had its one moment on this mount (fired, cancelled,
   *  or skipped); the cross-page guard lives in sessionStorage. */
  const welcomeDoneRef = useRef(false);
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
  proactiveNoteRef.current = proactiveNote;

  /* Her arrival: she starts off screen and settles into the corner
     only once she has introduced herself, when her first proactive
     card resolves or a panel visit ends. The settled state is kept in
     sessionStorage, so later pages of the session show the pill from
     load (fading in on the mount effect below) while a new session
     starts hidden again. */
  const settleRevealed = useCallback(() => {
    setRevealed(true);
    try {
      window.sessionStorage.setItem(REVEALED_KEY, '1');
    } catch {
      /* Storage unavailable: she still settles for this page view. */
    }
  }, []);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(REVEALED_KEY)) setRevealed(true);
    } catch {
      /* Storage unavailable: this page view starts unrevealed. */
    }
  }, []);

  /* Panel mount machine: mount first, paint the closed state, then
     transition in; on close, transition out and unmount only once the
     panel has settled away. The durations match .lyla-panel. */
  useEffect(() => {
    if (open) {
      setPanelMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setPanelShown(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setPanelShown(false);
    const timer = window.setTimeout(() => setPanelMounted(false), 300);
    return () => window.clearTimeout(timer);
  }, [open ]);

  /* Nothing she starts outlives the widget: a guided move in flight
     and a pending demo-status listener are both ended on unmount. */
  useEffect(() => {
    return () => {
      cancelActiveGuide();
      pendingDemoStatusCleanup?.();
    };
  }, []);

  /* ------------------------- session lifecycle ------------------------ */

  // Turnstile tokens expire about five minutes after they are solved, and
  // the challenge renders on page load, so a visitor who browses first
  // reaches the panel holding a dead token. Never fire a session start
  // without a fresh one: reset the challenge and wait for the solve.
  const waitForFreshToken = useCallback(async (timeoutMs: number): Promise<void> => {
    if (!TURNSTILE_SITE_KEY) return;
    const fresh = () =>
      turnstileTokenRef.current !== null && Date.now() - turnstileTokenAtRef.current < 240_000;
    if (fresh()) return;
    turnstileTokenRef.current = null;
    turnstileTokenAtRef.current = 0;
    turnstileResetRef.current?.();
    const deadline = Date.now() + timeoutMs;
    while (!fresh() && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }, []);

  const startSession = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    setSessionPhase((phase) => (phase === 'ready' ? phase : 'starting'));
    await waitForFreshToken(6000);
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
      turnstileTokenAtRef.current = 0;
      turnstileResetRef.current?.();
    }
  }, [waitForFreshToken]);

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
        const reportSnapshot = pageReportRef.current;
        const res = await fetch(`${API_URL}/api/public/proactive`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            trigger,
            visitorState: buildVisitorState(behaviorRef.current),
            pageReport: reportSnapshot ?? undefined,
            referrer: document.referrer || undefined,
            localTime: new Date().toLocaleString(),
          }),
        });
        // The report went out on this call; it is spent, like on a chat
        // turn. A newer report is never eaten.
        if (pageReportRef.current === reportSnapshot) pageReportRef.current = null;
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
    // The card has resolved: if it was her first, she now settles
    // into the corner as the session's resting entry point.
    settleRevealed();
  }, [settleRevealed]);

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

  /* ------------------------------ welcome ----------------------------- */
  /* Five seconds after the session's first marketing page view, she
   * greets the room once. The greeting is a local line, never an API
   * call: the public agent's trigger list has no welcome, and a hello
   * must not burn a chat session (or a Turnstile solve) on every visit.
   * At its moment it obeys the same manners as every proactive line:
   * panel closed, not muted, budget left, no proactive request already
   * in flight, and no other proactive card already up. It spends one of
   * the session's two proactive slots like any other trigger, and the
   * moment is spent even when she stays quiet. */

  const markWelcomeDone = useCallback(() => {
    welcomeDoneRef.current = true;
    try {
      window.sessionStorage.setItem(WELCOME_DONE_KEY, '1');
    } catch {
      /* Storage unavailable: the ref still guards this page view. */
    }
  }, []);

  // Opening the panel before her moment cancels the welcome for the
  // session: a visitor who already found her needs no greeting.
  useEffect(() => {
    if (open) markWelcomeDone();
  }, [open, markWelcomeDone]);

  // A card clicked through resolves when its panel visit ends, and a
  // panel somehow opened before any card (there is no visible entry
  // point then) settles her the same way: either way, closing the
  // panel leaves the pill in the corner.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !open) settleRevealed();
    wasOpenRef.current = open;
  }, [open, settleRevealed]);

  useEffect(() => {
    if (welcomeDoneRef.current) return;
    let startedAt = Date.now();
    try {
      if (window.sessionStorage.getItem(WELCOME_DONE_KEY)) {
        welcomeDoneRef.current = true;
        return;
      }
      const stored = Number(window.sessionStorage.getItem(WELCOME_START_KEY));
      if (Number.isFinite(stored) && stored > 0) {
        startedAt = stored;
      } else {
        window.sessionStorage.setItem(WELCOME_START_KEY, String(startedAt));
      }
    } catch {
      /* Storage unavailable: this page view's clock stands alone. */
    }
    const timer = window.setTimeout(
      () => {
        markWelcomeDone();
        if (openRef.current || proactiveMutedRef.current || proactiveBusyRef.current) return;
        if (proactiveUsedRef.current >= MAX_PROACTIVE_PER_SESSION) return;
        if (proactiveNoteRef.current) return;
        if (proactiveFiredRef.current.has('welcome')) return;
        proactiveFiredRef.current.add('welcome');
        proactiveUsedRef.current += 1;
        setProactiveNote({ trigger: 'welcome', line: WELCOME_MESSAGE });
      },
      Math.max(0, startedAt + WELCOME_DELAY_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [markWelcomeDone]);

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
        window.setTimeout(
          () =>
            executeLylaActions(result.actions, {
              // Her panel steps aside for a demo submit, and the form's
              // own outcome is kept for her next turn.
              onStartDemo: () => setOpen(false),
              onDemoStatus: (report) => {
                pageReportRef.current = report;
              },
              onGuidingChange: (next) => setGuiding(next),
            }),
          60,
        );
      }
    },
    [stopReveal],
  );

  const chatRequestBody = useCallback(
    (sessionId: string, history: ChatMessage[]) => ({
      sessionId,
      messages: history.slice(-20),
      visitorState: buildVisitorState(behaviorRef.current),
      // Read, not consumed: sendText spends the report only once the
      // turn has actually gone out, so the stream-to-plain fallback
      // carries the same body.
      pageReport: pageReportRef.current ?? undefined,
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
      const reportSnapshot = pageReportRef.current;
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
        // The page report rode this turn, whichever path it took; it is
        // spent now. A newer report (a different object) is never eaten.
        if (pageReportRef.current === reportSnapshot) pageReportRef.current = null;
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

  /** The corner holds exactly one chat element at a time: while a
   *  proactive card is up, or the panel is open, the pill hands off.
   *  Before she has introduced herself this session it hands off the
   *  same way, so nothing of her sits in the corner at first load;
   *  when she settles, the same hand-off transition fades it back in. */
  const pillHandedOff = open || proactiveNote !== null || !revealed;

  return (
    <>
      {/* Proactive card, Messenger style: her picture, her name and
          title, and the message in full, the way a chat preview lands.
          The card itself is the tap target and opens the panel; the ✕
          dismisses without opening. It arrives with the .lyla-bubble-in
          slide-and-fade, and it never outgrows the viewport. While it
          is up, the pill below hands the corner off to it. */}
      {proactiveNote && !open && (
        <div className="lyla-bubble-in fixed bottom-24 right-3 z-[60] w-[min(320px,calc(100vw-24px))] rounded-2xl border border-line bg-white p-3.5 shadow-lift sm:right-6">
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={openFromProactive}
              aria-label={`Chat with ${LYLA_PERSONA.name}: ${proactiveNote.line}`}
              className="flex min-w-0 flex-1 items-start gap-3 text-left"
            >
              <LylaAvatar sizeClass="h-10 w-10 text-sm" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-tight text-ink">
                  {LYLA_PERSONA.name}
                </span>
                <span className="block text-[11px] leading-tight text-ink-muted">{LYLA_PERSONA.role}</span>
                <span className="mt-1 block break-words text-[13.5px] leading-snug text-ink">
                  {proactiveNote.line}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={dismissProactive}
              aria-label="Dismiss"
              className="shrink-0 rounded-full px-1 text-ink-muted transition-colors hover:text-ink"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Minimized pill: her face and name, quiet until tapped. It stays
          mounted and hands the corner off through .lyla-pill: before
          she has arrived this session, while a proactive card is up,
          or while the panel is open, it fades and slides away (and is
          neither clickable nor focusable), so the page loads clean and
          the corner never shows two chat elements at once. Once she
          has introduced herself it settles in and stays. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-handed-off={pillHandedOff}
        tabIndex={pillHandedOff ? -1 : undefined}
        className="lyla-pill fixed bottom-5 right-4 z-40 flex items-center gap-3 rounded-full border border-line bg-white py-2 pl-2 pr-4 shadow-lift sm:right-6"
        aria-label={`Chat with ${LYLA_PERSONA.name}, ${LYLA_PERSONA.role}`}
      >
        <span className={`relative ${guiding || sending || proactiveNote ? 'lyla-avatar-ring' : ''}`}>
          <span className="lyla-avatar-float block">
            <LylaAvatar sizeClass="h-10 w-10 text-sm" />
          </span>
          <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-teal-500 ring-2 ring-white" />
        </span>
        <span className="text-left">
          <span className="block text-[13.5px] font-semibold leading-tight text-ink">{LYLA_PERSONA.name}</span>
          <span className="block text-[11.5px] leading-tight text-ink-muted">
            {guiding ? 'Showing you around…' : LYLA_PERSONA.role}
          </span>
        </span>
      </button>

      {/* Chat panel: breathes in and out on .lyla-panel rather than
          snapping; it stays mounted until the close has settled. Its
          geometry is sized against the viewport itself, never past it:
          at most 400px wide and 24px short of the full viewport width,
          at most 24px short of the full viewport height, with a margin
          on every side at every size and zoom, so no edge of it can
          ever leave the screen. Inside, the header and the composer
          never shrink and the message list takes what is left and
          scrolls on its own. */}
      {panelMounted && (
        <div
          data-shown={panelShown}
          className="lyla-panel fixed bottom-3 right-3 z-[60] flex h-[min(560px,calc(100dvh-24px))] w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-lift sm:bottom-5 sm:right-6"
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
            <span className={guiding || sending ? 'lyla-avatar-ring' : undefined}>
              <LylaAvatar sizeClass="h-10 w-10 text-sm" />
            </span>
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
              turnstileTokenAtRef.current = token ? Date.now() : 0;
            }}
            resetRef={turnstileResetRef}
            visible={sessionPhase === 'starting'}
          />

          <div ref={scrollBoxRef} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-4">
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
                        ? 'lyla-msg max-w-[85%] self-end rounded-2xl rounded-br-md bg-ink px-3.5 py-2.5 text-[13.5px] leading-relaxed text-white'
                        : 'lyla-msg max-w-[85%] self-start rounded-2xl rounded-bl-md bg-paper px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink'
                    }
                  >
                    {message.text}
                  </div>
                ))}
                {sessionPhase === 'starting' && messages.length === 0 && <LylaTyping label="Saying hello" />}
                {streamStatus && <LylaTyping label={streamStatus} />}
                {streamText && (
                  <div className="lyla-msg max-w-[85%] self-start rounded-2xl rounded-bl-md bg-paper px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink">
                    {streamText}
                  </div>
                )}
                {sending && !streamStatus && !streamText && <LylaTyping />}
              </>
            )}
          </div>

          <form
            className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-3"
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
          proactive-triggered session start can find a token. Keyed on
          panelMounted rather than open, so it never coexists with the
          panel's own challenge during the close transition. */}
      {!panelMounted && (
        <LylaTurnstile
          onToken={(token) => {
            turnstileTokenRef.current = token;
            turnstileTokenAtRef.current = token ? Date.now() : 0;
          }}
          resetRef={turnstileResetRef}
          visible={false}
        />
      )}
    </>
  );
}
