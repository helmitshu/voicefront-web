import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pricing-region verification: the CAD price book is granted only when
 * the business itself verifies as Canadian. These tests pin the
 * classifier's signals (the site's own stated country first, then postal
 * codes, provinces, states, and the .ca domain), the conflict rule
 * (both sides signaling means no verdict), and the signup resolver's
 * two grant paths (demo carry-over, then a fresh website read). The
 * visitor's IP plays no part anywhere in this module.
 */

interface FakeLead {
  email: string;
  websiteUrl: string | null;
  factsJson: unknown;
  createdAt: Date;
}

const leads: FakeLead[] = [];
const tenantUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];

const demoLeadFindFirst = vi.fn(
  async (args: { where: { email: { equals: string; mode: 'insensitive' } } }) => {
    const wanted = args.where.email.equals.toLowerCase();
    const match = [...leads]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .find((l) => l.email.toLowerCase() === wanted);
    return match ? { factsJson: match.factsJson, websiteUrl: match.websiteUrl } : null;
  },
);
const demoLeadFindMany = vi.fn(async (args: { take?: number }) => {
  return [...leads]
    .filter((l) => l.websiteUrl !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, args.take ?? 50)
    .map((l) => ({ factsJson: l.factsJson, websiteUrl: l.websiteUrl }));
});
const tenantUpdate = vi.fn(
  async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    tenantUpdates.push({ id: args.where.id, data: args.data });
    return {};
  },
);

vi.mock('../lib/prisma', () => ({
  prisma: {
    demoLead: {
      findFirst: (args: unknown) => demoLeadFindFirst(args as never),
      findMany: (args: unknown) => demoLeadFindMany(args as never),
    },
    tenant: { update: (args: unknown) => tenantUpdate(args as never) },
  },
}));

const fetchClinicFacts = vi.fn();
vi.mock('./clinic-facts.service', () => ({
  fetchClinicFacts: (...args: unknown[]) => fetchClinicFacts(...args),
}));

import { classifyBusinessCountry, resolveSignupPricingRegion } from './pricing-region.service';

const CA_FACTS = {
  businessName: 'Maple Dental Studio',
  address: '2145 West 4th Avenue, Vancouver, BC V6B 1A1',
  country: 'CA',
  region: 'BC',
  postalCode: 'V6B 1A1',
};
const US_FACTS = {
  businessName: 'Rainier Dental',
  address: '1200 Pine Street, Seattle, WA 98101',
  country: 'US',
  region: 'WA',
  postalCode: '98101',
};

describe('classifyBusinessCountry', () => {
  it('trusts the country the site states in its structured data', () => {
    expect(classifyBusinessCountry({ country: 'CA' })).toBe('CA');
    expect(classifyBusinessCountry({ country: 'Canada' })).toBe('CA');
    expect(classifyBusinessCountry({ country: 'CAN' })).toBe('CA');
    expect(classifyBusinessCountry({ country: 'US' })).toBe('US');
    expect(classifyBusinessCountry({ country: 'United States' })).toBe('US');
  });

  it('treats any other stated country as not Canada', () => {
    expect(classifyBusinessCountry({ country: 'GB' })).toBe('US');
    expect(classifyBusinessCountry({ country: 'Australia' })).toBe('US');
  });

  it('reads the structured region and postal code', () => {
    expect(classifyBusinessCountry({ region: 'BC' })).toBe('CA');
    expect(classifyBusinessCountry({ region: 'British Columbia' })).toBe('CA');
    expect(classifyBusinessCountry({ region: 'Ontario' })).toBe('CA');
    expect(classifyBusinessCountry({ region: 'WA' })).toBe('US');
    expect(classifyBusinessCountry({ region: 'California' })).toBe('US');
    expect(classifyBusinessCountry({ postalCode: 'V3R 1A1' })).toBe('CA');
    expect(classifyBusinessCountry({ postalCode: '98101' })).toBe('US');
    expect(classifyBusinessCountry({ postalCode: '98101-1234' })).toBe('US');
  });

  it('reads the address line: postal codes, province and state names, comma codes', () => {
    expect(classifyBusinessCountry({ address: '2145 West 4th Avenue, Vancouver, BC V6B 1A1' })).toBe('CA');
    expect(classifyBusinessCountry({ address: '88 King Street, Surrey, British Columbia' })).toBe('CA');
    expect(classifyBusinessCountry({ address: '12 Rue Sainte-Catherine, Montréal, QC' })).toBe('CA');
    expect(classifyBusinessCountry({ address: '1200 9 Avenue SW, Calgary, AB' })).toBe('CA');
    expect(classifyBusinessCountry({ address: '2145 West 4th Avenue, Vancouver, Canada' })).toBe('CA');
    expect(classifyBusinessCountry({ address: '1200 Pine Street, Seattle, WA 98101' })).toBe('US');
    expect(classifyBusinessCountry({ address: '400 Broad Street, Seattle, Washington' })).toBe('US');
    expect(classifyBusinessCountry({ address: '75 E Santa Clara Street, San Jose, CA 95112' })).toBe('US');
  });

  it('counts a .ca website as Canadian evidence, and only Canadian evidence', () => {
    expect(classifyBusinessCountry(null, 'https://mapledental.ca')).toBe('CA');
    expect(classifyBusinessCountry({}, 'https://mapledental.ca/contact')).toBe('CA');
    expect(classifyBusinessCountry(null, 'https://rainierdental.com')).toBeNull();
  });

  it('returns no verdict on conflicts instead of guessing', () => {
    // A Canadian postal code next to a 5-digit street number that also
    // parses as a ZIP: both sides signal, so no grant.
    expect(
      classifyBusinessCountry({ address: '12345 King George Boulevard, Surrey, BC V3R 1A1' }),
    ).toBeNull();
    expect(classifyBusinessCountry({ country: 'CA', postalCode: '98101' })).toBeNull();
  });

  it('returns no verdict when there is no usable evidence', () => {
    expect(classifyBusinessCountry(null)).toBeNull();
    expect(classifyBusinessCountry({})).toBeNull();
    expect(classifyBusinessCountry({ businessName: 'Somewhere Dental' })).toBeNull();
    expect(classifyBusinessCountry({ address: '2145 West 4th Avenue' })).toBeNull();
  });
});

describe('resolveSignupPricingRegion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    leads.length = 0;
    tenantUpdates.length = 0;
    fetchClinicFacts.mockResolvedValue(null);
  });

  it('grants CAD from a demo lead with the same email, without refetching', async () => {
    leads.push({
      email: 'Owner@MapleDental.ca',
      websiteUrl: 'https://mapledental.ca',
      factsJson: CA_FACTS,
      createdAt: new Date(),
    });
    await resolveSignupPricingRegion('tenant_1', { email: 'owner@mapledental.ca', website: null });
    expect(tenantUpdates).toHaveLength(1);
    expect(tenantUpdates[0]?.id).toBe('tenant_1');
    expect(tenantUpdates[0]?.data.pricingRegion).toBe('CAD');
    expect(tenantUpdates[0]?.data.pricingRegionSource).toBe('demo-lead');
    expect(tenantUpdates[0]?.data.pricingRegionVerifiedAt).toBeInstanceOf(Date);
    expect(fetchClinicFacts).not.toHaveBeenCalled();
  });

  it('grants CAD from a demo lead matched by website when the email differs', async () => {
    leads.push({
      email: 'frontdesk@mapledental.ca',
      websiteUrl: 'https://www.mapledental.ca/',
      factsJson: CA_FACTS,
      createdAt: new Date(),
    });
    await resolveSignupPricingRegion('tenant_1', {
      email: 'owner@mapledental.ca',
      website: 'https://mapledental.ca',
    });
    expect(tenantUpdates).toHaveLength(1);
    expect(tenantUpdates[0]?.data.pricingRegionSource).toBe('demo-lead');
    expect(fetchClinicFacts).not.toHaveBeenCalled();
  });

  it('grants CAD from a fresh read of the registration website', async () => {
    fetchClinicFacts.mockResolvedValue(CA_FACTS);
    await resolveSignupPricingRegion('tenant_1', {
      email: 'owner@mapledental.ca',
      website: 'https://mapledental.ca',
    });
    expect(fetchClinicFacts).toHaveBeenCalledWith('https://mapledental.ca');
    expect(tenantUpdates).toHaveLength(1);
    expect(tenantUpdates[0]?.data.pricingRegion).toBe('CAD');
    expect(tenantUpdates[0]?.data.pricingRegionSource).toBe('website');
  });

  it('leaves USD in place for a US business', async () => {
    fetchClinicFacts.mockResolvedValue(US_FACTS);
    await resolveSignupPricingRegion('tenant_1', {
      email: 'owner@rainierdental.com',
      website: 'https://rainierdental.com',
    });
    expect(tenantUpdates).toHaveLength(0);
  });

  it('leaves USD in place when the website cannot be read or classified', async () => {
    fetchClinicFacts.mockResolvedValue(null);
    await resolveSignupPricingRegion('tenant_1', {
      email: 'owner@unknown.test',
      website: 'https://unreadable.example',
    });
    expect(tenantUpdates).toHaveLength(0);

    fetchClinicFacts.mockResolvedValue({ businessName: 'No Address Dental' });
    await resolveSignupPricingRegion('tenant_1', {
      email: 'owner@unknown.test',
      website: 'https://noaddress.example',
    });
    expect(tenantUpdates).toHaveLength(0);
  });

  it('a US demo lead does not block a later Canadian website verdict', async () => {
    leads.push({
      email: 'owner@mapledental.ca',
      websiteUrl: 'https://oldsite.example',
      factsJson: US_FACTS,
      createdAt: new Date(),
    });
    fetchClinicFacts.mockResolvedValue(CA_FACTS);
    await resolveSignupPricingRegion('tenant_1', {
      email: 'owner@mapledental.ca',
      website: 'https://mapledental.ca',
    });
    expect(tenantUpdates).toHaveLength(1);
    expect(tenantUpdates[0]?.data.pricingRegionSource).toBe('website');
  });

  it('never throws, even when the lead lookup fails', async () => {
    demoLeadFindFirst.mockRejectedValueOnce(new Error('db down'));
    await expect(
      resolveSignupPricingRegion('tenant_1', { email: 'a@b.test', website: null }),
    ).resolves.toBeUndefined();
    expect(tenantUpdates).toHaveLength(0);
  });
});
