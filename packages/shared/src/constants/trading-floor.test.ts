import { describe, expect, test } from 'bun:test';
import { resolveTradeOperator } from './trading-floor';

describe('resolveTradeOperator', () => {
  test.each([
    { operatedByClawville: true, source: 'clawpump', expected: 'clawville' },
    { operatedByClawville: false, source: 'clawpump', expected: 'clawpump' },
    { operatedByClawville: false, source: 'signed', expected: null },
    { operatedByClawville: false, source: null, expected: null },
  ] as const)('resolves $expected for operatedByClawville=$operatedByClawville and source=$source', ({ expected, ...input }) => {
    expect(resolveTradeOperator(input)).toBe(expected);
  });
});
