import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { updateAppointment } from './appointment.service';
import { listFounderEntries, removeFounderEntry } from './founder.service';

vi.mock('../lib/prisma', () => ({
  prisma: {
    tenant: { findUnique: vi.fn(), create: vi.fn() },
    platformSetting: { findUnique: vi.fn() },
    appointment: { findMany: vi.fn() },
  },
}));

vi.mock('./appointment.service', () => ({
  bookAppointment: vi.fn(),
  findFreeSlots: vi.fn(),
  updateAppointment: vi.fn(),
  // Faithful stand-in for the real Intl-based helper (founder.service only
  // reads .date and .time off the result).
  utcToZonedParts: (date: Date, timeZone: string) => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts: Record<string, string> = {};
    for (const part of fmt.formatToParts(date)) parts[part.type] = part.value;
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}`, day: 'wed' as const };
  },
}));

vi.mock('./calendar.service', () => ({
  buildAuthUrl: vi.fn(),
  disconnect: vi.fn(),
  getCalendarStatus: vi.fn(),
  getExternalEvents: vi.fn(),
  updateConnectionPrefs: vi.fn(),
}));

vi.mock('../lib/jwt', () => ({ signOAuthStateToken: vi.fn(() => 'state-token') }));

vi.mock('../domain/prompt-templates', () => ({
  industryDefaults: vi.fn(() => ({ systemPrompt: '', firstMessage: '', voicemailGreeting: '' })),
}));

const FOUNDER_TENANT = {
  id: 'tenant_founder',
  slug: '__founder',
  agentSettings: { timezone: 'America/Vancouver', businessHours: {} },
};

type Row = Record<string, unknown> & { startsAt: Date; status: string; tenantId: string };

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'appt_1',
    tenantId: 'tenant_founder',
    source: 'MANUAL',
    customerName: 'Busy',
    reason: null,
    startsAt: new Date('2026-10-14T16:00:00Z'),
    endsAt: new Date('2026-10-14T17:00:00Z'),
    timezone: 'America/Vancouver',
    status: 'CONFIRMED',
    ...overrides,
  } as Row;
}

// The rows "in the database". The cancelled row must stay here (history is
// preserved); the list function is what has to stop surfacing it.
const DB_ROWS: Row[] = [
  makeRow({ id: 'appt_confirmed', status: 'CONFIRMED', customerName: 'Planning call' }),
  makeRow({ id: 'appt_completed', status: 'COMPLETED' }),
  makeRow({ id: 'appt_noshow', status: 'NO_SHOW' }),
  makeRow({ id: 'appt_cancelled', status: 'CANCELLED', customerName: 'Removed block' }),
  makeRow({ id: 'appt_other_tenant', tenantId: 'tenant_someone_else', status: 'CONFIRMED' }),
];

/** Applies the query's where clause the way Prisma would, so the test fails
 *  if the service ever stops asking for the CANCELLED exclusion. */
function applyWhere(rows: Row[], where: Record<string, any>): Row[] {
  return rows.filter((row) => {
    if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
    if (where.startsAt?.gte && row.startsAt < where.startsAt.gte) return false;
    if (where.startsAt?.lte && row.startsAt > where.startsAt.lte) return false;
    if (where.status !== undefined) {
      if (typeof where.status === 'string' && row.status !== where.status) return false;
      if (where.status?.not !== undefined && row.status === where.status.not) return false;
    }
    return true;
  });
}

const findManyMock = prisma.appointment.findMany as unknown as ReturnType<typeof vi.fn>;
const findTenantMock = prisma.tenant.findUnique as unknown as ReturnType<typeof vi.fn>;
const updateAppointmentMock = updateAppointment as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  findTenantMock.mockResolvedValue(FOUNDER_TENANT);
  findManyMock.mockImplementation(async (args: { where: Record<string, any> }) => applyWhere(DB_ROWS, args.where));
});

describe('listFounderEntries — cancelled entries stay out of the admin calendar', () => {
  it('asks the database to exclude CANCELLED rows', async () => {
    await listFounderEntries('2026-10-14', '2026-10-14');
    expect(findManyMock).toHaveBeenCalledTimes(1);
    const where = findManyMock.mock.calls[0][0].where;
    expect(where.tenantId).toBe('tenant_founder');
    expect(where.status).toEqual({ not: 'CANCELLED' });
  });

  it('returns live entries of every other status, and never the cancelled one', async () => {
    const entries = await listFounderEntries('2026-10-14', '2026-10-14');
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('appt_confirmed');
    expect(ids).toContain('appt_completed');
    expect(ids).toContain('appt_noshow');
    expect(ids).not.toContain('appt_cancelled');
    expect(entries.map((e) => e.status)).not.toContain('CANCELLED');
    // The cancelled row itself is untouched in the "database" (history kept).
    expect(DB_ROWS.find((r) => r.id === 'appt_cancelled')?.status).toBe('CANCELLED');
  });

  it('still scopes the list to the founder tenant', async () => {
    const entries = await listFounderEntries('2026-10-14', '2026-10-14');
    expect(entries.map((e) => e.id)).not.toContain('appt_other_tenant');
  });
});

describe('removeFounderEntry — the cancel side is unchanged', () => {
  it('remains a status-only cancel to CANCELLED (slot frees, row kept)', async () => {
    updateAppointmentMock.mockResolvedValue(undefined);
    await removeFounderEntry('appt_confirmed');
    expect(updateAppointmentMock).toHaveBeenCalledWith('tenant_founder', 'appt_confirmed', { status: 'CANCELLED' }, null);
  });
});
