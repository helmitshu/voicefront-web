'use client';

import { useState } from 'react';
import { TIMEZONE_OPTIONS, timezoneShortLabel, type BusinessHours } from '@/domain/agent-config';
import { AgentApi, ApiError, OnboardingApi, type AgentSettingsDto, type OnboardingView } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { BusinessHoursEditor } from '@/components/agent/BusinessHoursEditor';

export function StepProfile({
  settings,
  onCompleted,
  onError,
}: {
  settings: AgentSettingsDto;
  onCompleted: (view: OnboardingView, settings: AgentSettingsDto) => void;
  onError: (message: string) => void;
}) {
  const [displayName, setDisplayName] = useState(settings.displayName);
  const [firstMessage, setFirstMessage] = useState(settings.firstMessage);
  // Pre-select the browser's timezone on first setup so the owner doesn't hunt
  // for it. Only override the platform default — never an explicit prior choice.
  const [timezone, setTimezone] = useState(() => {
    if (settings.timezone !== 'America/New_York') return settings.timezone;
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || settings.timezone;
    } catch {
      return settings.timezone;
    }
  });
  const [hours, setHours] = useState<BusinessHours>(settings.businessHours);
  const [errors, setErrors] = useState<{ displayName?: string; firstMessage?: string }>({});
  const [saving, setSaving] = useState(false);

  // Keep the saved timezone selectable even if it's not in the curated list.
  const timezones = TIMEZONE_OPTIONS.includes(timezone as (typeof TIMEZONE_OPTIONS)[number])
    ? TIMEZONE_OPTIONS
    : ([timezone, ...TIMEZONE_OPTIONS] as readonly string[]);

  async function save() {
    const nextErrors: typeof errors = {};
    if (displayName.trim().length < 2) nextErrors.displayName = 'Give your receptionist a name.';
    if (firstMessage.trim().length < 4) nextErrors.firstMessage = 'Add a short greeting callers will hear first.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      const updated = await AgentApi.update({
        displayName: displayName.trim(),
        firstMessage: firstMessage.trim(),
        timezone,
        businessHours: hours,
      });
      const { onboarding } = await OnboardingApi.completeStep('PROFILE');
      onCompleted(onboarding, updated.settings);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not save your profile. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-ink">Quick check — these look right?</h2>
        <p className="mt-1 text-sm text-ink-muted">
          We&apos;ve pre-filled the basics for you. Tweak anything that&apos;s off, or just continue.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          label="Receptionist name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={errors.displayName}
          hint="Callers will hear this name."
          placeholder="Maya"
        />
        <Select label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {timezones.map((tz) => (
            <option key={tz} value={tz}>
              {timezoneShortLabel(tz)} — {tz}
            </option>
          ))}
        </Select>
      </div>

      <Input
        label="Greeting"
        value={firstMessage}
        onChange={(e) => setFirstMessage(e.target.value)}
        error={errors.firstMessage}
        hint="The first sentence on every call."
      />

      <div>
        <p className="mb-2 text-sm font-medium text-ink">Business hours</p>
        <BusinessHoursEditor value={hours} onChange={setHours} />
        <p className="mt-2 text-xs text-ink-muted">
          Outside these hours the receptionist still answers — it lets callers know you&apos;re closed and takes a
          message.
        </p>
      </div>

      <div className="flex justify-end border-t border-line pt-5">
        <Button size="lg" loading={saving} onClick={save}>
          Looks good →
        </Button>
      </div>
    </div>
  );
}
