'use client';

import { useEffect, useState } from 'react';
import { AdminApi, ApiError, type AdminAuditEntry } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Badge, Card, EmptyState } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';

const ACTION_LABELS: Record<string, { label: string; tone: 'signal' | 'warning' | 'danger' | 'neutral' }> = {
  'tenant.update': { label: 'Customer updated', tone: 'signal' },
  'user.reset_password': { label: 'Password reset', tone: 'warning' },
  'config.set': { label: 'Config saved', tone: 'signal' },
  'config.unset': { label: 'Config reverted', tone: 'neutral' },
};

export default function AdminAuditPage() {
  const [entries, setEntries] = useState<AdminAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    AdminApi.audit()
      .then(({ entries }) => setEntries(entries))
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the audit log.'),
      );
  }, []);

  if (error) {
    return <EmptyState title="Couldn't load the audit log" description={error} />;
  }
  if (!entries) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Audit log</h2>
        <p className="mt-1.5 text-sm text-ink-muted">
          Every change made through this panel, newest first. Your undo trail.
        </p>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          description="Actions you take in the admin panel will show up here."
        />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line/60">
            {entries.map((entry) => {
              const meta = ACTION_LABELS[entry.action] ?? { label: entry.action, tone: 'neutral' as const };
              const detail = JSON.stringify(entry.detail);
              return (
                <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <Badge tone={meta.tone} dot>
                      {meta.label}
                    </Badge>
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink">
                        {entry.target ?? '—'}
                        {detail !== '{}' && (
                          <span className="ml-2 font-mono text-xs text-ink-muted">{detail}</span>
                        )}
                      </p>
                    </div>
                  </div>
                  <p className="shrink-0 text-xs text-ink-muted">
                    {entry.adminEmail} · {formatDateTime(entry.createdAt)}
                  </p>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
