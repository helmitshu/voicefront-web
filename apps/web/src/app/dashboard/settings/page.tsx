'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/Toast';
import {
  AgentApi,
  ApiError,
  type AgentSettingsDto,
  type AgentSettingsPatch,
} from '@/lib/api';
import { TIMEZONE_OPTIONS, timezoneShortLabel, type BusinessHours, type ForwardingNumber } from '@/domain/agent-config';
import { INDUSTRY_TEMPLATES } from '@/domain/prompt-templates';
import {
  BACKGROUND_SOUND_OPTIONS,
  ELEVENLABS_PRESETS,
  VAPI_VOICES,
  VOICE_PROVIDER_OPTIONS,
  isPresetElevenLabsVoice,
  sampleUrlFor,
} from '@/domain/voice-catalog';
import { Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { VoicePreviewButton } from '@/components/agent/VoicePreviewButton';
import { DocumentsEditor } from '@/components/agent/DocumentsEditor';
import { SmsSettingsCard } from '@/components/agent/SmsSettingsCard';
import { ReactivationSettingsCard } from '@/components/agent/ReactivationSettingsCard';
import { CalendarConnectionsCard } from '@/components/agent/CalendarConnectionsCard';
import { BusinessHoursEditor } from '@/components/agent/BusinessHoursEditor';
import {
  ForwardingNumbersEditor,
  validateForwardingNumbers,
} from '@/components/agent/ForwardingNumbersEditor';
import { formatPhone } from '@/lib/format';

interface Draft {
  displayName: string;
  firstMessage: string;
  systemPrompt: string;
  voicemailGreeting: string;
  timezone: string;
  businessHours: BusinessHours;
  forwardingNumbers: ForwardingNumber[];
  voiceProvider: string;
  voiceId: string;
  backgroundSound: string;
  /** Editable as a string; '' means "no number assigned" (null). */
  inboundPhoneNumber: string;
}

function toDraft(settings: AgentSettingsDto): Draft {
  return {
    displayName: settings.displayName,
    firstMessage: settings.firstMessage,
    systemPrompt: settings.systemPrompt,
    voicemailGreeting: settings.voicemailGreeting,
    timezone: settings.timezone,
    businessHours: settings.businessHours,
    forwardingNumbers: settings.forwardingNumbers,
    voiceProvider: settings.voiceProvider,
    voiceId: settings.voiceId,
    backgroundSound: settings.backgroundSound,
    inboundPhoneNumber: settings.inboundPhoneNumber ?? '',
  };
}

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export default function SettingsPage() {
  const { me } = useAuth();
  const { toast } = useToast();
  const readOnly = me?.user.role === 'AGENT';

  const [loaded, setLoaded] = useState<AgentSettingsDto | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof Draft, string>>>({});

  useEffect(() => {
    let cancelled = false;
    AgentApi.get()
      .then(({ settings }) => {
        if (cancelled) return;
        setLoaded(settings);
        setDraft(toDraft(settings));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : 'Could not load settings.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(() => {
    if (!loaded || !draft) return false;
    return JSON.stringify(toDraft(loaded)) !== JSON.stringify(draft);
  }, [loaded, draft]);

  const forwardingErrors = useMemo(
    () => (draft ? validateForwardingNumbers(draft.forwardingNumbers) : new Map<string, string>()),
    [draft],
  );

  function patchDraft(patch: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function applyTemplate() {
    if (!me || !draft) return;
    const built = INDUSTRY_TEMPLATES[me.tenant.industry].build({
      companyName: me.tenant.companyName,
      personaName: draft.displayName || 'Maya',
    });
    patchDraft({
      systemPrompt: built.systemPrompt,
      firstMessage: built.firstMessage,
      voicemailGreeting: built.voicemailGreeting,
    });
    toast('Template applied — review and save when ready.', 'info');
  }

  async function save() {
    if (!draft || !loaded) return;

    const nextErrors: typeof fieldErrors = {};
    if (draft.displayName.trim().length < 2) nextErrors.displayName = 'Give your receptionist a name.';
    if (draft.firstMessage.trim().length < 4) nextErrors.firstMessage = 'Add a short greeting.';
    if (draft.systemPrompt.trim().length < 40)
      nextErrors.systemPrompt = 'Instructions need at least 40 characters.';
    if (draft.systemPrompt.length > 6000) nextErrors.systemPrompt = 'Instructions can be at most 6,000 characters.';
    if (draft.voicemailGreeting.trim().length < 4) nextErrors.voicemailGreeting = 'Add a voicemail greeting.';
    if (draft.voiceId.trim().length === 0)
      nextErrors.voiceId = 'Pick a voice, or paste an ElevenLabs voice ID.';
    const normalizedNumber = draft.inboundPhoneNumber.replace(/[\s().-]/g, '');
    if (normalizedNumber.length > 0 && !E164_REGEX.test(normalizedNumber))
      nextErrors.inboundPhoneNumber = 'Use E.164 format, e.g. +15551234567.';
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || forwardingErrors.size > 0) {
      // Name the offending fields — they may be scrolled out of view, so a
      // generic "fix the highlighted fields" leaves people hunting.
      const labels: Record<string, string> = {
        displayName: 'Receptionist name',
        firstMessage: 'Greeting',
        systemPrompt: 'Call handling instructions',
        voicemailGreeting: 'Voicemail greeting',
        voiceId: 'Voice',
        inboundPhoneNumber: 'Phone number',
      };
      const bad = Object.keys(nextErrors).map((k) => labels[k] ?? k);
      if (forwardingErrors.size > 0) bad.push('Forwarding numbers (fill in or remove the empty row)');
      toast(`Fix these before saving: ${bad.join(', ')}.`, 'error');
      return;
    }

    const patch: AgentSettingsPatch = {
      displayName: draft.displayName.trim(),
      firstMessage: draft.firstMessage.trim(),
      systemPrompt: draft.systemPrompt.trim(),
      voicemailGreeting: draft.voicemailGreeting.trim(),
      timezone: draft.timezone,
      voiceProvider: draft.voiceProvider,
      voiceId: draft.voiceId.trim(),
      backgroundSound: draft.backgroundSound,
      inboundPhoneNumber: normalizedNumber.length > 0 ? normalizedNumber : null,
      businessHours: draft.businessHours,
      forwardingNumbers: draft.forwardingNumbers.map((entry) => ({
        ...entry,
        label: entry.label.trim(),
        number: entry.number.replace(/[\s().-]/g, ''),
        whenToUse: entry.whenToUse.trim(),
      })),
    };

    setSaving(true);
    try {
      const { settings, sync } = await AgentApi.update(patch);
      setLoaded(settings);
      setDraft(toDraft(settings));
      if (settings.assistantId) {
        if (sync?.synced) {
          toast('Saved and pushed to your voice agent — new calls use these settings.', 'success');
        } else {
          toast('Saved here.', 'success');
          if (sync?.reason) toast(sync.reason, 'info');
        }
      } else {
        toast('Saved — new calls use these settings immediately.', 'success');
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <EmptyState
        title="Couldn't load settings"
        description={loadError}
        action={
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Try again
          </Button>
        }
      />
    );
  }

  if (!draft || !loaded) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6 pb-24">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Receptionist</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            Changes apply to the very next call — no retraining, no waiting.
          </p>
        </div>
        {!readOnly && (
          <Button variant="secondary" size="sm" onClick={applyTemplate}>
            Re-apply {INDUSTRY_TEMPLATES[me?.tenant.industry ?? 'CLINIC'].title.toLowerCase()} template
          </Button>
        )}
      </div>

      {readOnly && (
        <p className="flex items-center gap-2.5 rounded-xl border border-construction/25 bg-construction-soft/50 px-4 py-3 text-sm text-[#9a6a1d]">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 shrink-0">
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
            <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
          </svg>
          You have view-only access. Ask an owner or manager to make changes.
        </p>
      )}

      {loaded.assistantId && (
        <p className="flex items-center gap-2.5 rounded-xl border border-clinic/20 bg-clinic-soft/50 px-4 py-3 text-sm text-[#0b8a74]">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute h-full w-full animate-pulse-ring rounded-full bg-clinic" />
            <span className="relative h-2 w-2 rounded-full bg-clinic" />
          </span>
          Connected to your voice agent. Saving here updates it automatically — changes apply to the next
          call.
        </p>
      )}

      <Card>
        <CardHeader title="Persona" description="Who answers, and the first thing callers hear." />
        <div className="grid gap-5 sm:grid-cols-2">
          <Input
            label="Receptionist name"
            value={draft.displayName}
            disabled={readOnly}
            onChange={(e) => patchDraft({ displayName: e.target.value })}
            error={fieldErrors.displayName}
          />
          <Select
            label="Timezone"
            value={draft.timezone}
            disabled={readOnly}
            onChange={(e) => patchDraft({ timezone: e.target.value })}
          >
            {(TIMEZONE_OPTIONS.includes(draft.timezone as (typeof TIMEZONE_OPTIONS)[number])
              ? TIMEZONE_OPTIONS
              : ([draft.timezone, ...TIMEZONE_OPTIONS] as readonly string[])
            ).map((tz) => (
              <option key={tz} value={tz}>
                {timezoneShortLabel(tz)} — {tz}
              </option>
            ))}
          </Select>
        </div>
        <div className="mt-5">
          <Input
            label="Greeting"
            value={draft.firstMessage}
            disabled={readOnly}
            onChange={(e) => patchDraft({ firstMessage: e.target.value })}
            error={fieldErrors.firstMessage}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Voice & sound"
          description="How your receptionist sounds on every call. Changes apply to the very next call."
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <Select
            label="Voice provider"
            value={draft.voiceProvider}
            disabled={readOnly}
            onChange={(e) => {
              const voiceProvider = e.target.value;
              // Reset to each provider's most human-sounding default.
              patchDraft({
                voiceProvider,
                voiceId: voiceProvider === '11labs' ? ELEVENLABS_PRESETS[0].id : 'Emma',
              });
            }}
          >
            {VOICE_PROVIDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>

          {draft.voiceProvider === '11labs' ? (
            <Select
              label="Voice"
              value={isPresetElevenLabsVoice(draft.voiceId) ? draft.voiceId : 'custom'}
              disabled={readOnly}
              onChange={(e) => patchDraft({ voiceId: e.target.value === 'custom' ? '' : e.target.value })}
            >
              {ELEVENLABS_PRESETS.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.label} — {voice.description}
                </option>
              ))}
              <option value="custom">Custom voice ID…</option>
            </Select>
          ) : (
            <Select
              label="Voice"
              value={draft.voiceId}
              disabled={readOnly}
              error={fieldErrors.voiceId}
              onChange={(e) => patchDraft({ voiceId: e.target.value })}
            >
              {VAPI_VOICES.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.label} — {voice.description}
                </option>
              ))}
            </Select>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <VoicePreviewButton
            sampleUrl={sampleUrlFor(draft.voiceProvider as 'vapi' | '11labs', draft.voiceId)}
            voiceLabel={
              VAPI_VOICES.find((v) => v.id === draft.voiceId)?.label ??
              ELEVENLABS_PRESETS.find((v) => v.id === draft.voiceId)?.label ??
              'this voice'
            }
          />
          {!sampleUrlFor(draft.voiceProvider as 'vapi' | '11labs', draft.voiceId) && (
            <span className="text-[13px] text-ink-muted">
              No preview for this voice — it’ll still work on calls.
            </span>
          )}
        </div>

        {draft.voiceProvider === '11labs' && !isPresetElevenLabsVoice(draft.voiceId) && (
          <div className="mt-5">
            <Input
              label="ElevenLabs voice ID"
              placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
              value={draft.voiceId}
              disabled={readOnly}
              onChange={(e) => patchDraft({ voiceId: e.target.value })}
              error={fieldErrors.voiceId}
              hint="Paste any voice ID from your ElevenLabs voice library — including cloned voices."
              className="font-mono text-sm"
            />
          </div>
        )}

        {draft.voiceProvider === '11labs' && (
          <p className="mt-4 rounded-xl border border-signal/15 bg-signal-soft/40 px-4 py-3 text-[13px] leading-relaxed text-signal-deep">
            ElevenLabs voices require your ElevenLabs API key to be connected in the voice platform&apos;s
            dashboard under <span className="font-semibold">Integrations</span>. Once connected, your whole
            voice library syncs automatically.
          </p>
        )}

        <div className="mt-5">
          <Select
            label="Background sound"
            value={draft.backgroundSound}
            disabled={readOnly}
            onChange={(e) => patchDraft({ backgroundSound: e.target.value })}
            hint={
              BACKGROUND_SOUND_OPTIONS.find((option) => option.value === draft.backgroundSound)?.description
            }
          >
            {BACKGROUND_SOUND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Call handling instructions"
          description="The receptionist's playbook for every conversation."
        />
        <Textarea
          rows={14}
          value={draft.systemPrompt}
          disabled={readOnly}
          onChange={(e) => patchDraft({ systemPrompt: e.target.value })}
          error={fieldErrors.systemPrompt}
          className="font-mono text-sm"
          trailing={
            <span className="font-mono text-xs text-ink-muted">
              {draft.systemPrompt.length.toLocaleString()} / 6,000
            </span>
          }
        />
      </Card>

      <Card>
        <CardHeader
          title="Knowledge documents"
          description="Upload files about your services, pricing, promotions, location, parking, or insurance. Your receptionist reads from them to answer callers' questions. Supports PDF, Word, TXT, CSV, Markdown, and more."
        />
        <DocumentsEditor disabled={readOnly} assistantConnected={Boolean(loaded.assistantId)} />
      </Card>

      <Card>
        <CardHeader title="Voicemail greeting" description="Played when callers are sent to voicemail." />
        <Textarea
          rows={4}
          value={draft.voicemailGreeting}
          disabled={readOnly}
          onChange={(e) => patchDraft({ voicemailGreeting: e.target.value })}
          error={fieldErrors.voicemailGreeting}
        />
      </Card>

      <Card>
        <CardHeader
          title="Business hours"
          description="Outside these hours, callers are told you're closed and offered voicemail."
        />
        <BusinessHoursEditor
          value={draft.businessHours}
          disabled={readOnly}
          onChange={(businessHours) => patchDraft({ businessHours })}
        />
      </Card>

      <Card>
        <CardHeader
          title="Live call transfer"
          description="When a caller needs a real person, the receptionist rings your line and briefs you on who's calling and why before connecting — a warm handoff, not a cold transfer. Numbers are never read aloud."
        />
        <ForwardingNumbersEditor
          value={draft.forwardingNumbers}
          disabled={readOnly}
          errors={forwardingErrors}
          onChange={(forwardingNumbers) => patchDraft({ forwardingNumbers })}
        />
      </Card>

      <Card>
        <CardHeader
          title="Your receptionist number"
          description="The phone number callers dial to reach your AI receptionist. Buy a number in the voice platform's dashboard, point its Server URL at this app's webhook, then paste it here."
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <Input
            label="Inbound number"
            placeholder="+15551234567"
            value={draft.inboundPhoneNumber}
            disabled={readOnly}
            onChange={(e) => patchDraft({ inboundPhoneNumber: e.target.value })}
            error={fieldErrors.inboundPhoneNumber}
            hint={
              loaded.inboundPhoneNumber
                ? `Currently live: ${formatPhone(loaded.inboundPhoneNumber)}`
                : 'No number assigned yet — inbound calls can’t reach this workspace until one is.'
            }
            className="font-mono"
          />
        </div>
      </Card>

      <CalendarConnectionsCard />

      <SmsSettingsCard />

      <ReactivationSettingsCard />

      {/* Floating save dock */}
      {!readOnly && (
        <div
          className={`fixed inset-x-4 bottom-4 z-40 transition-all duration-300 ${
            dirty ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-6 opacity-0'
          }`}
        >
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-4 rounded-2xl border border-line/70 bg-white/95 px-5 py-3 shadow-lift backdrop-blur-md">
            <p className="flex items-center gap-2.5 text-sm text-ink">
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-construction" />
              You have unsaved changes.
            </p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => setDraft(toDraft(loaded))}
              >
                Discard
              </Button>
              <Button loading={saving} onClick={save}>
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
