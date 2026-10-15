import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { callTeamModel, partsToText } from './team-gemini';
import { TEAM_MEMBERS, VOICEFRONT_CONTEXT_PACK } from './team-content';
import { htmlToText } from './team-tools';

/**
 * The team's standing abilities, as real services over real data. Each
 * one runs on demand from the Team page (no cron in v1) and leaves its
 * output where the founder can see it: a stored draft, a failure-museum
 * case, or a work item with the numbers in it. Where an ability is a
 * skeleton, its output says so in plain words.
 */

/* ----------------------------- call scoring ----------------------------- */

export interface CallCheck {
  key: 'greeting' | 'numberReadback' | 'doubleBooking' | 'cleanGoodbye';
  label: string;
  pass: boolean;
  provingLine: string | null;
}

export interface CallScore {
  checks: CallCheck[];
  passed: boolean;
  passedCount: number;
}

const ASSISTANT_LINE = /^(AI|Assistant|Agent|Maya|Receptionist)\s*:\s*(.*)$/i;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'oh'];
const CONFIRM_PATTERN =
  /(got you (held|booked)|you('re| are) (all )?(booked|set)|appointment is (held|booked|confirmed)|i('ve| have) (held|booked|confirmed)|you('re| are) confirmed)/i;
const FAREWELL_PATTERN = /(goodbye|bye|take care|have a (great|good|wonderful) day)/i;

function assistantLines(transcript: string): string[] {
  const lines = transcript
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const labelled = lines
    .map((line) => line.match(ASSISTANT_LINE)?.[2])
    .filter((text): text is string => typeof text === 'string' && text.length > 0);
  // Unlabelled transcripts (rare) degrade to blob heuristics over the text.
  return labelled.length > 0 ? labelled : lines;
}

function digitCount(text: string): number {
  return (text.match(/\d/g) ?? []).length;
}

function numberWordCount(text: string): number {
  const words = text.toLowerCase().split(/[^a-z]+/);
  return words.filter((word) => NUMBER_WORDS.includes(word)).length;
}

/**
 * Score one call transcript against the quality checklist. Deterministic:
 * the same transcript always gets the same score, and every failed check
 * quotes the line that proves it (or null when the proof is an absence).
 */
export function scoreCallTranscript(transcript: string, companyName?: string): CallScore {
  const lines = assistantLines(transcript ?? '');
  const first = lines[0] ?? '';
  const last = lines[lines.length - 1] ?? '';
  const checks: CallCheck[] = [];

  // 1. Right greeting: the opening names the business or a proper welcome.
  const greetingOk =
    /(thanks for calling|welcome to|this is .* (clinic|studio|dental|reception))/i.test(first) ||
    (companyName ? first.toLowerCase().includes(companyName.toLowerCase().split(' ')[0]) : false);
  checks.push({
    key: 'greeting',
    label: 'Right greeting (names the clinic)',
    pass: greetingOk,
    provingLine: first || null,
  });

  // 2. Number read back: a line carrying a full number AND a confirmation
  // ask in the same or the immediately following assistant line.
  let readbackLine: string | null = null;
  let numberSeenLine: string | null = null;
  lines.forEach((line, i) => {
    const carriesNumber = digitCount(line) >= 7 || numberWordCount(line) >= 5;
    if (carriesNumber && !numberSeenLine) numberSeenLine = line;
    if (carriesNumber && !readbackLine) {
      const next = lines[i + 1] ?? '';
      if (/(confirm|is that (right|correct)|does that sound|correct\?)/i.test(line) ||
          /(confirm|is that (right|correct)|does that sound|correct\?)/i.test(next)) {
        readbackLine = line;
      }
    }
  });
  checks.push({
    key: 'numberReadback',
    label: 'Callback number read back for confirmation',
    pass: readbackLine !== null,
    provingLine: readbackLine ?? numberSeenLine,
  });

  // 3. No double booking: at most one full confirmation of a booking.
  const confirmations = lines.filter((line) => CONFIRM_PATTERN.test(line));
  checks.push({
    key: 'doubleBooking',
    label: 'No double booking (one confirmation only)',
    pass: confirmations.length <= 1,
    provingLine: confirmations.length > 1 ? confirmations[1] : (confirmations[0] ?? null),
  });

  // 4. Clean goodbye: the call ends on a farewell, said once. A doubled
  // farewell (the bug that shipped twice) fails this check.
  const lastTwo = lines.slice(-2);
  const doubledFarewell = lastTwo.length === 2 && lastTwo.every((line) => FAREWELL_PATTERN.test(line));
  const endsOnFarewell = FAREWELL_PATTERN.test(last);
  checks.push({
    key: 'cleanGoodbye',
    label: 'Clean goodbye (one farewell, at the end)',
    pass: endsOnFarewell && !doubledFarewell,
    provingLine: doubledFarewell ? lastTwo.join(' / ') : last || null,
  });

  const passedCount = checks.filter((check) => check.pass).length;
  return { checks, passed: passedCount === checks.length, passedCount };
}

/**
 * Run call scoring over recent calls with stored transcripts. Failing
 * calls get a Priya scorecard draft and a failure-museum case (deduped
 * by call), so the bug becomes a permanent regression case.
 */
export async function runCallScoring(params: { limit?: number } = {}): Promise<{
  scored: number;
  passed: number;
  failed: number;
  draftsCreated: number;
}> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const calls = await prisma.callLog.findMany({
    where: { transcript: { not: null } },
    orderBy: { startedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      startedAt: true,
      transcript: true,
      tenant: { select: { companyName: true } },
    },
  });
  let passed = 0;
  let draftsCreated = 0;
  for (const call of calls) {
    const score = scoreCallTranscript(call.transcript ?? '', call.tenant.companyName);
    if (score.passed) {
      passed++;
      continue;
    }
    const failedChecks = score.checks.filter((check) => !check.pass);
    const body = [
      `Call ${call.id} at ${call.tenant.companyName} (${call.startedAt.toISOString()}) scored ${score.passedCount}/4.`,
      '',
      ...failedChecks.map(
        (check) => `FAIL ${check.label}\n  Proof: ${check.provingLine ? `"${check.provingLine}"` : '(absent from the transcript)'}`,
      ),
      '',
      ...score.checks
        .filter((check) => check.pass)
        .map((check) => `PASS ${check.label}`),
    ].join('\n');
    const existingCase = await prisma.failureCase.findFirst({ where: { callLogId: call.id } });
    if (!existingCase) {
      await prisma.failureCase.create({
        data: {
          title: `Call quality: ${failedChecks.map((check) => check.key).join(', ')} (${call.tenant.companyName})`,
          description: body,
          callLogId: call.id,
          checksJson: JSON.parse(JSON.stringify(score.checks)),
        },
      });
    }
    await prisma.teamDraft.create({
      data: {
        memberSlug: 'priya',
        kind: 'SCORECARD',
        title: `Scorecard: ${call.tenant.companyName} call ${call.id.slice(0, 8)} (${score.passedCount}/4)`,
        body,
      },
    });
    draftsCreated++;
  }
  return { scored: calls.length, passed, failed: calls.length - passed, draftsCreated };
}

export async function listFailureCases(limit = 50) {
  return prisma.failureCase.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
  });
}

/* ------------------------------ leak radar ------------------------------ */

export interface Leak {
  kind: 'abandoned_demos' | 'stale_trials' | 'near_minute_cap';
  title: string;
  detail: string;
  count: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the funnel leaks from real tables. Pure over its inputs is not
 * possible (the inputs ARE the tables), so this reads bounded windows:
 * demo leads from the last 7 days, trialing tenants, and this month's
 * call minutes against each tenant's cap.
 */
export async function computeLeakRadar(now = new Date()): Promise<Leak[]> {
  const leaks: Leak[] = [];
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  // Abandoned demos: a lead old enough to have taken the call, whose
  // session never produced a DemoCall.
  const leads = await prisma.demoLead.findMany({
    where: { createdAt: { gte: weekAgo, lte: twoHoursAgo } },
    select: { id: true, demoSessionId: true, businessName: true, name: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  if (leads.length > 0) {
    const sessions = [...new Set(leads.map((lead) => lead.demoSessionId))];
    const calledSessions = await prisma.demoCall.findMany({
      where: { demoSessionId: { in: sessions } },
      select: { demoSessionId: true },
      distinct: ['demoSessionId'],
    });
    const called = new Set(calledSessions.map((row) => row.demoSessionId));
    const abandoned = leads.filter((lead) => !called.has(lead.demoSessionId));
    if (abandoned.length > 0) {
      const examples = abandoned
        .slice(0, 5)
        .map((lead) => lead.businessName || lead.name)
        .join(', ');
      leaks.push({
        kind: 'abandoned_demos',
        count: abandoned.length,
        title: `Leak radar: ${abandoned.length} abandoned demos this week`,
        detail: `${abandoned.length} prospects started a personalized demo in the last 7 days and never took a call. Examples: ${examples}. Each one is a clinic that saw the offer and walked away before hearing Maya.`,
      });
    }
  }

  // Trials older than 24h whose receptionist never went live.
  const staleTrials = await prisma.tenant.findMany({
    where: {
      subscriptionStatus: 'TRIALING',
      deletedAt: null,
      createdAt: { lt: new Date(now.getTime() - DAY_MS) },
      OR: [{ onboarding: { is: null } }, { onboarding: { is: { isActive: false } } }],
    },
    select: { companyName: true, slug: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  if (staleTrials.length > 0) {
    const oldest = staleTrials[0];
    leaks.push({
      kind: 'stale_trials',
      count: staleTrials.length,
      title: `Leak radar: ${staleTrials.length} trials not activated after 24h`,
      detail: `${staleTrials.length} trialing workspaces are older than 24 hours and their receptionist is not live. Oldest: ${oldest.companyName} (${oldest.slug}), signed up ${oldest.createdAt.toISOString()}. A trial that never hears its own receptionist does not convert.`,
    });
  }

  // Tenants nearing their monthly minute cap.
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null, subscriptionStatus: { in: ['ACTIVE', 'TRIALING'] } },
    select: { id: true, companyName: true, slug: true, monthlyMinuteLimit: true },
    take: 500,
  });
  for (const tenant of tenants) {
    if (!tenant.monthlyMinuteLimit) continue;
    const agg = await prisma.callLog.aggregate({
      where: { tenantId: tenant.id, startedAt: { gte: monthStart } },
      _sum: { durationSeconds: true },
    });
    const minutes = (agg._sum.durationSeconds ?? 0) / 60;
    const ratio = minutes / tenant.monthlyMinuteLimit;
    if (ratio >= 0.8) {
      leaks.push({
        kind: 'near_minute_cap',
        count: 1,
        title: `Leak radar: ${tenant.companyName} at ${Math.round(ratio * 100)}% of minute cap`,
        detail: `${tenant.companyName} (${tenant.slug}) has used ${Math.round(minutes)} of ${tenant.monthlyMinuteLimit} minutes this month (${Math.round(ratio * 100)}%). At the cap the receptionist stops answering until the month rolls over; this clinic needs a plan conversation before that day.`,
      });
    }
  }

  return leaks;
}

/** File each leak as a work item (deduped against still-open items). */
export async function runLeakRadar(): Promise<{ leaks: Leak[]; workItemsCreated: number }> {
  const leaks = await computeLeakRadar();
  let workItemsCreated = 0;
  for (const leak of leaks) {
    const open = await prisma.workItem.findFirst({
      where: { title: leak.title, status: { in: ['QUEUED', 'IN_PROGRESS'] } },
    });
    if (open) continue;
    await prisma.workItem.create({
      data: { title: leak.title, detail: leak.detail, ownerSlug: 'daniel' },
    });
    workItemsCreated++;
  }
  return { leaks, workItemsCreated };
}

/* ------------------------------ uptime watch ---------------------------- */

export interface UptimeCheckResult {
  name: string;
  url: string;
  ok: boolean;
  status: number | null;
  evidence: string;
}

const UPTIME_TARGETS = [
  {
    name: 'API health',
    url: process.env.TEAM_HEALTH_API_URL ?? 'https://voicefrontapi-production.up.railway.app/api/health',
    expectJsonOk: true,
  },
  {
    name: 'Web app',
    url: process.env.TEAM_HEALTH_WEB_URL ?? 'https://voicefrontweb-production.up.railway.app',
    expectJsonOk: false,
  },
];

/**
 * On-demand uptime check (no cron in v1). A failing target files a work
 * item with the evidence attached; a healthy run files nothing.
 */
export async function runUptimeCheck(): Promise<{
  checks: UptimeCheckResult[];
  workItemCreated: boolean;
}> {
  const checks: UptimeCheckResult[] = [];
  for (const target of UPTIME_TARGETS) {
    const startedAt = new Date();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(target.url, { signal: controller.signal });
      clearTimeout(timer);
      let ok = res.status === 200;
      let evidence = `HTTP ${res.status} at ${startedAt.toISOString()}`;
      if (ok && target.expectJsonOk) {
        const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        ok = body?.ok === true;
        evidence += ok ? ', body {ok:true}' : ', body did not report ok:true';
      }
      checks.push({ name: target.name, url: target.url, ok, status: res.status, evidence });
    } catch (err) {
      checks.push({
        name: target.name,
        url: target.url,
        ok: false,
        status: null,
        evidence: `Fetch failed at ${startedAt.toISOString()}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const failing = checks.filter((check) => !check.ok);
  let workItemCreated = false;
  if (failing.length > 0) {
    await prisma.workItem.create({
      data: {
        title: `Uptime: ${failing.map((check) => check.name).join(', ')} failing`,
        detail: failing.map((check) => `${check.name} (${check.url}): ${check.evidence}`).join('\n'),
        ownerSlug: 'omar',
      },
    });
    workItemCreated = true;
  }
  return { checks, workItemCreated };
}

/* ------------------------- dossiers and board pack ----------------------- */

function stringifyFacts(facts: unknown): string {
  if (!facts || typeof facts !== 'object') return '(no structured facts stored)';
  const lines: string[] = [];
  for (const [key, value] of Object.entries(facts as Record<string, unknown>)) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`${key}: ${Array.isArray(value) ? value.join('; ') : String(value)}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(facts object was empty)';
}

/**
 * A one-page clinic dossier from data that exists: a demo lead's pulled
 * facts when a lead id is given, or a fresh public fetch of the clinic's
 * own website when only a URL is given. The evidence source is named in
 * the draft; nothing is invented to fill gaps.
 */
export async function buildClinicDossier(params: {
  leadId?: string;
  websiteUrl?: string;
  businessName?: string;
}): Promise<{ id: string; title: string }> {
  let title = 'Clinic dossier';
  let body = '';
  if (params.leadId) {
    const lead = await prisma.demoLead.findUnique({ where: { id: params.leadId } });
    if (!lead) throw new HttpError(404, `No demo lead with id ${params.leadId}.`, 'NOT_FOUND');
    title = `Dossier: ${lead.businessName || lead.name}`;
    body = [
      `# ${lead.businessName || lead.name}`,
      '',
      `Prospect: ${lead.name} (${lead.email})`,
      `Industry (self-reported): ${lead.industry}`,
      `Website: ${lead.websiteUrl ?? '(none given)'}`,
      `Demo mode chosen: ${lead.mode}`,
      `Lead created: ${lead.createdAt.toISOString()}`,
      '',
      'Facts pulled from their website at demo time:',
      stringifyFacts(lead.factsJson),
      '',
      'Evidence source: the demo lead record and its stored website facts. Pain points beyond these facts are NOT established; verify before outreach.',
    ].join('\n');
  } else if (params.websiteUrl) {
    const name = params.businessName || params.websiteUrl;
    title = `Dossier: ${name}`;
    let pageText = '';
    let fetchNote = '';
    try {
      const res = await fetch(params.websiteUrl, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; VoiceFrontTeam/1.0)' },
      });
      if (res.ok) {
        pageText = htmlToText(await res.text()).slice(0, 4000);
        fetchNote = `Fetched ${params.websiteUrl} just now (HTTP ${res.status}).`;
      } else {
        fetchNote = `Fetching ${params.websiteUrl} returned HTTP ${res.status}; no page evidence.`;
      }
    } catch (err) {
      fetchNote = `Fetching ${params.websiteUrl} failed: ${err instanceof Error ? err.message : String(err)}. No page evidence.`;
    }
    body = [
      `# ${name}`,
      '',
      `Website: ${params.websiteUrl}`,
      '',
      'What their own site says (excerpt):',
      pageText || '(no readable text)',
      '',
      `Evidence source: ${fetchNote} Hours, current phone setup, and review pain are NOT established by this skeleton; a full dossier verifies them before outreach.`,
    ].join('\n');
  } else {
    throw new HttpError(400, 'A dossier needs a demo lead id or a clinic website URL.', 'BAD_REQUEST');
  }
  const draft = await prisma.teamDraft.create({
    data: { memberSlug: 'layla', kind: 'DOSSIER', title, body },
  });
  return { id: draft.id, title: draft.title };
}

/** The weekly board pack, assembled from real aggregates. */
export async function buildBoardPack(): Promise<{ id: string; title: string }> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [byStatus, monthAgg, leadsThisWeek, callsThisWeek, openItems, recentScored] =
    await Promise.all([
      prisma.tenant.groupBy({ by: ['subscriptionStatus'], where: { deletedAt: null }, _count: true }),
      prisma.callLog.aggregate({
        where: { startedAt: { gte: monthStart } },
        _sum: { durationSeconds: true, billedCostCents: true },
        _count: true,
      }),
      prisma.demoLead.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.callLog.count({ where: { startedAt: { gte: weekAgo } } }),
      prisma.workItem.count({ where: { status: { in: ['QUEUED', 'IN_PROGRESS'] } } }),
      prisma.callLog.findMany({
        where: { transcript: { not: null }, startedAt: { gte: weekAgo } },
        orderBy: { startedAt: 'desc' },
        take: 50,
        select: { transcript: true, tenant: { select: { companyName: true } } },
      }),
    ]);
  const scored = recentScored.map((call) => scoreCallTranscript(call.transcript ?? '', call.tenant.companyName));
  const qualityPassed = scored.filter((score) => score.passed).length;
  const statusLine = byStatus.map((row) => `${row.subscriptionStatus}: ${row._count}`).join(', ');
  const body = [
    `# Board pack, ${now.toISOString().slice(0, 10)}`,
    '',
    `Tenants by status: ${statusLine || '(none)'}`,
    `Calls this month: ${monthAgg._count} (${Math.round((monthAgg._sum.durationSeconds ?? 0) / 60)} minutes, billed $${(((monthAgg._sum.billedCostCents ?? 0) / 100)).toFixed(2)})`,
    `Demo leads this week: ${leadsThisWeek}`,
    `Calls this week: ${callsThisWeek}`,
    `Call quality (last 7 days, ${scored.length} scored): ${qualityPassed}/${scored.length} passed all four checks`,
    `Open work items: ${openItems}`,
    '',
    'MRR note: MRR is not stored per tenant (no plan field exists). Any MRR figure must be computed as ACTIVE tenants x tier price and labeled an estimate.',
    'Competitor moves: not covered by this pack in v1; Layla files those as research briefs from public sources.',
  ].join('\n');
  const draft = await prisma.teamDraft.create({
    data: { memberSlug: 'layla', kind: 'BOARD_PACK', title: `Board pack, ${now.toISOString().slice(0, 10)}`, body },
  });
  return { id: draft.id, title: draft.title };
}

/* -------------------------------- red team ------------------------------- */

/**
 * Priya's pre-mortem on tap: the plan goes to the model wearing Priya's
 * persona, and her answer is stored as a QA report draft. If the model is
 * down this throws an honest 502; there is no canned pre-mortem.
 */
export async function runRedTeam(params: { plan: string }): Promise<{ id: string; title: string }> {
  const plan = params.plan?.trim();
  if (!plan) throw new HttpError(400, 'A pre-mortem needs the plan text.', 'BAD_REQUEST');
  const priya = TEAM_MEMBERS.find((member) => member.slug === 'priya');
  if (!priya) throw new HttpError(500, 'Priya is not on the team roster.', 'ROSTER_ERROR');
  const parts = await callTeamModel({
    model: priya.modelConfig,
    memberSlug: priya.slug,
    systemText: `${priya.personaPrompt}\n\n${VOICEFRONT_CONTEXT_PACK}`,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Run a pre-mortem on this plan. Assume it is three months later and it failed. List the most likely failure modes, the evidence or test that would catch each one early, and the smallest change that prevents it. End with your verdict: ship, ship with fixes, or do not ship. Keep it tight.\n\nPLAN:\n${plan.slice(0, 6000)}`,
          },
        ],
      },
    ],
  });
  const text = partsToText(parts);
  if (!text) throw new HttpError(502, 'Priya could not answer just now. Please try again.', 'MODEL_ERROR');
  const title = `Pre-mortem: ${plan.split('\n')[0].slice(0, 80)}`;
  const draft = await prisma.teamDraft.create({
    data: { memberSlug: 'priya', kind: 'QA_REPORT', title, body: text },
  });
  return { id: draft.id, title: draft.title };
}
