'use client';

import { useEffect, useState } from 'react';
import { ApiError, ReactivationApi, type ReactivationSettings } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/lib/auth-context';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Toggle';
import { Spinner } from '@/components/ui/Spinner';

const DEFAULT_TEMPLATE =
  "Hi {customerName}, it's been a while since your last visit to {businessName}. We'd love to see you again — call us to book a time that works for you. Reply STOP to opt out.";

const VARIABLE_CHIPS = ['{customerName}', '{businessName}'];

const INACTIVITY_PRESETS = [
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
];

export function ReactivationSettingsCard() {
  const { me } = useAuth();
  const { toast } = useToast();
  const readOnly = me?.user.role === 'AGENT';

  const [available, setAvailable] = useState<boolean | null>(null);
  const [eligibleCount, setEligibleCount] = useState(0);
  const [settings, setSettings] = useState<ReactivationSettings | null>(null);
  const [draft, setDraft] = useState<ReactivationSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    ReactivationApi.getSettings()
      .then(({ available: a, eligibleCount: n, settings: s }) => {
        setAvailable(a);
        setEligibleCount(n);
        setSettings(s);
        setDraft(s);
      })
      .catch(() => setAvailable(false));
  }, []);

  if (available === null) {
    return (
      <Card>
        <div className="flex h-16 items-center justify-center">
          <Spinner className="h-5 w-5 text-signal" />
        </div>
      </Card>
    );
  }

  if (!available) {
    return (
      <Card>
        <CardHeader
          title="Win-back campaigns"
          description="Automatically text customers you haven't seen in a while to bring them back in."
        />
        <p className="mt-3 rounded-xl border border-dashed border-line bg-paper/60 px-4 py-4 text-sm text-ink-muted">
          This runs on SMS, which isn't configured on this platform yet. The operator needs to add Twilio credentials to enable it.
        </p>
      </Card>
    );
  }

  if (!draft) return null;

  const dirty = JSON.stringify(settings) !== JSON.stringify(draft);
  const charCount = draft.template.length;
  const isDefaultTemplate = draft.template === DEFAULT_TEMPLATE;

  function patch(updates: Partial<ReactivationSettings>) {
    setDraft((d) => (d ? { ...d, ...updates } : d));
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await ReactivationApi.updateSettings(draft);
      setSettings(draft);
      toast('Win-back settings saved.', 'success');
      // Refresh the eligible count — changing the window changes who's due.
      ReactivationApi.getSettings().then(({ eligibleCount: n }) => setEligibleCount(n)).catch(() => {});
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save.', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Win-back campaigns"
        description="Once a day, lapsed customers get a friendly text inviting them to rebook — hands-free recurring revenue."
      />

      <div className="mt-5 flex flex-col gap-5">
        {/* Master toggle */}
        <div className="flex items-center justify-between gap-4 rounded-xl border border-line/60 bg-paper/60 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-ink">Enable win-back texts</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              Each customer is contacted at most once per lapse — never on a loop.
            </p>
          </div>
          <Toggle checked={draft.enabled} onChange={(v) => patch({ enabled: v })} disabled={readOnly} />
        </div>

        {draft.enabled && (
          <>
            {/* Inactivity window */}
            <div className="flex flex-col gap-2.5 rounded-xl border border-line/60 bg-paper/40 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                Reach out after a customer hasn&apos;t visited for
              </p>
              <div className="flex flex-wrap gap-2">
                {INACTIVITY_PRESETS.map((p) => (
                  <button
                    key={p.days}
                    type="button"
                    disabled={readOnly}
                    onClick={() => patch({ inactivityDays: p.days })}
                    aria-pressed={draft.inactivityDays === p.days}
                    className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-all disabled:opacity-50 ${
                      draft.inactivityDays === p.days
                        ? 'bg-signal-soft/70 text-signal-deep ring-1 ring-inset ring-signal/25'
                        : 'bg-white text-ink-muted ring-1 ring-inset ring-ink/8 hover:text-ink'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Eligible preview */}
            <div className="flex items-center gap-3 rounded-xl border border-signal/15 bg-signal-soft/30 px-4 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-signal-deep ring-1 ring-inset ring-signal/15">
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
                  <circle cx="8" cy="6.5" r="3" />
                  <path d="M2.5 16c0-3 2.5-5 5.5-5s5.5 2 5.5 5M14 7l2 2 3-3.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <p className="text-sm text-ink">
                <span className="font-semibold text-signal-deep">{eligibleCount}</span>{' '}
                {eligibleCount === 1 ? 'customer is' : 'customers are'} due to hear from you right now.
              </p>
            </div>

            {/* Template */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">Message</p>
                {!isDefaultTemplate && !readOnly && (
                  <button
                    type="button"
                    onClick={() => patch({ template: DEFAULT_TEMPLATE })}
                    className="text-[11px] text-signal hover:underline"
                  >
                    Reset to default
                  </button>
                )}
              </div>
              <textarea
                className="min-h-[80px] resize-y rounded-lg border border-line/70 bg-paper/60 px-3 py-2 text-sm text-ink placeholder-ink-muted/50 shadow-input focus:border-signal/60 focus:outline-none focus:ring-2 focus:ring-signal/20 disabled:cursor-not-allowed disabled:opacity-50"
                value={draft.template}
                onChange={(e) => patch({ template: e.target.value })}
                disabled={readOnly}
                maxLength={320}
              />
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {VARIABLE_CHIPS.map((v) => (
                    <span key={v} className="rounded-md bg-signal-soft/60 px-2 py-0.5 font-mono text-[11px] text-signal-deep">
                      {v}
                    </span>
                  ))}
                </div>
                <span className={`text-[11px] tabular-nums ${charCount > 300 ? 'text-danger' : 'text-ink-muted/60'}`}>
                  {charCount}/320
                </span>
              </div>
            </div>
          </>
        )}

        {/* Save / discard */}
        {!readOnly && dirty && (
          <div className="flex justify-end gap-2 border-t border-line/60 pt-4">
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(settings)}>
              Discard
            </Button>
            <Button size="sm" loading={saving} onClick={save}>
              Save win-back settings
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
