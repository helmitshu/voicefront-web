import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';
import { demoRouter } from './demo.routes';
import { prisma } from '../lib/prisma';
import { errorHandler } from '../middleware/error';

vi.mock('../lib/prisma', () => ({
  prisma: {
    demoLead: { findFirst: vi.fn() },
    demoHold: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../services/demo.service', () => ({
  startDemoSession: vi.fn(),
  resumeDemoSession: vi.fn(),
  getDemoAppointments: vi.fn(),
  blockDemoSlot: vi.fn(),
  resetDemoSession: vi.fn(),
  isDemoEnabled: vi.fn(),
  createDemoLead: vi.fn(),
  setLeadMode: vi.fn(),
  getSalesConfig: vi.fn(),
  getDemoNumbers: vi.fn(),
  pickDemoCallerId: vi.fn(),
  demoSample: vi.fn(),
  getDemoScreen: vi.fn(),
  clearDemoScreen: vi.fn(),
  getDemoSummary: vi.fn(),
  clearDemoSummary: vi.fn(),
}));

vi.mock('../services/vapi.service', () => ({ placeOutboundCall: vi.fn() }));

vi.mock('../services/geo.service', () => ({
  evaluateGate: vi.fn(),
  clientIp: vi.fn(),
}));

vi.mock('../services/platform-config.service', () => ({
  getSettingValue: vi.fn(async (key: string) =>
    key === 'VAPI_WEBHOOK_SECRET' ? 'test-hold-secret-0123456789abcdef' : 'https://api.example.test',
  ),
}));

const SECRET = 'test-hold-secret-0123456789abcdef';

// 2026-10-14 is a Wednesday — the design's canonical example day.
const HOLD_ARGS = {
  action: 'hold',
  service: 'cleaning',
  date: '2026-10-14',
  time: '14:00',
  patientName: 'Jordan Lee',
  callbackNumber: '+15144315049',
};

function holdPayload(args: Record<string, unknown>, callId = 'call_hold1', sessionId = 'demo_holdtest') {
  return {
    message: {
      type: 'tool-calls',
      call: { id: callId },
      assistant: { metadata: { tenantId: 'tenant_demo', demoSessionId: sessionId } },
      toolCallList: [{ id: 'tc1', name: 'hold_appointment', arguments: args }],
    },
  };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'holdrow1',
    demoSessionId: 'demo_holdtest',
    externalCallId: 'call_hold1',
    service: 'cleaning',
    date: '2026-10-14',
    time: '14:00',
    patientName: 'Jordan Lee',
    callbackNumber: '+15144315049',
    status: 'ACTIVE',
    ...overrides,
  };
}

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/demo', demoRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no test server address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function postHold(body: unknown, secret?: string) {
  const res = await fetch(`${base}/api/demo/hold`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-vapi-secret': secret } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

function firstResult(json: Record<string, any>): string {
  return (json.results?.[0]?.result as string) ?? '';
}

describe('POST /api/demo/hold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Session known by default; the unknown-session case overrides.
    vi.mocked(prisma.demoLead.findFirst).mockResolvedValue({ id: 'lead1' } as never);
    vi.mocked(prisma.demoHold.findUnique).mockResolvedValue(null);
  });

  it('refuses a request with no webhook secret (401)', async () => {
    const { status, json } = await postHold(holdPayload(HOLD_ARGS));
    expect(status).toBe(401);
    expect(json.error.code).toBe('UNAUTHENTICATED');
    expect(prisma.demoHold.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a request with the wrong webhook secret (401)', async () => {
    const { status } = await postHold(holdPayload(HOLD_ARGS), 'wrong-secret');
    expect(status).toBe(401);
    expect(prisma.demoHold.findUnique).not.toHaveBeenCalled();
  });

  it('refuses an unknown demo session in-band with a speakable failure and no state change', async () => {
    vi.mocked(prisma.demoLead.findFirst).mockResolvedValue(null);
    const { status, json } = await postHold(holdPayload(HOLD_ARGS, 'call_unknown', 'demo_unknown'), SECRET);
    expect(status).toBe(200);
    const result = firstResult(json);
    expect(result).not.toMatch(/error|stack|prisma/i);
    expect(result).toMatch(/hold didn't go through/i);
    expect(prisma.demoHold.create).not.toHaveBeenCalled();
    expect(prisma.demoHold.update).not.toHaveBeenCalled();
  });

  it('creates the first hold and returns the canonical summary', async () => {
    vi.mocked(prisma.demoHold.create).mockImplementation(
      async (args: never) => ({ ...(args as { data: object }).data, id: 'hold1' }) as never,
    );
    const { status, json } = await postHold(holdPayload(HOLD_ARGS), SECRET);
    expect(status).toBe(200);
    expect(firstResult(json)).toContain('a cleaning on Wednesday, October 14th at 2 PM');
    expect(prisma.demoHold.create).toHaveBeenCalledTimes(1);
    expect(prisma.demoHold.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          service: 'cleaning',
          date: '2026-10-14',
          time: '14:00',
          patientName: 'Jordan Lee',
          callbackNumber: '+15144315049',
          status: 'ACTIVE',
        }),
      }),
    );
  });

  it('refuses a second plain hold: echoes the existing summary and changes no state', async () => {
    vi.mocked(prisma.demoHold.findUnique).mockResolvedValue(makeRow() as never);
    const { status, json } = await postHold(holdPayload(HOLD_ARGS), SECRET);
    expect(status).toBe(200);
    const result = firstResult(json);
    expect(result).toContain('a cleaning on Wednesday, October 14th at 2 PM');
    expect(result).toMatch(/already/i);
    expect(result).toMatch(/nothing new was booked/i);
    expect(prisma.demoHold.create).not.toHaveBeenCalled();
    expect(prisma.demoHold.update).not.toHaveBeenCalled();
  });

  it('replaces the active hold on "change" and returns the new summary', async () => {
    vi.mocked(prisma.demoHold.findUnique).mockResolvedValue(makeRow() as never);
    vi.mocked(prisma.demoHold.update).mockImplementation(
      async (args: never) => ({ ...makeRow(), ...(args as { data: object }).data }) as never,
    );
    const { status, json } = await postHold(holdPayload({ ...HOLD_ARGS, action: 'change', time: '12:00' }), SECRET);
    expect(status).toBe(200);
    expect(firstResult(json)).toContain('a cleaning on Wednesday, October 14th at 12 PM');
    expect(prisma.demoHold.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ time: '12:00', status: 'CHANGED' }) }),
    );
  });

  it('marks the hold cancelled on "cancel" and confirms with the old summary', async () => {
    vi.mocked(prisma.demoHold.findUnique).mockResolvedValue(makeRow() as never);
    vi.mocked(prisma.demoHold.update).mockImplementation(
      async (args: never) => ({ ...makeRow(), ...(args as { data: object }).data }) as never,
    );
    const { status, json } = await postHold(holdPayload({ action: 'cancel' }), SECRET);
    expect(status).toBe(200);
    const result = firstResult(json);
    expect(result).toContain('a cleaning on Wednesday, October 14th at 2 PM');
    expect(result).toMatch(/cancelled/i);
    expect(prisma.demoHold.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
  });

  it('lets a fresh hold be placed after a cancel', async () => {
    vi.mocked(prisma.demoHold.findUnique).mockResolvedValue(makeRow({ status: 'CANCELLED' }) as never);
    vi.mocked(prisma.demoHold.update).mockImplementation(
      async (args: never) => ({ ...makeRow(), ...(args as { data: object }).data }) as never,
    );
    const { status, json } = await postHold(holdPayload(HOLD_ARGS), SECRET);
    expect(status).toBe(200);
    expect(firstResult(json)).toContain('Hold created');
    expect(prisma.demoHold.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
  });

  it('fails speakably with nothing stored when required hold fields are missing or garbage', async () => {
    const cases: Record<string, unknown>[] = [
      { ...HOLD_ARGS, service: '' }, // missing service
      { ...HOLD_ARGS, date: '14/10/2026' }, // wrong date shape
      { ...HOLD_ARGS, date: '2026-02-30' }, // impossible date
      { ...HOLD_ARGS, time: 'noon' }, // wrong time shape
      { ...HOLD_ARGS, time: '25:00' }, // impossible time
    ];
    for (const args of cases) {
      const { status, json } = await postHold(holdPayload(args), SECRET);
      expect(status).toBe(200);
      const result = firstResult(json);
      expect(result).toMatch(/nothing was held|missing/i);
      expect(result).not.toMatch(/error|stack|prisma/i);
    }
    expect(prisma.demoHold.create).not.toHaveBeenCalled();
    expect(prisma.demoHold.update).not.toHaveBeenCalled();
  });

  it('fails speakably when changing a call that has no live hold', async () => {
    const { status, json } = await postHold(holdPayload({ ...HOLD_ARGS, action: 'change', time: '12:00' }), SECRET);
    expect(status).toBe(200);
    expect(firstResult(json)).toMatch(/no hold on this call/i);
    expect(prisma.demoHold.update).not.toHaveBeenCalled();
  });

  it('a floated second time as a plain hold never creates a second row (the original flaw)', async () => {
    vi.mocked(prisma.demoHold.findUnique).mockResolvedValue(makeRow() as never);
    const { status, json } = await postHold(holdPayload({ ...HOLD_ARGS, time: '12:00' }), SECRET);
    expect(status).toBe(200);
    expect(prisma.demoHold.create).not.toHaveBeenCalled();
    expect(firstResult(json)).toMatch(/already/i);
  });
});

describe('POST /api/demo/hold — the closing facts card', () => {
  const SMILECRAFT_LEAD = {
    id: 'lead1',
    businessName: 'SmileCraft Dental',
    factsJson: { businessName: 'SmileCraft Dental' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.demoLead.findFirst).mockResolvedValue(SMILECRAFT_LEAD as never);
    vi.mocked(prisma.demoHold.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.demoHold.create).mockImplementation(
      async (args: never) => ({ ...(args as { data: object }).data, id: 'hold1' }) as never,
    );
  });

  it('returns labeled closing FACTS on a successful hold — no scripted closing anywhere in the result', async () => {
    const { status, json } = await postHold(
      holdPayload({
        action: 'hold',
        service: 'cleaning',
        date: '2026-10-14',
        time: '09:30',
        patientName: 'Hakim El Mitshu',
        callbackNumber: '+15144315049',
        newPatient: true,
      }),
      SECRET,
    );
    expect(status).toBe(200);
    const result = firstResult(json);
    // Every fact the CLOSE state composes from, labeled, built only from
    // stored/validated fields.
    expect(result).toContain('Hold created. Closing facts — ');
    expect(result).toContain('summary: a cleaning on Wednesday, October 14th at 9:30 AM');
    expect(result).toContain('clinic: SmileCraft Dental');
    expect(result).toContain('caller first name: Hakim');
    expect(result).toContain('new patient: yes');
    expect(result).toContain('arriving fifteen minutes early for paperwork and bringing an insurance card');
    expect(result).toContain('held in this demo');
    expect(result).toContain("land straight on SmileCraft Dental's calendar");
    expect(result).toContain('ONE goodbye');
    // The compose instruction teaches the same TWO-TURN close the prompt's
    // CLOSE state carries: confirmation beats + pivot question first, the
    // trial line and the one goodbye only after the caller answers.
    expect(result).toContain('in TWO turns');
    expect(result).toContain('Turn one: confirm the hold with the summary');
    expect(result).toContain('ask "Is there anything else I can help you with today?"');
    expect(result).toContain('no trial line and no goodbye in turn one');
    expect(result).toContain('Final turn, after they answer: the free trial line and ONE goodbye');
    // And NO script: no read-verbatim instruction, no composed paragraph,
    // no thank-you/goodbye text for her to parrot or double.
    expect(result).not.toContain('word for word');
    expect(result).not.toContain('Read this closing');
    expect(result).not.toContain('Perfect. I have you held in this demo for');
    expect(result).not.toContain('Thanks so much for calling');
    expect(result).not.toContain('Take care now');
  });

  it('flags new patient: no (and no arrive-early fact) when the caller is not a new patient', async () => {
    const { json } = await postHold(
      holdPayload({
        action: 'hold',
        service: 'cleaning',
        date: '2026-10-14',
        time: '09:30',
        patientName: 'Hakim El Mitshu',
        callbackNumber: '+15144315049',
      }),
      SECRET,
    );
    const result = firstResult(json);
    expect(result).toContain('Closing facts');
    expect(result).toContain('caller first name: Hakim');
    expect(result).toContain('new patient: no');
    expect(result).not.toContain('fifteen minutes early');
  });

  it('returns closing facts carrying the NEW summary on "change"', async () => {
    vi.mocked(prisma.demoHold.findUnique).mockResolvedValue(makeRow() as never);
    vi.mocked(prisma.demoHold.update).mockImplementation(
      async (args: never) => ({ ...makeRow(), ...(args as { data: object }).data }) as never,
    );
    const { status, json } = await postHold(
      holdPayload({ action: 'change', date: '2026-10-14', time: '12:00', newPatient: false }),
      SECRET,
    );
    expect(status).toBe(200);
    const result = firstResult(json);
    expect(result).toContain('Hold changed. Closing facts — ');
    expect(result).toContain('summary: a cleaning on Wednesday, October 14th at 12 PM');
    expect(result).toContain('clinic: SmileCraft Dental');
    expect(result).toContain('caller first name: Jordan');
    expect(result).toContain('new patient: no');
    expect(result).not.toContain('fifteen minutes early');
    expect(result).not.toContain('Thanks so much for calling');
  });

  it('resolves the clinic name from the lead businessName when the stored facts carry none', async () => {
    vi.mocked(prisma.demoLead.findFirst).mockResolvedValue({
      id: 'lead1',
      businessName: 'Maple Dental Studio',
      factsJson: null,
    } as never);
    const { json } = await postHold(holdPayload(HOLD_ARGS), SECRET);
    const result = firstResult(json);
    expect(result).toContain('clinic: Maple Dental Studio');
    expect(result).toContain("land straight on Maple Dental Studio's calendar");
    expect(result).toContain('caller first name: Jordan');
  });

  it('cancel keeps its plain confirmation shape — no facts card attached', async () => {
    vi.mocked(prisma.demoHold.findUnique).mockResolvedValue(makeRow() as never);
    vi.mocked(prisma.demoHold.update).mockImplementation(
      async (args: never) => ({ ...makeRow(), ...(args as { data: object }).data }) as never,
    );
    const { json } = await postHold(holdPayload({ action: 'cancel' }), SECRET);
    const result = firstResult(json);
    expect(result).toMatch(/cancelled/i);
    expect(result).not.toContain('Closing facts');
    expect(result).not.toContain('free trial');
    expect(result).not.toContain('held in this demo for');
  });
});
