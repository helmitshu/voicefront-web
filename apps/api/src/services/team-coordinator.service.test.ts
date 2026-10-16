import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Coordinator tests (Phase 2a), over an in-memory store:
 *  - pickOwnerSlug maps work to seats by keyword, Daniel by default;
 *  - a tick assigns QUEUED items (respecting an owner already on the
 *    item), works them into a linked draft, posts the templated
 *    Picked up and Done channel lines, and closes them DONE;
 *  - the per-tick work cap holds: a backlog is not burned in one pass;
 *  - a member model failure parks the item BLOCKED with the reason in
 *    its detail, and no draft is faked;
 *  - an item IN_PROGRESS over a day gets one nudge line per day;
 *  - the daily digest composes the window from records: runs, findings,
 *    closures, and the exceptions (weak scorecard, leak item, failed
 *    run), authored by the coordinator, never as Cleo.
 */

type Row = Record<string, any>;

const { store, prismaMock } = vi.hoisted(() => {
  const store = {
    workItems: [] as Row[],
    drafts: [] as Row[],
    runs: [] as Row[],
    statusLines: [] as Array<{ memberSlug?: string | null; body: string }>,
    modelMode: 'ok' as 'ok' | 'fail',
    seq: 0,
  };
  const prismaMock: Record<string, any> = {
    workItem: {
      findMany: async (args: any = {}) => {
        let rows = store.workItems.filter((row) => {
          const where = args.where ?? {};
          if (where.status && row.status !== where.status) return false;
          if (where.updatedAt?.lt && !(row.updatedAt < where.updatedAt.lt)) return false;
          return true;
        });
        rows = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        if (args.take) rows = rows.slice(0, args.take);
        return rows.map((row) => ({ ...row }));
      },
      update: async (args: any) => {
        const row = store.workItems.find((r) => r.id === args.where.id);
        if (!row) throw new Error('work item not found');
        Object.assign(row, args.data, { updatedAt: new Date() });
        return { ...row };
      },
    },
    teamMember: {
      findUnique: async (args: any) => ({
        slug: args.where.slug,
        name: args.where.slug,
        personaPrompt: `You are ${args.where.slug}.`,
        modelConfig: 'gemini-3.8-flash',
      }),
    },
    teamDraft: {
      create: async (args: any) => {
        const row = { id: `draft_${++store.seq}`, createdAt: new Date(), ...args.data };
        store.drafts.push(row);
        return { ...row };
      },
      findMany: async (args: any = {}) => {
        let rows = store.drafts;
        if (args.where?.kind) rows = rows.filter((row) => row.kind === args.where.kind);
        if (args.take) rows = rows.slice(0, args.take);
        return rows.map((row) => ({ ...row }));
      },
    },
    teamRun: {
      findMany: async () => store.runs.map((row) => ({ ...row })),
    },
  };
  return { store, prismaMock };
});

vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('./team.service', () => ({
  postGroupStatusLine: async (params: { memberSlug?: string | null; body: string }) => {
    store.statusLines.push(params);
    return { id: 'msg_status', ...params };
  },
}));
vi.mock('./team-gemini', () => ({
  callTeamModel: async () => {
    if (store.modelMode === 'fail') throw new Error('member model is down');
    return [{ text: 'Summary of the finding, from the stored detail. Next step: act on it.' }];
  },
  partsToText: (parts: Array<{ text?: string }>) =>
    parts.map((part) => part.text ?? '').join('').trim(),
}));

import { pickOwnerSlug, runDailyDigest, runTeamCoordinator } from './team-coordinator.service';

const DAY = 24 * 60 * 60 * 1000;

function seedItem(partial: Partial<Row>): Row {
  const row: Row = {
    id: `wi_${++store.seq}`,
    title: 'Untitled',
    detail: 'Stored detail.',
    ownerSlug: 'daniel',
    status: 'QUEUED',
    draftId: null,
    lastNudgeAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
  store.workItems.push(row);
  return row;
}

beforeEach(() => {
  store.workItems = [];
  store.drafts = [];
  store.runs = [];
  store.statusLines = [];
  store.modelMode = 'ok';
  store.seq = 0;
});

describe('pickOwnerSlug', () => {
  it('routes work to seats by keyword, Daniel by default', () => {
    expect(pickOwnerSlug('Leak radar: 5 abandoned demos this week')).toBe('daniel');
    expect(pickOwnerSlug('Trial not activated after 24h')).toBe('daniel');
    expect(pickOwnerSlug('Scorecard failures need review')).toBe('priya');
    expect(pickOwnerSlug('Call quality regression on greetings')).toBe('priya');
    expect(pickOwnerSlug('Clinic dossier for SmileCraft')).toBe('layla');
    expect(pickOwnerSlug('Research the competitor pricing page')).toBe('layla');
    expect(pickOwnerSlug('Uptime: API health failing')).toBe('omar');
    expect(pickOwnerSlug('Bug in the booking flow')).toBe('omar');
    expect(pickOwnerSlug('Something unclassifiable')).toBe('daniel');
  });
});

describe('runTeamCoordinator', () => {
  it('assigns, works, and closes an item, with templated channel lines and a linked draft', async () => {
    const item = seedItem({ title: 'Leak radar: 3 abandoned demos', ownerSlug: 'daniel' });

    const result = await runTeamCoordinator();

    expect(result.assigned).toBe(1);
    expect(result.worked).toBe(1);
    expect(result.blocked).toBe(0);
    const stored = store.workItems.find((row) => row.id === item.id)!;
    expect(stored.status).toBe('DONE');
    expect(stored.draftId).toBeTruthy();
    const draft = store.drafts.find((row) => row.id === stored.draftId)!;
    expect(draft.memberSlug).toBe('daniel');
    expect(draft.title).toContain('Leak radar: 3 abandoned demos');
    expect(draft.body).toContain('Summary of the finding');
    expect(store.statusLines.map((line) => line.body)).toEqual([
      'Picked up: Leak radar: 3 abandoned demos',
      'Done: Leak radar: 3 abandoned demos, draft is in Drafts.',
    ]);
    expect(store.statusLines.every((line) => line.memberSlug === 'daniel')).toBe(true);
  });

  it('works at most the per-tick cap and leaves the rest ASSIGNED', async () => {
    for (let i = 0; i < 5; i++) seedItem({ title: `Item ${i}`, status: 'ASSIGNED' });

    const result = await runTeamCoordinator();

    expect(result.worked).toBe(3);
    expect(store.workItems.filter((row) => row.status === 'DONE')).toHaveLength(3);
    expect(store.workItems.filter((row) => row.status === 'ASSIGNED')).toHaveLength(2);
  });

  it('a member model failure parks the item BLOCKED with the reason, and fakes no draft', async () => {
    store.modelMode = 'fail';
    const item = seedItem({ title: 'Scorecard failures need review', ownerSlug: 'priya' });

    const result = await runTeamCoordinator();

    expect(result.blocked).toBe(1);
    expect(result.worked).toBe(0);
    const stored = store.workItems.find((row) => row.id === item.id)!;
    expect(stored.status).toBe('BLOCKED');
    expect(stored.detail).toContain('member model is down');
    expect(store.drafts).toHaveLength(0);
  });

  it('nudges an item stuck IN_PROGRESS over a day, at most once per day', async () => {
    const stale = seedItem({
      title: 'Old in-progress item',
      status: 'IN_PROGRESS',
      updatedAt: new Date(Date.now() - 2 * DAY),
      lastNudgeAt: null,
    });
    seedItem({
      title: 'Recently nudged item',
      status: 'IN_PROGRESS',
      updatedAt: new Date(Date.now() - 2 * DAY),
      lastNudgeAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await runTeamCoordinator();

    expect(result.nudged).toBe(1);
    expect(store.statusLines).toHaveLength(1);
    expect(store.statusLines[0].body).toContain('Old in-progress item');
    expect(store.workItems.find((row) => row.id === stale.id)!.lastNudgeAt).toBeInstanceOf(Date);
  });
});

describe('runDailyDigest', () => {
  it('composes counts and exceptions from records, authored by the coordinator, never as Cleo', async () => {
    store.runs = [
      { ability: 'leak-radar', status: 'DONE', summary: 'ok' },
      { ability: 'call-scoring', status: 'DONE', summary: 'ok' },
      { ability: 'uptime', status: 'FAILED', summary: 'Failed: boom' },
    ];
    seedItem({ title: 'Leak radar: 2 abandoned demos', status: 'QUEUED' });
    seedItem({ title: 'Done thing', status: 'DONE' });
    store.drafts = [
      { id: 'd1', kind: 'SCORECARD', title: 'Scorecard: Clinic call abcd1234 (2/4)', createdAt: new Date() },
      { id: 'd2', kind: 'SCORECARD', title: 'Scorecard: Clinic call efgh5678 (3/4)', createdAt: new Date() },
    ];

    const result = await runDailyDigest();

    // Exceptions: 1 weak scorecard (2/4; the 3/4 is routine) + 1 leak
    // item + 1 failed run.
    expect(result.exceptions).toBe(3);
    expect(store.statusLines).toHaveLength(1);
    expect(store.statusLines[0].memberSlug ?? null).toBeNull();
    expect(store.statusLines[0].body).toContain('3 exception(s)');
    const digest = store.drafts.find((row) => row.kind === 'DAILY_DIGEST')!;
    expect(digest).toBeDefined();
    expect(digest.memberSlug).toBe('coordinator');
    expect(digest.title).toMatch(/^Daily digest \d{4}-\d{2}-\d{2}$/);
    expect(digest.body).toContain('Not written by Cleo');
    expect(digest.body).toContain('Runs in the last 24 hours: 3');
    expect(digest.body).toContain('Weak call scored');
    expect(digest.body).toContain('Leak filed');
    expect(digest.body).toContain('Failed run: uptime');
  });
});
