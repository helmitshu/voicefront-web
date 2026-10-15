import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tool tier enforcement tests. The registry is the security boundary:
 * a tool outside a member's role config is rejected in code (not just
 * hidden from the model), the unavailable screenshot tool is reported
 * honestly, every attempt (success, rejection, error) writes a
 * TeamToolLog row, repo reads are path-jailed, and member memory is
 * scoped to the caller with no way to name another member.
 */

type Row = Record<string, any>;

const { notes, drafts, workItems, logs, fakePrisma } = vi.hoisted(() => {
  const notes: Row[] = [];
  const drafts: Row[] = [];
  const workItems: Row[] = [];
  const logs: Row[] = [];
  const fakePrisma = {
    teamNote: {
      create: async ({ data }: any) => {
        const row = { id: `note_${notes.length + 1}`, createdAt: new Date(), ...data };
        notes.push(row);
        return row;
      },
      findMany: async ({ where }: any) => notes.filter((n) => n.memberSlug === where.memberSlug),
    },
    teamDraft: {
      create: async ({ data }: any) => {
        const row = { id: `draft_${drafts.length + 1}`, createdAt: new Date(), ...data };
        drafts.push(row);
        return row;
      },
    },
    workItem: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        const row = { id: `wi_${workItems.length + 1}`, createdAt: new Date(), ...data };
        workItems.push(row);
        return row;
      },
    },
    teamToolLog: {
      create: async ({ data }: any) => {
        const row = { id: `log_${logs.length + 1}`, createdAt: new Date(), ...data };
        logs.push(row);
        return row;
      },
    },
    teamPageWatch: {
      findUnique: async () => null,
      create: async ({ data }: any) => ({ id: 'watch_1', createdAt: new Date(), ...data }),
      update: async ({ data }: any) => ({ id: 'watch_1', ...data }),
    },
  };
  return { notes, drafts, workItems, logs, fakePrisma };
});

vi.mock('../lib/prisma', () => ({ prisma: fakePrisma }));

import { invokeTeamTool, toolsForMember } from './team-tools';

beforeEach(() => {
  notes.length = 0;
  drafts.length = 0;
  workItems.length = 0;
  logs.length = 0;
  vi.clearAllMocks();
});

describe('tool tier enforcement', () => {
  it('rejects a draft kind outside the member role config, and logs it', async () => {
    await expect(
      invokeTeamTool({ memberSlug: 'daniel' }, 'create_draft', {
        kind: 'QA_REPORT',
        title: 'Sneaky report',
        body: 'text',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'TOOL_FORBIDDEN' });
    expect(drafts).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0].ok).toBe(false);
    expect(logs[0].memberSlug).toBe('daniel');
  });

  it('allows a draft kind inside the member role config', async () => {
    const result = (await invokeTeamTool({ memberSlug: 'daniel' }, 'create_draft', {
      kind: 'EMAIL',
      title: 'Trial follow-up',
      body: 'Short draft body.',
    })) as any;
    expect(result.draft.kind).toBe('EMAIL');
    expect(drafts).toHaveLength(1);
    expect(logs[0].ok).toBe(true);
  });

  it('rejects unknown tools and unknown members, and logs both', async () => {
    await expect(invokeTeamTool({ memberSlug: 'omar' }, 'send_email', {})).rejects.toMatchObject({
      status: 400,
      code: 'TOOL_UNKNOWN',
    });
    // An unknown member has no role config, so every tool is out of tier.
    await expect(invokeTeamTool({ memberSlug: 'nobody' }, 'web_search', { query: 'x' })).rejects.toMatchObject({
      status: 403,
      code: 'TOOL_FORBIDDEN',
    });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.ok === false)).toBe(true);
  });

  it('page_screenshot is honestly unavailable, never offered, still logged', async () => {
    const priyaTools = toolsForMember('priya').map((t) => t.name);
    expect(priyaTools).not.toContain('page_screenshot');
    await expect(
      invokeTeamTool({ memberSlug: 'priya' }, 'page_screenshot', { url: 'https://example.com' }),
    ).rejects.toMatchObject({ status: 400, code: 'TOOL_UNAVAILABLE' });
    expect(logs).toHaveLength(1);
    expect(logs[0].tool).toBe('page_screenshot');
  });

  it('member memory is scoped to the caller and cannot be aimed elsewhere', async () => {
    await invokeTeamTool({ memberSlug: 'omar' }, 'memory_write', { body: 'Vapi quota burns at noon.' });
    await invokeTeamTool({ memberSlug: 'priya' }, 'memory_write', { body: 'Double goodbye seen twice.' });

    const omarRead = (await invokeTeamTool({ memberSlug: 'omar' }, 'memory_read', {})) as any;
    expect(omarRead.notes).toHaveLength(1);
    expect(omarRead.notes[0].body).toContain('Vapi quota');

    // Even an explicit memberSlug arg cannot widen the scope.
    const priyaRead = (await invokeTeamTool({ memberSlug: 'priya' }, 'memory_read', {
      memberSlug: 'omar',
    })) as any;
    expect(priyaRead.notes).toHaveLength(1);
    expect(priyaRead.notes[0].body).toContain('Double goodbye');
  });

  it('repo reads are path-jailed to the repo and block secrets', async () => {
    const ok = (await invokeTeamTool({ memberSlug: 'omar' }, 'repo_read', {
      path: 'apps/api/package.json',
    })) as any;
    expect(ok.content).toContain('"name"');

    await expect(
      invokeTeamTool({ memberSlug: 'omar' }, 'repo_read', { path: '../../etc/passwd' }),
    ).rejects.toThrow();
    await expect(
      invokeTeamTool({ memberSlug: 'omar' }, 'repo_read', { path: 'apps/api/.env' }),
    ).rejects.toThrow();
  });

  it('every invoke writes exactly one log row with input and result summaries', async () => {
    await invokeTeamTool({ memberSlug: 'layla' }, 'memory_write', { body: 'Check competitor pricing.' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ memberSlug: 'layla', tool: 'memory_write', ok: true });
    expect(logs[0].inputSummary).toContain('competitor pricing');
    expect(logs[0].resultSummary.length).toBeGreaterThan(0);
  });
});
