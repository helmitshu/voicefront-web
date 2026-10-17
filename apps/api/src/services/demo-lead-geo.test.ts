import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ingestion test for the visitor map: createDemoLead persists the
 * approximate, IP-derived location fields (city / region / coordinates)
 * and nothing else geo-shaped. There is deliberately no raw-IP input to
 * this function at all — the test pins the exact persisted key set so a
 * future change cannot quietly start storing the address itself.
 */

const createCalls: Array<{ data: Record<string, unknown> }> = [];

vi.mock('../lib/prisma', () => ({
  prisma: {
    demoLead: {
      create: (args: { data: Record<string, unknown> }) => {
        createCalls.push(args);
        return Promise.resolve({ id: 'lead_new', ...args.data });
      },
    },
  },
}));

import { createDemoLead } from './demo.service';

beforeEach(() => {
  createCalls.length = 0;
});

describe('createDemoLead geo persistence', () => {
  it('stores the derived location fields the lookup returned', async () => {
    await createDemoLead({
      sessionId: 'demo_geo',
      name: 'Geo Tester',
      email: 'geo@tester.test',
      phone: '+16045550199',
      ipCountry: 'CA',
      ipCity: 'Surrey',
      ipRegion: 'British Columbia',
      ipLat: 49.1,
      ipLng: -122.8,
      phoneCountry: 'CA',
    });
    expect(createCalls).toHaveLength(1);
    const data = createCalls[0].data;
    expect(data.ipCountry).toBe('CA');
    expect(data.ipCity).toBe('Surrey');
    expect(data.ipRegion).toBe('British Columbia');
    expect(data.ipLat).toBe(49.1);
    expect(data.ipLng).toBe(-122.8);
  });

  it('persists nulls when the lookup returned nothing, and never a raw IP', async () => {
    await createDemoLead({
      sessionId: 'demo_nogeo',
      name: 'No Geo',
      email: 'nogeo@tester.test',
      phone: '+16045550198',
      ipCountry: null,
      phoneCountry: null,
    });
    const data = createCalls[0].data;
    expect(data.ipCity).toBeNull();
    expect(data.ipRegion).toBeNull();
    expect(data.ipLat).toBeNull();
    expect(data.ipLng).toBeNull();
    // The persisted key set is pinned: no raw-address field can sneak in.
    expect(Object.keys(data).sort()).toEqual(
      [
        'businessName',
        'demoSessionId',
        'email',
        'industry',
        'ipCity',
        'ipCountry',
        'ipLat',
        'ipLng',
        'ipRegion',
        'mode',
        'name',
        'phone',
        'phoneCountry',
        'websiteUrl',
      ].sort(),
    );
    expect(JSON.stringify(data)).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  });
});
