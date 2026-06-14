'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminApi, ApiError, type AdminRole, type AdminTeamMember } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatDate } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';

const ROLE_COPY: Record<AdminRole, { label: string; blurb: string; tone: 'signal' | 'neutral' }> = {
  ADMIN: {
    label: 'Admin',
    blurb: 'Full control — customers, API keys, billing, and managing the team.',
    tone: 'signal',
  },
  SUPPORT: {
    label: 'Support',
    blurb: 'Help customers — view accounts, reset passwords, pause/activate. No API keys or team access.',
    tone: 'neutral',
  },
};

export default function AdminTeamPage() {
  const { me } = useAuth();
  const { toast } = useToast();
  const [admins, setAdmins] = useState<AdminTeamMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AdminRole>('SUPPORT');
  const [newLogin, setNewLogin] = useState<{ email: string; password: string } | null>(null);

  const isFullAdmin = me?.user.adminRole === 'ADMIN';

  const load = useCallback(() => {
    AdminApi.team()
      .then(({ admins }) => setAdmins(admins))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load the team.'));
  }, []);

  useEffect(() => {
    if (isFullAdmin) load();
  }, [load, isFullAdmin]);

  // Managing operators is full-admin only.
  if (me && !isFullAdmin) {
    return (
      <EmptyState
        title="Admins only"
        description="Managing team access is restricted to full admins."
      />
    );
  }

  async function grant() {
    const value = email.trim().toLowerCase();
    if (!value) {
      toast('Enter an email first.', 'error');
      return;
    }
    setBusy('add');
    try {
      const result = await AdminApi.addTeamMember(value, role);
      if (result.tempPassword) {
        setNewLogin({ email: result.email, password: result.tempPassword });
        toast('Account created. Copy the temporary password now.', 'success');
      } else {
        toast(`${result.email} now has ${ROLE_COPY[result.role].label} access.`, 'success');
      }
      setEmail('');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not grant access.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function revoke(member: AdminTeamMember) {
    if (
      !window.confirm(
        `Remove admin access for ${member.email}?\n\nThey lose access immediately. If they have a login it stays, but with no admin powers.`,
      )
    ) {
      return;
    }
    setBusy(member.email);
    try {
      await AdminApi.removeTeamMember(member.email);
      toast(`Access removed for ${member.email}.`, 'success');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove access.', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return <EmptyState title="Couldn't load the team" description={error} />;
  }
  if (!admins) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  const myEmail = me?.user.email.toLowerCase();

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Team</h2>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
          Give people access to this panel. <strong className="font-semibold text-ink">Admin</strong> gets
          full control; <strong className="font-semibold text-ink">Support</strong> can help customers but
          never sees your API keys or this page.
        </p>
      </div>

      {/* Grant access */}
      <Card>
        <CardHeader title="Add someone" description="Enter their work email and choose an access level." />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Email"
              type="email"
              placeholder="teammate@yourcompany.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="sm:w-48">
            <Select label="Access level" value={role} onChange={(e) => setRole(e.target.value as AdminRole)}>
              <option value="SUPPORT">Support</option>
              <option value="ADMIN">Admin (full)</option>
            </Select>
          </div>
          <Button loading={busy === 'add'} onClick={grant}>
            Grant access
          </Button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-muted">{ROLE_COPY[role].blurb}</p>
      </Card>

      {newLogin && (
        <div className="flex animate-pop-in items-start justify-between gap-4 rounded-2xl border border-construction/30 bg-construction-soft/60 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-ink">
              New login created for {newLogin.email} — temporary password, shown once
            </p>
            <p className="mt-1 font-mono text-lg font-semibold tracking-wide text-ink">{newLogin.password}</p>
            <p className="mt-1 text-xs text-ink-muted">
              Send it to them securely. They sign in at the normal login page, then open <code>/admin</code>.
              They should change this password after first sign-in.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setNewLogin(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {/* Current team */}
      <Card padded={false}>
        <div className="px-6 pt-5">
          <CardHeader title={`People with access (${admins.length})`} />
        </div>
        <ul className="divide-y divide-line/60 px-6 pb-4">
          {admins.map((member) => {
            const copy = ROLE_COPY[member.role];
            const isSelf = member.email.toLowerCase() === myEmail;
            return (
              <li key={member.email} className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold text-ink">{member.email}</p>
                    <Badge tone={copy.tone} dot>
                      {copy.label}
                    </Badge>
                    {member.source === 'bootstrap' && <Badge tone="success">Founder</Badge>}
                    {isSelf && <Badge tone="neutral">You</Badge>}
                    {!member.hasLogin && (
                      <Badge tone="warning" dot>
                        No login yet
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {member.source === 'bootstrap'
                      ? 'Permanent admin (set in server config)'
                      : member.createdBy
                        ? `Added by ${member.createdBy}${member.createdAt ? ` · ${formatDate(member.createdAt)}` : ''}`
                        : 'Granted access'}
                  </p>
                </div>
                {member.removable && !isSelf ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busy === member.email}
                    onClick={() => revoke(member)}
                  >
                    Remove
                  </Button>
                ) : (
                  <span className="text-xs text-ink-muted">{isSelf ? '—' : 'Locked'}</span>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
