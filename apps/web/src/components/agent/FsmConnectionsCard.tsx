'use client';

import { useEffect, useState } from 'react';
import { FsmApi, FeaturesApi, ApiError, type FsmConnection, type FsmProvider } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader, Badge } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Toggle } from '@/components/ui/Toggle';
import { Spinner } from '@/components/ui/Spinner';

/**
 * Field-service-software connections (ServiceTitan / Jobber / Housecall Pro).
 * Hidden entirely unless the operator has entitled the FSM_INTEGRATION feature —
 * the per-customer on/off the operator controls. Lets the customer connect a
 * system so captured jobs flow into it.
 */
export function FsmConnectionsCard() {
  const { toast } = useToast();
  const [show, setShow] = useState<boolean | null>(null);
  const [conns, setConns] = useState<FsmConnection[]>([]);
  const [openForm, setOpenForm] = useState<FsmProvider | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<FsmProvider | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([FeaturesApi.list(), FsmApi.list()])
      .then(([{ features }, { connections }]) => {
        if (!alive) return;
        const f = features.find((x) => x.key === 'FSM_INTEGRATION');
        setShow(!!f && f.available && f.entitled);
        setConns(connections);
      })
      .catch(() => alive && setShow(false));
    return () => {
      alive = false;
    };
  }, []);

  function refresh() {
    FsmApi.list().then(({ connections }) => setConns(connections)).catch(() => {});
  }

  async function connect(c: FsmConnection) {
    setBusy(c.provider);
    try {
      await FsmApi.connect(c.provider, draft);
      toast(`${c.label} connected.`, 'success');
      setOpenForm(null);
      setDraft({});
      refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not connect.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(c: FsmConnection) {
    setBusy(c.provider);
    try {
      await FsmApi.disconnect(c.provider);
      toast(`${c.label} disconnected.`, 'success');
      refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not disconnect.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function togglePush(c: FsmConnection, next: boolean) {
    setConns((cur) => cur.map((x) => (x.provider === c.provider ? { ...x, pushJobs: next } : x)));
    try {
      await FsmApi.setPush(c.provider, next);
    } catch {
      setConns((cur) => cur.map((x) => (x.provider === c.provider ? { ...x, pushJobs: !next } : x)));
      toast('Could not update.', 'error');
    }
  }

  if (show === null) {
    return (
      <Card>
        <div className="flex h-20 items-center justify-center">
          <Spinner className="h-5 w-5 text-signal" />
        </div>
      </Card>
    );
  }
  if (!show) return null;

  return (
    <Card>
      <CardHeader
        title="Field service software"
        description="Connect the system your crew runs on so jobs the receptionist captures land there automatically."
      />
      <div className="flex flex-col divide-y divide-line/60">
        {conns.map((c) => (
          <div key={c.provider} className="py-4 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <p className="text-sm font-semibold text-ink">{c.label}</p>
                {c.connected ? (
                  <Badge tone={c.status === 'ERROR' ? 'danger' : 'success'} dot>
                    {c.status === 'ERROR' ? 'Error' : 'Connected'}
                  </Badge>
                ) : (
                  <Badge tone="neutral">Not connected</Badge>
                )}
                {!c.pushReady && (
                  <span className="rounded-full bg-construction-soft/70 px-2 py-0.5 text-[11px] font-medium text-construction">
                    Live sync coming soon
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {c.connected ? (
                  <Button size="sm" variant="secondary" disabled={busy === c.provider} onClick={() => disconnect(c)}>
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant={openForm === c.provider ? 'secondary' : 'primary'}
                    onClick={() => {
                      setOpenForm(openForm === c.provider ? null : c.provider);
                      setDraft({});
                    }}
                  >
                    {openForm === c.provider ? 'Cancel' : 'Connect'}
                  </Button>
                )}
              </div>
            </div>

            {c.connected && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-ink-muted">
                  {c.accountLabel}
                  {c.lastError ? ` · ${c.lastError}` : ''}
                </p>
                <Toggle
                  checked={c.pushJobs}
                  onChange={(v) => togglePush(c, v)}
                  label="Push captured jobs"
                />
              </div>
            )}

            {openForm === c.provider && !c.connected && (
              <div className="mt-3 grid gap-3 rounded-xl border border-line/70 bg-paper/50 p-4 sm:grid-cols-2">
                {c.credentialFields.map((f) => (
                  <Input
                    key={f.key}
                    label={f.label}
                    type={f.secret ? 'password' : 'text'}
                    value={draft[f.key] ?? ''}
                    placeholder={f.placeholder ?? undefined}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  />
                ))}
                <div className="sm:col-span-2 flex justify-end">
                  <Button size="sm" loading={busy === c.provider} onClick={() => connect(c)}>
                    Connect {c.label}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
