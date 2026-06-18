'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminApi, ApiError, type AccessCodeRow } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatDate } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';

export default function AdminAccessCodesPage() {
  const { me } = useAuth();
  const { toast } = useToast();
  const [codes, setCodes] = useState<AccessCodeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [fresh, setFresh] = useState<AccessCodeRow | null>(null);

  const isFullAdmin = me?.user.adminRole === 'ADMIN';

  const load = useCallback(() => {
    AdminApi.accessCodes()
      .then(({ codes }) => setCodes(codes))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load codes.'));
  }, []);

  useEffect(() => {
    if (isFullAdmin) load();
  }, [load, isFullAdmin]);

  if (me && !isFullAdmin) {
    return (
      <EmptyState
        title="Admins only"
        description="Issuing signup invitations is restricted to full admins."
      />
    );
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast('Code copied to clipboard.', 'success');
    } catch {
      toast('Could not copy — select and copy it manually.', 'error');
    }
  }

  async function generate() {
    setBusy('add');
    try {
      const { code } = await AdminApi.createAccessCode({
        label: label.trim() || undefined,
        email: email.trim() || undefined,
      });
      setFresh(code);
      setLabel('');
      setEmail('');
      toast('Code generated. Send it to the customer.', 'success');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not generate a code.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function revoke(row: AccessCodeRow) {
    if (!window.confirm(`Revoke code ${row.code}? It can no longer be used to sign up.`)) return;
    setBusy(row.id);
    try {
      await AdminApi.revokeAccessCode(row.id);
      toast('Code revoked.', 'success');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not revoke the code.', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return <EmptyState title="Couldn't load access codes" description={error} />;
  }
  if (!codes) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  const available = codes.filter((c) => !c.used).length;

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Access codes</h2>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
          Signups are invite-only. Generate a one-time code after a demo or sales call, then send it to the
          customer — they enter it to create their account. Each code works once.
        </p>
      </div>

      {/* Generate */}
      <Card>
        <CardHeader
          title="Generate a code"
          description="Add a label and email so you remember who it's for (both optional)."
        />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Label"
              placeholder="Riverside Dental"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <Input
              label="Customer email"
              type="email"
              placeholder="owner@riversidedental.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button loading={busy === 'add'} onClick={generate}>
            Generate code
          </Button>
        </div>
      </Card>

      {fresh && (
        <div className="flex animate-pop-in flex-wrap items-center justify-between gap-4 rounded-2xl border border-signal/30 bg-signal-soft/50 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-ink">
              New code{fresh.label ? ` for ${fresh.label}` : ''} — send it to the customer
            </p>
            <p className="mt-1 font-mono text-2xl font-bold tracking-wider text-signal-deep">{fresh.code}</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => copy(fresh.code)}>
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setFresh(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* List */}
      <Card padded={false}>
        <div className="px-6 pt-5">
          <CardHeader title={`Codes (${codes.length} · ${available} available)`} />
        </div>
        {codes.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState title="No codes yet" description="Generate your first invitation code above." />
          </div>
        ) : (
          <ul className="divide-y divide-line/60 px-6 pb-4">
            {codes.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-mono text-sm font-bold tracking-wide text-ink">{row.code}</p>
                    {row.used ? (
                      <Badge tone="neutral">Used</Badge>
                    ) : (
                      <Badge tone="success" dot>
                        Available
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {row.label ? `${row.label} · ` : ''}
                    {row.email ? `${row.email} · ` : ''}
                    {row.used && row.usedAt
                      ? `Used ${formatDate(row.usedAt)}`
                      : `Created ${formatDate(row.createdAt)}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  {!row.used && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => copy(row.code)}>
                        Copy
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busy === row.id}
                        onClick={() => revoke(row)}
                      >
                        Revoke
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
