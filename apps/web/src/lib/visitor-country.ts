import { headers } from 'next/headers';

/**
 * Server-side visitor country for the marketing pages. The API is the
 * single geolocation source: it resolves the country from the visitor's
 * IP with the same mechanism the demo geo gate uses (see the API's
 * geo.service). The web forwards the visitor's X-Forwarded-For so the
 * API sees the real client IP, exactly as it does for demo requests.
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
    const res = await fetch(`${API_BASE}/api/geo/country`, {
      headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : undefined,
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
