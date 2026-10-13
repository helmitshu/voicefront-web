/**
 * Pulls public clinic facts (name, phone, address, hours, services) from a
 * prospect-supplied website, for the personalized receptionist demo. The URL
 * comes from a public form, so this is written like an SSRF surface, not a
 * convenience fetch:
 *  - only http/https, no credentials in the URL, no localhost, and no
 *    private/loopback/link-local IP literals as the host;
 *  - redirects are followed manually (max 3) and every hop is re-validated;
 *  - 5s timeout, 512KB body cap, and every failure returns null (the demo
 *    falls back to a clinic-name-only agent) — this never throws.
 *
 * Known limit: a public hostname that DNS-resolves to a private address is
 * not blocked (validation is on the URL literal, per the build spec); the
 * response is only ever parsed as text for a handful of regex extractions.
 */

export interface ClinicFacts {
  businessName?: string;
  phone?: string;
  address?: string;
  hours?: string[];
  services?: string[];
}

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 512 * 1024;

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums as [number, number, number, number];
  return (
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 loopback
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local
    a === 0 // 0.0.0.0/8 "this network"
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === '::1' || h === '::') return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) — judge the embedded IPv4 address.
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  const firstHextet = parseInt(h.split(':')[0] || '', 16);
  if (Number.isNaN(firstHextet)) return false;
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true; // fc00::/7 unique-local
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // fe80::/10 link-local
  return false;
}

/**
 * Validates a prospect-supplied URL for server-side fetching. Returns the
 * parsed URL when it is safe to fetch, or null when it must be refused.
 */
export function validatePublicUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL((raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return null;
  return url;
}

/* ------------------------------ extraction ------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d{1,5});/g, (_m, code: string) => {
      const n = Number(code);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&(#x[0-9a-fA-F]{1,6});/g, (_m, hex: string) => {
      const n = parseInt(hex.slice(2), 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function cleanText(value: string, max: number): string {
  return decodeEntities(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractTitle(html: string): string | undefined {
  const og =
    html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const raw = og?.[1] ?? titleTag?.[1];
  if (!raw) return undefined;
  // Titles are usually "Clinic Name | City Dentist" — the name is the first
  // segment when a spaced separator is used.
  const firstSegment = decodeEntities(raw).split(/\s+\|\s+|\s+[-–—]\s+/)[0] ?? '';
  const name = cleanText(firstSegment, 80);
  return name.length >= 3 ? name : undefined;
}

/** The dental services lexicon the extractor matches against page text. */
const SERVICE_LEXICON: Array<{ label: string; patterns: string[] }> = [
  { label: 'Cleanings', patterns: ['cleaning'] },
  { label: 'Hygiene', patterns: ['hygiene', 'hygienist'] },
  { label: 'Exams', patterns: ['exam'] },
  { label: 'Checkups', patterns: ['checkup', 'check-up', 'check up'] },
  { label: 'Fillings', patterns: ['filling'] },
  { label: 'Crowns', patterns: ['crown'] },
  { label: 'Root canals', patterns: ['root canal'] },
  { label: 'Implants', patterns: ['implant'] },
  { label: 'Invisalign', patterns: ['invisalign'] },
  { label: 'Braces', patterns: ['braces', 'orthodont'] },
  { label: 'Whitening', patterns: ['whitening'] },
  { label: 'Dentures', patterns: ['denture'] },
  { label: 'Extractions', patterns: ['extraction'] },
  { label: 'Veneers', patterns: ['veneer'] },
  { label: 'Bridges', patterns: ['dental bridge', 'bridges'] },
  { label: 'Emergency care', patterns: ['emergency'] },
];

const DAY_RE = /\b(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/i;
const TIME_RE = /(\d{1,2}(?::\d{2})?\s*(?:a\.?\s?m\.?|p\.?\s?m\.?)|\b\d{1,2}:\d{2}\b)/i;
const PHONE_RE = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/;
const ADDRESS_RE =
  /\d{1,6}\s+[\w.'\- ]{2,60}?\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Highway|Hwy|Parkway|Circle|Cir)\b\.?/i;

/**
 * Pure extraction from fetched HTML. `pageUrl` is accepted for interface
 * stability (future canonical/host checks) and is not currently needed by
 * the heuristics. Every returned string is length-capped.
 */
export function extractClinicFacts(html: string, pageUrl: string): ClinicFacts {
  void pageUrl;
  const facts: ClinicFacts = {};
  const businessName = extractTitle(html);
  if (businessName) facts.businessName = businessName;

  // Strip scripts/styles first so code and CSS never leak into the text the
  // regexes (and ultimately the prompt) see.
  const noScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // Block-level tags become line breaks so "lines" survive for hours/address.
  const withBreaks = noScripts.replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|address)>|<br\s*\/?>/gi, '\n');
  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '));
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);

  const phoneMatch = text.replace(/\s+/g, ' ').match(PHONE_RE);
  if (phoneMatch) facts.phone = cleanText(phoneMatch[0], 32);

  for (const line of lines) {
    const m = line.match(ADDRESS_RE);
    if (m) {
      facts.address = cleanText(m[0], 120);
      break;
    }
  }

  const hours: string[] = [];
  for (const line of lines) {
    if (hours.length >= 7) break;
    if (DAY_RE.test(line) && TIME_RE.test(line) && !hours.includes(line)) {
      hours.push(cleanText(line, 120));
    }
  }
  if (hours.length > 0) facts.hours = hours;

  const lowerText = text.toLowerCase();
  const services = SERVICE_LEXICON.filter((entry) => entry.patterns.some((p) => lowerText.includes(p))).map(
    (entry) => entry.label,
  );
  if (services.length > 0) facts.services = services.slice(0, 12);

  return facts;
}

/** Reads a response body with a hard byte cap (aborts the stream past it). */
async function readBodyCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    return text.slice(0, cap);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/**
 * Validates, fetches (manual redirects, each re-validated), and extracts.
 * Any failure at any step returns null — never throws.
 */
export async function fetchClinicFacts(rawUrl: string): Promise<ClinicFacts | null> {
  let current = validatePublicUrl(rawUrl);
  if (!current) return null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(current.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'VoiceFrontDemoBot/1.0 (+https://voicefront.app)',
          accept: 'text/html,application/xhtml+xml',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location || hop === MAX_REDIRECTS) return null;
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return null;
        }
        current = validatePublicUrl(next.toString());
        if (!current) return null;
        continue;
      }
      if (!res.ok) return null;
      const body = await readBodyCapped(res, MAX_BODY_BYTES);
      if (!body) return null;
      return extractClinicFacts(body, current.toString());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
