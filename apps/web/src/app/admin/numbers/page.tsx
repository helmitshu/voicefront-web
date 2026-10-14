'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminApi, ApiError, type PooledNumberRow, type VapiNumberOption } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { formatPhone } from '@/lib/format';

const COUNTRIES = [
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
];

export default function AdminNumbersPage() {
  const { toast } = useToast();
  const [numbers, setNumbers] = useState<PooledNumberRow[] | null>(null);
  const [available, setAvailable] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [unpooled, setUnpooled] = useState<VapiNumberOption[]>([]);
  const [vapiTotal, setVapiTotal] = useState(0);
  const [vapiError, setVapiError] = useState<string | null>(null);

  const [number, setNumber] = useState('');
  const [country, setCountry] = useState('US');
  const [vapiPhoneId, setVapiPhoneId] = useState('');
  const [adding, setAdding] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const [areaCode, setAreaCode] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    AdminApi.numbers()
      .then((res) => {
        setNumbers(res.numbers);
        setAvailable(res.available);
        setUnpooled(res.unpooled);
        setVapiTotal(res.vapiTotal);
        setVapiError(res.vapiError);
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the number pool.'),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function add() {
    if (number.trim().length === 0) {
      toast('Enter a number in E.164 format, e.g. +15551234567.', 'error');
      return;
    }
    setAdding(true);
    try {
      await AdminApi.addNumber({
        number: number.trim(),
        country,
        vapiPhoneId: vapiPhoneId.trim() || undefined,
      });
      toast('Number added to the pool.', 'success');
      setNumber('');
      setVapiPhoneId('');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add that number.', 'error');
    } finally {
      setAdding(false);
    }
  }

  async function addUnpooled(row: VapiNumberOption) {
    setAddingId(row.id);
    try {
      await AdminApi.addNumber({ number: row.number, vapiPhoneId: row.id });
      toast('Number added to the pool.', 'success');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add that number.', 'error');
    } finally {
      setAddingId(null);
    }
  }

  async function create() {
    const code = areaCode.trim();
    if (code.length > 0 && !/^\d{3}$/.test(code)) {
      toast('Area code must be exactly 3 digits, e.g. 415.', 'error');
      return;
    }
    setCreating(true);
    try {
      await AdminApi.createNumber(code || undefined);
      toast('Number created in Vapi and added to the pool.', 'success');
      setAreaCode('');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not create that number.', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function remove(row: PooledNumberRow) {
    if (
      !window.confirm(
        `Remove ${formatPhone(row.number)} from the pool? The number itself stays live on your Vapi account.`,
      )
    )
      return;
    setRemovingId(row.id);
    try {
      await AdminApi.removeNumber(row.id);
      toast('Number removed from the pool.', 'success');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove that number.', 'error');
    } finally {
      setRemovingId(null);
    }
  }

  if (error) {
    return (
      <EmptyState
        title="Couldn't load the number pool"
        description={error}
        action={
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Try again
          </Button>
        }
      />
    );
  }

  if (!numbers) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  const total = numbers.length;

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Phone numbers</h2>
        <p className="mt-1.5 text-sm text-ink-muted">
          Shared pool of pre-provisioned numbers. Customers automatically claim one when they go live.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <span className="inline-flex items-center gap-2 rounded-xl border border-line/70 bg-card px-4 py-2.5 text-sm shadow-card">
          <span className="font-display text-lg font-semibold text-ink">{available}</span>
          <span className="text-ink-muted">available</span>
        </span>
        <span className="inline-flex items-center gap-2 rounded-xl border border-line/70 bg-card px-4 py-2.5 text-sm shadow-card">
          <span className="font-display text-lg font-semibold text-ink">{total - available}</span>
          <span className="text-ink-muted">assigned</span>
        </span>
        <span className="inline-flex items-center gap-2 rounded-xl border border-line/70 bg-card px-4 py-2.5 text-sm shadow-card">
          <span className="font-display text-lg font-semibold text-ink">{total}</span>
          <span className="text-ink-muted">in pool</span>
        </span>
        {!vapiError && (
          <span className="inline-flex items-center gap-2 rounded-xl border border-line/70 bg-card px-4 py-2.5 text-sm shadow-card">
            <span className="font-display text-lg font-semibold text-ink">{vapiTotal}</span>
            <span className="text-ink-muted">on your Vapi account</span>
          </span>
        )}
      </div>

      {vapiError && (
        <p className="rounded-xl border border-danger/25 bg-danger-soft/50 px-4 py-3 text-sm text-ink">
          Couldn&apos;t read your live Vapi inventory ({vapiError}) The pool below still works, but numbers
          that exist only in Vapi can&apos;t be shown until this clears.
        </p>
      )}

      {unpooled.length > 0 && (
        <Card>
          <CardHeader
            title="On your Vapi account, not in the pool"
            description="These numbers exist in Vapi but customers can't claim them yet. Adding one points its webhook at VoiceFront first, so it can never look assigned and silently never ring."
          />
          <ul className="flex flex-col gap-2">
            {unpooled.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-construction/25 bg-construction-soft/30 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-mono text-sm font-medium text-ink">{formatPhone(row.number)}</p>
                  <p className="text-xs text-ink-muted">Vapi ID {row.id}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Badge tone="warning" dot>
                    Not in pool
                  </Badge>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={addingId === row.id}
                    onClick={() => addUnpooled(row)}
                  >
                    Add to pool
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {available === 0 && total > 0 && (
        <p className="rounded-xl border border-construction/25 bg-construction-soft/50 px-4 py-3 text-sm text-construction">
          No numbers are available — the next customer to activate won&apos;t get one until you add more.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Create new number in Vapi"
            description="Instantly provisions a free Vapi number, auto-configures its webhook, and adds it to the pool."
          />
          <div>
            <Input
              label="Area code (optional)"
              placeholder="e.g. 415 — leave blank for any"
              value={areaCode}
              onChange={(e) => setAreaCode(e.target.value)}
              inputMode="numeric"
              maxLength={3}
            />
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            Free Vapi numbers are <span className="font-medium text-ink">US only</span>. For Canadian or other
            numbers, buy one elsewhere (e.g. Twilio) and use “Add existing.”
          </p>
          <div className="mt-4">
            <Button loading={creating} onClick={create} className="w-full">
              Create number
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Add existing number"
            description="For a number that already exists on your Vapi account. We verify it is really there and point its webhook at VoiceFront before pooling it."
          />
          <div className="grid gap-4">
            <Input
              label="Phone number (E.164)"
              placeholder="+15551234567"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              className="font-mono"
            />
            <Select label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
              {COUNTRIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
            <Input
              label="Vapi phone ID (optional)"
              placeholder="ph_..."
              value={vapiPhoneId}
              onChange={(e) => setVapiPhoneId(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="mt-4">
            <Button loading={adding} onClick={add} className="w-full">
              Add to pool
            </Button>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Pool" />
        {numbers.length === 0 ? (
          <EmptyState
            title="No numbers yet"
            description="Add your first provisioned number above so customers can go live automatically."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {numbers.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-line/70 bg-paper/50 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-mono text-sm font-medium text-ink">{formatPhone(row.number)}</p>
                  <p className="text-xs text-ink-muted">
                    {row.country}
                    {row.assignedCompany ? ` · ${row.assignedCompany}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {row.assignedTenantId ? (
                    <Badge tone="signal" dot>
                      Assigned
                    </Badge>
                  ) : (
                    <Badge tone="success" dot>
                      Available
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(row.assignedTenantId)}
                    loading={removingId === row.id}
                    onClick={() => remove(row)}
                    aria-label={`Remove ${row.number} from the pool`}
                  >
                    Remove from pool
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
