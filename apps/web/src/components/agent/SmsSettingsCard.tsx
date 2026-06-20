'use client';

import { useEffect, useState } from 'react';
import { ApiError, SmsApi, type SmsSettings } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/lib/auth-context';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Toggle';
import { Spinner } from '@/components/ui/Spinner';

const DEFAULT_TEMPLATES = {
  confirmationTemplate:
    'Hi {customerName}, your appointment at {businessName} is confirmed for {date} at {time}. Reply STOP to opt out.',
  reminder24hTemplate:
    'Reminder: You have an appointment at {businessName} tomorrow at {time}. Reply STOP to unsubscribe.',
  reminder1hTemplate:
    'Your {businessName} appointment starts in 1 hour ({time}). Reply STOP to unsubscribe.',
  waitlistTemplate:
    'Good news {customerName} — a spot just opened at {businessName} on {date} at {time}. Call us back to grab it before someone else does. Reply STOP to opt out.',
};

const VARIABLE_CHIPS = ['{customerName}', '{businessName}', '{date}', '{time}'];

type TemplateKey = 'confirmationTemplate' | 'reminder24hTemplate' | 'reminder1hTemplate' | 'waitlistTemplate';

interface TemplateSectionProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
  defaultValue: string;
  onReset: () => void;
}

function TemplateSection({ label, value, onChange, readOnly, defaultValue, onReset }: TemplateSectionProps) {
  const charCount = value.length;
  const isDefault = value === defaultValue;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">{label}</p>
        {!isDefault && !readOnly && (
          <button
            type="button"
            onClick={onReset}
            className="text-[11px] text-signal hover:underline"
          >
            Reset to default
          </button>
        )}
      </div>
      <textarea
        className="min-h-[72px] resize-y rounded-lg border border-line/70 bg-paper/60 px-3 py-2 text-sm text-ink placeholder-ink-muted/50 shadow-input focus:border-signal/60 focus:outline-none focus:ring-2 focus:ring-signal/20 disabled:cursor-not-allowed disabled:opacity-50"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={readOnly}
        maxLength={320}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {VARIABLE_CHIPS.map((v) => (
            <span
              key={v}
              className="rounded-md bg-signal-soft/60 px-2 py-0.5 font-mono text-[11px] text-signal-deep"
            >
              {v}
            </span>
          ))}
        </div>
        <span className={`text-[11px] tabular-nums ${charCount > 300 ? 'text-danger' : 'text-ink-muted/60'}`}>
          {charCount}/320
        </span>
      </div>
    </div>
  );
}

export function SmsSettingsCard() {
  const { me } = useAuth();
  const { toast } = useToast();
  const readOnly = me?.user.role === 'AGENT';

  const [available, setAvailable] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<SmsSettings | null>(null);
  const [draft, setDraft] = useState<SmsSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  useEffect(() => {
    SmsApi.getSettings()
      .then(({ available: a, settings: s }) => {
        setAvailable(a);
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
          title="SMS Notifications"
          description="Automatic texts to customers when they book or have an upcoming appointment."
        />
        <p className="mt-3 rounded-xl border border-dashed border-line bg-paper/60 px-4 py-4 text-sm text-ink-muted">
          SMS is not yet configured on this platform. The operator needs to add Twilio credentials to enable this feature.
        </p>
      </Card>
    );
  }

  if (!draft) return null;

  const dirty = JSON.stringify(settings) !== JSON.stringify(draft);

  function patch(updates: Partial<SmsSettings>) {
    setDraft((d) => (d ? { ...d, ...updates } : d));
  }

  function resetTemplate(key: TemplateKey) {
    patch({ [key]: DEFAULT_TEMPLATES[key] });
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await SmsApi.updateSettings(draft);
      setSettings(draft);
      toast('SMS settings saved.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save SMS settings.', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="SMS Notifications"
        description="Automatic texts to customers after booking and before their appointment."
      />

      <div className="mt-5 flex flex-col gap-5">
        {/* Master toggle */}
        <div className="flex items-center justify-between gap-4 rounded-xl border border-line/60 bg-paper/60 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-ink">Enable SMS</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              Customers with a phone number on file will receive texts.
            </p>
          </div>
          <Toggle
            checked={draft.enabled}
            onChange={(v) => patch({ enabled: v })}
            disabled={readOnly}
          />
        </div>

        {draft.enabled && (
          <>
            {/* Sub-toggles */}
            <div className="flex flex-col gap-3 rounded-xl border border-line/60 bg-paper/40 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                When to send
              </p>
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-ink">Booking confirmation</p>
                    <p className="text-xs text-ink-muted">Sent immediately after an appointment is booked.</p>
                  </div>
                  <Toggle
                    checked={draft.confirmation}
                    onChange={(v) => patch({ confirmation: v })}
                    disabled={readOnly}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-ink">24-hour reminder</p>
                    <p className="text-xs text-ink-muted">Sent the day before the appointment.</p>
                  </div>
                  <Toggle
                    checked={draft.reminder24h}
                    onChange={(v) => patch({ reminder24h: v })}
                    disabled={readOnly}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-ink">1-hour reminder</p>
                    <p className="text-xs text-ink-muted">Sent an hour before for last-minute prep.</p>
                  </div>
                  <Toggle
                    checked={draft.reminder1h}
                    onChange={(v) => patch({ reminder1h: v })}
                    disabled={readOnly}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-ink">Waitlist opening alert</p>
                    <p className="text-xs text-ink-muted">When a cancellation frees a slot, text the next person waiting.</p>
                  </div>
                  <Toggle
                    checked={draft.waitlist}
                    onChange={(v) => patch({ waitlist: v })}
                    disabled={readOnly}
                  />
                </div>
              </div>
            </div>

            {/* Message templates */}
            <div>
              <button
                type="button"
                onClick={() => setShowTemplates((s) => !s)}
                className="flex items-center gap-2 text-sm font-semibold text-signal hover:text-signal-deep"
              >
                <span>{showTemplates ? '▾' : '▸'}</span>
                Customize message templates
              </button>

              {showTemplates && (
                <div className="mt-4 flex flex-col gap-5 rounded-xl border border-line/60 bg-paper/40 p-4">
                  <p className="text-xs text-ink-muted">
                    Use{' '}
                    {VARIABLE_CHIPS.map((v, i) => (
                      <span key={v}>
                        <span className="rounded bg-signal-soft/60 px-1 font-mono text-[11px] text-signal-deep">{v}</span>
                        {i < VARIABLE_CHIPS.length - 1 ? ', ' : ''}
                      </span>
                    ))}{' '}
                    as placeholders. Max 320 characters (one SMS segment).
                  </p>

                  {draft.confirmation && (
                    <TemplateSection
                      label="Booking confirmation"
                      value={draft.confirmationTemplate}
                      onChange={(v) => patch({ confirmationTemplate: v })}
                      readOnly={readOnly}
                      defaultValue={DEFAULT_TEMPLATES.confirmationTemplate}
                      onReset={() => resetTemplate('confirmationTemplate')}
                    />
                  )}
                  {draft.reminder24h && (
                    <TemplateSection
                      label="24-hour reminder"
                      value={draft.reminder24hTemplate}
                      onChange={(v) => patch({ reminder24hTemplate: v })}
                      readOnly={readOnly}
                      defaultValue={DEFAULT_TEMPLATES.reminder24hTemplate}
                      onReset={() => resetTemplate('reminder24hTemplate')}
                    />
                  )}
                  {draft.reminder1h && (
                    <TemplateSection
                      label="1-hour reminder"
                      value={draft.reminder1hTemplate}
                      onChange={(v) => patch({ reminder1hTemplate: v })}
                      readOnly={readOnly}
                      defaultValue={DEFAULT_TEMPLATES.reminder1hTemplate}
                      onReset={() => resetTemplate('reminder1hTemplate')}
                    />
                  )}
                  {draft.waitlist && (
                    <TemplateSection
                      label="Waitlist opening alert"
                      value={draft.waitlistTemplate}
                      onChange={(v) => patch({ waitlistTemplate: v })}
                      readOnly={readOnly}
                      defaultValue={DEFAULT_TEMPLATES.waitlistTemplate}
                      onReset={() => resetTemplate('waitlistTemplate')}
                    />
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* Save / discard */}
        {!readOnly && dirty && (
          <div className="flex justify-end gap-2 border-t border-line/60 pt-4">
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => setDraft(settings)}
            >
              Discard
            </Button>
            <Button size="sm" loading={saving} onClick={save}>
              Save SMS settings
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
