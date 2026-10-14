import { describe, it, expect } from 'vitest';
import type { AgentSettings, Tenant } from '@prisma/client';
import {
  buildAssistantUpdatePayload,
  buildTransientAssistant,
  capAssistantName,
} from './assistant-builder';
import { defaultBusinessHours } from './agent-config';

const tenant = { id: 't1', companyName: 'Acme Dental', industry: 'CLINIC' } as Pick<
  Tenant,
  'id' | 'companyName' | 'industry'
>;

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    id: 's1',
    tenantId: 't1',
    assistantId: null,
    displayName: 'Maya',
    systemPrompt: 'You are a receptionist.',
    firstMessage: 'Hi there.',
    voicemailGreeting: 'Please leave a message.',
    businessHours: defaultBusinessHours(),
    forwardingNumbers: [],
    timezone: 'America/New_York',
    inboundPhoneNumber: null,
    voiceProvider: 'vapi',
    voiceId: 'Emma',
    backgroundSound: 'office',
    offerProviderChoice: false,
    updatedAt: new Date(),
    ...overrides,
  } as AgentSettings;
}

describe('buildAssistantUpdatePayload (persistent assistant)', () => {
  it('lists providers and adds provider params to booking tools with 2+ providers', () => {
    const payload = buildAssistantUpdatePayload(tenant, settings(), {
      providers: [
        { name: 'Dr. A', title: null },
        { name: 'Dr. B', title: null },
      ],
      services: [{ name: 'Cleaning', durationMinutes: 30 }],
    });
    expect(payload.model.messages[0].content).toContain('PROVIDERS & SERVICES');
    const book = payload.model.tools?.find((t) => 'function' in t && t.function.name === 'bookAppointment');
    expect(JSON.stringify(book)).toContain('providerName');
  });

  it('stays a simple single calendar for one provider', () => {
    const payload = buildAssistantUpdatePayload(tenant, settings(), {
      providers: [{ name: 'Solo Doc', title: null }],
    });
    expect(payload.model.messages[0].content).not.toContain('PROVIDERS & SERVICES');
    const book = payload.model.tools?.find((t) => 'function' in t && t.function.name === 'bookAppointment');
    expect(JSON.stringify(book)).not.toContain('providerName');
  });

  it('does NOT attach the job-capture tool or prompt for a clinic', () => {
    const payload = buildAssistantUpdatePayload(tenant, settings());
    const job = payload.model.tools?.find((t) => 'function' in t && t.function.name === 'captureJobRequest');
    expect(job).toBeUndefined();
    expect(payload.model.messages[0].content).not.toContain('CAPTURING A JOB OR SERVICE REQUEST');
  });

  it('boosts the transcriber on the company name + persona so names are heard right', () => {
    const payload = buildAssistantUpdatePayload(tenant, settings({ displayName: 'Marcus' }));
    const kw = payload.transcriber.keywords ?? [];
    // "Acme Dental" → Acme + Dental, plus the persona — each with an intensity.
    expect(kw).toContain('Acme:2');
    expect(kw).toContain('Dental:2');
    expect(kw).toContain('Marcus:2');
  });

  it('includes bookable provider names in the transcriber keyterms', () => {
    const payload = buildAssistantUpdatePayload(tenant, settings(), {
      providers: [
        { name: 'Priya Nair', title: null },
        { name: 'Dr. Lee', title: null },
      ],
    });
    const kw = payload.transcriber.keywords ?? [];
    expect(kw).toContain('Priya:2');
    expect(kw).toContain('Nair:2');
  });

  it('enables denoising, backchanneling, and idle messages', () => {
    const payload = buildAssistantUpdatePayload(tenant, settings());
    expect(payload.backgroundDenoisingEnabled).toBe(true);
    expect(payload.backchannelingEnabled).toBe(true);
    expect(payload.messagePlan?.idleMessages.length).toBeGreaterThan(0);
  });

  it('keeps the stock platform end-call message (tenant production is unchanged)', () => {
    // Only the personalized demo assistant drops endCallMessage, and it
    // does so downstream in demo.routes.ts — the persistent tenant
    // payload keeps the configured goodbye byte-identical.
    const payload = buildAssistantUpdatePayload(tenant, settings());
    expect(payload.endCallMessage).toBe('Thanks so much for calling Acme Dental — take care now, bye!');
  });

  it('attaches the job-capture tool + intake prompt for a trades workspace', () => {
    const trades = { id: 't2', companyName: 'Acme Plumbing', industry: 'CONSTRUCTION' } as Pick<
      Tenant,
      'id' | 'companyName' | 'industry'
    >;
    const payload = buildAssistantUpdatePayload(trades, settings());
    const job = payload.model.tools?.find((t) => 'function' in t && t.function.name === 'captureJobRequest');
    expect(job).toBeDefined();
    expect(JSON.stringify(job)).toContain('urgency');
    expect(payload.model.messages[0].content).toContain('CAPTURING A JOB OR SERVICE REQUEST');
  });
});

describe('capAssistantName (Vapi caps assistant names at 40 characters)', () => {
  it('passes names at or under the cap through unchanged', () => {
    expect(capAssistantName('Acme Dental Receptionist')).toBe('Acme Dental Receptionist');
    expect(capAssistantName('A'.repeat(40))).toBe('A'.repeat(40));
  });

  it('cuts an over-long name at a clean boundary near the cap instead of mid-word', () => {
    // The personalized-demo composition: "Maya · <58-char clinic> receptionist (demo)".
    const composed =
      'Maya · Modern Top Rated Dentist And Orthodontics Center Vancouver receptionist (demo)';
    const capped = capAssistantName(composed);
    expect(capped.length).toBeLessThanOrEqual(40);
    expect(capped).toBe('Maya · Modern Top Rated Dentist And');
  });

  it('hard-cuts a single long word with no boundary to land on', () => {
    const capped = capAssistantName('A'.repeat(55));
    expect(capped).toBe('A'.repeat(40));
  });

  it('never leaves a dangling separator at the end', () => {
    const capped = capAssistantName(`${'Word '.repeat(7)}Word · extra words push this over`);
    expect(capped.length).toBeLessThanOrEqual(40);
    expect(capped).not.toMatch(/[\s·\-/(]$/);
  });
});

describe('buildTransientAssistant demo-standard (v2) overrides', () => {
  const DEMO_VOICE = {
    provider: '11labs',
    voiceId: 'cgSgspJ2msm6clMCkdW9',
    model: 'eleven_turbo_v2_5',
    stability: 0.4,
    similarityBoost: 0.75,
    style: 0.3,
    useSpeakerBoost: true,
    speed: 1.1,
    optimizeStreamingLatency: 3,
  };

  it('pins every demo-standard (v2) field onto the built assistant', () => {
    const assistant = buildTransientAssistant(tenant, settings(), 'phone', new Date(), {
      systemPromptOverride: 'You are Maya.',
      voice: DEMO_VOICE,
      backgroundSound: 'office',
      temperature: 0.55,
      transcriberModel: 'flux-general-en',
      transcriberEotThreshold: 0.8,
      transcriberKeywords: ['dental:2', 'Maple:2'],
      startSpeakingPlan: { waitSeconds: 0.3, smartEndpointingEnabled: false },
      stopSpeakingPlan: {
        numWords: 2,
        voiceSeconds: 0.2,
        backoffSeconds: 0.6,
        acknowledgementPhrases: ['okay', 'uh-huh', 'yeah', 'mm-hmm'],
      },
      silenceTimeoutSeconds: 30,
      backgroundDenoisingEnabled: true,
    });
    expect(assistant.voice).toEqual(DEMO_VOICE);
    expect(assistant.model.provider).toBe('openai');
    expect(assistant.model.model).toBe('gpt-4o');
    expect(assistant.model.temperature).toBe(0.55);
    expect(assistant.transcriber.provider).toBe('deepgram');
    expect(assistant.transcriber.model).toBe('flux-general-en');
    expect(assistant.transcriber.language).toBe('en');
    expect(assistant.transcriber.endpointing).toBeUndefined();
    expect(assistant.transcriber.eotThreshold).toBe(0.8);
    // Flux takes the vocabulary as plain `keyterm` entries — the Nova
    // `keywords` field and its `:intensity` suffixes stay off the wire.
    expect(assistant.transcriber.keywords).toBeUndefined();
    expect(assistant.transcriber.keyterm).toEqual(['dental', 'Maple']);
    expect(assistant.startSpeakingPlan).toEqual({ waitSeconds: 0.3, smartEndpointingEnabled: false });
    expect(assistant.stopSpeakingPlan).toEqual({
      numWords: 2,
      voiceSeconds: 0.2,
      backoffSeconds: 0.6,
      acknowledgementPhrases: ['okay', 'uh-huh', 'yeah', 'mm-hmm'],
    });
    expect(assistant.silenceTimeoutSeconds).toBe(30);
    expect(assistant.backchannelingEnabled).toBe(true);
    expect(assistant.backgroundDenoisingEnabled).toBe(true);
    expect(assistant.backgroundSound).toBe('office');
    expect(assistant.firstMessageMode).toBe('assistant-speaks-first');
  });

  it('a Nova transcriber model still renders the boosts as `keywords`', () => {
    const assistant = buildTransientAssistant(tenant, settings(), 'phone', new Date(), {
      systemPromptOverride: 'You are Maya.',
      transcriberModel: 'nova-3',
      transcriberEndpointing: 500,
      transcriberKeywords: ['dental:2'],
    });
    expect(assistant.transcriber.model).toBe('nova-3');
    expect(assistant.transcriber.endpointing).toBe(500);
    expect(assistant.transcriber.eotThreshold).toBeUndefined();
    expect(assistant.transcriber.keywords).toEqual(['dental:2']);
    expect(assistant.transcriber.keyterm).toBeUndefined();
  });

  it('without the overrides, every field keeps its long-standing default', () => {
    // The sales demo and every other caller pass none of the parity options;
    // their serialized assistant must not change by a single field.
    const assistant = buildTransientAssistant(
      tenant,
      settings({ silenceTimeoutSeconds: 45 }),
      'phone',
      new Date(),
      { voice: { provider: '11labs', voiceId: 'some-voice' } },
    );
    expect(assistant.voice).toEqual({ provider: '11labs', voiceId: 'some-voice' });
    expect(assistant.model.temperature).toBe(0.65);
    expect(assistant.transcriber.model).toBe('nova-2');
    expect(assistant.transcriber.endpointing).toBeUndefined();
    expect(assistant.startSpeakingPlan).toEqual({ waitSeconds: 0.6, smartEndpointingEnabled: true });
    expect(assistant.stopSpeakingPlan).toEqual({ numWords: 3, voiceSeconds: 0.3, backoffSeconds: 1.0 });
    expect(assistant.silenceTimeoutSeconds).toBe(45);
    // Denoising has always been on for transient assistants (it is part of
    // the sales demo's current payload too); the override only restates it.
    expect(assistant.backgroundDenoisingEnabled).toBe(true);
  });

  it('a vapi voice override still serializes as the V2 voice, tuning fields ignored', () => {
    const assistant = buildTransientAssistant(tenant, settings(), 'phone', new Date(), {
      voice: { provider: 'vapi', voiceId: 'Savannah' },
    });
    expect(assistant.voice).toEqual({ provider: 'vapi', voiceId: 'Savannah', version: 2 });
  });
});

describe('buildTransientAssistant assistant name cap', () => {
  const LONG_COMPANY = 'Modern Top Rated Dentist And Orthodontics Center Vancouver';

  it('caps the default tenant name when the company name is long', () => {
    const longTenant = { id: 't3', companyName: LONG_COMPANY, industry: 'CLINIC' } as Pick<
      Tenant,
      'id' | 'companyName' | 'industry'
    >;
    const assistant = buildTransientAssistant(longTenant, settings(), 'phone', new Date());
    expect(assistant.name.length).toBeLessThanOrEqual(40);
  });

  it('caps an explicit assistantName override the same way', () => {
    const assistant = buildTransientAssistant(tenant, settings(), 'phone', new Date(), {
      assistantName: `Maya · ${LONG_COMPANY} receptionist (demo)`,
    });
    expect(assistant.name).toBe('Maya · Modern Top Rated Dentist And');
  });

  it('leaves short names byte-identical on both paths', () => {
    const byDefault = buildTransientAssistant(tenant, settings(), 'phone', new Date());
    expect(byDefault.name).toBe('Acme Dental Receptionist');
    const byOverride = buildTransientAssistant(tenant, settings(), 'phone', new Date(), {
      assistantName: 'Ava · VoiceFront (demo)',
    });
    expect(byOverride.name).toBe('Ava · VoiceFront (demo)');
  });

  it('still carries the stock platform end-call message by default', () => {
    // The builder default is unchanged: sales and inbound assistants keep
    // the configured goodbye. Only the personalized demo route deletes
    // the property from its assistant before placing the call.
    const assistant = buildTransientAssistant(tenant, settings(), 'phone', new Date());
    expect(assistant.endCallMessage).toBe(
      'Thanks so much for calling Acme Dental — take care now, bye!',
    );
  });
});

describe('buildTransientAssistant holdAppointment (function-gated booking)', () => {
  it('swaps the whole booking toolset for exactly the hold tool, with its server config', () => {
    const assistant = buildTransientAssistant(tenant, settings(), 'phone', new Date(), {
      systemPromptOverride: 'You are Maya.',
      holdAppointment: { serverUrl: 'https://api.example.test/api/demo/hold', serverSecret: 's3cret' },
    });
    const tools = assistant.model.tools ?? [];
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.type).toBe('function');
    if (tool.type !== 'function') throw new Error('expected a function tool');
    expect(tool.function.name).toBe('hold_appointment');
    expect(tool.server).toEqual({ url: 'https://api.example.test/api/demo/hold', secret: 's3cret' });
    expect(tool.function.parameters.required).toEqual(['action']);
    expect(Object.keys(tool.function.parameters.properties).sort()).toEqual([
      'action',
      'callbackNumber',
      'date',
      'newPatient',
      'patientName',
      'service',
      'time',
    ]);
    expect(tool.function.parameters.properties.action?.enum).toEqual(['hold', 'change', 'cancel']);
    expect(tool.function.parameters.properties.newPatient?.type).toBe('boolean');
    // Optional: hold/change still work when the model omits it.
    expect(tool.function.parameters.required).not.toContain('newPatient');
  });

  it('omits the secret key entirely when no server secret is configured', () => {
    const assistant = buildTransientAssistant(tenant, settings(), 'phone', new Date(), {
      systemPromptOverride: 'You are Maya.',
      holdAppointment: { serverUrl: 'https://api.example.test/api/demo/hold' },
    });
    const tool = (assistant.model.tools ?? [])[0]!;
    if (tool.type !== 'function') throw new Error('expected a function tool');
    expect(tool.server).toEqual({ url: 'https://api.example.test/api/demo/hold' });
    expect(tool.server && 'secret' in tool.server).toBe(false);
  });

  it('without the option, the standard five booking tools stay (defaults untouched)', () => {
    const assistant = buildTransientAssistant(tenant, settings(), 'phone', new Date(), {
      systemPromptOverride: 'You are Maya.',
    });
    const names = (assistant.model.tools ?? []).map((t) => (t.type === 'function' ? t.function.name : t.type));
    expect(names).toEqual([
      'checkAvailability',
      'bookAppointment',
      'findAppointment',
      'rescheduleAppointment',
      'cancelAppointment',
    ]);
  });
});
