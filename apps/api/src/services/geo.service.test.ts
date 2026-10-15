import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectIpCountry, parsePublicIp } from './geo.service';

/**
 * Service tests for geo.service: the success-only country cache (a second
 * lookup for the same IP must not re-fetch; failures must never be cached)
 * and the parsePublicIp validator behind the x-visitor-ip header contract.
 * The network is stubbed the same way the other service tests stub it.
 * Each test uses its own IP so the module-level cache cannot leak between
 * cases.
 */

const fetchStub = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchStub.mockReset();
});

function okCountry(country: string) {
  return { ok: true, text: async () => `${country}\n` };
}

describe('detectIpCountry cache', () => {
  it('serves a second lookup for the same IP from cache without re-fetching', async () => {
    fetchStub.mockResolvedValue(okCountry('CA'));
    vi.stubGlobal('fetch', fetchStub);

    await expect(detectIpCountry('203.0.113.10')).resolves.toBe('CA');
    await expect(detectIpCountry('203.0.113.10')).resolves.toBe('CA');
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][0]).toContain('203.0.113.10');
  });

  it('does not cache a non-OK response', async () => {
    fetchStub
      .mockResolvedValueOnce({ ok: false, text: async () => '' })
      .mockResolvedValue(okCountry('US'));
    vi.stubGlobal('fetch', fetchStub);

    await expect(detectIpCountry('203.0.113.11')).resolves.toBeNull();
    await expect(detectIpCountry('203.0.113.11')).resolves.toBe('US');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('does not cache a network error', async () => {
    fetchStub
      .mockRejectedValueOnce(new Error('socket hangup'))
      .mockResolvedValue(okCountry('CA'));
    vi.stubGlobal('fetch', fetchStub);

    await expect(detectIpCountry('203.0.113.12')).resolves.toBeNull();
    await expect(detectIpCountry('203.0.113.12')).resolves.toBe('CA');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('does not cache an invalid country body', async () => {
    fetchStub
      .mockResolvedValueOnce({ ok: true, text: async () => 'Rate limited' })
      .mockResolvedValue(okCountry('CA'));
    vi.stubGlobal('fetch', fetchStub);

    await expect(detectIpCountry('203.0.113.13')).resolves.toBeNull();
    await expect(detectIpCountry('203.0.113.13')).resolves.toBe('CA');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});

describe('parsePublicIp', () => {
  it('accepts a public IPv4 address and trims whitespace', () => {
    expect(parsePublicIp(' 198.51.100.23 ')).toBe('198.51.100.23');
  });

  it('accepts a public IPv6 address', () => {
    expect(parsePublicIp('2606:4700:4700::1111')).toBe('2606:4700:4700::1111');
  });

  it('strips an IPv4-mapped IPv6 prefix before validating', () => {
    expect(parsePublicIp('::ffff:198.51.100.23')).toBe('198.51.100.23');
    expect(parsePublicIp('::ffff:10.0.0.1')).toBeNull();
  });

  it('takes the first value when the header arrives as an array', () => {
    expect(parsePublicIp(['198.51.100.23', '10.0.0.1'])).toBe('198.51.100.23');
  });

  it('rejects private, loopback, and link-local addresses', () => {
    expect(parsePublicIp('10.1.2.3')).toBeNull();
    expect(parsePublicIp('192.168.0.9')).toBeNull();
    expect(parsePublicIp('172.16.5.5')).toBeNull();
    expect(parsePublicIp('127.0.0.1')).toBeNull();
    expect(parsePublicIp('::1')).toBeNull();
    expect(parsePublicIp('fd00::1')).toBeNull();
  });

  it('rejects garbage and missing values', () => {
    expect(parsePublicIp('not-an-ip')).toBeNull();
    expect(parsePublicIp('999.1.1.1')).toBeNull();
    expect(parsePublicIp('198.51.100.23, 10.0.0.1')).toBeNull();
    expect(parsePublicIp('')).toBeNull();
    expect(parsePublicIp(undefined)).toBeNull();
  });
});
