import { prisma } from '../lib/prisma';

/**
 * Admin visitor map: where demo visitors are, built ONLY from records the
 * demo flow already stores (demo leads, their demo calls, their holds).
 *
 * Legal boundary, enforced here rather than in the UI:
 *  - No raw IP address exists on a demo lead, and nothing in this payload
 *    is derived from one at request time. Locations are the approximate,
 *    IP-derived fields stored when the lead was created (city level at
 *    best), or a country centroid when only the country is known — and
 *    the precision is labeled on every location so a country pin is never
 *    mistaken for a real spot.
 *  - Contact details are exactly what the visitor typed into the demo
 *    form (or gave Lyla). Business facts are the ones their own website
 *    published and the demo pulled. No tenant or patient data is read.
 */

/** Country centroids (approximate geographic centers), [lat, lng]. Used
 *  only for country-precision pins, which the payload labels as such. */
const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  US: [39.8, -98.6], CA: [57.1, -101.4], MX: [23.6, -102.6], GT: [15.5, -90.3],
  BZ: [17.2, -88.7], HN: [15.2, -86.4], SV: [13.8, -88.9], NI: [12.9, -84.9],
  CR: [9.7, -84.1], PA: [8.5, -80.8], CU: [21.5, -78.7], DO: [18.7, -70.2],
  HT: [19.0, -72.7], JM: [18.1, -77.2], BS: [25.0, -77.4], TT: [10.4, -61.3],
  BR: [-10.8, -52.9], AR: [-38.4, -63.6], CL: [-31.8, -70.7], PE: [-9.2, -75.0],
  CO: [4.6, -74.1], VE: [7.1, -66.2], EC: [-1.5, -78.2], BO: [-16.3, -64.7],
  PY: [-23.4, -58.4], UY: [-32.5, -55.8], GY: [4.9, -58.9], SR: [4.0, -55.9],
  GB: [54.0, -2.5], IE: [53.2, -8.2], FR: [46.6, 2.5], ES: [40.2, -3.6],
  PT: [39.6, -8.0], IT: [42.8, 12.8], DE: [51.1, 10.4], NL: [52.2, 5.3],
  BE: [50.5, 4.5], LU: [49.8, 6.1], CH: [46.8, 8.2], AT: [47.6, 14.1],
  PL: [52.1, 19.4], CZ: [49.8, 15.5], SK: [48.7, 19.7], HU: [47.2, 19.5],
  GR: [39.1, 21.8], SE: [62.2, 15.0], NO: [64.9, 11.7], DK: [56.0, 10.0],
  FI: [64.0, 26.0], IS: [65.0, -18.6], EE: [58.8, 25.0], LV: [56.9, 24.9],
  LT: [56.0, 23.9], RO: [45.9, 25.0], BG: [42.8, 25.5], HR: [45.3, 16.4],
  SI: [46.1, 14.9], RS: [44.0, 20.8], BA: [44.2, 17.8], ME: [42.8, 19.3],
  MK: [41.6, 21.7], AL: [41.2, 20.0], UA: [48.8, 32.0], BY: [53.5, 28.0],
  MD: [47.4, 28.4], RU: [60.0, 90.0], TR: [39.0, 35.2], CY: [35.0, 33.0],
  MT: [35.9, 14.4], IL: [31.0, 34.9], PS: [31.9, 35.2], LB: [33.9, 35.9],
  SY: [35.0, 38.0], IQ: [33.2, 43.7], IR: [32.4, 53.7], SA: [24.6, 46.7],
  YE: [15.6, 47.6], OM: [21.5, 57.9], AE: [24.2, 55.4], QA: [25.3, 51.2],
  BH: [26.1, 50.6], KW: [29.3, 47.5], JO: [31.2, 36.6], EG: [26.8, 30.8],
  LY: [26.3, 17.3], TN: [33.9, 9.6], DZ: [28.0, 2.0], MA: [31.8, -6.0],
  NG: [9.1, 8.7], GH: [7.9, -1.2], CI: [7.6, -5.6], SN: [14.4, -14.5],
  ML: [17.6, -4.0], BF: [12.2, -1.7], NE: [16.6, 9.7], TD: [15.5, 18.7],
  SD: [13.0, 30.0], SS: [7.9, 30.0], ET: [9.1, 40.5], ER: [15.2, 39.8],
  DJ: [11.6, 43.1], SO: [5.2, 46.2], KE: [0.5, 37.9], TZ: [-6.4, 34.9],
  UG: [1.4, 32.4], RW: [-1.9, 30.0], BI: [-3.4, 29.9], MZ: [-17.3, 35.5],
  AO: [-12.5, 18.0], ZM: [-13.1, 27.8], ZW: [-19.0, 29.9], BW: [-22.3, 24.7],
  NA: [-22.6, 17.1], ZA: [-29.0, 25.0], MG: [-19.0, 46.7], MU: [-20.2, 57.5],
  CM: [5.7, 12.7], CD: [-2.9, 23.7], CG: [-0.7, 14.9], GA: [-0.8, 11.6],
  PK: [30.4, 69.3], IN: [22.4, 78.7], BD: [23.7, 90.4], LK: [7.9, 80.8],
  NP: [28.4, 84.1], BT: [27.5, 90.4], MM: [21.9, 96.0], TH: [15.9, 101.0],
  VN: [14.1, 108.3], KH: [12.7, 105.0], LA: [19.9, 102.5], MY: [4.2, 102.2],
  SG: [1.35, 103.8], ID: [-2.2, 118.0], PH: [12.9, 121.8], CN: [35.9, 104.2],
  HK: [22.3, 114.2], TW: [23.7, 121.0], JP: [36.2, 138.3], KR: [36.4, 127.9],
  MN: [46.9, 103.8], KZ: [48.2, 66.9], UZ: [41.4, 64.6], TM: [39.1, 59.6],
  KG: [41.2, 74.8], TJ: [38.9, 71.3], AF: [33.9, 67.7], AU: [-25.3, 133.8],
  NZ: [-41.8, 172.8], PG: [-6.3, 147.0], FJ: [-17.7, 178.1], SB: [-9.6, 160.2],
};

const countryNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

export function countryName(code: string): string {
  try {
    return countryNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export interface VisitorMapLocation {
  city: string | null;
  region: string | null;
  country: string;
  countryName: string;
  lat: number;
  lng: number;
  /** "city" when the stored IP-derived coordinates exist; "country" when
   *  the pin sits on the country centroid because that is all we know. */
  precision: 'city' | 'country';
  /** Human label stating plainly how approximate this location is. */
  precisionLabel: string;
}

export interface VisitorTimelineEvent {
  at: string;
  kind: 'lead' | 'call' | 'hold';
  label: string;
}

export interface VisitorMapVisitor {
  id: string;
  displayName: string;
  /** "lyla" when Lyla captured the lead in chat, "form" for the demo form. */
  source: 'lyla' | 'form';
  /** Null on instant-call leads, which are captured with a phone only. */
  email: string | null;
  /** Null when the visitor never provided one (Lyla leads). */
  phone: string | null;
  businessName: string | null;
  websiteUrl: string | null;
  industry: string;
  mode: string;
  /** Business facts their own website published and the demo pulled. */
  businessFacts: { address: string | null; services: string[]; hours: string[] } | null;
  country: string | null;
  countryName: string | null;
  location: VisitorMapLocation | null;
  firstSeenAt: string;
  lastActivityAt: string;
  callCount: number;
  holdBooked: boolean;
  hold: { service: string | null; date: string | null; time: string | null; status: string } | null;
  timeline: VisitorTimelineEvent[];
}

export interface VisitorMapPoint {
  key: string;
  lat: number;
  lng: number;
  precision: 'city' | 'country';
  precisionLabel: string;
  label: string;
  country: string;
  countryName: string;
  count: number;
  visitorIds: string[];
}

export interface VisitorMapResult {
  stats: {
    totalVisitors: number;
    locatedVisitors: number;
    unlocatedVisitors: number;
    countries: number;
    last7Days: number;
  };
  points: VisitorMapPoint[];
  visitors: VisitorMapVisitor[];
}

const MAX_LEADS = 1000;
const LIVE_HOLD_STATUSES = new Set(['ACTIVE', 'CHANGED']);

function validCountry(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim().slice(0, 120))
    .slice(0, max);
}

function parseBusinessFacts(factsJson: unknown): VisitorMapVisitor['businessFacts'] {
  if (!factsJson || typeof factsJson !== 'object') return null;
  const facts = factsJson as Record<string, unknown>;
  const address = typeof facts.address === 'string' && facts.address.trim() ? facts.address.trim().slice(0, 200) : null;
  const services = stringList(facts.services, 12);
  const hours = stringList(facts.hours, 10);
  if (!address && services.length === 0 && hours.length === 0) return null;
  return { address, services, hours };
}

function locationForLead(lead: {
  ipCountry: string | null;
  phoneCountry: string | null;
  ipCity: string | null;
  ipRegion: string | null;
  ipLat: number | null;
  ipLng: number | null;
}): { country: string | null; location: VisitorMapLocation | null } {
  const country = validCountry(lead.ipCountry) ?? validCountry(lead.phoneCountry);
  if (!country) return { country: null, location: null };
  const name = countryName(country);
  if (lead.ipLat !== null && lead.ipLng !== null) {
    return {
      country,
      location: {
        city: lead.ipCity,
        region: lead.ipRegion,
        country,
        countryName: name,
        lat: lead.ipLat,
        lng: lead.ipLng,
        precision: 'city',
        precisionLabel: 'Approximate, city level (from their network)',
      },
    };
  }
  const centroid = COUNTRY_CENTROIDS[country];
  if (!centroid) return { country, location: null };
  return {
    country,
    location: {
      city: null,
      region: null,
      country,
      countryName: name,
      lat: centroid[0],
      lng: centroid[1],
      precision: 'country',
      precisionLabel: 'Country level only (pin sits at the country center)',
    },
  };
}

/** Builds the full visitor-map payload from stored demo records. */
export async function getVisitorMap(): Promise<VisitorMapResult> {
  const leads = await prisma.demoLead.findMany({
    orderBy: { createdAt: 'desc' },
    take: MAX_LEADS,
  });
  const sessionIds = [...new Set(leads.map((l) => l.demoSessionId))];
  const [calls, holds] = sessionIds.length
    ? await Promise.all([
        prisma.demoCall.findMany({
          where: { demoSessionId: { in: sessionIds } },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.demoHold.findMany({
          where: { demoSessionId: { in: sessionIds } },
          orderBy: { updatedAt: 'desc' },
        }),
      ])
    : [[], []];

  const callsBySession = new Map<string, typeof calls>();
  for (const call of calls) {
    const list = callsBySession.get(call.demoSessionId) ?? [];
    list.push(call);
    callsBySession.set(call.demoSessionId, list);
  }
  const holdsBySession = new Map<string, typeof holds>();
  for (const hold of holds) {
    const list = holdsBySession.get(hold.demoSessionId) ?? [];
    list.push(hold);
    holdsBySession.set(hold.demoSessionId, list);
  }

  const visitors: VisitorMapVisitor[] = leads.map((lead) => {
    const source: 'lyla' | 'form' = lead.demoSessionId.startsWith('lyla_') ? 'lyla' : 'form';
    const sessionCalls = callsBySession.get(lead.demoSessionId) ?? [];
    const sessionHolds = holdsBySession.get(lead.demoSessionId) ?? [];
    const latestHold = sessionHolds[0] ?? null;

    const timeline: VisitorTimelineEvent[] = [
      {
        at: lead.createdAt.toISOString(),
        kind: 'lead',
        label: source === 'lyla' ? 'Lead captured by Lyla in chat' : 'Demo form submitted',
      },
    ];
    for (const call of sessionCalls) {
      const at = (call.startedAt ?? call.createdAt).toISOString();
      const secs = call.durationSeconds;
      const duration = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
      timeline.push({
        at,
        kind: 'call',
        label: `Demo call, ${duration}${call.endedReason ? `, ended ${call.endedReason}` : ''}`,
      });
    }
    for (const hold of sessionHolds) {
      if (!LIVE_HOLD_STATUSES.has(hold.status)) continue;
      timeline.push({
        at: hold.createdAt.toISOString(),
        kind: 'hold',
        label: `Hold booked${hold.service ? `: ${hold.service}` : ''}${hold.date ? ` on ${hold.date}` : ''}${hold.time ? ` at ${hold.time}` : ''}`,
      });
    }
    timeline.sort((a, b) => a.at.localeCompare(b.at));

    const { country, location } = locationForLead(lead);
    const lastActivityAt = timeline.length
      ? timeline[timeline.length - 1].at
      : lead.createdAt.toISOString();

    return {
      id: lead.id,
      displayName: (lead.name ?? '').trim() || 'Demo visitor',
      source,
      email: lead.email,
      phone: lead.phone.trim() ? lead.phone : null,
      businessName: lead.businessName,
      websiteUrl: lead.websiteUrl,
      industry: lead.industry,
      mode: lead.mode,
      businessFacts: parseBusinessFacts(lead.factsJson),
      country,
      countryName: country ? countryName(country) : null,
      location,
      firstSeenAt: lead.createdAt.toISOString(),
      lastActivityAt,
      callCount: sessionCalls.length,
      holdBooked: sessionHolds.some((h) => LIVE_HOLD_STATUSES.has(h.status)),
      hold: latestHold
        ? { service: latestHold.service, date: latestHold.date, time: latestHold.time, status: latestHold.status }
        : null,
      timeline,
    };
  });

  // Aggregate located visitors into clustered points.
  const pointsByKey = new Map<string, VisitorMapPoint & { latSum: number; lngSum: number }>();
  for (const visitor of visitors) {
    const loc = visitor.location;
    if (!loc) continue;
    const key =
      loc.precision === 'city'
        ? `city|${loc.country}|${(loc.city ?? '').toLowerCase()}|${(loc.region ?? '').toLowerCase()}`
        : `country|${loc.country}`;
    const label =
      loc.precision === 'city'
        ? `${loc.city ?? 'Unknown city'}${loc.region ? `, ${loc.region}` : ''}, ${loc.countryName}`
        : loc.countryName;
    const existing = pointsByKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.latSum += loc.lat;
      existing.lngSum += loc.lng;
      existing.lat = existing.latSum / existing.count;
      existing.lng = existing.lngSum / existing.count;
      existing.visitorIds.push(visitor.id);
    } else {
      pointsByKey.set(key, {
        key,
        lat: loc.lat,
        lng: loc.lng,
        latSum: loc.lat,
        lngSum: loc.lng,
        precision: loc.precision,
        precisionLabel: loc.precisionLabel,
        label,
        country: loc.country,
        countryName: loc.countryName,
        count: 1,
        visitorIds: [visitor.id],
      });
    }
  }
  const points: VisitorMapPoint[] = [...pointsByKey.values()]
    .map(({ latSum: _latSum, lngSum: _lngSum, ...point }) => point)
    .sort((a, b) => b.count - a.count);

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const locatedVisitors = visitors.filter((v) => v.location !== null).length;
  return {
    stats: {
      totalVisitors: visitors.length,
      locatedVisitors,
      unlocatedVisitors: visitors.length - locatedVisitors,
      countries: new Set(visitors.map((v) => v.country).filter(Boolean)).size,
      last7Days: visitors.filter((v) => new Date(v.firstSeenAt).getTime() >= sevenDaysAgo).length,
    },
    points,
    visitors,
  };
}
