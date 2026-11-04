import { describe, expect, it } from 'bun:test';
import { centsToUsdText, parseUsdToCents } from './usd-cents';

describe('parseUsdToCents', () => {
  it('reads empty text as not set', () => {
    expect(parseUsdToCents('  ', 100_000)).toEqual({ ok: true, cents: null });
  });

  it('converts dollars without float math', () => {
    expect(parseUsdToCents('2', 100_000)).toEqual({ ok: true, cents: 200 });
    expect(parseUsdToCents('0.5', 100_000)).toEqual({ ok: true, cents: 50 });
    expect(parseUsdToCents('$0.05', 100_000)).toEqual({ ok: true, cents: 5 });
    expect(parseUsdToCents('19.99', 100_000)).toEqual({ ok: true, cents: 1999 });
    expect(parseUsdToCents('0', 100_000)).toEqual({ ok: true, cents: 0 });
  });

  it('refuses bad text and amounts above the limit', () => {
    for (const text of ['-1', '1.234', 'abc', '1e3', '1,000']) {
      expect(parseUsdToCents(text, 100_000).ok).toBe(false);
    }
    expect(parseUsdToCents('1000.01', 100_000).ok).toBe(false);
    expect(parseUsdToCents('1000', 100_000)).toEqual({ ok: true, cents: 100_000 });
  });
});

describe('centsToUsdText', () => {
  it('round-trips cents to dollar text', () => {
    expect(centsToUsdText(null)).toBe('');
    expect(centsToUsdText(5)).toBe('0.05');
    expect(centsToUsdText(1999)).toBe('19.99');
    expect(parseUsdToCents(centsToUsdText(1234), 100_000)).toEqual({ ok: true, cents: 1234 });
  });
});
