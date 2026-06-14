'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { Logo } from '@/components/ui/Logo';

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
        className="absolute -inset-8 rounded-[40px] bg-[radial-gradient(50%_50%_at_50%_50%,rgba(109,91,255,0.18),transparent_70%)]"
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

const DEMO_SCRIPT: ScriptLine[] = [
  { role: 'agent', text: 'Northside Family Clinic, this is the receptionist — how can I help?' },
  { role: 'caller', text: 'Do you have anything tomorrow morning? It’s for a follow-up.' },
  { role: 'agent', text: 'Let me check the calendar… I have 9:30 and 11:00 open.' },
  { role: 'caller', text: '11:00 please. James Cole, 555-0119.' },
  { role: 'agent', text: 'Booked — James Cole, tomorrow at 11:00 AM. Anything else?' },
];

const DEMO_SLOTS = [
  { time: '9:00', label: 'Team huddle', taken: true },
  { time: '9:30', label: '', taken: false },
  { time: '10:00', label: 'M. Alvarez — cleaning', taken: true },
  { time: '11:00', label: '', taken: false, target: true },
  { time: '11:30', label: '', taken: false },
  { time: '12:00', label: 'Lunch block', taken: true },
];

function LiveDemo() {
  const { ringing, visibleLines, booked } = useCallLoop(DEMO_SCRIPT.length);
  return (
    <div className="grid items-stretch gap-5 lg:grid-cols-2">
      {/* transcript console */}
      <div className="flex flex-col overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-white/50">Live call</p>
          {ringing ? (
            <span className="text-xs font-medium text-white/40">Ringing…</span>
          ) : (
            <span className="flex items-center gap-2 text-xs font-semibold text-emerald-300">
              <Waveform bars={4} light />
              On the line
            </span>
          )}
        </div>
        <div className="flex min-h-[300px] flex-1 flex-col gap-2.5 px-5 py-5">
          {DEMO_SCRIPT.slice(0, visibleLines).map((line, i) => (
            <div
              key={i}
              className={`max-w-[88%] animate-pop-in rounded-2xl px-3.5 py-2 text-[13px] leading-snug ${
                line.role === 'agent'
                  ? 'self-start rounded-bl-md bg-signal/25 text-white ring-1 ring-inset ring-signal/40'
                  : 'self-end rounded-br-md bg-white/10 text-white/90 ring-1 ring-inset ring-white/10'
              }`}
            >
              {line.text}
            </div>
          ))}
          {ringing && (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-sm text-white/40">A customer is calling…</p>
            </div>
          )}
        </div>
      </div>

      {/* calendar panel */}
      <div className="overflow-hidden rounded-3xl border border-white/10 bg-white shadow-lift">
        <div className="flex items-center justify-between border-b border-line/60 bg-paper/70 px-5 py-3.5">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">Your calendar — tomorrow</p>
          {booked && (
            <span className="animate-pop-in rounded-full bg-clinic-soft px-2.5 py-1 text-[11px] font-semibold text-[#0b8a74]">
              +1 booked by AI
            </span>
          )}
        </div>
        <ul className="divide-y divide-line/50 px-5 py-2">
          {DEMO_SLOTS.map((slot) => {
            const justBooked = slot.target && booked;
            return (
              <li key={slot.time} className="flex items-center gap-4 py-2.5">
                <span className="w-12 font-mono text-xs text-ink-muted">{slot.time}</span>
                {justBooked ? (
                  <span className="flex flex-1 animate-pop-in items-center justify-between rounded-xl bg-gradient-to-r from-signal to-signal-deep px-3.5 py-2 text-[13px] font-semibold text-white shadow-pop">
                    James Cole — follow-up
                    <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                      Voice agent
                    </span>
                  </span>
                ) : slot.taken ? (
                  <span className="flex-1 rounded-xl bg-paper px-3.5 py-2 text-[13px] text-ink-muted ring-1 ring-inset ring-ink/5">
                    {slot.label}
                  </span>
                ) : (
                  <span className="flex-1 rounded-xl border border-dashed border-line px-3.5 py-2 text-[13px] text-ink-muted/50">
                    Open
                  </span>
                )}
              </li>
            );
          })}
        </ul>
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
    a: 'Bookings land in your VoiceFront calendar the moment the caller hangs up — with the name, number and reason. Two callers can never grab the same slot, and Google & Microsoft calendar sync is on the roadmap.',
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

/* ---------------------------------- page ---------------------------------- */

export default function LandingPage() {
  const { status } = useAuth();
  const authed = status === 'authenticated';
  const primaryHref = authed ? '/dashboard' : '/register';
  const primaryLabel = authed ? 'Open dashboard' : 'Get started';

  return (
    <div className="bg-white text-ink">
      {/* ---------------------------------- nav --------------------------------- */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-line/60 bg-white/80 backdrop-blur-md">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6" aria-label="Main">
          <Link href="/">
            <Logo />
          </Link>
          <div className="hidden items-center gap-7 text-sm font-medium text-ink-muted md:flex">
            <a href="#demo" className="transition-colors hover:text-ink">Demo</a>
            <a href="#how" className="transition-colors hover:text-ink">How it works</a>
            <a href="#industries" className="transition-colors hover:text-ink">Industries</a>
            <a href="#pricing" className="transition-colors hover:text-ink">Pricing</a>
            <a href="#faq" className="transition-colors hover:text-ink">FAQ</a>
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
              className="rounded-xl bg-gradient-to-b from-signal to-signal-deep px-4 py-2 text-sm font-semibold text-white shadow-pop transition-transform duration-150 hover:-translate-y-px active:translate-y-0"
            >
              {primaryLabel}
            </Link>
          </div>
        </nav>
      </header>

      {/* --------------------------------- hero --------------------------------- */}
      <section className="relative overflow-hidden px-6 pb-24 pt-36 md:pt-44">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_60%_at_50%_0%,rgba(109,91,255,0.08),transparent)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(rgba(11,18,32,0.05)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(60%_50%_at_50%_30%,black,transparent)]"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-16 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <Reveal>
              <span className="inline-flex items-center gap-2 rounded-full border border-signal/20 bg-signal-soft/60 px-3.5 py-1.5 text-xs font-semibold text-signal-deep">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute h-full w-full animate-pulse-ring rounded-full bg-signal" />
                  <span className="relative h-1.5 w-1.5 rounded-full bg-signal" />
                </span>
                AI receptionist · answers in under a second
              </span>
            </Reveal>
            <Reveal delay={80}>
              <h1 className="mt-6 font-display text-[44px] font-bold leading-[1.04] tracking-tight md:text-[64px]">
                Your phone is answered.
                <br />
                <span className="bg-gradient-to-r from-signal to-signal-deep bg-clip-text text-transparent">
                  Your calendar fills itself.
                </span>
              </h1>
            </Reveal>
            <Reveal delay={160}>
              <p className="mt-6 max-w-[520px] text-lg leading-relaxed text-ink-muted">
                VoiceFront answers every call with a voice your customers can’t tell from a person —
                then books the appointment straight into your calendar. 24/7. No hold music. No missed revenue.
              </p>
            </Reveal>
            <Reveal delay={240}>
              <div className="mt-9 flex flex-wrap items-center gap-4">
                <Link
                  href={primaryHref}
                  className="rounded-2xl bg-gradient-to-b from-signal to-signal-deep px-7 py-3.5 text-[15px] font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-0.5 hover:shadow-lift active:translate-y-0"
                >
                  {authed ? 'Open your dashboard' : 'Get started — it’s live in minutes'}
                </Link>
                <a
                  href="#demo"
                  className="group flex items-center gap-2 rounded-2xl border border-line bg-white px-6 py-3.5 text-[15px] font-semibold text-ink shadow-input transition-all duration-150 hover:border-ink-muted/40"
                >
                  Watch it book a call
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 transition-transform duration-150 group-hover:translate-y-0.5">
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

      {/* ------------------------------- stat band ------------------------------- */}
      <section className="border-y border-line/60 bg-paper/60 px-6 py-14">
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
      <section id="demo" className="relative overflow-hidden bg-ink px-6 py-24 md:py-32">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_30%_0%,rgba(109,91,255,0.22),transparent),radial-gradient(40%_40%_at_90%_100%,rgba(79,61,245,0.18),transparent)]"
        />
        <div className="relative mx-auto max-w-6xl">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-soft/70">The product, live</p>
            <h2 className="mt-4 font-display text-4xl font-bold tracking-tight text-white md:text-5xl">
              Watch it book. In real time.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-white/60">
              A customer calls. The receptionist checks your real availability, holds the conversation,
              and the appointment lands on your calendar before they hang up.
            </p>
          </Reveal>
          <Reveal delay={150} className="mt-14">
            <LiveDemo />
          </Reveal>
          <Reveal delay={250} className="mt-12 text-center">
            <Link
              href={primaryHref}
              className="inline-block rounded-2xl bg-white px-7 py-3.5 text-[15px] font-semibold text-ink shadow-lift transition-all duration-150 hover:-translate-y-0.5"
            >
              Try it with your own voice — free in-browser test call
            </Link>
            <p className="mt-4 text-sm text-white/40">Create a workspace, press “Test call”, and talk to your receptionist.</p>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------ how it works ----------------------------- */}
      <section id="how" className="px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <Reveal className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">How it works</p>
            <h2 className="mt-4 font-display text-4xl font-bold tracking-tight md:text-[44px]">
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
            <h2 className="mt-4 font-display text-4xl font-bold tracking-tight md:text-[44px]">
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

      {/* ------------------------------- industries ------------------------------ */}
      <section id="industries" className="px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">Industries</p>
            <h2 className="mt-4 font-display text-4xl font-bold tracking-tight md:text-[44px]">
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

      {/* --------------------------------- pricing -------------------------------- */}
      <section id="pricing" className="px-6 pb-24 md:pb-32">
        <div className="mx-auto max-w-6xl">
          <div className="relative overflow-hidden rounded-[32px] bg-ink px-8 py-16 md:px-16 md:py-20">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_60%_at_80%_0%,rgba(109,91,255,0.28),transparent),radial-gradient(40%_50%_at_10%_100%,rgba(79,61,245,0.2),transparent)]"
            />
            <div className="relative grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
              <div>
                <Reveal>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-soft/70">Pricing</p>
                  <h2 className="mt-4 font-display text-4xl font-bold tracking-tight text-white md:text-[44px]">
                    Priced around your calls,
                    <br />
                    not a one-size plan.
                  </h2>
                  <p className="mt-5 max-w-lg text-lg leading-relaxed text-white/60">
                    A solo contractor and a three-location clinic shouldn’t pay the same.
                    Tell us your call volume and we’ll quote a plan that pays for itself —
                    most customers cover it with the first few bookings it saves.
                  </p>
                </Reveal>
                <Reveal delay={120}>
                  <div className="mt-9 flex flex-wrap items-center gap-4">
                    <a
                      href="mailto:sales@voicefront.app?subject=VoiceFront%20pricing&body=Hi%2C%20I%27d%20like%20a%20quote.%0A%0ABusiness%20type%3A%20%0AApprox.%20calls%20per%20day%3A%20%0ALocations%3A%20"
                      className="rounded-2xl bg-white px-7 py-3.5 text-[15px] font-semibold text-ink shadow-lift transition-all duration-150 hover:-translate-y-0.5"
                    >
                      Talk to sales
                    </a>
                    <Link
                      href={primaryHref}
                      className="rounded-2xl border border-white/20 px-7 py-3.5 text-[15px] font-semibold text-white transition-colors duration-150 hover:bg-white/10"
                    >
                      Try the product first
                    </Link>
                  </div>
                  <p className="mt-5 text-sm text-white/40">Custom quote within a day · no contracts · no setup fees · cancel anytime</p>
                </Reveal>
              </div>
              <Reveal delay={200}>
                <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-8 backdrop-blur">
                  <p className="text-sm font-semibold uppercase tracking-[0.12em] text-white/50">Every plan includes</p>
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
                      <li key={item} className="flex items-start gap-3 text-[15px] text-white/85">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-signal/30 ring-1 ring-inset ring-signal/50">
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3 text-signal-soft">
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

      {/* ----------------------------------- FAQ ---------------------------------- */}
      <section id="faq" className="border-t border-line/60 bg-paper/50 px-6 py-24 md:py-32">
        <div className="mx-auto max-w-3xl">
          <Reveal className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">FAQ</p>
            <h2 className="mt-4 font-display text-4xl font-bold tracking-tight md:text-[44px]">
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
              <h2 className="relative mx-auto max-w-2xl font-display text-4xl font-bold tracking-tight text-white md:text-5xl">
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
                  className="rounded-2xl bg-white px-8 py-4 text-[15px] font-bold text-signal-deep shadow-lift transition-all duration-150 hover:-translate-y-0.5"
                >
                  {primaryLabel}
                </Link>
                {!authed && (
                  <Link
                    href="/login"
                    className="rounded-2xl border border-white/30 px-8 py-4 text-[15px] font-semibold text-white transition-colors hover:bg-white/10"
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
          <Logo size="sm" />
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
