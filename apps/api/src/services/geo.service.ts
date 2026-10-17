import { isIP } from 'node:net';
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
 * Validates an IP supplied in a header value. The web tier sends the visitor
 * IP as `x-visitor-ip` on its server-to-server call to the geo endpoint,
 * because the X-Forwarded-For chain does not survive that hop (the API edge
 * only sees the web service's egress, not the browser's). Returns the
 * normalized IP only when the value is a syntactically valid, publicly
 * routable address; anything else returns null so the caller falls back to
 * the connection IP. Accepts the raw header value, which Express may
 * surface as a string array.
 */
export function parsePublicIp(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  // Strip an IPv4-mapped IPv6 prefix (::ffff:1.2.3.4), like clientIp does.
  const candidate = raw.trim().replace(/^::ffff:/, '');
  if (!candidate || isIP(candidate) === 0) return null;
  return isPrivateIp(candidate) ? null : candidate;
}

/**
 * Successful country lookups are cached in memory for a day, keyed by IP.
 * One clinic's staff share an egress IP, so repeat pricing-page renders and
 * demo-gate checks mostly hit the cache instead of ipapi.co's free tier.
 * Failures (null) are never cached: a rate-limited lookup must be retried on
 * the next request, not remembered. Bounded size, oldest evicted first.
 */
const COUNTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const COUNTRY_CACHE_MAX_ENTRIES = 500;
const countryCache = new Map<string, { country: string; cachedAt: number }>();

function readCountryCache(ip: string): string | null {
  const entry = countryCache.get(ip);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > COUNTRY_CACHE_TTL_MS) {
    countryCache.delete(ip);
    return null;
  }
  // Refresh recency so active IPs are evicted last.
  countryCache.delete(ip);
  countryCache.set(ip, entry);
  return entry.country;
}

function writeCountryCache(ip: string, country: string): void {
  countryCache.delete(ip);
  countryCache.set(ip, { country, cachedAt: Date.now() });
  while (countryCache.size > COUNTRY_CACHE_MAX_ENTRIES) {
    const oldest = countryCache.keys().next().value;
    if (oldest === undefined) break;
    countryCache.delete(oldest);
  }
}

/**
 * Resolves a client IP to a 2-letter country code via ipapi.co. Best-effort:
 * returns null on private IPs, timeouts, rate limits, or any error — callers
 * must treat null as "unknown", never as "blocked". Successful results are
 * served from the in-memory cache above; failures always re-lookup.
 */
export async function detectIpCountry(ip: string | null): Promise<string | null> {
  if (!ip || isPrivateIp(ip)) return null;
  const cached = readCountryCache(ip);
  if (cached) return cached;
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
    if (!/^[A-Z]{2}$/.test(country)) return null;
    writeCountryCache(ip, country);
    return country;
  } catch {
    return null;
  }
}

/**
 * Approximate, IP-derived location for the admin visitor map. Everything
 * here comes from the same ipapi.co lookup family as detectIpCountry —
 * network-based geolocation is city-level at best and often only right to
 * the metro area, so consumers must label it approximate. The raw IP is
 * used only as the lookup key (and the in-memory cache key below, exactly
 * like the country cache); it is never returned or persisted.
 */
export interface IpLocation {
  country: string;
  city: string | null;
  region: string | null;
  lat: number | null;
  lng: number | null;
}

const LOCATION_CACHE_TTL_MS = COUNTRY_CACHE_TTL_MS;
const LOCATION_CACHE_MAX_ENTRIES = COUNTRY_CACHE_MAX_ENTRIES;
const locationCache = new Map<string, { location: IpLocation; cachedAt: number }>();

function readLocationCache(ip: string): IpLocation | null {
  const entry = locationCache.get(ip);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > LOCATION_CACHE_TTL_MS) {
    locationCache.delete(ip);
    return null;
  }
  locationCache.delete(ip);
  locationCache.set(ip, entry);
  return entry.location;
}

function writeLocationCache(ip: string, location: IpLocation): void {
  locationCache.delete(ip);
  locationCache.set(ip, { location, cachedAt: Date.now() });
  while (locationCache.size > LOCATION_CACHE_MAX_ENTRIES) {
    const oldest = locationCache.keys().next().value;
    if (oldest === undefined) break;
    locationCache.delete(oldest);
  }
}

function cleanPlaceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 80);
  return trimmed.length > 0 ? trimmed : null;
}

function cleanCoordinate(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value >= min && value <= max ? value : null;
}

/**
 * Resolves a client IP to an approximate location via ipapi.co's JSON
 * endpoint. Best-effort like detectIpCountry: null on private IPs,
 * timeouts, rate limits, malformed payloads, or any error. Successful
 * results are cached in memory for a day, keyed by IP; failures are never
 * cached. Returns derived fields only — never the IP itself.
 */
export async function detectIpLocation(ip: string | null): Promise<IpLocation | null> {
  if (!ip || isPrivateIp(ip)) return null;
  const cached = readLocationCache(ip);
  if (cached) return cached;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'voicefront-demo/1.0' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const country = typeof body.country_code === 'string' ? body.country_code.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(country)) return null;
    const location: IpLocation = {
      country,
      city: cleanPlaceName(body.city),
      region: cleanPlaceName(body.region),
      lat: cleanCoordinate(body.latitude, -90, 90),
      lng: cleanCoordinate(body.longitude, -180, 180),
    };
    writeLocationCache(ip, location);
    return location;
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
