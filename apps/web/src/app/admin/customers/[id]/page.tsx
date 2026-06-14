'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AdminApi, ApiError, type AdminTenantDetail, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatCents, formatDateTime, formatDuration, formatPhone } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';
import { Badge, Card, CardHeader, CallStatusBadge, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { VoicePreviewButton } from '@/components/agent/VoicePreviewButton';
import { sampleUrlFor } from '@/domain/voice-catalog';

const SUBSCRIPTION_OPTIONS = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'] as const;

export default function AdminCustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const tenantId = params.id;
  const router = useRouter();
  const { me } = useAuth();
  const { toast } = useToast();
  const isFullAdmin = me?.user.adminRole === 'ADMIN';

  const [tenant, setTenant] = useState<AdminTenantDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);

  // Assistant assignment (full-admin only)
  const [assistantInput, setAssistantInput] = useState('');
  const [assistantBusy, setAssistantBusy] = useState(false);

  // Invite a user to this workspace
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('MANAGER');
  const [inviteBusy, setInviteBusy] = useState(false);

  const load = useCallback(() => {
    AdminApi.tenant(tenantId)
      .then(({ tenant }) => {
        setTenant(tenant);
        setAssistantInput(tenant.settings?.assistantId ?? '');
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not load this workspace.'),
      );
  }, [tenantId]);

  async function saveAssistant() {
    const value = assistantInput.trim();
    setAssistantBusy(true);
    try {
      const result = await AdminApi.setAssistant(tenantId, value);
      if (result.assistantId) {
        const name = result.assistantName ? ` (“${result.assistantName}”)` : '';
        toast(`Assistant${name} linked.`, 'success');
        if (result.phoneNumber) {
          toast(`Pulled in the number ${result.phoneNumber} from Vapi.`, 'success');
        } else if (result.phoneNote) {
          toast(result.phoneNote, 'info');
        }
        if (!result.synced && result.syncNote) toast(result.syncNote, 'info');
      } else {
        toast('Assistant unassigned.', 'success');
      }
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the assistant.', 'error');
    } finally {
      setAssistantBusy(false);
    }
  }

  useEffect(() => {
    load();
  }, [load]);

  async function patch(change: Parameters<typeof AdminApi.updateTenant>[1], confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy('patch');
    try {
      await AdminApi.updateTenant(tenantId, change);
      toast('Saved.', 'success');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That change did not save.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function resetPassword(userId: string, email: string) {
    if (
      !window.confirm(
        `Reset the password for ${email}?\n\nTheir current password stops working immediately. You'll get a one-time temporary password to send them.`,
      )
    ) {
      return;
    }
    setBusy(userId);
    try {
      const result = await AdminApi.resetPassword(tenantId, userId);
      setTempPassword({ email: result.email, password: result.tempPassword });
      toast('Password reset. Copy the temporary password now.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not reset the password.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function inviteUser() {
    const email = inviteEmail.trim().toLowerCase();
    const fullName = inviteName.trim();
    if (!email || !fullName) {
      toast('Enter a name and email first.', 'error');
      return;
    }
    setInviteBusy(true);
    try {
      const result = await AdminApi.inviteUser(tenantId, { email, fullName, role: inviteRole });
      setTempPassword({ email: result.email, password: result.tempPassword });
      toast(`${result.email} added. Copy the temporary password now.`, 'success');
      setInviteEmail('');
      setInviteName('');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add that person.', 'error');
    } finally {
      setInviteBusy(false);
    }
  }

  async function deleteWorkspace() {
    if (!tenant) return;
    if (
      !window.confirm(
        `Permanently delete ${tenant.companyName}?\n\nThis erases the workspace, all its users, call history, and appointments. This cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy('delete');
    try {
      await AdminApi.deleteTenant(tenantId);
      toast(`${tenant.companyName} deleted.`, 'success');
      router.push('/admin/customers');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete the workspace.', 'error');
      setBusy(null);
    }
  }

  if (error) {
    return <EmptyState title="Couldn't load this workspace" description={error} />;
  }
  if (!tenant) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link
            href="/admin/customers"
            className="group mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
          >
            <span className="transition-transform duration-150 group-hover:-translate-x-0.5">←</span> All customers
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">{tenant.companyName}</h2>
            {tenant.blocked && (
              <Badge tone="danger" dot>
                Blocked
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-ink-muted">
            {tenant.industry === 'CLINIC' ? 'Medical clinic' : 'Contractor'} · customer since{' '}
            {formatDateTime(tenant.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tenant.receptionistActive ? (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'patch'}
              onClick={() =>
                patch(
                  { receptionistActive: false },
                  `Pause the receptionist for ${tenant.companyName}?\n\nIncoming calls will hear "not activated" until you turn it back on.`,
                )
              }
            >
              Pause receptionist
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'patch'}
              onClick={() => patch({ receptionistActive: true })}
            >
              Activate receptionist
            </Button>
          )}
          {isFullAdmin &&
            (tenant.blocked ? (
              <Button
                size="sm"
                loading={busy === 'patch'}
                onClick={() => patch({ blocked: false }, `Unblock ${tenant.companyName}? Their team can sign in again.`)}
              >
                Unblock
              </Button>
            ) : (
              <Button
                variant="danger"
                size="sm"
                loading={busy === 'patch'}
                onClick={() =>
                  patch(
                    { blocked: true },
                    `Block ${tenant.companyName}?\n\nTheir team can't sign in and the receptionist stops taking calls. You can unblock anytime.`,
                  )
                }
              >
                Block
              </Button>
            ))}
          {isFullAdmin && (
            <Button variant="danger" size="sm" loading={busy === 'delete'} onClick={deleteWorkspace}>
              Delete
            </Button>
          )}
        </div>
      </div>

      {tenant.blocked && (
        <p className="flex items-center gap-2.5 rounded-xl border border-danger/25 bg-danger/5 px-4 py-3 text-sm text-danger">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 shrink-0">
            <circle cx="8" cy="8" r="6" />
            <path d="M5 5l6 6" strokeLinecap="round" />
          </svg>
          This workspace is blocked. Its team can’t sign in and the receptionist won’t take calls until you unblock it.
        </p>
      )}

      {tempPassword && (
        <div className="flex animate-pop-in items-start justify-between gap-4 rounded-2xl border border-construction/30 bg-construction-soft/60 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-ink">
              Temporary password for {tempPassword.email} — shown only once
            </p>
            <p className="mt-1 font-mono text-lg font-semibold tracking-wide text-ink">{tempPassword.password}</p>
            <p className="mt-1 text-xs text-ink-muted">
              Send it to them securely. They should change it after signing in.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setTempPassword(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {/* Voice assistant — link this customer to a Vapi assistant */}
      <Card>
        <CardHeader
          title="Voice assistant"
          description="Link this customer to a Vapi assistant. Their Receptionist edits then sync to it automatically."
        />
        {!isFullAdmin ? (
          <p className="rounded-xl border border-line/70 bg-paper/60 px-4 py-3 text-sm text-ink-muted">
            {tenant.settings?.assistantId ? (
              <>
                Assigned assistant:{' '}
                <span className="font-mono text-ink">{tenant.settings.assistantId}</span>
              </>
            ) : (
              'No assistant assigned. Ask a full admin to link one.'
            )}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Input
                  label="Vapi assistant ID"
                  placeholder="e.g. 1230d090-36df-4b50-b4d8-b22beaea8963"
                  value={assistantInput}
                  onChange={(e) => setAssistantInput(e.target.value)}
                  className="font-mono text-sm"
                  hint={
                    tenant.settings?.assistantId
                      ? 'Linked. Replace the ID to point at a different assistant, or clear it to unassign.'
                      : 'Paste the assistant ID from your Vapi dashboard. We check it exists before saving.'
                  }
                />
              </div>
              <Button
                loading={assistantBusy}
                disabled={assistantInput.trim() === (tenant.settings?.assistantId ?? '')}
                onClick={saveAssistant}
              >
                {assistantInput.trim().length === 0 && tenant.settings?.assistantId
                  ? 'Unassign'
                  : tenant.settings?.assistantId
                    ? 'Update'
                    : 'Assign'}
              </Button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-ink-muted">
              When the customer saves their Receptionist settings, the app pushes voice, greeting, prompt,
              and hours to this assistant. Needs the Vapi private key under{' '}
              <Link href="/admin/config" className="font-medium text-signal-deep hover:text-signal">
                Keys &amp; config
              </Link>
              .
            </p>
          </>
        )}
      </Card>

      {/* Invite a teammate into this customer's workspace */}
      <Card>
        <CardHeader
          title="Add a team member"
          description="Create a login for this workspace. You'll get a one-time password to send them."
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Full name"
              placeholder="Jordan Lee"
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <Input
              label="Email"
              type="email"
              placeholder="jordan@theircompany.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
          </div>
          <div className="sm:w-44">
            <Select
              label="Role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Role)}
            >
              <option value="OWNER">Owner</option>
              <option value="MANAGER">Manager</option>
              <option value="AGENT">Agent (view only)</option>
            </Select>
          </div>
          <Button loading={inviteBusy} onClick={inviteUser}>
            Add
          </Button>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Billing" />
          <div className="flex flex-col gap-3">
            <Select
              label="Subscription status"
              value={tenant.subscriptionStatus}
              onChange={(e) => {
                const next = e.target.value;
                patch(
                  { subscriptionStatus: next },
                  next === 'CANCELED'
                    ? `Cancel ${tenant.companyName}?\n\nTheir receptionist stops answering calls immediately.`
                    : undefined,
                );
              }}
            >
              {SUBSCRIPTION_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">Call markup</p>
              <p className="mt-1 text-sm text-ink">
                +{(tenant.markupBps / 100).toFixed(0)}% on provider cost
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">Your margin on every billed call.</p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Receptionist" />
          {tenant.settings ? (
            <dl className="flex flex-col gap-2.5 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Status</dt>
                <dd>
                  {tenant.receptionistActive ? (
                    <Badge tone="success" dot>
                      Live
                    </Badge>
                  ) : (
                    <Badge tone="neutral" dot>
                      Paused
                    </Badge>
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Number</dt>
                <dd className="font-mono text-ink">
                  {tenant.settings.inboundPhoneNumber ? formatPhone(tenant.settings.inboundPhoneNumber) : '—'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Voice</dt>
                <dd className="flex items-center gap-2 text-ink">
                  <span>
                    {tenant.settings.voiceProvider}/{tenant.settings.voiceId}
                  </span>
                  <VoicePreviewButton
                    sampleUrl={sampleUrlFor(
                      tenant.settings.voiceProvider as 'vapi' | '11labs',
                      tenant.settings.voiceId,
                    )}
                    voiceLabel={tenant.settings.voiceId}
                  />
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Ambience</dt>
                <dd className="text-ink">{tenant.settings.backgroundSound}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Timezone</dt>
                <dd className="text-ink">{tenant.settings.timezone}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-ink-muted">No settings yet.</p>
          )}
        </Card>

        <Card>
          <CardHeader title="Team" description="Reset a password if someone is locked out" />
          <ul className="flex flex-col divide-y divide-line/60">
            {tenant.users.map((user) => (
              <li key={user.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{user.fullName}</p>
                  <p className="truncate text-xs text-ink-muted">
                    {user.email} · {user.role}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busy === user.id}
                  onClick={() => resetPassword(user.id, user.email)}
                >
                  Reset password
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card padded={false}>
          <div className="px-6 pt-5">
            <CardHeader title="Recent calls" />
          </div>
          {tenant.recentCalls.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-ink-muted">No calls yet.</p>
          ) : (
            <ul className="divide-y divide-line/60 px-6 pb-4">
              {tenant.recentCalls.map((call) => (
                <li key={call.id} className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-ink-muted">
                      {formatDateTime(call.startedAt)} · {formatDuration(call.durationSeconds)} ·{' '}
                      {call.channel === 'web' ? 'browser test' : formatPhone(call.callerNumber)}
                    </p>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs text-ink-muted">{formatCents(call.billedCostCents)}</span>
                      <CallStatusBadge status={call.status} />
                    </div>
                  </div>
                  {call.summary && <p className="mt-1.5 text-sm leading-relaxed text-ink">{call.summary}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card padded={false}>
          <div className="px-6 pt-5">
            <CardHeader title="Upcoming appointments" />
          </div>
          {tenant.upcomingAppointments.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-ink-muted">Nothing scheduled.</p>
          ) : (
            <ul className="divide-y divide-line/60 px-6 pb-4">
              {tenant.upcomingAppointments.map((appointment) => (
                <li key={appointment.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{appointment.customerName}</p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {formatDateTime(appointment.startsAt)}
                      {appointment.reason ? ` · ${appointment.reason}` : ''}
                    </p>
                  </div>
                  <Badge tone={appointment.source === 'VOICE_AGENT' ? 'signal' : 'neutral'}>
                    {appointment.source === 'VOICE_AGENT' ? 'Voice agent' : 'Manual'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
