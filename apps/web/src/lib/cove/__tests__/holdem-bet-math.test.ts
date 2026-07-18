/**
 * P3.1 — unit tests for the shared client bet-sizing math (Codex review
 * asked for focused coverage of the extracted helpers). Fixtures are
 * hand-computed from the No-Limit rules with HOLDEM_BIG_BLIND = 2; they do
 * NOT call the production code to generate expectations. All amounts are
 * TOTAL street commitments (matching the wire contract), and the server is
 * the final validator — these guard the CLIENT's offered options.
 */
import { describe, expect, test } from 'bun:test';
import { computeAllIn, computeRaiseOpen, computeRaisePresets } from '../holdem-bet-math';

const hand = (currentBet: string, humanCommitted: string, humanStack: string) => ({
  currentBet, humanCommitted, humanStack,
});

describe('computeRaiseOpen', () => {
  test('unopened pot → opening bet, min = committed + BB, max = full shove', () => {
    expect(computeRaiseOpen(hand('0', '0', '100')))
      .toEqual({ kind: 'slider', min: 2, max: 100, verb: 'bet' });
  });

  test('small blind facing the big blind → raise, min = currentBet + BB', () => {
    // SB committed 1, BB posted 2, stack 99 → shove ceiling 100, min raise-to 4.
    expect(computeRaiseOpen(hand('2', '1', '99')))
      .toEqual({ kind: 'slider', min: 4, max: 100, verb: 'raise' });
  });

  test('stack cannot out-bet the current bet → call only', () => {
    // Shove ceiling 0+30=30 ≤ bet 50: raising is impossible.
    expect(computeRaiseOpen(hand('50', '0', '30'))).toEqual({ kind: 'call' });
  });

  test('shove ceiling exactly equal to the current bet → call only', () => {
    expect(computeRaiseOpen(hand('30', '10', '20'))).toEqual({ kind: 'call' });
  });

  test('short all-in raise: min clamps down to the shove ceiling', () => {
    // Full min-raise would be 4+2=6 but ceiling is 0+5=5 > 4 → all-in raise-to 5.
    expect(computeRaiseOpen(hand('4', '0', '5')))
      .toEqual({ kind: 'slider', min: 5, max: 5, verb: 'raise' });
  });

  test('opening bet with prior commitment (BB checking option)', () => {
    // BB committed 2, checked around... currentBet 0 on a later street,
    // committed resets per street server-side; committed 0, stack 98.
    expect(computeRaiseOpen(hand('0', '0', '98')))
      .toEqual({ kind: 'slider', min: 2, max: 98, verb: 'bet' });
  });

  test('malformed wire strings degrade to 0, never NaN', () => {
    expect(computeRaiseOpen(hand('junk', 'junk', 'junk'))).toEqual({ kind: 'call' });
  });
});

describe('computeAllIn', () => {
  test('unopened pot → all-in is a BET of the full shove total', () => {
    expect(computeAllIn(hand('0', '0', '100'))).toEqual({ action: 'bet', amount: 100 });
  });

  test('facing a bet with a covering stack → all-in is a RAISE to the shove total', () => {
    expect(computeAllIn(hand('10', '2', '90'))).toEqual({ action: 'raise', amount: 92 });
  });

  test('shove that cannot exceed the current bet → all-in CALL', () => {
    expect(computeAllIn(hand('50', '5', '20'))).toEqual({ action: 'call' });
  });

  test('shove exactly equal to the current bet → all-in CALL, not a zero raise', () => {
    expect(computeAllIn(hand('25', '5', '20'))).toEqual({ action: 'call' });
  });
});

describe('computeRaisePresets', () => {
  test('builds total-commitment Min / 3BB / half-pot / pot sizes', () => {
    expect(computeRaisePresets({ min: 12, max: 100 }, '30', '2', '4')).toEqual([
      { label: 'Min', value: 12 },
      { label: '3BB', value: 12 },
      { label: '½ Pot', value: 19 },
      { label: 'Pot', value: 34 },
    ]);
  });

  test('clamps every preset to the legal slider window', () => {
    expect(computeRaisePresets({ min: 20, max: 25 }, '1000', '2', '0')).toEqual([
      { label: 'Min', value: 20 },
      { label: '3BB', value: 20 },
      { label: '½ Pot', value: 25 },
      { label: 'Pot', value: 25 },
    ]);
  });

  test('parses bigint pot strings without Number precision loss', () => {
    expect(computeRaisePresets(
      { min: 2, max: 500 },
      '900719925474099312345',
      '2',
      '0',
    )[3]).toEqual({ label: 'Pot', value: 500 });
  });
});
