import type { Lead, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { getSettingValue } from './platform-config.service';

/**
 * Outbound lead-generation pipeline (founder/platform-level).
 *
 *  1. SOURCE — Google Places (New) Text Search turns "HVAC in Phoenix, AZ" into
 *     real businesses with phone + website, deduped by Google place id.
 *  2. SCRAPE — a best-effort fetch of each business website pulls a *published*
 *     business email (the CAN-SPAM-friendly target). Many small sites list none;
 *     that's expected — phone-only leads still have value.
 *
 * Sending lives in a later phase; this module only finds and enriches leads.
 */

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_FIELDS =
  'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,nextPageToken';

interface PlacesResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    nationalPhoneNumber?: string;
    websiteUri?: string;
    rating?: number;
    userRatingCount?: number;
  }>;
  nextPageToken?: string;
}

async function requirePlacesKey(): Promise<string> {
  const key = await getSettingValue('GOOGLE_PLACES_API_KEY');
  if (!key) {
    throw new HttpError(
      400,
      'Add your Google Places API key under Keys & config before sourcing leads.',
      'PLACES_KEY_MISSING',
    );
  }
  return key;
}

export interface SourceResult {
  sourced: number;
  created: number;
  updated: number;
}

/**
 * Pull businesses for `trade` in `city` and upsert them as leads. Deduped on the
 * Google place id, so re-running only ever adds new businesses and refreshes the
 * Places-sourced fields — it never clobbers a scraped email or an advanced
 * funnel status.
 */
export async function sourceLeads(params: {
  trade: string;
  city: string;
  limit?: number;
}): Promise<SourceResult> {
  const key = await requirePlacesKey();
  const trade = params.trade.trim();
  const city = params.city.trim();
  if (!trade || !city) throw new HttpError(400, 'Both a trade and a city are required.', 'BAD_QUERY');
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 60); // Places caps at 60 per query

  const textQuery = `${trade} in ${city}`;
  let pageToken: string | undefined;
  let sourced = 0;
  let created = 0;
  let updated = 0;

  // Up to 3 pages of 20 (the Places API maximum for a single text query).
  for (let page = 0; page < 3 && sourced < limit; page++) {
    const res = await fetch(PLACES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': PLACES_FIELDS,
      },
      body: JSON.stringify({
        textQuery,
        pageSize: Math.min(20, limit - sourced),
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new HttpError(
        502,
        `Google Places rejected the request (${res.status}). Check the key and that "Places API (New)" is enabled.`,
        'PLACES_ERROR',
        detail.slice(0, 500),
      );
    }
    const json = (await res.json()) as PlacesResponse;
    const places = json.places ?? [];
    for (const p of places) {
      if (!p.id) continue;
      sourced++;
      const data = {
        businessName: p.displayName?.text ?? 'Unknown business',
        trade,
        city,
        phone: p.nationalPhoneNumber ?? null,
        website: p.websiteUri ?? null,
        address: p.formattedAddress ?? null,
        rating: p.rating ?? null,
        reviewCount: p.userRatingCount ?? null,
      } satisfies Partial<Prisma.LeadUncheckedCreateInput>;
      const existing = await prisma.lead.findUnique({ where: { placeId: p.id }, select: { id: true } });
      if (existing) {
        await prisma.lead.update({ where: { placeId: p.id }, data });
        updated++;
      } else {
        await prisma.lead.create({ data: { placeId: p.id, ...data } });
        created++;
      }
      if (sourced >= limit) break;
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }

  return { sourced, created, updated };
}

/* ------------------------------ email scraping ---------------------------- */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Junk that the email regex picks up from markup/assets/3rd-party scripts.
const EMAIL_BLOCKLIST = [
  'example.com',
  'sentry.io',
  'sentry-next.wixpress.com',
  'wixpress.com',
  'wix.com',
  'godaddy.com',
  'squarespace.com',
  'schema.org',
  'yourdomain',
  'domain.com',
  'email.com',
  'noreply',
  'no-reply',
];
const ASSET_EXT_RE = /\.(png|jpe?g|gif|webp|svg|css|js|ico|woff2?)$/i;
// Role mailboxes worth preferring when a site lists several addresses.
const PREFERRED_LOCALPARTS = ['info', 'office', 'contact', 'sales', 'hello', 'admin', 'service', 'support', 'booking'];

function registrableDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(website).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Pick the most plausible business email out of a page's raw text. */
export function extractBestEmail(html: string, siteDomain: string | null): string | null {
  const found = new Set<string>();
  for (const raw of html.match(EMAIL_RE) ?? []) {
    const email = raw.toLowerCase().replace(/^mailto:/, '');
    if (ASSET_EXT_RE.test(email)) continue;
    if (EMAIL_BLOCKLIST.some((b) => email.includes(b))) continue;
    if (email.length > 100) continue;
    found.add(email);
  }
  if (found.size === 0) return null;
  const candidates = [...found];
  const score = (email: string): number => {
    let s = 0;
    const [local, domain] = email.split('@');
    if (siteDomain && domain === siteDomain) s += 100; // same-domain wins big
    if (PREFERRED_LOCALPARTS.includes(local)) s += 20;
    if (/(gmail|yahoo|hotmail|outlook|aol|icloud)\./.test(domain)) s -= 10; // free inbox, weaker
    return s;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0];
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // A real desktop UA — some sites 403 obvious bots.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html') && !type.includes('text')) return null;
    const buf = await res.arrayBuffer();
    // Cap at ~1.5MB so a huge page can't blow up memory.
    return Buffer.from(buf.slice(0, 1_500_000)).toString('utf8');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Scrape a single lead's website for a published email; persists if found. */
export async function scrapeEmailForLead(leadId: string): Promise<string | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new HttpError(404, 'Lead not found.', 'LEAD_NOT_FOUND');
  if (!lead.website) return null;

  const domain = registrableDomain(lead.website);
  const base = lead.website.replace(/\/+$/, '');
  // Homepage first, then the usual contact pages.
  const urls = [lead.website, `${base}/contact`, `${base}/contact-us`, `${base}/about`];
  let email: string | null = null;
  for (const url of urls) {
    const html = await fetchText(url);
    if (!html) continue;
    email = extractBestEmail(html, domain);
    if (email) break;
  }
  if (email) {
    await prisma.lead.update({ where: { id: leadId }, data: { email, emailSource: 'website' } });
  }
  return email;
}

export interface ScrapeResult {
  scanned: number;
  found: number;
}

/**
 * Scrape emails for the next batch of leads that have a website but no email
 * yet. Sequential + best-effort so one slow/broken site never stalls the rest.
 */
export async function scrapeEmails(params: { limit?: number } = {}): Promise<ScrapeResult> {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const leads = await prisma.lead.findMany({
    where: {
      email: null,
      website: { not: null },
      status: { notIn: ['unsubscribed', 'dead'] },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  let found = 0;
  for (const { id } of leads) {
    try {
      if (await scrapeEmailForLead(id)) found++;
    } catch {
      /* best-effort — skip and continue */
    }
  }
  return { scanned: leads.length, found };
}

/* --------------------------------- queries -------------------------------- */

export interface ListLeadsParams {
  status?: string;
  hasEmail?: boolean;
  q?: string;
  sort?: 'newest' | 'rating';
  page?: number;
  perPage?: number;
}

export async function listLeads(params: ListLeadsParams): Promise<{
  leads: Lead[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}> {
  const page = Math.max(params.page ?? 1, 1);
  const perPage = Math.min(Math.max(params.perPage ?? 50, 1), 200);
  const where: Prisma.LeadWhereInput = {};
  if (params.status) where.status = params.status;
  if (params.hasEmail === true) where.email = { not: null };
  if (params.hasEmail === false) where.email = null;
  if (params.q && params.q.trim()) {
    const q = params.q.trim();
    where.OR = [
      { businessName: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { city: { contains: q, mode: 'insensitive' } },
    ];
  }
  const orderBy: Prisma.LeadOrderByWithRelationInput =
    params.sort === 'rating' ? { rating: { sort: 'desc', nulls: 'last' } } : { createdAt: 'desc' };
  const [total, leads] = await prisma.$transaction([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);
  return { leads, total, page, perPage, totalPages: Math.max(1, Math.ceil(total / perPage)) };
}

const LEAD_STATUSES = ['new', 'emailed', 'opened', 'clicked', 'replied', 'demoed', 'won', 'dead', 'unsubscribed'];

export async function getLeadStats(): Promise<{ total: number; withEmail: number; withPhone: number; byStatus: Record<string, number> }> {
  const [total, withEmail, withPhone, ...statusCounts] = await Promise.all([
    prisma.lead.count(),
    prisma.lead.count({ where: { email: { not: null } } }),
    prisma.lead.count({ where: { phone: { not: null } } }),
    ...LEAD_STATUSES.map((status) => prisma.lead.count({ where: { status } })),
  ]);
  const byStatus: Record<string, number> = {};
  LEAD_STATUSES.forEach((status, i) => {
    byStatus[status] = statusCounts[i];
  });
  return { total, withEmail, withPhone, byStatus };
}

export async function updateLead(
  id: string,
  patch: { status?: string; notes?: string; email?: string | null },
): Promise<Lead> {
  const data: Prisma.LeadUpdateInput = {};
  if (patch.status !== undefined) {
    if (!LEAD_STATUSES.includes(patch.status)) throw new HttpError(400, 'Unknown status.', 'BAD_STATUS');
    data.status = patch.status;
  }
  if (patch.notes !== undefined) data.notes = patch.notes;
  if (patch.email !== undefined) {
    data.email = patch.email;
    data.emailSource = patch.email ? 'manual' : null;
  }
  try {
    return await prisma.lead.update({ where: { id }, data });
  } catch {
    throw new HttpError(404, 'Lead not found.', 'LEAD_NOT_FOUND');
  }
}

export async function deleteLead(id: string): Promise<void> {
  await prisma.lead.deleteMany({ where: { id } });
}

/** Bulk status-change or delete across many leads at once. Returns the count
 *  affected. Used by the admin select-and-act workflow. */
export async function bulkLeads(
  ids: string[],
  action: 'delete' | 'status',
  status?: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  if (action === 'delete') {
    const r = await prisma.lead.deleteMany({ where: { id: { in: ids } } });
    return r.count;
  }
  if (!status || !LEAD_STATUSES.includes(status)) {
    throw new HttpError(400, 'Unknown status.', 'BAD_STATUS');
  }
  const r = await prisma.lead.updateMany({ where: { id: { in: ids } }, data: { status } });
  return r.count;
}

/** Mark a lead unsubscribed (public, idempotent — used by the email's
 *  CAN-SPAM unsubscribe link). Never throws if the lead is already gone. */
export async function unsubscribeLead(leadId: string): Promise<void> {
  await prisma.lead.updateMany({ where: { id: leadId }, data: { status: 'unsubscribed' } });
}
