'use client';

import { useEffect, useState } from 'react';
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

const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/** Decorative waveform heights for the receptionist panel (px). */
const WAVE_BARS = [26, 40, 30, 48, 36, 22, 44, 28, 38, 18, 42, 30, 46, 24, 34, 20, 40, 27];

export default function OverviewPage() {
  const { me } = useAuth();
  const [stats, setStats] = useState<CallStats | null>(null);
  const [usage, setUsage] = useState<MonthlyUsage | null>(null);
  const [recent, setRecent] = useState<CallDto[] | null>(null);
  const [inboundNumber, setInboundNumber] = useState<string | null | undefined>(undefined);
  const [callFilter, setCallFilter] = useState<CallFilter>('all');
  // Each block loads independently: one failing endpoint degrades only its
  // own section (with a retry) instead of blanking the whole home page.
  const [statsError, setStatsError] = useState<string | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const describe = (err: unknown, fallback: string) =>
      err instanceof ApiError ? err.message : fallback;

    CallsApi.stats()
      .then((res) => {
        if (cancelled) return;
        setStatsError(null);
        setStats(res.stats);
        setUsage(res.usage);
      })
      .catch((err: unknown) => {
        if (!cancelled) setStatsError(describe(err, 'Could not load your call stats.'));
      });
    CallsApi.list({ page: 1, perPage: 5 })
      .then((res) => {
        if (cancelled) return;
        setRecentError(null);
        setRecent(res.calls);
      })
      .catch((err: unknown) => {
        if (!cancelled) setRecentError(describe(err, 'Could not load your recent calls.'));
      });
    AgentApi.get()
      .then((res) => {
        if (cancelled) return;
        setSettingsError(null);
        setInboundNumber(res.settings.inboundPhoneNumber);
      })
      .catch((err: unknown) => {
        if (!cancelled) setSettingsError(describe(err, 'Could not load your receptionist settings.'));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const retry = () => setReloadKey((k) => k + 1);
  const statsPending = stats === null && statsError === null;
  const recentPending = recent === null && recentError === null;
  const settingsPending = inboundNumber === undefined && settingsError === null;

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

  return (
    <div className="flex animate-fade-up flex-col gap-6 sm:gap-8">
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

      {/* Activation rescue: once live but before the first call lands, show the
          owner the one real-world step (forward the line) + a self-test. */}
      {inboundNumber && recent !== null && recent.length === 0 && <GoLiveGuide number={inboundNumber} />}

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
        <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-4">
          <StatCard
            label="Calls · last 7 days"
            value={String(stats.callsLast7Days)}
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
            value={String(stats.callsLast30Days)}
            icon={
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                <rect x="2.5" y="3" width="11" height="10.5" rx="2" />
                <path d="M2.5 6.5h11M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
              </svg>
            }
          />
          <StatCard
            label="Minutes handled · 30 days"
            value={String(stats.minutesLast30Days)}
            sublabel={`${stats.forwardedLast30Days} calls transferred to your team`}
            icon={
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
          />
          <StatCard
            label="Spend · last 30 days"
            value={formatCents(stats.costCentsLast30Days)}
            icon={
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                <circle cx="8" cy="8" r="6" />
                <path d="M10 6.2c-.4-.7-1.1-1-2-1-1.1 0-1.9.6-1.9 1.4 0 2 4 1 4 2.9 0 .9-.9 1.4-2.1 1.4-1 0-1.7-.4-2.1-1.1M8 3.8v8.4" strokeLinecap="round" />
              </svg>
            }
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        {/* Receptionist status: the demo's dark live panel, carrying the real
            number and settings states instead of a staged live call. */}
        <div className="relative overflow-hidden rounded-[18px] border border-shell-edge/15 bg-shell-grad p-5 text-shell-ink shadow-card sm:p-[22px]">
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
                  Live
                </span>
              </div>
              <div aria-hidden className="mt-5 flex h-[52px] items-center gap-[3px]">
                {WAVE_BARS.map((height, i) => (
                  <span
                    key={i}
                    className="logo-eq-bar w-[3px] rounded-full bg-[linear-gradient(180deg,#5EEAD4,#0EA5C6)]"
                    style={{ height: `${height}px`, animationDelay: `${i * 0.12}s` }}
                  />
                ))}
              </div>
              <p className="mt-3 text-[13.5px] leading-relaxed text-shell-mut">
                Your AI receptionist answers on this number around the clock. Every call is recorded and
                summarized in your call history.
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
                {usage.usedMinutes}
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

      {/* Recent calls: the demo's table, fed by the real call list, with the
          demo's outcome filters working over the loaded rows. */}
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
          <table className="w-full border-collapse">
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
                    {call.summary ?? call.outcome ?? '—'}
                  </td>
                  <td className="block px-3 py-1 sm:table-cell sm:py-3.5">
                    {call.appointmentBooked ? (
                      <Badge tone="success">Booked</Badge>
                    ) : (
                      <CallStatusBadge status={call.status} />
                    )}
                  </td>
                  <td className="block px-3 py-1 text-sm tabular-nums text-ink-soft sm:table-cell sm:py-3.5">
                    {formatDuration(call.durationSeconds)}
                  </td>
                  <td className="block px-3 py-1 text-sm text-ink-muted sm:table-cell sm:py-3.5">
                    {TIME_FMT.format(new Date(call.startedAt))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
