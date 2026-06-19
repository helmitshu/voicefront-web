'use client';

import { useCallback, useEffect, useState } from 'react';
import { WaitlistApi, ApiError, type WaitlistEntry, type WaitlistStatus } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { formatPhone, formatDate } from '@/lib/format';

const STATUS_META: Record<WaitlistStatus, { label: string; tone: 'neutral' | 'signal' | 'success' | 'warning' }> = {
  WAITING: { label: 'Waiting', tone: 'warning' },
  NOTIFIED: { label: 'Texted', tone: 'signal' },
  CONVERTED: { label: 'Booked', tone: 'success' },
  CANCELLED: { label: 'Removed', tone: 'neutral' },
};

const FILTERS: { value: WaitlistStatus | 'ALL'; label: string }[] = [
  { value: 'WAITING', label: 'Waiting' },
  { value: 'NOTIFIED', label: 'Texted' },
  { value: 'ALL', label: 'All' },
];

export default function WaitlistPage() {
  const { toast } = useToast();
  const [entries, setEntries] = useState<WaitlistEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<WaitlistStatus | 'ALL'>('WAITING');
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(() => {
    const status = filter === 'ALL' ? undefined : filter;
    WaitlistApi.list(status)
      .then(({ waitlist }) => setEntries(waitlist))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load the waitlist.'));
  }, [filter]);

  useEffect(() => {
    setEntries(null);
    setError(null);
    load();
  }, [load]);

  async function changeStatus(id: string, status: WaitlistStatus) {
    try {
      await WaitlistApi.setStatus(id, status);
      toast(status === 'CONVERTED' ? 'Marked as booked.' : 'Updated.', 'success');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update.', 'error');
    }
  }

  async function remove(id: string) {
    try {
      await WaitlistApi.remove(id);
      toast('Removed from waitlist.', 'success');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove.', 'error');
    }
  }

  return (
    <div className="flex animate-fade-up flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Waitlist</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            People waiting for a spot. When a cancellation frees one up, the next person waiting is texted automatically.
          </p>
        </div>
        <Button onClick={() => setShowForm((s) => !s)} variant={showForm ? 'secondary' : 'primary'}>
          {showForm ? 'Close' : 'Add to waitlist'}
        </Button>
      </div>

      {showForm && <AddForm onAdded={() => { setShowForm(false); setFilter('WAITING'); load(); }} />}

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
        <EmptyState title="Couldn't load the waitlist" description={error} />
      ) : !entries ? (
        <div className="flex h-48 items-center justify-center">
          <Spinner className="h-6 w-6 text-signal" />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          title="Nobody waiting"
          description="Add a customer who wanted a slot that was full. When a cancellation opens one up, we'll text the first person here."
        />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line/60">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-4 px-6 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <p className="truncate text-sm font-semibold text-ink">{e.customerName}</p>
                    <Badge tone={STATUS_META[e.status].tone} dot>
                      {STATUS_META[e.status].label}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {formatPhone(e.customerPhone)} · added {formatDate(e.createdAt)}
                    {e.status === 'NOTIFIED' && e.notifiedAt ? ` · texted ${formatDate(e.notifiedAt)}` : ''}
                  </p>
                  {e.note && <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-muted">{e.note}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {e.status !== 'CONVERTED' && (
                    <Button size="sm" variant="secondary" onClick={() => changeStatus(e.id, 'CONVERTED')}>
                      Mark booked
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(e.id)}
                    className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-muted transition-colors hover:bg-danger-soft/60 hover:text-danger"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
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
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    const customerName = name.trim();
    const customerPhone = phone.trim();
    if (customerName.length < 2 || customerPhone.length < 6) {
      toast('Add a name and a phone number.', 'error');
      return;
    }
    setSaving(true);
    try {
      await WaitlistApi.create({ customerName, customerPhone, note: note.trim() || undefined });
      toast('Added to the waitlist.', 'success');
      onAdded();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add. Check the phone number format.', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Add to waitlist" description="They'll be texted the moment a matching slot opens up." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Customer name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Reyes" />
        <Input label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 (555) 123-4567" hint="Used to text them when a spot opens." />
      </div>
      <div className="mt-4">
        <Textarea label="Note (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Any morning next week · prefers Dr. Lee · after 5pm…" maxLength={500} />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button loading={saving} onClick={submit}>Add to waitlist</Button>
      </div>
    </Card>
  );
}
