import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env, publicApiUrl } from '../config/env';
import { HttpError } from '../lib/http';

/**
 * Operator-editable runtime configuration. Values pasted in the admin panel
 * are encrypted at rest and override the corresponding env var the moment
 * they're saved — no restart, no .env editing. Deleting an override falls
 * back to whatever the env file says.
 */

export const SETTING_KEYS = [
  'VAPI_PUBLIC_KEY',
  'VAPI_PRIVATE_KEY',
  'VAPI_WEBHOOK_SECRET',
  'PUBLIC_API_URL',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'MICROSOFT_OAUTH_CLIENT_ID',
  'MICROSOFT_OAUTH_CLIENT_SECRET',
  'GOOGLE_PLACES_API_KEY',
  'RESEND_API_KEY',
  'OUTREACH_FROM_EMAIL',
  'OUTREACH_FROM_NAME',
  'OUTREACH_PHYSICAL_ADDRESS',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_USD',
  'STRIPE_PRICE_CAD',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const SETTING_META: Record<
  SettingKey,
  { label: string; description: string; secret: boolean; placeholder: string }
> = {
  VAPI_PUBLIC_KEY: {
    label: 'Vapi public key',
    description:
      'The public (browser) key from your Vapi dashboard. Powers in-browser test calls for every workspace. Safe to expose to signed-in users.',
    secret: false,
    placeholder: 'e.g. c6ea4db1-757e-4306-…',
  },
  VAPI_PRIVATE_KEY: {
    label: 'Vapi private key',
    description:
      'The private (server) key from your Vapi dashboard under API Keys. Lets the app push setting changes to each customer’s assigned assistant and check that an assistant ID is real. Keep this secret.',
    secret: true,
    placeholder: 'paste your Vapi private key',
  },
  VAPI_WEBHOOK_SECRET: {
    label: 'Vapi webhook secret',
    description:
      'Must match the secret configured on your Vapi phone number’s Server URL. If these don’t match, incoming calls stop working — change both places together.',
    secret: true,
    placeholder: 'paste the shared secret',
  },
  PUBLIC_API_URL: {
    label: 'Public API URL',
    description:
      'The public https address of this server, used for the Vapi webhook. On Railway it auto-derives from the service domain — leave this blank in production. Set it only for local development (e.g. an ngrok/cloudflared tunnel) so browser test calls and booking tools can reach your machine.',
    secret: false,
    placeholder: 'Blank on Railway · locally e.g. https://abc123.ngrok-free.app',
  },
  GOOGLE_OAUTH_CLIENT_ID: {
    label: 'Google OAuth client ID',
    description:
      'From your Google Cloud OAuth 2.0 client (Web application). Lets customers connect their Google Calendar for two-way sync. Set the authorized redirect URI to <API URL>/api/calendar/google/callback.',
    secret: false,
    placeholder: 'e.g. 1234-abcd.apps.googleusercontent.com',
  },
  GOOGLE_OAUTH_CLIENT_SECRET: {
    label: 'Google OAuth client secret',
    description: 'The client secret paired with the Google OAuth client ID above. Keep this secret.',
    secret: true,
    placeholder: 'paste your Google client secret',
  },
  MICROSOFT_OAUTH_CLIENT_ID: {
    label: 'Microsoft OAuth client ID',
    description:
      'Application (client) ID from your Azure app registration. Lets customers connect Outlook / Microsoft 365 calendars. Set the redirect URI to <API URL>/api/calendar/microsoft/callback.',
    secret: false,
    placeholder: 'e.g. 00000000-0000-0000-0000-000000000000',
  },
  MICROSOFT_OAUTH_CLIENT_SECRET: {
    label: 'Microsoft OAuth client secret',
    description: 'A client secret value from your Azure app registration (Certificates & secrets). Keep this secret.',
    secret: true,
    placeholder: 'paste your Microsoft client secret',
  },
  GOOGLE_PLACES_API_KEY: {
    label: 'Google Places API key',
    description:
      'From Google Cloud → APIs & Services. Enable “Places API (New)”, create an API key, and paste it here. Powers the lead-sourcing pipeline (Leads tab). Free tier covers thousands of lookups, then a few cents each.',
    secret: true,
    placeholder: 'paste your Google Places API key',
  },
  RESEND_API_KEY: {
    label: 'Resend API key',
    description:
      'From resend.com → API Keys. Powers outreach email sending (Leads tab). With no verified domain you can send from onboarding@resend.dev but only to your own Resend signup email — verify a domain to send to a real list.',
    secret: true,
    placeholder: 're_…',
  },
  OUTREACH_FROM_EMAIL: {
    label: 'Outreach “from” email',
    description:
      'The address outreach emails are sent from. For testing with no domain, use onboarding@resend.dev. Once you verify a domain on Resend, switch this to e.g. hello@mail.yourdomain.com.',
    secret: false,
    placeholder: 'onboarding@resend.dev',
  },
  OUTREACH_FROM_NAME: {
    label: 'Outreach “from” name',
    description: 'The sender name shown in the inbox, e.g. “Sam at VoiceFront”. Optional.',
    secret: false,
    placeholder: 'VoiceFront',
  },
  OUTREACH_PHYSICAL_ADDRESS: {
    label: 'Mailing address (CAN-SPAM)',
    description:
      'A real physical mailing address — US law requires one in every commercial email. Shown in the email footer. e.g. “VoiceFront, 123 Main St, Phoenix, AZ 85004”.',
    secret: false,
    placeholder: 'Business name, street, city, state ZIP',
  },
  STRIPE_SECRET_KEY: {
    label: 'Stripe secret key',
    description:
      'From Stripe → Developers → API keys. Powers subscriptions, the 30-day trial, and the customer billing portal. Use a test key (sk_test_…) until you’re ready to charge real cards. Keep this secret.',
    secret: true,
    placeholder: 'sk_live_… or sk_test_…',
  },
  STRIPE_WEBHOOK_SECRET: {
    label: 'Stripe webhook signing secret',
    description:
      'From the Stripe webhook endpoint you point at <API URL>/api/stripe/webhook. Lets us trust subscription events. Must match the endpoint’s signing secret.',
    secret: true,
    placeholder: 'whsec_…',
  },
  STRIPE_PRICE_USD: {
    label: 'Stripe price ID — USD',
    description:
      'The recurring Price ID (price_…) for the Professional plan in USD. Create a $250/mo product in Stripe and paste its price ID here.',
    secret: false,
    placeholder: 'price_…',
  },
  STRIPE_PRICE_CAD: {
    label: 'Stripe price ID — CAD',
    description:
      'The recurring Price ID (price_…) for the Professional plan in CAD (shown to Canadian visitors). Optional — falls back to USD if unset.',
    secret: false,
    placeholder: 'price_…',
  },
};

function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

export function assertSettingKey(key: string): SettingKey {
  if (!isSettingKey(key)) {
    throw new HttpError(404, 'Unknown setting.', 'UNKNOWN_SETTING');
  }
  return key;
}

/* ------------------------------- encryption ------------------------------- */

// Derived (not raw) so the JWT secret and storage key are not interchangeable.
const ENC_KEY = createHash('sha256').update(`${env.JWT_SECRET}:platform-settings`).digest();

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function decrypt(stored: string): string {
  const [iv, tag, data] = stored.split('.');
  if (!iv || !tag || !data) throw new Error('Malformed encrypted setting');
  const decipher = createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/* --------------------------------- access --------------------------------- */

const CACHE_TTL_MS = 15_000;
const cache = new Map<SettingKey, { value: string | null; source: 'admin' | 'env' | 'unset'; at: number }>();

function envFallback(key: SettingKey): string | null {
  switch (key) {
    case 'VAPI_PUBLIC_KEY':
      return env.VAPI_PUBLIC_KEY ?? null;
    case 'VAPI_PRIVATE_KEY':
      return env.VAPI_PRIVATE_KEY ?? null;
    case 'VAPI_WEBHOOK_SECRET':
      return env.VAPI_WEBHOOK_SECRET;
    case 'PUBLIC_API_URL':
      return publicApiUrl;
    case 'GOOGLE_OAUTH_CLIENT_ID':
      return env.GOOGLE_OAUTH_CLIENT_ID ?? null;
    case 'GOOGLE_OAUTH_CLIENT_SECRET':
      return env.GOOGLE_OAUTH_CLIENT_SECRET ?? null;
    case 'MICROSOFT_OAUTH_CLIENT_ID':
      return env.MICROSOFT_OAUTH_CLIENT_ID ?? null;
    case 'MICROSOFT_OAUTH_CLIENT_SECRET':
      return env.MICROSOFT_OAUTH_CLIENT_SECRET ?? null;
    case 'GOOGLE_PLACES_API_KEY':
      return process.env.GOOGLE_PLACES_API_KEY ?? null;
    case 'RESEND_API_KEY':
      return process.env.RESEND_API_KEY ?? null;
    case 'OUTREACH_FROM_EMAIL':
      return process.env.OUTREACH_FROM_EMAIL ?? null;
    case 'OUTREACH_FROM_NAME':
      return process.env.OUTREACH_FROM_NAME ?? null;
    case 'OUTREACH_PHYSICAL_ADDRESS':
      return process.env.OUTREACH_PHYSICAL_ADDRESS ?? null;
    case 'STRIPE_SECRET_KEY':
      return process.env.STRIPE_SECRET_KEY ?? null;
    case 'STRIPE_WEBHOOK_SECRET':
      return process.env.STRIPE_WEBHOOK_SECRET ?? null;
    case 'STRIPE_PRICE_USD':
      return process.env.STRIPE_PRICE_USD ?? null;
    case 'STRIPE_PRICE_CAD':
      return process.env.STRIPE_PRICE_CAD ?? null;
  }
}

export interface ResolvedSetting {
  value: string | null;
  source: 'admin' | 'env' | 'unset';
}

/** Admin override if present, env fallback otherwise. Cached briefly. */
export async function getSetting(key: SettingKey): Promise<ResolvedSetting> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { value: hit.value, source: hit.source };

  let resolved: ResolvedSetting;
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key } });
    if (row) {
      resolved = { value: decrypt(row.valueEnc), source: 'admin' };
    } else {
      const fallback = envFallback(key);
      resolved = { value: fallback, source: fallback === null ? 'unset' : 'env' };
    }
  } catch (err) {
    // A corrupt row or DB hiccup must never take calls down — fall back to env.
    console.error(`[config] Failed to resolve ${key}, using env fallback:`, err);
    const fallback = envFallback(key);
    resolved = { value: fallback, source: fallback === null ? 'unset' : 'env' };
  }
  cache.set(key, { ...resolved, at: Date.now() });
  return resolved;
}

export async function getSettingValue(key: SettingKey): Promise<string | null> {
  return (await getSetting(key)).value;
}

const VALIDATORS: Record<SettingKey, (value: string) => string | null> = {
  VAPI_PUBLIC_KEY: (v) => (v.length >= 8 ? null : 'That looks too short to be a Vapi public key.'),
  VAPI_PRIVATE_KEY: (v) => (v.length >= 8 ? null : 'That looks too short to be a Vapi private key.'),
  VAPI_WEBHOOK_SECRET: (v) => (v.length >= 16 ? null : 'Webhook secrets must be at least 16 characters.'),
  PUBLIC_API_URL: (v) => {
    try {
      const url = new URL(v);
      return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'Must be an http(s) URL.';
    } catch {
      return 'That is not a valid URL.';
    }
  },
  GOOGLE_OAUTH_CLIENT_ID: (v) => (v.length >= 8 ? null : 'That does not look like a Google client ID.'),
  GOOGLE_OAUTH_CLIENT_SECRET: (v) => (v.length >= 8 ? null : 'That looks too short to be a client secret.'),
  MICROSOFT_OAUTH_CLIENT_ID: (v) => (v.length >= 8 ? null : 'That does not look like a Microsoft client ID.'),
  MICROSOFT_OAUTH_CLIENT_SECRET: (v) => (v.length >= 8 ? null : 'That looks too short to be a client secret.'),
  GOOGLE_PLACES_API_KEY: (v) => (v.length >= 20 ? null : 'That looks too short to be a Google API key.'),
  RESEND_API_KEY: (v) => (v.length >= 10 ? null : 'That looks too short to be a Resend API key.'),
  OUTREACH_FROM_EMAIL: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Enter a valid email address.'),
  OUTREACH_FROM_NAME: () => null,
  OUTREACH_PHYSICAL_ADDRESS: (v) => (v.length >= 5 ? null : 'Enter a real mailing address.'),
  STRIPE_SECRET_KEY: (v) => (v.startsWith('sk_') ? null : 'Stripe secret keys start with sk_live_ or sk_test_.'),
  STRIPE_WEBHOOK_SECRET: (v) => (v.startsWith('whsec_') ? null : 'Stripe webhook secrets start with whsec_.'),
  STRIPE_PRICE_USD: (v) => (v.startsWith('price_') ? null : 'Stripe price IDs start with price_.'),
  STRIPE_PRICE_CAD: (v) => (v.startsWith('price_') ? null : 'Stripe price IDs start with price_.'),
};

export async function setSetting(key: SettingKey, rawValue: string, adminEmail: string): Promise<void> {
  const value = rawValue.trim();
  if (!value) throw new HttpError(400, 'Value cannot be empty.', 'EMPTY_VALUE');
  const problem = VALIDATORS[key](value);
  if (problem) throw new HttpError(400, problem, 'INVALID_VALUE');
  const valueEnc = encrypt(value);
  await prisma.platformSetting.upsert({
    where: { key },
    create: { key, valueEnc, updatedBy: adminEmail },
    update: { valueEnc, updatedBy: adminEmail },
  });
  cache.delete(key);
}

export async function unsetSetting(key: SettingKey): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key } });
  cache.delete(key);
}

/** Masked preview for UI display — enough to recognize, never enough to leak. */
export function maskValue(value: string | null): string | null {
  if (value === null) return null;
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/* ---------------------------------- audit ---------------------------------- */

export async function recordAdminAction(
  adminEmail: string,
  action: string,
  target: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: { adminEmail, action, target, detail: detail as Prisma.InputJsonValue },
    });
  } catch (err) {
    // Auditing must never block the action itself.
    console.error('[audit] Failed to record admin action:', err);
  }
}
