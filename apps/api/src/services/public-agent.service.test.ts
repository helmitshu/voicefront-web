import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for Lyla, the public landing-page host. The DB is faked with
 * a tripwire: her ONLY permitted write is a demo lead row, so every
 * tenant-scoped model counts its calls and throws. Gemini and the geo
 * lookup are stubbed at fetch; the clinic-facts reader is module-mocked.
 */

const state = vi.hoisted(() => {
  process.env.GEMINI_API_KEY = 'shared-test-key';
  process.env.LYLA_GEMINI_API_KEY = 'lyla-test-key';
  process.env.TWILIO_ACCOUNT_SID = 'AC-test';
  process.env.TWILIO_AUTH_TOKEN = 'twilio-test';
  process.env.TWILIO_FROM_NUMBER = '+14165550100';

  const leads: Array<Record<string, unknown>> = [];
  const tripwires: Record<string, number> = {};
  const geminiScript: Array<() => Response> = [];
  const geminiRequests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const ipCountries = new Map<string, string>();
  const clinicFacts = { current: null as unknown };

  const tripwire = (model: string) => () => {
    tripwires[model] = (tripwires[model] ?? 0) + 1;
    throw new Error(`Lyla must never touch prisma.${model}`);
  };

  return { leads, tripwires, geminiScript, geminiRequests, ipCountries, clinicFacts, tripwire };
});

vi.mock('../lib/prisma', () => ({
  prisma: {
    demoLead: {
      create: (args: { data: Record<string, unknown> }) => {
        const row = { id: `lead_${state.leads.length + 1}`, ...args.data };
        state.leads.push(row);
        return Promise.resolve(row);
      },
    },
    tenant: { findUnique: state.tripwire('tenant'), findMany: state.tripwire('tenant') },
    user: { findUnique: state.tripwire('user') },
    agentSettings: { findUnique: state.tripwire('agentSettings') },
    callLog: { findMany: state.tripwire('callLog'), findFirst: state.tripwire('callLog') },
    supportTicket: { create: state.tripwire('supportTicket') },
    appointment: { create: state.tripwire('appointment'), findMany: state.tripwire('appointment') },
  },
}));

vi.mock('./clinic-facts.service', () => ({
  fetchClinicFacts: vi.fn(() => Promise.resolve(state.clinicFacts.current)),
}));

import { HttpError } from '../lib/http';
import {
  MAX_TURNS_PER_SESSION,
  PROACTIVE_FALLBACK_LINES,
  PUBLIC_AGENT,
  PUBLIC_KNOWLEDGE_BLOCK,
  PUBLIC_TOOL_NAMES,
  __resetPublicAgentStateForTests,
  beginSessionTurn,
  claimProactive,
  computeLeakQuote,
  getPublicSession,
  publicChatAvailability,
  resolvePublicAgentKey,
  resolveVisitorContext,
  runPublicChat,
  runPublicChatStream,
  runPublicProactive,
  startPublicSession,
  validatePageAction,
  type PublicSession,
  type VisitorContext,
} from './public-agent.service';

const CA_VISITOR: VisitorContext = { country: 'CA', currency: 'CAD', demoPath: 'web' };

function geminiJson(parts: unknown[]): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
const textReply = (text: string) => () => geminiJson([{ text }]);
const callReply = (name: string, args: Record<string, unknown>) => () => geminiJson([{ functionCall: { name, args } }]);
function streamReply(chunks: string[]): Response {
  const body = chunks
    .map((c) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: c }] } }] })}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function makeSession(ip: string | null = '203.0.113.10'): PublicSession {
  return startPublicSession(ip, CA_VISITOR);
}

beforeEach(() => {
  __resetPublicAgentStateForTests();
  state.leads.length = 0;
  for (const key of Object.keys(state.tripwires)) delete state.tripwires[key];
  state.geminiScript.length = 0;
  state.geminiRequests.length = 0;
  state.ipCountries.clear();
  state.clinicFacts.current = null;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        state.geminiRequests.push({ url: u, headers: init?.headers ?? {}, body: init?.body ?? '' });
        const next = state.geminiScript.shift();
        if (!next) throw new Error('Gemini script exhausted');
        return next();
      }
      if (u.startsWith('https://ipapi.co/')) {
        const ip = u.split('/')[3] ?? '';
        const country = state.ipCountries.get(ip);
        if (!country) throw new Error('geo lookup failed');
        return new Response(country, { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('persona and knowledge', () => {
  it('presents Lyla as an AI host, plainly', () => {
    expect(PUBLIC_AGENT.name).toBe('Lyla');
    expect(PUBLIC_AGENT.title).toBe('Customer Experience Specialist');
    expect(PUBLIC_AGENT.identityLine).toContain('AI host from VoiceFront');
    expect(PUBLIC_AGENT.greeting).toContain('AI host from VoiceFront');
  });

  it('pins the public price book, caps, trial, and demo paths', () => {
    const pins = [
      'Starter After-Hours is $299 a month in US dollars, with 300 included minutes a month',
      'Canadian clinics pay CAD $399',
      'Core 24/7 is $499 a month in US dollars, with 950 included minutes a month',
      'Canadian clinics pay CAD $599',
      'Extra minutes are $0.50 each in US dollars, CAD $0.75 in Canadian dollars',
      'Both plans: $0 setup, a 7-day free trial, and you can cancel anytime. A card is required to start the trial.',
      'White glove setup is the one paid extra: $500 one time',
      'In Canada the demo runs right in your browser. In the US she calls your phone instead.',
      'You choose from twelve built-in voices.',
      'double-book protection on every booking',
      'These are the only two plans offered today.',
    ];
    for (const pin of pins) expect(PUBLIC_KNOWLEDGE_BLOCK).toContain(pin);
  });

  it('never names an unbuilt plan or feature in her knowledge', () => {
    expect(PUBLIC_KNOWLEDGE_BLOCK).not.toContain('Growth');
    expect(PUBLIC_KNOWLEDGE_BLOCK).not.toContain('$899');
  });
});

describe('tool registry isolation', () => {
  it('contains exactly her own tools, and none of the tenant-scoped ones', () => {
    expect([...PUBLIC_TOOL_NAMES].sort()).toEqual(
      [
        'capture_lead',
        'compute_leak',
        'get_visitor_context',
        'guide_to_section',
        'highlight_plan',
        'open_signup',
        'prefill_demo',
        'read_clinic_site',
        'start_demo',
      ].sort(),
    );
    const tenantTools = [
      'get_call_details',
      'list_recent_calls',
      'list_calls_in_range',
      'analyze_call_quality',
      'get_account_snapshot',
      'get_workspace_state',
      'propose_ticket',
      'file_ticket',
      'run_simulated_call',
      'get_booking_window',
    ];
    for (const name of tenantTools) expect(PUBLIC_TOOL_NAMES).not.toContain(name);
  });
});

describe('computeLeakQuote', () => {
  it('does the monthly and yearly math in code', () => {
    const quote = computeLeakQuote({ patientsPerDay: 20, averageVisitValue: 150, missedCallSharePercent: 25 });
    expect(quote.missedCallsPerDay).toBe(5);
    expect(quote.missedCallsPerMonth).toBe(150);
    expect(quote.monthlyLoss).toBe(22500);
    expect(quote.yearlyLoss).toBe(270000);
  });

  it('refuses out-of-range or non-numeric inputs', () => {
    expect(() => computeLeakQuote({ patientsPerDay: 0, averageVisitValue: 150, missedCallSharePercent: 25 })).toThrow();
    expect(() => computeLeakQuote({ patientsPerDay: 20, averageVisitValue: 150, missedCallSharePercent: 101 })).toThrow();
    expect(() => computeLeakQuote({ patientsPerDay: 'many', averageVisitValue: 150, missedCallSharePercent: 25 })).toThrow();
  });
});

describe('validatePageAction', () => {
  it('passes well-formed actions through', () => {
    expect(validatePageAction('guide_to_section', { section: 'pricing' })).toEqual({
      type: 'guide_to_section',
      section: 'pricing',
    });
    expect(validatePageAction('highlight_plan', { plan: 'core' })).toEqual({ type: 'highlight_plan', plan: 'core' });
    expect(validatePageAction('open_signup', { plan: 'starter' })).toEqual({ type: 'open_signup', plan: 'starter' });
    expect(validatePageAction('start_demo', {})).toEqual({ type: 'start_demo' });
    expect(validatePageAction('prefill_demo', { name: '  Jo Smith ', email: 'jo@clinic.ca' })).toEqual({
      type: 'prefill_demo',
      fields: { name: 'Jo Smith', email: 'jo@clinic.ca' },
    });
  });

  it('drops unknown actions and malformed payloads', () => {
    expect(validatePageAction('delete_everything', {})).toBeNull();
    expect(validatePageAction('guide_to_section', { section: 'admin' })).toBeNull();
    expect(validatePageAction('highlight_plan', { plan: 'growth' })).toBeNull();
    expect(validatePageAction('open_signup', {})).toBeNull();
    expect(validatePageAction('prefill_demo', {})).toBeNull();
    expect(validatePageAction('prefill_demo', { name: '   ' })).toBeNull();
  });
});

describe('session armor', () => {
  it('caps chat turns per session at 12', () => {
    const session = makeSession();
    for (let i = 0; i < MAX_TURNS_PER_SESSION; i += 1) beginSessionTurn(session);
    expect(session.turns).toBe(12);
    try {
      beginSessionTurn(session);
      expect.unreachable('the 13th turn must refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('SESSION_TURN_LIMIT');
    }
  });

  it('caps sessions per IP per day at 10', () => {
    for (let i = 0; i < 10; i += 1) makeSession('198.51.100.7');
    try {
      makeSession('198.51.100.7');
      expect.unreachable('the 11th session must refuse');
    } catch (err) {
      expect((err as HttpError).code).toBe('IP_SESSION_LIMIT');
    }
    // A different IP is unaffected.
    expect(makeSession('198.51.100.8').id).toMatch(/^lyla_/);
  });

  it('trips the global daily circuit breaker at the configured limit', () => {
    for (let i = 0; i < 300; i += 1) makeSession(`203.0.${Math.floor(i / 250)}.${i % 250}`);
    expect(publicChatAvailability()).toEqual({ available: false, reason: 'CIRCUIT_BREAKER' });
    try {
      makeSession('192.0.2.1');
      expect.unreachable('a tripped breaker must refuse new sessions');
    } catch (err) {
      expect((err as HttpError).code).toBe('CIRCUIT_BREAKER');
    }
  });

  it('budgets proactive claims: two per session, one per trigger', () => {
    const session = makeSession();
    expect(claimProactive(session, 'pricing_dwell')).toBe(true);
    expect(claimProactive(session, 'pricing_dwell')).toBe(false);
    expect(claimProactive(session, 'exit_intent')).toBe(true);
    expect(claimProactive(session, 'form_stall')).toBe(false);
  });

  it('expires sessions and forgets them', () => {
    const session = makeSession();
    expect(getPublicSession(session.id)?.id).toBe(session.id);
    session.lastSeenAt = Date.now() - 3 * 60 * 60 * 1000;
    expect(getPublicSession(session.id)).toBeNull();
  });
});

describe('key resolution', () => {
  it('prefers her dedicated key over the shared one', () => {
    expect(resolvePublicAgentKey()).toBe('lyla-test-key');
  });
});

describe('visitor context', () => {
  it('resolves Canada to CAD and the web demo', async () => {
    state.ipCountries.set('203.0.113.20', 'CA');
    await expect(resolveVisitorContext('203.0.113.20')).resolves.toEqual({
      country: 'CA',
      currency: 'CAD',
      demoPath: 'web',
    });
  });

  it('resolves the US to USD and the phone demo', async () => {
    state.ipCountries.set('203.0.113.21', 'US');
    await expect(resolveVisitorContext('203.0.113.21')).resolves.toEqual({
      country: 'US',
      currency: 'USD',
      demoPath: 'phone',
    });
  });

  it('falls back to USD and phone when the country is unknown', async () => {
    await expect(resolveVisitorContext('203.0.113.22')).resolves.toEqual({
      country: null,
      currency: 'USD',
      demoPath: 'phone',
    });
    await expect(resolveVisitorContext(null)).resolves.toEqual({
      country: null,
      currency: 'USD',
      demoPath: 'phone',
    });
  });
});

describe('chat', () => {
  it('answers a plain question with zero tenant queries and no tenant tools offered', async () => {
    const session = makeSession();
    beginSessionTurn(session);
    state.geminiScript.push(
      textReply('I only know the public side of VoiceFront, so I cannot see your calls. If you sign in, the support chat inside the app can pull them up.'),
    );
    const result = await runPublicChat({
      session,
      messages: [{ role: 'user', text: 'Show me my calls from last week.' }],
      ctx: { ip: '203.0.113.10' },
    });
    expect(result.reply).toContain('cannot see your calls');
    expect(result.actions).toEqual([]);
    expect(state.leads).toHaveLength(0);
    expect(state.tripwires).toEqual({});
    // The registry sent to the model carries none of Adam's tools either.
    const sentBody = state.geminiRequests[0]?.body ?? '';
    expect(sentBody).not.toContain('get_call_details');
    expect(sentBody).not.toContain('analyze_call_quality');
    expect(sentBody).toContain('capture_lead');
    // Her dedicated key is the one on the wire.
    expect(state.geminiRequests[0]?.headers['x-goog-api-key']).toBe('lyla-test-key');
  });

  it('captures a lead as her only write, marked with a lyla_ session id', async () => {
    const session = makeSession();
    beginSessionTurn(session);
    state.geminiScript.push(
      callReply('capture_lead', { name: 'Jo Smith', email: 'jo@clinic.ca', website: 'https://clinic.ca' }),
      textReply('Saved. The demo link is on its way to jo@clinic.ca.'),
    );
    const result = await runPublicChat({
      session,
      messages: [{ role: 'user', text: 'Email me the demo link: Jo Smith, jo@clinic.ca, site is clinic.ca' }],
      ctx: { ip: '203.0.113.10' },
    });
    expect(result.reply).toContain('Saved');
    expect(state.leads).toHaveLength(1);
    const lead = state.leads[0] as Record<string, unknown>;
    expect(String(lead.demoSessionId)).toMatch(/^lyla_/);
    expect(lead.name).toBe('Jo Smith');
    expect(lead.email).toBe('jo@clinic.ca');
    expect(lead.websiteUrl).toBe('https://clinic.ca');
    expect(lead.ipCountry).toBe('CA');
    expect(lead.mode).toBe('pending');
    expect(lead.phone).toBe('');
    expect(state.tripwires).toEqual({});
  });

  it('refuses a second lead in the same session', async () => {
    const session = makeSession();
    beginSessionTurn(session);
    state.geminiScript.push(
      callReply('capture_lead', { name: 'Jo Smith', email: 'jo@clinic.ca' }),
      textReply('Saved.'),
      callReply('capture_lead', { name: 'Jo Smith', email: 'jo@clinic.ca' }),
      textReply('Already saved.'),
    );
    await runPublicChat({ session, messages: [{ role: 'user', text: 'save me' }], ctx: { ip: null } });
    beginSessionTurn(session);
    await runPublicChat({
      session,
      messages: [
        { role: 'user', text: 'save me' },
        { role: 'assistant', text: 'Saved.' },
        { role: 'user', text: 'save me again' },
      ],
      ctx: { ip: null },
    });
    expect(state.leads).toHaveLength(1);
  });

  it('reads the clinic site through the demo reader and speaks from its facts', async () => {
    state.clinicFacts.current = {
      businessName: 'Riverside Dental',
      hours: ['Mon-Fri 8am-5pm'],
      services: ['Cleanings', 'Implants'],
    };
    const session = makeSession();
    beginSessionTurn(session);
    state.geminiScript.push(
      callReply('read_clinic_site', { website: 'https://riverside.example' }),
      textReply('Riverside Dental, open Mon-Fri 8am-5pm. She would greet your patients with exactly that.'),
    );
    const result = await runPublicChat({
      session,
      messages: [{ role: 'user', text: 'My site is riverside.example, what would the demo know?' }],
      ctx: { ip: null },
    });
    expect(result.reply).toContain('Riverside Dental');
    const secondRequest = state.geminiRequests[1]?.body ?? '';
    expect(secondRequest).toContain('Riverside Dental');
    expect(secondRequest).toContain('Cleanings');
  });

  it('quotes only the leak math the code computed', async () => {
    const session = makeSession();
    beginSessionTurn(session);
    state.geminiScript.push(
      callReply('compute_leak', { patientsPerDay: 20, averageVisitValue: 150, missedCallSharePercent: 25 }),
      textReply('That is about 150 missed calls a month, roughly $22,500 in visits walking away.'),
    );
    await runPublicChat({
      session,
      messages: [{ role: 'user', text: '20 patients a day, $150 a visit, a quarter of calls missed.' }],
      ctx: { ip: null },
    });
    const secondRequest = state.geminiRequests[1]?.body ?? '';
    expect(secondRequest).toContain('22500');
    expect(secondRequest).toContain('270000');
  });

  it('returns validated page actions in order, and drops invalid ones', async () => {
    const session = makeSession();
    beginSessionTurn(session);
    state.geminiScript.push(
      callReply('guide_to_section', { section: 'pricing' }),
      callReply('highlight_plan', { plan: 'core' }),
      callReply('guide_to_section', { section: 'admin' }),
      textReply('Here are the plans. Core is the one most clinics pick.'),
    );
    const result = await runPublicChat({
      session,
      messages: [{ role: 'user', text: 'Show me the plans.' }],
      ctx: { ip: null },
    });
    expect(result.actions).toEqual([
      { type: 'guide_to_section', section: 'pricing' },
      { type: 'highlight_plan', plan: 'core' },
    ]);
  });
});

describe('streaming', () => {
  it('streams deltas and lands the same final reply', async () => {
    const session = makeSession();
    beginSessionTurn(session);
    state.geminiScript.push(() => streamReply(['Hello ', 'there.']));
    const deltas: string[] = [];
    const result = await runPublicChatStream(
      { session, messages: [{ role: 'user', text: 'Hi' }], ctx: { ip: null } },
      { status: () => undefined, delta: (t) => deltas.push(t) },
    );
    expect(deltas.join('')).toBe('Hello there.');
    expect(result.reply).toBe('Hello there.');
  });

  it('falls back to the plain call when streaming is refused before the first event', async () => {
    const session = makeSession();
    beginSessionTurn(session);
    state.geminiScript.push(
      () => new Response('streaming unsupported', { status: 400 }),
      textReply('Plain answer.'),
    );
    const result = await runPublicChatStream(
      { session, messages: [{ role: 'user', text: 'Hi' }], ctx: { ip: null } },
      { status: () => undefined, delta: () => undefined },
    );
    expect(result.reply).toBe('Plain answer.');
    expect(state.geminiRequests[0]?.url).toContain('streamGenerateContent');
    expect(state.geminiRequests[1]?.url).toContain('generateContent');
  });
});

describe('proactive lines', () => {
  it('spends the budget in code: one per trigger, two per session, then quiet', async () => {
    const session = makeSession();
    state.geminiScript.push(textReply('One line.'), textReply('Another line.'));
    await expect(
      runPublicProactive({ session, trigger: 'pricing_dwell', ctx: { ip: null } }),
    ).resolves.toEqual({ line: 'One line.' });
    await expect(
      runPublicProactive({ session, trigger: 'pricing_dwell', ctx: { ip: null } }),
    ).resolves.toEqual({ line: null });
    await expect(
      runPublicProactive({ session, trigger: 'exit_intent', ctx: { ip: null } }),
    ).resolves.toEqual({ line: 'Another line.' });
    await expect(
      runPublicProactive({ session, trigger: 'form_stall', ctx: { ip: null } }),
    ).resolves.toEqual({ line: null });
  });

  it('uses her canned line when the model call fails', async () => {
    const session = makeSession();
    state.geminiScript.push(() => new Response('boom', { status: 400 }));
    await expect(
      runPublicProactive({ session, trigger: 'form_stall', ctx: { ip: null } }),
    ).resolves.toEqual({ line: PROACTIVE_FALLBACK_LINES.form_stall });
  });
});
