'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { Logo } from '@/components/ui/Logo';
import { Spinner } from '@/components/ui/Spinner';
import {
  DemoApi,
  ApiError,
  type DemoAppointment,
  type DemoDay,
  type DemoLeadResponse,
  type DemoIndustry,
  type DemoCallSummary,
} from '@/lib/api';
import { VoiceSession, type SimulatorPhase, type TranscriptEntry } from '@/lib/voice-client';
import { BookCallSection } from '@/components/BookCallSection';
import { ROICalculator } from '@/components/ROICalculator';
import { WaveBackground } from '@/components/WaveBackground';
import { WorkflowConsole } from '@/components/WorkflowConsole';

/* ------------------------------ scroll reveal ----------------------------- */

function Reveal({
  children,
  className = '',
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          obs.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`transition-all duration-700 ease-out ${
        shown ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'
      } ${className}`}
    >
      {children}
    </div>
  );
}

/* ----------------------------- call simulation ---------------------------- */

interface ScriptLine {
  role: 'agent' | 'caller';
  text: string;
}

/**
 * Looping timeline: step 0 = ringing, steps 1..n reveal transcript lines,
 * step n+1 = booked confirmation, then the loop restarts.
 */
function useCallLoop(lineCount: number) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const duration = step === 0 ? 1800 : step <= lineCount ? 1800 : 4200;
    const t = setTimeout(() => setStep((s) => (s > lineCount ? 0 : s + 1)), duration);
    return () => clearTimeout(t);
  }, [step, lineCount]);
  return {
    ringing: step === 0,
    visibleLines: Math.min(step, lineCount),
    booked: step > lineCount,
  };
}

const WAVE_HEIGHTS = [0.55, 0.95, 0.7, 1, 0.6];

function Waveform({ bars = 5, light = false }: { bars?: number; light?: boolean }) {
  return (
    <span className="flex h-4 items-center gap-[3px]" aria-hidden>
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className={`h-full w-[3px] origin-center animate-wave-bar rounded-full ${light ? 'bg-white' : 'bg-signal'}`}
          style={{
            animationDelay: `${i * 0.12}s`,
            ['--wave-max' as string]: WAVE_HEIGHTS[i % WAVE_HEIGHTS.length],
          }}
        />
      ))}
    </span>
  );
}

const HERO_SCRIPT: ScriptLine[] = [
  { role: 'agent', text: 'Good morning, Northside Family Clinic — how can I help?' },
  { role: 'caller', text: 'Hi, I need a checkup for tomorrow if possible.' },
  { role: 'agent', text: 'Sure. Tomorrow I have 9:30, 11:00 or 2:00 — what works best?' },
  { role: 'caller', text: '11 works great. It’s Sarah Mitchell.' },
  { role: 'agent', text: 'Done, Sarah — you’re booked for 11:00 AM tomorrow.' },
];

function CallCard() {
  const { ringing, visibleLines, booked } = useCallLoop(HERO_SCRIPT.length);
  return (
    <div className="relative w-full max-w-[420px] animate-float">
      {/* glow */}
      <div
        aria-hidden
        className="absolute -inset-8 rounded-[40px] bg-[radial-gradient(50%_50%_at_50%_50%,rgba(14,107,99,0.14),transparent_70%)]"
      />
      <div className="relative overflow-hidden rounded-3xl border border-line/70 bg-white shadow-lift ring-1 ring-ink/5">
        {/* header */}
        <div className="flex items-center justify-between border-b border-line/60 bg-paper/70 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-signal to-signal-deep text-sm font-semibold text-white shadow-pop">
              {ringing && (
                <span className="absolute inset-0 animate-pulse-ring rounded-full bg-signal/60" aria-hidden />
              )}
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[18px] w-[18px]">
                <path
                  d="M4 3.5h3l1.5 4-2 1.5a11 11 0 0 0 4.5 4.5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5C8.3 16.9 3.1 11.7 2.5 5.1A1.5 1.5 0 0 1 4 3.5Z"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <div>
              <p className="text-[13px] font-semibold text-ink">+1 (555) 012-8841</p>
              <p className="text-xs text-ink-muted">{ringing ? 'Incoming call…' : 'Connected · 00:12'}</p>
            </div>
          </div>
          {ringing ? (
            <span className="rounded-full bg-construction-soft px-2.5 py-1 text-[11px] font-semibold text-[#9a6a1d]">
              Ringing
            </span>
          ) : (
            <span className="flex items-center gap-2 rounded-full bg-clinic-soft/80 px-2.5 py-1 text-[11px] font-semibold text-[#0b8a74]">
              <Waveform bars={4} />
              Live
            </span>
          )}
        </div>

        {/* transcript */}
        <div className="flex min-h-[270px] flex-col gap-2.5 px-5 py-5">
          {HERO_SCRIPT.slice(0, visibleLines).map((line, i) => (
            <div
              key={i}
              className={`max-w-[85%] animate-pop-in rounded-2xl px-3.5 py-2 text-[13px] leading-snug ${
                line.role === 'agent'
                  ? 'self-start rounded-bl-md bg-signal-soft/70 text-ink ring-1 ring-inset ring-signal/10'
                  : 'self-end rounded-br-md bg-paper text-ink ring-1 ring-inset ring-ink/5'
              }`}
            >
              {line.role === 'agent' && (
                <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.1em] text-signal-deep/70">
                  Receptionist
                </span>
              )}
              {line.text}
            </div>
          ))}
          {ringing && (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-sm text-ink-muted">Answering before the second ring…</p>
            </div>
          )}
        </div>

        {/* booked toast */}
        <div className="px-5 pb-5">
          {booked ? (
            <div className="flex animate-pop-in items-center gap-3 rounded-2xl border border-clinic/20 bg-clinic-soft/70 px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-clinic text-white shadow-sm">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                  <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div>
                <p className="text-[13px] font-semibold text-ink">Appointment booked</p>
                <p className="text-xs text-ink-muted">Sarah Mitchell · Tomorrow, 11:00 AM · synced to dashboard</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-2xl border border-line/60 bg-paper/60 px-4 py-3">
              <p className="text-xs text-ink-muted">Voice: Emma · ambience: office</p>
              <Waveform bars={5} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------- live demo (dark section) ------------------------ */

type DemoPhase = 'idle' | 'requesting' | SimulatorPhase;

const DEMO_SCENARIOS = [
  { tag: 'Just talk', text: 'Tell Ava about your business — she leads from there.' },
  { tag: 'Book it live', text: 'Ask her to book an appointment — watch the calendar fill in real time.' },
  { tag: 'Try to double-book', text: 'Block an open slot below, then ask for that exact time — watch her refuse.' },
  { tag: 'Get the recap', text: 'Hang up and see the clean summary she leaves behind.' },
];

function minutesOf(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function hhmm(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
function to12(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${String(m).padStart(2, '0')} ${suffix}`;
}
function gridTimes(day: DemoDay): string[] {
  const out: string[] = [];
  for (let t = minutesOf(day.open); t + day.slotMinutes <= minutesOf(day.close); t += day.slotMinutes) {
    out.push(hhmm(t));
  }
  return out;
}

type DemoView = 'form' | 'choose' | 'web' | 'call';

/** Lead-capture form state. `industry` starts unset so the user must pick one. */
interface DemoFormState {
  name: string;
  email: string;
  phone: string;
  industry: DemoIndustry | null;
  /** Optional — when given, shown on the demo calendar instead of a placeholder. */
  businessName: string;
}

/** The guided stages Ava walks the prospect through; the right panel follows. */
type DemoStage = 'intro' | 'booking' | 'doublebook' | 'summary' | 'close';
const STAGE_ORDER: DemoStage[] = ['intro', 'booking', 'doublebook', 'summary', 'close'];

/** Whether a string from Ava's set_demo_screen tool is a real stage. */
function isStage(value: unknown): value is DemoStage {
  return typeof value === 'string' && (STAGE_ORDER as string[]).includes(value);
}

/* ----------------------------- demo: lead form ---------------------------- */

function DemoLeadField({
  label,
  type,
  placeholder,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  type: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-left">
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-white/45">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="rounded-xl border border-white/15 bg-white/[0.06] px-4 py-3 text-[15px] text-white placeholder:text-white/30 outline-none transition-colors focus:border-signal-soft/70 focus:bg-white/[0.09]"
      />
    </label>
  );
}

/** The industries the demo can dress its sample calendar for. */
const DEMO_INDUSTRIES: Array<{ key: DemoIndustry; label: string; hint: string }> = [
  { key: 'clinic', label: 'Clinic / practice', hint: 'Dental, medical, vet' },
  { key: 'contractor', label: 'Contractor / trades', hint: 'Builders, HVAC, plumbing' },
  { key: 'other', label: 'Something else', hint: 'Salon, law, services' },
];

function DemoLeadForm({
  form,
  setForm,
  submitting,
  error,
  onSubmit,
}: {
  form: DemoFormState;
  setForm: React.Dispatch<React.SetStateAction<DemoFormState>>;
  submitting: boolean;
  error: string | null;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <div className="mx-auto max-w-xl">
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.04] p-7 backdrop-blur sm:p-9"
      >
        <div className="text-center">
          <h3 className="font-display text-[22px] font-semibold tracking-tight text-white">
            Talk to our AI — live, right now
          </h3>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">
            Drop your details and she’ll walk you through exactly how VoiceFront answers, books, and
            never double-books — tuned to your line of work.
          </p>
        </div>

        <div className="mt-1 flex flex-col gap-3.5">
          <DemoLeadField
            label="Your name"
            type="text"
            placeholder="Jordan Reyes"
            autoComplete="name"
            value={form.name}
            onChange={(v) => setForm((f) => ({ ...f, name: v }))}
          />
          <DemoLeadField
            label="Email"
            type="email"
            placeholder="you@company.com"
            autoComplete="email"
            value={form.email}
            onChange={(v) => setForm((f) => ({ ...f, email: v }))}
          />
          <DemoLeadField
            label="Phone"
            type="tel"
            placeholder="+1 (555) 123-4567"
            autoComplete="tel"
            value={form.phone}
            onChange={(v) => setForm((f) => ({ ...f, phone: v }))}
          />

          {/* Industry — dresses the demo calendar to match their world. */}
          <div className="flex flex-col gap-1.5 text-left">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-white/45">
              What kind of business?
            </span>
            <div className="grid grid-cols-3 gap-2">
              {DEMO_INDUSTRIES.map((opt) => {
                const selected = form.industry === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, industry: opt.key }))}
                    aria-pressed={selected}
                    className={`flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-all duration-200 ${
                      selected
                        ? 'border-signal-soft/70 bg-signal/20 ring-1 ring-inset ring-signal/40'
                        : 'border-white/12 bg-white/[0.05] hover:border-white/25 hover:bg-white/[0.08]'
                    }`}
                  >
                    <span className={`text-[13px] font-semibold ${selected ? 'text-white' : 'text-white/80'}`}>
                      {opt.label}
                    </span>
                    <span className="text-[11px] leading-tight text-white/40">{opt.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Optional business name — shown on the demo calendar if provided. */}
          <label className="flex flex-col gap-1.5 text-left">
            <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-white/45">
              Business name
              <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-white/40">
                optional
              </span>
            </span>
            <input
              type="text"
              value={form.businessName}
              onChange={(e) => setForm((f) => ({ ...f, businessName: e.target.value }))}
              placeholder="e.g. Riverside Dental"
              autoComplete="organization"
              maxLength={60}
              className="rounded-xl border border-white/15 bg-white/[0.06] px-4 py-3 text-[15px] text-white placeholder:text-white/30 outline-none transition-colors focus:border-signal-soft/70 focus:bg-white/[0.09]"
            />
            <span className="text-[11px] leading-tight text-white/35">
              We’ll put it on the demo calendar so it feels like yours. Leave blank and we’ll use a sample.
            </span>
          </label>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="mt-1 rounded-full bg-white px-7 py-3.5 text-[15px] font-semibold text-ink shadow-lift transition-transform hover:-translate-y-0.5 disabled:opacity-60"
        >
          {submitting ? 'Setting things up…' : 'Continue'}
        </button>
        {error && <p className="text-center text-xs text-[#ffb4ba]">{error}</p>}
        <p className="text-center text-[11px] leading-relaxed text-white/30">
          We’ll only use this to run your demo and follow up. No spam.
        </p>
      </form>
    </div>
  );
}

/* --------------------------- demo: choose a mode -------------------------- */

function DemoModeChoice({
  lead,
  onWeb,
  onCall,
  onBack,
}: {
  lead: DemoLeadResponse;
  onWeb: () => void;
  onCall: () => void;
  onBack: () => void;
}) {
  const firstName = lead.name.trim().split(/\s+/)[0];
  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-7 backdrop-blur sm:p-9">
        <div className="text-center">
          <h3 className="font-display text-[22px] font-semibold tracking-tight text-white">
            Nice to meet you, {firstName} 👋
          </h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/55">
            How would you like to experience the demo?
          </p>
        </div>

        <div className="mt-6 grid gap-3.5 sm:grid-cols-2">
          {/* Test on web — always available */}
          <button
            type="button"
            onClick={onWeb}
            className="group flex flex-col items-start gap-2 rounded-2xl border border-white/15 bg-white/[0.06] p-5 text-left transition-all hover:-translate-y-0.5 hover:border-signal-soft/60 hover:bg-white/[0.1]"
          >
            <span className="rounded-full bg-signal/25 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-signal-soft ring-1 ring-inset ring-signal/30">
              Instant
            </span>
            <span className="text-[16px] font-semibold text-white">Test on the web</span>
            <span className="text-[13px] leading-snug text-white/55">
              Talk to the agent right here in your browser. Just needs mic access.
            </span>
          </button>

          {/* Get a call — gated to US/CA */}
          {lead.callAllowed ? (
            <button
              type="button"
              onClick={onCall}
              className="group flex flex-col items-start gap-2 rounded-2xl border border-white/15 bg-white/[0.06] p-5 text-left transition-all hover:-translate-y-0.5 hover:border-emerald-300/50 hover:bg-white/[0.1]"
            >
              <span className="rounded-full bg-emerald-400/20 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-200 ring-1 ring-inset ring-emerald-300/30">
                Most realistic
              </span>
              <span className="text-[16px] font-semibold text-white">Get a call</span>
              <span className="text-[13px] leading-snug text-white/55">
                We’ll ring your phone in a few seconds so you hear it like a real customer would.
              </span>
            </button>
          ) : (
            <div className="flex flex-col items-start gap-2 rounded-2xl border border-dashed border-white/12 bg-white/[0.02] p-5 text-left opacity-70">
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">
                US & Canada
              </span>
              <span className="text-[16px] font-semibold text-white/70">Get a call</span>
              <span className="text-[13px] leading-snug text-white/45">
                Phone callbacks are available in the US & Canada right now. The web test works
                everywhere — give it a try!
              </span>
            </div>
          )}
        </div>

        <div className="mt-5 text-center">
          <button
            type="button"
            onClick={onBack}
            className="text-xs font-medium text-white/40 transition-colors hover:text-white/70"
          >
            ‹ Use different details
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------- demo: outbound "get a call" ---------------------- */

type CallState =
  | { status: 'idle' }
  | { status: 'dialing' }
  | { status: 'ringing'; fromNumber: string }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

function DemoCallView({
  lead,
  onBack,
  onWeb,
}: {
  lead: DemoLeadResponse;
  onBack: () => void;
  onWeb: () => void;
}) {
  const [state, setState] = useState<CallState>({ status: 'idle' });

  async function dial() {
    setState({ status: 'dialing' });
    try {
      const res = await DemoApi.call({
        sessionId: lead.sessionId,
        leadId: lead.leadId,
        name: lead.name,
        phone: lead.phone,
      });
      setState({ status: 'ringing', fromNumber: res.fromNumber });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NO_DEMO_NUMBER') {
        setState({ status: 'unavailable' });
      } else {
        setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Could not place the call.' });
      }
    }
  }

  const ringing = state.status === 'ringing';

  return (
    <div className="mx-auto max-w-xl">
      <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-9 text-center backdrop-blur">
        <div
          className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ring-1 ring-inset ${
            ringing ? 'bg-emerald-400/20 ring-emerald-300/40' : 'bg-signal/15 ring-signal-soft/30'
          }`}
        >
          {state.status === 'dialing' ? (
            <Spinner className="h-6 w-6 text-white" />
          ) : (
            <Waveform bars={4} light />
          )}
        </div>

        {ringing ? (
          <>
            <h3 className="mt-5 font-display text-[20px] font-semibold tracking-tight text-white">
              Your phone’s about to ring
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/60">
              We’re calling <span className="font-semibold text-white">{lead.phone}</span> from{' '}
              <span className="font-mono text-white/80">{state.fromNumber}</span>. Pick up and say hi to Ava — she’ll
              take it from there.
            </p>
          </>
        ) : state.status === 'unavailable' ? (
          <>
            <h3 className="mt-5 font-display text-[20px] font-semibold tracking-tight text-white">
              Phone demo isn’t live yet
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/60">
              We’re finishing the outbound calling setup. The in-browser test is fully live in the meantime — same
              Ava, same demo.
            </p>
          </>
        ) : (
          <>
            <h3 className="mt-5 font-display text-[20px] font-semibold tracking-tight text-white">
              Get a call from Ava
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/60">
              We’ll ring <span className="font-semibold text-white">{lead.phone}</span> right now. Pick up and run the
              whole demo by voice — booking, double-booking, the works.
            </p>
            {state.status === 'error' && (
              <p className="mx-auto mt-3 max-w-sm text-sm text-rose-300/90">{state.message}</p>
            )}
          </>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {!ringing && state.status !== 'unavailable' && (
            <button
              type="button"
              onClick={dial}
              disabled={state.status === 'dialing'}
              className="rounded-full bg-white px-6 py-3 text-[15px] font-semibold text-ink shadow-lift transition-transform hover:-translate-y-0.5 disabled:opacity-60"
            >
              {state.status === 'dialing' ? 'Calling…' : 'Call me now'}
            </button>
          )}
          {(state.status === 'unavailable' || state.status === 'error') && (
            <button
              type="button"
              onClick={onWeb}
              className="rounded-full bg-white px-6 py-3 text-[15px] font-semibold text-ink shadow-lift transition-transform hover:-translate-y-0.5"
            >
              Try the in-browser demo
            </button>
          )}
          <button
            type="button"
            onClick={onBack}
            className="rounded-2xl border border-white/15 bg-white/[0.06] px-6 py-3 text-[15px] font-semibold text-white transition-transform hover:-translate-y-0.5"
          >
            ‹ Back to options
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------- demo: agent-driven screens ----------------------- */

function DemoIntroStage() {
  const items = [
    { t: 'Books appointments', d: 'Ask her to book — watch it land on the calendar.' },
    { t: 'Never double-books', d: 'Block a slot and try to trip her up.' },
    { t: 'Sends a summary', d: 'A clean recap the second you hang up.' },
  ];
  return (
    <div className="flex flex-col gap-3 px-5 py-6">
      <p className="text-[13px] text-ink-muted">Ava’s about to walk you through three things, live:</p>
      {items.map((it, i) => (
        <div key={it.t} className="flex items-start gap-3 rounded-2xl bg-paper px-4 py-3 ring-1 ring-inset ring-ink/5">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-signal/15 text-[12px] font-bold text-signal-deep">
            {i + 1}
          </span>
          <div>
            <p className="text-[14px] font-semibold text-ink">{it.t}</p>
            <p className="text-[12px] leading-snug text-ink-muted">{it.d}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function DemoCalendarHidden() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-paper ring-1 ring-inset ring-ink/10">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5 text-ink-muted">
          <rect x="4" y="9" width="12" height="8" rx="2" />
          <path d="M7 9V6.5a3 3 0 0 1 6 0V9" strokeLinecap="round" />
        </svg>
      </div>
      <p className="max-w-xs text-sm text-ink-muted">
        The live calendar is hidden for this demo — Ava will walk you through how booking works, by voice.
      </p>
    </div>
  );
}

function DemoSummaryStage({
  day,
  voiceAppt,
  lead,
  summary,
}: {
  day: DemoDay | null;
  voiceAppt: DemoAppointment | null;
  lead: DemoLeadResponse | null;
  summary: DemoCallSummary | null;
}) {
  const caller = lead?.name ?? 'New caller';
  // Ava's real, call-specific recap when she's pushed one; otherwise a sensible
  // line from what we know (so the panel is never blank before she summarizes).
  const recap =
    summary?.recap?.trim() ||
    `${caller} called and I ${voiceAppt ? 'booked them in' : 'took their details'}. Everything’s on your calendar and nothing needs your attention right now.`;
  return (
    <div className="animate-fade-up px-5 py-6">
      <div className="rounded-2xl border border-line/70 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-signal-deep">Call summary</p>
          <span className="rounded-full bg-clinic-soft px-2 py-0.5 text-[10px] font-semibold text-[#0b8a74]">
            Auto-generated
          </span>
        </div>
        <dl className="mt-3 flex flex-col gap-2.5 text-[13px]">
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">Caller</dt>
            <dd className="font-medium text-ink">{caller}</dd>
          </div>
          {summary?.headline?.trim() && (
            <div className="flex justify-between gap-3">
              <dt className="shrink-0 text-ink-muted">They needed</dt>
              <dd className="text-right font-medium text-ink">{summary.headline.trim()}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">Outcome</dt>
            <dd className="font-medium text-ink">{voiceAppt ? 'Appointment booked' : 'Spoke with the agent'}</dd>
          </div>
          {voiceAppt && (
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">Booked</dt>
              <dd className="text-right font-medium text-ink">
                {voiceAppt.label}
                {day ? ` · ${day.dayLabel}` : ''}
              </dd>
            </div>
          )}
        </dl>
        <div className="mt-4 rounded-xl bg-paper px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-muted ring-1 ring-inset ring-ink/5">
          “{recap}”
        </div>
      </div>
      <p className="mt-3 text-center text-[12px] text-ink-muted">This lands in your inbox the moment a call ends.</p>
    </div>
  );
}

function DemoCloseStage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-signal/15">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5 text-signal-deep">
          <rect x="3.5" y="4.5" width="13" height="12" rx="2" />
          <path d="M3.5 8h13M7 3v3M13 3v3M8 12l1.5 1.5L13 10.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <p className="font-display text-[16px] font-semibold text-ink">Like what you see?</p>
      <p className="max-w-xs text-[13px] leading-snug text-ink-muted">
        Ava can book you a quick setup call right now — just tell her a day that works, and watch it land.
      </p>
    </div>
  );
}

function DemoStagePanel({
  stage,
  showCalendar,
  day,
  appointments,
  blocking,
  onBlock,
  onReset,
  resetting,
  sessionId,
  lead,
  callSummary,
}: {
  stage: DemoStage;
  showCalendar: boolean;
  day: DemoDay | null;
  appointments: DemoAppointment[];
  blocking: string | null;
  onBlock: (time: string) => void;
  onReset: () => void;
  resetting: boolean;
  sessionId: string | null;
  lead: DemoLeadResponse | null;
  callSummary: DemoCallSummary | null;
}) {
  const byTime = new Map(appointments.map((a) => [a.time, a]));
  const aiBooked = appointments.filter((a) => a.kind === 'voice').length;
  const voiceAppt = appointments.find((a) => a.kind === 'voice') ?? null;
  const onCalendar = stage === 'booking' || stage === 'doublebook';

  // Click-guidance: during the double-book stage the prospect must block an
  // open slot themselves. Highlight the slots and point at the first one until
  // they've blocked one. During booking it's voice-driven, so we nudge them to
  // ask out loud instead.
  const apptNoun = day?.industry === 'contractor' ? 'site estimate' : 'appointment';
  const hasBlocked = appointments.some((a) => a.kind === 'blocked');
  const guideBlock = stage === 'doublebook' && showCalendar && !!day && !hasBlocked;
  const guideBook = stage === 'booking' && showCalendar && !!day && aiBooked === 0;
  const firstOpen = guideBlock && day ? gridTimes(day).find((t) => !byTime.get(t)) : undefined;

  // When Ava books a slot it can land below the fold — so the moment a new
  // voice booking appears, scroll the list to center it and flash it green so
  // the prospect always sees the confirmation, no scrolling required.
  const scrollBoxRef = useRef<HTMLUListElement | null>(null);
  const slotRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const seenVoiceRef = useRef<Set<string>>(new Set());
  const [flashTime, setFlashTime] = useState<string | null>(null);
  useEffect(() => {
    const voice = appointments.filter((a) => a.kind === 'voice');
    const fresh = voice.find((a) => !seenVoiceRef.current.has(a.id));
    voice.forEach((a) => seenVoiceRef.current.add(a.id));
    if (!fresh) return;
    setFlashTime(fresh.time);
    requestAnimationFrame(() => {
      const li = slotRefs.current.get(fresh.time);
      const box = scrollBoxRef.current;
      // Scroll only the list (it's position:relative, so offsetTop is local) —
      // never the whole page.
      if (li && box) {
        box.scrollTo({ top: li.offsetTop - box.clientHeight / 2 + li.clientHeight / 2, behavior: 'smooth' });
      }
    });
    const t = window.setTimeout(() => setFlashTime(null), 2800);
    return () => window.clearTimeout(t);
  }, [appointments]);

  const sampleCompany = day?.sampleCompany ?? 'Sample business';
  const header = {
    intro: { eyebrow: 'Live demo', title: 'What Ava will show you' },
    booking: { eyebrow: `Sample · ${sampleCompany}`, title: day?.dayLabel ?? 'Loading…' },
    doublebook: { eyebrow: 'Try to catch her out', title: 'She won’t double-book' },
    summary: { eyebrow: 'After the call', title: 'The summary you’d get' },
    close: { eyebrow: 'Your next step', title: 'Book your setup call' },
  }[stage];

  return (
    <div className="flex flex-col overflow-hidden rounded-3xl border border-white/10 bg-white shadow-lift">
      <div className="flex items-center justify-between border-b border-line/60 bg-paper/70 px-5 py-3.5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">{header.eyebrow}</p>
          <p className="mt-0.5 text-[13px] font-semibold text-ink">{header.title}</p>
        </div>
        {onCalendar && showCalendar && (
          <div className="flex items-center gap-2">
            {aiBooked > 0 && (
              <span className="animate-pop-in rounded-full bg-clinic-soft px-2.5 py-1 text-[11px] font-semibold text-[#0b8a74]">
                +{aiBooked} booked by AI
              </span>
            )}
            {sessionId && (
              <button
                type="button"
                onClick={onReset}
                disabled={resetting}
                className="rounded-full border border-line px-2.5 py-1 text-[11px] font-semibold text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
              >
                Reset
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex min-h-[280px] flex-1 flex-col">
        {onCalendar ? (
          !showCalendar ? (
            <DemoCalendarHidden />
          ) : !day ? (
            <div className="flex flex-1 items-center justify-center px-5 py-14 text-center text-sm text-ink-muted">
              Loading the calendar…
            </div>
          ) : (
            <div className="flex flex-1 flex-col">
              {/* Coachmark: tell the prospect exactly what to do this stage. */}
              {(guideBook || guideBlock) && (
                <div className="mx-5 mb-1 mt-2 flex animate-pop-in items-center gap-2.5 rounded-xl border border-signal/30 bg-signal-soft/60 px-3.5 py-2.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-signal text-white">
                    {guideBlock ? (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5">
                        <path d="M6 8.5 3 8l-.5 3.5L6 14l5-1 1.5-4-2.5-1-1 2-1-5.5-1.5.5L7 8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5">
                        <path d="M8 2.5a2 2 0 0 1 2 2v3a2 2 0 1 1-4 0v-3a2 2 0 0 1 2-2ZM4 7.5a4 4 0 0 0 8 0M8 11.5v2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <p className="text-[12px] font-medium leading-snug text-signal-deep">
                    {guideBlock
                      ? 'Click any open slot below to block it — then ask Ava to book that exact time and watch her refuse.'
                      : `Say it out loud: “Book me ${apptNoun === 'site estimate' ? 'a site estimate' : 'an appointment'} at 2 PM” — watch it land here.`}
                  </p>
                </div>
              )}
              <ul
                ref={scrollBoxRef}
                className="relative max-h-[360px] flex-1 divide-y divide-line/50 overflow-y-auto px-5 py-1.5"
              >
              {gridTimes(day).map((time) => {
                const appt = byTime.get(time);
                const pointHere = firstOpen === time;
                return (
                  <li
                    key={time}
                    ref={(el) => {
                      if (el) slotRefs.current.set(time, el);
                    }}
                    className="flex items-center gap-3 py-2"
                  >
                    <span className="w-16 shrink-0 font-mono text-xs text-ink-muted">{to12(time)}</span>
                    {!appt ? (
                      <button
                        type="button"
                        onClick={() => onBlock(time)}
                        disabled={blocking === time}
                        className={`group relative flex flex-1 items-center justify-between rounded-xl border border-dashed px-3.5 py-2 text-[13px] transition-colors ${
                          guideBlock
                            ? 'animate-highlight border-signal/50 text-ink-muted hover:border-signal hover:text-ink'
                            : 'border-line text-ink-muted/60 hover:border-ink-muted/40 hover:text-ink-muted'
                        }`}
                      >
                        <span>Open</span>
                        <span
                          className={`text-[11px] font-semibold transition-opacity ${
                            guideBlock ? 'text-signal-deep opacity-100' : 'opacity-0 group-hover:opacity-100'
                          }`}
                        >
                          {blocking === time ? 'Blocking…' : 'Block this slot'}
                        </span>
                        {pointHere && (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute -right-1 top-1/2 hidden -translate-y-1/2 translate-x-full animate-nudge items-center pl-2 text-signal sm:flex"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                              <path d="M19 12H6M11 7l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                        )}
                      </button>
                    ) : appt.kind === 'voice' ? (
                      <span
                        className={`flex flex-1 animate-pop-in items-center justify-between rounded-xl bg-gradient-to-r from-signal to-signal-deep px-3.5 py-2 text-[13px] font-semibold text-white shadow-pop ${
                          flashTime === time ? 'animate-flash-green' : ''
                        }`}
                      >
                        {appt.label}
                        <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                          {flashTime === time ? 'Just booked ✓' : 'Voice agent'}
                        </span>
                      </span>
                    ) : appt.kind === 'blocked' ? (
                      <span className="flex flex-1 items-center justify-between rounded-xl bg-construction-soft px-3.5 py-2 text-[13px] font-medium text-[#9a6a1d] ring-1 ring-inset ring-construction/20">
                        {appt.label}
                        <span className="text-[10px] font-semibold uppercase tracking-wide">Blocked</span>
                      </span>
                    ) : (
                      <span className="flex-1 rounded-xl bg-paper px-3.5 py-2 text-[13px] text-ink-muted ring-1 ring-inset ring-ink/5">
                        {appt.label}
                      </span>
                    )}
                  </li>
                );
              })}
              </ul>
            </div>
          )
        ) : stage === 'summary' ? (
          <DemoSummaryStage day={day} voiceAppt={voiceAppt} lead={lead} summary={callSummary} />
        ) : stage === 'close' ? (
          <DemoCloseStage />
        ) : (
          <DemoIntroStage />
        )}
      </div>
    </div>
  );
}

function InteractiveDemo() {
  const [view, setView] = useState<DemoView>('form');
  const [lead, setLead] = useState<DemoLeadResponse | null>(null);
  const [form, setForm] = useState<DemoFormState>({
    name: '',
    email: '',
    phone: '',
    industry: null,
    businessName: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [phase, setPhase] = useState<DemoPhase>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [day, setDay] = useState<DemoDay | null>(null);
  const [appointments, setAppointments] = useState<DemoAppointment[]>([]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [blocking, setBlocking] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [showCalendar, setShowCalendar] = useState(true);
  const [stage, setStage] = useState<DemoStage>('intro');
  // Ava's real recap of the call, pushed to the summary panel via her tool.
  const [callSummary, setCallSummary] = useState<DemoCallSummary | null>(null);

  const sessionRef = useRef<VoiceSession | null>(null);
  const aliveRef = useRef(true);
  const transcriptBoxRef = useRef<HTMLDivElement | null>(null);
  // When Ava last drove the screen via a live tool-call event. The calendar
  // poll only reconciles the screen once events have been quiet for a moment,
  // so a slightly-stale poll can never flicker the panel backward mid-step.
  const screenSetAtRef = useRef(0);

  // Switch the on-screen panel to whatever Ava asked for — forward OR back.
  const applyScreen = useCallback((screen: string) => {
    if (!isStage(screen)) return;
    screenSetAtRef.current = Date.now();
    setStage(screen);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  // Poll the live calendar while a session is open, so the agent's bookings
  // (and the "after they hang up" final one) appear on screen. The response
  // also carries the screen Ava last set server-side — a fallback in case the
  // browser missed her live tool-call event. We only apply it once live events
  // have been quiet for a few seconds, so it reconciles without fighting them.
  useEffect(() => {
    if (!sessionId) return;
    const id = window.setInterval(async () => {
      try {
        const { appointments: next, screen, summary } = await DemoApi.appointments(sessionId);
        if (!aliveRef.current) return;
        setAppointments(next);
        // Fast reconcile so the panel tracks Ava closely even when the live
        // tool-call event doesn't reach the browser. The short window only
        // defers to a *very* recent live event, to avoid a one-tick flicker.
        if (isStage(screen) && Date.now() - screenSetAtRef.current > 800) setStage(screen);
        if (summary) setCallSummary(summary);
      } catch {
        /* transient — next tick retries */
      }
    }, 600);
    return () => window.clearInterval(id);
  }, [sessionId]);

  useEffect(() => {
    const box = transcriptBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [transcript]);

  const live = phase === 'connecting' || phase === 'listening' || phase === 'assistant-speaking';

  async function submitLead(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const name = form.name.trim();
    const email = form.email.trim();
    const phone = form.phone.trim();
    if (!name || !email || !phone) {
      setFormError('Please fill in your name, email, and phone.');
      return;
    }
    if (!form.industry) {
      setFormError('Pick the kind of business you run so we can tailor the demo.');
      return;
    }
    setSubmitting(true);
    try {
      const businessName = form.businessName.trim();
      const res = await DemoApi.lead({
        name,
        email,
        phone,
        industry: form.industry,
        ...(businessName ? { businessName } : {}),
      });
      setLead(res);
      setSessionId(res.sessionId);
      setDay(res.day);
      setAppointments(res.appointments);
      setView('choose');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DEMO_DISABLED') {
        setFormError('The demo is currently turned off — please check back soon.');
      } else if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
        setFormError('Please double-check your email and phone number.');
      } else {
        setFormError(err instanceof ApiError ? err.message : 'Could not start the demo. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function chooseWeb() {
    setView('web');
    void startCall();
  }

  async function startCall() {
    if (live || phase === 'requesting') return;
    setError(null);
    setTranscript([]);
    setStage('intro');
    setCallSummary(null);
    screenSetAtRef.current = 0;
    setPhase('requesting');
    let data;
    try {
      data = await DemoApi.start({ sessionId: lead?.sessionId, leadId: lead?.leadId, name: lead?.name });
    } catch (err) {
      if (!aliveRef.current) return;
      if (err instanceof ApiError && err.code === 'VOICE_NOT_CONFIGURED') {
        setUnavailable(true);
        setPhase('idle');
        return;
      }
      setPhase('error');
      setError(err instanceof ApiError ? err.message : 'Could not start the demo.');
      return;
    }
    if (!aliveRef.current) return;
    setSessionId(data.sessionId);
    setDay(data.day);
    setAppointments(data.appointments);
    setShowCalendar(data.showCalendar);

    const session = new VoiceSession();
    sessionRef.current = session;
    await session.start(data.publicKey, data.assistant, {
      onPhase: (next) => aliveRef.current && setPhase(next),
      onVolume: () => {},
      onTranscript: (entry) => aliveRef.current && setTranscript((cur) => [...cur, entry]),
      onError: (message) => aliveRef.current && setError(message),
      onScreen: (screen) => aliveRef.current && applyScreen(screen),
      onSummary: (summary) => {
        if (!aliveRef.current) return;
        setCallSummary(summary);
        applyScreen('summary'); // the recap tool also switches them to the summary
      },
    });
  }

  function endCall() {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setPhase('ended');
  }

  async function blockSlot(time: string) {
    if (!sessionId || !day) return;
    setBlocking(time);
    try {
      const { appointments: next } = await DemoApi.block(sessionId, day.date, time);
      if (aliveRef.current) setAppointments(next);
    } catch {
      /* ignore */
    } finally {
      if (aliveRef.current) setBlocking(null);
    }
  }

  async function resetCalendar() {
    if (!sessionId) return;
    setResetting(true);
    try {
      const res = await DemoApi.reset(sessionId);
      if (aliveRef.current) {
        setDay(res.day);
        setAppointments(res.appointments);
      }
    } catch {
      /* ignore */
    } finally {
      if (aliveRef.current) setResetting(false);
    }
  }

  // ----------------------------- gate: lead form ----------------------------
  if (view === 'form') {
    return (
      <div key="form" className="animate-fade-up">
        <DemoLeadForm
          form={form}
          setForm={setForm}
          submitting={submitting}
          error={formError}
          onSubmit={submitLead}
        />
      </div>
    );
  }

  // --------------------------- gate: choose a mode --------------------------
  if (view === 'choose' && lead) {
    return (
      <div key="choose" className="animate-fade-up">
        <DemoModeChoice
          lead={lead}
          onWeb={chooseWeb}
          onCall={() => setView('call')}
          onBack={() => setView('form')}
        />
      </div>
    );
  }

  // ------------------------- "get a call" placeholder -----------------------
  if (view === 'call' && lead) {
    return (
      <div key="call" className="animate-fade-up">
        <DemoCallView lead={lead} onBack={() => setView('choose')} onWeb={chooseWeb} />
      </div>
    );
  }

  return (
    <div key="web" className="grid animate-fade-up items-stretch gap-5 lg:grid-cols-2">
      {/* ------------------------------ call console ------------------------------ */}
      <div className="flex flex-col overflow-hidden rounded-3xl border border-white/10 bg-white shadow-lift">
        <div className="flex items-center justify-between border-b border-line/60 bg-paper/70 px-5 py-3.5">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">Live demo call</p>
          {live ? (
            <span className="flex items-center gap-2 text-xs font-semibold text-signal-deep">
              <Waveform bars={4} />
              On the line
            </span>
          ) : (
            <span className="text-xs font-medium text-ink-muted/70">
              {phase === 'requesting' ? 'Connecting…' : phase === 'ended' ? 'Call ended' : 'Not connected'}
            </span>
          )}
        </div>

        <div ref={transcriptBoxRef} className="flex h-[440px] flex-col gap-2.5 overflow-y-auto px-5 py-5">
          {transcript.length === 0 && !live && phase !== 'requesting' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
              <p className="max-w-xs text-sm text-ink-muted">
                Press the button and say hi to Ava. She’ll walk you through what VoiceFront does — live. Ask her to book, then try to trip her up.
              </p>
            </div>
          ) : (
            transcript.map((entry, i) => (
              <div
                key={i}
                className={`max-w-[88%] animate-pop-in rounded-2xl px-3.5 py-2.5 text-[13px] leading-snug ${
                  entry.role === 'assistant'
                    ? 'self-start rounded-tl-sm bg-signal-soft/60 text-ink'
                    : 'self-end rounded-tr-sm bg-ink text-white'
                }`}
              >
                {entry.text}
              </div>
            ))
          )}
          {phase === 'requesting' && (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-sm text-ink-muted/70">Getting Ava on the line…</p>
            </div>
          )}
        </div>

        <div className="border-t border-line/60 px-5 py-4">
          {unavailable ? (
            <p className="text-center text-sm text-ink-muted">
              The live demo isn’t configured on this server yet. You can still create a workspace and run a
              free in-browser test call.
            </p>
          ) : (
            <div className="flex flex-col items-center gap-2">
              {live ? (
                <button
                  type="button"
                  onClick={endCall}
                  className="rounded-full bg-[#ff5d6c] px-7 py-3 text-[15px] font-semibold text-white shadow-pop transition-transform hover:-translate-y-0.5"
                >
                  End call
                </button>
              ) : (
                <span className="relative inline-flex">
                  {phase === 'idle' && transcript.length === 0 && (
                    <span
                      aria-hidden
                      className="absolute inset-0 animate-pulse-ring rounded-full bg-signal/40"
                    />
                  )}
                  <button
                    type="button"
                    onClick={startCall}
                    disabled={phase === 'requesting'}
                    className="relative rounded-full bg-gradient-to-b from-signal to-signal-deep px-7 py-3 text-[15px] font-semibold text-white shadow-pop transition-all duration-200 ease-smooth hover:-translate-y-0.5 hover:shadow-lift disabled:opacity-60"
                  >
                    {phase === 'ended' ? 'Call again' : 'Start the demo call'}
                  </button>
                </span>
              )}
              <p className="text-[11px] text-ink-muted/70">Free · runs in your browser · needs mic access</p>
              {error && <p className="text-center text-xs text-danger">{error}</p>}
            </div>
          )}
        </div>
      </div>

      {/* ---------------------- agent-driven stage panel ---------------------- */}
      <DemoStagePanel
        stage={stage}
        showCalendar={showCalendar}
        day={day}
        appointments={appointments}
        blocking={blocking}
        onBlock={blockSlot}
        onReset={resetCalendar}
        resetting={resetting}
        sessionId={sessionId}
        lead={lead}
        callSummary={callSummary}
      />

      {/* ----------------------------- guided scenarios ---------------------------- */}
      <div className="lg:col-span-2">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {DEMO_SCENARIOS.map((s, i) => {
            // Scenarios map 1:1 to the first four stages; the last card ("recap")
            // stays lit through both summary and close.
            const stageIdx = STAGE_ORDER.indexOf(stage);
            const active = stageIdx === i || (i === 3 && stageIdx === 4);
            return (
              <div
                key={s.tag}
                className={`rounded-2xl border p-4 shadow-card transition-all duration-300 ${
                  active ? 'border-signal/40 bg-signal-soft/60 ring-1 ring-inset ring-signal/20' : 'border-line bg-white'
                }`}
              >
                <p className={`text-[11px] font-semibold uppercase tracking-wide ${active ? 'text-signal-deep' : 'text-signal-deep/70'}`}>
                  {s.tag}
                </p>
                <p className={`mt-1.5 text-[13px] leading-snug ${active ? 'text-ink' : 'text-ink-muted'}`}>{s.text}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- industries ------------------------------- */

const INDUSTRIES = {
  clinic: {
    label: 'Clinics & practices',
    accent: 'text-[#0b8a74]',
    chip: 'bg-clinic-soft text-[#0b8a74]',
    headline: 'The front desk that never puts a patient on hold.',
    body: 'Patients call to book, reschedule and ask the same questions every day. VoiceFront answers instantly, books into open slots, and routes urgent calls to your staff line.',
    sample: [
      { role: 'caller' as const, text: 'I need to move my Thursday appointment.' },
      { role: 'agent' as const, text: 'Of course — I have Friday 10:00 or Monday 2:30 open.' },
    ],
    points: ['Books & reschedules visits', 'Screens urgent calls to staff', 'After-hours messages with callbacks', 'Reads back numbers to confirm'],
  },
  contractor: {
    label: 'Contractors & trades',
    accent: 'text-[#9a6a1d]',
    chip: 'bg-construction-soft text-[#9a6a1d]',
    headline: 'Win the job while you’re still on the roof.',
    body: 'Most homeowners call the next contractor if you don’t pick up. VoiceFront qualifies the lead, books the estimate, and texts you the details before you’re off the ladder.',
    sample: [
      { role: 'caller' as const, text: 'I need a quote for a fence repair this week.' },
      { role: 'agent' as const, text: 'I can book an on-site estimate Thursday at 4:00 — does that work?' },
    ],
    points: ['Qualifies new leads', 'Books on-site estimates', 'Transfers emergencies to your cell', 'Takes supplier messages with PO numbers'],
  },
} as const;

function IndustryTabs() {
  const [tab, setTab] = useState<keyof typeof INDUSTRIES>('clinic');
  const active = INDUSTRIES[tab];
  return (
    <div>
      <div className="mb-8 flex justify-center gap-2">
        {(Object.keys(INDUSTRIES) as Array<keyof typeof INDUSTRIES>).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-full px-5 py-2.5 text-sm font-semibold transition-all duration-200 ${
              tab === key
                ? 'bg-ink text-white shadow-lift'
                : 'bg-white text-ink-muted ring-1 ring-inset ring-line hover:text-ink'
            }`}
          >
            {INDUSTRIES[key].label}
          </button>
        ))}
      </div>
      <div className="grid items-center gap-10 rounded-3xl border border-line/70 bg-white p-8 shadow-card md:grid-cols-2 md:p-12">
        <div>
          <span className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${active.chip}`}>
            {active.label}
          </span>
          <h3 className="mt-4 font-display text-2xl font-semibold tracking-tight text-ink md:text-[28px]">
            {active.headline}
          </h3>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">{active.body}</p>
          <ul className="mt-6 grid gap-2.5 sm:grid-cols-2">
            {active.points.map((point) => (
              <li key={point} className="flex items-start gap-2 text-sm text-ink">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className={`mt-0.5 h-4 w-4 shrink-0 ${active.accent}`}>
                  <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {point}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2.5 rounded-2xl bg-paper/80 p-5 ring-1 ring-inset ring-ink/5">
          {active.sample.map((line, i) => (
            <div
              key={`${tab}-${i}`}
              className={`max-w-[88%] animate-pop-in rounded-2xl px-3.5 py-2.5 text-sm leading-snug ${
                line.role === 'agent'
                  ? 'self-start rounded-bl-md bg-signal-soft/80 text-ink ring-1 ring-inset ring-signal/10'
                  : 'self-end rounded-br-md bg-white text-ink ring-1 ring-inset ring-ink/5'
              }`}
              style={{ animationDelay: `${i * 150}ms` }}
            >
              {line.text}
            </div>
          ))}
          <p className="mt-2 text-center text-xs text-ink-muted/70">Sample exchange — voices and scripts are fully yours to shape.</p>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------- FAQ ---------------------------------- */

const FAQS = [
  {
    q: 'Does it really sound human?',
    a: 'Yes. You pick from twelve premium voices (or bring your own ElevenLabs voice), and optional office ambience makes calls feel like a real front desk. Most callers never realize they spoke to an AI.',
  },
  {
    q: 'What happens when it can’t answer something?',
    a: 'It does what a great receptionist does: transfers the call to the right person on your team, or takes a detailed message with a callback number — your rules decide which.',
  },
  {
    q: 'How do appointments reach my calendar?',
    a: 'Bookings land in your VoiceFront calendar the moment the caller hangs up — with the name, number and reason. Two callers can never grab the same slot, and you can connect your Google or Microsoft calendar so it reads your real availability and never books over personal time.',
  },
  {
    q: 'How long does setup take?',
    a: 'About two minutes. Tell us about your business, pick a voice, set your hours, and forward your number. Changes you make in the dashboard apply to the very next call.',
  },
  {
    q: 'What does it cost?',
    a: 'Pricing is tailored to your call volume — a solo contractor and a three-location clinic shouldn’t pay the same. Talk to us and you’ll have a quote within a day, with no contracts and no setup fees.',
  },
  {
    q: 'Can I keep my existing phone number?',
    a: 'Yes. You keep your number and simply forward it — always, after a few rings, or only after hours. You stay in control and can turn it off anytime.',
  },
];

/* --------------------------- beyond answering ----------------------------- */

/** Caller/agent bubbles in the same language as the hero + industry samples. */
function ChatBubbles({ lines }: { lines: { role: 'caller' | 'agent'; text: string }[] }) {
  return (
    <div className="flex flex-col gap-2">
      {lines.map((line, i) => (
        <div
          key={i}
          className={`max-w-[92%] rounded-2xl px-3.5 py-2 text-[12.5px] leading-snug ${
            line.role === 'agent'
              ? 'self-start rounded-bl-md bg-signal-soft/70 text-ink ring-1 ring-inset ring-signal/10'
              : 'self-end rounded-br-md bg-paper text-ink ring-1 ring-inset ring-ink/5'
          }`}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}

/** The three marquee capabilities, each with a mini-visual built from the
 *  existing kit (bubbles, dashboard tile, badges) so it reads as one family. */
function BeyondAnswering() {
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      {/* Warm transfer */}
      <div className="flex h-full flex-col rounded-3xl border border-line/70 bg-white p-7 shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-card-hover">
        <div className="rounded-2xl bg-paper/70 p-4 ring-1 ring-inset ring-ink/5">
          <ChatBubbles
            lines={[
              { role: 'caller', text: 'Is Dr. Lee free? It’s urgent.' },
              { role: 'agent', text: 'One moment — connecting you now.' },
            ]}
          />
          <div className="mt-2.5 flex items-center gap-2.5 rounded-xl border border-signal/20 bg-signal-soft/60 px-3 py-2">
            <Waveform bars={4} />
            <p className="text-[11.5px] font-medium leading-snug text-signal-deep">
              “Sarah’s calling about a filling that fell out — putting her through.”
            </p>
          </div>
        </div>
        <span className="mt-5 inline-flex w-fit items-center rounded-full bg-clinic-soft px-2.5 py-1 text-[11px] font-semibold text-[#0b8a74]">
          Warm handoff
        </span>
        <h3 className="mt-3 font-display text-lg font-semibold tracking-tight text-ink">
          Warm transfers, not blind ones
        </h3>
        <p className="mt-2 flex-1 text-[14px] leading-relaxed text-ink-muted">
          When a call needs a real person, it rings your line and briefs your staff on who’s calling and
          why — before connecting. Your team picks up already in the loop, not cold.
        </p>
      </div>

      {/* Revenue captured */}
      <div className="flex h-full flex-col rounded-3xl border border-line/70 bg-white p-7 shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-card-hover">
        <div className="rounded-2xl border border-signal/15 bg-gradient-to-br from-signal-soft/60 via-white to-white p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-signal-deep">
            Revenue captured
          </p>
          <p className="mt-1.5 font-display text-[34px] font-bold leading-none tracking-tight text-ink">
            $4,200<span className="text-base font-semibold text-ink-muted">/mo</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-ink-muted ring-1 ring-inset ring-ink/5">
              28 bookings saved
            </span>
            <span className="rounded-full bg-clinic-soft px-2.5 py-1 text-[11px] font-semibold text-[#0b8a74]">
              +9 after-hours
            </span>
          </div>
        </div>
        <span className="mt-5 inline-flex w-fit items-center rounded-full bg-signal-soft/70 px-2.5 py-1 text-[11px] font-semibold text-signal-deep">
          On your dashboard
        </span>
        <h3 className="mt-3 font-display text-lg font-semibold tracking-tight text-ink">
          See the revenue it captures
        </h3>
        <p className="mt-2 flex-1 text-[14px] leading-relaxed text-ink-muted">
          Every booking it saves — especially the after-hours calls you’d have missed — adds up on your
          dashboard. Watch the receptionist pay for itself, in real dollars.
        </p>
      </div>

      {/* Answers from your docs */}
      <div className="flex h-full flex-col rounded-3xl border border-line/70 bg-white p-7 shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-card-hover">
        <div className="rounded-2xl bg-paper/70 p-4 ring-1 ring-inset ring-ink/5">
          <ChatBubbles
            lines={[
              { role: 'caller', text: 'Do you take Cigna insurance?' },
              { role: 'agent', text: 'Yes — we’re in-network with Cigna and most major PPOs.' },
            ]}
          />
          <div className="mt-2.5 flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-inset ring-ink/5">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3.5 w-3.5 shrink-0 text-signal-deep">
              <path d="M4 2.5h5L12 5.5v8H4z" strokeLinejoin="round" />
              <path d="M9 2.5V6h3M6 9h4M6 11h4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <p className="text-[11px] font-medium text-ink-muted">Answered from your uploaded documents</p>
          </div>
        </div>
        <span className="mt-5 inline-flex w-fit items-center rounded-full bg-clinic-soft px-2.5 py-1 text-[11px] font-semibold text-[#0b8a74]">
          Knowledge base
        </span>
        <h3 className="mt-3 font-display text-lg font-semibold tracking-tight text-ink">
          Answers from your own docs
        </h3>
        <p className="mt-2 flex-1 text-[14px] leading-relaxed text-ink-muted">
          Upload your pricing, insurance list, services or FAQs and it answers callers straight from them —
          accurately, in your words, with no scripting.
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------- page ---------------------------------- */

export default function LandingPage() {
  const { status } = useAuth();
  const authed = status === 'authenticated';
  const primaryHref = authed ? '/dashboard' : '/register';
  const primaryLabel = authed ? 'Open dashboard' : 'Get started';

  // Founder can hide the demo from the admin panel. Fail open (show it) so a
  // status hiccup never blanks the marketing centerpiece.
  const [demoOn, setDemoOn] = useState<boolean | null>(null);
  useEffect(() => {
    DemoApi.status()
      .then((r) => setDemoOn(r.enabled))
      .catch(() => setDemoOn(true));
  }, []);
  const showDemo = demoOn === true;

  // Mobile nav menu (the desktop links are hidden under md).
  const [menuOpen, setMenuOpen] = useState(false);
  // Order mirrors the on-page scroll order so the nav reads as a table of
  // contents; "Savings" points at the ROI calculator, which was previously
  // unreachable from the nav.
  const navLinks = [
    { href: '#how', label: 'How it works' },
    ...(showDemo ? [{ href: '#demo', label: 'Demo' }] : []),
    { href: '#industries', label: 'Industries' },
    { href: '#roi', label: 'Savings' },
    { href: '#pricing', label: 'Pricing' },
    { href: '#book', label: 'Book a call' },
    { href: '#faq', label: 'FAQ' },
  ];

  // Scroll-spy: highlight the nav link for whatever section is centered in the
  // viewport, so visitors always know where they are in a long page.
  const [activeId, setActiveId] = useState('');
  useEffect(() => {
    const ids = ['how', 'demo', 'industries', 'roi', 'pricing', 'book', 'faq'];
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const onscreen = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (onscreen[0]) setActiveId(onscreen[0].target.id);
      },
      // A section becomes "active" once it crosses the middle of the viewport.
      { rootMargin: '-45% 0px -50% 0px' },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [showDemo]);

  return (
    <div className="relative text-ink">
      {/* Ambient sound-wave backdrop (fixed, behind everything). */}
      <WaveBackground />
      {/* ---------------------------- header (bar + nav) ------------------------- */}
      <header className="fixed inset-x-0 top-0 z-50">
        {/* announcement / trust bar */}
        <a
          href="#demo"
          className="group block bg-ink text-white"
        >
          <div className="mx-auto flex h-9 max-w-6xl items-center justify-center gap-2 px-6 text-[12.5px] font-medium">
            <span className="flex h-1.5 w-1.5 shrink-0 rounded-full bg-clinic" aria-hidden />
            <span className="text-white/85">New — talk to a live AI receptionist right in your browser</span>
            <span className="hidden items-center gap-1 font-semibold text-clinic transition-transform group-hover:translate-x-0.5 sm:inline-flex">
              Try the demo
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3">
                <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>
        </a>
        {/* nav */}
        <div className="border-b border-line/60 bg-white/80 backdrop-blur-md">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6" aria-label="Main">
          <Link href="/">
            <Logo />
          </Link>
          <div className="hidden items-center gap-7 text-sm font-medium text-ink-muted md:flex">
            {navLinks.map((l) => {
              const active = activeId === l.href.slice(1);
              return (
                <a
                  key={l.href}
                  href={l.href}
                  aria-current={active ? 'true' : undefined}
                  className={`relative transition-colors ${
                    active ? 'text-signal-deep' : 'hover:text-ink'
                  }`}
                >
                  {l.label}
                  <span
                    aria-hidden
                    className={`absolute -bottom-1.5 left-0 h-0.5 rounded-full bg-signal transition-all duration-300 ${
                      active ? 'w-full opacity-100' : 'w-0 opacity-0'
                    }`}
                  />
                </a>
              );
            })}
          </div>
          <div className="flex items-center gap-3">
            {!authed && (
              <Link
                href="/login"
                className="hidden text-sm font-medium text-ink-muted transition-colors hover:text-ink sm:block"
              >
                Sign in
              </Link>
            )}
            <Link
              href={primaryHref}
              className="rounded-full bg-gradient-to-b from-signal to-signal-deep px-4 py-2 text-sm font-semibold text-white shadow-pop transition-all duration-300 ease-smooth hover:-translate-y-px hover:shadow-lift active:translate-y-0"
            >
              {primaryLabel}
            </Link>
            {/* hamburger — mobile only */}
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-ink md:hidden"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
                {menuOpen ? (
                  <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
                ) : (
                  <path d="M3 6h14M3 10h14M3 14h14" strokeLinecap="round" />
                )}
              </svg>
            </button>
          </div>
        </nav>

        {/* mobile dropdown menu */}
        {menuOpen && (
          <div className="animate-fade-up border-t border-line/60 bg-white px-6 py-4 md:hidden">
            <div className="flex flex-col gap-1">
              {navLinks.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setMenuOpen(false)}
                  className="rounded-lg px-3 py-2.5 text-[15px] font-medium text-ink-muted transition-colors hover:bg-paper hover:text-ink"
                >
                  {l.label}
                </a>
              ))}
              {!authed && (
                <Link
                  href="/login"
                  onClick={() => setMenuOpen(false)}
                  className="rounded-lg px-3 py-2.5 text-[15px] font-medium text-ink-muted transition-colors hover:bg-paper hover:text-ink"
                >
                  Sign in
                </Link>
              )}
            </div>
          </div>
        )}
        </div>
      </header>

      {/* --------------------------------- hero --------------------------------- */}
      <section className="relative overflow-hidden px-6 pb-24 pt-44 md:pt-52">
        <div className="relative mx-auto grid max-w-6xl items-center gap-16 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <Reveal>
              <span className="inline-flex items-center gap-2 rounded-full border border-signal/15 bg-white/70 px-3.5 py-1.5 text-[13px] font-medium text-signal-deep shadow-input backdrop-blur">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute h-full w-full animate-pulse-ring rounded-full bg-signal" />
                  <span className="relative h-1.5 w-1.5 rounded-full bg-signal" />
                </span>
                AI receptionist · answers in under a second
              </span>
            </Reveal>
            <Reveal delay={80}>
              <h1 className="mt-6 font-display text-[46px] font-semibold leading-[1.03] tracking-[-0.035em] text-ink md:text-[68px]">
                Your phone is answered.
                <br />
                <span className="bg-gradient-to-r from-signal to-signal-deep bg-clip-text text-transparent">
                  Your calendar fills itself.
                </span>
              </h1>
            </Reveal>
            <Reveal delay={160}>
              <p className="mt-6 max-w-[500px] text-[19px] leading-relaxed text-ink-muted">
                VoiceFront answers every call with a voice your customers can’t tell from a person —
                then books the appointment straight into your calendar. 24/7. No hold music. No missed revenue.
              </p>
            </Reveal>
            <Reveal delay={240}>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link
                  href={primaryHref}
                  className="rounded-full bg-gradient-to-b from-signal to-signal-deep px-7 py-3.5 text-[15px] font-semibold text-white shadow-pop transition-all duration-300 ease-smooth hover:-translate-y-0.5 hover:shadow-lift active:translate-y-0"
                >
                  {authed ? 'Open your dashboard' : 'Get started — it’s live in minutes'}
                </Link>
                <a
                  href="#demo"
                  className="group flex items-center gap-2 rounded-full border border-line bg-white/80 px-6 py-3.5 text-[15px] font-semibold text-ink shadow-input backdrop-blur transition-all duration-300 ease-smooth hover:-translate-y-0.5 hover:border-ink-muted/30 hover:shadow-card"
                >
                  Watch it book a call
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 transition-transform duration-300 ease-smooth group-hover:translate-y-0.5">
                    <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </a>
              </div>
            </Reveal>
            <Reveal delay={320}>
              <p className="mt-8 text-[13px] font-medium text-ink-muted/70">
                Built on Vapi · OpenAI · Deepgram — the same stack behind millions of AI calls
              </p>
            </Reveal>
          </div>
          <Reveal delay={200} className="flex justify-center lg:justify-end">
            <CallCard />
          </Reveal>
        </div>
      </section>

      {/* ------------------------------ social proof ----------------------------- */}
      <section className="border-t border-line/60 px-6 py-10">
        <div className="mx-auto max-w-5xl">
          <Reveal className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-muted/70">
              Built for the front desks that can’t miss a call
            </p>
          </Reveal>
          <Reveal delay={80}>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-x-10 gap-y-5">
              {[
                { name: 'Dental & medical', d: 'M5 9h14M5 9a7 7 0 0 0 14 0M9 9V5h6v4M10 19h4M12 16v3' },
                { name: 'Home services', d: 'M3 11.5 12 4l9 7.5M6 10v9h12v-9M10 19v-5h4v5' },
                { name: 'Salons & spas', d: 'M7 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 6 10 9M17 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm0 6L7 19' },
                { name: 'Legal & pro', d: 'M12 3v18M5 8h14M7 8l-3 6a3 3 0 0 0 6 0L7 8Zm10 0-3 6a3 3 0 0 0 6 0l-3-6Z' },
                { name: 'Real estate', d: 'M4 11.5 12 5l8 6.5M6 10v9h5v-5h2v5h5v-9' },
              ].map((seg) => (
                <span key={seg.name} className="inline-flex items-center gap-2.5 text-ink-muted">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5 text-signal/70" strokeLinecap="round" strokeLinejoin="round">
                    <path d={seg.d} />
                  </svg>
                  <span className="text-sm font-semibold tracking-tight text-ink/80">{seg.name}</span>
                </span>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* --------------------- how every call works (console) -------------------- */}
      <section id="how" className="relative px-6 py-24 md:py-32">
        <div className="mx-auto max-w-5xl">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">
              How every call works
            </p>
            <h2 className="mt-4 font-display text-4xl font-semibold tracking-[-0.02em] md:text-[44px]">
              See exactly what happens — before they hang up.
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-ink-muted">
              Watch the receptionist handle a real call end to end: it reads the caller, books or
              schedules a callback, answers questions, and writes the summary — all on your calendar,
              never double-booked.
            </p>
          </Reveal>

          <Reveal delay={120} className="mt-12">
            <WorkflowConsole />
          </Reveal>

          {/* the three things prospects always ask */}
          <div className="mt-16 grid gap-5 md:grid-cols-3">
            {[
              {
                icon: (
                  <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z M9 12l2 2 4-4" strokeLinejoin="round" strokeLinecap="round" />
                ),
                title: 'No double-booking, ever',
                body: 'Sync your Google or Outlook calendar, or just block busy times in your control panel. Every call checks real availability — two callers can never grab the same slot.',
              },
              {
                icon: (
                  <>
                    <circle cx="9" cy="8" r="3" />
                    <path d="M3 20a6 6 0 0 1 12 0M17 8a3 3 0 0 1 0 6M19 20a6 6 0 0 0-3-5.2" strokeLinecap="round" strokeLinejoin="round" />
                  </>
                ),
                title: 'New & returning callers',
                body: 'It welcomes new customers, recognizes returning ones, books appointments, schedules callbacks, and answers questions — then logs the exact outcome of every call.',
              },
              {
                icon: (
                  <path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4L12 3zM5 16l.9 2.3L8 19l-2.1.7L5 22l-.9-2.3L2 19l2.1-.7L5 16z" strokeLinejoin="round" strokeLinecap="round" />
                ),
                title: 'Want it built for you?',
                body: 'We also build fully custom agents around your workflows, scripts, and tools. Book a 15-minute call with our founder and we deliver one tailored to your business.',
                cta: { href: '#book', label: 'Book a call with the founder' },
              },
            ].map((card, i) => (
              <Reveal key={card.title} delay={i * 120}>
                <div className="flex h-full flex-col rounded-3xl border border-line/70 bg-white/80 p-7 shadow-card backdrop-blur transition-all duration-300 ease-smooth hover:-translate-y-1 hover:shadow-card-hover">
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-signal-soft/70 text-signal-deep">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
                      {card.icon}
                    </svg>
                  </span>
                  <h3 className="mt-5 font-display text-lg font-semibold tracking-tight text-ink">{card.title}</h3>
                  <p className="mt-2.5 flex-1 text-[14.5px] leading-relaxed text-ink-muted">{card.body}</p>
                  {card.cta && (
                    <a
                      href={card.cta.href}
                      className="group mt-4 inline-flex items-center gap-1.5 text-[14px] font-semibold text-signal-deep transition-colors hover:text-signal"
                    >
                      {card.cta.label}
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5 transition-transform duration-300 ease-smooth group-hover:translate-x-0.5">
                        <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </a>
                  )}
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------- stat band ------------------------------- */}
      <section className="border-y border-line/60 bg-surface/70 px-6 py-14">
        <div className="mx-auto grid max-w-5xl gap-10 text-center sm:grid-cols-3">
          {[
            { n: '62%', d: 'of callers hang up on voicemail and call a competitor instead' },
            { n: '24/7', d: 'every call answered — nights, weekends and lunch rushes included' },
            { n: '< 1s', d: 'pickup time, before the second ring, every single time' },
          ].map((stat, i) => (
            <Reveal key={stat.n} delay={i * 100}>
              <p className="font-display text-5xl font-bold tracking-tight text-ink">{stat.n}</p>
              <p className="mx-auto mt-3 max-w-[260px] text-sm leading-relaxed text-ink-muted">{stat.d}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ------------------------------- live demo ------------------------------- */}
      {showDemo && (
      <section id="demo" className="relative overflow-hidden bg-ink px-6 py-24 md:py-32">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_30%_0%,rgba(16,169,142,0.16),transparent),radial-gradient(40%_40%_at_90%_100%,rgba(14,107,99,0.16),transparent)]"
        />
        <div className="relative mx-auto max-w-6xl">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-soft/70">The product, live</p>
            <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight text-white md:text-5xl">
              Watch it book. In real time.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-white/60">
              A customer calls. The receptionist checks your real availability, holds the conversation,
              and the appointment lands on your calendar before they hang up.
            </p>
          </Reveal>
          <Reveal delay={150} className="mt-14">
            <InteractiveDemo />
          </Reveal>
          <Reveal delay={250} className="mt-12 text-center">
            <Link
              href={primaryHref}
              className="inline-block rounded-full bg-white px-7 py-3.5 text-[15px] font-semibold text-ink shadow-lift transition-all duration-150 hover:-translate-y-0.5"
            >
              Try it with your own voice — free in-browser test call
            </Link>
            <p className="mt-4 text-sm text-white/40">Create a workspace, press “Test call”, and talk to your receptionist.</p>
          </Reveal>
        </div>
      </section>
      )}

      {/* ------------------------------ getting set up --------------------------- */}
      <section className="px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <Reveal className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">Up and running</p>
            <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight md:text-[44px]">
              Live before your next missed call.
            </h2>
          </Reveal>
          <div className="mt-14 grid gap-5 md:grid-cols-3">
            {[
              {
                step: '01',
                title: 'Tell it about your business',
                body: 'Pick your industry, set hours and timezone, and shape how it greets callers. Industry-tuned scripts come ready out of the box.',
              },
              {
                step: '02',
                title: 'Pick a voice & your number',
                body: 'Choose from twelve human-grade voices or bring your own ElevenLabs voice. Keep your existing phone number — just forward it.',
              },
              {
                step: '03',
                title: 'Watch the calendar fill',
                body: 'Every call answered, every booking on your calendar, every message transcribed. Change a setting and the very next call uses it.',
              },
            ].map((item, i) => (
              <Reveal key={item.step} delay={i * 120}>
                <div className="group h-full rounded-3xl border border-line/70 bg-white p-8 shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-card-hover">
                  <span className="font-mono text-sm font-semibold text-signal-deep">{item.step}</span>
                  <h3 className="mt-4 font-display text-xl font-semibold tracking-tight">{item.title}</h3>
                  <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">{item.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------- features ------------------------------- */}
      <section className="border-y border-line/60 bg-paper/50 px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <Reveal className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">What it does</p>
            <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight md:text-[44px]">
              A real receptionist’s job. Done flawlessly.
            </h2>
          </Reveal>
          <div className="mt-14 grid gap-5 md:grid-cols-3">
            <Reveal className="md:col-span-2">
              <div className="h-full rounded-3xl border border-line/70 bg-white p-8 shadow-card">
                <div className="flex items-start justify-between gap-6">
                  <div className="max-w-md">
                    <h3 className="font-display text-xl font-semibold tracking-tight">Books real appointments</h3>
                    <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">
                      It checks your live availability mid-call, only offers slots that are actually open,
                      and writes the booking to your calendar instantly. Two callers can never take the same slot.
                    </p>
                  </div>
                  <span className="hidden shrink-0 rounded-2xl bg-signal-soft/70 p-4 text-signal-deep sm:block">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-8 w-8">
                      <rect x="3" y="5" width="18" height="16" rx="3" />
                      <path d="M3 10h18M8 3v4M16 3v4M8.5 14.5l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </div>
                <div className="mt-6 flex flex-wrap gap-2">
                  {['Live availability', 'Double-booking guard', 'Timezone aware', 'Manual bookings too'].map((tag) => (
                    <span key={tag} className="rounded-full bg-paper px-3 py-1 text-xs font-medium text-ink-muted ring-1 ring-inset ring-ink/5">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </Reveal>
            {[
              {
                title: 'Sounds human',
                body: 'Twelve premium voices, optional office ambience, natural pacing. Or plug in your own ElevenLabs voice.',
                icon: <path d="M12 4v16M8 8v8M16 8v8M4 11v2M20 11v2" strokeLinecap="round" />,
              },
              {
                title: 'Transfers when it matters',
                body: 'Emergencies and VIPs route straight to your real lines — your rules decide who gets through.',
                icon: <path d="M5 4h4l2 5-2.5 2a12 12 0 0 0 4.5 4.5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" strokeLinejoin="round" />,
              },
              {
                title: 'Every call on record',
                body: 'Transcripts, summaries and recordings for every conversation — searchable in your dashboard.',
                icon: <path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h3" strokeLinecap="round" strokeLinejoin="round" />,
              },
              {
                title: 'Knows your hours',
                body: 'Open, closed, lunch, holidays — it greets accordingly, takes messages after hours, never books when you’re shut.',
                icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" strokeLinecap="round" /></>,
              },
              {
                title: 'You stay in control',
                body: 'Change the greeting, voice, hours or transfer rules anytime — the very next call uses your new setup.',
                icon: <path d="M4 8h10M18 8h2M4 16h2M10 16h10M16 5.5v5M8 13.5v5" strokeLinecap="round" />,
              },
            ].map((feature, i) => (
              <Reveal key={feature.title} delay={(i % 3) * 100}>
                <div className="h-full rounded-3xl border border-line/70 bg-white p-8 shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-card-hover">
                  <span className="inline-block rounded-xl bg-signal-soft/70 p-3 text-signal-deep">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-6 w-6">
                      {feature.icon}
                    </svg>
                  </span>
                  <h3 className="mt-5 font-display text-lg font-semibold tracking-tight">{feature.title}</h3>
                  <p className="mt-2.5 text-[14px] leading-relaxed text-ink-muted">{feature.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------- beyond answering --------------------------- */}
      <section className="border-t border-line/60 bg-surface/50 px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">Beyond answering</p>
            <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight md:text-[44px]">
              It doesn’t just answer. It wins you the work.
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-ink-muted">
              Answering and booking are table stakes. Where VoiceFront earns its keep is the harder work a
              great receptionist does — the handoffs, the revenue, and the answers only your business knows.
            </p>
          </Reveal>
          <Reveal delay={150} className="mt-12">
            <BeyondAnswering />
          </Reveal>
        </div>
      </section>

      {/* ----------------------------- integrations ------------------------------ */}
      <section className="px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <div className="grid items-center gap-12 lg:grid-cols-[0.95fr_1.05fr]">
            <Reveal>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">Fits your setup</p>
              <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight md:text-[44px]">
                Works with what you already use.
              </h2>
              <p className="mt-5 max-w-md text-lg leading-relaxed text-ink-muted">
                Keep your number, your voice and your calendar. VoiceFront slots in behind the line you
                already give out — nothing to rip out, nothing for your team to relearn.
              </p>
              <ul className="mt-7 flex flex-col gap-3">
                {[
                  'Forward your existing number — always, after hours, or on no-answer',
                  'Premium neural voices, or bring your own ElevenLabs voice',
                  'Bookings land in your VoiceFront calendar the moment the call ends',
                ].map((line) => (
                  <li key={line} className="flex items-start gap-3 text-[15px] text-ink">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-signal-soft ring-1 ring-inset ring-signal/20">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3 text-signal-deep">
                        <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    {line}
                  </li>
                ))}
              </ul>
            </Reveal>
            <Reveal delay={120}>
              <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
                {[
                  { name: 'Your phone number', tag: 'Forwarding', icon: <path d="M5 4h4l2 5-2.5 2a12 12 0 0 0 4.5 4.5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" strokeLinejoin="round" /> },
                  { name: 'ElevenLabs', tag: 'Voices', icon: <path d="M12 4v16M8 8v8M16 8v8M4 11v2M20 11v2" strokeLinecap="round" /> },
                  { name: 'VoiceFront calendar', tag: 'Bookings', icon: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" /></> },
                  { name: 'Google Calendar', tag: 'Two-way sync', icon: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" /></> },
                  { name: 'Microsoft 365', tag: 'Two-way sync', icon: <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></> },
                  { name: 'Webhooks & CRM', tag: 'API · soon', soon: true, icon: <path d="M9 7a3 3 0 1 1 4.2 2.7L12 14M12 17v.01M6 12a6 6 0 1 1 12 0" strokeLinecap="round" strokeLinejoin="round" /> },
                ].map((it) => (
                  <div
                    key={it.name}
                    className="flex flex-col gap-3 rounded-2xl border border-line/70 bg-white p-4 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover"
                  >
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-surface text-signal-deep ring-1 ring-inset ring-line/70">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-5 w-5">
                        {it.icon}
                      </svg>
                    </span>
                    <div>
                      <p className="text-[13px] font-semibold leading-tight tracking-tight text-ink">{it.name}</p>
                      <p className={`mt-0.5 text-[11px] font-medium ${it.soon ? 'text-construction' : 'text-ink-muted'}`}>{it.tag}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------- industries ------------------------------ */}
      <section id="industries" className="border-t border-line/60 bg-surface/50 px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">Industries</p>
            <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight md:text-[44px]">
              Trained for your front desk.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-ink-muted">
              Not a generic chatbot with a phone number — a receptionist that already speaks your industry’s language.
            </p>
          </Reveal>
          <Reveal delay={150} className="mt-12">
            <IndustryTabs />
          </Reveal>
        </div>
      </section>

      {/* ----------------------------- ROI calculator ----------------------------- */}
      <section id="roi" className="border-t border-line/60 px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">The math</p>
            <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight md:text-[44px]">
              What are missed calls costing you?
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-ink-muted">
              Every unanswered call is a booking that went to whoever picked up. Tell us about your
              business — the numbers are real Vancouver-area averages, and you can change any of them.
            </p>
          </Reveal>
          <Reveal delay={150} className="mt-12">
            <ROICalculator />
          </Reveal>
        </div>
      </section>

      {/* --------------------------------- pricing -------------------------------- */}
      <section id="pricing" className="px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <div className="relative overflow-hidden rounded-[32px] border border-line/70 bg-white px-8 py-16 shadow-lift md:px-16 md:py-20">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_55%_at_85%_0%,rgba(14,107,99,0.07),transparent),radial-gradient(40%_50%_at_5%_100%,rgba(16,169,142,0.06),transparent)]"
            />
            <div className="relative grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
              <div>
                <Reveal>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">Pricing</p>
                  <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight text-ink md:text-[44px]">
                    Priced around your calls,
                    <br />
                    not a one-size plan.
                  </h2>
                  <p className="mt-5 max-w-lg text-lg leading-relaxed text-ink-muted">
                    A solo contractor and a three-location clinic shouldn’t pay the same.
                    Tell us your call volume and we’ll quote a plan that pays for itself —
                    most customers cover it with the first few bookings it saves.
                  </p>
                </Reveal>
                <Reveal delay={120}>
                  <div className="mt-9 flex flex-wrap items-center gap-4">
                    <a
                      href="#book"
                      className="rounded-full bg-gradient-to-b from-signal to-signal-deep px-7 py-3.5 text-[15px] font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-0.5 hover:shadow-lift"
                    >
                      Book a call
                    </a>
                    <Link
                      href={primaryHref}
                      className="rounded-2xl border border-line bg-white px-7 py-3.5 text-[15px] font-semibold text-ink shadow-input transition-colors duration-150 hover:border-ink-muted/40"
                    >
                      Try the product first
                    </Link>
                  </div>
                  <p className="mt-5 text-sm text-ink-muted/80">Custom quote within a day · no contracts · no setup fees · cancel anytime</p>
                </Reveal>
              </div>
              <Reveal delay={200}>
                <div className="rounded-3xl border border-signal/15 bg-signal-soft/40 p-8">
                  <p className="text-sm font-semibold uppercase tracking-[0.12em] text-signal-deep">Every plan includes</p>
                  <ul className="mt-5 grid gap-3">
                    {[
                      '24/7 AI receptionist on your number',
                      'Real-time appointment booking & calendar',
                      'Premium voices + ElevenLabs support',
                      'Smart transfers to your team',
                      'Transcripts, recordings & summaries',
                      'Unlimited staff seats on the dashboard',
                      'White-glove setup & onboarding',
                    ].map((item) => (
                      <li key={item} className="flex items-start gap-3 text-[15px] text-ink">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-signal text-white shadow-sm">
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                            <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------- book a call ------------------------------ */}
      <section id="book" className="border-t border-line/60 bg-surface/50 px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">Talk to a human</p>
            <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight md:text-[44px]">
              Rather just book a call?
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-ink-muted">
              Prefer a real conversation? Grab a time that suits you — pick a slot on our real calendar,
              tell us a little about your business, and we&apos;ll walk you through exactly how VoiceFront
              would fit. No account needed.
            </p>
          </Reveal>
          <Reveal delay={150} className="mt-12">
            <BookCallSection />
          </Reveal>
        </div>
      </section>

      {/* ----------------------------------- FAQ ---------------------------------- */}
      <section id="faq" className="border-t border-line/60 bg-paper/50 px-6 py-24 md:py-32">
        <div className="mx-auto max-w-3xl">
          <Reveal className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">FAQ</p>
            <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight md:text-[44px]">
              The questions everyone asks.
            </h2>
          </Reveal>
          <div className="mt-12 flex flex-col gap-3">
            {FAQS.map((faq, i) => (
              <Reveal key={faq.q} delay={i * 60}>
                <details className="group rounded-2xl border border-line/70 bg-white px-6 py-5 shadow-card transition-shadow open:shadow-card-hover">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
                    {faq.q}
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-paper text-ink-muted ring-1 ring-inset ring-ink/5 transition-transform duration-200 group-open:rotate-45">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
                        <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
                      </svg>
                    </span>
                  </summary>
                  <p className="mt-4 text-[15px] leading-relaxed text-ink-muted">{faq.a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------- final CTA ------------------------------- */}
      <section className="px-6 py-24 md:py-28">
        <div className="mx-auto max-w-6xl">
          <Reveal>
            <div className="relative overflow-hidden rounded-[32px] bg-gradient-to-br from-signal to-signal-deep px-8 py-16 text-center md:py-20">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 [background-image:radial-gradient(rgba(255,255,255,0.14)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:radial-gradient(70%_70%_at_50%_50%,black,transparent)]"
              />
              <h2 className="relative mx-auto max-w-2xl font-display text-4xl font-semibold tracking-tight text-white md:text-5xl">
                Stop losing calls.
                <br />
                Start booking appointments.
              </h2>
              <p className="relative mx-auto mt-5 max-w-md text-lg text-white/75">
                Your receptionist is two minutes away from answering its first call.
              </p>
              <div className="relative mt-9 flex flex-wrap items-center justify-center gap-4">
                <Link
                  href={primaryHref}
                  className="rounded-full bg-white px-8 py-4 text-[15px] font-bold text-signal-deep shadow-lift transition-all duration-150 hover:-translate-y-0.5"
                >
                  {primaryLabel}
                </Link>
                {!authed && (
                  <Link
                    href="/login"
                    className="rounded-full border border-white/30 px-8 py-4 text-[15px] font-semibold text-white transition-colors hover:bg-white/10"
                  >
                    Sign in
                  </Link>
                )}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* --------------------------------- footer --------------------------------- */}
      <footer className="border-t border-line/60 px-6 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 sm:flex-row">
          <Link href="/" aria-label="VoiceFront home">
            <Logo size="sm" />
          </Link>
          <div className="flex items-center gap-6 text-sm text-ink-muted">
            <a href="#demo" className="transition-colors hover:text-ink">Demo</a>
            <a href="#pricing" className="transition-colors hover:text-ink">Pricing</a>
            <a href="#faq" className="transition-colors hover:text-ink">FAQ</a>
            <Link href="/dashboard" className="transition-colors hover:text-ink">Dashboard</Link>
          </div>
          <p className="text-xs text-ink-muted/70">© 2026 VoiceFront. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
