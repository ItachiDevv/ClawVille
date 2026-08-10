import { BACCARAT_SCENARIOS } from './baccarat';
import { BLACKJACK_SCENARIOS } from './blackjack';
import { HOLDEM_SCENARIOS } from './holdem';

export const SCENARIO_CATALOG = Object.freeze([
  ...HOLDEM_SCENARIOS,
  ...BLACKJACK_SCENARIOS,
  ...BACCARAT_SCENARIOS,
]);

/** Frozen BA-2 server scenario names, including the penetration smoke fixtures. */
export const FIXTURE_SCENARIO_CATALOG = Object.freeze([
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
] as const);

export type FixtureScenarioName =
  (typeof FIXTURE_SCENARIO_CATALOG)[number];
