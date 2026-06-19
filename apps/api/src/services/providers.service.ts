import { prisma } from '../lib/prisma';

/**
 * Providers & services resolution for the booking flow. A tenant with no
 * Providers is a single shared resource (the solo case) — everything here
 * returns "no constraint" so the booking engine falls back to its legacy
 * null-provider behavior. Once providers exist, this maps what a caller says
 * ("with Dr. Smith", "a cleaning") to concrete ids, durations, and the pool of
 * providers eligible for first-available assignment.
 */

/** Strips titles/punctuation so spoken names match stored ones loosely. */
function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(dr|doctor|mr|mrs|ms|miss|prof|professor)\b\.?/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Best-effort match of a spoken `query` to one of `items` by name: exact, then
 * substring either direction, then any shared word (so "Smith" finds
 * "Dr. Sarah Smith"). Returns null when nothing plausibly matches.
 */
export function matchByName<T extends { name: string }>(items: T[], query: string): T | null {
  const q = norm(query);
  if (!q) return null;

  const exact = items.find((i) => norm(i.name) === q);
  if (exact) return exact;

  const contains = items.find((i) => {
    const n = norm(i.name);
    return n.length > 0 && (n.includes(q) || q.includes(n));
  });
  if (contains) return contains;

  const queryWords = new Set(q.split(' ').filter(Boolean));
  return items.find((i) => norm(i.name).split(' ').some((w) => w.length > 1 && queryWords.has(w))) ?? null;
}

export interface BookingContext {
  /** A specific provider the caller named (and who can do the service). */
  providerId: string | null;
  /** Providers eligible for first-available assignment. Empty = shared resource. */
  candidateProviderIds: string[];
  /** The matched service, if any — recorded on the appointment. */
  serviceId: string | null;
  /** Slot length from the service; null = use the engine's default. */
  durationMinutes: number | null;
  /** A speakable aside when something the caller named wasn't found / didn't fit. */
  note?: string;
}

/**
 * Resolves a caller's spoken provider/service into the ids and provider pool the
 * booking engine needs. Service is resolved first (it sets the duration and
 * narrows the eligible providers); a named provider is then honored only if they
 * can perform that service.
 */
export async function resolveBookingContext(
  tenantId: string,
  opts: { providerName?: string | null; serviceName?: string | null },
): Promise<BookingContext> {
  const [providers, services] = await Promise.all([
    prisma.provider.findMany({ where: { tenantId, active: true }, select: { id: true, name: true } }),
    prisma.service.findMany({
      where: { tenantId, active: true },
      select: { id: true, name: true, durationMinutes: true, providers: { where: { active: true }, select: { id: true } } },
    }),
  ]);

  // No providers configured → solo / single shared resource; ignore the rest.
  if (providers.length === 0) {
    return { providerId: null, candidateProviderIds: [], serviceId: null, durationMinutes: null };
  }

  let note: string | undefined;

  // Service first: it sets the duration and may narrow the eligible providers.
  let serviceId: string | null = null;
  let durationMinutes: number | null = null;
  let qualified = providers.map((p) => p.id);
  if (opts.serviceName?.trim()) {
    const svc = matchByName(services, opts.serviceName);
    if (svc) {
      serviceId = svc.id;
      durationMinutes = svc.durationMinutes;
      const ids = svc.providers.map((p) => p.id);
      if (ids.length > 0) qualified = ids; // empty list = any provider can do it
    } else if (services.length > 0) {
      note = `I couldn't find a service called "${opts.serviceName.trim()}", so I'll book a standard appointment.`;
    }
  }

  // Then a specifically requested provider, constrained to the qualified pool.
  let providerId: string | null = null;
  if (opts.providerName?.trim()) {
    const prov = matchByName(providers, opts.providerName);
    if (prov && qualified.includes(prov.id)) {
      providerId = prov.id;
    } else if (prov) {
      note = `${prov.name} doesn't handle that one, so I'll find whoever's available.`;
    } else {
      note = `I couldn't find someone by that name, so I'll book the first available.`;
    }
  }

  return { providerId, candidateProviderIds: qualified, serviceId, durationMinutes, note };
}

/**
 * Like resolveBookingContext but driven by ids from a trusted UI (the manual
 * calendar booking form) instead of spoken names. Ids are validated against the
 * tenant; an unknown/foreign id is simply ignored (falls back to first-available).
 */
export async function bookingContextByIds(
  tenantId: string,
  opts: { providerId?: string | null; serviceId?: string | null },
): Promise<BookingContext> {
  const [providers, service] = await Promise.all([
    prisma.provider.findMany({ where: { tenantId, active: true }, select: { id: true } }),
    opts.serviceId
      ? prisma.service.findFirst({
          where: { id: opts.serviceId, tenantId, active: true },
          select: { id: true, durationMinutes: true, providers: { where: { active: true }, select: { id: true } } },
        })
      : Promise.resolve(null),
  ]);

  if (providers.length === 0) {
    return { providerId: null, candidateProviderIds: [], serviceId: null, durationMinutes: null };
  }

  let qualified = providers.map((p) => p.id);
  let serviceId: string | null = null;
  let durationMinutes: number | null = null;
  if (service) {
    serviceId = service.id;
    durationMinutes = service.durationMinutes;
    if (service.providers.length > 0) qualified = service.providers.map((p) => p.id);
  }

  const providerId = opts.providerId && qualified.includes(opts.providerId) ? opts.providerId : null;
  return { providerId, candidateProviderIds: qualified, serviceId, durationMinutes };
}
