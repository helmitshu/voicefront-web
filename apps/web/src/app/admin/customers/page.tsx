'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AdminApi, ApiError, type AdminTenantRow, type Industry } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/Toast';
import { formatCents, formatDate, formatPhone } from '@/lib/format';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';

const SUBSCRIPTION_TONES: Record<string, 'success' | 'signal' | 'warning' | 'danger' | 'neutral'> = {
  ACTIVE: 'success',
  TRIALING: 'signal',
  PAST_DUE: 'warning',
  CANCELED: 'danger',
};

export default function AdminCustomersPage() {
  const { me } = useAuth();
  const { toast } = useToast();
  const isFullAdmin = me?.user.adminRole === 'ADMIN';

  const [tenants, setTenants] = useState<AdminTenantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // Add-customer form
  const [showAdd, setShowAdd] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [industry, setIndustry] = useState<Industry>('CLINIC');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [newLogin, setNewLogin] = useState<{ email: string; password: string } | null>(null);

  async function createCustomer() {
    if (!companyName.trim() || !ownerName.trim() || !ownerEmail.trim()) {
      toast('Fill in the company, owner name, and email.', 'error');
      return;
    }
    setAddBusy(true);
    try {
      const result = await AdminApi.createTenant({
        companyName: companyName.trim(),
        industry,
        ownerName: ownerName.trim(),
        ownerEmail: ownerEmail.trim().toLowerCase(),
      });
      setNewLogin({ email: result.email, password: result.tempPassword });
      toast(`${companyName.trim()} created. Copy the owner’s temporary password now.`, 'success');
      setCompanyName('');
      setOwnerName('');
      setOwnerEmail('');
      setShowAdd(false);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not create the customer.', 'error');
    } finally {
      setAddBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    AdminApi.tenants(controller.signal)
      .then(({ tenants }) => setTenants(tenants))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Could not load customers.');
      });
    return () => controller.abort();
  }, [reloadKey]);

  const filtered = useMemo(() => {
    if (!tenants) return null;
    const q = query.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter(
      (t) =>
        t.companyName.toLowerCase().includes(q) ||
        (t.ownerEmail ?? '').toLowerCase().includes(q) ||
        (t.inboundPhoneNumber ?? '').includes(q),
    );
  }, [tenants, query]);

  if (error) {
    return (
      <EmptyState
        title="Couldn't load customers"
        description={error}
        action={
          <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!filtered) {
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
          <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Customers</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            Every workspace on the platform — click one to manage it.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-64">
            <Input
              placeholder="Search by company, email, number…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {isFullAdmin && (
            <Button onClick={() => setShowAdd((v) => !v)}>{showAdd ? 'Close' : 'Add customer'}</Button>
          )}
        </div>
      </div>

      {newLogin && (
        <div className="flex animate-pop-in items-start justify-between gap-4 rounded-2xl border border-construction/30 bg-construction-soft/60 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-ink">
              Workspace created — owner login for {newLogin.email}, temporary password shown once
            </p>
            <p className="mt-1 font-mono text-lg font-semibold tracking-wide text-ink">{newLogin.password}</p>
            <p className="mt-1 text-xs text-ink-muted">
              Send it to them securely. They sign in at the normal login page and should change it after.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setNewLogin(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {showAdd && isFullAdmin && (
        <Card>
          <CardHeader
            title="Add a customer"
            description="Creates the workspace and an owner login. You'll get a one-time password to hand off."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Company name" placeholder="Northside Family Clinic" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            <Select label="Industry" value={industry} onChange={(e) => setIndustry(e.target.value as Industry)}>
              <option value="CLINIC">Medical clinic</option>
              <option value="CONSTRUCTION">Construction / contractor</option>
            </Select>
            <Input label="Owner name" placeholder="Jordan Lee" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
            <Input label="Owner email" type="email" placeholder="owner@theircompany.com" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
          </div>
          <div className="mt-4 flex justify-end">
            <Button loading={addBusy} onClick={createCustomer}>
              Create workspace
            </Button>
          </div>
        </Card>
      )}

      {filtered.length === 0 ? (
        <EmptyState title="No customers match" description="Try a different search." />
      ) : (
        <Card padded={false} className="overflow-hidden">
          <div className="hidden grid-cols-[1.6fr_1fr_0.8fr_0.8fr_0.9fr_0.9fr] gap-4 border-b border-line/70 bg-paper/60 px-6 py-3 md:grid">
            {['Company', 'Owner', 'Status', 'Receptionist', 'Calls (30d)', 'Billed (30d)'].map((h) => (
              <p key={h} className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                {h}
              </p>
            ))}
          </div>
          <ul className="divide-y divide-line/60">
            {filtered.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/admin/customers/${t.id}`}
                  className="grid grid-cols-1 gap-2 px-6 py-4 transition-colors hover:bg-paper/70 md:grid-cols-[1.6fr_1fr_0.8fr_0.8fr_0.9fr_0.9fr] md:items-center md:gap-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{t.companyName}</p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {t.inboundPhoneNumber ? formatPhone(t.inboundPhoneNumber) : 'No number assigned'} · since{' '}
                      {formatDate(t.createdAt)}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{t.ownerName ?? '—'}</p>
                    <p className="truncate text-xs text-ink-muted">{t.ownerEmail ?? ''}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={SUBSCRIPTION_TONES[t.subscriptionStatus] ?? 'neutral'} dot>
                      {t.subscriptionStatus}
                    </Badge>
                    {t.blocked && (
                      <Badge tone="danger" dot>
                        Blocked
                      </Badge>
                    )}
                  </div>
                  <div>
                    {t.receptionistActive ? (
                      <Badge tone="success" dot>
                        Live
                      </Badge>
                    ) : (
                      <Badge tone="neutral" dot>
                        Paused
                      </Badge>
                    )}
                  </div>
                  <p className="font-mono text-sm text-ink">{t.calls30d}</p>
                  <p className="font-mono text-sm text-ink">{formatCents(t.billed30dCents)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
