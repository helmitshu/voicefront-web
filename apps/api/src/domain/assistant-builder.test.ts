import { describe, it, expect } from 'vitest';
import type { AgentSettings, Tenant } from '@prisma/client';
import { buildAssistantUpdatePayload } from './assistant-builder';
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
