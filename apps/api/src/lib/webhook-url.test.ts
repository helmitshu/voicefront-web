import { describe, it, expect } from 'vitest';
import { classifyWebhookHost } from './webhook-url';

describe('classifyWebhookHost', () => {
  it('treats a public https host (Railway domain) as production-safe', () => {
    const r = classifyWebhookHost('https://voicefrontapi-production.up.railway.app');
    expect(r.productionSafe).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.host).toBe('voicefrontapi-production.up.railway.app');
  });

  it('flags ngrok and other dev tunnels', () => {
    for (const url of [
      'https://abc123.ngrok-free.app',
      'https://abc.ngrok.io',
      'https://x.trycloudflare.com',
      'https://y.loca.lt',
    ]) {
      const r = classifyWebhookHost(url);
      expect(r.productionSafe, url).toBe(false);
      expect(r.reason, url).toMatch(/tunnel/i);
    }
  });

  it('flags localhost', () => {
    expect(classifyWebhookHost('https://localhost:4000').productionSafe).toBe(false);
    expect(classifyWebhookHost('https://127.0.0.1').productionSafe).toBe(false);
  });

  it('flags non-https URLs', () => {
    const r = classifyWebhookHost('http://example.com');
    expect(r.productionSafe).toBe(false);
    expect(r.reason).toMatch(/https/);
  });

  it('flags an unparseable URL', () => {
    expect(classifyWebhookHost('not a url').productionSafe).toBe(false);
  });
});
