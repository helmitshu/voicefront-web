'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminApi, ApiError, type LeadListResult, type LeadRow, type OutreachEmailDto } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { formatPhone } from '@/lib/format';

const STATUSES = ['new', 'emailed', 'opened', 'clicked', 'replied', 'demoed', 'won', 'dead', 'unsubscribed'] as const;

// Funnel colour so the list is scannable at a glance.
const STATUS_DOT: Record<string, string> = {
  new: 'bg-ink-muted/40',
  emailed: 'bg-signal',
  opened: 'bg-signal',
  clicked: 'bg-signal-deep',
  replied: 'bg-clinic',
  demoed: 'bg-clinic',
  won: 'bg-clinic',
  dead: 'bg-danger',
  unsubscribed: 'bg-ink-muted/40',
};

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

  // Test send (to your own addresses, not the leads)
  const [testEmails, setTestEmails] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { sent: number; total: number; results: { to: string; ok: boolean; error?: string }[] } | null
  >(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState('');
  const [emailFilter, setEmailFilter] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sort, setSort] = useState<'newest' | 'rating'>('newest');
  const [page, setPage] = useState(1);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bulk selection (ids persist only within the current filtered view)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // Inline notes editing
  const [editingNotes, setEditingNotes] = useState<string | null>(null);

  // Email preview modal
  const [previewLead, setPreviewLead] = useState<LeadRow | null>(null);
  const [previewEmail, setPreviewEmail] = useState<OutreachEmailDto | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Debounce typing → one query per pause, reset to page 1 on new terms.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      AdminApi.leads(
        {
          status: statusFilter || undefined,
          hasEmail: emailFilter === '' ? undefined : emailFilter === 'yes',
          q: debouncedSearch || undefined,
          sort,
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
    [statusFilter, emailFilter, debouncedSearch, sort, page],
  );

  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, [load]);

  // Clear the selection whenever the visible set changes, so bulk actions never
  // hit rows you can no longer see.
  useEffect(() => {
    setSelected(new Set());
  }, [statusFilter, emailFilter, debouncedSearch, sort, page]);

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
      const r = await AdminApi.scrapeLeadEmails(10);
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

  async function runTest() {
    const recipients = testEmails.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (recipients.length === 0) {
      toast('Add at least one email address to send the test to.', 'error');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await AdminApi.testEmail(recipients);
      setTestResult(r);
      toast(`Test sent to ${r.sent} of ${r.total}.`, r.sent > 0 ? 'success' : 'error');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Test send failed.', 'error');
    } finally {
      setTesting(false);
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

  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function toggleAllOnPage() {
    if (!data) return;
    const ids = data.leads.map((l) => l.id);
    const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
    setSelected((s) => {
      const n = new Set(s);
      if (allOn) ids.forEach((id) => n.delete(id));
      else ids.forEach((id) => n.add(id));
      return n;
    });
  }

  async function bulkAction(action: 'delete' | 'status', status?: string) {
    if (selected.size === 0) return;
    if (action === 'delete' && !window.confirm(`Delete ${selected.size} lead${selected.size === 1 ? '' : 's'}?`)) {
      return;
    }
    setBulkBusy(true);
    try {
      const r = await AdminApi.bulkLeads([...selected], action, status);
      toast(
        action === 'delete' ? `Deleted ${r.count} lead${r.count === 1 ? '' : 's'}.` : `Updated ${r.count} lead${r.count === 1 ? '' : 's'}.`,
        'success',
      );
      setSelected(new Set());
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Bulk action failed.', 'error');
    } finally {
      setBulkBusy(false);
    }
  }

  async function openEmail(lead: LeadRow) {
    setPreviewLead(lead);
    setPreviewEmail(null);
    setPreviewLoading(true);
    try {
      const { email } = await AdminApi.leadEmail(lead.id);
      setPreviewEmail(email);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not generate the email.', 'error');
      setPreviewLead(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied.`, 'success');
    } catch {
      toast('Could not copy — your browser blocked clipboard access.', 'error');
    }
  }

  async function saveNotes(lead: LeadRow, notes: string) {
    const trimmed = notes.trim();
    if (trimmed === (lead.notes ?? '')) {
      setEditingNotes(null);
      return;
    }
    try {
      await AdminApi.updateLead(lead.id, { notes: trimmed });
      setEditingNotes(null);
      load();
      toast('Note saved.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save note.', 'error');
    }
  }

  async function markEmailed() {
    if (!previewLead) return;
    try {
      await AdminApi.updateLead(previewLead.id, { status: 'emailed' });
      setPreviewLead(null);
      setPreviewEmail(null);
      load();
      toast('Marked as emailed.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update.', 'error');
    }
  }

  // "Next →" in the email modal walks the emailable leads in the current view.
  const emailable = data?.leads.filter((l) => l.email) ?? [];
  const previewIdx = previewLead ? emailable.findIndex((l) => l.id === previewLead.id) : -1;
  function openNext() {
    if (previewIdx >= 0 && previewIdx < emailable.length - 1) openEmail(emailable[previewIdx + 1]);
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
            Scrape emails (next 10)
          </Button>
          <p className="text-[12.5px] text-ink-muted">
            Best-effort: fetches each website and pulls a published business email. Many small sites list none.
          </p>
        </div>
      </Card>

      {/* Test send */}
      <Card>
        <CardHeader
          title="Send a test email"
          description="Sends the outreach email (using a sample HVAC lead) to addresses you list below — never to a real lead. Use it to check rendering and deliverability. Set the Resend key + “from” email under Keys & config first."
        />
        <textarea
          value={testEmails}
          onChange={(e) => setTestEmails(e.target.value)}
          rows={2}
          placeholder="you@gmail.com, teammate@gmail.com"
          className="w-full rounded-xl border border-line bg-paper/60 px-3 py-2 text-sm text-ink shadow-input outline-none focus:border-signal/60 focus:ring-2 focus:ring-signal/20"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" loading={testing} onClick={runTest}>
            Send test
          </Button>
          {testResult && (
            <p className="text-[12.5px] font-medium text-ink-muted">
              Sent {testResult.sent} of {testResult.total}.
            </p>
          )}
        </div>
        {testResult && testResult.results.some((r) => !r.ok) && (
          <ul className="mt-2 flex flex-col gap-1">
            {testResult.results
              .filter((r) => !r.ok)
              .map((r) => (
                <li key={r.to} className="text-[12px] text-danger">
                  {r.to}: {r.error}
                </li>
              ))}
          </ul>
        )}
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-muted/80">
          Testing without a domain? Set the “from” email to <span className="font-mono">onboarding@resend.dev</span> —
          Resend will only deliver to your own Resend signup email until you verify a domain.
        </p>
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
      <div className="flex flex-col gap-3">
        {/* Quick views */}
        <div className="flex flex-wrap gap-2">
          {[
            { label: 'Ready to email', apply: () => { setStatusFilter('new'); setEmailFilter('yes'); } },
            { label: 'Needs email', apply: () => { setStatusFilter(''); setEmailFilter('no'); } },
            { label: 'Replied', apply: () => { setStatusFilter('replied'); setEmailFilter(''); } },
            { label: 'All', apply: () => { setStatusFilter(''); setEmailFilter(''); setSearch(''); } },
          ].map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => { c.apply(); setPage(1); }}
              className="rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] font-medium text-ink-muted transition-colors hover:border-signal/40 hover:text-ink"
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1">
            <Input
              aria-label="Search leads"
              placeholder="Search business, email or city…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select
            aria-label="Sort"
            value={sort}
            onChange={(e) => { setSort(e.target.value as 'newest' | 'rating'); setPage(1); }}
            className="sm:w-40"
          >
            <option value="newest">Newest first</option>
            <option value="rating">Top rated first</option>
          </Select>
          <Select
            aria-label="Status"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="sm:w-40"
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
            onChange={(e) => { setEmailFilter(e.target.value); setPage(1); }}
            className="sm:w-36"
          >
            <option value="">Email: any</option>
            <option value="yes">Has email</option>
            <option value="no">No email</option>
          </Select>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-signal/30 bg-signal-soft/50 px-4 py-2.5">
          <p className="text-sm font-semibold text-signal-deep">{selected.size} selected</p>
          <Button size="sm" variant="secondary" loading={bulkBusy} onClick={() => bulkAction('status', 'emailed')}>
            Mark emailed
          </Button>
          <Select
            aria-label="Set status for selected"
            value=""
            disabled={bulkBusy}
            onChange={(e) => e.target.value && bulkAction('status', e.target.value)}
            className="w-40"
          >
            <option value="">Set status…</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => bulkAction('delete')}
            className="text-[13px] font-medium text-danger hover:underline disabled:opacity-50"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-[13px] font-medium text-ink-muted hover:text-ink"
          >
            Clear
          </button>
        </div>
      )}

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
          <>
            <div className="flex items-center gap-3 border-b border-line/60 bg-paper/50 px-5 py-2.5">
              <input
                type="checkbox"
                aria-label="Select all on this page"
                checked={data.leads.length > 0 && data.leads.every((l) => selected.has(l.id))}
                onChange={toggleAllOnPage}
                className="h-4 w-4 rounded border-line accent-signal"
              />
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
              </span>
            </div>
            <ul className={`divide-y divide-line/60 transition-opacity ${loading ? 'opacity-60' : ''}`}>
              {data.leads.map((lead) => (
                <li key={lead.id} className="px-5 py-3.5">
                  <div className="flex items-start gap-3 sm:items-center">
                  <input
                    type="checkbox"
                    aria-label={`Select ${lead.businessName}`}
                    checked={selected.has(lead.id)}
                    onChange={() => toggleSelect(lead.id)}
                    className="mt-1 h-4 w-4 shrink-0 rounded border-line accent-signal sm:mt-0"
                  />
                  <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[lead.status] ?? 'bg-ink-muted/40'}`}
                          aria-hidden
                        />
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
                  {lead.email && (
                    <Button size="sm" variant="secondary" onClick={() => openEmail(lead)}>
                      Email
                    </Button>
                  )}
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
                    aria-label={lead.notes ? 'Edit note' : 'Add note'}
                    title={lead.notes ?? 'Add a note'}
                    onClick={() => setEditingNotes((cur) => (cur === lead.id ? null : lead.id))}
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-paper ${
                      lead.notes ? 'text-signal-deep' : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                      <path d="M11 2.5l2.5 2.5L6 12.5l-3 .5.5-3z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
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
                  </div>
                  </div>
                  {editingNotes === lead.id && (
                    <div className="mt-2.5 sm:pl-7">
                      <textarea
                        autoFocus
                        defaultValue={lead.notes ?? ''}
                        placeholder="Notes — e.g. left a voicemail, follow up Tuesday…"
                        onBlur={(e) => saveNotes(lead, e.target.value)}
                        rows={2}
                        className="w-full rounded-xl border border-line bg-paper/60 px-3 py-2 text-sm text-ink shadow-input outline-none focus:border-signal/60 focus:ring-2 focus:ring-signal/20"
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
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

      {/* Email preview modal */}
      {previewLead && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-sm sm:p-8"
          onClick={() => setPreviewLead(null)}
        >
          <div
            className="my-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-line/70 bg-white shadow-lift"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-line/60 px-5 py-3.5">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-muted">
                  Outreach email{previewIdx >= 0 ? ` · ${previewIdx + 1} of ${emailable.length}` : ''}
                </p>
                <p className="truncate text-sm font-semibold text-ink">{previewLead.businessName}</p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setPreviewLead(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-paper hover:text-ink"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {previewLoading || !previewEmail ? (
              <div className="flex h-48 items-center justify-center">
                <Spinner className="h-6 w-6 text-signal" />
              </div>
            ) : (
              <div className="flex flex-col gap-3 p-5">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">To</p>
                  <p className="text-sm text-ink">{previewLead.email}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Subject</p>
                  <p className="text-sm font-medium text-ink">{previewEmail.subject}</p>
                </div>
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Preview</p>
                  <iframe
                    title="Email preview"
                    srcDoc={previewEmail.html}
                    sandbox=""
                    className="h-[420px] w-full rounded-xl border border-line/70 bg-paper"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-line/60 pt-4">
                  <Button size="sm" onClick={() => copy(previewEmail.html, 'HTML')}>
                    Copy HTML
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => copy(previewEmail.text, 'Plain text')}>
                    Copy text
                  </Button>
                  <a
                    href={`mailto:${previewLead.email}?subject=${encodeURIComponent(previewEmail.subject)}&body=${encodeURIComponent(previewEmail.text)}`}
                    className="rounded-full border border-line bg-white px-3.5 py-1.5 text-[13px] font-semibold text-ink shadow-input transition-colors hover:border-ink-muted/40"
                  >
                    Open in mail app
                  </a>
                  <div className="ml-auto flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={markEmailed}>
                      Mark as emailed
                    </Button>
                    {previewIdx >= 0 && previewIdx < emailable.length - 1 && (
                      <Button size="sm" variant="secondary" onClick={openNext}>
                        Next →
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-[11.5px] leading-relaxed text-ink-muted/80">
                  The styled version (money card + button) only renders when sent as HTML — “Open in mail app”
                  carries the plain-text version. One-click sending of the full HTML is the next step.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
