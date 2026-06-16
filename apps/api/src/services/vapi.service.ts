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
  init: { method: 'GET' | 'PATCH' | 'POST' | 'DELETE'; body?: unknown },
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

interface VapiCreatePhoneResult {
  id: string;
  number: string;
}

/**
 * Creates a free Vapi-managed phone number and configures its Server URL +
 * secret so calls route to our inbound webhook. Throws HttpError on failure,
 * surfacing Vapi's own validation message when present.
 *
 * IMPORTANT: free Vapi numbers are US-only. A US area code can be requested via
 * `areaCode`; Vapi assigns any available number when omitted. For non-US
 * numbers, import a Twilio/BYO number instead (the "add existing" path).
 */
export async function createPhoneNumberInVapi(opts: { areaCode?: string }): Promise<VapiCreatePhoneResult> {
  const [publicApiUrl, webhookSecret] = await Promise.all([
    getSettingValue('PUBLIC_API_URL'),
    getSettingValue('VAPI_WEBHOOK_SECRET'),
  ]);

  if (!publicApiUrl) {
    throw new HttpError(
      503,
      'PUBLIC_API_URL is not configured. Set it under Keys & config first.',
      'CONFIG_MISSING',
    );
  }

  // Vapi's phone-number create is a discriminated union keyed on `provider`;
  // "vapi" gets one of Vapi's own free numbers. The webhook lives in `server`,
  // whose `secret` Vapi echoes back as the X-Vapi-Secret header on each call.
  const server: { url: string; secret?: string } = { url: `${publicApiUrl}/api/vapi/inbound` };
  if (webhookSecret) server.secret = webhookSecret;

  const payload: Record<string, unknown> = { provider: 'vapi', server };
  if (opts.areaCode) payload.numberDesiredAreaCode = opts.areaCode;

  const res = await vapiFetch('/phone-number', { method: 'POST', body: payload });
  if (!res.ok) {
    // Surface Vapi's real complaint — its 400s carry a `message` worth showing.
    const raw = await res.text().catch(() => '');
    let message = `Vapi returned an error (${res.status}).`;
    try {
      const parsed = JSON.parse(raw) as { message?: unknown };
      const m = Array.isArray(parsed.message) ? parsed.message.join('; ') : parsed.message;
      if (typeof m === 'string' && m.length > 0) message = `Vapi: ${m}`;
    } catch {
      if (raw) message = `Vapi (${res.status}): ${raw.slice(0, 200)}`;
    }
    throw new HttpError(res.status >= 500 ? 502 : 400, message, 'VAPI_CREATE_FAILED');
  }

  const data = (await res.json()) as VapiCreatePhoneResult;
  if (!data.number) {
    throw new HttpError(502, 'Vapi created the number but returned no E.164 value.', 'VAPI_ERROR');
  }
  return data;
}

/* ------------------------------ file uploads ------------------------------ */

export interface VapiFile {
  id: string;
  /** "processing" | "done" | "failed" — until "done" it isn't queryable. */
  status: string;
}

/**
 * Uploads a document to Vapi's file store (multipart). The returned id is what
 * we attach to an assistant as a knowledge-base file. Throws HttpError with a
 * speakable message so the upload route can surface a clear failure.
 *
 * Note: we send the multipart body via the native FormData/Blob — fetch sets
 * the multipart boundary itself, so (unlike vapiFetch) we must NOT set a
 * Content-Type header here.
 */
export async function uploadFileToVapi(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<VapiFile> {
  const key = await privateKey();
  if (!key) {
    throw new HttpError(
      503,
      'No Vapi private key is configured. Add it under Keys & config before uploading documents.',
      'VAPI_PRIVATE_KEY_MISSING',
    );
  }

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), fileName);

  const controller = new AbortController();
  // Uploads + server-side parsing can take longer than a normal API call.
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(`${VAPI_BASE_URL}/file`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new HttpError(504, 'The upload to Vapi timed out. Try again in a moment.', 'VAPI_TIMEOUT');
    }
    throw new HttpError(502, 'Could not reach Vapi to upload the file.', 'VAPI_UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const { code, message } = explainStatus(res.status);
    throw new HttpError(res.status === 401 || res.status === 403 ? 502 : 502, message, code);
  }
  const data = (await res.json()) as { id: string; status?: string };
  return { id: data.id, status: data.status ?? 'processing' };
}

/**
 * Removes a file from Vapi's store. Best-effort: never throws, so deleting a
 * document from the portal always succeeds locally even if Vapi is unreachable
 * (an orphaned Vapi file is harmless — it's no longer referenced by any assistant).
 */
export async function deleteFileFromVapi(fileId: string): Promise<void> {
  try {
    await vapiFetch(`/file/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  } catch (err) {
    console.warn(`[vapi] Failed to delete file ${fileId} (continuing):`, err);
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
    const [publicApiUrl, webhookSecret, documents] = await Promise.all([
      getSettingValue('PUBLIC_API_URL'),
      getSettingValue('VAPI_WEBHOOK_SECRET'),
      // Attach every file that isn't a known failure. Vapi keeps indexing a
      // "processing" file after it's attached, so it becomes queryable by the
      // time a call lands — and we never poll Vapi for status transitions.
      prisma.document.findMany({
        where: { tenantId, status: { not: 'failed' } },
        select: { vapiFileId: true },
      }),
    ]);
    const payload = buildAssistantUpdatePayload(tenant, settings, {
      serverUrl: publicApiUrl ? `${publicApiUrl}/api/vapi/inbound` : undefined,
      serverSecret: webhookSecret ?? undefined,
      knowledgeFileIds: documents.map((d) => d.vapiFileId),
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

/**
 * Creates a dedicated persistent Vapi assistant for a tenant from their current
 * settings (Maya's shared tuning + the tenant's industry script, voice, and
 * name), stores the new assistantId, and returns it. Idempotent: if the tenant
 * already has an assistant, returns that id without creating a duplicate.
 *
 * Calls route to this assistant via the assistant-request webhook returning
 * `{ assistantId }` — so the per-call quota/block gate still runs, but Vapi uses
 * a warm, pre-built assistant instead of one rebuilt on every call. Throws
 * HttpError on failure so callers can surface a clear message.
 */
export async function createAssistantForTenant(tenantId: string): Promise<string> {
  const [tenant, settings] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, companyName: true } }),
    prisma.agentSettings.findUnique({ where: { tenantId } }),
  ]);
  if (!tenant || !settings) {
    throw new HttpError(404, 'Workspace settings were not found.', 'SETTINGS_MISSING');
  }
  if (settings.assistantId) return settings.assistantId; // already provisioned

  const [publicApiUrl, webhookSecret, documents] = await Promise.all([
    getSettingValue('PUBLIC_API_URL'),
    getSettingValue('VAPI_WEBHOOK_SECRET'),
    prisma.document.findMany({
      where: { tenantId, status: { not: 'failed' } },
      select: { vapiFileId: true },
    }),
  ]);

  const payload = buildAssistantUpdatePayload(tenant, settings, {
    serverUrl: publicApiUrl ? `${publicApiUrl}/api/vapi/inbound` : undefined,
    serverSecret: webhookSecret ?? undefined,
    knowledgeFileIds: documents.map((d) => d.vapiFileId),
  });

  const res = await vapiFetch('/assistant', { method: 'POST', body: payload });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `Vapi could not create the assistant (${res.status}).`;
    try {
      const parsed = JSON.parse(raw) as { message?: unknown };
      const m = Array.isArray(parsed.message) ? parsed.message.join('; ') : parsed.message;
      if (typeof m === 'string' && m.length > 0) message = `Vapi: ${m}`;
    } catch {
      /* keep generic message */
    }
    throw new HttpError(res.status >= 500 ? 502 : 400, message, 'VAPI_CREATE_ASSISTANT_FAILED');
  }

  const data = (await res.json()) as { id?: string };
  if (!data.id) {
    throw new HttpError(502, 'Vapi created the assistant but returned no id.', 'VAPI_ERROR');
  }
  await prisma.agentSettings.update({ where: { tenantId }, data: { assistantId: data.id } });
  return data.id;
}
