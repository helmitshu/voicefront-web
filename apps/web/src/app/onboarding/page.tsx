'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/Toast';
import {
  AgentApi,
  ApiError,
  BillingApi,
  getStoredPlan,
  OnboardingApi,
  type AgentSettingsDto,
  type BillingStatus,
  type BillingTierChoice,
  type OnboardingView,
} from '@/lib/api';
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

/** Display facts for the two sellable tiers. The charged amount is always
 *  re-derived server-side from the workspace's locked pricing region; this
 *  table only mirrors the published prices. Growth is a waitlist and is
 *  never offered here. */
const PLAN_DISPLAY: Record<
  BillingTierChoice,
  { name: string; minutes: number; blurb: string; price: Record<'USD' | 'CAD', string> }
> = {
  STARTER: { name: 'Starter', minutes: 300, blurb: 'After-hours answering', price: { USD: '$299', CAD: '$399' } },
  CORE: { name: 'Core', minutes: 950, blurb: '24/7 answering', price: { USD: '$499', CAD: '$599' } },
};

const WHITE_GLOVE_PRICE: Record<'USD' | 'CAD', string> = { USD: '$500', CAD: '$600' };

function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

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

  // Billing (Build 2): the trial step after the setup steps. The plan
  // choice carried from pricing/register preselects the tier; Core is the
  // default hero when the visitor arrived without one.
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [billingLoaded, setBillingLoaded] = useState(false);
  const [tierChoice, setTierChoice] = useState<BillingTierChoice>(
    () => (getStoredPlan() === 'starter' ? 'STARTER' : 'CORE'),
  );
  const [whiteGlove, setWhiteGlove] = useState(false);
  const [startingCheckout, setStartingCheckout] = useState(false);
  const [checkoutNote, setCheckoutNote] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);
  const returnHandled = useRef(false);

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

  // Billing state on mount, including the Stripe return trip: success
  // completes the checkout server-side (the webhook is the backstop and
  // both paths converge), cancelled just re-arms the trial step.
  useEffect(() => {
    if (returnHandled.current) return;
    returnHandled.current = true;
    let cancelled = false;

    async function load() {
      const params = new URLSearchParams(window.location.search);
      const outcome = params.get('checkout');
      const sessionId = params.get('session_id');
      try {
        if (outcome === 'success' && sessionId) {
          const { billing: applied } = await BillingApi.complete(sessionId);
          if (!cancelled) {
            setBilling(applied);
            if (applied.tier) setTierChoice(applied.tier);
            setBillingLoaded(true);
          }
          window.history.replaceState(null, '', '/onboarding');
          return;
        }
        if (outcome === 'cancelled') {
          setCheckoutNote(
            "Checkout was cancelled, so your trial hasn't started yet. Start it whenever you're ready below.",
          );
          window.history.replaceState(null, '', '/onboarding');
        }
        const { billing: loaded } = await BillingApi.status();
        if (!cancelled) {
          setBilling(loaded);
          if (loaded.tier) setTierChoice(loaded.tier);
          setBillingLoaded(true);
        }
      } catch {
        // Billing state is an enhancement to this page; if it can't load,
        // the trial step simply stays hidden and activation answers for
        // itself (the server gate replies in plain words).
        if (!cancelled) setBillingLoaded(true);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function startCheckout() {
    setStartingCheckout(true);
    try {
      const { url } = await BillingApi.checkout({ tier: tierChoice, whiteGlove });
      window.location.href = url;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not start checkout. Please try again.', 'error');
      setStartingCheckout(false);
    }
  }

  async function openPortal() {
    setOpeningPortal(true);
    try {
      const { url } = await BillingApi.portal();
      window.location.href = url;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not open billing. Please try again.', 'error');
      setOpeningPortal(false);
    }
  }

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

  // Billing presentation state. The go-live bar appears once billing lets
  // it (trial running, past-due grace, or an exempt pre-launch workspace);
  // before that, the trial step below takes its place.
  const priceRegion = billing?.pricingRegion ?? me.tenant.pricingRegion;
  const trialLive = billing?.state === 'TRIALING' || billing?.state === 'ACTIVE';
  const pastDue = billing?.state === 'PAST_DUE';
  const showTrialStep =
    allDone && billingLoaded && billing !== null && !billing.billingExempt && !trialLive && !pastDue;
  const showGoLive =
    allDone && (!billingLoaded || billing === null || billing.billingExempt || trialLive || pastDue);
  const trialDaysLeft = daysLeft(billing?.trialEndsAt ?? null);

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

      {/* Trial step (Build 2) — the last step before go-live for paying
          workspaces. Prices come from the workspace's real pricing region,
          never from the marketing display currency. */}
      {showTrialStep && billing && (
        <div className="mt-6 rounded-3xl border border-signal/25 bg-signal-soft/50 p-6">
          <p className="font-display text-lg font-semibold text-ink">Start your 7-day free trial</p>
          <p className="mt-0.5 text-sm text-ink-muted">
            7 days free, card required today. Your card is charged{' '}
            {PLAN_DISPLAY[tierChoice].price[priceRegion]} {priceRegion} on day 8 unless you cancel.
            Cancel anytime.
          </p>
          {checkoutNote && (
            <p className="mt-3 rounded-xl border border-line bg-card px-4 py-3 text-sm text-ink">{checkoutNote}</p>
          )}
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {(Object.keys(PLAN_DISPLAY) as BillingTierChoice[]).map((tier) => {
              const plan = PLAN_DISPLAY[tier];
              const selected = tierChoice === tier;
              return (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setTierChoice(tier)}
                  aria-pressed={selected}
                  className={`rounded-2xl border p-4 text-left transition-all ${
                    selected
                      ? 'border-signal bg-card shadow-card'
                      : 'border-line bg-card/60 hover:border-ink-muted/40'
                  }`}
                >
                  <p className="text-sm font-semibold text-ink">{plan.name}</p>
                  <p className="mt-1 font-display text-2xl font-semibold text-ink">
                    {plan.price[priceRegion]}
                    <span className="ml-1 text-sm font-normal text-ink-muted">{priceRegion} / month</span>
                  </p>
                  <p className="mt-0.5 text-xs leading-snug text-ink-muted">
                    {plan.blurb} · {plan.minutes} minutes included
                  </p>
                </button>
              );
            })}
          </div>
          <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-teal-600"
              checked={whiteGlove}
              onChange={(e) => setWhiteGlove(e.target.checked)}
            />
            <span>
              Add white glove setup ({WHITE_GLOVE_PRICE[priceRegion]} {priceRegion}, one time). We configure
              everything for you. Charged when your trial converts, not today.
            </span>
          </label>
          {billing.configured ? (
            <div className="mt-6">
              <Button size="lg" loading={startingCheckout} onClick={startCheckout}>
                Start free trial
              </Button>
            </div>
          ) : (
            <p className="mt-6 text-sm text-ink-muted">
              Billing is being set up on our side. Please check back shortly to start your trial.
            </p>
          )}
        </div>
      )}

      {/* Trial is running: say so, with the days left, above go-live. */}
      {allDone && trialLive && billing && (
        <div className="mt-6 rounded-3xl border border-clinic/30 bg-clinic-soft p-6">
          <p className="font-display text-lg font-semibold text-ink">
            {billing.state === 'TRIALING'
              ? `Trial active${trialDaysLeft !== null ? `, ${trialDaysLeft} ${trialDaysLeft === 1 ? 'day' : 'days'} left` : ''} ✓`
              : 'Subscription active ✓'}
          </p>
          <p className="mt-0.5 text-sm text-ink-muted">
            {billing.tier ? `${PLAN_DISPLAY[billing.tier].name}, ` : ''}
            {billing.monthlyMinuteLimit} minutes a month. Manage or cancel anytime from Settings.
          </p>
        </div>
      )}

      {/* Past due: service continues during Stripe's retries; point at the fix. */}
      {allDone && pastDue && (
        <div className="mt-6 flex flex-col items-start gap-3 rounded-3xl border border-danger/30 bg-danger-soft p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-display text-lg font-semibold text-ink">Your last payment failed</p>
            <p className="mt-0.5 text-sm text-ink-muted">
              Your receptionist keeps answering while payment is retried. Update your card to keep it that way.
            </p>
          </div>
          <Button size="lg" loading={openingPortal} onClick={openPortal}>
            Update card
          </Button>
        </div>
      )}

      {/* Page-level go-live — visible wherever you finish, not trapped on one step. */}
      {showGoLive && (
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
