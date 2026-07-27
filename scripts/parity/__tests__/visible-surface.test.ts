import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { RECORDED_CASES } from '../fixtures/recorded';
import type { WireRecord } from '../types';
import {
  assertVisibleSurface,
  expectedProbeValue,
  normalizeVisibleProbeActual,
  parseVisibleInteger,
  VISIBLE_PROBES,
  visibleProbesFor,
} from '../visible-surface';
import type { Driver } from '../driver';

describe('visible-surface probe scoping', () => {
  test('settled holdem uses only the exact revision witness after auto-advance', async () => {
    const recorded = RECORDED_CASES[3]!;
    const root = {
      ...recorded.root,
      surface: 'holdem-tray-3d' as const,
      dealStep: 'showdown',
      phase: 'settled',
      correlation: { hand: 'cash-table:9', handNumber: 9 },
    };
    const snapshot = {
      endedAt: 'showdown',
      pots: [{
        amount: '40',
        awards: [{ seatIndex: 4, amount: '40' }],
      }],
      seats: [{ seatIndex: 4, endStack: '137', net: '37' }],
    };
    const driver = {
      evalJson: async <T>(js: string): Promise<T> => {
        if (js.includes('__CV_HOLDEM_SETTLEMENT_WITNESS')) {
          return {
            surface: root.surface,
            revision: root.renderRevision,
            correlationHand: root.correlation.hand,
            values: {
              'banner-text': 'Showdown',
              pot: 'Pot 40 vCLAW',
              'self-stack': 'Stack 137 vCLAW',
              'on-felt': true,
            },
          } as T;
        }
        throw new Error('current DOM must not be probed after the pinned witness');
      },
    } as Driver;
    expect(await assertVisibleSurface(
      driver,
      'holdem',
      root,
      recorded.records[0]!,
      snapshot,
      [{
        ...recorded.records[0]!,
        responseBody: {
          view: {
            handNumber: root.correlation.handNumber,
            seatIndex: 4,
          },
        },
      }],
    )).toEqual({
      'banner-text': { expected: 'Showdown', actual: 'Showdown', pass: true },
      pot: { expected: 40, actual: 40, pass: true },
      'self-stack': { expected: 137, actual: 137, pass: true },
      'on-felt': { expected: true, actual: true, pass: true },
    });
  });

  test('felt settlement witness may trail cards only at correlated terminal idle', () => {
    const source = readFileSync(
      new URL('../visible-surface.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('const correlatedFeltTerminal = Boolean(');
    expect(source).toContain(`rootEntry?.dealStep === 'showdown'`);
    expect(source).toContain(`witnessEntry?.dealStep === 'showdown'`);
    expect(source).toContain(`witnessEntry?.transition === 'idle'`);
    expect(source).toContain(
      'if (!exactRevision && !correlatedFeltTerminal) return null;',
    );
  });

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
