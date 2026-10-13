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

describe('buildTransientAssistant golden-parity overrides', () => {
  const GOLDEN_VOICE = {
    provider: '11labs',
    voiceId: 'cgSgspJ2msm6clMCkdW9',
    model: 'eleven_turbo_v2_5',
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0.3,
    useSpeakerBoost: true,
    optimizeStreamingLatency: 2,
  };

  it('pins every golden field onto the built assistant', () => {
    const assistant = buildTransientAssistant(tenant, settings(), 'phone', new Date(), {
      systemPromptOverride: 'You are Maya.',
      voice: GOLDEN_VOICE,
      backgroundSound: 'office',
      temperature: 0.55,
      transcriberModel: 'nova-3',
      transcriberEndpointing: 500,
      startSpeakingPlan: { waitSeconds: 0.3, smartEndpointingEnabled: true },
      stopSpeakingPlan: { numWords: 3, voiceSeconds: 0.3, backoffSeconds: 0.7 },
      silenceTimeoutSeconds: 30,
    });
    expect(assistant.voice).toEqual(GOLDEN_VOICE);
    expect(assistant.model.provider).toBe('openai');
    expect(assistant.model.model).toBe('gpt-4o');
    expect(assistant.model.temperature).toBe(0.55);
    expect(assistant.transcriber.provider).toBe('deepgram');
    expect(assistant.transcriber.model).toBe('nova-3');
    expect(assistant.transcriber.language).toBe('en');
    expect(assistant.transcriber.endpointing).toBe(500);
    expect(assistant.startSpeakingPlan).toEqual({ waitSeconds: 0.3, smartEndpointingEnabled: true });
    expect(assistant.stopSpeakingPlan).toEqual({ numWords: 3, voiceSeconds: 0.3, backoffSeconds: 0.7 });
    expect(assistant.silenceTimeoutSeconds).toBe(30);
    expect(assistant.backchannelingEnabled).toBe(true);
    expect(assistant.backgroundSound).toBe('office');
    expect(assistant.firstMessageMode).toBe('assistant-speaks-first');
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
});
