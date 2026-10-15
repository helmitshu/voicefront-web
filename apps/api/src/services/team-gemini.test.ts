import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for the team model client (team-gemini.ts), pinning two
 * contracts:
 *
 *  - Key resolution: a call made for a member runs on that member's own
 *    Gemini key (TEAM_GEMINI_API_KEY_<SLUG>, from their own Google
 *    project) when one is set, and falls back to the shared
 *    GEMINI_API_KEY otherwise. A call with no member always uses the
 *    shared chain and never borrows a member's key. (The discuss auto
 *    summary passes the first answering member's slug, so it runs on
 *    that member's chain; that choice is pinned at the route level.)
 *    Nothing configured anywhere is the honest 503.
 *  - Quota-aware retry: a 503 keeps the existing behaviour (3 attempts,
 *    1s then 3s backoff). A 429 means the free-tier pool is empty, so it
 *    gets exactly one retry after a 10s pause, and only when that pause
 *    fits inside the call's overall timeout. The 3-attempt total cap
 *    binds however the statuses mix: a 429 landing on the last allowed
 *    attempt buys no extra one.
 *
 * env.ts parses process.env once at import, so each case re-imports the
 * module with a fresh registry after stubbing the key vars (the same
 * pattern clinic-facts.service.test.ts uses for GEMINI_API_KEY). The
 * retry timing tests run on fake timers so the 10s pause costs nothing.
 */

const SHARED_KEY = 'shared-gemini-key';
const OMAR_KEY = 'omar-own-key';
const PRIYA_KEY = 'priya-own-key';

type KeySet = { shared?: string; omar?: string; priya?: string; daniel?: string; layla?: string };

async function loadGemini(keys: KeySet) {
  vi.resetModules();
  vi.stubEnv('GEMINI_API_KEY', keys.shared ?? '');
  vi.stubEnv('TEAM_GEMINI_API_KEY_OMAR', keys.omar ?? '');
  vi.stubEnv('TEAM_GEMINI_API_KEY_PRIYA', keys.priya ?? '');
  vi.stubEnv('TEAM_GEMINI_API_KEY_DANIEL', keys.daniel ?? '');
  vi.stubEnv('TEAM_GEMINI_API_KEY_LAYLA', keys.layla ?? '');
  return import('./team-gemini');
}

type FetchCall = { url: string; apiKey: string | undefined };

/** Stubs global fetch as Gemini; the handler picks a status per call index. */
function stubFetch(handler: (callIndex: number) => number) {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), apiKey: init?.headers?.['x-goog-api-key'] });
    const status = handler(calls.length - 1);
    if (status === 200) {
      return {
        ok: true,
        status,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'A reply.' }] } }] }),
        text: async () => '',
      };
    }
    return { ok: false, status, json: async () => ({}), text: async () => `status ${status}` };
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

const PARAMS = {
  model: 'gemini-3.8-flash',
  systemText: 'You are a team member.',
  contents: [{ role: 'user', parts: [{ text: 'Hello.' }] }],
} as const;

/** Drains pending microtasks without touching (fake) time. */
async function flushMicrotasks(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('team model client: per-member key resolution', () => {
  it("uses the member's own key when their env var is set", async () => {
    const gemini = await loadGemini({ shared: SHARED_KEY, omar: OMAR_KEY });
    const calls = stubFetch(() => 200);

    const parts = await gemini.callTeamModel({ ...PARAMS, memberSlug: 'omar' });

    expect(parts).toEqual([{ text: 'A reply.' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].apiKey).toBe(OMAR_KEY);
  });

  it('falls back to the shared key when the member var is unset', async () => {
    const gemini = await loadGemini({ shared: SHARED_KEY });
    const calls = stubFetch(() => 200);

    await gemini.callTeamModel({ ...PARAMS, memberSlug: 'daniel' });

    expect(calls).toHaveLength(1);
    expect(calls[0].apiKey).toBe(SHARED_KEY);
  });

  it('runs member conversations on the member key through every tool round', async () => {
    const gemini = await loadGemini({ shared: SHARED_KEY, priya: PRIYA_KEY });
    const calls = stubFetch(() => 200);

    const text = await gemini.runMemberConversation({
      model: 'gemini-3.8-flash',
      memberSlug: 'priya',
      systemText: 'You are Priya Nair.',
      contents: [{ role: 'user', parts: [{ text: 'Score this.' }] }],
      executeTool: async () => ({}),
    });

    expect(text).toBe('A reply.');
    expect(calls).toHaveLength(1);
    expect(calls[0].apiKey).toBe(PRIYA_KEY);
  });

  it('a call with no member uses the shared key even when member keys are set', async () => {
    const gemini = await loadGemini({ shared: SHARED_KEY, omar: OMAR_KEY, priya: PRIYA_KEY });
    const calls = stubFetch(() => 200);

    // No memberSlug: the shared chain, never a member's key.
    await gemini.callTeamModel({ ...PARAMS });

    expect(calls).toHaveLength(1);
    expect(calls[0].apiKey).toBe(SHARED_KEY);
  });

  it("a call with no member never borrows a member's key when the shared key is unset", async () => {
    const gemini = await loadGemini({ omar: OMAR_KEY });
    const calls = stubFetch(() => 200);

    await expect(gemini.callTeamModel({ ...PARAMS })).rejects.toMatchObject({
      status: 503,
      code: 'MODEL_NOT_CONFIGURED',
    });
    expect(calls).toHaveLength(0);
  });

  it('a member with nothing configured anywhere gets the honest 503', async () => {
    const gemini = await loadGemini({});
    const calls = stubFetch(() => 200);

    await expect(gemini.callTeamModel({ ...PARAMS, memberSlug: 'layla' })).rejects.toMatchObject({
      status: 503,
      code: 'MODEL_NOT_CONFIGURED',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('team model client: quota-aware retry', () => {
  it('a 429 gets exactly one retry, after the 10s pause, on the same key', async () => {
    vi.useFakeTimers();
    const gemini = await loadGemini({ shared: SHARED_KEY, omar: OMAR_KEY });
    const calls = stubFetch((index) => (index === 0 ? 429 : 200));

    const promise = gemini.callTeamModel({ ...PARAMS, memberSlug: 'omar' });
    await flushMicrotasks();
    expect(calls).toHaveLength(1);

    // The pause is real: at 9.999s the retry has not fired.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await expect(promise).resolves.toEqual([{ text: 'A reply.' }]);
    expect(calls.map((c) => c.apiKey)).toEqual([OMAR_KEY, OMAR_KEY]);
  });

  it('a persistent 429 stops after two attempts in the honest 502', async () => {
    vi.useFakeTimers();
    const gemini = await loadGemini({ shared: SHARED_KEY });
    const calls = stubFetch(() => 429);

    const promise = gemini.callTeamModel({ ...PARAMS, memberSlug: 'omar' });
    const rejected = expect(promise).rejects.toMatchObject({ status: 502, code: 'MODEL_ERROR' });
    await flushMicrotasks();
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect(calls).toHaveLength(2);

    // No third attempt, however long the caller waits.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
    await rejected;
  });

  it('a 429 is not retried when the 10s pause cannot fit the remaining budget', async () => {
    vi.useFakeTimers();
    const gemini = await loadGemini({ shared: SHARED_KEY });
    const calls = stubFetch(() => 429);

    await expect(gemini.callTeamModel({ ...PARAMS, timeoutMs: 5_000 })).rejects.toMatchObject({
      status: 502,
      code: 'MODEL_ERROR',
    });
    expect(calls).toHaveLength(1);
  });

  it('a mixed 503/503/429 sequence stops at 3 attempts total, the 429 buys no extra one', async () => {
    vi.useFakeTimers();
    const gemini = await loadGemini({ shared: SHARED_KEY });
    // The stub would keep answering 429; a fourth call must never fire.
    const statuses = [503, 503, 429, 429, 429];
    const calls = stubFetch((index) => statuses[Math.min(index, statuses.length - 1)]);

    const promise = gemini.callTeamModel({ ...PARAMS, memberSlug: 'omar' });
    const rejected = expect(promise).rejects.toMatchObject({ status: 502, code: 'MODEL_ERROR' });
    await flushMicrotasks();
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();
    expect(calls).toHaveLength(3);

    // The 429 landed on the last allowed attempt: no 10s pause is
    // scheduled and no fourth attempt ever fires.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3);
    await rejected;
  });

  it('a persistent 503 keeps the existing behaviour: 3 attempts, 1s then 3s backoff', async () => {
    vi.useFakeTimers();
    const gemini = await loadGemini({ shared: SHARED_KEY });
    const calls = stubFetch(() => 503);

    const promise = gemini.callTeamModel({ ...PARAMS, memberSlug: 'priya' });
    const rejected = expect(promise).rejects.toMatchObject({ status: 502, code: 'MODEL_ERROR' });
    await flushMicrotasks();
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(calls).toHaveLength(3);

    await rejected;
  });
});
