'use client';

import { useMemo, useState } from 'react';

/**
 * Public "what are missed calls costing you" calculator. Pure client-side math,
 * no backend. Plain-language questions; the missed-calls answer can be given as
 * a percentage OR a plain count. Per-vertical average values are grounded in
 * real Vancouver-area pricing (2025–26, CAD) and fully editable.
 */

interface Vertical {
  key: string;
  label: string;
  /** Representative value of one booking, CAD — Vancouver-area average. */
  avgValue: number;
  /** Default "out of 10 missed callers, how many would book" (editable). */
  bookPerTen: number;
  /** What one booking is called, for the copy. */
  unit: string;
}

// Defaults sourced from Vancouver/BC 2025–26 pricing; all editable on screen.
const VERTICALS: Vertical[] = [
  { key: 'clinic', label: 'Dental / medical clinic', avgValue: 300, bookPerTen: 6, unit: 'appointment' },
  { key: 'salon', label: 'Hair & beauty salon', avgValue: 95, bookPerTen: 6, unit: 'appointment' },
  { key: 'plumbing', label: 'Plumbing / HVAC service', avgValue: 400, bookPerTen: 5, unit: 'job' },
  { key: 'hvac', label: 'Heating & cooling install', avgValue: 8000, bookPerTen: 4, unit: 'job' },
  { key: 'roofing', label: 'Roofing / exteriors', avgValue: 12000, bookPerTen: 3, unit: 'job' },
  { key: 'auto', label: 'Auto repair', avgValue: 450, bookPerTen: 5, unit: 'visit' },
  { key: 'other', label: 'Other', avgValue: 400, bookPerTen: 4, unit: 'job' },
];

const cad = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
  maximumFractionDigits: 0,
});

function Slider({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-2 w-full cursor-pointer appearance-none rounded-full bg-line accent-signal"
    />
  );
}

export function ROICalculator() {
  // Default to a common mid-ticket trade + modest volume so the first number a
  // visitor sees is believable; high-ticket verticals reveal bigger (real)
  // figures when picked.
  const [industryKey, setIndustryKey] = useState<string>('plumbing');
  const industry = VERTICALS.find((v) => v.key === industryKey) ?? VERTICALS[0];

  const [callsPerWeek, setCallsPerWeek] = useState(20);
  const [missedMode, setMissedMode] = useState<'pct' | 'num'>('num');
  const [missedPct, setMissedPct] = useState(25);
  const [missedNum, setMissedNum] = useState(5);
  const [bookPerTen, setBookPerTen] = useState(industry.bookPerTen);
  const [avgValue, setAvgValue] = useState(industry.avgValue);

  function pickIndustry(key: string) {
    const v = VERTICALS.find((x) => x.key === key);
    if (!v) return;
    setIndustryKey(key);
    setAvgValue(v.avgValue); // reset the money + booking assumptions to the preset
    setBookPerTen(v.bookPerTen);
  }

  const { missedPerWeek, recoveredJobs, monthly, yearly } = useMemo(() => {
    const missed =
      missedMode === 'pct'
        ? (callsPerWeek * missedPct) / 100
        : Math.min(missedNum, callsPerWeek);
    const jobs = missed * 4.33 * (bookPerTen / 10);
    const m = jobs * avgValue;
    return { missedPerWeek: missed, recoveredJobs: jobs, monthly: m, yearly: m * 12 };
  }, [callsPerWeek, missedMode, missedPct, missedNum, bookPerTen, avgValue]);

  // Show the "other" framing of the missed answer so it's never ambiguous.
  const missedEquivalent =
    missedMode === 'pct'
      ? `about ${Math.round((callsPerWeek * missedPct) / 100)} calls a week`
      : `about ${callsPerWeek > 0 ? Math.round((Math.min(missedNum, callsPerWeek) / callsPerWeek) * 100) : 0}% of your calls`;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[1.05fr_0.95fr]">
      {/* Inputs */}
      <div className="rounded-3xl border border-line/70 bg-white p-6 shadow-card sm:p-8">
        {/* Q1 — industry */}
        <p className="text-[15px] font-semibold text-ink">1. What kind of business do you run?</p>
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

        {/* Q2 — calls per week */}
        <div className="mt-7">
          <div className="flex items-baseline justify-between">
            <p className="text-[15px] font-semibold text-ink">2. How many calls do you get a week?</p>
            <span className="font-display text-base font-bold text-signal-deep">{callsPerWeek}</span>
          </div>
          <div className="mt-2.5">
            <Slider value={callsPerWeek} min={5} max={300} step={5} onChange={setCallsPerWeek} />
          </div>
        </div>

        {/* Q3 — missed, as % or number */}
        <div className="mt-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[15px] font-semibold text-ink">3. How many of those do you miss?</p>
            <div className="inline-flex rounded-lg border border-line bg-paper p-0.5 text-[12px] font-medium">
              <button
                type="button"
                onClick={() => setMissedMode('num')}
                className={`rounded-md px-2.5 py-1 transition-colors ${missedMode === 'num' ? 'bg-white text-ink shadow-input' : 'text-ink-muted'}`}
              >
                A number
              </button>
              <button
                type="button"
                onClick={() => setMissedMode('pct')}
                className={`rounded-md px-2.5 py-1 transition-colors ${missedMode === 'pct' ? 'bg-white text-ink shadow-input' : 'text-ink-muted'}`}
              >
                A percentage
              </button>
            </div>
          </div>
          <p className="mt-1 text-[12.5px] text-ink-muted">
            Calls that ring out after hours, during a job, at lunch, or when the line&apos;s busy.
          </p>

          {missedMode === 'num' ? (
            <div className="mt-3 flex items-center gap-3">
              <input
                type="number"
                min={0}
                max={callsPerWeek}
                value={missedNum}
                onChange={(e) => setMissedNum(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                className="h-11 w-24 rounded-xl border border-line bg-white px-3 text-[15px] text-ink shadow-input outline-none focus:border-signal focus:ring-4 focus:ring-signal/15"
              />
              <span className="text-[14px] text-ink-muted">calls a week</span>
            </div>
          ) : (
            <div className="mt-3">
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-[13px] text-ink-muted">Drag to set</span>
                <span className="font-display text-base font-bold text-signal-deep">{missedPct}%</span>
              </div>
              <Slider value={missedPct} min={0} max={80} step={1} onChange={setMissedPct} />
            </div>
          )}
          <p className="mt-2 text-[12.5px] font-medium text-signal-deep">= {missedEquivalent}</p>
        </div>

        {/* Q4 — booking likelihood, as a plain "X out of 10" */}
        <div className="mt-7">
          <div className="flex items-baseline justify-between">
            <p className="text-[15px] font-semibold text-ink">
              4. Out of 10 missed callers, how many would book?
            </p>
            <span className="font-display text-base font-bold text-signal-deep">{bookPerTen}</span>
          </div>
          <div className="mt-2.5">
            <Slider value={bookPerTen} min={1} max={10} step={1} onChange={setBookPerTen} />
          </div>
        </div>

        {/* Q5 — value */}
        <div className="mt-7">
          <p className="text-[15px] font-semibold text-ink">
            5. What&apos;s one new {industry.unit} worth to you?
          </p>
          <div className="mt-2.5 flex items-center rounded-xl border border-line bg-white px-3.5 shadow-input focus-within:border-signal focus-within:ring-4 focus-within:ring-signal/15">
            <span className="text-ink-muted">$</span>
            <input
              type="number"
              min={0}
              value={avgValue}
              onChange={(e) => setAvgValue(Math.max(0, Math.round(Number(e.target.value) || 0)))}
              className="h-11 w-full bg-transparent px-2 text-[15px] text-ink outline-none"
            />
            <span className="whitespace-nowrap text-[13px] text-ink-muted">CAD</span>
          </div>
          <p className="mt-1.5 text-[12.5px] text-ink-muted">
            Pre-filled with a typical Vancouver {industry.label.toLowerCase()} — change it to your number.
          </p>
        </div>
      </div>

      {/* Result */}
      <div className="flex flex-col justify-between overflow-hidden rounded-3xl border border-signal/20 bg-gradient-to-br from-signal-soft/60 via-white to-white p-6 shadow-card sm:p-8">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-deep">
            Revenue you&apos;re losing to missed calls
          </p>
          <p className="mt-3 font-display text-[44px] font-bold leading-none tracking-tight text-ink sm:text-[52px]">
            {cad.format(monthly)}
            <span className="text-xl font-semibold text-ink-muted">/mo</span>
          </p>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">
            That&apos;s <span className="font-semibold text-ink">{cad.format(yearly)} a year</span> — about{' '}
            <span className="font-semibold text-ink">
              {Math.round(recoveredJobs)} {industry.unit}
              {Math.round(recoveredJobs) === 1 ? '' : 's'} a month
            </span>{' '}
            going to whoever picked up instead of you.
          </p>
          <p className="mt-2 text-[13px] text-ink-muted/90">
            Based on missing {Math.round(missedPerWeek)} call{Math.round(missedPerWeek) === 1 ? '' : 's'} a
            week.
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
            Estimate based on your answers · CAD · Vancouver-area averages, fully editable.
          </p>
        </div>
      </div>
    </div>
  );
}
