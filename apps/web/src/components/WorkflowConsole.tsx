'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Waveform } from '@/components/ui/Waveform';

/**
 * The landing-page centerpiece: a self-driving "watch a call work" console.
 *
 * It narrates a real call end-to-end — a streaming transcript on the left, and
 * on the right a live calendar that refuses to double-book plus a call summary
 * that fills in field by field and resolves to an explicit OUTCOME (booked,
 * callback requested, or question answered). It cycles three scenarios so a
 * visitor sees the breadth — new caller, returning customer, quick question —
 * without touching a thing. No audio; the real voice test lives in the demo.
 *
 * Everything is a tiny state machine driven by per-scenario step lists. Timers
 * are tracked in a ref and torn down on scenario change / unmount, and the run
 * only starts once the console scrolls into view.
 */

/* --------------------------------- types --------------------------------- */

type Speaker = 'agent' | 'caller';
type Outcome = 'booked' | 'callback' | 'answered';
type SlotStatus = 'open' | 'busy' | 'selected' | 'booked' | 'callback';

interface Summary {
  business?: string;
  caller?: string;
  kind?: 'New' | 'Returning';
  phone?: string;
  intent?: string;
}

interface Slot {
  time: string;
  label: string;
}

type Step =
  | { wait?: number; status: string }
  | { wait?: number; speaking: Speaker | null }
  | { wait?: number; line: { who: Speaker; text: string } }
  | { wait?: number; summary: Summary }
  | { wait?: number; slot: { time: string; status: SlotStatus; chip?: string } }
  | { wait?: number; outcome: { value: Outcome; detail: string } };

interface Scenario {
  id: string;
  tab: string;
  icon: 'new' | 'return' | 'ask';
  initialStatus: string;
  busy: string[]; // pre-blocked slot times
  steps: Step[];
}

/* The shared day rail — same times across scenarios, only statuses change. */
const SLOTS: Slot[] = [
  { time: '09:30', label: '9:30 AM' },
  { time: '11:00', label: '11:00 AM' },
  { time: '13:00', label: '1:00 PM' },
  { time: '14:30', label: '2:30 PM' },
  { time: '15:30', label: '3:30 PM' },
  { time: '16:30', label: '4:30 PM' },
];

/* ------------------------------- scenarios ------------------------------- */

const SCENARIOS: Scenario[] = [
  {
    id: 'new-booking',
    tab: 'New patient',
    icon: 'new',
    initialStatus: 'Incoming call · Riverside Dental',
    busy: ['11:00'],
    steps: [
      { speaking: 'agent', wait: 500 },
      { line: { who: 'agent', text: 'Thanks for calling Riverside Dental — this is Ava. How can I help?' }, wait: 1300 },
      { summary: { business: 'Riverside Dental' }, wait: 200 },
      { speaking: 'caller', wait: 700 },
      { line: { who: 'caller', text: "Hi, I'd like to book a cleaning. I'm a new patient." }, wait: 1500 },
      { summary: { kind: 'New', intent: 'Book a cleaning' }, wait: 200 },
      { speaking: 'agent', wait: 700 },
      { line: { who: 'agent', text: 'Welcome! Can I grab your name and a good number?' }, wait: 1400 },
      { speaking: 'caller', wait: 700 },
      { line: { who: 'caller', text: "Daniel Brooks — six oh four, five five five, oh one four eight." }, wait: 1600 },
      { summary: { caller: 'Daniel Brooks', phone: '(604) 555-0148' }, wait: 300 },
      { speaking: 'agent', wait: 700 },
      { line: { who: 'agent', text: 'Let me check the calendar…' }, wait: 1100 },
      { slot: { time: '11:00', status: 'busy' }, wait: 500 },
      { line: { who: 'agent', text: '11 is taken, but I have 2:30 PM open — does that work?' }, wait: 1500 },
      { slot: { time: '14:30', status: 'selected' }, wait: 200 },
      { speaking: 'caller', wait: 700 },
      { line: { who: 'caller', text: '2:30 is perfect.' }, wait: 1200 },
      { speaking: 'agent', wait: 600 },
      { slot: { time: '14:30', status: 'booked', chip: 'Daniel B.' }, wait: 400 },
      { line: { who: 'agent', text: "You're booked for Tuesday at 2:30. I'll text a confirmation." }, wait: 1400 },
      { outcome: { value: 'booked', detail: 'Tue · 2:30 PM · New-patient cleaning' }, wait: 300 },
      { speaking: null, status: 'Call complete · 0:48', wait: 200 },
    ],
  },
  {
    id: 'returning-callback',
    tab: 'Returning · callback',
    icon: 'return',
    initialStatus: 'Incoming call · Summit Plumbing',
    busy: ['11:00'],
    steps: [
      { speaking: 'agent', wait: 500 },
      { line: { who: 'agent', text: 'Summit Plumbing, this is Ava speaking.' }, wait: 1200 },
      { summary: { business: 'Summit Plumbing' }, wait: 200 },
      { speaking: 'caller', wait: 700 },
      { line: { who: 'caller', text: "Hi, it's Maria Lopez — I'm a current customer. Quick question on my quote." }, wait: 1800 },
      { summary: { caller: 'Maria Lopez', kind: 'Returning', intent: 'Question about her quote' }, wait: 300 },
      { speaking: 'agent', wait: 700 },
      { line: { who: 'agent', text: 'Good to hear from you, Maria. Our estimator can walk you through it — want a callback?' }, wait: 1700 },
      { speaking: 'caller', wait: 700 },
      { line: { who: 'caller', text: 'Yes please — sometime tomorrow morning works.' }, wait: 1400 },
      { summary: { phone: 'On file · ending 0132' }, wait: 300 },
      { speaking: 'agent', wait: 700 },
      { slot: { time: '09:30', status: 'callback', chip: 'Maria L.' }, wait: 400 },
      { line: { who: 'agent', text: "Done — I've put you down for a callback tomorrow at 9:30 AM." }, wait: 1500 },
      { outcome: { value: 'callback', detail: 'Tomorrow · 9:30 AM · Estimator callback' }, wait: 300 },
      { speaking: null, status: 'Call complete · 0:39', wait: 200 },
    ],
  },
  {
    id: 'question',
    tab: 'Quick question',
    icon: 'ask',
    initialStatus: 'Incoming call · Bright Smile Dental',
    busy: ['11:00'],
    steps: [
      { speaking: 'agent', wait: 500 },
      { line: { who: 'agent', text: 'Bright Smile Dental, this is Ava — how can I help?' }, wait: 1300 },
      { summary: { business: 'Bright Smile Dental' }, wait: 200 },
      { speaking: 'caller', wait: 700 },
      { line: { who: 'caller', text: 'Do you take Pacific Blue insurance, and are you open Saturdays?' }, wait: 1800 },
      { summary: { caller: 'Caller', kind: undefined, intent: 'Insurance + Saturday hours' }, wait: 300 },
      { speaking: 'agent', wait: 800 },
      { line: { who: 'agent', text: "Yes — we accept Pacific Blue, and we're open Saturdays 9 to 1." }, wait: 1700 },
      { speaking: 'caller', wait: 700 },
      { line: { who: 'caller', text: 'Perfect, thank you!' }, wait: 1100 },
      { speaking: 'agent', wait: 600 },
      { line: { who: 'agent', text: 'Anytime — call back whenever you’d like to book.' }, wait: 1400 },
      { outcome: { value: 'answered', detail: 'Insurance confirmed · Saturday hours given' }, wait: 300 },
      { speaking: null, status: 'Call complete · 0:31', wait: 200 },
    ],
  },
];

/* -------------------------------- helpers -------------------------------- */

const OUTCOME_META: Record<Outcome, { label: string; cls: string; dot: string }> = {
  booked: {
    label: 'Appointment booked',
    cls: 'bg-clinic-soft text-signal-deep ring-clinic/30',
    dot: 'bg-clinic',
  },
  callback: {
    label: 'Callback scheduled',
    cls: 'bg-[#FBF1DD] text-[#8A5A12] ring-[#E4C98A]/50',
    dot: 'bg-[#C68A2E]',
  },
  answered: {
    label: 'Question answered',
    cls: 'bg-surface text-ink ring-line',
    dot: 'bg-ink-muted',
  },
};

function initials(name?: string): string {
  if (!name || name === 'Caller') return '?';
  return name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/* ------------------------------- component ------------------------------- */

export function WorkflowConsole() {
  const [active, setActive] = useState(0);
  const [lines, setLines] = useState<{ who: Speaker; text: string }[]>([]);
  const [summary, setSummary] = useState<Summary>({});
  const [slots, setSlots] = useState<Record<string, { status: SlotStatus; chip?: string }>>({});
  const [speaking, setSpeaking] = useState<Speaker | null>(null);
  const [typing, setTyping] = useState(false);
  const [status, setStatus] = useState('');
  const [outcome, setOutcome] = useState<{ value: Outcome; detail: string } | null>(null);
  const [progress, setProgress] = useState(0);
  const [inView, setInView] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Start once scrolled into view (kept on thereafter).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Run the active scenario.
  useEffect(() => {
    if (!inView) return;
    const scenario = SCENARIOS[active];

    // reset
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setLines([]);
    setSummary({});
    setSpeaking(null);
    setTyping(false);
    setOutcome(null);
    setStatus(scenario.initialStatus);
    setSlots(Object.fromEntries(scenario.busy.map((t) => [t, { status: 'busy' as SlotStatus }])));

    // drive the progress bar across the scenario's length
    const total = scenario.steps.reduce((sum, s) => sum + (s.wait ?? 700), 0) + 1600;
    setProgress(0);
    timers.current.push(setTimeout(() => setProgress(100), 60));

    let elapsed = 0;
    scenario.steps.forEach((step) => {
      elapsed += step.wait ?? 700;
      timers.current.push(
        setTimeout(() => {
          if ('status' in step) setStatus(step.status);
          if ('speaking' in step) {
            setSpeaking(step.speaking);
            setTyping(step.speaking === 'agent');
          }
          if ('line' in step) {
            setTyping(false);
            setLines((prev) => [...prev, step.line]);
          }
          if ('summary' in step) setSummary((prev) => ({ ...prev, ...step.summary }));
          if ('slot' in step)
            setSlots((prev) => ({ ...prev, [step.slot.time]: { status: step.slot.status, chip: step.slot.chip } }));
          if ('outcome' in step) setOutcome(step.outcome);
        }, elapsed),
      );
    });

    // advance to the next scenario after a hold
    timers.current.push(
      setTimeout(() => setActive((a) => (a + 1) % SCENARIOS.length), total),
    );

    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [active, inView]);

  // keep the transcript pinned to the latest line
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [lines, typing]);

  return (
    <div ref={rootRef} className="mx-auto max-w-5xl">
      {/* scenario switcher */}
      <div className="mb-5 flex flex-wrap items-center justify-center gap-2">
        {SCENARIOS.map((s, i) => {
          const on = i === active;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setActive(i)}
              className={`group relative overflow-hidden rounded-full border px-4 py-2 text-[13px] font-semibold transition-all duration-300 ease-smooth ${
                on
                  ? 'border-signal/30 bg-white text-ink shadow-card'
                  : 'border-line bg-white/50 text-ink-muted hover:border-signal/30 hover:text-ink'
              }`}
            >
              <span className="relative z-10 flex items-center gap-2">
                <ScenarioIcon icon={s.icon} on={on} />
                {s.tab}
              </span>
              {on && (
                <span
                  className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-signal"
                  style={{ transform: `scaleX(${progress / 100})`, transition: 'transform 12s linear' }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* the console */}
      <div className="overflow-hidden rounded-[28px] border border-line/70 bg-white shadow-lift">
        {/* title bar */}
        <div className="flex items-center justify-between border-b border-line/60 bg-paper/60 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-2 w-2">
              <span className="absolute h-2 w-2 animate-pulse-ring rounded-full bg-clinic" />
              <span className="h-2 w-2 rounded-full bg-clinic" />
            </span>
            <span className="text-[13px] font-semibold text-ink">{status}</span>
          </div>
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted/70">
            VoiceFront
          </div>
        </div>

        <div className="grid lg:grid-cols-[1.05fr_0.95fr]">
          {/* -------- left: live call + transcript -------- */}
          <div className="flex flex-col border-b border-line/60 lg:border-b-0 lg:border-r">
            {/* speaker bar */}
            <div className="flex items-center gap-3 px-5 py-3.5">
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-bold transition-colors ${
                  speaking === 'agent'
                    ? 'bg-signal text-white'
                    : speaking === 'caller'
                      ? 'bg-ink text-white'
                      : 'bg-paper text-ink-muted'
                }`}
              >
                {speaking === 'agent' ? 'AI' : speaking === 'caller' ? '☎' : '·'}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-ink">
                  {speaking === 'agent' ? 'Ava · AI receptionist' : speaking === 'caller' ? 'Caller' : 'Listening…'}
                </p>
                <p className="text-[11px] text-ink-muted">
                  {speaking === 'agent' ? 'speaking' : speaking === 'caller' ? 'speaking' : 'on the line'}
                </p>
              </div>
              <Waveform
                bars={14}
                active={speaking !== null}
                tone={speaking === 'caller' ? 'muted' : 'signal'}
                className="h-7 w-24 justify-center"
              />
            </div>

            {/* transcript */}
            <div
              ref={transcriptRef}
              className="h-[300px] space-y-3 overflow-y-auto px-5 pb-5 pt-1 [scrollbar-width:thin]"
            >
              {lines.map((l, i) => (
                <div
                  key={i}
                  className={`flex animate-fade-up ${l.who === 'agent' ? 'justify-start' : 'justify-end'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed ${
                      l.who === 'agent'
                        ? 'rounded-tl-sm bg-signal-soft/60 text-ink'
                        : 'rounded-tr-sm bg-ink text-white'
                    }`}
                  >
                    {l.text}
                  </div>
                </div>
              ))}
              {typing && (
                <div className="flex animate-fade-up justify-start">
                  <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm bg-signal-soft/60 px-3.5 py-3">
                    {[0, 1, 2].map((d) => (
                      <span
                        key={d}
                        className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-deep/60"
                        style={{ animationDelay: `${d * 0.18}s` }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* -------- right: calendar + summary -------- */}
          <div className="flex flex-col">
            {/* calendar */}
            <div className="border-b border-line/60 px-5 py-4">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-signal-deep">
                  Your calendar
                </p>
                <span className="text-[11px] font-medium text-ink-muted">Tuesday</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-1.5">
                {SLOTS.map((slot) => (
                  <CalendarSlot key={slot.time} slot={slot} state={slots[slot.time]} />
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] font-medium text-ink-muted">
                <Guard icon="sync" text="Calendar synced" />
                <Guard icon="block" text="Busy times blocked" />
                <Guard icon="shield" text="Never double-booked" />
              </div>
            </div>

            {/* summary */}
            <div className="flex flex-1 flex-col px-5 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-signal-deep">Call summary</p>
              <div className="mt-3 space-y-2.5">
                <SummaryRow label="Caller">
                  {summary.caller ? (
                    <span className="flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-signal-soft text-[9px] font-bold text-signal-deep">
                        {initials(summary.caller)}
                      </span>
                      <span className="font-semibold text-ink">{summary.caller}</span>
                      {summary.kind && (
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                            summary.kind === 'Returning'
                              ? 'bg-[#FBF1DD] text-[#8A5A12]'
                              : 'bg-signal-soft text-signal-deep'
                          }`}
                        >
                          {summary.kind}
                        </span>
                      )}
                    </span>
                  ) : null}
                </SummaryRow>
                <SummaryRow label="Business">{summary.business}</SummaryRow>
                <SummaryRow label="Phone">{summary.phone}</SummaryRow>
                <SummaryRow label="Intent">{summary.intent}</SummaryRow>
              </div>

              {/* outcome */}
              <div className="mt-auto pt-4">
                {outcome ? (
                  <div className={`animate-pop-in rounded-2xl px-4 py-3 ring-1 ${OUTCOME_META[outcome.value].cls}`}>
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${OUTCOME_META[outcome.value].dot}`} />
                      <span className="text-[13px] font-bold">{OUTCOME_META[outcome.value].label}</span>
                    </div>
                    <p className="mt-1 text-[12px] font-medium opacity-80">{outcome.detail}</p>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-line px-4 py-3">
                    <p className="text-[12px] text-ink-muted/70">Outcome resolves as the call ends…</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <p className="mt-4 text-center text-[12.5px] text-ink-muted">
        A visual walkthrough — your real receptionist runs the same way.{' '}
        <span className="hidden sm:inline">The interactive voice test is in the demo above.</span>
      </p>
    </div>
  );
}

/* ----------------------------- sub-components ----------------------------- */

function SummaryRow({ label, children }: { label: string; children?: ReactNode }) {
  const filled = children !== undefined && children !== null && children !== '';
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-[12px] font-medium text-ink-muted">{label}</span>
      {filled ? (
        <span className="animate-fade-up text-right text-[13px] text-ink">{children}</span>
      ) : (
        <span className="text-[13px] text-ink-muted/30">—</span>
      )}
    </div>
  );
}

function CalendarSlot({ slot, state }: { slot: Slot; state?: { status: SlotStatus; chip?: string } }) {
  const status = state?.status ?? 'open';

  const base =
    'relative flex items-center justify-between rounded-lg px-2.5 py-2 text-[11.5px] transition-all duration-300';
  if (status === 'busy') {
    return (
      <div className={`${base} border border-line bg-surface/80 text-ink-muted/60`}>
        <span className="font-medium line-through decoration-ink-muted/30">{slot.label}</span>
        <span className="flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wide">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" strokeLinecap="round" />
          </svg>
          Busy
        </span>
      </div>
    );
  }
  if (status === 'selected') {
    return (
      <div className={`${base} border border-signal bg-signal-soft/70 text-signal-deep ring-2 ring-signal/30`}>
        <span className="font-semibold">{slot.label}</span>
        <span className="text-[9.5px] font-semibold uppercase tracking-wide">Holding…</span>
      </div>
    );
  }
  if (status === 'booked') {
    return (
      <div className={`${base} animate-flash-green border border-clinic bg-clinic-soft text-signal-deep`}>
        <span className="flex items-center gap-1.5 font-semibold">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3.5 w-3.5">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {slot.label}
        </span>
        {state?.chip && (
          <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[9.5px] font-bold">{state.chip}</span>
        )}
      </div>
    );
  }
  if (status === 'callback') {
    return (
      <div className={`${base} animate-flash-green border border-[#E4C98A] bg-[#FBF1DD] text-[#8A5A12]`}>
        <span className="flex items-center gap-1.5 font-semibold">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
            <path
              d="M5 4h3l2 5-2 1a11 11 0 0 0 5 5l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"
              strokeLinejoin="round"
            />
          </svg>
          {slot.label}
        </span>
        {state?.chip && (
          <span className="rounded-full bg-white/60 px-1.5 py-0.5 text-[9.5px] font-bold">Callback</span>
        )}
      </div>
    );
  }
  return (
    <div className={`${base} border border-line bg-white text-ink hover:border-signal/30`}>
      <span className="font-medium">{slot.label}</span>
      <span className="text-[9.5px] font-medium text-ink-muted/50">Open</span>
    </div>
  );
}

function Guard({ icon, text }: { icon: 'sync' | 'block' | 'shield'; text: string }) {
  const paths: Record<'sync' | 'block' | 'shield', ReactNode> = {
    sync: <path d="M4 9a8 8 0 0 1 14-3l2 2M20 15a8 8 0 0 1-14 3l-2-2M18 4v4h-4M6 20v-4h4" strokeLinecap="round" strokeLinejoin="round" />,
    block: <><circle cx="12" cy="12" r="9" /><path d="M6 6l12 12" strokeLinecap="round" /></>,
    shield: <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" strokeLinejoin="round" />,
  };
  return (
    <span className="flex items-center gap-1">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3 text-signal">
        {paths[icon]}
      </svg>
      {text}
    </span>
  );
}

function ScenarioIcon({ icon, on }: { icon: 'new' | 'return' | 'ask'; on: boolean }) {
  const cls = `h-3.5 w-3.5 ${on ? 'text-signal' : 'text-ink-muted/60'}`;
  if (icon === 'new')
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cls}>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M3 20a6 6 0 0 1 12 0M18 8v6M21 11h-6" strokeLinecap="round" />
      </svg>
    );
  if (icon === 'return')
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cls}>
        <path d="M4 4v6h6M20 20v-6h-6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5 10a8 8 0 0 1 14-2M19 14a8 8 0 0 1-14 2" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cls}>
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.9.4-1.5 1-1.5 2.2M12 17h.01" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
