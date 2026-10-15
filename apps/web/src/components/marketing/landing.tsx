'use client';

// Shared marketing widgets used across the multipage site. The page sections
// and site chrome live in ./sections; this module is just the reusable pieces.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import {
  DemoApi,
  ApiError,
  type ClinicFacts,
  type DemoAppointment,
  type DemoDay,
  type DemoKind,
  type DemoLeadResponse,
  type DemoIndustry,
  type DemoCallSummary,
} from '@/lib/api';
import { VoiceSession, type SimulatorPhase, type TranscriptEntry } from '@/lib/voice-client';

/* ------------------------------ scroll reveal ----------------------------- */

export function Reveal({
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


/* ------------------------- live demo (dark section) ------------------------ */

type DemoPhase = 'idle' | 'requesting' | SimulatorPhase;

const DEMO_SCENARIOS = [
  { tag: 'Just talk', text: 'Tell Ava about your business — she leads from there.' },
  { tag: 'Book it live', text: 'Ask her to book an appointment — watch the calendar fill in real time.' },
  { tag: 'Try to double-book', text: 'Block an open slot below, then ask for that exact time — watch her refuse.' },
  { tag: 'Get the recap', text: 'Hang up and see the clean summary she leaves behind.' },
];

/** The same four beats for Maya's in-browser demo (Canadian receptionist
 *  visitors). Hers are the receptionist versions: answer, book, one hold
 *  only, recap. */
const MAYA_SCENARIOS = [
  { tag: 'Just talk', text: 'Say hi and ask about hours or services. She answers from your clinic facts.' },
  { tag: 'Book it live', text: 'Ask her for a cleaning. Watch the booking land on the calendar.' },
  { tag: 'One booking only', text: 'Try to get a second appointment held too. The system allows exactly one.' },
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

type DemoView = 'form' | 'confirm' | 'choose' | 'web' | 'call';

/** What a demo submit did, in words. When Lyla asks for the submit, she
 *  hears exactly this outcome (the 'lyla:demo-status' event below), the
 *  same result the visitor sees on the form; the form's own onSubmit
 *  ignores the return value and behaves exactly as before. */
type DemoSubmitOutcome = { ok: true; view: DemoView } | { ok: false; reason: string };

/** Lead-capture form state. `industry` starts unset so the user must pick one. */
interface DemoFormState {
  name: string;
  email: string;
  phone: string;
  industry: DemoIndustry | null;
  /** Optional — when given, shown on the demo calendar instead of a placeholder. */
  businessName: string;
  /** Optional clinic website; only used by the receptionist demo kind. */
  website: string;
}

/** Editable state for the confirm step: the facts Maya will use, pre-filled
 *  from what was pulled off the clinic website (or blank when the pull found
 *  nothing). Hours and services are kept as single text fields for editing. */
interface ConfirmFactsState {
  clinicName: string;
  hours: string;
  services: string;
  address: string;
  /** True when at least one field was pre-filled from the website pull. */
  pulledFacts: boolean;
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
  { key: 'contractor', label: 'Contractor / trades', hint: 'Builders and trades' },
  { key: 'other', label: 'Something else', hint: 'Salon, law, services' },
];

/** The two demo kinds the prospect can pick between. */
const DEMO_KINDS: Array<{ key: DemoKind; label: string; hint: string }> = [
  { key: 'receptionist', label: 'Hear your clinic answered', hint: 'Maya calls you as your clinic' },
  { key: 'sales', label: 'Hear the pitch', hint: 'Ava walks you through VoiceFront' },
];

/* --------------------------- Cloudflare Turnstile -------------------------- */

/**
 * Public Turnstile site key (safe to expose: it only identifies the site).
 * When it is unset, the lead form renders no bot check and behaves exactly
 * as it did before Turnstile was wired up. When it is set, the API expects
 * a token with every lead once its matching secret is configured, so the
 * form waits for one before it lets a submit through.
 */
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
}

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

/**
 * The Turnstile challenge for the demo lead form, rendered explicitly once
 * its script arrives. Tokens go up through onToken (null when a token
 * expires or the challenge errors), and a reset function is registered on
 * resetRef: tokens are single-use, so the form resets the widget after
 * every submit attempt and a retry always gets a fresh challenge.
 */
function TurnstileWidget({
  onToken,
  resetRef,
}: {
  onToken: (token: string | null) => void;
  resetRef: React.MutableRefObject<(() => void) | null>;
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
      if (cancelled || widgetIdRef.current || !containerRef.current || !window.turnstile) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(null),
        'error-callback': () => onTokenRef.current(null),
      });
      resetRef.current = () => {
        if (widgetIdRef.current && window.turnstile) window.turnstile.reset(widgetIdRef.current);
      };
    };

    if (window.turnstile) {
      renderWidget();
    } else {
      // Load the script at most once per page, however many widgets mount.
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
      if (widgetIdRef.current && window.turnstile) window.turnstile.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [resetRef]);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={containerRef} className="flex justify-center" />;
}

function DemoLeadForm({
  form,
  setForm,
  demoKind,
  setDemoKind,
  submitting,
  error,
  onSubmit,
  turnstileToken,
  onTurnstileToken,
  turnstileResetRef,
}: {
  form: DemoFormState;
  setForm: React.Dispatch<React.SetStateAction<DemoFormState>>;
  demoKind: DemoKind;
  setDemoKind: (kind: DemoKind) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: (e: React.FormEvent) => void;
  turnstileToken: string | null;
  onTurnstileToken: (token: string | null) => void;
  turnstileResetRef: React.MutableRefObject<(() => void) | null>;
}) {
  // With a bot check on the form, a submit has to wait for its token: the
  // API rejects tokenless leads once its Turnstile secret is configured.
  const awaitingTurnstile = Boolean(TURNSTILE_SITE_KEY) && !turnstileToken;
  return (
    <div className="mx-auto max-w-xl">
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.04] p-7 backdrop-blur sm:p-9"
      >
        <div className="text-center">
          <h3 className="font-display text-[22px] font-semibold tracking-tight text-white">
            Talk to our AI, live, right now
          </h3>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">
            Drop your details and she’ll walk you through exactly how VoiceFront answers, books, and
            never double-books, tuned to your line of work.
          </p>
        </div>

        {/* Demo kind: the receptionist demo is the headline experience. */}
        <div className="mt-1 flex flex-col gap-1.5 text-left">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-white/45">
            Which demo do you want?
          </span>
          <div className="grid grid-cols-2 gap-2">
            {DEMO_KINDS.map((opt) => {
              const selected = demoKind === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setDemoKind(opt.key)}
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

          {/* Receptionist kind only: the clinic website Maya dresses in. */}
          {demoKind === 'receptionist' && (
            <label className="flex flex-col gap-1.5 text-left">
              <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-white/45">
                Clinic website
                <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-white/40">
                  optional
                </span>
              </span>
              <input
                type="url"
                value={form.website}
                onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
                placeholder="https://yourclinic.ca"
                autoComplete="url"
                maxLength={300}
                className="rounded-xl border border-white/15 bg-white/[0.06] px-4 py-3 text-[15px] text-white placeholder:text-white/30 outline-none transition-colors focus:border-signal-soft/70 focus:bg-white/[0.09]"
              />
              <span className="text-[11px] leading-tight text-white/35">
                We pull your hours and services from it, so Maya sounds like she works there. You can fix
                anything on the next screen.
              </span>
            </label>
          )}
        </div>

        {/* Bot check: renders nothing at all when no site key is set. */}
        <TurnstileWidget onToken={onTurnstileToken} resetRef={turnstileResetRef} />

        <button
          type="submit"
          disabled={submitting || awaitingTurnstile}
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

/* --------------------- demo: confirm the clinic facts -------------------- */

/**
 * The receptionist demo's review step: the prospect sees exactly which facts
 * Maya will speak from (pulled from their website) and can fix any of them.
 * What they confirm here is what /call sends, and the server re-sanitizes it.
 */
function DemoConfirmFacts({
  facts,
  setFacts,
  onContinue,
  onBack,
}: {
  facts: ConfirmFactsState;
  setFacts: React.Dispatch<React.SetStateAction<ConfirmFactsState>>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const inputClass =
    'rounded-xl border border-white/15 bg-white/[0.06] px-4 py-3 text-[15px] text-white placeholder:text-white/30 outline-none transition-colors focus:border-signal-soft/70 focus:bg-white/[0.09]';
  const labelClass = 'text-xs font-semibold uppercase tracking-[0.12em] text-white/45';
  return (
    <div className="mx-auto max-w-xl">
      <div className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.04] p-7 backdrop-blur sm:p-9">
        <div className="text-center">
          <h3 className="font-display text-[22px] font-semibold tracking-tight text-white">
            Before Maya calls, check her homework
          </h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/55">
            {facts.pulledFacts
              ? 'We pulled this from your website. Fix anything that looks off.'
              : 'We could not pull details from your website. Add what you would like Maya to use, or leave it general.'}
          </p>
        </div>

        <div className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5 text-left">
            <span className={labelClass}>Clinic name</span>
            <input
              type="text"
              value={facts.clinicName}
              onChange={(e) => setFacts((f) => ({ ...f, clinicName: e.target.value }))}
              placeholder="e.g. Maple Dental Studio"
              maxLength={60}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-left">
            <span className={labelClass}>Hours, one line per day or range</span>
            <textarea
              value={facts.hours}
              onChange={(e) => setFacts((f) => ({ ...f, hours: e.target.value }))}
              placeholder={'Monday to Friday: 8:00 AM to 5:00 PM\nSaturday: 9:00 AM to 2:00 PM'}
              rows={3}
              className={`${inputClass} resize-y`}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-left">
            <span className={labelClass}>Services, separated by commas</span>
            <input
              type="text"
              value={facts.services}
              onChange={(e) => setFacts((f) => ({ ...f, services: e.target.value }))}
              placeholder="Cleanings, Exams, Fillings, Crowns"
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-left">
            <span className={labelClass}>Address</span>
            <input
              type="text"
              value={facts.address}
              onChange={(e) => setFacts((f) => ({ ...f, address: e.target.value }))}
              placeholder="2145 West 4th Avenue, Vancouver"
              maxLength={120}
              className={inputClass}
            />
          </label>
        </div>

        <button
          type="button"
          onClick={onContinue}
          className="mt-1 rounded-full bg-white px-7 py-3.5 text-[15px] font-semibold text-ink shadow-lift transition-transform hover:-translate-y-0.5"
        >
          Looks right, continue
        </button>
        <div className="text-center">
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

/* --------------------------- demo: choose a mode -------------------------- */

function DemoModeChoice({
  lead,
  demoKind,
  clinicName,
  onWeb,
  onMayaWeb,
  onCall,
  onBack,
}: {
  lead: DemoLeadResponse;
  demoKind: DemoKind;
  clinicName: string;
  onWeb: () => void;
  /** Canadian receptionist demo: Maya runs right here in the browser. */
  onMayaWeb: () => void;
  onCall: () => void;
  onBack: () => void;
}) {
  const firstName = lead.name.trim().split(/\s+/)[0];
  // Canadian visitors get Maya's demo in the browser instead of a phone
  // call (the server makes the same call when the demo starts, this card
  // just names it honestly). The phone card stays as their fallback.
  const mayaWeb = demoKind === 'receptionist' && lead.ipCountry === 'CA';
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
          {/* Test on web — always available. For a Canadian receptionist
              demo this card IS Maya, in the browser; anywhere else it is
              the pitch demo with Ava, as before. */}
          {mayaWeb ? (
            <button
              type="button"
              onClick={onMayaWeb}
              className="group flex flex-col items-start gap-2 rounded-2xl border border-white/15 bg-white/[0.06] p-5 text-left transition-all hover:-translate-y-0.5 hover:border-signal-soft/60 hover:bg-white/[0.1]"
            >
              <span className="rounded-full bg-signal/25 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-signal-soft ring-1 ring-inset ring-signal/30">
                In your browser
              </span>
              <span className="text-[16px] font-semibold text-white">Talk to Maya now</span>
              <span className="text-[13px] leading-snug text-white/55">
                Maya answers right here, as the front desk at {clinicName || 'your clinic'}. No phone
                call needed, just your microphone.
              </span>
            </button>
          ) : (
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
          )}

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
                {demoKind === 'receptionist'
                  ? `We’ll ring your phone in a few seconds and Maya will answer as the front desk at ${clinicName || 'your clinic'}.`
                  : 'We’ll ring your phone in a few seconds so you hear it like a real customer would.'}
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

        {demoKind === 'receptionist' &&
          (mayaWeb ? (
            <p className="mt-4 text-center text-[12px] leading-relaxed text-white/40">
              You are visiting from Canada, so Maya runs right here in your browser. Rather get a call?
              The phone option above still works the usual way.
            </p>
          ) : (
            <p className="mt-4 text-center text-[12px] leading-relaxed text-white/40">
              The receptionist demo runs by phone only. The in-browser test above is the pitch demo with Ava.
            </p>
          ))}

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
  demoKind,
  facts,
  clinicName,
  onBack,
  onWeb,
}: {
  lead: DemoLeadResponse;
  demoKind: DemoKind;
  /** The facts the prospect confirmed on the review step (receptionist
   *  kind only); sent with the call so Maya uses exactly these. */
  facts: ClinicFacts | null;
  clinicName: string;
  onBack: () => void;
  onWeb: () => void;
}) {
  const [state, setState] = useState<CallState>({ status: 'idle' });
  const receptionist = demoKind === 'receptionist';

  async function dial() {
    setState({ status: 'dialing' });
    try {
      const res = await DemoApi.call({
        sessionId: lead.sessionId,
        leadId: lead.leadId,
        name: lead.name,
        phone: lead.phone,
        // This view IS the phone choice (for a Canadian it is the
        // fallback they picked on purpose), so opt in explicitly: the
        // server otherwise starts Canadian receptionist demos in the
        // browser.
        ...(receptionist ? { demoKind, delivery: 'phone' as const, ...(facts ? { facts } : {}) } : {}),
      });
      if (res.mode === 'web') {
        // Unreachable with delivery 'phone' — kept so the union narrows.
        setState({ status: 'error', message: 'That demo runs in the browser instead. Head back and pick the in-browser option.' });
        return;
      }
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
              {receptionist ? (
                <>
                  We’re calling <span className="font-semibold text-white">{lead.phone}</span> from{' '}
                  <span className="font-mono text-white/80">{state.fromNumber}</span>. Pick up and talk to Maya like
                  a patient would. Ask for a cleaning, or try a tricky question.
                </>
              ) : (
                <>
                  We’re calling <span className="font-semibold text-white">{lead.phone}</span> from{' '}
                  <span className="font-mono text-white/80">{state.fromNumber}</span>. Pick up and say hi to Ava — she’ll
                  take it from there.
                </>
              )}
            </p>
          </>
        ) : state.status === 'unavailable' ? (
          <>
            <h3 className="mt-5 font-display text-[20px] font-semibold tracking-tight text-white">
              Phone demo isn’t live yet
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/60">
              {receptionist
                ? 'We’re finishing the outbound calling setup. The in-browser pitch demo with Ava is fully live in the meantime.'
                : 'We’re finishing the outbound calling setup. The in-browser test is fully live in the meantime — same Ava, same demo.'}
            </p>
          </>
        ) : (
          <>
            <h3 className="mt-5 font-display text-[20px] font-semibold tracking-tight text-white">
              {receptionist ? 'Hear Maya answer for your clinic' : 'Get a call from Ava'}
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/60">
              {receptionist ? (
                <>
                  We’ll ring <span className="font-semibold text-white">{lead.phone}</span> right now. Maya will
                  greet you as the front desk at {clinicName || 'your clinic'} and book you a short pretend
                  appointment. Nothing is added to a real calendar.
                </>
              ) : (
                <>
                  We’ll ring <span className="font-semibold text-white">{lead.phone}</span> right now. Pick up and run
                  the whole demo by voice — booking, double-booking, the works.
                </>
              )}
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

function DemoIntroStage({ variant = 'sales' }: { variant?: 'sales' | 'receptionist' }) {
  const items =
    variant === 'receptionist'
      ? [
          { t: 'Answers as your front desk', d: 'She greets callers with your clinic name and your hours.' },
          { t: 'Books the appointment', d: 'Ask her for a cleaning and watch it land on the calendar.' },
          { t: 'Never double-books', d: 'One booking per call, held by the system, not by memory.' },
        ]
      : [
          { t: 'Books appointments', d: 'Ask her to book — watch it land on the calendar.' },
          { t: 'Never double-books', d: 'Block a slot and try to trip her up.' },
          { t: 'Sends a summary', d: 'A clean recap the second you hang up.' },
        ];
  return (
    <div className="flex flex-col gap-3 px-5 py-6">
      <p className="text-[13px] text-ink-muted">
        {variant === 'receptionist' ? 'Maya’s about to show you three things, live:' : 'Ava’s about to walk you through three things, live:'}
      </p>
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

function DemoCloseStage({
  variant = 'sales',
  sampleCompany,
}: {
  variant?: 'sales' | 'receptionist';
  sampleCompany?: string;
}) {
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
        {variant === 'receptionist'
          ? `That is exactly how Maya would answer at ${sampleCompany ?? 'your clinic'}. When you are ready, she can be live on your real phones.`
          : 'Ava can book you a quick setup call right now — just tell her a day that works, and watch it land.'}
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
  variant = 'sales',
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
  /** Which agent is driving: Ava's pitch (default) or Maya's web demo. */
  variant?: 'sales' | 'receptionist';
}) {
  const agentName = variant === 'receptionist' ? 'Maya' : 'Ava';
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
    intro: { eyebrow: 'Live demo', title: `What ${agentName} will show you` },
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
                      ? variant === 'receptionist'
                        ? 'Try to get her to hold a second appointment as well. She will refuse, one hold per call, and she will ask before changing anything.'
                        : 'Click any open slot below to block it — then ask Ava to book that exact time and watch her refuse.'
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
          <DemoCloseStage variant={variant} sampleCompany={sampleCompany} />
        ) : (
          <DemoIntroStage variant={variant} />
        )}
      </div>
    </div>
  );
}

export function InteractiveDemo() {
  const [view, setView] = useState<DemoView>('form');
  const [lead, setLead] = useState<DemoLeadResponse | null>(null);
  const [form, setForm] = useState<DemoFormState>({
    name: '',
    email: '',
    phone: '',
    industry: null,
    businessName: '',
    website: '',
  });
  // The receptionist demo is the default: it is the product, not the pitch.
  const [demoKind, setDemoKind] = useState<DemoKind>('receptionist');
  const [confirmFacts, setConfirmFacts] = useState<ConfirmFactsState>({
    clinicName: '',
    hours: '',
    services: '',
    address: '',
    pulledFacts: false,
  });
  // What the prospect confirmed on the review step; sent with the demo call.
  const [confirmedFacts, setConfirmedFacts] = useState<ClinicFacts | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // The lead form's Turnstile token (stays null when no site key is
  // configured and no widget renders) and the widget's reset hook, called
  // after every submit attempt because tokens are single-use.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileResetRef = useRef<(() => void) | null>(null);

  const [phase, setPhase] = useState<DemoPhase>('idle');
  /** Which agent the web console is running: Ava's pitch, or Maya's
   *  receptionist demo (Canadian visitors). */
  const [webAgent, setWebAgent] = useState<'ava' | 'maya'>('ava');
  /** Set when a Maya web start fell back to a phone call server-side (the
   *  browser demo could not be offered): the from-number Maya is ringing
   *  from, shown instead of the console. */
  const [mayaRingingFrom, setMayaRingingFrom] = useState<string | null>(null);
  /** Whether the last web-mode response said the phone fallback exists. */
  const [phoneFallbackAvailable, setPhoneFallbackAvailable] = useState(false);
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

  // Lyla, the page host, can fill this form and start the demo on the
  // visitor's word. She dispatches window events; the form answers with
  // its own state and its own submit path, exactly as if the visitor had
  // typed the details and clicked Continue themselves.
  const submitLeadRef = useRef(submitLead);
  useEffect(() => {
    submitLeadRef.current = submitLead;
  });
  useEffect(() => {
    const onPrefill = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail ?? {};
      setForm((f) => ({
        ...f,
        ...(typeof detail.name === 'string' && detail.name ? { name: detail.name } : {}),
        ...(typeof detail.email === 'string' && detail.email ? { email: detail.email } : {}),
        ...(typeof detail.phone === 'string' && detail.phone ? { phone: detail.phone } : {}),
        ...(typeof detail.website === 'string' && detail.website ? { website: detail.website } : {}),
        // The business kind arrives in the form's own industry values;
        // anything else leaves the toggle exactly as the visitor left it.
        ...(detail.businessKind === 'clinic' || detail.businessKind === 'contractor' || detail.businessKind === 'other'
          ? { industry: detail.businessKind }
          : {}),
      }));
    };
    const onStart = () => {
      // She hears back what the submit actually did, in the same outcome
      // the visitor sees; without this she once reported a demo she had
      // never started.
      void (async () => {
        const outcome = await submitLeadRef.current({ preventDefault: () => undefined } as React.FormEvent);
        window.dispatchEvent(new CustomEvent('lyla:demo-status', { detail: outcome }));
      })();
    };
    window.addEventListener('lyla:prefill', onPrefill);
    window.addEventListener('lyla:start-demo', onStart);
    return () => {
      window.removeEventListener('lyla:prefill', onPrefill);
      window.removeEventListener('lyla:start-demo', onStart);
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
  const maya = webAgent === 'maya';

  async function submitLead(e: React.FormEvent): Promise<DemoSubmitOutcome> {
    e.preventDefault();
    setFormError(null);
    const name = form.name.trim();
    const email = form.email.trim();
    const phone = form.phone.trim();
    if (!name || !email || !phone) {
      setFormError('Please fill in your name, email, and phone.');
      const missing = [
        ...(!name ? ['name'] : []),
        ...(!email ? ['email'] : []),
        ...(!phone ? ['phone'] : []),
      ];
      return { ok: false, reason: `The demo form is missing: ${missing.join(', ')}.` };
    }
    if (!form.industry) {
      setFormError('Pick the kind of business you run so we can tailor the demo.');
      return { ok: false, reason: 'The demo form is missing: the kind of business.' };
    }
    // The submit button already waits for a token when the bot check is
    // configured; this guards the paths that bypass it (e.g. Enter in a
    // field), because the API rejects tokenless leads in that setup.
    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      return { ok: false, reason: 'The demo form bot check is not ready yet.' };
    }
    setSubmitting(true);
    let outcome: DemoSubmitOutcome;
    try {
      const businessName = form.businessName.trim();
      const website = form.website.trim();
      const res = await DemoApi.lead({
        name,
        email,
        phone,
        industry: form.industry,
        ...(businessName ? { businessName } : {}),
        ...(demoKind === 'receptionist' && website ? { websiteUrl: website } : {}),
        ...(turnstileToken ? { turnstileToken } : {}),
      });
      setLead(res);
      setSessionId(res.sessionId);
      setDay(res.day);
      setAppointments(res.appointments);
      if (demoKind === 'receptionist') {
        // Pull the clinic facts for the confirm step. A failed pull is not
        // an error for the prospect: they land on the same step with blank
        // fields and a note.
        let pulled: ClinicFacts | null = null;
        if (website) {
          try {
            pulled = (await DemoApi.clinicFacts({ sessionId: res.sessionId, websiteUrl: website })).facts;
          } catch {
            pulled = null;
          }
        }
        setConfirmFacts({
          clinicName: pulled?.businessName ?? businessName,
          hours: (pulled?.hours ?? []).join('\n'),
          services: (pulled?.services ?? []).join(', '),
          address: pulled?.address ?? '',
          pulledFacts: pulled !== null && Object.keys(pulled).length > 0,
        });
        setView('confirm');
        outcome = { ok: true, view: 'confirm' };
      } else {
        setView('choose');
        outcome = { ok: true, view: 'choose' };
      }
    } catch (err) {
      let message: string;
      if (err instanceof ApiError && err.code === 'DEMO_DISABLED') {
        message = 'The demo is currently turned off — please check back soon.';
      } else if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
        message = 'Please double-check your email and phone number.';
      } else {
        message = err instanceof ApiError ? err.message : 'Could not start the demo. Try again.';
      }
      setFormError(message);
      outcome = { ok: false, reason: message };
    } finally {
      setSubmitting(false);
      if (TURNSTILE_SITE_KEY) {
        // Tokens are single-use: drop ours and reset the widget so any
        // retry runs against a fresh challenge.
        setTurnstileToken(null);
        turnstileResetRef.current?.();
      }
    }
    return outcome;
  }

  /** Confirm step done: freeze the edited facts into the shape /call sends. */
  function confirmContinue() {
    const splitLines = (text: string) =>
      text
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    const clinicName = confirmFacts.clinicName.trim();
    const hours = splitLines(confirmFacts.hours);
    const services = splitLines(confirmFacts.services);
    const address = confirmFacts.address.trim();
    setConfirmedFacts({
      ...(clinicName ? { businessName: clinicName } : {}),
      ...(hours.length > 0 ? { hours } : {}),
      ...(services.length > 0 ? { services } : {}),
      ...(address ? { address } : {}),
    });
    setView('choose');
  }

  function chooseWeb() {
    setWebAgent('ava');
    setView('web');
    void startCall();
  }

  function chooseMayaWeb() {
    setWebAgent('maya');
    setView('web');
    void startMayaWebCall();
  }

  /** The console's voice-session handlers, shared by Ava's start and
   *  Maya's: whichever agent is on the line drives the same panel. */
  function voiceHandlers() {
    return {
      onPhase: (next: SimulatorPhase) => {
        if (aliveRef.current) setPhase(next);
      },
      onVolume: () => {},
      onTranscript: (entry: TranscriptEntry) => {
        if (aliveRef.current) setTranscript((cur) => [...cur, entry]);
      },
      onError: (message: string) => {
        if (aliveRef.current) setError(message);
      },
      onScreen: (screen: string) => {
        if (aliveRef.current) applyScreen(screen);
      },
      onSummary: (summary: DemoCallSummary) => {
        if (!aliveRef.current) return;
        setCallSummary(summary);
        applyScreen('summary'); // the recap tool also switches them to the summary
      },
    };
  }

  /** Reset the console to a fresh call: no transcript, no stale screen. */
  function resetConsole() {
    setError(null);
    setTranscript([]);
    setStage('intro');
    setCallSummary(null);
    screenSetAtRef.current = 0;
  }

  async function startCall() {
    if (live || phase === 'requesting') return;
    resetConsole();
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
    await session.start(data.publicKey, data.assistant, voiceHandlers());
  }

  /**
   * Maya's in-browser demo (Canadian receptionist visitors): the demo
   * start is the same /call the phone flow uses, answered with a web
   * call instead of a dial. If the server could not offer the browser
   * demo it rings the phone as it always has, and the console gives way
   * to the ringing state rather than pretending a web call started.
   */
  async function startMayaWebCall() {
    if (!lead || live || phase === 'requesting') return;
    resetConsole();
    setMayaRingingFrom(null);
    setPhoneFallbackAvailable(false);
    setPhase('requesting');
    let res;
    try {
      res = await DemoApi.call({
        sessionId: lead.sessionId,
        leadId: lead.leadId,
        name: lead.name,
        phone: lead.phone,
        demoKind: 'receptionist',
        delivery: 'web',
        ...(confirmedFacts ? { facts: confirmedFacts } : {}),
      });
    } catch (err) {
      if (!aliveRef.current) return;
      setPhase('error');
      setError(err instanceof ApiError ? err.message : 'Could not start the demo.');
      return;
    }
    if (!aliveRef.current) return;
    if (res.mode === 'phone') {
      setMayaRingingFrom(res.fromNumber);
      setPhase('idle');
      return;
    }
    setPhoneFallbackAvailable(res.phoneFallbackAvailable);
    setSessionId(res.sessionId);
    setShowCalendar(true);

    const session = new VoiceSession();
    sessionRef.current = session;
    await session.start(res.publicKey, res.assistant, voiceHandlers());
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
          demoKind={demoKind}
          setDemoKind={setDemoKind}
          submitting={submitting}
          error={formError}
          onSubmit={submitLead}
          turnstileToken={turnstileToken}
          onTurnstileToken={setTurnstileToken}
          turnstileResetRef={turnstileResetRef}
        />
      </div>
    );
  }

  // --------------------- gate: confirm the clinic facts ---------------------
  if (view === 'confirm' && lead) {
    return (
      <div key="confirm" className="animate-fade-up">
        <DemoConfirmFacts
          facts={confirmFacts}
          setFacts={setConfirmFacts}
          onContinue={confirmContinue}
          onBack={() => setView('form')}
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
          demoKind={demoKind}
          clinicName={confirmedFacts?.businessName ?? ''}
          onWeb={chooseWeb}
          onMayaWeb={chooseMayaWeb}
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
        <DemoCallView
          lead={lead}
          demoKind={demoKind}
          facts={confirmedFacts}
          clinicName={confirmedFacts?.businessName ?? ''}
          onBack={() => setView('choose')}
          onWeb={chooseWeb}
        />
      </div>
    );
  }

  // Maya's web start fell back to a phone call server-side: the console
  // gives way to the same ringing state the phone view shows.
  if (maya && mayaRingingFrom && lead) {
    return (
      <div key="maya-ringing" className="animate-fade-up">
        <div className="mx-auto max-w-xl">
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-9 text-center backdrop-blur">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-400/20 ring-1 ring-inset ring-emerald-300/40">
              <Waveform bars={4} light />
            </div>
            <h3 className="mt-5 font-display text-[20px] font-semibold tracking-tight text-white">
              Your phone’s about to ring
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/60">
              The in-browser demo could not start here, so we are calling{' '}
              <span className="font-semibold text-white">{lead.phone}</span> from{' '}
              <span className="font-mono text-white/80">{mayaRingingFrom}</span> instead. Pick up and talk
              to Maya like a patient would. Ask for a cleaning, or try a tricky question.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => void startMayaWebCall()}
                className="rounded-full bg-white px-6 py-3 text-[15px] font-semibold text-ink shadow-lift transition-transform hover:-translate-y-0.5"
              >
                Try the browser demo again
              </button>
              <button
                type="button"
                onClick={() => setView('choose')}
                className="rounded-2xl border border-white/15 bg-white/[0.06] px-6 py-3 text-[15px] font-semibold text-white transition-transform hover:-translate-y-0.5"
              >
                ‹ Back to options
              </button>
            </div>
          </div>
        </div>
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
                {maya
                  ? `Press the button and talk to Maya like a patient calling ${confirmedFacts?.businessName ?? 'your clinic'}. Ask her to book a cleaning, then try to trip her up.`
                  : 'Press the button and say hi to Ava. She’ll walk you through what VoiceFront does — live. Ask her to book, then try to trip her up.'}
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
              <p className="text-sm text-ink-muted/70">{maya ? 'Getting Maya on the line…' : 'Getting Ava on the line…'}</p>
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
                    onClick={maya ? startMayaWebCall : startCall}
                    disabled={phase === 'requesting'}
                    className="relative rounded-full bg-gradient-to-b from-signal to-signal-deep px-7 py-3 text-[15px] font-semibold text-white shadow-pop transition-all duration-200 ease-smooth hover:-translate-y-0.5 hover:shadow-lift disabled:opacity-60"
                  >
                    {phase === 'ended' ? 'Call again' : 'Start the demo call'}
                  </button>
                </span>
              )}
              <p className="text-[11px] text-ink-muted/70">Free · runs in your browser · needs mic access</p>
              {error && <p className="text-center text-xs text-danger">{error}</p>}
              {/* Maya's microphone fallback: the phone call, exactly as it
                  has always worked, offered whenever a web call ends or
                  fails and a caller-ID exists to dial from. */}
              {maya && phoneFallbackAvailable && (phase === 'error' || phase === 'ended') && (
                <p className="text-center text-[12px] text-ink-muted">
                  Rather hear it on your phone?{' '}
                  <button
                    type="button"
                    onClick={() => setView('call')}
                    className="font-semibold text-signal-deep underline decoration-signal/40 underline-offset-2 transition-colors hover:text-ink"
                  >
                    Get a call instead
                  </button>
                </p>
              )}
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
        variant={maya ? 'receptionist' : 'sales'}
      />

      {/* ----------------------------- guided scenarios ---------------------------- */}
      <div className="lg:col-span-2">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(maya ? MAYA_SCENARIOS : DEMO_SCENARIOS).map((s, i) => {
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
    body: 'Most homeowners call the next contractor if you don’t pick up. VoiceFront qualifies the lead, books the estimate, and puts the details on your dashboard before you’re off the ladder.',
    sample: [
      { role: 'caller' as const, text: 'I need a quote for a fence repair this week.' },
      { role: 'agent' as const, text: 'I can book an on-site estimate Thursday at 4:00 — does that work?' },
    ],
    points: ['Qualifies new leads', 'Books on-site estimates', 'Transfers emergencies to your cell', 'Takes supplier messages with PO numbers'],
  },
} as const;

export function IndustryTabs() {
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
          <p className="mt-2 text-center text-xs text-ink-muted/70">Sample exchange. Voices and scripts are fully yours to shape.</p>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------- FAQ ---------------------------------- */

export const FAQS = [
  {
    q: 'Does it really sound human?',
    a: 'Yes. You choose from twelve built-in voices in settings, each with natural pacing and a real front desk manner. Most callers never realize they spoke to an AI. Hear her yourself in the demo before you decide.',
  },
  {
    q: 'What happens when it can’t answer something?',
    a: 'It does what a great receptionist does: transfers the call to the right person on your team, or takes a detailed message with a callback number, and your rules decide which.',
  },
  {
    q: 'How do appointments reach my calendar?',
    a: 'Bookings land in your VoiceFront calendar in the dashboard the moment the caller hangs up, with the patient’s name, number and reason for the visit. She checks that same calendar before she offers any time, so two callers can never take the same slot.',
  },
  {
    q: 'How long does setup take?',
    a: 'About two minutes. Tell us about your clinic, pick a voice, set your hours, and forward your number. Changes you make in the dashboard apply to the very next call.',
  },
  {
    q: 'What does it cost?',
    a: 'Two plans, priced in the open. Starter After-Hours is $299 a month with 300 included minutes. Core 24/7 is $499 a month with 950 included minutes, and it answers around the clock. Prices are in US dollars. Canadian clinics are billed in Canadian dollars, $399 for Starter and $599 for Core. Both plans come with $0 setup and a 7-day free trial, and you can cancel anytime.',
  },
  {
    q: 'Can I keep my existing phone number?',
    a: 'Yes. You keep your number and simply forward it, always, after a few rings, or only after hours. You stay in control and can turn it off anytime.',
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
export function BeyondAnswering() {
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      {/* Warm transfer */}
      <div className="flex h-full flex-col rounded-3xl border border-line/70 bg-white p-7 shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-card-hover">
        <div className="rounded-2xl bg-paper/70 p-4 ring-1 ring-inset ring-ink/5">
          <ChatBubbles
            lines={[
              { role: 'caller', text: 'Is Dr. Lee free? It’s urgent.' },
              { role: 'agent', text: 'One moment, connecting you now.' },
            ]}
          />
          <div className="mt-2.5 flex items-center gap-2.5 rounded-xl border border-signal/20 bg-signal-soft/60 px-3 py-2">
            <Waveform bars={4} />
            <p className="text-[11.5px] font-medium leading-snug text-signal-deep">
              “Sarah’s calling about a filling that fell out, putting her through.”
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
          why, before connecting. Your team picks up already in the loop, not cold.
        </p>
      </div>

      {/* The dashboard story */}
      <div className="flex h-full flex-col rounded-3xl border border-line/70 bg-white p-7 shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-card-hover">
        <div className="rounded-2xl border border-signal/15 bg-gradient-to-br from-signal-soft/60 via-white to-white p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-signal-deep">
              On your dashboard
            </p>
            <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted ring-1 ring-inset ring-ink/5">
              Example
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            {[
              { n: '128', d: 'calls answered' },
              { n: '34', d: 'bookings made' },
              { n: '41', d: 'after hours' },
            ].map((m) => (
              <div key={m.d} className="rounded-xl bg-white px-2 py-3 ring-1 ring-inset ring-ink/5">
                <p className="font-display text-[22px] font-bold leading-none tracking-tight text-ink">{m.n}</p>
                <p className="mt-1.5 text-[10.5px] font-medium leading-tight text-ink-muted">{m.d}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-center text-[11px] text-ink-muted/80">One month at a sample clinic, for illustration.</p>
        </div>
        <span className="mt-5 inline-flex w-fit items-center rounded-full bg-signal-soft/70 px-2.5 py-1 text-[11px] font-semibold text-signal-deep">
          Live as it happens
        </span>
        <h3 className="mt-3 font-display text-lg font-semibold tracking-tight text-ink">
          See every call on your dashboard
        </h3>
        <p className="mt-2 flex-1 text-[14px] leading-relaxed text-ink-muted">
          Every call she answers, every booking she makes, and every minute she spends lands on your
          dashboard, with the recording, transcript and summary attached.
        </p>
      </div>

      {/* Answers from your clinic details */}
      <div className="flex h-full flex-col rounded-3xl border border-line/70 bg-white p-7 shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-card-hover">
        <div className="rounded-2xl bg-paper/70 p-4 ring-1 ring-inset ring-ink/5">
          <ChatBubbles
            lines={[
              { role: 'caller', text: 'Do you take Sun Life?' },
              { role: 'agent', text: 'We do, Sun Life is on our list. I can book you in, and the clinic confirms the details at your visit.' },
            ]}
          />
          <div className="mt-2.5 flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-inset ring-ink/5">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3.5 w-3.5 shrink-0 text-signal-deep">
              <path d="M4 2.5h5L12 5.5v8H4z" strokeLinejoin="round" />
              <path d="M9 2.5V6h3M6 9h4M6 11h4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <p className="text-[11px] font-medium text-ink-muted">Answered from the details you give her</p>
          </div>
        </div>
        <span className="mt-5 inline-flex w-fit items-center rounded-full bg-clinic-soft px-2.5 py-1 text-[11px] font-semibold text-[#0b8a74]">
          Your clinic, your facts
        </span>
        <h3 className="mt-3 font-display text-lg font-semibold tracking-tight text-ink">
          Answers from your own details
        </h3>
        <p className="mt-2 flex-1 text-[14px] leading-relaxed text-ink-muted">
          She answers from the facts you set for your clinic, your hours, your services, your prices, and
          the insurance plans you list in settings. If a caller asks something outside that, she takes a
          message or transfers. She does not guess.
        </p>
      </div>
    </div>
  );
}
