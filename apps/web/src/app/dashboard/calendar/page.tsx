'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/Toast';
import {
  ApiError,
  AppointmentsApi,
  ProvidersApi,
  type AppointmentDto,
  type AvailabilityResult,
  type ExternalCalendarEvent,
  type ProviderDto,
  type ServiceDto,
} from '@/lib/api';
import { formatPhone } from '@/lib/format';
import { Card, Badge, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';

const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const STATUS_META: Record<
  AppointmentDto['status'],
  { label: string; tone: 'signal' | 'success' | 'neutral' | 'danger'; chip: string }
> = {
  CONFIRMED: { label: 'Confirmed', tone: 'signal', chip: 'bg-signal-soft/70 text-signal-deep ring-signal/15' },
  COMPLETED: { label: 'Completed', tone: 'success', chip: 'bg-clinic-soft/70 text-[#0b8a74] ring-clinic/20' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', chip: 'bg-paper text-ink-muted/70 ring-ink/5 line-through' },
  NO_SHOW: { label: 'No-show', tone: 'danger', chip: 'bg-danger-soft/70 text-danger ring-danger/20' },
};

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

/** Per-provider group label with an initials avatar (premium touch). */
function GroupHeader({ label, count }: { label: string; count: number }) {
  const unassigned = label === 'Unassigned';
  const initials = unassigned
    ? '–'
    : label
        .replace(/^(Dr|Mr|Mrs|Ms|Miss|Prof|Hygienist)\.?\s+/i, '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? '')
        .join('');
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span
        aria-hidden
        className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${
          unassigned
            ? 'bg-paper text-ink-muted ring-1 ring-inset ring-ink/10'
            : 'bg-gradient-to-br from-signal to-signal-deep text-white shadow-pop'
        }`}
      >
        {initials}
      </span>
      <p className="text-[13px] font-semibold text-ink">{label}</p>
      <span className="text-xs text-ink-muted">· {count}</span>
    </div>
  );
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
  { value: '45', label: '45 minutes' },
  { value: '60', label: '1 hour' },
];

export default function CalendarPage() {
  const { me } = useAuth();
  const { toast } = useToast();
  const readOnly = me?.user.role === 'AGENT';

  const now = new Date();
  const todayKey = toKey(now.getFullYear(), now.getMonth(), now.getDate());
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [selected, setSelected] = useState(todayKey);
  const [appointments, setAppointments] = useState<AppointmentDto[] | null>(null);
  const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // New-appointment form
  const [formOpen, setFormOpen] = useState(false);
  const [availability, setAvailability] = useState<AvailabilityResult | null>(null);
  const [form, setForm] = useState({
    customerName: '',
    customerPhone: '',
    reason: '',
    time: '',
    duration: '30',
    providerId: '',
    serviceId: '',
  });
  const [saving, setSaving] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [providersInfo, setProvidersInfo] = useState<{
    enabled: boolean;
    providers: ProviderDto[];
    services: ServiceDto[];
  } | null>(null);

  useEffect(() => {
    ProvidersApi.list()
      .then((d) =>
        setProvidersInfo({ enabled: d.config.enabled, providers: d.providers, services: d.services }),
      )
      .catch(() => setProvidersInfo({ enabled: false, providers: [], services: [] }));
  }, []);

  const activeProviders = useMemo(
    () => (providersInfo?.providers ?? []).filter((p) => p.active),
    [providersInfo],
  );
  const activeServices = useMemo(
    () => (providersInfo?.services ?? []).filter((s) => s.active),
    [providersInfo],
  );
  const multiProvider = !!providersInfo && providersInfo.enabled && activeProviders.length > 1;
  const selectedService = useMemo(
    () => (form.serviceId ? activeServices.find((s) => s.id === form.serviceId) ?? null : null),
    [form.serviceId, activeServices],
  );
  const providerLabel = useCallback(
    (id: string | null) => {
      if (!id) return 'Unassigned';
      const p = (providersInfo?.providers ?? []).find((x) => x.id === id);
      return p ? (p.title ? `${p.title} ${p.name}` : p.name) : 'Unassigned';
    },
    [providersInfo],
  );

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
    AppointmentsApi.list({ from, to }, controller.signal)
      .then(({ appointments }) => setAppointments(appointments))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Could not load the calendar.');
      });
    // External (Google/Outlook) events overlay — best-effort, never blocks the
    // page or surfaces an error if no calendar is connected.
    AppointmentsApi.external({ from, to }, controller.signal)
      .then(({ events }) => setExternalEvents(events))
      .catch(() => setExternalEvents([]));
    return () => controller.abort();
  }, [grid, reloadKey]);

  const byDate = useMemo(() => {
    const map = new Map<string, AppointmentDto[]>();
    for (const appointment of appointments ?? []) {
      const list = map.get(appointment.local.date) ?? [];
      list.push(appointment);
      map.set(appointment.local.date, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.local.time.localeCompare(b.local.time));
    return map;
  }, [appointments]);

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

  const dayAppointments = byDate.get(selected) ?? [];
  const dayExternal = byDateExternal.get(selected) ?? [];
  const selectedLabel = new Date(`${selected}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const loadAvailability = useCallback((date: string) => {
    setAvailability(null);
    AppointmentsApi.availability(date)
      .then(({ availability }) => {
        setAvailability(availability);
        setForm((f) => ({ ...f, time: availability.freeSlots[0] ?? '' }));
      })
      .catch(() => setAvailability({ open: false, freeSlots: [], dayLabel: date }));
  }, []);

  function openForm() {
    setFormOpen(true);
    loadAvailability(selected);
  }

  useEffect(() => {
    if (formOpen) loadAvailability(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function createAppointment() {
    if (form.customerName.trim().length < 2) {
      toast('Add the customer name first.', 'error');
      return;
    }
    if (!form.time) {
      toast('Pick a time slot.', 'error');
      return;
    }
    setSaving(true);
    try {
      await AppointmentsApi.create({
        customerName: form.customerName.trim(),
        customerPhone: form.customerPhone.trim() || undefined,
        reason: form.reason.trim() || undefined,
        date: selected,
        time: form.time,
        durationMinutes: selectedService ? selectedService.durationMinutes : Number(form.duration),
        providerId: multiProvider && form.providerId ? form.providerId : undefined,
        serviceId: multiProvider && form.serviceId ? form.serviceId : undefined,
      });
      toast('Appointment booked.', 'success');
      setForm({ customerName: '', customerPhone: '', reason: '', time: '', duration: '30', providerId: '', serviceId: '' });
      setFormOpen(false);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not book that slot.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function cancelAppointment(id: string) {
    setCancellingId(id);
    try {
      await AppointmentsApi.update(id, { status: 'CANCELLED' });
      toast('Appointment cancelled.', 'success');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not cancel.', 'error');
    } finally {
      setCancellingId(null);
    }
  }

  const renderAppointment = (appointment: AppointmentDto) => (
    <li key={appointment.id} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-sm font-medium text-ink">{to12h(appointment.local.time)}</p>
        <Badge tone={STATUS_META[appointment.status].tone} dot>
          {STATUS_META[appointment.status].label}
        </Badge>
      </div>
      <p className="text-sm font-semibold text-ink">{appointment.customerName}</p>
      {appointment.customerPhone && (
        <p className="font-mono text-xs text-ink-muted">{formatPhone(appointment.customerPhone)}</p>
      )}
      {appointment.reason && <p className="text-xs leading-relaxed text-ink-muted">{appointment.reason}</p>}
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted/70">
          {appointment.source === 'VOICE_AGENT' ? 'Booked by receptionist' : 'Booked manually'}
        </span>
        {!readOnly && appointment.status === 'CONFIRMED' && (
          <Button
            variant="ghost"
            size="sm"
            loading={cancellingId === appointment.id}
            onClick={() => cancelAppointment(appointment.id)}
          >
            Cancel
          </Button>
        )}
      </div>
    </li>
  );

  const unassignedToday = dayAppointments.filter((a) => !a.providerId);

  if (error) {
    return (
      <EmptyState
        title="Couldn't load the calendar"
        description={error}
        action={
          <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </Button>
        }
      />
    );
  }

  if (!appointments) {
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
          <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Calendar</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            Every appointment your receptionist books lands here instantly.
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
              const entries = byDate.get(cell.key) ?? [];
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
                      isToday
                        ? 'bg-signal text-white shadow-pop'
                        : cell.inMonth
                          ? 'text-ink'
                          : 'text-ink-muted/50'
                    }`}
                  >
                    {cell.day}
                  </span>
                  {entries.slice(0, 3).map((appointment) => (
                    <span
                      key={appointment.id}
                      className={`truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${STATUS_META[appointment.status].chip}`}
                    >
                      {to12h(appointment.local.time)} {appointment.customerName}
                    </span>
                  ))}
                  {entries.length > 3 && (
                    <span className="px-1.5 text-[11px] font-medium text-ink-muted">+{entries.length - 3} more</span>
                  )}
                  {/* External (Google/Outlook) events — dashed/striped so they read
                      as "from your own calendar", not bookable appointments. */}
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
                  {dayAppointments.length === 0
                    ? 'No appointments'
                    : `${dayAppointments.length} appointment${dayAppointments.length === 1 ? '' : 's'}`}
                </p>
              </div>
              {!readOnly && !formOpen && (
                <Button size="sm" onClick={openForm}>
                  New
                </Button>
              )}
            </div>

            {formOpen && (
              <div className="mb-5 flex flex-col gap-3 rounded-xl border border-line/70 bg-paper/60 p-4">
                <Input
                  label="Customer name"
                  value={form.customerName}
                  onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
                />
                <Input
                  label="Phone (optional)"
                  placeholder="+15551234567"
                  value={form.customerPhone}
                  onChange={(e) => setForm((f) => ({ ...f, customerPhone: e.target.value }))}
                />
                <Input
                  label="Reason (optional)"
                  value={form.reason}
                  onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                />
                {multiProvider && activeProviders.length > 0 && (
                  <div className="grid grid-cols-2 gap-3">
                    <Select
                      label="Provider (optional)"
                      value={form.providerId}
                      onChange={(e) => setForm((f) => ({ ...f, providerId: e.target.value }))}
                    >
                      <option value="">Any available</option>
                      {activeProviders.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title ? `${p.title} ${p.name}` : p.name}
                        </option>
                      ))}
                    </Select>
                    {activeServices.length > 0 && (
                      <Select
                        label="Service (optional)"
                        value={form.serviceId}
                        onChange={(e) => setForm((f) => ({ ...f, serviceId: e.target.value }))}
                      >
                        <option value="">No specific service</option>
                        {activeServices.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                )}
                {availability === null ? (
                  <div className="flex items-center gap-2 py-1 text-xs text-ink-muted">
                    <Spinner className="h-3.5 w-3.5" /> Checking open slots…
                  </div>
                ) : availability.freeSlots.length === 0 ? (
                  <p className="rounded-lg bg-construction-soft/50 px-3 py-2 text-xs text-[#9a6a1d]">
                    {availability.open ? 'This day is fully booked.' : 'The business is closed this day.'}
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <Select
                      label="Time"
                      value={form.time}
                      onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
                    >
                      {availability.freeSlots.map((slot) => (
                        <option key={slot} value={slot}>
                          {to12h(slot)}
                        </option>
                      ))}
                    </Select>
                    {selectedService ? (
                      <div className="flex flex-col gap-1">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">Duration</p>
                        <p className="flex h-9 items-center rounded-lg border border-line/70 bg-paper/60 px-3 text-sm text-ink-muted">
                          {selectedService.durationMinutes} min
                        </p>
                      </div>
                    ) : (
                      <Select
                        label="Duration"
                        value={form.duration}
                        onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value }))}
                      >
                        {DURATION_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <Button variant="ghost" size="sm" disabled={saving} onClick={() => setFormOpen(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" loading={saving} onClick={createAppointment} disabled={!form.time}>
                    Book it
                  </Button>
                </div>
              </div>
            )}

            {dayAppointments.length === 0 && !formOpen ? (
              <p className="rounded-xl border border-dashed border-line bg-paper/60 px-4 py-6 text-center text-sm text-ink-muted">
                Nothing booked this day.
              </p>
            ) : multiProvider ? (
              <div className="flex flex-col gap-5">
                {activeProviders.map((p) => {
                  const appts = dayAppointments.filter((a) => a.providerId === p.id);
                  return (
                    <section key={p.id}>
                      <GroupHeader label={providerLabel(p.id)} count={appts.length} />
                      {appts.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-line/70 bg-paper/40 px-3 py-2 text-xs text-ink-muted/80">
                          Open — no appointments
                        </p>
                      ) : (
                        <ul className="flex flex-col divide-y divide-line/60">{appts.map(renderAppointment)}</ul>
                      )}
                    </section>
                  );
                })}
                {unassignedToday.length > 0 && (
                  <section>
                    <GroupHeader label="Unassigned" count={unassignedToday.length} />
                    <ul className="flex flex-col divide-y divide-line/60">
                      {unassignedToday.map(renderAppointment)}
                    </ul>
                  </section>
                )}
              </div>
            ) : (
              <ul className="flex flex-col divide-y divide-line/60">{dayAppointments.map(renderAppointment)}</ul>
            )}

            {/* Read-only overlay of the owner's own connected calendar. */}
            {dayExternal.length > 0 && (
              <div className="mt-5 border-t border-line/60 pt-4">
                <div className="mb-2.5 flex items-center gap-1.5">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-violet-600" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v3M16 3v3" strokeLinecap="round" />
                  </svg>
                  <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-violet-600">From your calendar</p>
                </div>
                <ul className="flex flex-col gap-2">
                  {dayExternal.map((event, i) => (
                    <li
                      key={`ext-${i}`}
                      className="flex items-start gap-2.5 rounded-lg border border-dashed border-violet-200 bg-violet-50/50 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-xs font-medium text-violet-700">
                          {event.allDay ? 'All day' : to12h(event.local.time)}
                        </p>
                        <p className="truncate text-sm font-semibold text-ink">{event.title}</p>
                        <p className="mt-0.5 text-[11px] text-ink-muted">
                          {event.provider === 'GOOGLE' ? 'Google Calendar' : 'Outlook'}
                          {event.accountEmail ? ` · ${event.accountEmail}` : ''}
                        </p>
                      </div>
                      <span className="mt-0.5 shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600">
                        Busy
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
