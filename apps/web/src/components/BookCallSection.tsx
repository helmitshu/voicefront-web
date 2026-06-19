'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { BookingApi, ApiError, type BookingDay } from '@/lib/api';

function to12(time: string): string {
  const [hStr, m] = time.split(':');
  const h = Number(hStr);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${m} ${suffix}`;
}

function tzLabel(tz: string): string {
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}

interface FormState {
  name: string;
  businessType: string;
  phone: string;
  email: string;
  notes: string;
  customSystem: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  businessType: '',
  phone: '',
  email: '',
  notes: '',
  customSystem: false,
};

export function BookCallSection() {
  const [timezone, setTimezone] = useState<string>('');
  const [days, setDays] = useState<BookingDay[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const [activeTime, setActiveTime] = useState<string | null>(null);
  // mobile step: 'pick' = calendar, 'details' = form
  const [mobileStep, setMobileStep] = useState<'pick' | 'details'>('pick');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [booked, setBooked] = useState<{ date: string; time: string; dayLabel: string } | null>(null);

  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    BookingApi.slots(14)
      .then((res) => {
        if (!alive) return;
        setTimezone(res.timezone);
        setDays(res.days);
        const firstOpen = res.days.find((d) => d.open && d.slots.length > 0);
        if (firstOpen) setActiveDate(firstOpen.date);
      })
      .catch((err) => {
        if (!alive) return;
        setLoadError(err instanceof ApiError ? err.message : 'Could not load availability.');
      });
    return () => { alive = false; };
  }, []);

  const activeDay = useMemo(
    () => days?.find((d) => d.date === activeDate) ?? null,
    [days, activeDate],
  );
  const bookableDays = useMemo(
    () => days?.filter((d) => d.open && d.slots.length > 0) ?? [],
    [days],
  );

  function pickDate(date: string) {
    setActiveDate(date);
    setActiveTime(null);
    setSubmitError(null);
  }

  function pickTime(t: string) {
    setActiveTime(t);
    setSubmitError(null);
  }

  function goToDetails() {
    setMobileStep('details');
    // scroll to top of the card on mobile after step transition
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  function goBack() {
    setMobileStep('pick');
  }

  async function confirm() {
    if (!activeDate || !activeTime || submitting) return;
    const name = form.name.trim();
    const businessType = form.businessType.trim();
    const phone = form.phone.trim();
    if (!name || !businessType || !phone) {
      setSubmitError('Please fill in your name, business type, and phone.');
      return;
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      await BookingApi.book({
        name, businessType, phone,
        email: form.email.trim() || undefined,
        notes: form.notes.trim() || undefined,
        customSystem: form.customSystem,
        date: activeDate,
        time: activeTime,
      });
      setBooked({ date: activeDate, time: activeTime, dayLabel: activeDay?.dayLabel ?? activeDate });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'SLOT_TAKEN') {
        setSubmitError('That slot was just taken — please pick another time.');
        setActiveTime(null);
        setMobileStep('pick');
        try {
          const res = await BookingApi.slots(14);
          setDays(res.days);
        } catch { /* keep old list */ }
      } else {
        setSubmitError(err instanceof ApiError ? err.message : 'Could not book. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  /* ── Success ── */
  if (booked) {
    return (
      <div className="mx-auto max-w-xl rounded-3xl border border-line/70 bg-white p-8 text-center shadow-card sm:p-10">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-signal text-white shadow-pop">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-7 w-7">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h3 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">You&apos;re booked in</h3>
        <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-ink-muted">
          Your intro call is set for{' '}
          <span className="font-semibold text-ink">
            {booked.dayLabel} at {to12(booked.time)}
          </span>
          {timezone ? ` (${tzLabel(timezone)} time)` : ''}. We&apos;ll be in touch at the number you gave us.
        </p>
        <p className="mt-6 text-sm text-ink-muted">
          Talk soon — bring any questions about how VoiceFront would fit your front desk.
        </p>
      </div>
    );
  }

  /* ── Calendar panel ── */
  const CalendarPanel = (
    <div className="flex flex-col p-6 sm:p-8">
      {/* Header */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-deep">Pick a time</p>
        <p className="mt-1 text-[13px] text-ink-muted">
          {timezone ? `Times shown in ${tzLabel(timezone)} time.` : 'Loading availability…'}
        </p>
      </div>

      {loadError ? (
        <p className="mt-5 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          {loadError}
        </p>
      ) : !days ? (
        <div className="mt-5 space-y-3">
          <div className="flex gap-2 overflow-hidden">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-16 w-14 shrink-0 animate-pulse rounded-xl bg-paper" />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-paper" />
            ))}
          </div>
        </div>
      ) : bookableDays.length === 0 ? (
        <p className="mt-5 text-sm text-ink-muted">
          No open times in the next two weeks — check back soon or try the live demo above.
        </p>
      ) : (
        <>
          {/* Day chips */}
          <div className="mt-5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {bookableDays.map((d) => {
              const [, mm, dd] = d.date.split('-');
              const weekday = new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-US', {
                weekday: 'short',
                timeZone: 'UTC',
              });
              const selected = d.date === activeDate;
              return (
                <button
                  key={d.date}
                  type="button"
                  onClick={() => pickDate(d.date)}
                  aria-pressed={selected}
                  className={`flex shrink-0 flex-col items-center rounded-xl border px-4 py-2.5 transition-all ${
                    selected
                      ? 'border-signal bg-signal text-white shadow-pop'
                      : 'border-line bg-white text-ink hover:border-signal/40 hover:bg-signal-soft/20'
                  }`}
                >
                  <span className={`text-[11px] font-semibold uppercase tracking-wide ${selected ? 'text-white/80' : 'text-ink-muted'}`}>
                    {weekday}
                  </span>
                  <span className="mt-0.5 text-[16px] font-bold leading-none tracking-tight">{`${mm}/${dd}`}</span>
                </button>
              );
            })}
          </div>

          {/* Time slots */}
          {activeDay && (
            <div className="mt-4">
              <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                {activeDay.dayLabel}
              </p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-3">
                {activeDay.slots.map((t) => {
                  const selected = t === activeTime;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => pickTime(t)}
                      aria-pressed={selected}
                      className={`rounded-xl border py-2.5 text-[13px] font-semibold transition-all ${
                        selected
                          ? 'border-signal bg-signal-soft text-signal-deep ring-1 ring-inset ring-signal/40'
                          : 'border-line bg-white text-ink hover:border-signal/40 hover:bg-signal-soft/20'
                      }`}
                    >
                      {to12(t)}
                    </button>
                  );
                })}
              </div>

              {/* Mobile CTA — only visible when a time is picked */}
              {activeTime && (
                <button
                  type="button"
                  onClick={goToDetails}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-b from-signal to-signal-deep px-6 py-3.5 text-[15px] font-semibold text-white shadow-pop transition-all hover:-translate-y-0.5 hover:shadow-lift md:hidden"
                >
                  Continue — {to12(activeTime)}
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <path d="M3 8h10M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

  /* ── Form panel ── */
  const FormPanel = (
    <div ref={formRef} className="flex flex-col p-6 sm:p-8">
      {!activeTime ? (
        /* Desktop placeholder — hidden on mobile (mobile never shows this panel without a time) */
        <div className="hidden h-full flex-col items-center justify-center py-10 text-center md:flex">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-paper ring-1 ring-inset ring-ink/8">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7 text-ink-muted/60">
              <rect x="3" y="5" width="18" height="16" rx="3" />
              <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" />
            </svg>
          </div>
          <p className="mt-4 max-w-[200px] text-sm leading-relaxed text-ink-muted">
            Select a day and time to fill in your details.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Back button — mobile only */}
          <button
            type="button"
            onClick={goBack}
            className="flex w-fit items-center gap-1.5 text-[13px] font-medium text-ink-muted hover:text-ink md:hidden"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
              <path d="M10 3L6 8l4 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back
          </button>

          {/* Selected slot pill */}
          <div className="flex items-center gap-2 rounded-xl bg-signal-soft/50 px-3.5 py-2.5 text-[13px] font-semibold text-signal-deep ring-1 ring-inset ring-signal/15">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 shrink-0">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {activeDay?.dayLabel} · {to12(activeTime)}
            <button
              type="button"
              onClick={() => { setActiveTime(null); setMobileStep('pick'); }}
              className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] font-normal text-signal-deep/70 hover:bg-signal/10 md:block"
            >
              Change
            </button>
          </div>

          {/* Fields */}
          <div className="flex flex-col gap-3">
            <Field
              label="Your name"
              value={form.name}
              onChange={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="Jordan Reyes"
              autoComplete="name"
            />
            <Field
              label="Type of business"
              value={form.businessType}
              onChange={(v) => setForm((f) => ({ ...f, businessType: v }))}
              placeholder="Dental clinic, roofing, salon…"
            />
            <Field
              label="Phone"
              type="tel"
              value={form.phone}
              onChange={(v) => setForm((f) => ({ ...f, phone: v }))}
              placeholder="+1 (555) 123-4567"
              autoComplete="tel"
            />
            <Field
              label="Email"
              type="email"
              optional
              value={form.email}
              onChange={(v) => setForm((f) => ({ ...f, email: v }))}
              placeholder="you@company.com"
              autoComplete="email"
            />
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink">
                Anything worth mentioning? <span className="font-normal text-ink-muted">(optional)</span>
              </span>
              <textarea
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                maxLength={800}
                placeholder="Call volume, current setup, what you're hoping to fix…"
                className="resize-y rounded-xl border border-line bg-white px-3.5 py-2.5 text-[14px] leading-relaxed text-ink shadow-input outline-none transition-all placeholder:text-ink-muted/60 focus:border-signal focus:ring-4 focus:ring-signal/15"
              />
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-paper/50 px-3.5 py-3">
              <input
                type="checkbox"
                checked={form.customSystem}
                onChange={(e) => setForm((f) => ({ ...f, customSystem: e.target.checked }))}
                className="mt-0.5 h-4 w-4 shrink-0 accent-signal"
              />
              <span className="text-[13px] leading-snug text-ink">
                I think I&apos;ll need a <span className="font-semibold">customized system</span> for my workflow.
              </span>
            </label>
          </div>

          {submitError && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{submitError}</p>
          )}

          <button
            type="button"
            onClick={confirm}
            disabled={submitting}
            className="w-full rounded-full bg-gradient-to-b from-signal to-signal-deep px-6 py-3.5 text-[15px] font-semibold text-white shadow-pop transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lift disabled:opacity-60"
          >
            {submitting ? 'Booking…' : 'Confirm booking'}
          </button>
          <p className="text-center text-[11px] text-ink-muted">
            Free intro call · no account needed · we&apos;ll call you.
          </p>
        </div>
      )}
    </div>
  );

  /* ── Layout ── */
  return (
    <div className="mx-auto max-w-4xl overflow-hidden rounded-3xl border border-line/70 bg-white shadow-card">
      {/* Desktop: side-by-side always */}
      <div className="hidden md:grid md:grid-cols-[1.1fr_0.9fr] md:divide-x md:divide-line/60">
        {CalendarPanel}
        {FormPanel}
      </div>

      {/* Mobile: step-based */}
      <div className="md:hidden">
        {mobileStep === 'pick' ? CalendarPanel : FormPanel}
      </div>

      {/* Mobile step indicator */}
      <div className="flex items-center justify-center gap-2 border-t border-line/50 py-3 md:hidden">
        <span className={`h-1.5 w-6 rounded-full transition-all ${mobileStep === 'pick' ? 'bg-signal' : 'bg-line'}`} />
        <span className={`h-1.5 w-6 rounded-full transition-all ${mobileStep === 'details' ? 'bg-signal' : 'bg-line'}`} />
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, type = 'text', autoComplete, optional = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  optional?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink">
        {label}
        {optional && <span className="font-normal text-ink-muted"> (optional)</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="h-11 rounded-xl border border-line bg-white px-3.5 text-[14px] text-ink shadow-input outline-none transition-all placeholder:text-ink-muted/60 focus:border-signal focus:ring-4 focus:ring-signal/15"
      />
    </label>
  );
}
