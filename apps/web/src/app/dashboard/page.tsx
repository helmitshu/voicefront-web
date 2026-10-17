'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import {
  AgentApi,
  ApiError,
  CallsApi,
  type CallDto,
  type CallStats,
  type MonthlyUsage,
} from '@/lib/api';
import { formatCents, formatDateTime, formatDuration, formatPhone } from '@/lib/format';
import { Badge, Card, CardHeader, CallStatusBadge, EmptyState, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { GoLiveGuide } from '@/components/dashboard/GoLiveGuide';

type CallFilter = 'all' | 'booked' | 'transferred' | 'message';

const CALL_FILTERS: { key: CallFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'booked', label: 'Booked' },
  { key: 'transferred', label: 'Transferred' },
  { key: 'message', label: 'Messages' },
];

function matchesFilter(call: CallDto, filter: CallFilter): boolean {
  switch (filter) {
    case 'booked':
      return call.appointmentBooked === true;
    case 'transferred':
      return call.status === 'FORWARDED';
    case 'message':
      return call.status === 'VOICEMAIL';
    default:
      return true;
  }
}

/** Phone-only section tabs for this page (below sm). Page-local sections,
    not app navigation: the drawer and sidebar keep that job. */
type HomeTab = 'overview' | 'receptionist' | 'calls';

const HOME_TABS: { key: HomeTab; label: string; icon: ReactNode }[] = [
  {
    key: 'overview',
    label: 'Overview',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-5 w-5">
        <rect x="3" y="3" width="6" height="6" rx="1.5" />
        <rect x="11" y="3" width="6" height="6" rx="1.5" />
        <rect x="3" y="11" width="6" height="6" rx="1.5" />
        <rect x="11" y="11" width="6" height="6" rx="1.5" />
      </svg>
    ),
  },
  {
    key: 'receptionist',
    label: 'Receptionist',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-5 w-5">
        <path d="M4.5 8.5v3M10 5.5v9M15.5 8.5v3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: 'calls',
    label: 'Calls',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-5 w-5">
        <path
          d="M4 3.5h3l1.5 4-2 1.5a11 11 0 0 0 4.5 4.5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5C8.3 16.9 3.1 11.7 2.5 5.1A1.5 1.5 0 0 1 4 3.5Z"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/** Decorative waveform heights for the receptionist panel (px). */
const WAVE_BARS = [26, 40, 30, 48, 36, 22, 44, 28, 38, 18, 42, 30, 46, 24, 34, 20, 40, 27];

/** How often the home quietly re-checks stats and recent calls (ms). */
const POLL_INTERVAL_MS = 30_000;

/**
 * Eases a displayed number toward its latest value, so a stat that changes
 * on a background refresh counts across instead of snapping. The first real
 * value (the initial load) lands instantly, and reduced-motion users always
 * get the value instantly. Purely visual: the number rendered is a rounded
 * step on the way to the real value, which it reaches within the tween.
 */
function useTweenedNumber(value: number): number {
  const [display, setDisplay] = useState(value);
  const displayRef = useRef(value);
  const primedRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const from = displayRef.current;
    if (from === value) return;
    if (!primedRef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.calm === '1') {
      primedRef.current = true;
      displayRef.current = value;
      setDisplay(value);
      return;
    }
    const startedAt = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / 600);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + (value - from) * eased;
      displayRef.current = current;
      setDisplay(current);
      frameRef.current = t < 1 ? requestAnimationFrame(tick) : null;
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [value]);

  return display;
}

export default function OverviewPage() {
  const { me } = useAuth();
  const [stats, setStats] = useState<CallStats | null>(null);
  const [usage, setUsage] = useState<MonthlyUsage | null>(null);
  const [recent, setRecent] = useState<CallDto[] | null>(null);
  const [inboundNumber, setInboundNumber] = useState<string | null | undefined>(undefined);
  const [callFilter, setCallFilter] = useState<CallFilter>('all');
  // Which home section a phone shows (below sm only). Held in page state;
  // at sm and up every section renders regardless, so nothing reads this
  // on larger screens.
  const [homeTab, setHomeTab] = useState<HomeTab>('overview');
  // Each block loads independently: one failing endpoint degrades only its
  // own section (with a retry) instead of blanking the whole home page.
  const [statsError, setStatsError] = useState<string | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const describeError = useCallback(
    (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback),
    [],
  );

  // Loaders shared by the first load and the background poll. A silent load
  // (a poll) keeps the last good data on failure and never raises the
  // per-section error states; a loud load (first load, manual retry) does.
  const loadStats = useCallback(
    (silent: boolean) =>
      CallsApi.stats()
        .then((res) => {
          setStatsError(null);
          setStats(res.stats);
          setUsage(res.usage);
        })
        .catch((err: unknown) => {
          if (!silent) setStatsError(describeError(err, 'Could not load your call stats.'));
        }),
    [describeError],
  );

  const loadRecent = useCallback(
    (silent: boolean) =>
      CallsApi.list({ page: 1, perPage: 5 })
        .then((res) => {
          setRecentError(null);
          setRecent(res.calls);
        })
        .catch((err: unknown) => {
          if (!silent) setRecentError(describeError(err, 'Could not load your recent calls.'));
        }),
    [describeError],
  );

  const loadSettings = useCallback(
    () =>
      AgentApi.get()
        .then((res) => {
          setSettingsError(null);
          setInboundNumber(res.settings.inboundPhoneNumber);
        })
        .catch((err: unknown) => {
          setSettingsError(describeError(err, 'Could not load your receptionist settings.'));
        }),
    [describeError],
  );

  // First load and manual retry: failures surface as per-section errors.
  useEffect(() => {
    void loadStats(false);
    void loadRecent(false);
    void loadSettings();
  }, [reloadKey, loadStats, loadRecent, loadSettings]);

  // Background refresh: while the tab is visible, re-check every 30 seconds
  // so a call that just ended (or one in progress, once the API reports it)
  // appears without a manual reload. The interval keeps running in hidden
  // tabs but each tick no-ops there, and coming back to the tab refreshes
  // right away. Poll failures stay silent by design.
  useEffect(() => {
    let inFlight = false;
    const poll = () => {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      void Promise.allSettled([loadStats(true), loadRecent(true)]).finally(() => {
        inFlight = false;
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') poll();
    };
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadStats, loadRecent]);

  const retry = () => setReloadKey((k) => k + 1);
  const statsPending = stats === null && statsError === null;
  const recentPending = recent === null && recentError === null;
  const settingsPending = inboundNumber === undefined && settingsError === null;

  // A call counts as live only while the API reports it with no end time.
  // Call rows are written when a call ends today, so in practice this stays
  // empty until the API also writes the row when a call starts, at which
  // point the panel and the table light up on their own. Nothing here
  // guesses or simulates a call.
  const liveCall = recent?.find((call) => call.endedAt === null) ?? null;

  // Ticking clock for the on-call timer; it only runs while a call is live.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!liveCall) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [liveCall]);

  const liveElapsedSeconds = liveCall
    ? Math.max(0, Math.floor((nowMs - new Date(liveCall.startedAt).getTime()) / 1000))
    : 0;

  // KPI and usage values ease to their new number when a poll changes them.
  const tweenedCalls7 = useTweenedNumber(stats?.callsLast7Days ?? 0);
  const tweenedCalls30 = useTweenedNumber(stats?.callsLast30Days ?? 0);
  const tweenedMinutes = useTweenedNumber(stats?.minutesLast30Days ?? 0);
  const tweenedSpendCents = useTweenedNumber(stats?.costCentsLast30Days ?? 0);
  const tweenedUsedMinutes = useTweenedNumber(usage?.usedMinutes ?? 0);

  if (statsPending && recentPending && settingsPending) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  // Page head, demo style: mono eyebrow with the date, time-aware greeting.
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const eyebrow = `${new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(now)} · ${new Intl.DateTimeFormat(
    'en-US',
    { month: 'short', day: 'numeric', year: 'numeric' },
  ).format(now)} — Overview`;
  const firstName = me?.user.fullName.split(' ')[0];

  // Usage bar tone: gradient normally, amber past 80%, red once the cap is hit.
  const usagePct = usage ? Math.round(usage.fractionUsed * 100) : 0;
  const usageBar =
    usage && usage.overLimit
      ? 'bg-danger'
      : usage && usage.fractionUsed >= 0.8
        ? 'bg-construction'
        : 'bg-grad';

  const filteredRecent = recent?.filter((call) => matchesFilter(call, callFilter)) ?? null;

  // Phone section wrappers: below sm only the active group shows, stacked
  // with the page's usual gap. At sm and up every wrapper is sm:contents,
  // so it drops out of the layout and the sections render exactly as they
  // did before the tabs existed.
  const sectionClass = (tab: HomeTab) =>
    homeTab === tab ? 'flex flex-col gap-6 sm:contents' : 'hidden sm:contents';

  const selectHomeTab = (tab: HomeTab) => {
    setHomeTab(tab);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  return (
    <>
      <div className="flex animate-fade-up flex-col gap-6 pb-20 sm:gap-8 sm:pb-0">
        <div className={sectionClass('overview')}>
          <div>
            <p className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-signal">
              {eyebrow}
            </p>
        <h1 className="font-display text-[26px] font-bold tracking-[-0.015em] text-ink sm:text-[36px]">
          {greeting}
          {firstName ? `, ${firstName}.` : '.'}
        </h1>
        <p className="mt-2 max-w-[56ch] text-[15px] leading-relaxed text-ink-muted">
          Here&apos;s how your receptionist has been doing.
        </p>
      </div>

      {/* Activation rescue: while the line has taken no calls in the last 30
          days, show the owner the setup steps (number, forwarding, self-test).
          It steps aside on its own once calls are flowing. */}
      {inboundNumber &&
        ((recent !== null && recent.length === 0) || (stats !== null && stats.callsLast30Days === 0)) && (
          <GoLiveGuide number={inboundNumber} />
        )}

      {statsError ? (
        <Card>
          <CardHeader title="Call activity" />
          <p className="text-sm text-ink-muted">Couldn&apos;t load your call stats. {statsError}</p>
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        </Card>
      ) : statsPending || !stats ? (
        <div className="flex h-28 items-center justify-center">
          <Spinner className="h-5 w-5 text-signal" />
        </div>
      ) : (
        <>
          {stats.rescueNeededLast7Days > 0 && (
            <Link
              href="/dashboard/calls"
              className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-danger/30 bg-danger-soft/40 px-4 py-3 transition-colors hover:bg-danger-soft/60"
            >
              <p className="text-sm text-ink">
                <span className="font-semibold">
                  {stats.rescueNeededLast7Days} caller{stats.rescueNeededLast7Days === 1 ? '' : 's'} still need
                  {stats.rescueNeededLast7Days === 1 ? 's' : ''} a callback
                </span>{' '}
                <span className="text-ink-muted">from calls that ended broken in the last 7 days.</span>
              </p>
              <span className="shrink-0 text-sm font-medium text-danger">Review calls →</span>
            </Link>
          )}
          <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-4">
          <StatCard
            label="Calls · last 7 days"
            value={String(Math.round(tweenedCalls7))}
            hint={stats.callsLast7Days === 0 ? 'No calls yet' : undefined}
            icon={
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                <path
                  d="M3.2 2.8h2.4l1.2 3.2-1.6 1.2a8.8 8.8 0 0 0 3.6 3.6l1.2-1.6 3.2 1.2v2.4a1.2 1.2 0 0 1-1.3 1.2C6.6 13.5 2.5 9.4 2 4.1a1.2 1.2 0 0 1 1.2-1.3Z"
                  strokeLinejoin="round"
                />
              </svg>
            }
          />
          <StatCard
            label="Calls · last 30 days"
            value={String(Math.round(tweenedCalls30))}
            hint={stats.callsLast30Days === 0 ? 'No calls yet' : undefined}
            icon={
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                <rect x="2.5" y="3" width="11" height="10.5" rx="2" />
                <path d="M2.5 6.5h11M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
              </svg>
            }
          />
          <StatCard
            label="Minutes handled · 30 days"
            value={String(Math.round(tweenedMinutes))}
            sublabel={`${stats.forwardedLast30Days} calls transferred to your team`}
            hint={stats.minutesLast30Days === 0 ? 'No minutes yet' : undefined}
            icon={
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
          />
          <StatCard
            label="Spend · last 30 days"
            value={formatCents(Math.round(tweenedSpendCents))}
            hint={stats.costCentsLast30Days === 0 ? 'No spend yet' : undefined}
            icon={
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                <circle cx="8" cy="8" r="6" />
                <path d="M10 6.2c-.4-.7-1.1-1-2-1-1.1 0-1.9.6-1.9 1.4 0 2 4 1 4 2.9 0 .9-.9 1.4-2.1 1.4-1 0-1.7-.4-2.1-1.1M8 3.8v8.4" strokeLinecap="round" />
              </svg>
            }
          />
          </div>
        </>
      )}

        </div>

        <div className={sectionClass('receptionist')}>
      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        {/* Receptionist status: the demo's dark live panel, carrying the real
            number and settings states. It shows an on-a-call state only while
            the API reports a call with no end time, never a staged one. */}
        <div
          className={`relative overflow-hidden rounded-[18px] border bg-shell-grad p-5 text-shell-ink shadow-card transition-colors sm:p-[22px] ${
            liveCall ? 'border-[rgba(94,234,212,0.45)]' : 'border-shell-edge/15'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-display text-[17px] font-semibold">Your receptionist</h3>
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-shell-faint">
              Receptionist line
            </span>
          </div>
          {settingsError ? (
            <div className="mt-4">
              <p className="text-sm leading-relaxed text-shell-mut">
                Couldn&apos;t load your number. {settingsError}
              </p>
              <button
                type="button"
                onClick={retry}
                className="mt-3 rounded-full border border-white/15 px-3.5 py-2 text-xs font-bold text-shell-mut transition-colors hover:bg-white/[0.06] hover:text-shell-ink"
              >
                Try again
              </button>
            </div>
          ) : inboundNumber ? (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span aria-hidden className="live-dot h-2 w-2 shrink-0 rounded-full bg-clinic" />
                <p className="font-mono text-xl font-semibold tracking-tight text-shell-ink sm:text-2xl">
                  {formatPhone(inboundNumber)}
                </p>
                <span className="ml-auto rounded-full border border-[rgba(94,234,212,0.35)] bg-[rgba(20,184,166,0.12)] px-3 py-1 text-xs font-bold text-[#CFFCEF]">
                  {liveCall ? 'On a call now' : 'Live'}
                </span>
              </div>
              {liveCall && (
                <p role="status" className="mt-3 text-[13.5px] font-semibold leading-relaxed text-shell-ink">
                  On a call now · {formatPhone(liveCall.callerNumber)} ·{' '}
                  <span className="tabular-nums">{formatDuration(liveElapsedSeconds)}</span>
                </p>
              )}
              <div aria-hidden className="mt-5 flex h-[52px] items-center gap-[3px]">
                {WAVE_BARS.map((height, i) => (
                  <span
                    key={i}
                    className={`logo-eq-bar ${liveCall ? 'logo-eq-live' : ''} w-[3px] rounded-full bg-[linear-gradient(180deg,#5EEAD4,#0EA5C6)]`}
                    style={{ height: `${height}px`, animationDelay: `${i * 0.12}s` }}
                  />
                ))}
              </div>
              <p className="mt-3 text-[13.5px] leading-relaxed text-shell-mut">
                {liveCall
                  ? 'Your receptionist is talking with a caller right now. The summary and recording land in your call history as soon as the call wraps up.'
                  : 'Your AI receptionist answers on this number around the clock. Every call is recorded and summarized in your call history.'}
              </p>
              <div className="mt-4 flex flex-wrap gap-2.5">
                <Link
                  href="/dashboard/calls"
                  className="rounded-full border border-[rgba(94,234,212,0.35)] bg-[rgba(20,184,166,0.12)] px-3.5 py-2 text-xs font-bold text-[#CFFCEF] transition-colors hover:bg-[rgba(20,184,166,0.25)]"
                >
                  View calls
                </Link>
                <Link
                  href="/dashboard/settings"
                  className="rounded-full border border-white/15 px-3.5 py-2 text-xs font-bold text-shell-mut transition-colors hover:bg-white/[0.06] hover:text-shell-ink"
                >
                  Receptionist settings
                </Link>
              </div>
            </>
          ) : (
            <p className="mt-4 text-sm leading-relaxed text-shell-mut">
              {settingsPending
                ? 'Loading your number…'
                : "Your dedicated number is being provisioned. We'll connect it to your account shortly — no action needed on your side."}
            </p>
          )}
        </div>

        {/* Usage: the demo's breakdown treatment over the real monthly usage. */}
        <Card className="p-5 sm:p-[22px]">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-display text-[17px] font-semibold text-ink">Usage this month</h3>
            {usage && (
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                {usagePct}% used
              </span>
            )}
          </div>
          {usage ? (
            <div className="mt-4">
              <p className="font-display text-[26px] font-semibold leading-none tracking-tight text-ink">
                {Math.round(tweenedUsedMinutes)}
                <span className="text-base font-normal text-ink-muted"> / {usage.limitMinutes} min</span>
              </p>
              <div className="mt-4 grid grid-cols-[64px_1fr_44px] items-center gap-3">
                <span className="text-[13px] font-semibold text-ink">Minutes</span>
                <span className="h-2 overflow-hidden rounded-full bg-surface3">
                  <span
                    className={`block h-full rounded-full transition-all ${usageBar}`}
                    style={{ width: `${Math.max(2, Math.min(100, usagePct))}%` }}
                  />
                </span>
                <span className="text-right text-[13px] font-semibold tabular-nums text-ink-muted">{usagePct}%</span>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                {usage.overLimit
                  ? 'Monthly limit reached — calls are paused until the 1st. Contact us to raise your plan.'
                  : `${usage.remainingMinutes} minutes left · resets on the 1st`}
              </p>
            </div>
          ) : statsError ? (
            <div className="mt-4">
              <p className="text-sm text-ink-muted">Couldn&apos;t load your usage. {statsError}</p>
              <div className="mt-3">
                <Button variant="secondary" size="sm" onClick={retry}>
                  Try again
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex h-16 items-center justify-center">
              <Spinner className="h-5 w-5 text-signal" />
            </div>
          )}
        </Card>
      </div>
        </div>

        <div className={sectionClass('calls')}>
      {/* Recent calls: fed by the real call list, with the demo's outcome
          filters working over the loaded rows. At sm and up the table below
          renders as it always has; on phones the same rows show as cards. */}
      <Card className="p-5 sm:p-[22px]">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-[17px] font-semibold text-ink">Recent calls</h3>
            <span className="mt-1 block font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Every call recorded · Summary attached
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter calls">
              {CALL_FILTERS.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  onClick={() => setCallFilter(filter.key)}
                  aria-pressed={callFilter === filter.key}
                  className={`rounded-full border px-3.5 py-[7px] text-xs font-bold transition-all duration-200 ${
                    callFilter === filter.key
                      ? 'border-transparent bg-ink text-paper'
                      : 'border-line-strong bg-surface text-ink-muted hover:text-ink'
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <Link
              href="/dashboard/calls"
              className="text-sm font-semibold text-signal-deep hover:underline"
            >
              View all →
            </Link>
          </div>
        </div>
        {recentError ? (
          <div className="py-4">
            <p className="text-sm text-ink-muted">Couldn&apos;t load your recent calls. {recentError}</p>
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={retry}>
                Try again
              </Button>
            </div>
          </div>
        ) : recentPending || !recent || !filteredRecent ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner className="h-5 w-5 text-signal" />
          </div>
        ) : recent.length === 0 ? (
          <EmptyState
            title="No calls yet"
            description="Once your number is connected, every call lands here with a summary and recording."
          />
        ) : filteredRecent.length === 0 ? (
          <p className="py-4 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            No calls match that filter
          </p>
        ) : (
          <>
            {/* Phones: the same filtered rows as compact cards, same data,
                same badges, same detail target as the table rows. */}
            <div className="flex flex-col gap-2.5 sm:hidden">
              {filteredRecent.map((call) => (
                <Link
                  key={call.id}
                  href={`/dashboard/calls/${call.id}`}
                  className="block rounded-[14px] border border-line bg-surface p-3.5 transition-colors hover:bg-surface3"
                >
                  <span className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full border border-line bg-surface3 text-signal"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                        <path
                          d="M3.2 2.8h2.4l1.2 3.2-1.6 1.2a8.8 8.8 0 0 0 3.6 3.6l1.2-1.6 3.2 1.2v2.4a1.2 1.2 0 0 1-1.3 1.2C6.6 13.5 2.5 9.4 2 4.1a1.2 1.2 0 0 1 1.2-1.3Z"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-ink">
                        {call.callerNumber ? formatPhone(call.callerNumber) : 'Unknown caller'}
                      </span>
                      <span className="block truncate text-xs text-ink-faint">
                        {formatDateTime(call.startedAt)}
                      </span>
                    </span>
                    {call.endedAt === null ? (
                      <Badge tone="success" dot>
                        On a call
                      </Badge>
                    ) : call.appointmentBooked ? (
                      <Badge tone="success">Booked</Badge>
                    ) : (
                      <CallStatusBadge status={call.status} />
                    )}
                  </span>
                  <span className="mt-2.5 block truncate text-sm text-ink-soft">
                    {call.endedAt === null ? 'Call in progress' : (call.summary ?? call.outcome ?? '—')}
                  </span>
                  <span className="mt-1 block text-xs tabular-nums text-ink-muted">
                    {call.endedAt === null
                      ? formatDuration(
                          Math.max(0, Math.floor((nowMs - new Date(call.startedAt).getTime()) / 1000)),
                        )
                      : formatDuration(call.durationSeconds)}
                    {' · '}
                    {TIME_FMT.format(new Date(call.startedAt))}
                  </span>
                </Link>
              ))}
            </div>
            <table className="hidden w-full border-collapse sm:table">
            <thead className="hidden sm:table-header-group">
              <tr>
                {['Caller', 'Summary', 'Outcome', 'Duration', 'When'].map((heading) => (
                  <th
                    key={heading}
                    className="border-b border-line px-3 py-2.5 text-left font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-faint"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRecent.map((call) => (
                <tr
                  key={call.id}
                  className="relative block border-b border-line py-3 transition-colors last:border-none hover:bg-surface sm:table-row sm:py-0"
                >
                  <td className="block px-3 py-1 sm:table-cell sm:py-3.5">
                    <span className="flex items-center gap-3">
                      <span
                        aria-hidden
                        className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full border border-line bg-surface3 text-signal"
                      >
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                          <path
                            d="M3.2 2.8h2.4l1.2 3.2-1.6 1.2a8.8 8.8 0 0 0 3.6 3.6l1.2-1.6 3.2 1.2v2.4a1.2 1.2 0 0 1-1.3 1.2C6.6 13.5 2.5 9.4 2 4.1a1.2 1.2 0 0 1 1.2-1.3Z"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                      <span className="min-w-0">
                        <Link
                          href={`/dashboard/calls/${call.id}`}
                          className="block truncate text-sm font-bold text-ink after:absolute after:inset-0 hover:underline"
                        >
                          {call.callerNumber ? formatPhone(call.callerNumber) : 'Unknown caller'}
                        </Link>
                        <span className="block truncate text-xs text-ink-faint">
                          {formatDateTime(call.startedAt)}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td className="block max-w-[420px] truncate px-3 py-1 text-sm text-ink-soft sm:table-cell sm:py-3.5">
                    {call.endedAt === null ? 'Call in progress' : (call.summary ?? call.outcome ?? '—')}
                  </td>
                  <td className="block px-3 py-1 sm:table-cell sm:py-3.5">
                    {call.endedAt === null ? (
                      <Badge tone="success" dot>
                        On a call
                      </Badge>
                    ) : call.appointmentBooked ? (
                      <Badge tone="success">Booked</Badge>
                    ) : (
                      <CallStatusBadge status={call.status} />
                    )}
                  </td>
                  <td className="block px-3 py-1 text-sm tabular-nums text-ink-soft sm:table-cell sm:py-3.5">
                    {call.endedAt === null
                      ? formatDuration(
                          Math.max(0, Math.floor((nowMs - new Date(call.startedAt).getTime()) / 1000)),
                        )
                      : formatDuration(call.durationSeconds)}
                  </td>
                  <td className="block px-3 py-1 text-sm text-ink-muted sm:table-cell sm:py-3.5">
                    {TIME_FMT.format(new Date(call.startedAt))}
                  </td>
                </tr>
              ))}
            </tbody>
            </table>
          </>
        )}
      </Card>
        </div>
      </div>

      {/* Phone section tabs: fixed to the bottom of the screen below sm,
          switching which home section shows. Page sections only, the app
          navigation stays in the topbar and drawer. Rendered outside the
          animated page root so the fade transform cannot trap the fixed
          positioning, and the page root carries bottom padding below sm
          so the bar never covers content. */}
      <nav
        aria-label="Home sections"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-[var(--vf-topbar)] backdrop-blur-[14px] sm:hidden"
      >
        <div className="grid grid-cols-3 pb-[env(safe-area-inset-bottom)]" role="tablist">
          {HOME_TABS.map((tab) => {
            const active = homeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => selectHomeTab(tab.key)}
                className={`flex flex-col items-center gap-1 px-2 py-2.5 text-[11px] font-bold transition-colors ${
                  active ? 'text-signal-deep' : 'text-ink-muted hover:text-ink'
                }`}
              >
                <span className="relative">
                  {tab.icon}
                  {tab.key === 'receptionist' && liveCall && (
                    <span
                      aria-hidden
                      className="live-dot absolute -right-1.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-clinic"
                    />
                  )}
                </span>
                {tab.label}
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
