'use client';

import { useState } from 'react';
import { INDUSTRY_TEMPLATES } from '@/domain/prompt-templates';
import {
  AgentApi,
  ApiError,
  OnboardingApi,
  type AgentSettingsDto,
  type Industry,
  type OnboardingView,
} from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';

const MIN_PROMPT = 40;
const MAX_PROMPT = 6000;

export function StepPrompt({
  settings,
  industry,
  companyName,
  onCompleted,
  onError,
}: {
  settings: AgentSettingsDto;
  industry: Industry;
  companyName: string;
  onCompleted: (view: OnboardingView, settings: AgentSettingsDto) => void;
  onError: (message: string) => void;
}) {
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [voicemailGreeting, setVoicemailGreeting] = useState(settings.voicemailGreeting);
  const [errors, setErrors] = useState<{ systemPrompt?: string; voicemailGreeting?: string }>({});
  const [saving, setSaving] = useState(false);
  // The raw call script is hidden by default — most owners never need to touch
  // it. Reveal it only if they choose to fine-tune, so the step isn't intimidating.
  const [showScript, setShowScript] = useState(false);

  const template = INDUSTRY_TEMPLATES[industry];
  const count = systemPrompt.length;
  const counterTone = count < MIN_PROMPT || count > MAX_PROMPT ? 'text-danger' : 'text-ink-muted';

  function applyTemplate() {
    const built = template.build({ companyName, personaName: settings.displayName });
    setSystemPrompt(built.systemPrompt);
    setVoicemailGreeting(built.voicemailGreeting);
    setErrors({});
  }

  async function save() {
    const nextErrors: typeof errors = {};
    if (systemPrompt.trim().length < MIN_PROMPT) {
      nextErrors.systemPrompt = `Instructions need at least ${MIN_PROMPT} characters so the receptionist has enough to work with.`;
    } else if (systemPrompt.length > MAX_PROMPT) {
      nextErrors.systemPrompt = `Instructions can be at most ${MAX_PROMPT.toLocaleString()} characters.`;
    }
    if (voicemailGreeting.trim().length < 4) {
      nextErrors.voicemailGreeting = 'Add a short voicemail greeting.';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      const updated = await AgentApi.update({
        systemPrompt: systemPrompt.trim(),
        voicemailGreeting: voicemailGreeting.trim(),
      });
      const { onboarding } = await OnboardingApi.completeStep('PROMPT');
      onCompleted(onboarding, updated.settings);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not save the instructions. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-ink">How it handles your calls</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Your receptionist is already trained for your {template.title.toLowerCase()}. Here&apos;s what it does on
          every call — leave it as-is, or fine-tune it below.
        </p>
      </div>

      <div className="rounded-2xl border border-line bg-paper/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink">{template.title} template</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {template.bullets.map((bullet) => (
                <li key={bullet} className="text-xs text-ink-muted">
                  · {bullet}
                </li>
              ))}
            </ul>
          </div>
          <Button variant="secondary" size="sm" onClick={applyTemplate}>
            Re-apply template
          </Button>
        </div>
      </div>

      {showScript ? (
        <Textarea
          label="Call script"
          rows={14}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          error={errors.systemPrompt}
          hint="Plain English — write it the way you'd brief a new front-desk hire."
          className="font-mono text-sm"
          trailing={
            <span className={`font-mono text-xs ${counterTone}`}>
              {count.toLocaleString()} / {MAX_PROMPT.toLocaleString()}
            </span>
          }
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowScript(true)}
          className="self-start text-sm font-medium text-signal-deep underline-offset-2 transition-colors hover:underline"
        >
          Fine-tune the call script (optional) →
        </button>
      )}

      <Textarea
        label="Voicemail greeting"
        rows={4}
        value={voicemailGreeting}
        onChange={(e) => setVoicemailGreeting(e.target.value)}
        error={errors.voicemailGreeting}
        hint="Played when a caller is sent to voicemail."
      />

      <div className="flex justify-end border-t border-line pt-5">
        <Button size="lg" loading={saving} onClick={save}>
          Looks good →
        </Button>
      </div>
    </div>
  );
}
