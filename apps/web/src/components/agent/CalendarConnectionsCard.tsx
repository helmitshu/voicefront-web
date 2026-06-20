'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  CalendarApi,
  type CalendarStatus,
  type CalendarConnectionDto,
  type CalendarProviderId,
} from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/lib/auth-context';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Toggle';
import { Spinner } from '@/components/ui/Spinner';

const PROVIDER_META: Record<CalendarProviderId, { label: string; sub: string; icon: JSX.Element }> = {
  GOOGLE: {
    label: 'Google Calendar',
    sub: 'Gmail / Google Workspace',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
        <path fill="#4285F4" d="M22.5 12.2c0-.7-.06-1.4-.18-2.05H12v3.9h5.9a5.05 5.05 0 0 1-2.19 3.32v2.76h3.54c2.07-1.91 3.25-4.72 3.25-7.93Z" />
        <path fill="#34A853" d="M12 23c2.96 0 5.45-.98 7.26-2.65l-3.54-2.76c-.98.66-2.24 1.05-3.72 1.05-2.86 0-5.28-1.93-6.14-4.53H2.2v2.84A11 11 0 0 0 12 23Z" />
        <path fill="#FBBC05" d="M5.86 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.2a11 11 0 0 0 0 9.88l3.66-2.84Z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.2 1.64l3.14-3.14A10.6 10.6 0 0 0 12 1 11 11 0 0 0 2.2 7.06L5.86 9.9C6.72 7.3 9.14 5.38 12 5.38Z" />
      </svg>
    ),
  },
  MICROSOFT: {
    label: 'Outlook Calendar',
    sub: 'Outlook / Microsoft 365',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
        <path fill="#0A2767" d="M23 12.2v6.4c0 .5-.4.9-.9.9h-6.6V8.9l3.5 2.2 3.6-1.3c.2.6.4 1.5.4 2.4Z" />
        <path fill="#0364B8" d="M7.5 6h8.6c.5 0 .9.4.9.9v.5l-5 3-4.5-1.9V6Z" />
        <path fill="#28A8EA" d="M2 7.5 7.5 6v12L2 16.5v-9Z" />
        <circle fill="#fff" cx="5" cy="12" r="2.2" />
        <path fill="#0078D4" d="M5 10.4c.9 0 1.6.7 1.6 1.6S5.9 13.6 5 13.6 3.4 12.9 3.4 12 4.1 10.4 5 10.4Z" />
      </svg>
    ),
  },
};

const ALL_PROVIDERS: CalendarProviderId[] = ['GOOGLE', 'MICROSOFT'];

export function CalendarConnectionsCard() {
  const { me } = useAuth();
  const { toast } = useToast();
  const readOnly = me?.user.role === 'AGENT';

  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<CalendarProviderId | null>(null);

  const load = useCallback(() => {
    CalendarApi.status()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load calendar status.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Surface the result of the OAuth round-trip (the callback redirects back here
  // with ?calendar=connected|error) and then strip the params from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('calendar');
    if (!result) return;
    const provider = params.get('provider') ?? 'calendar';
    if (result === 'connected') toast(`Connected your ${provider} calendar.`, 'success');
    else if (result === 'error') toast(`Couldn't connect that calendar. Please try again.`, 'error');
    params.delete('calendar');
    params.delete('provider');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, [toast]);

  async function connect(provider: CalendarProviderId) {
    setBusyProvider(provider);
    try {
      const { url } = await CalendarApi.connectUrl(provider);
      window.location.href = url; // hand off to the provider's consent screen
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not start the connection.', 'error');
      setBusyProvider(null);
    }
  }

  async function disconnect(provider: CalendarProviderId) {
    setBusyProvider(provider);
    try {
      await CalendarApi.disconnect(provider);
      toast('Calendar disconnected.', 'success');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not disconnect.', 'error');
    } finally {
      setBusyProvider(null);
    }
  }

  async function setPref(provider: CalendarProviderId, prefs: { writeEnabled?: boolean; blockBusy?: boolean }) {
    // Optimistic — flip locally, persist, revert on failure.
    setStatus((s) =>
      s
        ? { ...s, connections: s.connections.map((c) => (c.provider === provider ? { ...c, ...prefs } : c)) }
        : s,
    );
    try {
      await CalendarApi.setPrefs(provider, prefs);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save that change.', 'error');
      load();
    }
  }

  if (error) {
    return (
      <Card>
        <CardHeader title="Calendar sync" description="Two-way sync with Google Calendar and Outlook." />
        <p className="mt-3 rounded-xl border border-dashed border-line bg-paper/60 px-4 py-4 text-sm text-ink-muted">{error}</p>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card>
        <div className="flex h-16 items-center justify-center">
          <Spinner className="h-5 w-5 text-signal" />
        </div>
      </Card>
    );
  }

  if (status.availableProviders.length === 0) {
    return (
      <Card>
        <CardHeader title="Calendar sync" description="Two-way sync with Google Calendar and Outlook." />
        <p className="mt-3 rounded-xl border border-dashed border-line bg-paper/60 px-4 py-4 text-sm text-ink-muted">
          Calendar sync isn&apos;t configured on this platform yet. The operator needs to add the Google and/or Microsoft OAuth credentials to enable it.
        </p>
      </Card>
    );
  }

  const connByProvider = new Map(status.connections.map((c) => [c.provider, c]));

  return (
    <Card>
      <CardHeader
        title="Calendar sync"
        description="Connect Google Calendar or Outlook for two-way sync: bookings appear on your calendar, and times you block there are kept free from new bookings."
      />
      <div className="mt-5 flex flex-col gap-3">
        {ALL_PROVIDERS.filter((p) => status.availableProviders.includes(p)).map((provider) => (
          <ConnectionRow
            key={provider}
            provider={provider}
            connection={connByProvider.get(provider) ?? null}
            readOnly={readOnly}
            busy={busyProvider === provider}
            onConnect={() => connect(provider)}
            onDisconnect={() => disconnect(provider)}
            onPref={(prefs) => setPref(provider, prefs)}
          />
        ))}
      </div>
    </Card>
  );
}

function ConnectionRow({
  provider,
  connection,
  readOnly,
  busy,
  onConnect,
  onDisconnect,
  onPref,
}: {
  provider: CalendarProviderId;
  connection: CalendarConnectionDto | null;
  readOnly: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onPref: (prefs: { writeEnabled?: boolean; blockBusy?: boolean }) => void;
}) {
  const meta = PROVIDER_META[provider];

  return (
    <div className="rounded-xl border border-line/60 bg-paper/40 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white ring-1 ring-inset ring-ink/8">
            {meta.icon}
          </span>
          <div>
            <p className="text-sm font-semibold text-ink">{meta.label}</p>
            <p className="text-xs text-ink-muted">
              {connection?.accountEmail ?? (connection ? 'Connected' : meta.sub)}
            </p>
          </div>
        </div>
        {connection ? (
          <Button variant="ghost" size="sm" loading={busy} disabled={readOnly} onClick={onDisconnect}>
            Disconnect
          </Button>
        ) : (
          <Button variant="secondary" size="sm" loading={busy} disabled={readOnly} onClick={onConnect}>
            Connect
          </Button>
        )}
      </div>

      {connection && (
        <>
          {connection.lastError && (
            <p className="mt-3 rounded-lg bg-danger-soft/60 px-3 py-2 text-[13px] text-danger">{connection.lastError}</p>
          )}
          <div className="mt-4 flex flex-col gap-3 border-t border-line/50 pt-4">
            <Toggle
              checked={connection.writeEnabled}
              onChange={(v) => onPref({ writeEnabled: v })}
              disabled={readOnly}
              label="Add bookings to this calendar"
              description="New appointments are written here as events."
            />
            <Toggle
              checked={connection.blockBusy}
              onChange={(v) => onPref({ blockBusy: v })}
              disabled={readOnly}
              label="Block times you're busy here"
              description="Events on this calendar keep the receptionist from booking over them."
            />
          </div>
        </>
      )}
    </div>
  );
}
