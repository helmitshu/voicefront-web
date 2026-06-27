import { env } from '../config/env';
import { HttpError } from './http';
import { getSettingValue } from '../services/platform-config.service';

/**
 * Single source of truth for the public webhook URL we hand to Vapi (phone
 * numbers + assistants). The base resolves through the platform-config chain:
 * admin override → PUBLIC_API_URL env → Railway's injected domain. In
 * production that means zero manual config — and definitely no ngrok.
 *
 * This module also classifies the host so we can SEE (admin diagnostic) and
 * ENFORCE (production guard) that the webhook isn't accidentally pointed at a
 * dev tunnel or localhost — the exact failure mode where every tool-call and
 * end-of-call report silently 401s.
 */

/** The path Vapi posts call events / tool-calls to. */
export const VAPI_WEBHOOK_PATH = '/api/vapi/inbound';

// Dev-tunnel providers whose URLs must never end up on a production number.
const TUNNEL_HOST_RE =
  /(^|\.)(ngrok\.io|ngrok-free\.app|ngrok\.app|loca\.lt|localtunnel\.me|trycloudflare\.com|serveo\.net|tunnelmole\.net)$/i;

export interface WebhookHostInfo {
  host: string;
  /** True only for a real, public https host (not localhost / not a tunnel). */
  productionSafe: boolean;
  /** Why it isn't production-safe, for surfacing to the operator. Null when safe. */
  reason: string | null;
}

/** Classify a base URL's host: https + public = safe; localhost/tunnel = not. */
export function classifyWebhookHost(rawUrl: string): WebhookHostInfo {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { host: '', productionSafe: false, reason: 'not a valid URL' };
  }
  const host = url.hostname;
  if (url.protocol !== 'https:') return { host, productionSafe: false, reason: 'not https' };
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    return { host, productionSafe: false, reason: 'localhost — only your machine can reach it' };
  }
  if (TUNNEL_HOST_RE.test(host)) {
    return { host, productionSafe: false, reason: 'a dev tunnel (ngrok/cloudflared/etc.) that can disappear' };
  }
  return { host, productionSafe: true, reason: null };
}

export interface ResolvedWebhook {
  /** Resolved PUBLIC_API_URL, or null when unconfigured (pure local dev). */
  baseUrl: string | null;
  /** baseUrl + the inbound webhook path, or null when unconfigured. */
  webhookUrl: string | null;
  host: string | null;
  productionSafe: boolean;
  reason: string | null;
}

/** Resolve the effective webhook URL and classify its host in one shot. */
export async function resolveWebhookUrl(): Promise<ResolvedWebhook> {
  const baseUrl = (await getSettingValue('PUBLIC_API_URL'))?.trim() || null;
  if (!baseUrl) {
    return { baseUrl: null, webhookUrl: null, host: null, productionSafe: false, reason: 'not configured' };
  }
  const info = classifyWebhookHost(baseUrl);
  return { baseUrl, webhookUrl: `${baseUrl}${VAPI_WEBHOOK_PATH}`, ...info };
}

/**
 * Guard the write paths that bake a webhook URL into Vapi (creating a number,
 * re-pointing numbers). In production we refuse a tunnel/localhost/missing URL
 * rather than silently wiring up a dead webhook; in dev we allow tunnels (that's
 * how local calls reach your machine).
 */
export function assertProductionWebhookSafe(w: ResolvedWebhook): void {
  if (!w.webhookUrl) {
    throw new HttpError(
      503,
      'PUBLIC_API_URL is not configured. On Railway it auto-derives from the service domain; set it under Keys & config if you need to override.',
      'CONFIG_MISSING',
    );
  }
  if (env.NODE_ENV === 'production' && !w.productionSafe) {
    throw new HttpError(
      409,
      `Refusing to point Vapi at ${w.host} — that's ${w.reason}. Leave PUBLIC_API_URL unset so it uses your Railway domain, or set it to a public https URL, then try again.`,
      'WEBHOOK_NOT_PRODUCTION_SAFE',
    );
  }
}
