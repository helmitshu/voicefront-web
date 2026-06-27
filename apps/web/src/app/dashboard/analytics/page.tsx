'use client';

import { useEffect, useState } from 'react';
import { AnalyticsApi, ApiError, type AnalyticsOverview } from '@/lib/api';
import { Badge, Card, CardHeader, EmptyState, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    AnalyticsApi.overview(days, controller.signal)
      .then(({ overview }) => setData(overview))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Could not load analytics.');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [days]);

  return (
    <div className="flex animate-fade-up flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Analytics</h2>
          <p className="mt-1.5 text-sm text-ink-muted">How your receptionist is turning calls into booked revenue.</p>
        </div>
        <div className="inline-flex rounded-xl border border-line/70 bg-white p-1 shadow-input">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              onClick={() => setDays(r.days)}
              className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
                days === r.days ? 'bg-signal-soft/70 text-signal-deep' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <EmptyState
          title="Couldn't load analytics"
          description={error}
          action={
            <Button variant="secondary" onClick={() => setDays((d) => d)}>
              Try again
            </Button>
          }
        />
      ) : loading || !data ? (
        <div className="flex h-64 items-center justify-center">
          <Spinner className="h-6 w-6 text-signal" />
        </div>
      ) : (
        <Overview data={data} />
      )}
    </div>
  );
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function Overview({ data }: { data: AnalyticsOverview }) {
  const empty = data.totalCalls === 0 && data.totalBookings === 0;
  // Defensive default in case a new web build briefly hits an older API.
  const r = data.revenue ?? {
    avgAppointmentValue: 0,
    capturedBookings: 0,
    estimatedRevenue: 0,
    afterHoursCalls: 0,
    afterHoursBookings: 0,
  };
  const co = data.callOutcomes ?? {
    analyzedCalls: 0,
    byOutcome: { BOOKED: 0, RESCHEDULED: 0, CANCELLED: 0, JOB_LOGGED: 0, MESSAGE_TAKEN: 0, TRANSFERRED: 0, NO_ACTION: 0 },
    urgency: { emergency: 0, urgent: 0, routine: 0 },
    leads: { hot: 0, warm: 0, cold: 0 },
    avgQualityScore: null,
    scoredCalls: 0,
    qualityTrend: [],
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Revenue captured — the headline ROI number */}
      <div className="overflow-hidden rounded-3xl border border-signal/20 bg-gradient-to-br from-signal-soft/60 via-white to-white p-6 shadow-card sm:p-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-deep">
              Revenue your receptionist captured
            </p>
            {r.avgAppointmentValue > 0 ? (
              <p className="mt-2 font-display text-[44px] font-bold leading-none tracking-tight text-ink">
                {money(r.estimatedRevenue)}
              </p>
            ) : (
              <p className="mt-2 max-w-md text-sm text-ink-muted">
                Set your average appointment value in{' '}
                <a href="/dashboard/settings" className="font-semibold text-signal underline">
                  Settings
                </a>{' '}
                to see the revenue your receptionist captured.
              </p>
            )}
            <p className="mt-2 text-[13px] text-ink-muted">
              {r.avgAppointmentValue > 0 ? (
                <>
                  {r.capturedBookings} appointment{r.capturedBookings === 1 ? '' : 's'} booked by the
                  receptionist × {money(r.avgAppointmentValue)} avg · last {data.rangeDays} days
                </>
              ) : (
                <>
                  {r.capturedBookings} appointment{r.capturedBookings === 1 ? '' : 's'} booked by the
                  receptionist · last {data.rangeDays} days
                </>
              )}
            </p>
          </div>
          <div className="flex gap-6">
            <div>
              <p className="font-display text-2xl font-semibold text-ink">{r.afterHoursCalls}</p>
              <p className="mt-0.5 max-w-[7rem] text-[12px] leading-snug text-ink-muted">
                calls caught after hours
              </p>
            </div>
            <div>
              <p className="font-display text-2xl font-semibold text-ink">{r.afterHoursBookings}</p>
              <p className="mt-0.5 max-w-[7rem] text-[12px] leading-snug text-ink-muted">
                booked while you were closed
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Headline stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Calls handled"
          value={String(data.totalCalls)}
          accent
          sublabel={`Over the last ${data.rangeDays} days`}
        />
        <StatCard label="Appointments booked" value={String(data.totalBookings)} sublabel={`${data.bookingsBySource.voice} by the receptionist`} />
        <StatCard
          label="Call → booking rate"
          value={pct(data.conversionRate)}
          sublabel="Share of calls that became a booking"
        />
        <StatCard
          label="No-show rate"
          value={pct(data.noShowRate)}
          sublabel="Of appointments that came due"
        />
      </div>

      {empty ? (
        <EmptyState
          title="No activity yet"
          description="Once your receptionist starts answering calls and booking appointments, your trends will show up here."
        />
      ) : (
        <>
          {/* Calls vs bookings over time */}
          <Card>
            <CardHeader
              title="Calls & bookings over time"
              description="Daily volume across the selected window."
              action={
                <div className="flex items-center gap-4 text-xs">
                  <Legend swatch="bg-line" label="Calls" />
                  <Legend swatch="bg-signal" label="Bookings" />
                </div>
              }
            />
            <DailyChart daily={data.daily} />
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Busiest hours */}
            <Card>
              <CardHeader title="Busiest booking hours" description="When appointments are scheduled to start." />
              <HourChart byHour={data.byHour} />
            </Card>

            {/* Busiest weekdays */}
            <Card>
              <CardHeader title="Busiest days" description="Which weekdays fill up most." />
              <WeekdayChart byWeekday={data.byWeekday} />
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Status breakdown */}
            <Card>
              <CardHeader title="Appointment outcomes" description="Status of bookings created in this window." />
              <StatusBreakdown status={data.bookingsByStatus} />
            </Card>

            {/* Source split */}
            <Card>
              <CardHeader title="Who's booking" description="Receptionist vs. bookings you add by hand." />
              <SourceSplit source={data.bookingsBySource} />
            </Card>
          </div>

          {/* AI call-outcome analytics — what callers needed and how well it went */}
          {co.analyzedCalls > 0 && (
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader
                  title="What callers needed"
                  description={`How your receptionist handled ${co.analyzedCalls} analyzed call${co.analyzedCalls === 1 ? '' : 's'}.`}
                />
                <OutcomeBreakdown byOutcome={co.byOutcome} urgency={co.urgency} leads={co.leads} />
              </Card>
              <Card>
                <CardHeader title="Agent quality" description="Average score the AI gave each handled call (1–10)." />
                <QualityCard avgScore={co.avgQualityScore} scoredCalls={co.scoredCalls} trend={co.qualityTrend} />
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── AI call-outcome breakdown ─────────────────────────────────────────────── */
const OUTCOME_SEGMENTS: Array<{ key: keyof AnalyticsOverview['callOutcomes']['byOutcome']; label: string; color: string }> = [
  { key: 'BOOKED', label: 'Booked', color: 'bg-signal' },
  { key: 'JOB_LOGGED', label: 'Job logged', color: 'bg-clinic' },
  { key: 'TRANSFERRED', label: 'Transferred', color: 'bg-signal-deep' },
  { key: 'MESSAGE_TAKEN', label: 'Message taken', color: 'bg-ink-muted/50' },
  { key: 'RESCHEDULED', label: 'Rescheduled', color: 'bg-construction' },
  { key: 'CANCELLED', label: 'Cancelled', color: 'bg-construction/60' },
  { key: 'NO_ACTION', label: 'No action', color: 'bg-danger/70' },
];

function OutcomeBreakdown({
  byOutcome,
  urgency,
  leads,
}: {
  byOutcome: AnalyticsOverview['callOutcomes']['byOutcome'];
  urgency: AnalyticsOverview['callOutcomes']['urgency'];
  leads: AnalyticsOverview['callOutcomes']['leads'];
}) {
  const segments = OUTCOME_SEGMENTS.map((s) => ({ ...s, value: byOutcome[s.key] }));
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <div className="flex flex-col gap-4">
      {total > 0 ? (
        <>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-paper ring-1 ring-inset ring-ink/5">
            {segments.map((s) =>
              s.value > 0 ? (
                <div key={s.key} className={s.color} style={{ width: `${(s.value / total) * 100}%` }} title={`${s.label}: ${s.value}`} />
              ) : null,
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {segments
              .filter((s) => s.value > 0)
              .map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-2 text-sm">
                  <span className="inline-flex items-center gap-2 text-ink-muted">
                    <span className={`h-2.5 w-2.5 rounded-sm ${s.color}`} aria-hidden />
                    {s.label}
                  </span>
                  <span className="font-semibold tabular-nums text-ink">{s.value}</span>
                </div>
              ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-ink-muted">No call outcomes recorded in this window yet.</p>
      )}
      {(urgency.emergency > 0 || urgency.urgent > 0 || leads.hot > 0) && (
        <div className="flex flex-wrap gap-2 border-t border-line/60 pt-4">
          {urgency.emergency > 0 && <Badge tone="danger" dot>{urgency.emergency} emergency</Badge>}
          {urgency.urgent > 0 && <Badge tone="warning" dot>{urgency.urgent} urgent</Badge>}
          {leads.hot > 0 && <Badge tone="success">{leads.hot} hot lead{leads.hot === 1 ? '' : 's'}</Badge>}
        </div>
      )}
    </div>
  );
}

/* ── Agent quality score + trend ───────────────────────────────────────────── */
function QualityCard({
  avgScore,
  scoredCalls,
  trend,
}: {
  avgScore: number | null;
  scoredCalls: number;
  trend: AnalyticsOverview['callOutcomes']['qualityTrend'];
}) {
  if (avgScore == null || scoredCalls === 0) {
    return <p className="text-sm text-ink-muted">No quality scores recorded in this window yet.</p>;
  }
  const tone = avgScore >= 8 ? 'text-[#0b8a74]' : avgScore >= 5 ? 'text-[#9a6a1d]' : 'text-danger';
  const scored = trend.filter((t) => t.avgScore != null);
  const tickEvery = Math.max(1, Math.round(trend.length / 6));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2">
        <span className={`font-display text-[40px] font-bold leading-none tracking-tight ${tone}`}>{avgScore}</span>
        <span className="text-lg text-ink-muted">/ 10</span>
        <span className="ml-auto text-[13px] text-ink-muted">
          across {scoredCalls} scored call{scoredCalls === 1 ? '' : 's'}
        </span>
      </div>
      {scored.length > 0 && (
        <div>
          <div className="flex h-24 items-end gap-[3px]">
            {trend.map((t) => (
              <div key={t.date} className="group relative flex h-full flex-1 items-end justify-center">
                <div
                  className="w-full rounded-t bg-signal/80 transition-colors group-hover:bg-signal-deep"
                  style={{ height: t.avgScore != null ? `${(t.avgScore / 10) * 100}%` : '0', minHeight: t.avgScore != null ? '3px' : '0' }}
                />
                {t.avgScore != null && (
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-[11px] text-white shadow-lift group-hover:block">
                    {fmtDay(t.date)} · {t.avgScore}/10
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-ink-muted/70">
            {trend.map((t, i) => (
              <span key={t.date} className="flex-1 text-center">
                {i % tickEvery === 0 ? fmtDay(t.date) : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-ink-muted">
      <span className={`h-2.5 w-2.5 rounded-sm ${swatch}`} aria-hidden />
      {label}
    </span>
  );
}

/* ── Daily grouped bars (calls + bookings) ─────────────────────────────────── */
function DailyChart({ daily }: { daily: AnalyticsOverview['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => Math.max(d.calls, d.bookings)));
  // Label roughly six evenly spaced ticks so the axis isn't cluttered.
  const tickEvery = Math.max(1, Math.round(daily.length / 6));

  return (
    <div>
      <div className="flex h-44 items-end gap-[3px]">
        {daily.map((d, i) => (
          <div key={d.date} className="group relative flex h-full flex-1 items-end justify-center gap-[2px]">
            <div
              className="w-1/2 rounded-t bg-line transition-colors group-hover:bg-line/80"
              style={{ height: `${Math.max(2, (d.calls / max) * 100)}%` }}
            />
            <div
              className="w-1/2 rounded-t bg-signal transition-colors group-hover:bg-signal-deep"
              style={{ height: `${(d.bookings / max) * 100}%`, minHeight: d.bookings > 0 ? '2px' : '0' }}
            />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-[11px] text-white shadow-lift group-hover:block">
              {fmtDay(d.date)} · {d.calls} calls · {d.bookings} booked
            </div>
            <span className="sr-only">{`${d.date}: ${i}`}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-ink-muted/70">
        {daily.map((d, i) => (
          <span key={d.date} className="flex-1 text-center">
            {i % tickEvery === 0 ? fmtDay(d.date) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Busiest hours ─────────────────────────────────────────────────────────── */
function HourChart({ byHour }: { byHour: AnalyticsOverview['byHour'] }) {
  // Trim to the working span (first..last hour with any booking) so the chart
  // isn't 24 mostly-empty columns; fall back to business-ish 8–20 if empty.
  const active = byHour.filter((h) => h.bookings > 0);
  const lo = active.length ? Math.min(...active.map((h) => h.hour)) : 8;
  const hi = active.length ? Math.max(...active.map((h) => h.hour)) : 20;
  const slice = byHour.slice(lo, hi + 1);
  const max = Math.max(1, ...slice.map((h) => h.bookings));

  return (
    <div className="flex h-40 items-end gap-1.5">
      {slice.map((h) => (
        <div key={h.hour} className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5">
          <div
            className="w-full rounded-t bg-signal/85 transition-colors group-hover:bg-signal-deep"
            style={{ height: `${(h.bookings / max) * 100}%`, minHeight: h.bookings > 0 ? '3px' : '0' }}
            title={`${h.bookings} bookings`}
          />
          <span className="text-[10px] text-ink-muted/70">{fmtHour(h.hour)}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Busiest weekdays ──────────────────────────────────────────────────────── */
function WeekdayChart({ byWeekday }: { byWeekday: AnalyticsOverview['byWeekday'] }) {
  const max = Math.max(1, ...byWeekday.map((w) => w.bookings));
  return (
    <div className="flex h-40 items-end gap-2">
      {byWeekday.map((w) => (
        <div key={w.weekday} className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5">
          <div
            className="w-full rounded-t bg-signal/70 transition-colors group-hover:bg-signal"
            style={{ height: `${(w.bookings / max) * 100}%`, minHeight: w.bookings > 0 ? '3px' : '0' }}
            title={`${w.bookings} bookings`}
          />
          <span className="text-[10px] font-medium text-ink-muted/80">{WEEKDAY_LABELS[w.weekday]}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Status breakdown (segmented bar + legend) ─────────────────────────────── */
function StatusBreakdown({ status }: { status: AnalyticsOverview['bookingsByStatus'] }) {
  const segments = [
    { key: 'confirmed', label: 'Upcoming', value: status.confirmed, color: 'bg-signal' },
    { key: 'completed', label: 'Completed', value: status.completed, color: 'bg-clinic' },
    { key: 'cancelled', label: 'Cancelled', value: status.cancelled, color: 'bg-ink-muted/40' },
    { key: 'noShow', label: 'No-show', value: status.noShow, color: 'bg-danger' },
  ];
  const total = segments.reduce((s, x) => s + x.value, 0);

  if (total === 0) {
    return <p className="text-sm text-ink-muted">No appointments created in this window yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-paper ring-1 ring-inset ring-ink/5">
        {segments.map((s) =>
          s.value > 0 ? (
            <div key={s.key} className={s.color} style={{ width: `${(s.value / total) * 100}%` }} title={`${s.label}: ${s.value}`} />
          ) : null,
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {segments.map((s) => (
          <div key={s.key} className="flex items-center justify-between gap-2 text-sm">
            <span className="inline-flex items-center gap-2 text-ink-muted">
              <span className={`h-2.5 w-2.5 rounded-sm ${s.color}`} aria-hidden />
              {s.label}
            </span>
            <span className="font-semibold tabular-nums text-ink">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Voice vs manual source split ──────────────────────────────────────────── */
function SourceSplit({ source }: { source: AnalyticsOverview['bookingsBySource'] }) {
  const total = source.voice + source.manual;
  if (total === 0) {
    return <p className="text-sm text-ink-muted">No appointments created in this window yet.</p>;
  }
  const voicePct = source.voice / total;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2">
        <span className="font-display text-[32px] font-semibold leading-none tracking-tight text-signal-deep">
          {pct(voicePct)}
        </span>
        <span className="text-sm text-ink-muted">booked by the receptionist, hands-free</span>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-paper ring-1 ring-inset ring-ink/5">
        <div className="bg-signal" style={{ width: `${voicePct * 100}%` }} title={`Receptionist: ${source.voice}`} />
        <div className="bg-ink-muted/40" style={{ width: `${(1 - voicePct) * 100}%` }} title={`Manual: ${source.manual}`} />
      </div>
      <div className="flex justify-between text-sm">
        <span className="inline-flex items-center gap-2 text-ink-muted">
          <span className="h-2.5 w-2.5 rounded-sm bg-signal" aria-hidden />
          Receptionist
        </span>
        <span className="font-semibold tabular-nums text-ink">{source.voice}</span>
      </div>
      <div className="flex justify-between text-sm">
        <span className="inline-flex items-center gap-2 text-ink-muted">
          <span className="h-2.5 w-2.5 rounded-sm bg-ink-muted/40" aria-hidden />
          Added manually
        </span>
        <span className="font-semibold tabular-nums text-ink">{source.manual}</span>
      </div>
    </div>
  );
}

/* ── formatting helpers ────────────────────────────────────────────────────── */
function fmtDay(iso: string): string {
  const [, mm, dd] = iso.split('-');
  return `${mm}/${dd}`;
}

function fmtHour(h: number): string {
  const suffix = h >= 12 ? 'p' : 'a';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}${suffix}`;
}
