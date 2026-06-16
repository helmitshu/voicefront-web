import type { Request } from 'express';

/**
 * Geo gating for the public sales demo. The "Get a call" (outbound) option is
 * only offered when we can reasonably reach the visitor: their IP geolocates to
 * the US/Canada, OR the phone number they typed is a North-American (+1) number.
 * Everyone else is steered to the in-browser test, which works worldwide.
 *
 * Both signals are best-effort and degrade gracefully — a failed IP lookup or an
 * unparseable number simply doesn't contribute a "yes", it never hard-blocks.
 */

/** Countries allowed to receive an outbound demo call. */
const CALLABLE_COUNTRIES = new Set(['US', 'CA']);

/** A few common country dialing codes, for nicer founder-facing labels. */
const DIAL_CODE_TO_COUNTRY: Record<string, string> = {
  '1': 'US/CA',
  '44': 'GB',
  '61': 'AU',
  '91': 'IN',
  '52': 'MX',
  '49': 'DE',
  '33': 'FR',
  '34': 'ES',
  '39': 'IT',
  '55': 'BR',
  '81': 'JP',
  '86': 'CN',
  '971': 'AE',
  '966': 'SA',
  '234': 'NG',
  '27': 'ZA',
};

export interface PhoneCountry {
  /** "US/CA", an ISO-ish label, or null when we can't tell. */
  country: string | null;
  /** True when the number is a North-American (+1) number. */
  isNanp: boolean;
}

/**
 * Best-effort country detection from a typed phone number. The only distinction
 * that matters for gating is "+1 / NANP vs. not", which we can determine without
 * a full phone library.
 */
export function detectPhoneCountry(raw: string): PhoneCountry {
  const trimmed = (raw ?? '').trim();
  const hadPlus = trimmed.startsWith('+') || trimmed.startsWith('00');
  const digits = trimmed.replace(/[^\d]/g, '').replace(/^00/, '');

  // North-American Numbering Plan: 10 digits, or 11 digits starting with 1.
  const isNanp =
    (digits.length === 11 && digits.startsWith('1')) ||
    (!hadPlus && digits.length === 10);
  if (isNanp) return { country: 'US/CA', isNanp: true };

  if (hadPlus && digits.length > 0) {
    // Match the longest known dialing code (1–3 digits).
    for (let len = 3; len >= 1; len--) {
      const code = digits.slice(0, len);
      if (DIAL_CODE_TO_COUNTRY[code]) {
        const country = DIAL_CODE_TO_COUNTRY[code];
        return { country, isNanp: code === '1' };
      }
    }
    return { country: `+${digits.slice(0, 3)}`, isNanp: false };
  }

  return { country: null, isNanp: false };
}

/** Pulls the real client IP from the proxy chain (Railway sets X-Forwarded-For). */
export function clientIp(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  const fromHeader = Array.isArray(xff) ? xff[0] : xff;
  const candidate = (fromHeader?.split(',')[0] ?? req.ip ?? '').trim();
  if (!candidate) return null;
  // Strip an IPv4-mapped IPv6 prefix (::ffff:1.2.3.4).
  return candidate.replace(/^::ffff:/, '');
}

/** Private / loopback ranges we never bother geolocating. */
function isPrivateIp(ip: string): boolean {
  return (
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith('fc') ||
    ip.startsWith('fd')
  );
}

/**
 * Resolves a client IP to a 2-letter country code via ipapi.co. Best-effort:
 * returns null on private IPs, timeouts, rate limits, or any error — callers
 * must treat null as "unknown", never as "blocked".
 */
export async function detectIpCountry(ip: string | null): Promise<string | null> {
  if (!ip || isPrivateIp(ip)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/country/`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'voicefront-demo/1.0' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const country = (await res.text()).trim().toUpperCase();
    return /^[A-Z]{2}$/.test(country) ? country : null;
  } catch {
    return null;
  }
}

export interface GateResult {
  ipCountry: string | null;
  phone: PhoneCountry;
  /** True when the visitor may receive an outbound call. */
  callAllowed: boolean;
}

/**
 * Computes which demo modes a visitor may use. Web is always allowed; "Get a
 * call" requires a US/CA IP OR a North-American phone number.
 */
export async function evaluateGate(ip: string | null, phone: string): Promise<GateResult> {
  const [ipCountry, phoneInfo] = await Promise.all([
    detectIpCountry(ip),
    Promise.resolve(detectPhoneCountry(phone)),
  ]);
  const ipCallable = ipCountry ? CALLABLE_COUNTRIES.has(ipCountry) : false;
  return {
    ipCountry,
    phone: phoneInfo,
    callAllowed: ipCallable || phoneInfo.isNanp,
  };
}
