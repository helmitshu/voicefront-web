'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminApi, ApiError, type PooledNumberRow } from '@/lib/api';
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

  const [number, setNumber] = useState('');
  const [country, setCountry] = useState('CA');
  const [vapiPhoneId, setVapiPhoneId] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(() => {
    AdminApi.numbers()
      .then((res) => {
        setNumbers(res.numbers);
        setAvailable(res.available);
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

  async function remove(row: PooledNumberRow) {
    if (!window.confirm(`Remove ${formatPhone(row.number)} from the pool?`)) return;
    setRemovingId(row.id);
    try {
      await AdminApi.removeNumber(row.id);
      toast('Number removed.', 'success');
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
        <span className="inline-flex items-center gap-2 rounded-xl border border-line/70 bg-white px-4 py-2.5 text-sm shadow-card">
          <span className="font-display text-lg font-semibold text-ink">{available}</span>
          <span className="text-ink-muted">available</span>
        </span>
        <span className="inline-flex items-center gap-2 rounded-xl border border-line/70 bg-white px-4 py-2.5 text-sm shadow-card">
          <span className="font-display text-lg font-semibold text-ink">{total - available}</span>
          <span className="text-ink-muted">assigned</span>
        </span>
        <span className="inline-flex items-center gap-2 rounded-xl border border-line/70 bg-white px-4 py-2.5 text-sm shadow-card">
          <span className="font-display text-lg font-semibold text-ink">{total}</span>
          <span className="text-ink-muted">total</span>
        </span>
      </div>

      {available === 0 && total > 0 && (
        <p className="rounded-xl border border-construction/25 bg-construction-soft/50 px-4 py-3 text-sm text-[#9a6a1d]">
          No numbers are available — the next customer to activate won&apos;t get one until you add more.
        </p>
      )}

      <Card>
        <CardHeader
          title="Add a number"
          description="Buy a number in Vapi, point its Server URL at this app's inbound webhook, then add it here. New customers claim from this pool on activation."
        />
        <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
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
        </div>
        <div className="mt-4">
          <Input
            label="Vapi phone ID (optional)"
            placeholder="For future programmatic reconfiguration"
            value={vapiPhoneId}
            onChange={(e) => setVapiPhoneId(e.target.value)}
            className="font-mono text-sm"
          />
        </div>
        <div className="mt-4">
          <Button loading={adding} onClick={add}>
            Add to pool
          </Button>
        </div>
      </Card>

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
                    aria-label={`Remove ${row.number}`}
                  >
                    Remove
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
