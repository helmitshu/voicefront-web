import { headers } from 'next/headers';

/**
 * Server-side visitor country for the marketing pages. The API is the
 * single geolocation source: it resolves the country from the visitor's
 * IP with the same mechanism the demo geo gate uses (see the API's
 * geo.service).
 *
 * The visitor IP travels in a dedicated `x-visitor-ip` header, taken
 * from the first hop of this page request's X-Forwarded-For. Forwarding
 * X-Forwarded-For itself does not work on this server-to-server hop:
 * the platform proxy rewrites the chain, so the API ends up resolving
 * the web service's egress IP (or nothing) instead of the browser's.
 * The API validates the header and falls back to the connection IP.
 *
 * Display only. The currency a visitor sees here never decides what an
 * account is billed: that follows the tenant's verified pricing region
 * on the API. Any failure (API down, unknown IP) resolves to null,
 * which the pricing pages render as USD, the default price book.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function getVisitorCountry(): Promise<string | null> {
  try {
    const forwardedFor = headers().get('x-forwarded-for');
    const visitorIp = forwardedFor?.split(',')[0]?.trim();
    const res = await fetch(`${API_BASE}/api/geo/country`, {
      headers: visitorIp ? { 'x-visitor-ip': visitorIp } : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { country?: unknown };
    return typeof body.country === 'string' && body.country ? body.country : null;
  } catch {
    return null;
  }
}

/** Canadian visitors see CAD pricing; everyone else, and any lookup failure, sees USD. */
export async function getPricingCurrency(): Promise<'CAD' | 'USD'> {
  return (await getVisitorCountry()) === 'CA' ? 'CAD' : 'USD';
}
