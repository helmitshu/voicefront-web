import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
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
      'The public https address of this server (your ngrok URL in local dev). Needed so booking tools work on browser test calls.',
    secret: false,
    placeholder: 'https://your-subdomain.ngrok.io',
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
      return env.PUBLIC_API_URL ?? null;
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
