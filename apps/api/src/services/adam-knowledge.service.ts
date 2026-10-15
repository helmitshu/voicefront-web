import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { hoursToHumanText, parseBusinessHours } from '../domain/agent-config';
import { syncAssistantForTenant, uploadFileToVapi, type SyncResult } from './vapi.service';
import { utcToZonedParts } from './appointment.service';

/**
 * The Weekly Upgrade (Adam, phase 3): find the questions patients asked
 * that the receptionist could not answer, and turn the top gaps into
 * knowledge the owner approves.
 *
 * The honesty rules are enforced in code, not just in Adam's prompt:
 *  - The scan only reports what call records actually show: a caller
 *    question followed by a receptionist who could not answer it (from
 *    the transcript), or a question-intent call that ended in a message
 *    or no action (from the outcome data).
 *  - A draft addition may only restate facts that exist in the tenant's
 *    own records (services, providers, business facts, existing document
 *    names). A gap with no matching facts is marked not draftable: Adam
 *    must ask the owner instead of drafting an answer.
 *  - Every price in a draft is checked against the source corpus. A
 *    dollar figure that appears nowhere in the clinic's own records is
 *    refused outright, so an invented price can never reach the knowledge
 *    base through this path.
 *  - Applying a draft writes through the existing knowledge path: upload
 *    to the file store, create the Document row, re-sync the assistant —
 *    the same three steps the dashboard upload performs.
 */

/* ------------------------------ sources ---------------------------------- */

export interface KnowledgeSources {
  businessName: string;
  services: Array<{ name: string; durationMinutes: number; description: string | null }>;
  providers: Array<{ name: string; title: string | null }>;
  documentNames: string[];
  /** Every source fact as one text corpus: draft checks run against it. */
  corpus: string;
}

/** The tenant's own recorded facts, and only those, as drafting sources. */
export async function getKnowledgeSources(tenantId: string): Promise<KnowledgeSources> {
  const [tenant, settings, services, providers, documents] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { companyName: true, industry: true } }),
    prisma.agentSettings.findUnique({ where: { tenantId } }),
    prisma.service.findMany({
      where: { tenantId, active: true },
      orderBy: { name: 'asc' },
      select: { name: true, durationMinutes: true, description: true },
    }),
    prisma.provider.findMany({
      where: { tenantId, active: true },
      orderBy: { name: 'asc' },
      select: { name: true, title: true },
    }),
    prisma.document.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: { fileName: true },
    }),
  ]);
  if (!tenant || !settings) {
    throw new HttpError(409, 'Receptionist settings are missing for this workspace.', 'SETTINGS_MISSING');
  }

  const corpusParts: string[] = [
    `Business: ${tenant.companyName} (${tenant.industry === 'CONSTRUCTION' ? 'trades' : 'clinic'}).`,
    `Receptionist name: ${settings.displayName}.`,
    `Business hours: ${hoursToHumanText(parseBusinessHours(settings.businessHours))}.`,
    `Average appointment value: $${settings.avgAppointmentValue}.`,
  ];
  for (const s of services) {
    corpusParts.push(
      `Service: ${s.name}, ${s.durationMinutes} minutes${s.description ? `. ${s.description}` : ''}`,
    );
  }
  for (const p of providers) {
    corpusParts.push(`Provider: ${p.name}${p.title ? `, ${p.title}` : ''}.`);
  }
  if (documents.length > 0) {
    corpusParts.push(`Knowledge documents on file: ${documents.map((d) => d.fileName).join(', ')}.`);
  }
  // The owner's own call-handling instructions are tenant data too: facts
  // stated there (insurance taken, parking notes) are legitimate sources.
  if (settings.systemPrompt.trim()) {
    corpusParts.push(`Call handling instructions: ${settings.systemPrompt.trim()}`);
  }

  return {
    businessName: tenant.companyName,
    services,
    providers,
    documentNames: documents.map((d) => d.fileName),
    corpus: corpusParts.join('\n'),
  };
}

/* --------------------------- gap extraction ------------------------------ */

export interface UnansweredExample {
  question: string;
  callId: string;
  when: string;
}

export interface UnansweredGap {
  topic: string;
  /** How many distinct calls raised this gap in the range. */
  count: number;
  /** True when the tenant's own records hold facts about this topic. */
  draftable: boolean;
  examples: UnansweredExample[];
}

interface CallForScan {
  id: string;
  startedAt: Date;
  outcome: string | null;
  intent: string | null;
  summary: string | null;
  transcript: string | null;
}

/** Receptionist turns that admit the answer was not there. */
const UNCERTAINTY_PATTERNS: RegExp[] = [
  /i (?:don'?t|do not) (?:know|have)/i,
  /i'?m not (?:sure|able)/i,
  /can(?:not|'?t) (?:help|answer) (?:with )?that/i,
  /you'?ll (?:need|have) to (?:ask|call|check)/i,
  /someone (?:from the office|will) (?:call|get back)/i,
  /take a message/i,
];

const TOPIC_MATCHERS: Array<{ topic: string; pattern: RegExp }> = [
  { topic: 'Insurance coverage', pattern: /insurance|covered|coverage|delta dental|metlife|cigna|aetna|guardian|in[- ]network/i },
  { topic: 'Prices and cost', pattern: /cost|price|how much|fee|charge|quote|estimate/i },
  { topic: 'Parking', pattern: /park(?:ing)?|garage|street parking/i },
  { topic: 'Hours and scheduling', pattern: /open|close|hours|weekend|saturday|sunday|evening/i },
  { topic: 'Location and directions', pattern: /located|address|directions|get there|near|transit|bus/i },
  { topic: 'Payment plans and financing', pattern: /payment plan|financ|installment|pay (?:over|in)|monthly/i },
  { topic: 'New patients', pattern: /new patient|first (?:visit|time)|accepting/i },
  { topic: 'Emergencies and pain', pattern: /emergency|toothache|pain|swollen|broken tooth|urgent/i },
  { topic: 'Languages spoken', pattern: /spanish|french|mandarin|cantonese|language|speak/i },
  { topic: 'Accessibility', pattern: /wheelchair|accessible|elevator|ramp|disabilit/i },
];

/** Splits a transcript into utterances, dropping speaker labels. */
function utterancesOf(transcript: string): string[] {
  return transcript
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:AI|User|Caller|Patient|Receptionist|Assistant|Customer)\s*:\s*/i, '').trim())
    .filter((line) => line.length > 0);
}

function isQuestion(text: string): boolean {
  return text.includes('?') || /^(?:do|does|is|are|can|could|what|when|where|how|who)\b/i.test(text);
}

function topicOf(question: string, serviceNames: string[]): string {
  for (const matcher of TOPIC_MATCHERS) {
    if (matcher.pattern.test(question)) return matcher.topic;
  }
  const lower = question.toLowerCase();
  for (const name of serviceNames) {
    const words = name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (words.some((w) => lower.includes(w))) return `Service: ${name}`;
  }
  const words = lower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  return words ? `Other: ${words}` : 'Other questions';
}

/** A topic is draftable only when the tenant's own records mention it. */
function topicDraftable(topic: string, corpus: string, services: KnowledgeSources['services']): boolean {
  if (topic.startsWith('Service: ')) {
    const name = topic.slice('Service: '.length);
    const service = services.find((s) => s.name === name);
    return Boolean(service && (service.description?.trim() || service.durationMinutes > 0));
  }
  const matcher = TOPIC_MATCHERS.find((m) => m.topic === topic);
  if (!matcher) return false; // "Other" topics always need the owner.
  return matcher.pattern.test(corpus);
}

/**
 * Extracts the questions patients asked that the receptionist could not
 * answer, from call records. Pure: the same input always yields the same
 * gaps, so the extraction is unit-testable without a model in the loop.
 * A question counts when the very next receptionist turn admits the
 * answer was not there; without a transcript, a QUESTION-intent call
 * that ended as a message or with no action counts via its summary.
 */
export function extractUnansweredQuestions(
  calls: CallForScan[],
  sources: KnowledgeSources,
  timezone: string,
): UnansweredGap[] {
  const serviceNames = sources.services.map((s) => s.name);
  const byTopic = new Map<string, { calls: Set<string>; examples: UnansweredExample[] }>();

  const record = (call: CallForScan, question: string) => {
    const topic = topicOf(question, serviceNames);
    let entry = byTopic.get(topic);
    if (!entry) {
      entry = { calls: new Set(), examples: [] };
      byTopic.set(topic, entry);
    }
    entry.calls.add(call.id);
    if (entry.examples.length < 3 && !entry.examples.some((e) => e.question === question)) {
      entry.examples.push({
        question: question.slice(0, 200),
        callId: call.id,
        when: new Intl.DateTimeFormat('en-US', {
          timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        }).format(call.startedAt),
      });
    }
  };

  for (const call of calls) {
    let found = false;
    if (call.transcript && call.transcript.trim()) {
      const lines = utterancesOf(call.transcript);
      for (let i = 0; i < lines.length - 1; i += 1) {
        const line = lines[i]!;
        const next = lines[i + 1]!;
        if (isQuestion(line) && UNCERTAINTY_PATTERNS.some((p) => p.test(next))) {
          record(call, line);
          found = true;
        }
      }
    }
    if (!found && call.intent === 'QUESTION' && (call.outcome === 'MESSAGE_TAKEN' || call.outcome === 'NO_ACTION')) {
      const asked = /(?:asked|wanted to know|asking) (?:about )?(.+?)(?:\.|$)/i.exec(call.summary ?? '');
      if (asked?.[1]) record(call, `Patient asked about ${asked[1].trim()}`);
    }
  }

  return [...byTopic.entries()]
    .map(([topic, entry]) => ({
      topic,
      count: entry.calls.size,
      draftable: topicDraftable(topic, sources.corpus, sources.services),
      examples: entry.examples,
    }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
}

/* --------------------------------- scan ---------------------------------- */

export interface KnowledgeScanResult {
  range: { start: string; end: string };
  callsScanned: number;
  gaps: UnansweredGap[];
  sources: {
    services: KnowledgeSources['services'];
    providers: KnowledgeSources['providers'];
    documentNames: string[];
    corpus: string;
  };
}

/** Scans a tenant's calls in a range for unanswered patient questions. */
export async function scanUnansweredQuestions(
  tenantId: string,
  range: { start: Date; end: Date },
): Promise<KnowledgeScanResult> {
  const settings = await prisma.agentSettings.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  if (!settings) {
    throw new HttpError(409, 'Receptionist settings are missing for this workspace.', 'SETTINGS_MISSING');
  }
  const [calls, sources] = await Promise.all([
    prisma.callLog.findMany({
      where: { tenantId, startedAt: { gte: range.start, lt: range.end }, status: { not: 'IN_PROGRESS' } },
      orderBy: { startedAt: 'desc' },
      take: 200,
      select: { id: true, startedAt: true, outcome: true, intent: true, summary: true, transcript: true },
    }),
    getKnowledgeSources(tenantId),
  ]);
  const gaps = extractUnansweredQuestions(calls, sources, settings.timezone);
  return {
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    callsScanned: calls.length,
    gaps,
    sources: {
      services: sources.services,
      providers: sources.providers,
      documentNames: sources.documentNames,
      corpus: sources.corpus,
    },
  };
}

/* ----------------------------- draft guard ------------------------------- */

const AMOUNT_PATTERNS: RegExp[] = [
  /\$\s?(\d[\d,]*(?:\.\d{2})?)/g,
  /(\d[\d,]*(?:\.\d{2})?)\s?dollars/gi,
];

function amountsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const pattern of AMOUNT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const normalized = (match[1] ?? '').replace(/,/g, '').replace(/\.00$/, '');
      if (normalized) found.add(normalized);
    }
  }
  return found;
}

export interface DraftValidation {
  ok: boolean;
  /** Dollar figures present in the draft but absent from the sources. */
  unsourcedAmounts: string[];
}

/**
 * The sourcing gate for a knowledge draft: every dollar figure it states
 * must already exist in the tenant's own records. Anything else is the
 * owner's to supply, never the model's to invent.
 */
export function validateKnowledgeDraft(content: string, sources: KnowledgeSources): DraftValidation {
  const sourced = amountsIn(sources.corpus);
  const unsourcedAmounts = [...amountsIn(content)].filter((a) => !sourced.has(a));
  return { ok: unsourcedAmounts.length === 0, unsourcedAmounts };
}

/* ------------------------------ apply path ------------------------------- */

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'knowledge';
}

export interface KnowledgeAdditionResult {
  documentId: string;
  fileName: string;
  sync: SyncResult;
}

/**
 * Writes an approved knowledge addition through the existing knowledge
 * path, step for step the dashboard upload: file store first (so our row
 * never points at a file that does not exist), the Document row, then the
 * assistant re-sync. Best-effort sync, exactly like the upload route.
 */
export async function writeKnowledgeAddition(
  tenantId: string,
  input: { title: string; content: string },
): Promise<KnowledgeAdditionResult> {
  const fileName = `adam-knowledge-${slugifyTitle(input.title)}.md`;
  const body = `# ${input.title}\n\n${input.content.trim()}\n`;
  const buffer = Buffer.from(body, 'utf8');
  const uploaded = await uploadFileToVapi(buffer, fileName, 'text/markdown');
  const document = await prisma.document.create({
    data: {
      tenantId,
      vapiFileId: uploaded.id,
      fileName,
      mimeType: 'text/markdown',
      sizeBytes: buffer.length,
      status: uploaded.status,
    },
  });
  const sync = await syncAssistantForTenant(tenantId);
  return { documentId: document.id, fileName, sync };
}

/* ----------------------------- weekly review ----------------------------- */

/** ISO week key ("2026-W42") for an instant, in the workspace timezone. */
export function isoWeekKey(instant: Date, timezone: string): string {
  const local = utcToZonedParts(instant, timezone);
  const date = new Date(`${local.date}T12:00:00.000Z`);
  // ISO week: the year of the Thursday of this week, week 1 holds Jan 4.
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4, 12));
  const firstThursday = new Date(jan4);
  firstThursday.setUTCDate(jan4.getUTCDate() + 3 - ((jan4.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** The PENDING weekly review for a workspace, if one is waiting. */
export async function getPendingWeeklyReview(tenantId: string) {
  return prisma.adamWeeklyReview.findFirst({
    where: { tenantId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
}

/** Dismisses a pending review. Tenant-scoped; returns false when absent. */
export async function dismissWeeklyReview(tenantId: string, reviewId: string): Promise<boolean> {
  const result = await prisma.adamWeeklyReview.updateMany({
    where: { id: reviewId, tenantId, status: 'PENDING' },
    data: { status: 'DISMISSED' },
  });
  return result.count > 0;
}

/** Marks pending reviews REVIEWED once Adam has walked the owner through. */
export async function markWeeklyReviewsReviewed(tenantId: string): Promise<void> {
  await prisma.adamWeeklyReview.updateMany({
    where: { tenantId, status: 'PENDING' },
    data: { status: 'REVIEWED' },
  });
}

/**
 * The weekly job body: for every live workspace, scan the last 7 days and
 * park a PENDING review when patients hit questions the receptionist
 * could not answer. An existing row for the week is never overwritten, so
 * a dismissed or reviewed week stays handled. Returns how many reviews
 * were created.
 */
export async function runWeeklyKnowledgeReviews(now: Date = new Date()): Promise<number> {
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null, isBlocked: false, subscriptionStatus: { not: 'CANCELED' } },
    select: {
      id: true,
      agentSettings: { select: { timezone: true, inboundPhoneNumber: true } },
    },
  });
  let created = 0;
  for (const tenant of tenants) {
    if (!tenant.agentSettings?.inboundPhoneNumber) continue;
    try {
      const scan = await scanUnansweredQuestions(tenant.id, {
        start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        end: now,
      });
      const totalGaps = scan.gaps.reduce((sum, g) => sum + g.count, 0);
      if (scan.gaps.length === 0 || totalGaps === 0) continue;
      const weekKey = isoWeekKey(now, tenant.agentSettings.timezone);
      const existing = await prisma.adamWeeklyReview.findUnique({
        where: { tenantId_weekKey: { tenantId: tenant.id, weekKey } },
        select: { id: true },
      });
      if (existing) continue;
      await prisma.adamWeeklyReview.create({
        data: {
          tenantId: tenant.id,
          weekKey,
          gaps: scan.gaps as unknown as Prisma.InputJsonValue,
          gapCount: totalGaps,
          status: 'PENDING',
        },
      });
      created += 1;
    } catch (err) {
      console.error('[adam-weekly] review scan failed for tenant', tenant.id, err);
    }
  }
  return created;
}
