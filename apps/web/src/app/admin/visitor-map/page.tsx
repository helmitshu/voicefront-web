'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AdminApi,
  ApiError,
  type VisitorMapPoint,
  type VisitorMapResult,
  type VisitorMapVisitor,
} from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Badge, Card, CardHeader, EmptyState, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { WORLD_LAND_PATH, WORLD_VIEWBOX, projectLatLng } from '@/components/admin/world-map-paths';

function pinRadius(count: number): number {
  return Math.min(16, 5 + Math.sqrt(count) * 2.4);
}

function locationLine(visitor: VisitorMapVisitor): string {
  const loc = visitor.location;
  if (!loc) {
    return visitor.countryName ? `${visitor.countryName} (location unknown)` : 'Location unknown';
  }
  if (loc.precision === 'city') {
    return `${loc.city ?? 'Unknown city'}${loc.region ? `, ${loc.region}` : ''}, ${loc.countryName}`;
  }
  return `${loc.countryName} (country level only)`;
}

function VisitorDetail({ visitor }: { visitor: VisitorMapVisitor }) {
  const loc = visitor.location;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-ink">{visitor.displayName}</p>
        <Badge tone={visitor.source === 'lyla' ? 'signal' : 'neutral'}>
          {visitor.source === 'lyla' ? 'Via Lyla chat' : 'Demo form'}
        </Badge>
        {visitor.holdBooked && (
          <Badge tone="success" dot>
            Hold booked
          </Badge>
        )}
      </div>

      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Email</dt>
          <dd className="text-ink">{visitor.email ?? 'Not collected'}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Phone</dt>
          <dd className="text-ink">{visitor.phone ?? 'Not provided'}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Business</dt>
          <dd className="text-ink">{visitor.businessName ?? 'Not provided'}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Website</dt>
          <dd className="break-all text-ink">{visitor.websiteUrl ?? 'Not provided'}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Location</dt>
          <dd className="text-ink">
            {locationLine(visitor)}
            {loc && <span className="block text-xs text-ink-muted">{loc.precisionLabel}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Demo activity</dt>
          <dd className="text-ink">
            First seen {formatDateTime(visitor.firstSeenAt)}
            <span className="block text-xs text-ink-muted">
              Last activity {formatDateTime(visitor.lastActivityAt)} · {visitor.callCount}{' '}
              {visitor.callCount === 1 ? 'call' : 'calls'} · mode {visitor.mode}
            </span>
          </dd>
        </div>
      </dl>

      {visitor.hold && (
        <p className="text-sm text-ink">
          <span className="font-medium">Latest hold:</span> {visitor.hold.service ?? 'Appointment'}
          {visitor.hold.date ? ` on ${visitor.hold.date}` : ''}
          {visitor.hold.time ? ` at ${visitor.hold.time}` : ''} ({visitor.hold.status})
        </p>
      )}

      {visitor.businessFacts && (
        <div className="rounded-xl bg-paper/60 px-4 py-3 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            Facts from their website
          </p>
          {visitor.businessFacts.address && <p className="mt-1 text-ink">{visitor.businessFacts.address}</p>}
          {visitor.businessFacts.services.length > 0 && (
            <p className="mt-1 text-ink">
              <span className="font-medium">Services:</span> {visitor.businessFacts.services.join(', ')}
            </p>
          )}
          {visitor.businessFacts.hours.length > 0 && (
            <p className="mt-1 text-ink">
              <span className="font-medium">Hours:</span> {visitor.businessFacts.hours.join(' · ')}
            </p>
          )}
        </div>
      )}

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Timeline</p>
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {visitor.timeline.map((event, i) => (
            <li key={i} className="flex gap-3 text-sm">
              <span className="shrink-0 text-xs leading-5 text-ink-muted">{formatDateTime(event.at)}</span>
              <span className="text-ink">{event.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function AdminVisitorMapPage() {
  const [data, setData] = useState<VisitorMapResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedPointKey, setSelectedPointKey] = useState<string | null>(null);
  const [expandedVisitorId, setExpandedVisitorId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    AdminApi.visitorMap(controller.signal)
      .then(setData)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Could not load the visitor map.');
      });
    return () => controller.abort();
  }, [reloadKey]);

  const visitorsById = useMemo(() => {
    const map = new Map<string, VisitorMapVisitor>();
    for (const v of data?.visitors ?? []) map.set(v.id, v);
    return map;
  }, [data]);

  const selectedPoint: VisitorMapPoint | null = useMemo(() => {
    if (!data || !selectedPointKey) return null;
    return data.points.find((p) => p.key === selectedPointKey) ?? null;
  }, [data, selectedPointKey]);

  if (error) {
    return (
      <EmptyState
        title="Couldn't load the visitor map"
        description={error}
        action={
          <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  const { stats } = data;
  const selectedVisitors = (selectedPoint?.visitorIds ?? [])
    .map((id) => visitorsById.get(id))
    .filter((v): v is VisitorMapVisitor => Boolean(v));
  const selectedXY = selectedPoint ? projectLatLng(selectedPoint.lat, selectedPoint.lng) : null;
  const popupLeftPct = selectedXY ? Math.min(86, Math.max(14, (selectedXY.x / 1000) * 100)) : 50;
  const popupTopPct = selectedXY ? (selectedXY.y / 500) * 100 : 50;

  return (
    <div className="flex animate-fade-up flex-col gap-8">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Visitor map</h2>
        <p className="mt-1.5 text-sm text-ink-muted">
          Where demo visitors are, from the details they gave us and what they did in the demo.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Visitors on the map" value={String(stats.locatedVisitors)} sublabel={`${stats.totalVisitors} demo visitors in total`} accent />
        <StatCard label="Countries" value={String(stats.countries)} sublabel="with at least one visitor" />
        <StatCard label="Last 7 days" value={String(stats.last7Days)} sublabel="new demo visitors" />
        <StatCard
          label="Location unknown"
          value={String(stats.unlocatedVisitors)}
          sublabel="no usable location was stored"
        />
      </div>

      <p className="rounded-2xl border border-line/60 bg-paper/50 px-5 py-4 text-sm leading-relaxed text-ink-muted">
        Locations are approximate. They come from the visitor's network connection, so they are
        city level at best, and some visitors can only be placed at the center of their country;
        those pins say so. The details shown are what each visitor typed into the demo form or
        told Lyla, plus their demo activity. Raw network addresses are never stored or shown.
      </p>

      {stats.totalVisitors === 0 ? (
        <EmptyState
          title="No demo visitors yet"
          description="As visitors run the demo, each one will appear here as a pin on the map with the details they provided and a timeline of their demo activity."
        />
      ) : (
        <>
          <Card padded={false}>
            <div className="px-6 pt-5">
              <CardHeader
                title="Around the world"
                description="Bigger pins mean more visitors in one place. Select a pin to see who they are."
              />
            </div>
            <div className="relative px-3 pb-3 sm:px-5 sm:pb-5">
              <svg viewBox={WORLD_VIEWBOX} className="block w-full" role="img" aria-label="World map of demo visitors">
                <rect x="0" y="0" width="1000" height="500" className="fill-signal/5" rx="12" />
                <path d={WORLD_LAND_PATH} className="fill-ink/15 stroke-ink/25" strokeWidth="0.6" />
                {data.points.map((point) => {
                  const { x, y } = projectLatLng(point.lat, point.lng);
                  const r = pinRadius(point.count);
                  const selected = point.key === selectedPointKey;
                  return (
                    <g
                      key={point.key}
                      transform={`translate(${x} ${y})`}
                      className="cursor-pointer"
                      onClick={() => setSelectedPointKey(selected ? null : point.key)}
                    >
                      <circle r={r + 7} className="fill-transparent" />
                      <circle
                        r={r}
                        className={selected ? 'fill-signal-deep stroke-white' : 'fill-signal/80 stroke-white/70'}
                        strokeWidth="1.4"
                      />
                      <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        className="pointer-events-none fill-white text-[10px] font-bold"
                      >
                        {point.count}
                      </text>
                    </g>
                  );
                })}
              </svg>

              {selectedPoint && selectedXY && (
                <div
                  className="absolute z-10 w-72 max-w-[85%] rounded-2xl border border-line bg-white p-4 shadow-lift"
                  style={{
                    left: `${popupLeftPct}%`,
                    top: `${popupTopPct}%`,
                    transform: 'translate(-50%, calc(-100% - 16px))',
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-ink">{selectedPoint.label}</p>
                      <p className="mt-0.5 text-xs text-ink-muted">{selectedPoint.precisionLabel}</p>
                    </div>
                    <button
                      type="button"
                      aria-label="Close"
                      className="text-lg leading-none text-ink-muted transition-colors hover:text-ink"
                      onClick={() => setSelectedPointKey(null)}
                    >
                      ×
                    </button>
                  </div>
                  <p className="mt-2 text-sm text-ink">
                    {selectedPoint.count} {selectedPoint.count === 1 ? 'visitor' : 'visitors'}
                  </p>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {selectedVisitors.slice(0, 4).map((v) => (
                      <li key={v.id} className="truncate text-sm text-ink-muted">
                        {v.displayName}
                        {v.businessName ? ` · ${v.businessName}` : ''}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-ink-muted">Full details are in the panel below the map.</p>
                </div>
              )}
            </div>
          </Card>

          {selectedPoint && (
            <Card>
              <CardHeader
                title={selectedPoint.label}
                description={`${selectedPoint.count} ${selectedPoint.count === 1 ? 'visitor' : 'visitors'} · ${selectedPoint.precisionLabel}`}
              />
              <div className="mt-2 flex flex-col gap-6">
                {selectedVisitors.map((visitor) => (
                  <div key={visitor.id} className="border-t border-line/60 pt-5 first:border-t-0 first:pt-0">
                    <VisitorDetail visitor={visitor} />
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card padded={false}>
            <div className="px-6 pt-5">
              <CardHeader title="All demo visitors" description="Newest first. Select a row to see the full details." />
            </div>
            <ul className="divide-y divide-line/60 px-6 pb-4">
              {data.visitors.map((visitor) => {
                const expanded = visitor.id === expandedVisitorId;
                return (
                  <li key={visitor.id} className="py-3">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-4 text-left"
                      onClick={() => {
                        setExpandedVisitorId(expanded ? null : visitor.id);
                        if (visitor.location) {
                          const point = data.points.find((p) => p.visitorIds.includes(visitor.id));
                          if (point) setSelectedPointKey(point.key);
                        }
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-ink">
                          {visitor.displayName}
                          {visitor.businessName ? ` · ${visitor.businessName}` : ''}
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          {locationLine(visitor)} · first seen {formatDateTime(visitor.firstSeenAt)} ·{' '}
                          {visitor.source === 'lyla' ? 'via Lyla' : 'demo form'}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {visitor.holdBooked && (
                          <Badge tone="success" dot>
                            Hold booked
                          </Badge>
                        )}
                        <span className="text-xs font-medium text-ink-muted">{expanded ? 'Hide' : 'Details'}</span>
                      </span>
                    </button>
                    {expanded && (
                      <div className="mt-3 rounded-xl bg-paper/50 px-4 py-4">
                        <VisitorDetail visitor={visitor} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
