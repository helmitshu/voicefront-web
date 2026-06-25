'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/Toast';
import { AgentApi, ApiError, OnboardingApi, type AgentSettingsDto, type OnboardingView } from '@/lib/api';
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
  const [activating, setActivating] = useState(false);

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
  // POSITION (not by completedCount, which is order-dependent). The "Go live"
  // action is a page-level bar that appears wherever the user finishes.
  function advance(view: OnboardingView, updated?: AgentSettingsDto) {
    setOnboarding(view);
    if (updated) setSettings(updated);
    toast('Saved ✓', 'success');
    setIndex(Math.min((index ?? currentIndex) + 1, STEPS.length - 1));
  }

  // Manual navigation — the user moves between steps themselves (no auto-jumps).
  const goTo = (i: number) => setIndex(Math.max(0, Math.min(i, STEPS.length - 1)));

  const ob = me.onboarding;
  const allDone = ob.hasTestedVoice && ob.hasConfiguredProfile && ob.hasConfiguredPrompt;
  // Whatever steps still aren't done, in order — so we can always tell the user
  // exactly what's left to go live (the backend requires all three). `goTo`
  // index matches the STEPS order: 0 test, 1 profile, 2 prompt.
  const incomplete = [
    !ob.hasTestedVoice ? { i: 0, label: 'Hear it live' } : null,
    !ob.hasConfiguredProfile ? { i: 1, label: 'Quick check' } : null,
    !ob.hasConfiguredPrompt ? { i: 2, label: 'Fine-tune' } : null,
  ].filter((x): x is { i: number; label: string } => x !== null);
  const anyDone = ob.hasTestedVoice || ob.hasConfiguredProfile || ob.hasConfiguredPrompt;

  async function activate() {
    setActivating(true);
    try {
      const { onboarding } = await OnboardingApi.activate();
      setOnboarding(onboarding);
      toast('Your receptionist is live!', 'success');
      router.replace('/dashboard');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not activate. Please try again.', 'error');
      setActivating(false);
    }
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
              personaName={settings.displayName}
              initialVoiceId={settings.voiceId}
              onContinue={() => goTo(currentIndex + 1)}
              onTested={(view) => {
                // Record the test only — the user advances manually with Continue.
                setOnboarding(view);
                toast('Nice — test recorded. Continue when you’re ready.', 'success');
              }}
              onError={(message) => toast(message, 'error')}
            />
          )}
        </Card>
      </div>

      {/* Page-level go-live — visible wherever you finish, not trapped on one step. */}
      {allDone && (
        <div className="mt-6 flex flex-col items-start gap-3 rounded-3xl border border-clinic/30 bg-clinic-soft p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-display text-lg font-semibold text-ink">Everything&apos;s ready ✓</p>
            <p className="mt-0.5 text-sm text-ink-muted">
              Flip the switch and {me.tenant.companyName} starts answering for real.
            </p>
          </div>
          <Button size="lg" loading={activating} onClick={activate}>
            Get my number &amp; go live
          </Button>
        </div>
      )}
      {!allDone && anyDone && incomplete.length > 0 && (
        <div className="mt-6 flex flex-col items-start gap-3 rounded-3xl border border-signal/25 bg-signal-soft/50 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-display text-lg font-semibold text-ink">
              {incomplete.length === 1 ? 'One step left to go live' : `${incomplete.length} steps left to go live`}
            </p>
            <p className="mt-0.5 text-sm text-ink-muted">
              Still to do: {incomplete.map((s) => s.label).join(', ')}.
            </p>
          </div>
          <Button size="lg" onClick={() => goTo(incomplete[0].i)}>
            {incomplete[0].label} →
          </Button>
        </div>
      )}
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
