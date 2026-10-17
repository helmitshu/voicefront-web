import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  VAPI_WEBHOOK_SECRET: z.string().min(16, 'VAPI_WEBHOOK_SECRET must be at least 16 characters'),
  VAPI_PUBLIC_KEY: z.string().optional(),
  /**
   * Vapi private (server) API key. Lets the app push assistant updates to
   * Vapi when a customer saves their settings, and validate assistant IDs
   * the founder assigns. Optional: when unset, assistant sync is disabled
   * and the app's transient-assistant flow still drives calls.
   */
  VAPI_PRIVATE_KEY: z.string().optional(),
  /**
   * Public base URL of this API (e.g. the ngrok https URL in local dev).
   * When set, transient assistants carry an explicit server URL so tool
   * calls (appointment booking) work even on browser test calls, which
   * have no phone-number-level server config to fall back to.
   */
  PUBLIC_API_URL: z.string().url().optional(),
  /**
   * Injected automatically by Railway for any service with a public domain
   * (e.g. "voicefrontapi-production.up.railway.app"). Used to derive
   * PUBLIC_API_URL when it isn't set explicitly, so the Vapi webhook points at
   * this cloud service with zero manual config — no ngrok/local tunnel needed.
   */
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  MEDIA_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /**
   * Twilio credentials for outbound SMS (confirmations + reminders).
   * All three must be set for SMS to be active. Optional — when unset the SMS
   * feature is silently disabled and no messages are sent.
   */
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  /**
   * OAuth client credentials for two-way calendar sync. Operator-provisioned
   * (one Google Cloud OAuth app, one Azure app registration); customers then
   * self-connect their own calendar. Optional — when a provider's pair is unset
   * that provider's "Connect" option is simply hidden. Can also be set live in
   * the admin panel (PlatformSetting), which overrides these.
   */
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  /**
   * OAuth client ID for "Continue with Google" sign-in (Google Identity
   * Services ID-token flow). The browser posts an ID token and the API
   * verifies it against this audience — no client secret exists in this
   * flow. Optional — when unset, POST /api/auth/google refuses with
   * GOOGLE_AUTH_NOT_CONFIGURED and the web hides the button. Distinct from
   * GOOGLE_OAUTH_CLIENT_ID above, which belongs to the calendar-sync
   * auth-code app. The web app needs the same value as
   * NEXT_PUBLIC_GOOGLE_CLIENT_ID.
   */
  GOOGLE_CLIENT_ID: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_ID: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().optional(),
  /**
   * Comma-separated emails granted the founder admin panel (/admin).
   * These accounts see and control every workspace on the platform.
   */
  PLATFORM_ADMIN_EMAILS: z.string().default(''),
  /**
   * Which industries require an invitation code to sign up, comma-separated.
   * Trades is open self-serve; clinics are invite-only (vetted onboarding,
   * pending HIPAA handling). Defaults to "CLINIC". Set to "" to open everything,
   * or "CLINIC,CONSTRUCTION" to make all signups invite-only.
   */
  INVITE_ONLY_INDUSTRIES: z.string().default('CLINIC'),

  // ── Observability ──────────────────────────────────────────────────────────
  /** Structured-log verbosity. */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Sentry error-reporting DSN. Optional — when unset, error reporting is simply
   * disabled (the app logs as usual). Paste your project's DSN to switch it on.
   */
  SENTRY_DSN: z.string().optional(),
  /** Override the environment tag Sentry shows (defaults to NODE_ENV). */
  SENTRY_ENVIRONMENT: z.string().optional(),
  /**
   * Cloudflare Turnstile secret key for bot protection on the public demo
   * lead form. Optional — when unset, the Turnstile check is skipped (a
   * warning is logged in production). Create a Turnstile site in the
   * Cloudflare dashboard and paste the secret here to switch it on.
   */
  TURNSTILE_SECRET_KEY: z.string().optional(),
  /**
   * Google Gemini API key for the AI reading layer in the clinic-facts
   * puller (free tier is enough). Optional — when unset, the puller uses
   * its rules-based extractor only. When set, a model reads the cleaned
   * page text and extracts the clinic facts with understanding; any model
   * failure falls back to the rules result, so the demo behaves
   * identically with the key absent or broken.
   */
  GEMINI_API_KEY: z.string().optional(),
  /**
   * Per-member Gemini keys for the AI team room, one per seat, each from
   * that member's own Google project, so one member's free-tier quota
   * burn cannot starve the others. Optional — a member whose own key is
   * unset falls back to the shared GEMINI_API_KEY above.
   */
  TEAM_GEMINI_API_KEY_OMAR: z.string().optional(),
  TEAM_GEMINI_API_KEY_PRIYA: z.string().optional(),
  TEAM_GEMINI_API_KEY_DANIEL: z.string().optional(),
  TEAM_GEMINI_API_KEY_LAYLA: z.string().optional(),
  /**
   * Daily cap on SCHEDULED team ability runs (Phase 2a), counted per
   * UTC day from the team_runs ledger. Bounds paid-key spend from the
   * clock no matter how the schedules are tuned. Manual runs from the
   * Team page are never capped.
   */
  TEAM_DAILY_RUN_CAP: z.coerce.number().int().positive().default(40),
  /**
   * Success-rate alarm thresholds (reliability pack). An hourly job
   * looks at the last RESCUE_ALARM_WINDOW_MINUTES of finalized calls:
   * a single workspace with RESCUE_ALARM_TENANT_THRESHOLD or more
   * rescue-needed calls, that many across the whole platform, or that
   * many demo calls dying on a call.start.error-* transport failure,
   * posts one alarm to the AI Team channel and files a failure case.
   * A scope re-alarms at most once per RESCUE_ALARM_DEDUPE_HOURS; the
   * dedupe state lives in the reliability_alarms table.
   */
  RESCUE_ALARM_TENANT_THRESHOLD: z.coerce.number().int().positive().default(3),
  RESCUE_ALARM_PLATFORM_THRESHOLD: z.coerce.number().int().positive().default(5),
  RESCUE_ALARM_DEMO_TRANSPORT_THRESHOLD: z.coerce.number().int().positive().default(2),
  RESCUE_ALARM_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
  RESCUE_ALARM_DEDUPE_HOURS: z.coerce.number().int().positive().default(6),
  /**
   * Lyla's own Gemini key (the public landing-page host), from her own
   * Google project on the same billing account, so public chat spend and
   * quota stay separate from the signed-in product. Optional for now:
   * while unset she falls back to the shared GEMINI_API_KEY and logs the
   * fallback once. The endpoint, prompt, tool registry and data are fully
   * separate either way; provisioning this key is a later founder step.
   */
  LYLA_GEMINI_API_KEY: z.string().optional(),
  /**
   * Global daily circuit breaker for Lyla's public chat: once this many
   * chat sessions have started in one UTC day, her chat stops being
   * offered (the demo lead form keeps working). Bounds public model spend
   * no matter what any single visitor does.
   */
  LYLA_DAILY_SESSION_LIMIT: z.coerce.number().int().positive().default(300),
  /**
   * Kill switch for the personalized (receptionist) demo kind only. Unset =
   * enabled. Set to 'false' to reject demoKind 'receptionist' calls while
   * the sales demo keeps running; the DEMO_ENABLED platform setting still
   * gates the whole demo surface.
   */
  PERSONALIZED_DEMO_ENABLED: z.string().optional(),

  // ── Stripe billing (Build 2) ─────────────────────────────────────────────
  /**
   * Stripe secret key (sk_live_ or sk_test_). Server-side only; the web app
   * never sees it because checkout and the customer portal are hosted
   * redirects. Optional — when unset, the billing surface refuses cleanly
   * with BILLING_NOT_CONFIGURED and the rest of the API is unaffected.
   */
  STRIPE_SECRET_KEY: z.string().optional(),
  /**
   * Signing secret (whsec_) for the /api/billing/webhook endpoint. The
   * webhook verifies every delivery against the raw request body with this
   * secret and processes nothing without it.
   */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /**
   * Price ids (price_...) created in the Stripe dashboard, one per tier and
   * price book. The charged price is resolved ONLY from the tenant's
   * server-owned pricingRegion through these ids — no client input can
   * select one. A missing id for the requested tier and region makes
   * checkout refuse with BILLING_NOT_CONFIGURED.
   */
  STRIPE_PRICE_STARTER_USD: z.string().optional(),
  STRIPE_PRICE_STARTER_CAD: z.string().optional(),
  STRIPE_PRICE_CORE_USD: z.string().optional(),
  STRIPE_PRICE_CORE_CAD: z.string().optional(),
  /** One-time white glove setup fee, charged on the conversion invoice. */
  STRIPE_PRICE_WHITE_GLOVE_USD: z.string().optional(),
  STRIPE_PRICE_WHITE_GLOVE_CAD: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast with a readable report instead of crashing mid-request later.
    console.error('✖ Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

/**
 * Public base URL of this API. An explicit PUBLIC_API_URL wins; otherwise we
 * derive it from Railway's injected public domain, so the cloud deploy serves
 * the Vapi webhook with no ngrok/local tunnel. Null only in pure local dev.
 */
export const publicApiUrl: string | null =
  env.PUBLIC_API_URL ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null);

export const corsOrigins = env.CORS_ORIGIN.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const VALID_INDUSTRIES = ['CLINIC', 'CONSTRUCTION'] as const;
export type SignupIndustry = (typeof VALID_INDUSTRIES)[number];

/** Industries that require an invitation code to self-sign-up. */
export const inviteOnlyIndustries: SignupIndustry[] = env.INVITE_ONLY_INDUSTRIES.split(',')
  .map((s) => s.trim().toUpperCase())
  .filter((s): s is SignupIndustry => (VALID_INDUSTRIES as readonly string[]).includes(s));

/** True when the given industry needs an invitation code to sign up. */
export function requiresInvite(industry: string): boolean {
  return (inviteOnlyIndustries as readonly string[]).includes(industry);
}

export const platformAdminEmails = new Set(
  env.PLATFORM_ADMIN_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export function isPlatformAdminEmail(email: string): boolean {
  return platformAdminEmails.has(email.trim().toLowerCase());
}
