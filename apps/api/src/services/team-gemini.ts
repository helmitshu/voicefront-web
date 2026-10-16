import { env } from '../config/env';
import { HttpError } from '../lib/http';

/**
 * The team members' model client. Same platform pattern as the support
 * agent and the clinic-facts reader: a plain fetch to Gemini's
 * generateContent with the x-goog-api-key header, a hard timeout, and
 * logged failures. The model id is a per-member config value
 * (TeamMember.modelConfig, default gemini-3.8-flash); the key comes from
 * the server environment only and never reaches a payload or the browser.
 *
 * Keys are per member too: each seat can carry its own Gemini key from
 * its own Google project (TEAM_GEMINI_API_KEY_<SLUG>), so one member's
 * free-tier quota burn cannot starve the others. A member with no key
 * of their own falls back to the shared GEMINI_API_KEY (the key Adam
 * and the clinic-facts reader also use). The discuss auto summary
 * borrows the key of the first member who answered, so a drained
 * shared pool cannot kill a discussion the members did finish; it
 * falls back to the shared key when it has no answerer to borrow from,
 * and calls that belong to no member at all use the shared key.
 *
 * A model failure is an honest 502 (MODEL_ERROR / MODEL_NOT_CONFIGURED).
 * Nothing in this layer ever invents a reply: if Gemini is down, the
 * caller surfaces the error and no member message is stored.
 *
 * Transient overload is real, though, and the two transient statuses
 * are not the same. A 503 ("high demand") clears in seconds, so it is
 * retried with backoff inside one overall timeout. A 429 on a free
 * tier means the quota pool is empty: fast retries only burn it
 * further, so a 429 gets exactly one retry after a long pause, and
 * only when that pause still fits inside the overall timeout. Either
 * way, one call never exceeds MAX_MODEL_ATTEMPTS attempts in total,
 * however the statuses mix.
 * Non-transient errors (400, 401, 403, 404, anything else) are never
 * retried: they would fail the same way three times.
 */

export interface TeamGeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: unknown } };
}

export interface TeamGeminiContent {
  role: 'user' | 'model';
  parts: TeamGeminiPart[];
}

export interface TeamFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const MODEL_TIMEOUT_MS = 45_000;
const MAX_MODEL_ATTEMPTS = 3;
/** Backoff before attempt 2 and attempt 3 on a 503. */
const RETRY_BACKOFF_MS = [1_000, 3_000];
/**
 * The one pause before retrying a 429. Quota exhaustion does not clear
 * in a second or two; a single slow retry is the whole policy.
 */
const QUOTA_RETRY_PAUSE_MS = 10_000;
/** Gemini statuses worth retrying: overloaded or rate limited. */
const TRANSIENT_STATUSES = new Set([429, 503]);

/** Marker for a failure the retry loop may try again. Never escapes. */
class TransientModelError extends Error {
  constructor(readonly status: number) {
    super(`Transient Gemini failure, status ${status}`);
  }
}

/**
 * Marker for a call whose transient retries ran out (the last failure
 * was a 429 or a 503). Internal: callTeamModel converts it to the
 * honest 502, after giving the shared-key fallback its chance when the
 * failed call ran on a member's own key. Never escapes this module.
 */
class TransientExhaustedError extends Error {
  constructor(readonly status: number | null) {
    super(`Transient Gemini failures exhausted retries (last status ${status ?? 'none'})`);
  }
}

/** The shared paid Gemini key, when configured. */
function sharedApiKey(): string | undefined {
  return (env.GEMINI_API_KEY ?? '').trim() || undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

/** A member's own Gemini key from their per-seat env var, if one is set. */
function memberApiKey(memberSlug: string): string | undefined {
  const bySlug: Record<string, string | undefined> = {
    omar: env.TEAM_GEMINI_API_KEY_OMAR,
    priya: env.TEAM_GEMINI_API_KEY_PRIYA,
    daniel: env.TEAM_GEMINI_API_KEY_DANIEL,
    layla: env.TEAM_GEMINI_API_KEY_LAYLA,
  };
  return (bySlug[memberSlug.trim().toLowerCase()] ?? '').trim() || undefined;
}

/**
 * The key a model call runs on. A call made for a member uses that
 * member's own key when one is set, and falls back to the shared
 * GEMINI_API_KEY otherwise; a call with no member uses the shared key.
 * (The discuss auto summary passes the first answering member's slug,
 * so it runs on that member's chain.) Undefined when nothing in the
 * chain is configured.
 *
 * Run-scoped override (Phase 2a): scheduled ability runs pass
 * `useSharedKey`, and the call runs on the shared paid GEMINI_API_KEY
 * even when the member has a free-tier key of their own, so the clock
 * never drains a member's small free pool. Interactive member chat
 * never sets it and keeps the per-member chain above.
 */
export function teamModelApiKey(
  memberSlug?: string,
  opts?: { useSharedKey?: boolean },
): string | undefined {
  if (memberSlug && !opts?.useSharedKey) {
    const own = memberApiKey(memberSlug);
    if (own) return own;
  }
  return (env.GEMINI_API_KEY ?? '').trim() || undefined;
}

type CallTeamModelParams = {
  model: string;
  systemText: string;
  contents: TeamGeminiContent[];
  functionDeclarations?: TeamFunctionDeclaration[];
  timeoutMs?: number;
  /**
   * The member this call is made for, when it is made for one. Selects
   * the per-member key chain; omit for calls that belong to no member,
   * which run on the shared key.
   */
  memberSlug?: string;
  /**
   * Run-scoped override: when true, this call runs on the shared paid
   * GEMINI_API_KEY regardless of the member's own key. Set by
   * scheduled ability runs (Phase 2a); never by interactive chat.
   */
  useSharedKey?: boolean;
};

/** A single attempt, bounded by timeoutMs. Throws TransientModelError for 429/503. */
async function attemptTeamModelOnce(
  params: CallTeamModelParams,
  apiKey: string,
  timeoutMs: number,
): Promise<TeamGeminiPart[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(generateUrl(params.model), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: params.systemText }] },
        contents: params.contents,
        ...(params.functionDeclarations && params.functionDeclarations.length > 0
          ? {
              tools: [{ functionDeclarations: params.functionDeclarations }],
              toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
            }
          : {}),
        generationConfig: {
          temperature: 0.4,
          // Gemini 3 models think before answering by default; LOW is the
          // lowest level gemini-3.8-flash supports and keeps a team reply
          // near-instant (same control the clinic-facts reader uses).
          thinkingConfig: { thinkingLevel: 'LOW' },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[team] Gemini request failed, status ${res.status}: ${body.slice(0, 200)}`);
      if (TRANSIENT_STATUSES.has(res.status)) throw new TransientModelError(res.status);
      throw new HttpError(502, 'The team member could not answer just now. Please try again.', 'MODEL_ERROR');
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: TeamGeminiPart[] } }>;
    };
    const parts = data.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) {
      console.warn('[team] Gemini response had no content parts.');
      throw new HttpError(502, 'The team member could not answer just now. Please try again.', 'MODEL_ERROR');
    }
    return parts;
  } catch (err) {
    if (err instanceof HttpError || err instanceof TransientModelError) throw err;
    console.warn(
      `[team] Gemini request error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
    throw new HttpError(502, 'The team member could not answer just now. Please try again.', 'MODEL_ERROR');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One logical model call on one key, under the transient retry
 * contract: retries happen inside one overall timeout, but by status:
 * a 503 retries with backoff, while a 429 gets a single retry after
 * QUOTA_RETRY_PAUSE_MS (and only when that pause still leaves time for
 * the attempt). Both policies share one cap: MAX_MODEL_ATTEMPTS
 * attempts in total, however the statuses mix; anything else fails on
 * the first attempt. Throws TransientExhaustedError when the transient
 * retries run out; non-transient failures throw their HttpError.
 */
async function callWithRetries(
  params: CallTeamModelParams,
  apiKey: string,
): Promise<TeamGeminiPart[]> {
  const deadline = Date.now() + (params.timeoutMs ?? MODEL_TIMEOUT_MS);
  let lastTransientStatus: number | null = null;
  let attempts = 0;
  let quotaRetried = false;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    attempts += 1;
    try {
      return await attemptTeamModelOnce(params, apiKey, remaining);
    } catch (err) {
      if (!(err instanceof TransientModelError)) throw err;
      lastTransientStatus = err.status;
      console.warn(`[team] Gemini transient failure, status ${err.status} (attempt ${attempts}).`);
      if (err.status === 429) {
        // Quota, not weather: the pool is empty and fast retries only
        // burn what is left of it. One slow retry, if it fits. The
        // total attempt cap binds here too: a 429 landing on the last
        // allowed attempt buys no extra one, whatever came before it.
        if (quotaRetried) break;
        if (attempts >= MAX_MODEL_ATTEMPTS) break;
        quotaRetried = true;
        if (Date.now() + QUOTA_RETRY_PAUSE_MS >= deadline) break;
        await sleep(QUOTA_RETRY_PAUSE_MS);
        continue;
      }
      // 503: the existing bounded backoff, MAX_MODEL_ATTEMPTS total.
      if (attempts >= MAX_MODEL_ATTEMPTS) break;
      const backoff = RETRY_BACKOFF_MS[attempts - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
      if (Date.now() + backoff >= deadline) break;
      await sleep(backoff);
    }
  }
  console.warn(
    `[team] Gemini still unavailable after retries (last status ${lastTransientStatus ?? 'none'}); giving up on this key.`,
  );
  throw new TransientExhaustedError(lastTransientStatus);
}

/**
 * One logical model call. Returns the candidate parts or throws
 * HttpError 502/503.
 *
 * Reliability fallback (Phase 2a): an interactive call made for a
 * member runs first on that member's own key under the retry contract
 * above. If the member key's pool is what failed (the retries end in a
 * 429 or a 503), the call is retried once on the shared paid key, when
 * one is set and it is not the key that just failed. One member's
 * drained free-tier pool should not silence them while the paid key
 * has room. The fallback firing is logged in one line naming the
 * member; key values are never logged. If the fallback also fails,
 * the failure is the same honest 502 as before, and no reply is ever
 * invented. Calls already on the shared key (no member, a member with
 * no key of their own, or a scheduled run's useSharedKey override)
 * have nothing to fall back to and skip this entirely, and a
 * non-transient failure (a 400, say) never triggers it: the shared key
 * would fail the same way.
 */
export async function callTeamModel(params: CallTeamModelParams): Promise<TeamGeminiPart[]> {
  const apiKey = teamModelApiKey(params.memberSlug, { useSharedKey: params.useSharedKey });
  if (!apiKey) {
    console.warn('[team] GEMINI_API_KEY is not configured; team replies are unavailable.');
    throw new HttpError(503, 'The team is unavailable right now (model not configured).', 'MODEL_NOT_CONFIGURED');
  }
  try {
    return await callWithRetries(params, apiKey);
  } catch (err) {
    if (!(err instanceof TransientExhaustedError)) throw err;
    const memberOwnKey =
      params.memberSlug && !params.useSharedKey ? memberApiKey(params.memberSlug) : undefined;
    const shared = sharedApiKey();
    if (!memberOwnKey || !shared || shared === apiKey) {
      throw new HttpError(
        502,
        'The team member could not answer just now. Please try again.',
        'MODEL_ERROR',
      );
    }
    console.warn(
      `[team] Member ${params.memberSlug} could not answer on their own key (last status ${err.status ?? 'none'}); retried on the shared fallback key.`,
    );
    try {
      return await callWithRetries(params, shared);
    } catch (fallbackErr) {
      if (fallbackErr instanceof TransientExhaustedError) {
        throw new HttpError(
          502,
          'The team member could not answer just now. Please try again.',
          'MODEL_ERROR',
        );
      }
      throw fallbackErr;
    }
  }
}

export function partsToText(parts: TeamGeminiPart[]): string {
  return parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

/**
 * A full member turn: call the model, execute any function calls it makes
 * through the supplied executor (the tier-enforced, logged tool runtime),
 * feed results back, and repeat a bounded number of rounds until the model
 * answers in words. Returns the final text.
 */
export async function runMemberConversation(params: {
  model: string;
  systemText: string;
  contents: TeamGeminiContent[];
  functionDeclarations?: TeamFunctionDeclaration[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  maxToolRounds?: number;
  /** The member holding this conversation; selects their key chain. */
  memberSlug?: string;
  /** Run-scoped override: run every round on the shared paid key. */
  useSharedKey?: boolean;
}): Promise<string> {
  const maxRounds = params.maxToolRounds ?? 3;
  const contents: TeamGeminiContent[] = [...params.contents];
  for (let round = 0; round <= maxRounds; round++) {
    const parts = await callTeamModel({
      model: params.model,
      systemText: params.systemText,
      contents,
      functionDeclarations: params.functionDeclarations,
      memberSlug: params.memberSlug,
      useSharedKey: params.useSharedKey,
    });
    const calls = parts.filter((part) => part.functionCall?.name);
    if (calls.length === 0) {
      const text = partsToText(parts);
      if (!text) {
        throw new HttpError(502, 'The team member could not answer just now. Please try again.', 'MODEL_ERROR');
      }
      return text;
    }
    if (round === maxRounds) {
      throw new HttpError(502, 'The team member got stuck in a tool loop. Please try again.', 'MODEL_ERROR');
    }
    // Echo the model's function-call turn, then answer each call.
    contents.push({ role: 'model', parts });
    const responseParts: TeamGeminiPart[] = [];
    for (const call of calls) {
      const name = call.functionCall!.name;
      const args = (call.functionCall?.args ?? {}) as Record<string, unknown>;
      let result: unknown;
      try {
        result = await params.executeTool(name, args);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      responseParts.push({ functionResponse: { name, response: { result } } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  // Unreachable: the loop either returns text or throws on the last round.
  throw new HttpError(502, 'The team member could not answer just now. Please try again.', 'MODEL_ERROR');
}
