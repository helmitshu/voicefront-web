import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { getSettingValue } from './platform-config.service';
import { buildAssistantUpdatePayload } from '../domain/assistant-builder';

/**
 * Outbound calls to Vapi's REST API. Used to (1) validate an assistant ID the
 * founder assigns to a customer, and (2) push a customer's settings up to their
 * assigned assistant whenever they save. Authenticated with the platform's
 * Vapi *private* key (VAPI_PRIVATE_KEY), resolved from admin config or env.
 *
 * Design notes:
 *  - Validation (founder assigning) throws HttpError with clear messages.
 *  - Sync-on-save is best-effort: it returns a status and never throws, so a
 *    Vapi hiccup can't block a customer from saving their own settings.
 */

const VAPI_BASE_URL = 'https://api.vapi.ai';
const REQUEST_TIMEOUT_MS = 10_000;

async function privateKey(): Promise<string | null> {
  return getSettingValue('VAPI_PRIVATE_KEY');
}

/** True when a Vapi private key is configured (admin or env). */
export async function isAssistantSyncConfigured(): Promise<boolean> {
  return (await privateKey()) !== null;
}

interface VapiAssistant {
  id: string;
  name?: string;
}

async function vapiFetch(
  path: string,
  init: { method: 'GET' | 'PATCH' | 'POST'; body?: unknown },
): Promise<Response> {
  const key = await privateKey();
  if (!key) {
    throw new HttpError(
      503,
      'No Vapi private key is configured. Add it under Keys & config before assigning or syncing assistants.',
      'VAPI_PRIVATE_KEY_MISSING',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${VAPI_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new HttpError(504, 'Vapi did not respond in time. Try again in a moment.', 'VAPI_TIMEOUT');
    }
    throw new HttpError(502, 'Could not reach Vapi. Check the network and try again.', 'VAPI_UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }
}

function explainStatus(status: number): { code: string; message: string } {
  if (status === 401 || status === 403) {
    return { code: 'VAPI_AUTH', message: 'Vapi rejected the private key. Double-check it under Keys & config.' };
  }
  if (status === 404) {
    return { code: 'ASSISTANT_NOT_FOUND', message: 'No Vapi assistant with that ID exists on your account.' };
  }
  return { code: 'VAPI_ERROR', message: `Vapi returned an error (${status}). Try again in a moment.` };
}

/**
 * Confirms an assistant ID exists on the connected Vapi account.
 * Returns the assistant's id + name; throws HttpError otherwise.
 */
export async function validateAssistant(assistantId: string): Promise<VapiAssistant> {
  const res = await vapiFetch(`/assistant/${encodeURIComponent(assistantId)}`, { method: 'GET' });
  if (!res.ok) {
    const { code, message } = explainStatus(res.status);
    throw new HttpError(res.status === 404 ? 404 : 502, message, code);
  }
  const data = (await res.json()) as VapiAssistant;
  return { id: data.id, name: data.name };
}

interface VapiPhoneNumber {
  id: string;
  number?: string;
  assistantId?: string | null;
}

/**
 * Finds the phone number attached to an assistant in Vapi, if any. One list
 * call, matched client-side on assistantId. Best-effort: returns null on any
 * error or when no number is linked (the caller treats that as "not linked yet").
 */
export async function findAssistantPhoneNumber(assistantId: string): Promise<string | null> {
  try {
    const res = await vapiFetch('/phone-number', { method: 'GET' });
    if (!res.ok) return null;
    const numbers = (await res.json()) as VapiPhoneNumber[];
    if (!Array.isArray(numbers)) return null;
    const match = numbers.find((n) => n.assistantId === assistantId && typeof n.number === 'string');
    return match?.number ?? null;
  } catch {
    return null;
  }
}

export interface SyncResult {
  synced: boolean;
  /** Why a sync was skipped or failed — surfaced to the customer as a gentle note. */
  reason?: string;
}

/**
 * Pushes a tenant's current settings to their assigned Vapi assistant.
 * Best-effort: returns a status, never throws. Skips quietly when no assistant
 * is assigned or no private key is configured (the transient flow still works).
 */
export async function syncAssistantForTenant(tenantId: string): Promise<SyncResult> {
  const [tenant, settings] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, companyName: true } }),
    prisma.agentSettings.findUnique({ where: { tenantId } }),
  ]);
  if (!tenant || !settings) return { synced: false, reason: 'Workspace settings were not found.' };
  if (!settings.assistantId) return { synced: false };
  if (!(await privateKey())) {
    return { synced: false, reason: 'No Vapi private key is configured yet, so changes were saved here only.' };
  }

  try {
    const [publicApiUrl, webhookSecret] = await Promise.all([
      getSettingValue('PUBLIC_API_URL'),
      getSettingValue('VAPI_WEBHOOK_SECRET'),
    ]);
    const payload = buildAssistantUpdatePayload(tenant, settings, {
      serverUrl: publicApiUrl ? `${publicApiUrl}/api/vapi/inbound` : undefined,
      serverSecret: webhookSecret ?? undefined,
    });
    const res = await vapiFetch(`/assistant/${encodeURIComponent(settings.assistantId)}`, {
      method: 'PATCH',
      body: payload,
    });
    if (!res.ok) {
      const { message } = explainStatus(res.status);
      return { synced: false, reason: `Saved here, but Vapi update failed: ${message}` };
    }
    return { synced: true };
  } catch (err) {
    const reason = err instanceof HttpError ? err.message : 'Vapi was unreachable.';
    return { synced: false, reason: `Saved here, but the Vapi update didn’t go through: ${reason}` };
  }
}
