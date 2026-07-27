import type { ScenarioDefinition, Surface } from '../types';
import { driveScenario, reachedFor, teardownFor } from './runtime';

const MISSING_2D_PUBLISHER =
  'missing blackjack-2d parity publisher/root on current HEAD';

function scenario(
  row: string,
  tier: 'guest' | 'live',
  surface: Surface,
  name: string,
  phases: readonly string[],
  fixtureName?: string,
): ScenarioDefinition {
  return {
    id: `${row.toLowerCase()}.blackjack.${tier}.${surface}`,
    row,
    game: 'blackjack',
    tier,
    surface,
    name,
    required: true,
    phases,
    ...(fixtureName ? { fixtureName } : {}),
    ...(surface === 'blackjack-2d'
      ? { blockedReason: MISSING_2D_PUBLISHER }
      : {}),
    feltReplay: 'not-applicable',
    reachedPredicate: reachedFor('blackjack', row),
    run: (driver) => driveScenario('blackjack', row, surface, phases, driver),
    teardown: teardownFor('blackjack'),
  };
}

const BOTH_SURFACES = ['blackjack-2d', 'blackjack-3d'] as const;
const rows: ScenarioDefinition[] = [];

for (const tier of ['guest', 'live'] as const) {
  for (const surface of BOTH_SURFACES) {
    rows.push(scenario(
      'B1',
      tier,
      surface,
      '2+2 dealer hole down',
      ['hole'],
    ));
  }
}
for (const surface of BOTH_SURFACES) {
  rows.push(scenario('B2', 'guest', surface, 'hit order', ['hole', 'player-turn']));
  rows.push(scenario('B3', 'guest', surface, 'double', ['hole', 'player-turn', 'settled']));
  rows.push(scenario('B4', 'live', surface, 'dealer reveal and draw', ['dealer-reveal', 'settled']));
  rows.push(scenario('B5', 'live', surface, 'bust', ['player-turn', 'settled']));
  rows.push(scenario('B6', 'live', surface, 'natural', ['hole', 'settled'], 'bj-natural'));
  rows.push(scenario('B7', 'live', surface, 'push', ['hole', 'dealer-reveal', 'settled'], 'bj-push'));
  rows.push(scenario('B8', 'live', surface, 'split', ['hole', 'player-turn', 'split', 'player-turn', 'dealer-reveal', 'settled'], 'bj-split'));
}
rows.push(scenario(
  'B9',
  'live',
  'blackjack-2d',
  'insurance',
  ['hole', 'player-turn', 'settled'],
  'bj-insurance',
));
for (const tier of ['guest', 'live'] as const) {
  for (const surface of BOTH_SURFACES) {
    rows.push(scenario(
      'B-neg',
      tier,
      surface,
      'dealer hole non-leak',
      ['every-in-progress-read'],
    ));
  }
}

export const BLACKJACK_SCENARIOS: readonly ScenarioDefinition[] =
  Object.freeze(rows);
