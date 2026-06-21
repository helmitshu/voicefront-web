'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminApi, ApiError, type LeadListResult, type LeadRow } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { formatPhone } from '@/lib/format';

const STATUSES = ['new', 'emailed', 'opened', 'clicked', 'replied', 'demoed', 'won', 'dead', 'unsubscribed'] as const;

export default function LeadsPage() {
  const { toast } = useToast();
  const [data, setData] = useState<LeadListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sourcing form (seeded with the chosen beachhead: HVAC / Phoenix).
  const [trade, setTrade] = useState('HVAC');
  const [city, setCity] = useState('Phoenix, AZ');
  const [count, setCount] = useState('20');
  const [sourcing, setSourcing] = useState(false);
  const [scraping, setScraping] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState('');
  const [emailFilter, setEmailFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      AdminApi.leads(
        {
          status: statusFilter || undefined,
          hasEmail: emailFilter === '' ? undefined : emailFilter === 'yes',
          q: search.trim() || undefined,
          page,
        },
        signal,
      )
        .then((res) => {
          setData(res);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setError(err instanceof ApiError ? err.message : 'Could not load leads.');
          setLoading(false);
        });
    },
    [statusFilter, emailFilter, search, page],
  );

  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, [load]);

  async function runSource() {
    setSourcing(true);
    try {
      const r = await AdminApi.sourceLeads({ trade, city, limit: Math.max(1, Number(count) || 20) });
      toast(`Sourced ${r.sourced} — ${r.created} new, ${r.updated} already known.`, 'success');
      setPage(1);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Sourcing failed.', 'error');
    } finally {
      setSourcing(false);
    }
  }

  async function runScrape() {
    setScraping(true);
    try {
      const r = await AdminApi.scrapeLeadEmails(40);
      const noLeadsYet = (data?.stats.total ?? 0) === 0;
      toast(
        r.scanned === 0
          ? noLeadsYet
            ? 'No leads yet — click “Source” above to find businesses first, then scrape their emails.'
            : 'No leads left to scrape — every lead with a website already has an email or was checked.'
          : `Checked ${r.scanned} site${r.scanned === 1 ? '' : 's'}, found ${r.found} new email${r.found === 1 ? '' : 's'}.`,
        r.found > 0 ? 'success' : 'info',
      );
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Email scrape failed.', 'error');
    } finally {
      setScraping(false);
    }
  }

  async function scrapeOne(lead: LeadRow) {
    setRowBusy(lead.id);
    try {
      const { email } = await AdminApi.scrapeLeadEmail(lead.id);
      toast(email ? `Found ${email}` : 'No published email on that site.', email ? 'success' : 'info');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not scrape.', 'error');
    } finally {
      setRowBusy(null);
    }
  }

  async function setStatus(lead: LeadRow, status: string) {
    setRowBusy(lead.id);
    try {
      await AdminApi.updateLead(lead.id, { status });
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update.', 'error');
    } finally {
      setRowBusy(null);
    }
  }

  async function remove(lead: LeadRow) {
    setRowBusy(lead.id);
    try {
      await AdminApi.deleteLead(lead.id);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete.', 'error');
    } finally {
      setRowBusy(null);
    }
  }

  const stats = data?.stats;

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Leads</h2>
        <p className="mt-1.5 text-sm text-ink-muted">
          Source local businesses from Google, scrape their published email, and work the outbound funnel.
        </p>
      </div>

      {/* Source + scrape controls */}
      <Card>
        <CardHeader
          title="Find leads"
          description="Pulls businesses from Google Places (name, phone, website), deduped automatically. Needs a Google Places API key under Keys & config."
        />
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_120px_auto]">
          <Input label="Trade" value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="HVAC" />
          <Input label="City" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Phoenix, AZ" />
          <Input
            label="How many"
            type="number"
            min={1}
            max={60}
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
          <div className="flex items-end">
            <Button loading={sourcing} onClick={runSource} className="w-full">
              Source
            </Button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line/60 pt-4">
          <Button
            variant="secondary"
            size="sm"
            loading={scraping}
            disabled={(data?.stats.total ?? 0) === 0}
            onClick={runScrape}
          >
            Scrape emails (next 40)
          </Button>
          <p className="text-[12.5px] text-ink-muted">
            Best-effort: fetches each website and pulls a published business email. Many small sites list none.
          </p>
        </div>
      </Card>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Total leads', value: stats.total },
            { label: 'With email', value: stats.withEmail },
            { label: 'With phone', value: stats.withPhone },
            { label: 'Emailed', value: stats.byStatus.emailed ?? 0 },
          ].map((s) => (
            <div key={s.label} className="rounded-2xl border border-line/70 bg-white p-4 shadow-card">
              <p className="font-display text-2xl font-bold tabular-nums text-ink">{s.value}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <Input
            aria-label="Search leads"
            placeholder="Search business, email or city…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <Select
          aria-label="Status"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="sm:w-44"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Has email"
          value={emailFilter}
          onChange={(e) => {
            setEmailFilter(e.target.value);
            setPage(1);
          }}
          className="sm:w-40"
        >
          <option value="">Email: any</option>
          <option value="yes">Has email</option>
          <option value="no">No email</option>
        </Select>
      </div>

      {/* Table */}
      <Card padded={false} className="overflow-hidden">
        {error ? (
          <div className="p-6">
            <EmptyState title="Couldn’t load leads" description={error} />
          </div>
        ) : loading && !data ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner className="h-6 w-6 text-signal" />
          </div>
        ) : data && data.leads.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="No leads yet"
              description="Use “Find leads” above to source your first batch of local businesses."
            />
          </div>
        ) : data ? (
          <ul className={`divide-y divide-line/60 transition-opacity ${loading ? 'opacity-60' : ''}`}>
            {data.leads.map((lead) => (
              <li key={lead.id} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-ink">{lead.businessName}</p>
                    {lead.rating != null && (
                      <span className="shrink-0 text-[11px] text-ink-muted">
                        ★ {lead.rating.toFixed(1)} ({lead.reviewCount ?? 0})
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {lead.phone ? formatPhone(lead.phone) : 'no phone'} · {lead.city}
                    {lead.website && (
                      <>
                        {' · '}
                        <a
                          href={lead.website}
                          target="_blank"
                          rel="noreferrer"
                          className="text-signal-deep hover:underline"
                        >
                          website
                        </a>
                      </>
                    )}
                  </p>
                </div>
                <div className="w-full sm:w-64">
                  {lead.email ? (
                    <a href={`mailto:${lead.email}`} className="text-[13px] font-medium text-signal-deep hover:underline">
                      {lead.email}
                    </a>
                  ) : lead.website ? (
                    <button
                      type="button"
                      disabled={rowBusy === lead.id}
                      onClick={() => scrapeOne(lead)}
                      className="text-[13px] font-medium text-ink-muted hover:text-ink disabled:opacity-50"
                    >
                      {rowBusy === lead.id ? 'Scraping…' : 'Find email →'}
                    </button>
                  ) : (
                    <span className="text-[13px] text-ink-muted/60">no website</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    aria-label="Status"
                    value={lead.status}
                    disabled={rowBusy === lead.id}
                    onChange={(e) => setStatus(lead, e.target.value)}
                    className="w-32"
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                  <button
                    type="button"
                    aria-label="Delete lead"
                    disabled={rowBusy === lead.id}
                    onClick={() => remove(lead)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-danger-soft hover:text-danger disabled:opacity-50"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                      <path d="M3 4.5h10M6.5 4.5V3.5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M5 4.5l.5 8h5l.5-8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-line/70 bg-paper/60 px-5 py-3">
            <p className="text-xs text-ink-muted">
              {data.total} leads · page {data.page} of {data.totalPages}
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={data.page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Previous
              </Button>
              <Button variant="secondary" size="sm" disabled={data.page >= data.totalPages || loading} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      <p className="px-1 text-[12px] leading-relaxed text-ink-muted/80">
        Reminder: when you email these leads, US CAN-SPAM requires an accurate from/subject, a real physical
        mailing address, and a working unsubscribe you honor. Only email published business addresses.
      </p>
    </div>
  );
}
