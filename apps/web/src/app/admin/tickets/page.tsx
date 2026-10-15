'use client';

import { useEffect, useState } from 'react';
import { AdminApi, ApiError, type AdminSupportTicket } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Badge, Card, EmptyState } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';

const CATEGORY_TONES: Record<AdminSupportTicket['category'], 'warning' | 'danger' | 'neutral'> = {
  ISSUE: 'warning',
  BAD_CALL: 'danger',
  OTHER: 'neutral',
};

/**
 * The team's support-ticket inbox: tickets customers filed through the
 * in-app support agent (Adam), newest first. Open only by default; the
 * full list is one filter away. Read-only in this first cut — working a
 * ticket still happens wherever the team already talks to the customer.
 */
export default function AdminTicketsPage() {
  const [tickets, setTickets] = useState<AdminSupportTicket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  useEffect(() => {
    setTickets(null);
    setError(null);
    AdminApi.tickets(showResolved ? undefined : { status: 'OPEN' })
      .then(({ tickets: rows }) => setTickets(rows))
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the tickets.'),
      );
  }, [showResolved]);

  if (error) {
    return <EmptyState title="Couldn't load the tickets" description={error} />;
  }
  if (!tickets) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">
            Support tickets
          </h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            Filed by customers through Adam, the in-app support agent. Newest first.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
            className="h-4 w-4 accent-clinic"
          />
          Show resolved too
        </label>
      </div>

      {tickets.length === 0 ? (
        <EmptyState
          title={showResolved ? 'No tickets yet' : 'No open tickets'}
          description={
            showResolved
              ? 'Tickets customers file through the support agent will show up here.'
              : 'Nothing is waiting on the team right now.'
          }
        />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line/60">
            {tickets.map((ticket) => (
              <li key={ticket.id} className="px-6 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Badge tone={CATEGORY_TONES[ticket.category]} dot>
                      {ticket.categoryLabel}
                    </Badge>
                    <p className="min-w-0 truncate text-sm font-medium text-ink">{ticket.subject}</p>
                    <span className="shrink-0 font-mono text-xs text-ink-muted">{ticket.reference}</span>
                    {ticket.status === 'RESOLVED' && (
                      <Badge tone="neutral">Resolved</Badge>
                    )}
                  </div>
                  <p className="shrink-0 text-xs text-ink-muted">
                    {ticket.tenant.companyName} · {ticket.createdBy.fullName} ({ticket.createdBy.email}) ·{' '}
                    {formatDateTime(ticket.createdAt)}
                  </p>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
                  {ticket.details}
                </p>
                {ticket.call && (
                  <p className="mt-1.5 text-xs text-ink-muted">
                    About the call on {formatDateTime(ticket.call.startedAt)}
                    {ticket.call.callerNumber ? ` from ${ticket.call.callerNumber}` : ''} (call id{' '}
                    {ticket.call.id})
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
