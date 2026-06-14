'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AdminApi, ApiError, type AdminOverview } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatCents, formatDateTime, formatDuration, formatPhone } from '@/lib/format';
import { Badge, Card, CardHeader, CallStatusBadge, EmptyState, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';

const CONFIG_LABELS: Record<string, string> = {
  VAPI_PUBLIC_KEY: 'Vapi public key',
  VAPI_WEBHOOK_SECRET: 'Vapi webhook secret',
  PUBLIC_API_URL: 'Public API URL',
};

export default function AdminOverviewPage() {
  const { me } = useAuth();
  const isFullAdmin = me?.user.adminRole === 'ADMIN';
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    AdminApi.overview(controller.signal)
      .then(({ overview }) => setOverview(overview))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Could not load the overview.');
      });
    return () => controller.abort();
  }, [reloadKey]);

  if (error) {
    return (
      <EmptyState
        title="Couldn't load the overview"
        description={error}
        action={
          <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!overview) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  return (
    <div className="flex animate-fade-up flex-col gap-8">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Business at a glance</h2>
        <p className="mt-1.5 text-sm text-ink-muted">Live numbers across every workspace on the platform.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Customers" value={String(overview.tenants)} sublabel={`${overview.activeReceptionists} live receptionists`} accent />
        <StatCard label="Calls today" value={String(overview.callsToday)} sublabel={`${overview.calls30d} in the last 30 days`} />
        <StatCard label="Billed (30d)" value={formatCents(overview.billed30dCents)} sublabel={`${overview.minutes30d} minutes of calls`} />
        <StatCard
          label="Your margin (30d)"
          value={formatCents(overview.profit30dCents)}
          sublabel={`provider cost ${formatCents(overview.providerCost30dCents)}`}
          accent
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card padded={false}>
          <div className="px-6 pt-5">
            <CardHeader title="Latest calls" description="Most recent activity across all customers" />
          </div>
          {overview.recentCalls.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-ink-muted">No calls yet.</p>
          ) : (
            <ul className="divide-y divide-line/60 px-6 pb-4">
              {overview.recentCalls.map((call) => (
                <li key={call.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{call.company}</p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {formatDateTime(call.startedAt)} · {formatDuration(call.durationSeconds)} ·{' '}
                      {call.channel === 'web' ? 'browser test' : formatPhone(call.callerNumber)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="font-mono text-xs text-ink-muted">{formatCents(call.billedCents)}</span>
                    <CallStatusBadge status={call.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          {isFullAdmin && (
          <Card>
            <CardHeader title="System status" />
            <ul className="mt-1 flex flex-col gap-3">
              {overview.config.map((item) => (
                <li key={item.key} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-ink">{CONFIG_LABELS[item.key] ?? item.key}</span>
                  {item.configured ? (
                    <Badge tone="success" dot>
                      {item.source === 'admin' ? 'Set in admin' : 'From .env'}
                    </Badge>
                  ) : (
                    <Badge tone="warning" dot>
                      Not set
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            <Link
              href="/admin/config"
              className="mt-4 block text-center text-sm font-semibold text-signal-deep transition-colors hover:text-signal"
            >
              Manage keys & config →
            </Link>
          </Card>
          )}
          <Card>
            <CardHeader title="Bookings (30d)" />
            <p className="font-display text-4xl font-bold tracking-tight text-ink">{overview.bookings30d}</p>
            <p className="mt-1 text-xs text-ink-muted">appointments booked by voice agents</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
