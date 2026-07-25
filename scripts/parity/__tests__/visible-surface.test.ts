import { describe, expect, test } from 'bun:test';
import { RECORDED_CASES } from '../fixtures/recorded';
import type { WireRecord } from '../types';
import {
  expectedProbeValue,
  normalizeVisibleProbeActual,
  parseVisibleInteger,
  VISIBLE_PROBES,
  visibleProbesFor,
} from '../visible-surface';

describe('visible-surface probe scoping', () => {
  test('split active probes do not run for a single blackjack hand', () => {
    const recorded = RECORDED_CASES[0]!;
    expect(visibleProbesFor(
      'blackjack',
      recorded.root,
      recorded.records[0]!,
    ).map((probe) => probe.name)).not.toContain('subhand-1');
    const split = structuredClone(recorded.records[0]!);
    split.responseBody = {
      outcome: {
        playerHands: [{ cards: [] }, { cards: [] }],
      },
    };
    expect(visibleProbesFor(
      'blackjack',
      recorded.root,
      split,
    ).map((probe) => probe.name)).toEqual(
      expect.arrayContaining(['subhand-0', 'subhand-1']),
    );
  });

  test('cash self stack resolves requester seat endStack from BA-1', () => {
    const recorded = RECORDED_CASES[3]!;
    const root = {
      ...recorded.root,
      surface: 'holdem-tray-3d' as const,
      correlation: { hand: 'cash-table:9', handNumber: 9 },
    };
    const privateView: WireRecord = {
      ...recorded.records[0]!,
      seq: 91,
      handNumber: 9,
      responseBody: {
        view: {
          handNumber: 9,
          seatIndex: 4,
          chipStack: 1,
        },
      },
    };
    const probe = VISIBLE_PROBES.holdem.find(
      (candidate) => candidate.name === 'self-stack',
    )!;
    expect(expectedProbeValue(
      probe,
      'holdem',
      root,
      recorded.records[0]!,
      {
        seats: [
          { seatIndex: 2, endStack: '200' },
          { seatIndex: 4, endStack: '137' },
        ],
      },
      [privateView],
    )).toBe(137);
  });

  test('baccarat probes separate the bet label, odds, and vCLAW stake', () => {
    for (const [bet, label] of [
      ['player', 'Player · 1:1 · 25 vCLAW'],
      ['banker', 'Banker · 0.95:1 · 25 vCLAW'],
      ['tie', 'Tie · 8:1 · 25 vCLAW'],
    ] as const) {
      expect(parseVisibleInteger('stake', label)).toBe(25);
      expect(normalizeVisibleProbeActual('bet-zone', label)).toBe(bet);
    }
  });
});
