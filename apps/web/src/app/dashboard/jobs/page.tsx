'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { JobsApi, ApiError, type JobDto, type JobStatus, type JobUrgency } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Badge, Card, CardHeader, EmptyState, type BadgeTone } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { formatPhone, formatDateTime } from '@/lib/format';

const URGENCY_META: Record<JobUrgency, { label: string; tone: BadgeTone; rank: number }> = {
  EMERGENCY: { label: 'Emergency', tone: 'danger', rank: 0 },
  URGENT: { label: 'Urgent', tone: 'warning', rank: 1 },
  ROUTINE: { label: 'Routine', tone: 'neutral', rank: 2 },
};

const STATUS_META: Record<JobStatus, { label: string; tone: BadgeTone }> = {
  NEW: { label: 'New', tone: 'signal' },
  CONTACTED: { label: 'Contacted', tone: 'warning' },
  SCHEDULED: { label: 'Scheduled', tone: 'success' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};

/** The single forward step shown as the primary action on a job. */
const NEXT_STATUS: Partial<Record<JobStatus, { to: JobStatus; label: string }>> = {
  NEW: { to: 'CONTACTED', label: 'Mark contacted' },
  CONTACTED: { to: 'SCHEDULED', label: 'Mark scheduled' },
  SCHEDULED: { to: 'CLOSED', label: 'Close out' },
};

const FILTERS: { value: JobStatus | 'ALL'; label: string }[] = [
  { value: 'NEW', label: 'New' },
  { value: 'CONTACTED', label: 'In progress' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'ALL', label: 'All' },
];

export default function JobsPage() {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<JobDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<JobStatus | 'ALL'>('NEW');
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(() => {
    const status = filter === 'ALL' ? undefined : filter;
    JobsApi.list(status)
      .then(({ jobs }) => setJobs(jobs))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load jobs.'));
  }, [filter]);

  useEffect(() => {
    setJobs(null);
    setError(null);
    load();
  }, [load]);

  // Surface emergencies first, then most recent — the at-a-glance triage order.
  const sorted = useMemo(() => {
    if (!jobs) return null;
    return [...jobs].sort((a, b) => {
      const u = URGENCY_META[a.urgency].rank - URGENCY_META[b.urgency].rank;
      return u !== 0 ? u : b.createdAt.localeCompare(a.createdAt);
    });
  }, [jobs]);

  async function setStatus(id: string, status: JobStatus) {
    try {
      await JobsApi.update(id, { status });
      toast(status === 'CLOSED' ? 'Closed out.' : 'Updated.', 'success');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update.', 'error');
    }
  }

  const openEmergencies = (jobs ?? []).filter((j) => j.urgency === 'EMERGENCY' && j.status !== 'CLOSED').length;

  return (
    <div className="flex animate-fade-up flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Jobs</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            Service requests your receptionist captured — emergencies, quotes, and callbacks. Emergencies rise to the
            top{openEmergencies > 0 ? `, and you’ve got ${openEmergencies} open right now` : ''}.
          </p>
        </div>
        <Button onClick={() => setShowForm((s) => !s)} variant={showForm ? 'secondary' : 'primary'}>
          {showForm ? 'Close' : 'Add a job'}
        </Button>
      </div>

      {showForm && (
        <AddForm
          onAdded={() => {
            setShowForm(false);
            setFilter('NEW');
            load();
          }}
        />
      )}

      {/* Filter tabs */}
      <div className="inline-flex rounded-xl border border-line/70 bg-white p-1 shadow-input">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
              filter === f.value ? 'bg-signal-soft/70 text-signal-deep' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? (
        <EmptyState title="Couldn't load jobs" description={error} />
      ) : !sorted ? (
        <div className="flex h-48 items-center justify-center">
          <Spinner className="h-6 w-6 text-signal" />
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          title="No jobs here yet"
          description="When your receptionist takes a service request — a burst pipe, a quote, a callback — it lands here as a job you can work through."
        />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line/60">
            {sorted.map((job) => {
              const next = NEXT_STATUS[job.status];
              const emergency = job.urgency === 'EMERGENCY' && job.status !== 'CLOSED';
              return (
                <li
                  key={job.id}
                  className={`flex flex-wrap items-start justify-between gap-4 px-6 py-4 ${
                    emergency ? 'bg-danger-soft/30' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <p className="truncate text-sm font-semibold text-ink">{job.customerName}</p>
                      <Badge tone={URGENCY_META[job.urgency].tone} dot>
                        {URGENCY_META[job.urgency].label}
                      </Badge>
                      <Badge tone={STATUS_META[job.status].tone}>{STATUS_META[job.status].label}</Badge>
                      {job.jobType && <span className="text-[13px] font-medium text-ink-muted">{job.jobType}</span>}
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">
                      {formatPhone(job.customerPhone)} · {formatDateTime(job.createdAt)}
                      {job.preferredCallback ? ` · wants: ${job.preferredCallback}` : ''}
                    </p>
                    {job.serviceAddress && (
                      <p className="mt-1 text-[13px] text-ink-muted">
                        <span className="font-medium text-ink">Address:</span> {job.serviceAddress}
                      </p>
                    )}
                    {job.description && (
                      <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-muted">{job.description}</p>
                    )}
                    {job.notes && (
                      <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink">
                        <span className="font-medium">Note:</span> {job.notes}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {next && (
                      <Button size="sm" variant="secondary" onClick={() => setStatus(job.id, next.to)}>
                        {next.label}
                      </Button>
                    )}
                    {job.status !== 'CLOSED' && (
                      <button
                        type="button"
                        onClick={() => setStatus(job.id, 'CLOSED')}
                        className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-muted transition-colors hover:bg-danger-soft/60 hover:text-danger"
                      >
                        Close
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

function AddForm({ onAdded }: { onAdded: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [jobType, setJobType] = useState('');
  const [urgency, setUrgency] = useState<JobUrgency>('ROUTINE');
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [callback, setCallback] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    const customerName = name.trim();
    if (customerName.length < 2) {
      toast('Add a customer name.', 'error');
      return;
    }
    setSaving(true);
    try {
      await JobsApi.create({
        customerName,
        customerPhone: phone.trim() || undefined,
        jobType: jobType.trim() || undefined,
        urgency,
        serviceAddress: address.trim() || undefined,
        description: description.trim() || undefined,
        preferredCallback: callback.trim() || undefined,
      });
      toast('Job added.', 'success');
      onAdded();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add the job. Check the phone format.', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Add a job" description="Log a service request by hand — the same queue your receptionist fills." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Customer name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Reyes" />
        <Input label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 (555) 123-4567" />
        <Input label="Job type" value={jobType} onChange={(e) => setJobType(e.target.value)} placeholder="Burst pipe, panel upgrade…" />
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-ink">Urgency</label>
          <select
            value={urgency}
            onChange={(e) => setUrgency(e.target.value as JobUrgency)}
            className="w-full rounded-xl border border-line/80 bg-white px-3 py-2.5 text-sm text-ink shadow-input focus:border-signal focus:outline-none focus:ring-2 focus:ring-signal/30"
          >
            <option value="EMERGENCY">Emergency</option>
            <option value="URGENT">Urgent</option>
            <option value="ROUTINE">Routine</option>
          </select>
        </div>
      </div>
      <div className="mt-4">
        <Input label="Service address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="142 Maple St, Springfield" />
      </div>
      <div className="mt-4">
        <Textarea
          label="What's the job?"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Water coming from under the kitchen sink, spreading fast…"
          maxLength={2000}
        />
      </div>
      <div className="mt-4">
        <Input label="Preferred callback (optional)" value={callback} onChange={(e) => setCallback(e.target.value)} placeholder="This afternoon · after 5pm · ASAP" />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button loading={saving} onClick={submit}>
          Add job
        </Button>
      </div>
    </Card>
  );
}
