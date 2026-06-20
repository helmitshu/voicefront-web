'use client';

import { useMemo, useState } from 'react';

/**
 * Public "what are missed calls costing you" calculator. Pure client-side math,
 * no backend. Every assumption is on screen and editable — the only "fixed"
 * thing is the per-vertical default average job value, grounded in real
 * Vancouver-area pricing (2025–26, CAD). The visitor can override anything.
 */

interface Vertical {
  key: string;
  label: string;
  /** Representative value of one booking, CAD — Vancouver-area average. */
  avgValue: number;
  /** Default share of missed calls that would have booked (editable). */
  bookRate: number;
  /** What one booking is called, for the copy. */
  unit: string;
}

// Defaults sourced from Vancouver/BC 2025–26 pricing; all editable on screen.
const VERTICALS: Vertical[] = [
  { key: 'clinic', label: 'Dental / medical clinic', avgValue: 300, bookRate: 55, unit: 'appointment' },
  { key: 'salon', label: 'Hair & beauty salon', avgValue: 95, bookRate: 60, unit: 'appointment' },
  { key: 'plumbing', label: 'Plumbing / HVAC service', avgValue: 400, bookRate: 50, unit: 'job' },
  { key: 'hvac', label: 'Heating & cooling install', avgValue: 8000, bookRate: 40, unit: 'job' },
  { key: 'roofing', label: 'Roofing / exteriors', avgValue: 12000, bookRate: 35, unit: 'job' },
  { key: 'auto', label: 'Auto repair', avgValue: 450, bookRate: 55, unit: 'visit' },
  { key: 'other', label: 'Other', avgValue: 400, bookRate: 45, unit: 'job' },
];

const cad = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
  maximumFractionDigits: 0,
});

function Stepper({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <span className="font-display text-sm font-semibold text-signal-deep">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-line accent-signal"
      />
    </div>
  );
}

export function ROICalculator() {
  // Default to a common mid-ticket trade + modest volume so the first number a
  // visitor sees is believable; high-ticket verticals reveal bigger (real)
  // figures when picked.
  const [industryKey, setIndustryKey] = useState<string>('plumbing');
  const industry = VERTICALS.find((v) => v.key === industryKey) ?? VERTICALS[0];

  const [callsPerWeek, setCallsPerWeek] = useState(20);
  const [missedPct, setMissedPct] = useState(25);
  // Seeded from the preset, but the visitor owns them once they tweak.
  const [avgValue, setAvgValue] = useState(industry.avgValue);
  const [bookRate, setBookRate] = useState(industry.bookRate);

  function pickIndustry(key: string) {
    const v = VERTICALS.find((x) => x.key === key);
    if (!v) return;
    setIndustryKey(key);
    setAvgValue(v.avgValue); // reset the money + booking assumptions to the preset
    setBookRate(v.bookRate);
  }

  const { recoveredJobs, monthly, yearly } = useMemo(() => {
    const monthlyMissed = callsPerWeek * 4.33 * (missedPct / 100);
    const jobs = monthlyMissed * (bookRate / 100);
    const m = jobs * avgValue;
    return { recoveredJobs: jobs, monthly: m, yearly: m * 12 };
  }, [callsPerWeek, missedPct, bookRate, avgValue]);

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[1.05fr_0.95fr]">
      {/* Inputs */}
      <div className="rounded-3xl border border-line/70 bg-white p-6 shadow-card sm:p-8">
        <p className="text-[13px] font-medium text-ink">Your business</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {VERTICALS.map((v) => {
            const on = v.key === industryKey;
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => pickIndustry(v.key)}
                className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-all ${
                  on
                    ? 'border-signal bg-signal text-white shadow-pop'
                    : 'border-line bg-white text-ink hover:border-signal/40 hover:bg-signal-soft/20'
                }`}
              >
                {v.label}
              </button>
            );
          })}
        </div>

        <div className="mt-7 flex flex-col gap-6">
          <Stepper
            label="Calls you get a week"
            value={callsPerWeek}
            min={5}
            max={300}
            step={5}
            onChange={setCallsPerWeek}
          />
          <Stepper
            label="Calls you miss today (after-hours, busy, lunch)"
            value={missedPct}
            min={5}
            max={60}
            step={1}
            suffix="%"
            onChange={setMissedPct}
          />
          <Stepper
            label="Of those, share that would've booked"
            value={bookRate}
            min={10}
            max={80}
            step={1}
            suffix="%"
            onChange={setBookRate}
          />
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink">
              Average value of one {industry.unit} (CAD)
            </span>
            <div className="flex items-center rounded-xl border border-line bg-white px-3.5 shadow-input focus-within:border-signal focus-within:ring-4 focus-within:ring-signal/15">
              <span className="text-ink-muted">$</span>
              <input
                type="number"
                min={0}
                value={avgValue}
                onChange={(e) => setAvgValue(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                className="h-11 w-full bg-transparent px-2 text-[15px] text-ink outline-none"
              />
            </div>
          </label>
        </div>
      </div>

      {/* Result */}
      <div className="flex flex-col justify-between overflow-hidden rounded-3xl border border-signal/20 bg-gradient-to-br from-signal-soft/60 via-white to-white p-6 shadow-card sm:p-8">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-deep">
            Revenue you&apos;re leaving on the table
          </p>
          <p className="mt-3 font-display text-[44px] font-bold leading-none tracking-tight text-ink sm:text-[52px]">
            {cad.format(monthly)}
            <span className="text-xl font-semibold text-ink-muted">/mo</span>
          </p>
          <p className="mt-2 text-[15px] text-ink-muted">
            That&apos;s <span className="font-semibold text-ink">{cad.format(yearly)}/yr</span> — roughly{' '}
            <span className="font-semibold text-ink">
              {Math.round(recoveredJobs)} {industry.unit}
              {Math.round(recoveredJobs) === 1 ? '' : 's'}
            </span>{' '}
            a month walking to a competitor who picked up.
          </p>
        </div>

        <div className="mt-6">
          <p className="rounded-xl bg-white/70 px-4 py-3 text-[13px] leading-relaxed text-ink-muted ring-1 ring-inset ring-signal/10">
            VoiceFront answers every one of those calls — 24/7 — and books them straight into your
            calendar. Most plans pay for themselves with a single recovered {industry.unit}.
          </p>
          <a
            href="#book"
            className="mt-4 block rounded-full bg-gradient-to-b from-signal to-signal-deep px-6 py-3.5 text-center text-[15px] font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-0.5 hover:shadow-lift"
          >
            Stop missing these calls →
          </a>
          <p className="mt-3 text-center text-[11px] text-ink-muted/80">
            Estimate based on your inputs · CAD · Vancouver-area averages, fully editable.
          </p>
        </div>
      </div>
    </div>
  );
}
