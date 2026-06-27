'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ApiError, CallsApi, type ListCallsResult } from '@/lib/api';
import { formatCents, formatDateTime, formatDuration, formatPhone } from '@/lib/format';
import { Card, CallStatusBadge, EmptyState } from '@/components/ui/Card';
import { CallOutcomeChips } from '@/components/calls/CallOutcome';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';

const RANGE_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
] as const;

const OUTCOME_OPTIONS = [
  { value: '', label: 'Any outcome' },
  { value: 'BOOKED', label: 'Booked' },
  { value: 'JOB_LOGGED', label: 'Job logged' },
  { value: 'MESSAGE_TAKEN', label: 'Message taken' },
  { value: 'TRANSFERRED', label: 'Transferred' },
  { value: 'RESCHEDULED', label: 'Rescheduled' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'NO_ACTION', label: 'No action' },
] as const;

const URGENCY_OPTIONS = [
  { value: '', label: 'Any urgency' },
  { value: 'EMERGENCY', label: 'Emergency' },
  { value: 'URGENT', label: 'Urgent' },
  { value: 'ROUTINE', label: 'Routine' },
] as const;

const LEAD_OPTIONS = [
  { value: '', label: 'Any lead' },
  { value: 'HOT', label: 'Hot lead' },
  { value: 'WARM', label: 'Warm lead' },
  { value: 'COLD', label: 'Cold lead' },
] as const;

export default function CallsPage() {
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<string>('30');
  const [outcome, setOutcome] = useState('');
  const [urgency, setUrgency] = useState('');
  const [lead, setLead] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ListCallsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Debounce typing → one query per pause, and reset to page 1 on new terms.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    CallsApi.list(
      {
        page,
        perPage: 15,
        search: debouncedSearch || undefined,
        sinceDays: range === 'all' ? undefined : Number(range),
        outcome: outcome || undefined,
        urgency: urgency || undefined,
        leadQuality: lead || undefined,
      },
      controller.signal,
    )
      .then((data) => {
        setResult(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Could not load calls.');
        setLoading(false);
      });
    return () => controller.abort();
  }, [page, debouncedSearch, range, outcome, urgency, lead]);

  // Changing any outcome filter jumps back to the first page of results.
  function setFilter(setter: (v: string) => void, value: string) {
    setter(value);
    setPage(1);
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Call history</h2>
        <p className="mt-1.5 text-sm text-ink-muted">
          Every call your receptionist handled — with summaries, transcripts, and recordings.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <Input
            aria-label="Search calls"
            placeholder="Search by caller number or summary…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="sm:w-44">
          <Select
            aria-label="Date range"
            value={range}
            onChange={(e) => {
              setRange(e.target.value);
              setPage(1);
            }}
          >
            {RANGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* Outcome filters — powered by the AI-extracted call data. */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="sm:w-48">
          <Select aria-label="Filter by outcome" value={outcome} onChange={(e) => setFilter(setOutcome, e.target.value)}>
            {OUTCOME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </div>
        <div className="sm:w-44">
          <Select aria-label="Filter by urgency" value={urgency} onChange={(e) => setFilter(setUrgency, e.target.value)}>
            {URGENCY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </div>
        <div className="sm:w-44">
          <Select aria-label="Filter by lead quality" value={lead} onChange={(e) => setFilter(setLead, e.target.value)}>
            {LEAD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </div>
        {(outcome || urgency || lead) && (
          <button
            type="button"
            onClick={() => {
              setOutcome('');
              setUrgency('');
              setLead('');
              setPage(1);
            }}
            className="self-start text-sm font-medium text-ink-muted transition-colors hover:text-ink sm:self-center"
          >
            Clear filters
          </button>
        )}
      </div>

      <Card padded={false} className="overflow-hidden">
        {error ? (
          <div className="p-6">
            <EmptyState
              title="Couldn't load calls"
              description={error}
              action={
                <Button variant="secondary" onClick={() => setPage((p) => p)}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : loading && !result ? (
          <div className="flex h-48 items-center justify-center">
            <Spinner className="h-6 w-6 text-signal" />
          </div>
        ) : result && result.calls.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title={debouncedSearch || outcome || urgency || lead ? 'No calls match your filters' : 'No calls in this period'}
              description={
                debouncedSearch || outcome || urgency || lead
                  ? 'Try widening the date range or clearing a filter.'
                  : 'Calls will appear here as soon as your receptionist answers one.'
              }
            />
          </div>
        ) : result ? (
          <>
            <div className="hidden grid-cols-[180px_1fr_auto_auto] gap-x-4 border-b border-line/70 bg-paper/60 px-5 py-2.5 sm:grid">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">Caller</p>
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">Summary</p>
              <p className="w-20 text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                Duration
              </p>
              <p className="w-24 text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                Status
              </p>
            </div>
            <ul className={`divide-y divide-line/60 transition-opacity ${loading ? 'opacity-60' : ''}`}>
              {result.calls.map((call) => (
                <li key={call.id}>
                  <Link
                    href={`/dashboard/calls/${call.id}`}
                    className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-4 transition-colors hover:bg-paper/80 sm:grid-cols-[180px_1fr_auto_auto]"
                  >
                    <div>
                      <p className="text-sm font-semibold text-ink">{formatPhone(call.callerNumber)}</p>
                      <p className="mt-0.5 text-xs text-ink-muted">{formatDateTime(call.startedAt)}</p>
                    </div>
                    <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
                      <p className="line-clamp-2 text-sm leading-relaxed text-ink-muted">
                        {call.summary ?? 'No summary available.'}
                      </p>
                      <CallOutcomeChips call={call} />
                    </div>
                    <div className="hidden w-20 text-right sm:block">
                      <p className="font-mono text-sm text-ink">{formatDuration(call.durationSeconds)}</p>
                      <p className="font-mono text-xs text-ink-muted">{formatCents(call.costCents)}</p>
                    </div>
                    <div className="justify-self-end sm:w-24 sm:text-right">
                      <CallStatusBadge status={call.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-line/70 bg-paper/60 px-5 py-3">
              <p className="text-xs text-ink-muted">
                {result.total} call{result.total === 1 ? '' : 's'} · page {result.page} of {result.totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={result.page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={result.page >= result.totalPages || loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </Card>
    </div>
  );
}
