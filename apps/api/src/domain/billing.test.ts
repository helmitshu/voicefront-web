import { describe, it, expect } from 'vitest';
import { dollarsToCents, applyMarkup } from './billing';

describe('dollarsToCents', () => {
  it('converts dollars to integer cents', () => {
    expect(dollarsToCents(0.1)).toBe(10);
    expect(dollarsToCents(2.5)).toBe(250);
    expect(dollarsToCents(0)).toBe(0);
  });

  it('rounds sub-cent fractions', () => {
    expect(dollarsToCents(0.001)).toBe(0); // 0.1c rounds down
    expect(dollarsToCents(0.126)).toBe(13); // 12.6c rounds up
  });

  it('clamps invalid input to 0', () => {
    expect(dollarsToCents(-5)).toBe(0);
    expect(dollarsToCents(Number.NaN)).toBe(0);
    expect(dollarsToCents(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('applyMarkup', () => {
  it('applies a basis-point markup', () => {
    expect(applyMarkup(100, 5000)).toBe(150); // +50%
    expect(applyMarkup(100, 0)).toBe(100); // no markup
    expect(applyMarkup(200, 2500)).toBe(250); // +25%
  });

  it('rounds to the nearest cent', () => {
    expect(applyMarkup(101, 5000)).toBe(152); // 151.5 -> 152
  });

  it('treats invalid/negative markup as zero', () => {
    expect(applyMarkup(100, -10)).toBe(100);
    expect(applyMarkup(100, Number.NaN)).toBe(100);
  });
});
