import { describe, it, expect } from 'vitest';
import { matchByName } from './providers.service';

describe('matchByName', () => {
  const providers = [
    { id: 'p1', name: 'Dr. Sarah Smith' },
    { id: 'p2', name: 'Dr. James Lee' },
    { id: 'p3', name: 'Priya Patel' },
  ];

  it('matches a last name spoken with a title', () => {
    expect(matchByName(providers, 'Dr. Smith')?.id).toBe('p1');
    expect(matchByName(providers, 'smith')?.id).toBe('p1');
  });

  it('is case- and punctuation-tolerant on full names', () => {
    expect(matchByName(providers, 'james lee')?.id).toBe('p2');
    expect(matchByName(providers, 'PRIYA')?.id).toBe('p3');
  });

  it('returns null when nothing plausibly matches', () => {
    expect(matchByName(providers, 'Dr. Nobody')).toBeNull();
    expect(matchByName(providers, '')).toBeNull();
  });
});
