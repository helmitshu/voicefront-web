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
 * A model failure is an honest 502 (MODEL_ERROR / MODEL_NOT_CONFIGURED).
 * Nothing in this layer ever invents a reply: if Gemini is down, the
 * caller surfaces the error and no member message is stored.
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

function generateUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export function teamModelApiKey(): string | undefined {
  return (env.GEMINI_API_KEY ?? '').trim() || undefined;
}

/** One raw model call. Returns the candidate parts or throws HttpError 502/503. */
export async function callTeamModel(params: {
  model: string;
  systemText: string;
  contents: TeamGeminiContent[];
  functionDeclarations?: TeamFunctionDeclaration[];
  timeoutMs?: number;
}): Promise<TeamGeminiPart[]> {
  const apiKey = teamModelApiKey();
  if (!apiKey) {
    console.warn('[team] GEMINI_API_KEY is not configured; team replies are unavailable.');
    throw new HttpError(503, 'The team is unavailable right now (model not configured).', 'MODEL_NOT_CONFIGURED');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? MODEL_TIMEOUT_MS);
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
    if (err instanceof HttpError) throw err;
    console.warn(
      `[team] Gemini request error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
    throw new HttpError(502, 'The team member could not answer just now. Please try again.', 'MODEL_ERROR');
  } finally {
    clearTimeout(timer);
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
}): Promise<string> {
  const maxRounds = params.maxToolRounds ?? 3;
  const contents: TeamGeminiContent[] = [...params.contents];
  for (let round = 0; round <= maxRounds; round++) {
    const parts = await callTeamModel({
      model: params.model,
      systemText: params.systemText,
      contents,
      functionDeclarations: params.functionDeclarations,
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
