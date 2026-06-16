'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminApi, ApiError, type DemoCallRecord, type SalesConfig } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Card, Badge, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';

function fmtDuration(s: number): string {
  if (!s) return '—';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function AdminDemoPage() {
  const { toast } = useToast();
  const [config, setConfig] = useState<SalesConfig | null>(null);
  const [agentName, setAgentName] = useState('');
  const [founderName, setFounderName] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);

  const [calls, setCalls] = useState<DemoCallRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    AdminApi.salesConfig()
      .then((c) => {
        setConfig(c);
        setAgentName(c.agentName);
        setFounderName(c.founderName);
      })
      .catch(() => undefined);
    AdminApi.demoCalls()
      .then(({ calls }) => setCalls(calls))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load demo calls.'));
  }, []);

  useEffect(() => load(), [load]);

  async function saveConfig() {
    setSavingConfig(true);
    try {
      const c = await AdminApi.setSalesConfig({ agentName: agentName.trim(), founderName: founderName.trim() });
      setConfig(c);
      toast('Sales agent updated — live on the next demo call.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save.', 'error');
    } finally {
      setSavingConfig(false);
    }
  }

  async function toggleCalendar() {
    if (!config) return;
    const next = !config.showCalendar;
    try {
      const c = await AdminApi.setSalesConfig({ showCalendar: next });
      setConfig(c);
      toast(next ? 'Prospects will see the live calendar.' : 'The calendar is now hidden from prospects.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not change that.', 'error');
    }
  }

  const dirty = config && (agentName.trim() !== config.agentName || founderName.trim() !== config.founderName);

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Sales demo</h2>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
          Control the agent on your landing page and review how she did on every demo call — transcript,
          recording, and which lead she spoke to.
        </p>
      </div>

      {/* ---------------------------- agent identity ---------------------------- */}
      <Card>
        <h3 className="font-display text-[15px] font-semibold tracking-tight text-ink">Sales agent</h3>
        <p className="mt-1.5 text-sm text-ink-muted">
          The name prospects hear, and how she refers to you when she books the planning call.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Agent name</span>
            <div className="w-48">
              <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Ava" />
            </div>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Your name (the founder)</span>
            <div className="w-56">
              <Input value={founderName} onChange={(e) => setFounderName(e.target.value)} placeholder="our founder" />
            </div>
          </label>
          <Button size="sm" loading={savingConfig} disabled={!dirty} onClick={saveConfig}>
            Save
          </Button>
        </div>
      </Card>

      {/* ------------------------- calendar visibility ------------------------- */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="max-w-xl">
            <div className="flex items-center gap-2.5">
              <h3 className="font-display text-[15px] font-semibold tracking-tight text-ink">Live calendar on the demo</h3>
              {config && (config.showCalendar ? <Badge tone="signal" dot>Visible</Badge> : <Badge tone="warning" dot>Hidden</Badge>)}
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
              When on, prospects watch the sample calendar fill in as the agent books — proof it works. Turn it
              off to run a voice-only demo with no calendar on screen.
            </p>
          </div>
          <Button
            variant={config?.showCalendar ? 'secondary' : 'primary'}
            size="sm"
            disabled={!config}
            onClick={toggleCalendar}
          >
            {config?.showCalendar ? 'Hide calendar' : 'Show calendar'}
          </Button>
        </div>
      </Card>

      {/* ------------------------------ demo calls ------------------------------ */}
      <div>
        <h3 className="mb-3 font-display text-[15px] font-semibold tracking-tight text-ink">Recent demo calls</h3>
        {error ? (
          <EmptyState title="Couldn't load demo calls" description={error} />
        ) : !calls ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner className="h-6 w-6 text-signal" />
          </div>
        ) : calls.length === 0 ? (
          <EmptyState
            title="No demo calls yet"
            description="When someone talks to your sales agent on the landing page, the transcript and recording show up here."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {calls.map((c) => {
              const open = openId === c.id;
              return (
                <Card key={c.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : c.id)}
                    className="flex w-full items-center justify-between gap-3 text-left"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5">
                        <span className="font-display text-[15px] font-semibold text-ink">
                          {c.lead?.name ?? 'Anonymous visitor'}
                        </span>
                        {c.lead && <Badge tone="neutral">{c.lead.mode === 'call' ? 'Phone' : 'Web'}</Badge>}
                        <span className="text-xs text-ink-muted">{fmtWhen(c.createdAt)}</span>
                      </div>
                      {c.lead && (
                        <p className="mt-0.5 truncate text-[13px] text-ink-muted">
                          {c.lead.email} · {c.lead.phone}
                        </p>
                      )}
                      {c.summary && <p className="mt-1.5 line-clamp-2 text-[13px] text-ink">{c.summary}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="font-mono text-xs text-ink-muted">{fmtDuration(c.durationSeconds)}</span>
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        className={`h-4 w-4 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`}
                      >
                        <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  </button>

                  {open && (
                    <div className="mt-4 border-t border-line/60 pt-4">
                      {c.recordingUrl && (
                        <audio controls src={c.recordingUrl} className="mb-3 h-9 w-full max-w-md">
                          <track kind="captions" />
                        </audio>
                      )}
                      {c.transcript ? (
                        <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-xl bg-paper p-4 font-sans text-[13px] leading-relaxed text-ink ring-1 ring-inset ring-ink/5">
                          {c.transcript}
                        </pre>
                      ) : (
                        <p className="text-sm text-ink-muted">No transcript was captured for this call.</p>
                      )}
                      {c.endedReason && (
                        <p className="mt-2 text-xs text-ink-muted">Ended: {c.endedReason}</p>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
