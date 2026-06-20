'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AdminApi,
  ApiError,
  type AvailabilityResult,
  type CalendarProviderId,
  type CalendarStatus,
  type ExternalCalendarEvent,
  type FounderEntry,
} from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Card, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';

const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function to12h(time: string): string {
  const [hStr, m] = time.split(':');
  const h = Number(hStr);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${m} ${suffix}`;
}

interface GridDay {
  key: string;
  day: number;
  inMonth: boolean;
}

/** 6x7 Sunday-first grid covering the given month. */
function buildGrid(year: number, month: number): GridDay[] {
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());
  const cells: GridDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    cells.push({
      key: toKey(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month,
    });
  }
  return cells;
}

const DURATION_OPTIONS = [
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '90', label: '1.5 hours' },
  { value: '120', label: '2 hours' },
];

export default function AdminCalendarPage() {
  const { toast } = useToast();

  const now = new Date();
  const todayKey = toKey(now.getFullYear(), now.getMonth(), now.getDate());
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [selected, setSelected] = useState(todayKey);
  const [entries, setEntries] = useState<FounderEntry[] | null>(null);
  const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[]>([]);
  const [dayGrid, setDayGrid] = useState<{ time: string; available: boolean }[] | null>(null);
  const [calStatus, setCalStatus] = useState<CalendarStatus | null>(null);
  const [busyProvider, setBusyProvider] = useState<CalendarProviderId | null>(null);
  const [timezone, setTimezone] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Block-time form
  const [formOpen, setFormOpen] = useState(false);
  const [availability, setAvailability] = useState<AvailabilityResult | null>(null);
  const [form, setForm] = useState({ label: '', time: '', duration: '30' });
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const grid = useMemo(() => buildGrid(cursor.year, cursor.month), [cursor]);
  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  useEffect(() => {
    const controller = new AbortController();
    const from = grid[0].key;
    const to = grid[grid.length - 1].key;
    setError(null);
    AdminApi.founderCalendar({ from, to }, controller.signal)
      .then(({ entries, timezone }) => {
        setEntries(entries);
        setTimezone(timezone);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Could not load your calendar.');
      });
    // External (Google/Outlook) events for the founder calendar — best-effort.
    AdminApi.founderExternalEvents({ from, to }, controller.signal)
      .then(({ events }) => setExternalEvents(events))
      .catch(() => setExternalEvents([]));
    return () => controller.abort();
  }, [grid, reloadKey]);

  useEffect(() => {
    AdminApi.founderCalendarStatus()
      .then(setCalStatus)
      .catch(() => setCalStatus(null));
  }, [reloadKey]);

  // Day schedule grid for the selected day (full slot grid w/ free/busy).
  useEffect(() => {
    let alive = true;
    setDayGrid(null);
    AdminApi.founderAvailability(selected)
      .then(({ availability }) => {
        if (alive) setDayGrid(availability.slots ?? []);
      })
      .catch(() => {
        if (alive) setDayGrid([]);
      });
    return () => {
      alive = false;
    };
  }, [selected, reloadKey]);

  // Surface the OAuth round-trip result (?calendar=connected|error) then clean it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('calendar');
    if (!result) return;
    if (result === 'connected') toast('Calendar connected.', 'success');
    else if (result === 'error') toast("Couldn't connect that calendar. Please try again.", 'error');
    params.delete('calendar');
    params.delete('provider');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    setReloadKey((k) => k + 1);
  }, [toast]);

  const byDate = useMemo(() => {
    const map = new Map<string, FounderEntry[]>();
    for (const entry of entries ?? []) {
      const list = map.get(entry.local.date) ?? [];
      list.push(entry);
      map.set(entry.local.date, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.local.time.localeCompare(b.local.time));
    return map;
  }, [entries]);

  const byDateExternal = useMemo(() => {
    const map = new Map<string, ExternalCalendarEvent[]>();
    for (const event of externalEvents) {
      const list = map.get(event.local.date) ?? [];
      list.push(event);
      map.set(event.local.date, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.local.time.localeCompare(b.local.time));
    return map;
  }, [externalEvents]);

  const dayEntries = byDate.get(selected) ?? [];
  const dayExternal = byDateExternal.get(selected) ?? [];
  const selectedLabel = new Date(`${selected}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  // One ordered list of rows for the selected day: every time that holds an
  // entry (call/block), an external event, or sits on the open/busy grid.
  const daySchedule = useMemo(() => {
    const entryByTime = new Map<string, FounderEntry>();
    for (const e of dayEntries) if (!entryByTime.has(e.local.time)) entryByTime.set(e.local.time, e);
    const extByTime = new Map<string, ExternalCalendarEvent[]>();
    for (const e of dayExternal) {
      const list = extByTime.get(e.local.time) ?? [];
      list.push(e);
      extByTime.set(e.local.time, list);
    }
    const freeByTime = new Map<string, boolean>();
    for (const s of dayGrid ?? []) freeByTime.set(s.time, s.available);

    const times = new Set<string>([
      ...(dayGrid ?? []).map((s) => s.time),
      ...dayEntries.map((e) => e.local.time),
      ...dayExternal.map((e) => e.local.time),
    ]);
    return [...times]
      .sort((a, b) => a.localeCompare(b))
      .map((time) => ({
        time,
        entry: entryByTime.get(time) ?? null,
        external: extByTime.get(time) ?? [],
        free: freeByTime.get(time) ?? false,
      }));
  }, [dayGrid, dayEntries, dayExternal]);

  async function connectCalendar(provider: CalendarProviderId) {
    setBusyProvider(provider);
    try {
      const { url } = await AdminApi.founderCalendarConnectUrl(provider);
      window.location.href = url;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not start the connection.', 'error');
      setBusyProvider(null);
    }
  }

  async function disconnectCalendar(provider: CalendarProviderId) {
    setBusyProvider(provider);
    try {
      await AdminApi.founderCalendarDisconnect(provider);
      toast('Calendar disconnected.', 'success');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not disconnect.', 'error');
    } finally {
      setBusyProvider(null);
    }
  }

  const loadAvailability = useCallback((date: string) => {
    setAvailability(null);
    AdminApi.founderAvailability(date)
      .then(({ availability }) => {
        setAvailability(availability);
        setForm((f) => ({ ...f, time: availability.freeSlots[0] ?? '' }));
      })
      .catch(() => setAvailability({ open: false, freeSlots: [], slots: [], dayLabel: date }));
  }, []);

  function openForm() {
    setFormOpen(true);
    loadAvailability(selected);
  }

  useEffect(() => {
    if (formOpen) loadAvailability(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function blockTime() {
    if (!form.time) {
      toast('Pick a time to block.', 'error');
      return;
    }
    setSaving(true);
    try {
      await AdminApi.blockFounderTime({
        date: selected,
        time: form.time,
        durationMinutes: Number(form.duration),
        label: form.label.trim() || undefined,
      });
      toast('Time blocked — Ava won’t book you then.', 'success');
      setForm({ label: '', time: '', duration: '30' });
      setFormOpen(false);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not block that time.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function removeEntry(id: string) {
    setRemovingId(id);
    try {
      await AdminApi.removeFounderEntry(id);
      toast('Removed.', 'success');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove that.', 'error');
    } finally {
      setRemovingId(null);
    }
  }

  if (error) {
    return (
      <EmptyState
        title="Couldn't load your calendar"
        description={error}
        action={
          <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </Button>
        }
      />
    );
  }

  if (!entries) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">My calendar</h2>
          <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
            Block the times you’re busy. When a prospect asks your sales agent for a planning call, she only
            offers slots you’ve left open — she can never double-book you.
            {timezone && <span className="ml-1 text-ink-muted/80">Times shown in {timezone.replace(/_/g, ' ')}.</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            aria-label="Previous month"
            onClick={() => setCursor(({ year, month }) => (month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 }))}
          >
            ←
          </Button>
          <span className="min-w-[160px] text-center font-display text-sm font-semibold text-ink">{monthLabel}</span>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Next month"
            onClick={() => setCursor(({ year, month }) => (month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 }))}
          >
            →
          </Button>
        </div>
      </div>

      {/* Calendar sync — connect your own Google/Outlook so its busy time blocks
          planning calls and shows here. */}
      {calStatus &&
        (() => {
          const conns = calStatus.connections;
          const available = calStatus.availableProviders;
          if (available.length === 0) return null; // operator hasn't configured OAuth
          const errored = conns.find((c) => c.lastError);
          if (conns.length === 0) {
            return (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-paper/60 px-4 py-3">
                <p className="text-sm text-ink-muted">
                  Connect your own calendar so your busy times block planning calls and appear here.
                </p>
                <div className="flex gap-2">
                  {available.includes('GOOGLE') && (
                    <Button size="sm" variant="secondary" loading={busyProvider === 'GOOGLE'} onClick={() => connectCalendar('GOOGLE')}>
                      Connect Google
                    </Button>
                  )}
                  {available.includes('MICROSOFT') && (
                    <Button size="sm" variant="secondary" loading={busyProvider === 'MICROSOFT'} onClick={() => connectCalendar('MICROSOFT')}>
                      Connect Outlook
                    </Button>
                  )}
                </div>
              </div>
            );
          }
          return (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-200 bg-violet-50/60 px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-violet-800">
                <span className="inline-block h-2 w-2 rounded-full bg-violet-500" />
                <span className="font-medium">
                  Synced with{' '}
                  {conns
                    .map((c) => c.accountEmail || (c.provider === 'GOOGLE' ? 'Google Calendar' : 'Outlook'))
                    .join(', ')}
                  .
                </span>
                {errored ? (
                  <span className="text-amber-700">
                    Reconnect needed — {errored.lastError}
                  </span>
                ) : (
                  <span className="text-violet-700/80">
                    {externalEvents.length === 0
                      ? 'No events this month.'
                      : `${externalEvents.length} event${externalEvents.length === 1 ? '' : 's'} this month show in violet.`}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {conns.map((c) => (
                  <Button
                    key={c.provider}
                    size="sm"
                    variant="ghost"
                    loading={busyProvider === c.provider}
                    onClick={() => disconnectCalendar(c.provider)}
                  >
                    Disconnect {c.provider === 'GOOGLE' ? 'Google' : 'Outlook'}
                  </Button>
                ))}
              </div>
            </div>
          );
        })()}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Month grid */}
        <Card padded={false} className="overflow-hidden">
          <div className="grid grid-cols-7 border-b border-line/70 bg-paper/60">
            {WEEKDAY_HEADERS.map((label) => (
              <p key={label} className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                {label}
              </p>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {grid.map((cell) => {
              const dayList = byDate.get(cell.key) ?? [];
              const cellExternal = byDateExternal.get(cell.key) ?? [];
              const isToday = cell.key === todayKey;
              const isSelected = cell.key === selected;
              return (
                <button
                  key={cell.key}
                  type="button"
                  onClick={() => setSelected(cell.key)}
                  className={`flex min-h-[92px] flex-col items-stretch gap-1 border-b border-r border-line/40 p-1.5 text-left align-top transition-colors last:border-r-0 ${
                    isSelected ? 'bg-signal-soft/40' : 'hover:bg-paper/80'
                  } ${cell.inMonth ? 'bg-white' : 'bg-paper/50'}`}
                >
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                      isToday ? 'bg-signal text-white shadow-pop' : cell.inMonth ? 'text-ink' : 'text-ink-muted/50'
                    }`}
                  >
                    {cell.day}
                  </span>
                  {dayList.slice(0, 3).map((entry) => (
                    <span
                      key={entry.id}
                      className={`truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                        entry.kind === 'call'
                          ? 'bg-signal-soft/70 text-signal-deep ring-signal/15'
                          : 'bg-construction-soft/70 text-[#9a6a1d] ring-construction/20'
                      }`}
                    >
                      {to12h(entry.local.time)} {entry.label}
                    </span>
                  ))}
                  {dayList.length > 3 && (
                    <span className="px-1.5 text-[11px] font-medium text-ink-muted">+{dayList.length - 3} more</span>
                  )}
                  {/* Your own Google/Outlook events — dashed violet. */}
                  {cellExternal.slice(0, 2).map((event, i) => (
                    <span
                      key={`ext-${i}`}
                      title={`${event.title} · from ${event.provider === 'GOOGLE' ? 'Google' : 'Outlook'} Calendar`}
                      className="flex items-center gap-1 truncate rounded-md border border-dashed border-violet-300 bg-violet-50/70 px-1.5 py-0.5 text-[11px] font-medium text-violet-700"
                    >
                      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.4">
                        <rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v3M16 3v3" strokeLinecap="round" />
                      </svg>
                      <span className="truncate">{event.allDay ? '' : `${to12h(event.local.time)} `}{event.title}</span>
                    </span>
                  ))}
                  {cellExternal.length > 2 && (
                    <span className="px-1.5 text-[11px] font-medium text-violet-500/80">+{cellExternal.length - 2} more</span>
                  )}
                </button>
              );
            })}
          </div>
        </Card>

        {/* Day panel */}
        <div className="flex flex-col gap-4">
          <Card>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-[17px] font-semibold tracking-tight text-ink">{selectedLabel}</h3>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {dayEntries.length === 0
                    ? 'Fully open'
                    : `${dayEntries.length} ${dayEntries.length === 1 ? 'entry' : 'entries'}`}
                </p>
              </div>
              {!formOpen && (
                <Button size="sm" onClick={openForm}>
                  Block time
                </Button>
              )}
            </div>

            {formOpen && (
              <div className="mb-5 flex flex-col gap-3 rounded-xl border border-line/70 bg-paper/60 p-4">
                <Input
                  label="Label (optional)"
                  placeholder="e.g. Lunch, Customer call"
                  value={form.label}
                  onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                />
                {availability === null ? (
                  <div className="flex items-center gap-2 py-1 text-xs text-ink-muted">
                    <Spinner className="h-3.5 w-3.5" /> Loading open times…
                  </div>
                ) : availability.freeSlots.length === 0 ? (
                  <p className="rounded-lg bg-construction-soft/50 px-3 py-2 text-xs text-[#9a6a1d]">
                    Every slot this day is already blocked or booked.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <Select label="Start" value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}>
                      {availability.freeSlots.map((slot) => (
                        <option key={slot} value={slot}>
                          {to12h(slot)}
                        </option>
                      ))}
                    </Select>
                    <Select label="Length" value={form.duration} onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value }))}>
                      {DURATION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <Button variant="ghost" size="sm" disabled={saving} onClick={() => setFormOpen(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" loading={saving} onClick={blockTime} disabled={!form.time}>
                    Block it
                  </Button>
                </div>
              </div>
            )}

            {/* Day schedule — table of times: each slot shows a planning call /
                block, an event from your connected calendar, or Open. */}
            {!formOpen && (
              <>
                {dayExternal.filter((e) => e.allDay).map((event, i) => (
                  <div
                    key={`allday-${i}`}
                    className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-dashed border-violet-200 bg-violet-50/50 px-3 py-2"
                  >
                    <p className="truncate text-sm font-semibold text-violet-800">{event.title}</p>
                    <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600">
                      All day
                    </span>
                  </div>
                ))}

                {dayGrid === null ? (
                  <div className="flex items-center gap-2 py-6 text-xs text-ink-muted">
                    <Spinner className="h-3.5 w-3.5" /> Loading schedule…
                  </div>
                ) : daySchedule.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line bg-paper/60 px-4 py-6 text-center text-sm text-ink-muted">
                    This day is wide open. Ava can book a planning call anytime.
                  </p>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-line/70">
                    <table className="w-full border-collapse text-sm">
                      <tbody>
                        {daySchedule.map((row) => {
                          const ext = row.external.filter((e) => !e.allDay);
                          const rowBg = row.entry
                            ? row.entry.kind === 'call'
                              ? 'bg-signal-soft/20'
                              : 'bg-construction-soft/20'
                            : ext.length > 0
                              ? 'bg-violet-50/40'
                              : !row.free
                                ? 'bg-paper/50'
                                : '';
                          return (
                            <tr key={row.time} className={`border-b border-line/40 last:border-0 ${rowBg}`}>
                              <td className="w-[78px] whitespace-nowrap border-r border-line/40 px-2.5 py-2 align-top font-mono text-[11px] font-medium text-ink-muted">
                                {to12h(row.time)}
                              </td>
                              <td className="px-3 py-2">
                                {row.entry ? (
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                      <p className="truncate text-sm font-semibold text-ink">{row.entry.label}</p>
                                      <p className="text-[11px] text-ink-muted">
                                        {row.entry.kind === 'call' ? 'Planning call' : 'Blocked'} · {row.entry.durationMinutes}m
                                      </p>
                                    </div>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      loading={removingId === row.entry.id}
                                      onClick={() => removeEntry(row.entry!.id)}
                                    >
                                      {row.entry.kind === 'call' ? 'Cancel' : 'Remove'}
                                    </Button>
                                  </div>
                                ) : ext.length > 0 ? (
                                  <div className="flex flex-col gap-1">
                                    {ext.map((e, i) => (
                                      <div key={i} className="flex items-center justify-between gap-2">
                                        <div className="min-w-0">
                                          <p className="truncate text-sm font-semibold text-violet-800">{e.title}</p>
                                          <p className="truncate text-[11px] text-ink-muted">
                                            {e.provider === 'GOOGLE' ? 'Google Calendar' : 'Outlook'}
                                          </p>
                                        </div>
                                        <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600">
                                          Busy
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                ) : row.free ? (
                                  <span className="text-xs text-ink-muted/60">Open</span>
                                ) : (
                                  <span className="text-xs text-ink-muted/60">Busy</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
