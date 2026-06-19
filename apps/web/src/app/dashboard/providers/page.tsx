'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ProvidersApi,
  ApiError,
  type ProvidersResponse,
  type ProviderDto,
  type ServiceDto,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/Toast';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { Toggle } from '@/components/ui/Toggle';
import { Spinner } from '@/components/ui/Spinner';

/* ------------------------------- small bits ------------------------------- */

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-ink-muted ring-1 ring-inset ring-ink/5">
      {children}
    </span>
  );
}

/** Toggleable pill used to assign the other side of the provider↔service link. */
function PickPill({
  label,
  selected,
  onToggle,
  disabled,
}: {
  label: string;
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      aria-pressed={selected}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 disabled:opacity-50 ${
        selected
          ? 'bg-signal-soft/70 text-signal-deep ring-1 ring-inset ring-signal/25'
          : 'bg-paper text-ink-muted ring-1 ring-inset ring-ink/8 hover:text-ink'
      }`}
    >
      {label}
    </button>
  );
}

/* -------------------------------- editors --------------------------------- */

function ProviderForm({
  initial,
  services,
  busy,
  onSave,
  onCancel,
}: {
  initial?: ProviderDto;
  services: ServiceDto[];
  busy: boolean;
  onSave: (input: { name: string; title: string | null; active: boolean; serviceIds: string[] }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [active, setActive] = useState(initial?.active ?? true);
  const [serviceIds, setServiceIds] = useState<string[]>(initial?.serviceIds ?? []);

  function toggleService(id: string) {
    setServiceIds((cur) => (cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id]));
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line/70 bg-paper/40 p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
        <Input label="Name" placeholder="Sarah Smith" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <Input label="Title (optional)" placeholder="Dr." value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {services.length > 0 && (
        <div>
          <p className="mb-1.5 text-sm font-medium text-ink">Can perform</p>
          <p className="mb-2 text-[13px] text-ink-muted">Leave all off if they can do any service.</p>
          <div className="flex flex-wrap gap-1.5">
            {services.map((s) => (
              <PickPill key={s.id} label={s.name} selected={serviceIds.includes(s.id)} onToggle={() => toggleService(s.id)} />
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-4 border-t border-line/60 pt-3">
        <Toggle checked={active} onChange={setActive} label="Active" />
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={busy}
            disabled={name.trim().length === 0}
            onClick={() => onSave({ name: name.trim(), title: title.trim() || null, active, serviceIds })}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function ServiceForm({
  initial,
  providers,
  busy,
  onSave,
  onCancel,
}: {
  initial?: ServiceDto;
  providers: ProviderDto[];
  busy: boolean;
  onSave: (input: {
    name: string;
    durationMinutes: number;
    description: string | null;
    active: boolean;
    providerIds: string[];
  }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [duration, setDuration] = useState(String(initial?.durationMinutes ?? 30));
  const [description, setDescription] = useState(initial?.description ?? '');
  const [active, setActive] = useState(initial?.active ?? true);
  const [providerIds, setProviderIds] = useState<string[]>(initial?.providerIds ?? []);

  function toggleProvider(id: string) {
    setProviderIds((cur) => (cur.includes(id) ? cur.filter((p) => p !== id) : [...cur, id]));
  }

  const durationNum = Number.parseInt(duration, 10);
  const valid = name.trim().length > 0 && Number.isFinite(durationNum) && durationNum >= 5 && durationNum <= 480;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line/70 bg-paper/40 p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
        <Input label="Service name" placeholder="Cleaning" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <Input
          label="Length (minutes)"
          type="number"
          min={5}
          max={480}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />
      </div>
      <Textarea
        label="Description (optional)"
        rows={2}
        placeholder="What this appointment covers."
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {providers.length > 0 && (
        <div>
          <p className="mb-1.5 text-sm font-medium text-ink">Performed by</p>
          <p className="mb-2 text-[13px] text-ink-muted">Leave all off to let any provider take it.</p>
          <div className="flex flex-wrap gap-1.5">
            {providers.map((p) => (
              <PickPill
                key={p.id}
                label={p.title ? `${p.title} ${p.name}` : p.name}
                selected={providerIds.includes(p.id)}
                onToggle={() => toggleProvider(p.id)}
              />
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-4 border-t border-line/60 pt-3">
        <Toggle checked={active} onChange={setActive} label="Active" />
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={busy}
            disabled={!valid}
            onClick={() =>
              onSave({
                name: name.trim(),
                durationMinutes: durationNum,
                description: description.trim() || null,
                active,
                providerIds,
              })
            }
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- page ----------------------------------- */

export default function ProvidersPage() {
  const { me } = useAuth();
  const { toast } = useToast();
  const canEdit = me?.user.role !== 'AGENT';

  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<string | null>(null); // id | 'new' | null
  const [editingService, setEditingService] = useState<string | null>(null);

  const load = useCallback(() => {
    ProvidersApi.list()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load providers.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, okMsg?: string) {
    setBusy(key);
    try {
      await fn();
      if (okMsg) toast(okMsg, 'success');
      setEditingProvider(null);
      setEditingService(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That change did not save.', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (error) return <EmptyState title="Couldn't load providers" description={error} />;
  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  const { providers, services, config } = data;
  const nameOf = (id: string) => {
    const p = providers.find((x) => x.id === id);
    return p ? (p.title ? `${p.title} ${p.name}` : p.name) : '—';
  };

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Providers &amp; services</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Add the people your receptionist can book — and the services they offer, each with its own length.
        </p>
      </div>

      {/* Mode card */}
      <Card>
        <CardHeader
          title="Multi-provider booking"
          description="When on, the receptionist books across multiple providers — first-available by default, or a specific person when a caller asks."
        />
        {config.selfManage ? (
          <Toggle
            checked={config.enabled}
            disabled={busy === 'config' || !canEdit}
            onChange={(next) =>
              run('config', () => ProvidersApi.setConfig({ enabled: next }), next ? 'Multi-provider booking on.' : 'Switched to a single calendar.')
            }
            label={config.enabled ? 'On' : 'Off'}
            description={
              config.enabled
                ? 'Your receptionist routes callers across the providers below.'
                : 'Your receptionist uses one shared calendar. Turn on to use providers and services.'
            }
          />
        ) : (
          <div className="flex items-center justify-between gap-4 rounded-xl border border-line/70 bg-paper/60 px-4 py-3">
            <p className="text-sm text-ink-muted">
              Multi-provider booking is{' '}
              <span className="font-medium text-ink">{config.enabled ? 'on' : 'off'}</span> for your account, managed
              by the VoiceFront team. Contact us to change it.
            </p>
            <Badge tone={config.enabled ? 'success' : 'neutral'} dot>
              {config.enabled ? 'On' : 'Off'}
            </Badge>
          </div>
        )}

        {config.enabled && (
          <div className="mt-4 border-t border-line/60 pt-4">
            <Toggle
              checked={config.offerProviderChoice}
              disabled={busy === 'offer' || !canEdit}
              onChange={(next) => run('offer', () => ProvidersApi.setConfig({ offerProviderChoice: next }), 'Saved.')}
              label="Ask callers which provider they'd like"
              description="Off (recommended): only honors a request when the caller names someone — new callers aren't made to choose."
            />
          </div>
        )}
      </Card>

      {!config.enabled && (
        <p className="rounded-xl border border-signal/20 bg-signal-soft/30 px-4 py-3 text-[13px] leading-relaxed text-ink-muted">
          You can set up your roster now — it starts working the moment multi-provider booking is on.
        </p>
      )}

      {/* Providers */}
      <Card>
        <CardHeader
          title="Providers"
          description="The people who can be booked."
          action={
            canEdit && editingProvider !== 'new' ? (
              <Button size="sm" variant="secondary" onClick={() => setEditingProvider('new')}>
                Add provider
              </Button>
            ) : undefined
          }
        />
        <div className="flex flex-col gap-2.5">
          {editingProvider === 'new' && (
            <ProviderForm
              services={services}
              busy={busy === 'provider'}
              onSave={(input) => run('provider', () => ProvidersApi.createProvider(input), 'Provider added.')}
              onCancel={() => setEditingProvider(null)}
            />
          )}

          {providers.length === 0 && editingProvider !== 'new' ? (
            <EmptyState title="No providers yet" description="Add the people your receptionist can book appointments with." />
          ) : (
            providers.map((p) =>
              editingProvider === p.id ? (
                <ProviderForm
                  key={p.id}
                  initial={p}
                  services={services}
                  busy={busy === 'provider'}
                  onSave={(input) => run('provider', () => ProvidersApi.updateProvider(p.id, input), 'Provider updated.')}
                  onCancel={() => setEditingProvider(null)}
                />
              ) : (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-4 rounded-xl border border-line/70 bg-white px-4 py-3 shadow-input"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-ink">
                        {p.title ? `${p.title} ${p.name}` : p.name}
                      </p>
                      {!p.active && (
                        <Badge tone="neutral" dot>
                          Inactive
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {p.serviceIds.length === 0 ? (
                        <span className="text-xs text-ink-muted">All services</span>
                      ) : (
                        p.serviceIds.map((sid) => {
                          const s = services.find((x) => x.id === sid);
                          return s ? <Chip key={sid}>{s.name}</Chip> : null;
                        })
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditingProvider(p.id)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busy === `del-p-${p.id}`}
                        onClick={() =>
                          window.confirm(`Remove ${p.name}? Their existing appointments are kept but unassigned.`) &&
                          run(`del-p-${p.id}`, () => ProvidersApi.deleteProvider(p.id), 'Provider removed.')
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </div>
              ),
            )
          )}
        </div>
      </Card>

      {/* Services */}
      <Card>
        <CardHeader
          title="Services"
          description="Appointment types — each sets its own length and which providers can do it."
          action={
            canEdit && editingService !== 'new' ? (
              <Button size="sm" variant="secondary" onClick={() => setEditingService('new')}>
                Add service
              </Button>
            ) : undefined
          }
        />
        <div className="flex flex-col gap-2.5">
          {editingService === 'new' && (
            <ServiceForm
              providers={providers}
              busy={busy === 'service'}
              onSave={(input) => run('service', () => ProvidersApi.createService(input), 'Service added.')}
              onCancel={() => setEditingService(null)}
            />
          )}

          {services.length === 0 && editingService !== 'new' ? (
            <EmptyState
              title="No services yet"
              description="Optional — add services like “Cleaning” or “Consultation” to set durations and route by visit type."
            />
          ) : (
            services.map((s) =>
              editingService === s.id ? (
                <ServiceForm
                  key={s.id}
                  initial={s}
                  providers={providers}
                  busy={busy === 'service'}
                  onSave={(input) => run('service', () => ProvidersApi.updateService(s.id, input), 'Service updated.')}
                  onCancel={() => setEditingService(null)}
                />
              ) : (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-4 rounded-xl border border-line/70 bg-white px-4 py-3 shadow-input"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-ink">{s.name}</p>
                      <Badge tone="signal">{s.durationMinutes} min</Badge>
                      {!s.active && (
                        <Badge tone="neutral" dot>
                          Inactive
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {s.providerIds.length === 0 ? (
                        <span className="text-xs text-ink-muted">Any provider</span>
                      ) : (
                        s.providerIds.map((pid) => <Chip key={pid}>{nameOf(pid)}</Chip>)
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditingService(s.id)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busy === `del-s-${s.id}`}
                        onClick={() =>
                          window.confirm(`Remove the ${s.name} service?`) &&
                          run(`del-s-${s.id}`, () => ProvidersApi.deleteService(s.id), 'Service removed.')
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </div>
              ),
            )
          )}
        </div>
      </Card>
    </div>
  );
}
