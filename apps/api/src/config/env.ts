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
   * Comma-separated emails granted the founder admin panel (/admin).
   * These accounts see and control every workspace on the platform.
   */
  PLATFORM_ADMIN_EMAILS: z.string().default(''),
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

export const platformAdminEmails = new Set(
  env.PLATFORM_ADMIN_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export function isPlatformAdminEmail(email: string): boolean {
  return platformAdminEmails.has(email.trim().toLowerCase());
}
