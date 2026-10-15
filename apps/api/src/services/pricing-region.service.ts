/**
 * Pricing region: which price book a workspace is on, 'USD' or 'CAD'.
 *
 * The region is server-owned. Every workspace starts on USD, and CAD is
 * granted only when the business is verified as Canadian, in exactly two
 * ways (plus a platform admin override in the admin routes):
 *
 *  1. Website verification: the business website given at registration is
 *     read by the same guarded facts pipeline the personalized demo uses
 *     (services/clinic-facts.service), and the extracted facts must say
 *     the business is in Canada.
 *  2. Demo carry-over: the clinic already ran the personalized demo, and
 *     the facts stored on that demo lead classify as Canadian. Registering
 *     with the same email (or the same website) inherits the result, so
 *     a verified clinic never verifies twice.
 *
 * The visitor's IP country is NOT verification and is never used here:
 * it only picks which prices the public pages display. Tenant.pricingRegion
 * is the single source the Stripe checkout will read once checkout exists.
 *
 * Nothing in this module throws: a failed or inconclusive verification
 * simply leaves the workspace on the USD default.
 */

import { prisma } from '../lib/prisma';
import { fetchClinicFacts, type ClinicFacts } from './clinic-facts.service';

export type PricingRegion = 'USD' | 'CAD';
export type PricingRegionSource = 'website' | 'demo-lead' | 'admin';

/** 'CA' = the evidence says Canada, 'US' = the evidence says not Canada
 *  (US signals, or another country stated outright), null = no usable
 *  evidence either way. Only 'CA' can grant the CAD price book. */
export type BusinessCountry = 'CA' | 'US';

export function normalizePricingRegion(value: string | null | undefined): PricingRegion {
  return value === 'CAD' ? 'CAD' : 'USD';
}

/* ------------------------------ classifier ------------------------------ */

const CA_POSTAL_RE = /\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/;
const US_ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;

const PROVINCE_CODES = new Set([
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
]);

const PROVINCE_NAMES = [
  'british columbia',
  'alberta',
  'saskatchewan',
  'manitoba',
  'ontario',
  'quebec',
  'québec',
  'new brunswick',
  'nova scotia',
  'prince edward island',
  'newfoundland and labrador',
  'newfoundland',
  'northwest territories',
  'nunavut',
  'yukon',
];

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI',
  'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN',
  'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
]);

const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'district of columbia', 'florida', 'georgia',
  'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
  'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york',
  'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
  'west virginia', 'wisconsin', 'wyoming',
];

/** Normalizes a stated country ("Canada", "CAN", "U.S.A.", "GB") to a
 *  bucket. Any stated country that is not Canada lands in 'OTHER': for
 *  CAD eligibility the only question is "Canada or not". */
function normalizeCountryValue(raw: string | null | undefined): 'CA' | 'US' | 'OTHER' | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/[.\s]+/g, ' ').trim();
  if (!v) return null;
  if (v === 'ca' || v === 'can' || v === 'canada') return 'CA';
  if (v === 'us' || v === 'usa' || v === 'united states' || v === 'united states of america' || v === 'america') {
    return 'US';
  }
  return 'OTHER';
}

/** True when the region string names a Canadian province, by code or by
 *  full name ("BC", "British Columbia"). Codes are matched as whole
 *  tokens so a longer word containing the letters never counts. */
function isProvince(region: string): boolean {
  const lower = region.toLowerCase();
  if (PROVINCE_NAMES.some((name) => lower.includes(name))) return true;
  const tokens = region.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  return tokens.some((t) => PROVINCE_CODES.has(t));
}

function isUsState(region: string): boolean {
  const lower = region.toLowerCase();
  if (US_STATE_NAMES.some((name) => lower.includes(name))) return true;
  const tokens = region.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  return tokens.some((t) => US_STATE_CODES.has(t));
}

/**
 * In a free-text address, a two-letter code counts as a province or state
 * only in the LAST comma position, the way addresses end ("Vancouver,
 * BC", "Seattle, WA 98101"). Matching every comma would read the first
 * two letters of city names as codes ("Montréal, QC" is not Missouri,
 * "Calgary, AB" is not California). A last segment that is a country
 * word ("Canada", "USA") is not a code at all; the country-word checks
 * in the classifier cover it.
 */
function lastCommaCode(address: string): string | null {
  const idx = address.lastIndexOf(',');
  if (idx < 0) return null;
  const segment = address.slice(idx + 1).trim();
  if (/^(canada|usa|u\.s\.a\.?)\b/i.test(segment)) return null;
  const m = segment.match(/^([A-Za-z]{2})\b/);
  return m ? (m[1] as string).toUpperCase() : null;
}

function websiteHostIsCa(websiteUrl: string | null | undefined): boolean {
  if (!websiteUrl) return false;
  try {
    return new URL(websiteUrl).hostname.toLowerCase().endsWith('.ca');
  } catch {
    return false;
  }
}

/**
 * Classifies extracted clinic facts (plus the website they came from) as
 * Canadian, not-Canadian, or unknown. Signals, strongest first:
 *
 *  - the country the site's own JSON-LD states (addressCountry);
 *  - the region the site's JSON-LD states (addressRegion);
 *  - a Canadian postal code, or a US ZIP, in the structured postalCode
 *    or in the address line;
 *  - a province or state full name in the address line, a province or
 *    state code in the last comma position, or a country word;
 *  - a .ca website domain (Canadian evidence only: US businesses do not
 *    register .ca domains; it never counts as US evidence).
 *
 * Both sides signaling at once (a Canadian postal code next to a 5-digit
 * street number that parses as a ZIP) is a conflict, not a verdict: the
 * result is null and the workspace stays on USD, where a platform admin
 * can override. The classifier never sees the visitor's IP.
 */
export function classifyBusinessCountry(
  facts: ClinicFacts | null | undefined,
  websiteUrl?: string | null,
): BusinessCountry | null {
  let ca = false;
  let us = false;

  if (facts) {
    const country = normalizeCountryValue(facts.country);
    if (country === 'CA') ca = true;
    else if (country !== null) us = true;

    if (facts.region) {
      if (isProvince(facts.region)) ca = true;
      else if (isUsState(facts.region)) us = true;
    }

    const postal = (facts.postalCode ?? '').trim();
    if (postal) {
      if (CA_POSTAL_RE.test(postal)) ca = true;
      else if (US_ZIP_RE.test(postal)) us = true;
    }

    const address = facts.address ?? '';
    if (address) {
      const lower = address.toLowerCase();
      if (CA_POSTAL_RE.test(address)) ca = true;
      if (PROVINCE_NAMES.some((name) => lower.includes(name))) ca = true;
      if (US_STATE_NAMES.some((name) => lower.includes(name))) us = true;
      if (/\bcanada\b/i.test(address)) ca = true;
      if (/\b(usa|u\.s\.a\.|united states)\b/i.test(address)) us = true;
      const code = lastCommaCode(address);
      if (code && PROVINCE_CODES.has(code)) ca = true;
      else if (code && US_STATE_CODES.has(code)) us = true;
      if (US_ZIP_RE.test(address)) us = true;
    }
  }

  if (websiteHostIsCa(websiteUrl)) ca = true;

  if (ca && !us) return 'CA';
  if (us && !ca) return 'US';
  return null;
}

/* --------------------------- signup resolution -------------------------- */

/** Reads a DemoLead factsJson blob defensively: only the string fields
 *  the classifier reads, each type-checked. Anything malformed is null. */
function factsFromLeadJson(value: unknown): ClinicFacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v : undefined;
  const facts: ClinicFacts = {};
  if (str(obj.businessName)) facts.businessName = str(obj.businessName);
  if (str(obj.phone)) facts.phone = str(obj.phone);
  if (str(obj.address)) facts.address = str(obj.address);
  if (str(obj.country)) facts.country = str(obj.country);
  if (str(obj.region)) facts.region = str(obj.region);
  if (str(obj.postalCode)) facts.postalCode = str(obj.postalCode);
  return facts;
}

/** Light normalization for "same website" comparisons: case, scheme, a
 *  leading www, and trailing slashes do not make a different website. */
function normalizeWebsite(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

async function grantCad(tenantId: string, source: PricingRegionSource): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      pricingRegion: 'CAD',
      pricingRegionSource: source,
      pricingRegionVerifiedAt: new Date(),
    },
  });
}

/**
 * Runs the pricing-region decision for a brand-new workspace. Carry-over
 * first (a demo lead with the same email, or the same website, whose
 * stored facts classify as Canadian), then a fresh read of the website
 * given at registration. Only a Canadian verdict changes anything; every
 * other outcome leaves the USD default in place. Never throws.
 */
export async function resolveSignupPricingRegion(
  tenantId: string,
  input: { email: string; website?: string | null },
): Promise<void> {
  try {
    const email = input.email.trim().toLowerCase();
    const website = input.website?.trim() || null;

    const byEmail = email
      ? await prisma.demoLead.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
          orderBy: { createdAt: 'desc' },
          select: { factsJson: true, websiteUrl: true },
        })
      : null;

    let lead = byEmail;
    if (!lead && website) {
      const target = normalizeWebsite(website);
      const candidates = await prisma.demoLead.findMany({
        where: { websiteUrl: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { factsJson: true, websiteUrl: true },
      });
      lead =
        candidates.find((c) => c.websiteUrl && normalizeWebsite(c.websiteUrl) === target) ??
        null;
    }

    if (lead) {
      const facts = factsFromLeadJson(lead.factsJson);
      if (classifyBusinessCountry(facts, lead.websiteUrl) === 'CA') {
        await grantCad(tenantId, 'demo-lead');
        return;
      }
    }

    if (website) {
      const facts = await fetchClinicFacts(website);
      if (facts && classifyBusinessCountry(facts, website) === 'CA') {
        await grantCad(tenantId, 'website');
      }
    }
  } catch (err) {
    // Verification must never break signup: the workspace keeps the USD
    // default and an admin can override after a manual check.
    console.warn(
      `[pricing-region] verification failed for tenant ${tenantId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
