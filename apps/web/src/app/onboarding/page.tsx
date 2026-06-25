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

// Order matters: lead with the test call (the "aha"), then the quick config.
const STEPS: StepDescriptor[] = [
  { key: 'VOICE_TEST', title: 'Hear it live', description: 'Talk to your receptionist' },
  { key: 'PROFILE', title: 'Quick check', description: 'Name, hours, greeting' },
  { key: 'PROMPT', title: 'Fine-tune', description: 'How it handles your calls' },
];

function completedCount(view: OnboardingView): number {
  if (!view.hasTestedVoice) return 0;
  if (!view.hasConfiguredProfile) return 1;
  if (!view.hasConfiguredPrompt) return 2;
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
  // When everything's done, land on the test step (step 0) — that's where the
  // "go live" panel lives — rather than the last config step.
  const currentIndex = index ?? (done >= STEPS.length ? 0 : Math.min(done, STEPS.length - 1));

  const progressLabel = useMemo(() => {
    if (!me) return '';
    return me.onboarding.progressPercent === 100
      ? 'Setup complete — ready to activate'
      : `${me.onboarding.progressPercent}% set up`;
  }, [me]);

  if (!me) return <FullScreenLoader />;

  // Called when a config step saves: record it, then move to the next step by
  // POSITION (not by completedCount, which is order-dependent and would jump the
  // user around when steps are done out of order). Once all three are done, go
  // back to the test step where "Go live" waits.
  function advance(view: OnboardingView, updated?: AgentSettingsDto) {
    setOnboarding(view);
    if (updated) setSettings(updated);
    const allDone = view.hasTestedVoice && view.hasConfiguredProfile && view.hasConfiguredPrompt;
    setIndex(allDone ? 0 : Math.min((index ?? currentIndex) + 1, STEPS.length - 1));
  }

  // Manual navigation — the user moves between steps themselves (no auto-jumps).
  const goTo = (i: number) => setIndex(Math.max(0, Math.min(i, STEPS.length - 1)));

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
          {currentIndex > 0 && !loadError && settings && (
            <button
              type="button"
              onClick={() => goTo(currentIndex - 1)}
              className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
            >
              <span aria-hidden>←</span> Back
            </button>
          )}
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
              canGoLive={
                me.onboarding.hasTestedVoice &&
                me.onboarding.hasConfiguredProfile &&
                me.onboarding.hasConfiguredPrompt
              }
              personaName={settings.displayName}
              initialVoiceId={settings.voiceId}
              onContinue={() => goTo(currentIndex + 1)}
              onTested={(view) => {
                // Record the test only — the user advances manually with Continue.
                setOnboarding(view);
                toast('Nice — test recorded. Continue when you’re ready.', 'success');
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
