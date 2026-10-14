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
import { Card, CardHeader, CallStatusBadge, EmptyState, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { GoLiveGuide } from '@/components/dashboard/GoLiveGuide';

export default function OverviewPage() {
  const { me } = useAuth();
  const [stats, setStats] = useState<CallStats | null>(null);
  const [usage, setUsage] = useState<MonthlyUsage | null>(null);
  const [recent, setRecent] = useState<CallDto[] | null>(null);
  const [inboundNumber, setInboundNumber] = useState<string | null | undefined>(undefined);
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

  // Usage bar tone: green normally, amber past 80%, red once the cap is hit.
  const usagePct = usage ? Math.round(usage.fractionUsed * 100) : 0;
  const usageTone =
    usage && usage.overLimit
      ? { bar: 'bg-danger', text: 'text-danger' }
      : usage && usage.fractionUsed >= 0.8
        ? { bar: 'bg-construction', text: 'text-construction' }
        : { bar: 'bg-clinic', text: 'text-clinic' };

  return (
    <div className="flex animate-fade-up flex-col gap-8">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">
          Welcome back{me ? `, ${me.user.fullName.split(' ')[0]}` : ''}
        </h2>
        <p className="mt-1.5 text-sm text-ink-muted">Here&apos;s how your receptionist has been doing.</p>
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Calls · last 7 days"
          value={String(stats.callsLast7Days)}
          accent
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

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader
            title="Recent calls"
            action={
              <Link href="/dashboard/calls" className="text-sm font-medium text-signal-deep hover:underline">
                View all →
              </Link>
            }
          />
          {recentError ? (
            <div>
              <p className="text-sm text-ink-muted">Couldn&apos;t load your recent calls. {recentError}</p>
              <div className="mt-3">
                <Button variant="secondary" size="sm" onClick={retry}>
                  Try again
                </Button>
              </div>
            </div>
          ) : recentPending || !recent ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner className="h-5 w-5 text-signal" />
            </div>
          ) : recent.length === 0 ? (
            <EmptyState
              title="No calls yet"
              description="Once your number is connected, every call lands here with a summary and recording."
            />
          ) : (
            <ul className="divide-y divide-line/60">
              {recent.map((call) => (
                <li key={call.id}>
                  <Link
                    href={`/dashboard/calls/${call.id}`}
                    className="group -mx-2 flex items-center justify-between gap-4 rounded-xl px-2 py-3 transition-colors hover:bg-paper/80"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        aria-hidden
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper text-ink-muted ring-1 ring-inset ring-ink/5 transition-colors group-hover:bg-signal-soft/60 group-hover:text-signal-deep"
                      >
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                          <path
                            d="M3.2 2.8h2.4l1.2 3.2-1.6 1.2a8.8 8.8 0 0 0 3.6 3.6l1.2-1.6 3.2 1.2v2.4a1.2 1.2 0 0 1-1.3 1.2C6.6 13.5 2.5 9.4 2 4.1a1.2 1.2 0 0 1 1.2-1.3Z"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">{formatPhone(call.callerNumber)}</p>
                        <p className="truncate text-xs text-ink-muted">
                          {formatDateTime(call.startedAt)} · {formatDuration(call.durationSeconds)}
                        </p>
                      </div>
                    </div>
                    <CallStatusBadge status={call.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-6">
          <div className="relative overflow-hidden rounded-2xl border border-ink/20 bg-ink p-6 shadow-lift">
            <div
              aria-hidden
              className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-signal/25 blur-3xl"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -bottom-20 -left-10 h-40 w-40 rounded-full bg-signal-deep/20 blur-3xl"
            />
            <div className="relative">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/50">
                Your receptionist number
              </p>
              {settingsError ? (
                <div className="mt-3">
                  <p className="text-sm leading-relaxed text-white/70">
                    Couldn&apos;t load your number. {settingsError}
                  </p>
                  <button
                    type="button"
                    onClick={retry}
                    className="mt-2 text-sm font-semibold text-white underline underline-offset-2"
                  >
                    Try again
                  </button>
                </div>
              ) : inboundNumber ? (
                <p className="mt-3 font-mono text-xl font-medium tracking-tight text-white">
                  {formatPhone(inboundNumber)}
                </p>
              ) : (
                <p className="mt-3 text-sm leading-relaxed text-white/70">
                  {settingsPending
                    ? 'Loading your number…'
                    : "Your dedicated number is being provisioned. We'll connect it to your account shortly — no action needed on your side."}
                </p>
              )}
              <span aria-hidden className="mt-5 flex items-end gap-[3px] opacity-60">
                {[8, 14, 10, 18, 12, 7, 15, 9, 13, 6].map((h, i) => (
                  <span key={i} className="w-[3px] rounded-full bg-signal" style={{ height: `${h}px` }} />
                ))}
              </span>
            </div>
          </div>
          <Card>
            <CardHeader title="Usage this month" />
            {usage ? (
              <>
                <div className="flex items-baseline justify-between">
                  <p className="font-display text-2xl font-semibold tracking-tight text-ink">
                    {usage.usedMinutes}
                    <span className="text-base font-normal text-ink-muted"> / {usage.limitMinutes} min</span>
                  </p>
                  <span className={`text-xs font-semibold ${usageTone.text}`}>{usagePct}%</span>
                </div>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-paper ring-1 ring-inset ring-ink/5">
                  <div
                    className={`h-full rounded-full transition-all ${usageTone.bar}`}
                    style={{ width: `${Math.max(2, Math.min(100, usagePct))}%` }}
                  />
                </div>
                <p className="mt-2.5 text-xs leading-relaxed text-ink-muted">
                  {usage.overLimit
                    ? 'Monthly limit reached — calls are paused until the 1st. Contact us to raise your plan.'
                    : `${usage.remainingMinutes} minutes left · resets on the 1st`}
                </p>
              </>
            ) : statsError ? (
              <div>
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
          <Card>
            <CardHeader title="Fine-tune anytime" />
            <p className="text-sm leading-relaxed text-ink-muted">
              Update instructions, hours, or transfer lines and every new call picks up the changes instantly.
            </p>
            <Link href="/dashboard/settings" className="mt-4 inline-block">
              <Button variant="secondary" size="sm">
                Open receptionist settings
              </Button>
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}
