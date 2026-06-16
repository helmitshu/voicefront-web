'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminApi, ApiError, type AdminSetting } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/Toast';
import { Badge, Card, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';

export default function AdminConfigPage() {
  const { me } = useAuth();
  const { toast } = useToast();
  const [settings, setSettings] = useState<AdminSetting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [demoEnabled, setDemoEnabled] = useState<boolean | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [repointBusy, setRepointBusy] = useState(false);

  const isFullAdmin = me?.user.adminRole === 'ADMIN';

  const load = useCallback(() => {
    AdminApi.settings()
      .then(({ settings }) => setSettings(settings))
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not load configuration.'),
      );
    AdminApi.demoEnabled()
      .then(({ enabled }) => setDemoEnabled(enabled))
      .catch(() => setDemoEnabled(null));
  }, []);

  async function repointWebhooks() {
    if (!window.confirm('Re-point every Vapi phone number at this production server?\n\nSafe and idempotent — it just sets each number’s Server URL to PUBLIC_API_URL.')) {
      return;
    }
    setRepointBusy(true);
    try {
      const r = await AdminApi.migrateWebhooks();
      toast(
        `${r.updated}/${r.total} numbers now point at production${r.failed ? ` (${r.failed} failed)` : ''}.`,
        r.failed ? 'error' : 'success',
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not re-point numbers.', 'error');
    } finally {
      setRepointBusy(false);
    }
  }

  async function toggleDemo() {
    if (demoEnabled === null) return;
    const next = !demoEnabled;
    setDemoBusy(true);
    try {
      await AdminApi.setDemoEnabled(next);
      setDemoEnabled(next);
      toast(next ? 'Landing-page demo is now live.' : 'Landing-page demo is hidden.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not change the demo.', 'error');
    } finally {
      setDemoBusy(false);
    }
  }

  useEffect(() => {
    if (isFullAdmin) load();
  }, [load, isFullAdmin]);

  // API keys are full-admin only; Support operators get a clean message.
  if (me && !isFullAdmin) {
    return (
      <EmptyState
        title="Admins only"
        description="API keys and configuration are restricted to full admins. Ask an admin if you need a key changed."
      />
    );
  }

  async function save(setting: AdminSetting) {
    const value = (drafts[setting.key] ?? '').trim();
    if (!value) {
      toast('Paste a value first.', 'error');
      return;
    }
    if (
      setting.key === 'VAPI_WEBHOOK_SECRET' &&
      !window.confirm(
        'Change the webhook secret?\n\nIt must match what you set on your Vapi phone number. If they differ, incoming calls stop working until both match.',
      )
    ) {
      return;
    }
    setBusy(setting.key);
    try {
      await AdminApi.setSetting(setting.key, value);
      toast(`${setting.label} saved — live on the next call.`, 'success');
      setDrafts((d) => ({ ...d, [setting.key]: '' }));
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save that value.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function revert(setting: AdminSetting) {
    if (
      !window.confirm(
        `Remove the admin override for ${setting.label}?\n\nThe server falls back to the value in the .env file (if any).`,
      )
    ) {
      return;
    }
    setBusy(setting.key);
    try {
      await AdminApi.unsetSetting(setting.key);
      toast(`${setting.label} reverted to the .env value.`, 'success');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not revert.', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return <EmptyState title="Couldn't load configuration" description={error} />;
  }
  if (!settings) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Keys & config</h2>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
          Paste a value and save — it takes effect on the very next call, no restart needed. Values are
          encrypted before they touch the database. Removing an override falls back to the .env file.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <div className="flex items-center gap-2.5">
                <h3 className="font-display text-[15px] font-semibold tracking-tight text-ink">
                  Landing-page demo
                </h3>
                {demoEnabled === true && <Badge tone="signal" dot>Live</Badge>}
                {demoEnabled === false && <Badge tone="warning" dot>Hidden</Badge>}
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                The interactive voice demo on your public landing page. Turn it off to hide it from
                visitors entirely.
              </p>
            </div>
            <Button
              variant={demoEnabled ? 'secondary' : 'primary'}
              size="sm"
              loading={demoBusy}
              disabled={demoEnabled === null}
              onClick={toggleDemo}
            >
              {demoEnabled ? 'Turn off demo' : 'Turn on demo'}
            </Button>
          </div>
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <h3 className="font-display text-[15px] font-semibold tracking-tight text-ink">
                Production webhooks
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                Point every Vapi phone number at this cloud server so calls never depend on a local
                tunnel. Safe to run anytime — it just sets each number’s Server URL to the value above.
              </p>
            </div>
            <Button variant="secondary" size="sm" loading={repointBusy} onClick={repointWebhooks}>
              Re-point all numbers
            </Button>
          </div>
        </Card>

        {settings.map((setting) => (
          <Card key={setting.key}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-xl">
                <div className="flex items-center gap-2.5">
                  <h3 className="font-display text-[15px] font-semibold tracking-tight text-ink">{setting.label}</h3>
                  {setting.source === 'admin' && (
                    <Badge tone="signal" dot>
                      Admin override
                    </Badge>
                  )}
                  {setting.source === 'env' && <Badge tone="neutral">From .env</Badge>}
                  {setting.source === 'unset' && (
                    <Badge tone="warning" dot>
                      Not set
                    </Badge>
                  )}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{setting.description}</p>
                {setting.preview && (
                  <p className="mt-2 font-mono text-xs text-ink-muted">
                    Current value: <span className="text-ink">{setting.preview}</span>
                  </p>
                )}
              </div>
              {setting.source === 'admin' && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busy === setting.key}
                  onClick={() => revert(setting)}
                >
                  Revert to .env
                </Button>
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <div className="w-full max-w-md">
                <Input
                  placeholder={setting.placeholder}
                  type={setting.secret ? 'password' : 'text'}
                  value={drafts[setting.key] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [setting.key]: e.target.value }))}
                />
              </div>
              <Button
                size="sm"
                loading={busy === setting.key}
                disabled={!(drafts[setting.key] ?? '').trim()}
                onClick={() => save(setting)}
              >
                Save
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
