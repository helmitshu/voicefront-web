'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/Toast';
import { AgentApi, ApiError, type AgentSettingsDto, type OnboardingView } from '@/lib/api';
import { ProgressSteps, type StepDescriptor } from '@/components/ui/ProgressSteps';
import { FullScreenLoader } from '@/components/ui/Spinner';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { TipCard } from '@/components/onboarding/TipCard';
import { StepProfile } from '@/components/onboarding/StepProfile';
import { StepPrompt } from '@/components/onboarding/StepPrompt';
import { StepVoiceTest } from '@/components/onboarding/StepVoiceTest';

const STEPS: StepDescriptor[] = [
  { key: 'PROFILE', title: 'Business profile', description: 'Name, greeting, and hours' },
  { key: 'PROMPT', title: 'Call handling', description: 'Instructions and voicemail' },
  { key: 'VOICE_TEST', title: 'Test & go live', description: 'Talk to your receptionist' },
];

function completedCount(view: OnboardingView): number {
  if (!view.hasConfiguredProfile) return 0;
  if (!view.hasConfiguredPrompt) return 1;
  if (!view.hasTestedVoice) return 2;
  return 3;
}

export default function OnboardingPage() {
  const { me, setOnboarding } = useAuth();
  const { toast } = useToast();
  const router = useRouter();

  const [settings, setSettings] = useState<AgentSettingsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [index, setIndex] = useState<number | null>(null);

  // Load the tenant's current settings once; steps edit local copies.
  useEffect(() => {
    let cancelled = false;
    AgentApi.get()
      .then(({ settings: loaded }) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : 'Could not load your setup. Please refresh.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const done = me ? completedCount(me.onboarding) : 0;
  const currentIndex = index ?? Math.min(done, STEPS.length - 1);

  const progressLabel = useMemo(() => {
    if (!me) return '';
    return me.onboarding.progressPercent === 100
      ? 'Setup complete — ready to activate'
      : `${me.onboarding.progressPercent}% set up`;
  }, [me]);

  if (!me) return <FullScreenLoader />;

  function advance(view: OnboardingView, updated?: AgentSettingsDto) {
    setOnboarding(view);
    if (updated) setSettings(updated);
    setIndex(Math.min(completedCount(view), STEPS.length - 1));
  }

  const step = STEPS[currentIndex];

  return (
    <div className="animate-fade-up">
      <div className="mb-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
          Let&apos;s get {me.tenant.companyName} answering calls
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">{progressLabel}</p>
      </div>

      <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
        <div className="flex flex-col gap-6">
          <ProgressSteps
            steps={STEPS}
            currentIndex={currentIndex}
            completedCount={done}
            onSelect={setIndex}
          />
          <TipCard industry={me.tenant.industry} step={step.key as 'PROFILE' | 'PROMPT' | 'VOICE_TEST'} />
        </div>

        <Card className="min-h-[420px]">
          {loadError ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-danger">{loadError}</p>
              <Button variant="secondary" onClick={() => window.location.reload()}>
                Reload
              </Button>
            </div>
          ) : !settings ? (
            <div className="flex h-64 items-center justify-center">
              <FullScreenLoaderInline />
            </div>
          ) : step.key === 'PROFILE' ? (
            <StepProfile
              settings={settings}
              onCompleted={advance}
              onError={(message) => toast(message, 'error')}
            />
          ) : step.key === 'PROMPT' ? (
            <StepPrompt
              settings={settings}
              industry={me.tenant.industry}
              companyName={me.tenant.companyName}
              onCompleted={advance}
              onError={(message) => toast(message, 'error')}
            />
          ) : (
            <StepVoiceTest
              tested={me.onboarding.hasTestedVoice}
              personaName={settings.displayName}
              onTested={(view) => {
                setOnboarding(view);
                toast('Voice test recorded — you can activate whenever you’re ready.', 'success');
              }}
              onActivated={(view) => {
                setOnboarding(view);
                toast('Your receptionist is live!', 'success');
                router.replace('/dashboard');
              }}
              onError={(message) => toast(message, 'error')}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

function FullScreenLoaderInline() {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-signal border-t-transparent"
    />
  );
}
