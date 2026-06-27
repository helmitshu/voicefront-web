'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { ApiError, SignupApi, type Industry } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { INDUSTRY_TEMPLATES } from '@/domain/prompt-templates';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';

const RegisterSchema = z.object({
  accessCode: z.string().trim().min(1, 'Enter the invitation code we sent you'),
  companyName: z.string().trim().min(2, 'Company name is too short').max(80),
  fullName: z.string().trim().min(2, 'Please enter your name').max(80),
  email: z.string().trim().email('Please enter a valid email'),
  password: z.string().min(8, 'Use at least 8 characters').max(128),
});

type FieldKey = 'accessCode' | 'companyName' | 'fullName' | 'email' | 'password';
type FieldErrors = Partial<Record<FieldKey, string>>;

const INDUSTRY_CARDS: Array<{ value: Industry; icon: string }> = [
  { value: 'CLINIC', icon: '🩺' },
  { value: 'CONSTRUCTION', icon: '🏗️' },
];

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();
  // Launch gate: which industries the server allows for self-signup. Default to
  // trades-only (the safe gated default) until the config loads.
  const [openIndustries, setOpenIndustries] = useState<Industry[]>(['CONSTRUCTION']);
  const [industry, setIndustry] = useState<Industry>('CONSTRUCTION');

  useEffect(() => {
    const controller = new AbortController();
    SignupApi.config(controller.signal)
      .then(({ openIndustries: open }) => {
        if (open.length > 0) {
          setOpenIndustries(open);
          setIndustry((current) => (open.includes(current) ? current : open[0]));
        }
      })
      .catch(() => {
        /* keep the safe trades-only default if the config can't load */
      });
    return () => controller.abort();
  }, []);

  const visibleCards = INDUSTRY_CARDS.filter((c) => openIndustries.includes(c.value));
  const [values, setValues] = useState({
    accessCode: '',
    companyName: '',
    fullName: '',
    email: '',
    password: '',
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function setField(key: FieldKey, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setFormError(null);

    const parsed = RegisterSchema.safeParse(values);
    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as FieldKey;
        errors[key] ??= issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await register({ ...parsed.data, industry });
      router.replace('/onboarding');
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-ink">Create your workspace</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Your receptionist comes pre-trained for your trade — you&apos;ll hear it answer a real call in
        under two minutes, then go live. Enter the invitation code from your demo to start.
      </p>

      <form onSubmit={onSubmit} noValidate className="mt-8 flex flex-col gap-5">
        {formError && (
          <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
            {formError}
          </p>
        )}

        <div className="rounded-2xl border border-signal/20 bg-signal-soft/40 p-4">
          <Input
            label="Invitation code"
            value={values.accessCode}
            onChange={(e) => setField('accessCode', e.target.value.toUpperCase())}
            error={fieldErrors.accessCode}
            hint="The one-time code from your demo or sales call."
            placeholder="VF-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </div>

        {/* Industry picker — shown only when more than one is open for signup
            (the launch gate may restrict this to a single industry). */}
        {visibleCards.length > 1 && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink">What kind of business is this?</legend>
            <div className="grid grid-cols-2 gap-3">
              {visibleCards.map((card) => {
                const template = INDUSTRY_TEMPLATES[card.value];
                const selected = industry === card.value;
                return (
                  <button
                    key={card.value}
                    type="button"
                    onClick={() => setIndustry(card.value)}
                    aria-pressed={selected}
                    className={`rounded-2xl border p-4 text-left transition-all ${
                      selected
                        ? 'border-signal bg-signal-soft shadow-card'
                        : 'border-line bg-white hover:border-ink-muted/40'
                    }`}
                  >
                    <span aria-hidden className="text-xl">
                      {card.icon}
                    </span>
                    <p className="mt-2 text-sm font-semibold text-ink">{template.title}</p>
                    <p className="mt-0.5 text-xs leading-snug text-ink-muted">{template.tagline}</p>
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        <Input
          label="Company name"
          value={values.companyName}
          onChange={(e) => setField('companyName', e.target.value)}
          error={fieldErrors.companyName}
          placeholder={industry === 'CLINIC' ? 'Northside Family Clinic' : 'Granite Ridge Builders'}
          autoComplete="organization"
        />
        <Input
          label="Your name"
          value={values.fullName}
          onChange={(e) => setField('fullName', e.target.value)}
          error={fieldErrors.fullName}
          placeholder="Alex Rivera"
          autoComplete="name"
        />
        <Input
          label="Work email"
          type="email"
          value={values.email}
          onChange={(e) => setField('email', e.target.value)}
          error={fieldErrors.email}
          placeholder="you@company.com"
          autoComplete="email"
        />
        <Input
          label="Password"
          type="password"
          value={values.password}
          onChange={(e) => setField('password', e.target.value)}
          error={fieldErrors.password}
          hint="At least 8 characters."
          autoComplete="new-password"
        />

        <Button type="submit" size="lg" loading={submitting} className="mt-2">
          Create workspace
        </Button>

        <p className="text-center text-xs leading-relaxed text-ink-muted">
          By creating a workspace you agree to our{' '}
          <Link href="/terms" className="font-medium text-signal-deep hover:underline">
            Terms of Service
          </Link>{' '}
          and{' '}
          <Link href="/privacy" className="font-medium text-signal-deep hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </form>

      <p className="mt-6 text-sm text-ink-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-signal-deep hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
