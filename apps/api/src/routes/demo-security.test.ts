import { describe, it, expect, vi, afterEach } from 'vitest';
import { peekDemoSessionId } from './inbound.routes';

/**
 * Unit tests for the demo-surface security hardening:
 * - peekDemoSessionId must only ever surface ids that start with "demo_"
 *   (the assistant-request branch treats those as demo sessions; anything
 *   else must not enter the demo path).
 * - verifyTurnstile must fail closed when a secret is configured and the
 *   token is missing/invalid, and pass through when unconfigured.
 */

describe('peekDemoSessionId', () => {
  it('extracts demo_ session ids from assistant metadata', () => {
    const body = { message: { assistant: { metadata: { demoSessionId: 'demo_abc123' } } } };
    expect(peekDemoSessionId(body)).toBe('demo_abc123');
  });

  it('extracts demo_ ids from the call.assistant metadata shape', () => {
    const body = { message: { call: { assistant: { metadata: { demoSessionId: 'demo_deep' } } } } };
    expect(peekDemoSessionId(body)).toBe('demo_deep');
  });

  it('returns null for non-demo session ids', () => {
    const body = { message: { assistant: { metadata: { demoSessionId: 'real-session-1' } } } };
    expect(peekDemoSessionId(body)).toBeNull();
    const empty = { message: { assistant: { metadata: { demoSessionId: '' } } } };
    expect(peekDemoSessionId(empty)).toBeNull();
  });

  it('returns null for missing, non-string, or malformed bodies', () => {
    expect(peekDemoSessionId(null)).toBeNull();
    expect(peekDemoSessionId(undefined)).toBeNull();
    expect(peekDemoSessionId('demo_abc')).toBeNull();
    expect(peekDemoSessionId({})).toBeNull();
    expect(peekDemoSessionId({ message: null })).toBeNull();
    expect(peekDemoSessionId({ message: { assistant: { metadata: { demoSessionId: 42 } } } })).toBeNull();
  });

  it('ignores prototype-polluting shapes safely', () => {
    const body = JSON.parse(
      '{"message":{"assistant":{"metadata":{"demoSessionId":"demo_ok"}}},"__proto__":{"message":{"assistant":{"metadata":{"demoSessionId":"demo_evil"}}}}}',
    );
    expect(peekDemoSessionId(body)).toBe('demo_ok');
  });
});

describe('verifyTurnstile', () => {
  // env.ts parses process.env once at import, so each case re-imports the
  // module with a fresh registry after stubbing TURNSTILE_SECRET_KEY.
  async function loadWithSecret(secret: string | undefined) {
    vi.resetModules();
    if (secret === undefined) vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    else process.env.TURNSTILE_SECRET_KEY = secret;
    const mod = await import('./demo.routes');
    return mod.verifyTurnstile as (token: string | undefined, ip: string | null) => Promise<boolean>;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('passes when no secret is configured (widget not enabled)', async () => {
    const verify = await loadWithSecret(undefined);
    await expect(verify('any-token', '1.2.3.4')).resolves.toBe(true);
    await expect(verify(undefined, '1.2.3.4')).resolves.toBe(true);
  });

  it('fails closed when a token is missing but a secret is configured', async () => {
    const verify = await loadWithSecret('secret');
    await expect(verify(undefined, '1.2.3.4')).resolves.toBe(false);
    await expect(verify('', '1.2.3.4')).resolves.toBe(false);
  });

  it('returns the verification verdict from Cloudflare', async () => {
    const verify = await loadWithSecret('secret');
    const ok = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', ok);
    await expect(verify('tok', '1.2.3.4')).resolves.toBe(true);

    const bad = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: false }) });
    vi.stubGlobal('fetch', bad);
    await expect(verify('tok', '1.2.3.4')).resolves.toBe(false);
  });

  it('fails closed when the verification request throws', async () => {
    const verify = await loadWithSecret('secret');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(verify('tok', '1.2.3.4')).resolves.toBe(false);
  });
});
