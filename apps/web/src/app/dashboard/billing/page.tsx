'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiError, BillingApi, type Billing } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';

function daysLeft(trialEndsAt: string | null): number | null {
  if (!trialEndsAt) return null;
  const ms = new Date(trialEndsAt).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
}

const STATUS_BADGE: Record<string, { label: string; tone: 'signal' | 'success' | 'warning' | 'danger' | 'neutral' }> = {
  TRIALING: { label: 'Free trial', tone: 'signal' },
  ACTIVE: { label: 'Active', tone: 'success' },
  PAST_DUE: { label: 'Payment due', tone: 'danger' },
  CANCELED: { label: 'Canceled', tone: 'warning' },
};

export default function BillingPage() {
  const { toast } = useToast();
  const params = useSearchParams();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    BillingApi.state()
      .then(({ billing }) => setBilling(billing))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load billing.'));
  }, []);

  useEffect(() => {
    if (params.get('billing') === 'success') toast('Subscription started — your free trial is live!', 'success');
    if (params.get('billing') === 'cancel') toast('Checkout canceled — you can start anytime.', 'error');
  }, [params, toast]);

  async function startCheckout() {
    setBusy(true);
    try {
      const { url } = await BillingApi.checkout();
      window.location.href = url;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not start checkout.', 'error');
      setBusy(false);
    }
  }

  async function openPortal() {
    setBusy(true);
    try {
      const { url } = await BillingApi.portal();
      window.location.href = url;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not open the billing portal.', 'error');
      setBusy(false);
    }
  }

  if (error) return <EmptyState title="Couldn't load billing" description={error} />;
  if (!billing) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  // Billing turned off platform-wide — nothing for the customer to manage.
  if (!billing.enabled) {
    return (
      <EmptyState
        title="Billing isn't enabled"
        description="Your plan is managed directly with us — reach out if you need to make a change."
      />
    );
  }

  const badge = STATUS_BADGE[billing.status] ?? { label: billing.status, tone: 'neutral' as const };
  const days = daysLeft(billing.trialEndsAt);
  const onTrial = billing.status === 'TRIALING';
  const trialPct = Math.min(100, Math.round((billing.trialMinutesUsed / billing.trialMinutesCap) * 100));

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Billing</h2>
        <p className="mt-1.5 text-sm text-ink-muted">Your plan, trial, and payment method.</p>
      </div>

      {billing.blockedReason && (
        <div className="rounded-2xl border border-danger/30 bg-danger-soft px-5 py-4 text-sm text-danger">
          <strong>Calls are paused.</strong> {billing.blockedReason}
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h3 className="font-display text-lg font-semibold text-ink">Professional</h3>
              <Badge tone={badge.tone} dot>{badge.label}</Badge>
            </div>
            <p className="mt-1.5 text-sm text-ink-muted">
              {billing.includedMinutes} minutes included each month{billing.currency ? ` · billed in ${billing.currency.toUpperCase()}` : ''}.
            </p>
          </div>
          {billing.subscribed ? (
            <Button variant="secondary" loading={busy} onClick={openPortal}>
              Manage billing
            </Button>
          ) : (
            <Button loading={busy} onClick={startCheckout}>
              Add a card &amp; start trial
            </Button>
          )}
        </div>

        {onTrial && (
          <div className="mt-5 border-t border-line/60 pt-5">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-medium text-ink">
                Free trial{days != null ? ` — ${days} day${days === 1 ? '' : 's'} left` : ''}
              </p>
              <span className="text-xs text-ink-muted">
                {billing.trialMinutesUsed} / {billing.trialMinutesCap} trial minutes
              </span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-paper ring-1 ring-inset ring-ink/5">
              <div
                className={`h-full rounded-full transition-all ${trialPct >= 100 ? 'bg-danger' : trialPct >= 80 ? 'bg-construction' : 'bg-signal'}`}
                style={{ width: `${Math.max(2, trialPct)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              Your trial ends after 30 days or {billing.trialMinutesCap} minutes, whichever comes first — then your card
              is charged and {billing.includedMinutes} monthly minutes begin.
            </p>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Need more volume?" />
        <p className="text-sm leading-relaxed text-ink-muted">
          On a bigger plan or want custom terms? <a className="font-medium text-signal-deep underline" href="/book">Talk to us</a> about
          Scale pricing.
        </p>
      </Card>
    </div>
  );
}
