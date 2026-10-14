'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { INDUSTRY_LABELS } from '@/domain/prompt-templates';
import type { Role } from '@/lib/api';

const ROLE_LABELS: Record<Role, string> = {
  OWNER: 'Owner',
  MANAGER: 'Manager',
  AGENT: 'Agent',
};

/** 'TRIALING' → 'Trialing', 'ACTIVE' → 'Active'. */
function humanizeStatus(status: string): string {
  const lower = status.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-3.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="text-sm font-medium text-ink sm:text-right">{value}</dd>
    </div>
  );
}

export default function AccountPage() {
  const { me, signOut } = useAuth();
  const router = useRouter();
  if (!me) return null;

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Account</h2>
        <p className="mt-1.5 text-sm text-ink-muted">
          Who you&rsquo;re signed in as, and the workspace it belongs to.
        </p>
      </div>

      <Card>
        <CardHeader title="You" description="Your sign-in identity in this workspace." />
        <dl className="divide-y divide-line/70">
          <Row label="Full name" value={me.user.fullName} />
          <Row label="Email" value={me.user.email} />
          <Row label="Role in this workspace" value={ROLE_LABELS[me.user.role]} />
          {me.user.isPlatformAdmin && (
            <Row
              label="Platform access"
              value={me.user.adminRole === 'ADMIN' ? 'Full admin' : 'Support'}
            />
          )}
        </dl>
        {me.user.isPlatformAdmin && (
          <div className="mt-4">
            <Button variant="secondary" size="sm" onClick={() => router.push('/admin')}>
              Open platform admin
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Workspace" description="The business this account operates." />
        <dl className="divide-y divide-line/70">
          <Row label="Workspace name" value={me.tenant.companyName} />
          <Row label="Industry" value={INDUSTRY_LABELS[me.tenant.industry]} />
          <Row label="Subscription status" value={humanizeStatus(me.tenant.subscriptionStatus)} />
        </dl>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-ink">Sign out</p>
            <p className="mt-0.5 text-sm text-ink-muted">Ends this session on this device.</p>
          </div>
          <Button variant="secondary" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </Card>
    </div>
  );
}
