import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the Weekly Upgrade (Adam, phase 3).
 *
 * The honesty contract under test:
 *  - extraction only reports questions the records show went unanswered
 *    (a caller question followed by a receptionist who could not answer,
 *    or a question-intent call that ended as a message or no action);
 *  - grouping counts distinct calls per topic;
 *  - a topic is draftable only when the tenant's own records mention it,
 *    and every dollar figure in a draft must already exist in those
 *    records, so an invented price can never pass the gate;
 *  - applying writes through the real knowledge path (upload, Document
 *    row, re-sync);
 *  - the weekly job parks one PENDING review per workspace per week and
 *    never resurrects a dismissed one.
 */

const state = vi.hoisted(() => {
  interface FakeCall {
    id: string; tenantId: string; startedAt: Date; status: string;
    outcome: string | null; intent: string | null;
    summary: string | null; transcript: string | null;
  }
  const calls = new Map<string, FakeCall>();
  const documents: Array<Record<string, unknown>> = [];
  const reviews: Array<Record<string, unknown>> = [];
  const uploads: Array<{ buffer: Buffer; fileName: string; mimeType: string }> = [];
  let reviewSeq = 0;

  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [key, cond] of Object.entries(where ?? {})) {
      if (key === 'tenantId_weekKey') continue;
      const value = row[key];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as Record<string, unknown>;
        if ('not' in c && value === c.not) return false;
        if ('gte' in c && !((value as Date) >= (c.gte as Date))) return false;
        if ('lt' in c && !((value as Date) < (c.lt as Date))) return false;
      } else if (value !== cond) return false;
    }
    return true;
  }

  return { calls, documents, reviews, uploads, matches,
    nextReviewId: () => `review_${++reviewSeq}`,
    reset: () => { calls.clear(); documents.length = 0; reviews.length = 0; uploads.length = 0; },
  };
});

const SETTINGS = {
  tenantId: 'tenant_a', displayName: 'Maya', timezone: 'America/Toronto',
  inboundPhoneNumber: '+14165550100',
  businessHours: {
    mon: { enabled: true, open: '08:00', close: '17:00' },
    tue: { enabled: true, open: '08:00', close: '17:00' },
    wed: { enabled: true, open: '08:00', close: '17:00' },
    thu: { enabled: true, open: '08:00', close: '17:00' },
    fri: { enabled: true, open: '08:00', close: '17:00' },
    sat: { enabled: false, open: '09:00', close: '13:00' },
    sun: { enabled: false, open: '09:00', close: '13:00' },
  },
  avgAppointmentValue: 250,
  systemPrompt: 'We accept Delta Dental. Cleaning costs $180 for existing patients. Free parking is available behind the building.',
};

vi.mock('../lib/prisma', () => ({
  prisma: {
    tenant: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(args.where.id === 'tenant_a'
          ? { id: 'tenant_a', companyName: 'Alpha Dental', industry: 'CLINIC' } : null),
      findMany: () => Promise.resolve([
        { id: 'tenant_a', agentSettings: { timezone: 'America/Toronto', inboundPhoneNumber: '+14165550100' } },
      ]),
    },
    agentSettings: {
      findUnique: (args: { where: { tenantId: string } }) =>
        Promise.resolve(args.where.tenantId === 'tenant_a' ? SETTINGS : null),
    },
    callLog: {
      findMany: (args: { where: Record<string, unknown>; take?: number }) =>
        Promise.resolve(
          [...state.calls.values()]
            .filter((c) => state.matches(c as never, args.where))
            .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
            .slice(0, args.take ?? 200),
        ),
    },
    service: {
      findMany: () => Promise.resolve([
        { name: 'Cleaning', durationMinutes: 60, description: 'Routine hygiene cleaning.' },
        { name: 'Whitening', durationMinutes: 45, description: null },
      ]),
    },
    provider: {
      findMany: () => Promise.resolve([{ name: 'Dr. Sam Lee', title: 'Dentist' }]),
    },
    document: {
      findMany: () => Promise.resolve(state.documents.map((d) => ({ fileName: d.fileName }))),
      create: (args: { data: Record<string, unknown> }) => {
        const row = { id: `doc_${state.documents.length + 1}`, ...args.data };
        state.documents.push(row);
        return Promise.resolve(row);
      },
    },
    adamWeeklyReview: {
      findFirst: (args: { where: Record<string, unknown> }) =>
        Promise.resolve(state.reviews.find((r) => state.matches(r, args.where)) ?? null),
      findUnique: (args: { where: { tenantId_weekKey: { tenantId: string; weekKey: string } } }) =>
        Promise.resolve(
          state.reviews.find(
            (r) => r.tenantId === args.where.tenantId_weekKey.tenantId && r.weekKey === args.where.tenantId_weekKey.weekKey,
          ) ?? null,
        ),
      create: (args: { data: Record<string, unknown> }) => {
        const row = { id: state.nextReviewId(), createdAt: new Date(), ...args.data };
        state.reviews.push(row);
        return Promise.resolve(row);
      },
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of state.reviews) {
          if (state.matches(row, args.where)) { Object.assign(row, args.data); count += 1; }
        }
        return Promise.resolve({ count });
      },
    },
  },
}));

vi.mock('./vapi.service', () => ({
  uploadFileToVapi: (buffer: Buffer, fileName: string, mimeType: string) => {
    state.uploads.push({ buffer, fileName, mimeType });
    return Promise.resolve({ id: `vapi_file_${state.uploads.length}`, status: 'processed' });
  },
  syncAssistantForTenant: () => Promise.resolve({ synced: true }),
}));

import {
  dismissWeeklyReview,
  extractUnansweredQuestions,
  getKnowledgeSources,
  getPendingWeeklyReview,
  isoWeekKey,
  runWeeklyKnowledgeReviews,
  scanUnansweredQuestions,
  validateKnowledgeDraft,
  writeKnowledgeAddition,
  type KnowledgeSources,
} from './adam-knowledge.service';

beforeEach(() => state.reset());

const SOURCES: KnowledgeSources = {
  businessName: 'Alpha Dental',
  services: [
    { name: 'Cleaning', durationMinutes: 60, description: 'Routine hygiene cleaning.' },
    { name: 'Whitening', durationMinutes: 45, description: null },
  ],
  providers: [{ name: 'Dr. Sam Lee', title: 'Dentist' }],
  documentNames: [],
  corpus:
    'Business: Alpha Dental. Average appointment value: $250. ' +
    'We accept Delta Dental. Cleaning costs $180 for existing patients. Free parking behind the building.',
};

function call(overrides: Record<string, unknown> = {}) {
  return {
    id: `call_${state.calls.size + 1}`, tenantId: 'tenant_a',
    startedAt: new Date('2026-10-14T15:00:00Z'), status: 'COMPLETED',
    outcome: 'NO_ACTION', intent: 'QUESTION', summary: null, transcript: null,
    ...overrides,
  } as never;
}

describe('extractUnansweredQuestions', () => {
  it('finds a question the receptionist admitted she could not answer', () => {
    const gaps = extractUnansweredQuestions(
      [call({ transcript: 'Caller: Do you take Delta Dental?\nReceptionist: I don\'t know, but I can take a message and someone will call you back.' })],
      SOURCES, 'America/Toronto',
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.topic).toBe('Insurance coverage');
    expect(gaps[0]!.count).toBe(1);
    expect(gaps[0]!.examples[0]!.question).toContain('Delta Dental');
  });

  it('does not count a question she answered confidently', () => {
    const gaps = extractUnansweredQuestions(
      [call({ transcript: 'Caller: Where do I park?\nReceptionist: Free parking is right behind the building.' })],
      SOURCES, 'America/Toronto',
    );
    expect(gaps).toHaveLength(0);
  });

  it('counts a question-intent message call from its summary alone', () => {
    const gaps = extractUnansweredQuestions(
      [call({ outcome: 'MESSAGE_TAKEN', summary: 'Caller asked about parking near the clinic. A message was taken.' })],
      SOURCES, 'America/Toronto',
    );
    expect(gaps.map((g) => g.topic)).toContain('Parking');
  });

  it('groups by topic and counts distinct calls, not repeated questions', () => {
    const transcript = 'Caller: Do you take Delta Dental?\nReceptionist: I\'m not sure.\nCaller: What about MetLife?\nReceptionist: I don\'t know that either.';
    const gaps = extractUnansweredQuestions(
      [
        call({ id: 'c1', transcript }),
        call({ id: 'c2', transcript: 'Caller: Is parking free?\nReceptionist: I can take a message.' }),
      ],
      SOURCES, 'America/Toronto',
    );
    const insurance = gaps.find((g) => g.topic === 'Insurance coverage')!;
    expect(insurance.count).toBe(1);
    expect(gaps.find((g) => g.topic === 'Parking')!.count).toBe(1);
    expect(gaps[0]!.topic).toBe('Insurance coverage'); // sorted by count then name
  });

  it('marks draftable only when the tenant records mention the topic', () => {
    const gaps = extractUnansweredQuestions(
      [
        call({ id: 'c1', transcript: 'Caller: Do you take Delta Dental?\nReceptionist: I don\'t know.' }),
        call({ id: 'c2', transcript: 'Caller: Do you speak Mandarin?\nReceptionist: I\'m not sure.' }),
      ],
      SOURCES, 'America/Toronto',
    );
    expect(gaps.find((g) => g.topic === 'Insurance coverage')!.draftable).toBe(true);
    expect(gaps.find((g) => g.topic === 'Languages spoken')!.draftable).toBe(false);
  });
});

describe('validateKnowledgeDraft (the sourcing gate)', () => {
  it('accepts figures that exist in the clinic records', () => {
    const result = validateKnowledgeDraft('A cleaning costs $180 for existing patients.', SOURCES);
    expect(result.ok).toBe(true);
  });

  it('refuses an invented price', () => {
    const result = validateKnowledgeDraft('Whitening costs $499 per session.', SOURCES);
    expect(result.ok).toBe(false);
    expect(result.unsourcedAmounts).toContain('499');
  });

  it('catches amounts written as words too', () => {
    const result = validateKnowledgeDraft('The exam is 95 dollars.', SOURCES);
    expect(result.ok).toBe(false);
    expect(result.unsourcedAmounts).toContain('95');
  });

  it('a draft with no figures at all passes', () => {
    expect(validateKnowledgeDraft('Free parking is available behind the building.', SOURCES).ok).toBe(true);
  });
});

describe('scan and apply', () => {
  it('scan returns gaps with the source corpus attached', async () => {
    state.calls.set('c1', call({
      id: 'c1', transcript: 'Caller: Do you take Delta Dental?\nReceptionist: I don\'t know.',
    }) as never);
    const scan = await scanUnansweredQuestions('tenant_a', {
      start: new Date('2026-10-12T00:00:00Z'), end: new Date('2026-10-16T00:00:00Z'),
    });
    expect(scan.callsScanned).toBe(1);
    expect(scan.gaps[0]!.topic).toBe('Insurance coverage');
    expect(scan.sources.corpus).toContain('Delta Dental');
  });

  it('apply uploads the file, creates the Document row, and reports the sync', async () => {
    const result = await writeKnowledgeAddition('tenant_a', {
      title: 'Insurance we accept',
      content: 'We accept Delta Dental.',
    });
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0]!.fileName).toBe('adam-knowledge-insurance-we-accept.md');
    expect(state.uploads[0]!.buffer.toString('utf8')).toContain('We accept Delta Dental.');
    expect(result.documentId).toBe('doc_1');
    expect(result.sync.synced).toBe(true);
    expect(state.documents[0]).toMatchObject({ tenantId: 'tenant_a', vapiFileId: 'vapi_file_1' });
  });

  it('sources come from the tenant records only', async () => {
    const sources = await getKnowledgeSources('tenant_a');
    expect(sources.services.map((s) => s.name)).toEqual(['Cleaning', 'Whitening']);
    expect(sources.corpus).toContain('$180');
    expect(sources.corpus).toContain('Dr. Sam Lee');
  });
});

describe('weekly review job', () => {
  it('isoWeekKey follows ISO weeks', () => {
    // Thursday Oct 15 2026 is in ISO week 42 of 2026.
    expect(isoWeekKey(new Date('2026-10-15T12:00:00Z'), 'America/Toronto')).toBe('2026-W42');
    // Sunday Jan 1 2023 belongs to ISO week 52 of 2022.
    expect(isoWeekKey(new Date('2023-01-01T12:00:00Z'), 'UTC')).toBe('2022-W52');
  });

  it('creates one PENDING review and never resurrects a dismissed week', async () => {
    state.calls.set('c1', call({
      id: 'c1', startedAt: new Date(Date.now() - 60 * 60 * 1000),
      transcript: 'Caller: Do you take Delta Dental?\nReceptionist: I don\'t know.',
    }) as never);
    const created = await runWeeklyKnowledgeReviews(new Date());
    expect(created).toBe(1);
    const pending = await getPendingWeeklyReview('tenant_a');
    expect(pending?.gapCount).toBe(1);

    // Second run in the same week creates nothing new.
    expect(await runWeeklyKnowledgeReviews(new Date())).toBe(0);

    // Dismiss it; a later run still does not bring it back.
    expect(await dismissWeeklyReview('tenant_a', pending!.id)).toBe(true);
    expect(await getPendingWeeklyReview('tenant_a')).toBeNull();
    expect(await runWeeklyKnowledgeReviews(new Date())).toBe(0);
    expect(state.reviews).toHaveLength(1);
    expect(state.reviews[0]).toMatchObject({ status: 'DISMISSED' });
  });

  it('creates nothing when the week had no unanswered questions', async () => {
    state.calls.set('c1', call({
      id: 'c1', startedAt: new Date(Date.now() - 60 * 60 * 1000), outcome: 'BOOKED', intent: 'BOOK',
      transcript: 'Caller: I need a cleaning.\nReceptionist: Booked for Tuesday.',
    }) as never);
    expect(await runWeeklyKnowledgeReviews(new Date())).toBe(0);
    expect(state.reviews).toHaveLength(0);
  });

  it('dismiss is tenant-scoped', async () => {
    state.reviews.push({ id: 'review_x', tenantId: 'tenant_a', weekKey: '2026-W42', gaps: [], gapCount: 1, status: 'PENDING', createdAt: new Date() });
    expect(await dismissWeeklyReview('tenant_b', 'review_x')).toBe(false);
    expect(state.reviews[0]).toMatchObject({ status: 'PENDING' });
  });
});
