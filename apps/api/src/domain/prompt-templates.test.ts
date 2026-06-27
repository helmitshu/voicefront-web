import { describe, it, expect } from 'vitest';
import { providerDiscipline, composeSystemPrompt } from './prompt-templates';
import { defaultBusinessHours } from './agent-config';

describe('providerDiscipline', () => {
  const providers = [
    { name: 'Sarah Smith', title: 'Dr.' },
    { name: 'James Lee', title: 'Dr.' },
  ];
  const services = [{ name: 'Cleaning', durationMinutes: 45 }];

  it('lists the providers and services with durations', () => {
    const text = providerDiscipline(providers, services, false);
    expect(text).toContain('Dr. Sarah Smith');
    expect(text).toContain('Dr. James Lee');
    expect(text).toContain('Cleaning (about 45 minutes)');
  });

  it('never asks which provider by default (first-available)', () => {
    expect(providerDiscipline(providers, services, false)).toMatch(/Do NOT ask which provider/);
  });

  it('offers the provider list when configured to', () => {
    expect(providerDiscipline(providers, services, true)).toMatch(/ask if they have a preference/);
  });
});

describe('composeSystemPrompt provider section', () => {
  const base = {
    companyName: 'Acme',
    basePrompt: 'You are a receptionist.',
    businessHours: defaultBusinessHours(),
    timezone: 'America/New_York',
    openNow: true,
    voicemailGreeting: 'Leave a message.',
    forwardingNumbers: [],
  };

  it('includes the provider section with 2+ providers', () => {
    const prompt = composeSystemPrompt({ ...base, providers: [{ name: 'A' }, { name: 'B' }] });
    expect(prompt).toContain('PROVIDERS & SERVICES');
  });

  it('omits it for a single provider (solo case)', () => {
    const prompt = composeSystemPrompt({ ...base, providers: [{ name: 'A' }] });
    expect(prompt).not.toContain('PROVIDERS & SERVICES');
  });

  it('omits it when no providers are configured', () => {
    expect(composeSystemPrompt(base)).not.toContain('PROVIDERS & SERVICES');
  });

  it('always scopes the agent to the business (off-topic guardrail)', () => {
    const prompt = composeSystemPrompt(base);
    expect(prompt).toContain('STAYING ON TOPIC');
    // Redirect copy is personalized to the company so it sounds natural.
    expect(prompt).toContain('Acme');
    // Resists prompt-injection / role changes.
    expect(prompt).toContain('ignore previous instructions');
  });
});
