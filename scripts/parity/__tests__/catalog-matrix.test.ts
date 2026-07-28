import { describe, expect, test } from 'bun:test';
import { emitMatrix } from '../matrix';
import {
  FIXTURE_SCENARIO_CATALOG,
  SCENARIO_CATALOG,
} from '../scenarios';

describe('scenario × tier × surface matrix', () => {
  test('expands every frozen row with only baccarat 2D still blocked', () => {
    expect(SCENARIO_CATALOG).toHaveLength(58);
    const ids = new Set(SCENARIO_CATALOG.map((scenario) => scenario.id));
    expect(ids.size).toBe(SCENARIO_CATALOG.length);
    const matrix = emitMatrix(SCENARIO_CATALOG);
    expect(matrix.pass).toBe(false);
    expect(matrix.counts).toEqual({
      PASS: 0,
      FAIL: 0,
      UNPROVEN: 50,
      BLOCKED: 8,
    });
    expect(matrix.markdown).toContain('Gate verdict: **FAIL**');
    expect(matrix.markdown).toContain('ordered street replay is tray-only');
    expect(SCENARIO_CATALOG.filter((scenario) => scenario.blockedReason))
      .toHaveLength(8);
    expect(SCENARIO_CATALOG.filter((scenario) => scenario.blockedReason)
      .every((scenario) => scenario.surface === 'baccarat-2d')).toBe(true);
  });

  test('contains all thirteen frozen BA-2 fixture names', () => {
    expect(FIXTURE_SCENARIO_CATALOG).toEqual([
      'bj-split',
      'bj-natural',
      'bj-push',
      'bj-insurance',
      'bac-player-natural',
      'bac-banker-natural',
      'bac-player-third',
      'bac-banker-third',
      'bac-tie',
      'bac-shoe-near-threshold',
      'bac-shoe-exhausted',
      'holdem-multiway-showdown',
      'holdem-fold-win',
    ]);
  });
});
