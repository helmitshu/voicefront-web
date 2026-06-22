'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Logo } from '@/components/ui/Logo';
import { Spinner } from '@/components/ui/Spinner';
import { Waveform } from '@/components/ui/Waveform';
import { DemoApi } from '@/lib/api';
import { BookCallSection } from '@/components/BookCallSection';
import { ROICalculator } from '@/components/ROICalculator';
import { WorkflowConsole } from '@/components/WorkflowConsole';
import { Reveal, CallCard, IndustryTabs, BeyondAnswering, FAQS } from './landing';

// The interactive voice demo pulls in the Vapi web SDK and is only rendered on
// the home page. Load it in its own chunk so pricing/product/book routes don't
// ship the widget. ssr:false because it relies on browser-only audio APIs.
const InteractiveDemo = dynamic(
  () => import('./landing').then((m) => m.InteractiveDemo),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-[420px] items-center justify-center">
        <Spinner />
      </div>
    ),
  },
);

/* ------------------------------ shared helpers ---------------------------- */

/** The primary CTA target depends on whether the visitor is signed in. */
function usePrimaryCta() {
  const { status } = useAuth();
  const authed = status === 'authenticated';
  return {
    authed,
    primaryHref: authed ? '/dashboard' : '/register',
    primaryLabel: authed ? 'Open dashboard' : 'Get started',
  };
}

/** Founder can hide the demo; fail open so a status hiccup never blanks it. */
function useDemoEnabled() {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    DemoApi.status()
      .then((r) => setEnabled(r.enabled))
      .catch(() => setEnabled(true));
  }, []);
  return enabled;
}

/* ------------------------------- site header ------------------------------ */

export function SiteHeader() {
  const { authed, primaryHref, primaryLabel } = usePrimaryCta();
  const pathname = usePathname();
  const demoEnabled = useDemoEnabled();
  const [menuOpen, setMenuOpen] = useState(false);

  const nav = [
    { href: '/product', label: 'Product' },
    ...(demoEnabled ? [{ href: '/demo', label: 'Demo' }] : []),
    { href: '/industries', label: 'Industries' },
    { href: '/pricing', label: 'Pricing' },
    { href: '/book', label: 'Book a call' },
  ];
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="fixed inset-x-0 top-0 z-50">
      {/* announcement / trust bar */}
      {demoEnabled && (
        <Link href="/demo" className="group block bg-ink text-white">
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
        </Link>
      )}
      {/* nav — dark, so the top of every page reads as one premium block and the
          home hero flows seamlessly into it */}
      <div className="border-b border-white/10 bg-ink-deep/85 backdrop-blur-md">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6" aria-label="Main">
          <Link href="/">
            <Logo tone="light" />
          </Link>
          <div className="hidden items-center gap-7 text-sm font-medium text-white/65 md:flex">
            {nav.map((l) => {
              const active = isActive(l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={active ? 'page' : undefined}
                  className={`relative transition-colors ${active ? 'text-clinic' : 'hover:text-white'}`}
                >
                  {l.label}
                  <span
                    aria-hidden
                    className={`absolute -bottom-1.5 left-0 h-0.5 rounded-full bg-clinic transition-all duration-300 ${
                      active ? 'w-full opacity-100' : 'w-0 opacity-0'
                    }`}
                  />
                </Link>
              );
            })}
          </div>
          <div className="flex items-center gap-3">
            {!authed && (
              <Link
                href="/login"
                className="hidden text-sm font-medium text-white/65 transition-colors hover:text-white sm:block"
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
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/20 text-white md:hidden"
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

        {menuOpen && (
          <div className="animate-fade-up border-t border-white/10 bg-ink-deep px-6 py-4 md:hidden">
            <div className="flex flex-col gap-1">
              {nav.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setMenuOpen(false)}
                  className="rounded-lg px-3 py-2.5 text-[15px] font-medium text-white/70 transition-colors hover:bg-white/5 hover:text-white"
                >
                  {l.label}
                </Link>
              ))}
              {!authed && (
                <Link
                  href="/login"
                  onClick={() => setMenuOpen(false)}
                  className="rounded-lg px-3 py-2.5 text-[15px] font-medium text-white/70 transition-colors hover:bg-white/5 hover:text-white"
                >
                  Sign in
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

/* ----------------------------------- hero --------------------------------- */

export function HeroSection() {
  const { authed, primaryHref } = usePrimaryCta();
  return (
    <section className="relative isolate -mt-[100px] overflow-hidden bg-ink-deep px-6 pb-28 pt-[150px] md:pb-32 md:pt-[178px]">
      {/* Cinematic glow: teal key light, warm gold kicker, deep base — against ink.
          This dark hero is the brand's confident first impression and bookends
          with the dark stat anchor and closing CTA for a deliberate dark rhythm.
          The light *flows*: each blob drifts + scales on its own long, offset
          cycle (transform-only, GPU-composited; auto-stilled for reduced motion). */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* teal key light, top-left */}
        <div
          className="bg-aurora-a absolute -left-[12%] -top-[28%] h-[78vh] w-[78vh] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(16,169,142,0.30), transparent 68%)', filter: 'blur(72px)' }}
        />
        {/* warm gold kicker, top-right — drifts on a different phase */}
        <div
          className="bg-aurora-b absolute -right-[8%] -top-[14%] h-[52vh] w-[52vh] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(199,148,63,0.22), transparent 66%)', filter: 'blur(76px)' }}
        />
        {/* deep base glow, rising from the bottom */}
        <div
          className="bg-aurora-c absolute -bottom-[34%] left-[26%] h-[66vh] w-[66vh] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(10,87,79,0.55), transparent 70%)', filter: 'blur(84px)' }}
        />
      </div>
      {/* Faint grid texture, masked so it fades at the edges. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background-image:linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:60px_60px] [mask-image:radial-gradient(75%_70%_at_50%_22%,black,transparent)]"
      />
      <div className="relative mx-auto grid max-w-6xl items-center gap-16 lg:grid-cols-[1.05fr_0.95fr]">
        <div>
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 py-1.5 text-[13px] font-medium text-white/85 backdrop-blur">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute h-full w-full animate-pulse-ring rounded-full bg-clinic" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-clinic" />
              </span>
              AI receptionist · answers in under a second
            </span>
          </Reveal>
          <Reveal delay={80}>
            <h1 className="mt-6 font-display text-[46px] font-semibold leading-[1.02] tracking-[-0.035em] text-white md:text-[70px]">
              Your phone is answered.
              <br />
              <span className="bg-gradient-to-r from-clinic via-[#43d2b6] to-gold-light bg-clip-text text-transparent">
                Your calendar fills itself.
              </span>
            </h1>
          </Reveal>
          <Reveal delay={160}>
            <p className="mt-6 max-w-[500px] text-[19px] leading-relaxed text-white/65">
              VoiceFront answers every call with a voice your customers can’t tell from a person —
              then books the appointment straight into your calendar. 24/7. No hold music. No missed revenue.
            </p>
          </Reveal>
          <Reveal delay={240}>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href={primaryHref}
                className="rounded-full bg-white px-7 py-3.5 text-[15px] font-semibold text-ink shadow-lift transition-all duration-300 ease-smooth hover:-translate-y-0.5 active:translate-y-0"
              >
                {authed ? 'Open your dashboard' : 'Get started — it’s live in minutes'}
              </Link>
              <Link
                href="/demo"
                className="group flex items-center gap-2 rounded-full border border-white/20 bg-white/[0.06] px-6 py-3.5 text-[15px] font-semibold text-white backdrop-blur transition-all duration-300 ease-smooth hover:-translate-y-0.5 hover:bg-white/[0.12]"
              >
                Watch it book a call
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 transition-transform duration-300 ease-smooth group-hover:translate-y-0.5">
                  <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>
            </div>
          </Reveal>
          <Reveal delay={320}>
            <div className="mt-9 flex items-center gap-4">
              <Waveform bars={14} tone="light" className="h-6 w-auto shrink-0 opacity-70" />
              <p className="max-w-sm text-[13px] font-medium leading-snug text-white/55">
                <span className="font-semibold text-white/90">Built on Vapi · OpenAI · Deepgram</span> — the same
                stack behind millions of AI calls
              </p>
            </div>
          </Reveal>
        </div>
        <Reveal delay={200} className="relative isolate flex justify-center lg:justify-end">
          {/* Premium halo: the white call card glows against the dark hero,
              commanding attention instead of receding into a pale page. */}
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-10 -z-10 bg-[radial-gradient(50%_50%_at_55%_45%,rgba(16,169,142,0.32),transparent_70%),radial-gradient(42%_42%_at_82%_86%,rgba(199,148,63,0.18),transparent_70%)] blur-2xl"
          />
          <CallCard />
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------ social proof ------------------------------ */

export function SocialProofSection() {
  return (
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
  );
}

/* --------------------- how every call works (console) --------------------- */

export function HowItWorksSection() {
  return (
    <section id="how" className="relative px-6 py-24 md:py-32">
      <div className="mx-auto max-w-5xl">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-deep">How every call works</p>
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
              cta: { href: '/book', label: 'Book a call with the founder' },
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
                  <Link
                    href={card.cta.href}
                    className="group mt-4 inline-flex items-center gap-1.5 text-[14px] font-semibold text-signal-deep transition-colors hover:text-signal"
                  >
                    {card.cta.label}
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5 transition-transform duration-300 ease-smooth group-hover:translate-x-0.5">
                      <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </Link>
                )}
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------- stat band ------------------------------- */

export function StatBandSection() {
  return (
    <section className="relative overflow-hidden bg-ink-deep px-6 py-20 md:py-24">
      {/* Layered teal + gold glow gives the dark anchor depth without a flat fill. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_60%_at_20%_0%,rgba(16,169,142,0.18),transparent),radial-gradient(45%_55%_at_88%_100%,rgba(199,148,63,0.14),transparent)]"
      />
      <div className="relative mx-auto max-w-5xl">
        <Reveal className="flex flex-col items-center text-center">
          <Waveform bars={20} tone="gold" className="h-7 opacity-90" />
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-gold-light/90">
            Why it pays for itself
          </p>
        </Reveal>
        <div className="mt-12 grid gap-12 text-center sm:grid-cols-3">
          {[
            { n: '62%', d: 'of callers hang up on voicemail and call a competitor instead' },
            { n: '24/7', d: 'every call answered — nights, weekends and lunch rushes included' },
            { n: '< 1s', d: 'pickup time, before the second ring, every single time' },
          ].map((stat, i) => (
            <Reveal key={stat.n} delay={i * 100}>
              <p className="bg-gradient-to-br from-white via-white to-gold-light bg-clip-text font-display text-[58px] font-bold leading-none tracking-tight text-transparent md:text-6xl">
                {stat.n}
              </p>
              <p className="mx-auto mt-4 max-w-[250px] text-sm leading-relaxed text-white/55">{stat.d}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------- live demo ------------------------------- */

export function LiveDemoSection() {
  const { primaryHref } = usePrimaryCta();
  return (
    <section className="relative overflow-hidden bg-ink-deep px-6 py-24 md:py-32">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_25%_0%,rgba(16,169,142,0.18),transparent),radial-gradient(45%_45%_at_92%_100%,rgba(199,148,63,0.14),transparent)]"
      />
      <div className="relative mx-auto max-w-6xl">
        <Reveal className="mx-auto flex max-w-2xl flex-col items-center text-center">
          <Waveform bars={18} tone="gold" className="h-6 opacity-90" />
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-gold-light/90">The product, live</p>
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
  );
}

/* ------------------------------ getting set up ---------------------------- */

export function GettingSetUpSection() {
  return (
    <section className="relative overflow-hidden bg-ink-deep px-6 py-24 md:py-32">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_55%_at_12%_0%,rgba(16,169,142,0.16),transparent),radial-gradient(45%_55%_at_95%_90%,rgba(199,148,63,0.13),transparent)]"
      />
      <div className="relative mx-auto max-w-6xl">
        <Reveal className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-light/90">Up and running</p>
          <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight text-white md:text-[44px]">
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
              <div className="group h-full rounded-3xl border border-white/10 bg-white/[0.04] p-8 backdrop-blur-sm transition-all duration-200 hover:-translate-y-1 hover:border-white/20 hover:bg-white/[0.07]">
                <span className="font-mono text-sm font-semibold text-gold-light">{item.step}</span>
                <h3 className="mt-4 font-display text-xl font-semibold tracking-tight text-white">{item.title}</h3>
                <p className="mt-3 text-[15px] leading-relaxed text-white/60">{item.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------- features -------------------------------- */

export function FeaturesSection() {
  return (
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
  );
}

/* --------------------------- beyond answering ----------------------------- */

export function BeyondAnsweringSection() {
  return (
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
  );
}

/* ----------------------------- integrations ------------------------------- */

export function IntegrationsSection() {
  return (
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
  );
}

/* -------------------------------- industries ------------------------------ */

export function IndustriesSection() {
  return (
    <section className="border-t border-line/60 bg-surface/50 px-6 py-24 md:py-32">
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
  );
}

/* ----------------------------- ROI calculator ----------------------------- */

export function RoiSection() {
  return (
    <section className="relative overflow-hidden bg-ink-deep px-6 py-24 md:py-32">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_55%_at_18%_5%,rgba(16,169,142,0.16),transparent),radial-gradient(45%_55%_at_88%_100%,rgba(199,148,63,0.14),transparent)]"
      />
      <div className="relative mx-auto max-w-6xl">
        <Reveal className="mx-auto flex max-w-2xl flex-col items-center text-center">
          <Waveform bars={18} tone="gold" className="h-6 opacity-90" />
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-gold-light/90">The math</p>
          <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight text-white md:text-[44px]">
            What are missed calls costing you?
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-white/60">
            Every unanswered call is a booking that went to whoever picked up. Tell us about your
            business — the numbers are real Vancouver-area averages, and you can change any of them.
          </p>
        </Reveal>
        <Reveal delay={150} className="mt-12">
          <ROICalculator />
        </Reveal>
      </div>
    </section>
  );
}

/* --------------------------------- pricing -------------------------------- */

export function PricingSection() {
  const { primaryHref } = usePrimaryCta();
  return (
    <section className="px-6 py-24 md:py-32">
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
                  <Link
                    href="/book"
                    className="rounded-full bg-gradient-to-b from-signal to-signal-deep px-7 py-3.5 text-[15px] font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-0.5 hover:shadow-lift"
                  >
                    Book a call
                  </Link>
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
  );
}

/* ------------------------------- book a call ------------------------------ */

export function BookSection() {
  return (
    <section className="border-t border-line/60 bg-surface/50 px-6 py-24 md:py-32">
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
  );
}

/* ----------------------------------- FAQ ---------------------------------- */

export function FaqSection() {
  return (
    <section className="border-t border-line/60 bg-paper/50 px-6 py-24 md:py-32">
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
  );
}

/* -------------------------------- final CTA ------------------------------- */

export function FinalCtaSection() {
  const { authed, primaryHref, primaryLabel } = usePrimaryCta();
  return (
    <section className="px-6 py-24 md:py-28">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <div className="relative overflow-hidden rounded-[32px] bg-gradient-to-br from-ink-deep via-signal-deep to-signal px-8 py-16 text-center shadow-lift ring-1 ring-inset ring-white/10 md:py-20">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 [background-image:radial-gradient(rgba(255,255,255,0.12)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:radial-gradient(70%_70%_at_50%_50%,black,transparent)]"
            />
            {/* Warm gold kicker glow in the corner ties it to the brand system. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(40%_60%_at_88%_8%,rgba(199,148,63,0.22),transparent_70%)]"
            />
            <Reveal className="relative flex justify-center">
              <Waveform bars={22} tone="gold" className="h-7 opacity-90" />
            </Reveal>
            <h2 className="relative mx-auto mt-7 max-w-2xl font-display text-4xl font-semibold tracking-tight text-white md:text-5xl">
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
  );
}

/* --------------------------------- footer --------------------------------- */

export function SiteFooter() {
  const columns: { title: string; links: { href: string; label: string }[] }[] = [
    {
      title: 'Product',
      links: [
        { href: '/product', label: 'Overview' },
        { href: '/demo', label: 'Live demo' },
        { href: '/pricing', label: 'Pricing' },
        { href: '/industries', label: 'Industries' },
      ],
    },
    {
      title: 'Company',
      links: [
        { href: '/book', label: 'Book a call' },
        { href: '/dashboard', label: 'Dashboard' },
        { href: '/login', label: 'Sign in' },
      ],
    },
  ];
  return (
    <footer className="border-t border-line/60 bg-surface/40 px-6 pb-10 pt-14">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr]">
          <div className="max-w-xs">
            <Link href="/" aria-label="VoiceFront home" className="inline-block">
              <Logo size="sm" />
            </Link>
            <p className="mt-4 text-sm leading-relaxed text-ink-muted">
              The AI receptionist that answers every call in a human voice and books the appointment —
              24/7, on your calendar.
            </p>
            <Waveform bars={18} tone="muted" className="mt-5 h-6 w-auto justify-start" />
          </div>
          {columns.map((col) => (
            <div key={col.title}>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted/70">{col.title}</p>
              <ul className="mt-4 flex flex-col gap-2.5">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="text-sm text-ink-muted transition-colors hover:text-signal-deep">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-line/60 pt-6 sm:flex-row">
          <p className="text-xs text-ink-muted/70">© 2026 VoiceFront. All rights reserved.</p>
          <p className="text-xs text-ink-muted/60">Built on Vapi · OpenAI · Deepgram</p>
        </div>
      </div>
    </footer>
  );
}
