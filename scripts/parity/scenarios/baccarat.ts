import type { ScenarioDefinition, Surface } from '../types';
import { driveScenario, reachedFor, teardownFor } from './runtime';

const MISSING_2D_PUBLISHER =
  'missing baccarat-2d parity publisher/root on current HEAD';

function scenario(
  row: string,
  tier: 'guest' | 'live',
  surface: Surface,
  name: string,
  phases: readonly string[],
  fixtureName?: string,
): ScenarioDefinition {
  return {
    id: `${row.toLowerCase()}.baccarat.${tier}.${surface}`,
    row,
    game: 'baccarat',
    tier,
    surface,
    name,
    required: true,
    phases,
    ...(fixtureName ? { fixtureName } : {}),
    ...(row === 'C6' && tier === 'guest'
      ? { requiresGuestShoeReset: true as const }
      : {}),
    ...(surface === 'baccarat-2d'
      ? { blockedReason: MISSING_2D_PUBLISHER }
      : {}),
    feltReplay: 'not-applicable',
    reachedPredicate: reachedFor('baccarat', row),
    run: (driver) => driveScenario('baccarat', row, surface, phases, driver),
    teardown: teardownFor('baccarat', surface),
  };
}

const BOTH_SURFACES = ['baccarat-2d', 'baccarat-3d'] as const;
const rows: ScenarioDefinition[] = [];
for (const surface of BOTH_SURFACES) {
  rows.push(scenario('C1', 'guest', surface, 'player natural P2', ['player-1', 'banker-1', 'player-2', 'banker-2', 'settled'], 'bac-player-natural'));
  rows.push(scenario('C2', 'guest', surface, 'banker natural B2', ['player-1', 'banker-1', 'player-2', 'banker-2', 'settled'], 'bac-banker-natural'));
  rows.push(scenario('C3', 'live', surface, 'player third card', ['player-1', 'banker-1', 'player-2', 'banker-2', 'player-3', 'settled'], 'bac-player-third'));
  rows.push(scenario('C4', 'live', surface, 'banker third card', ['player-1', 'banker-1', 'player-2', 'banker-2', 'banker-3', 'settled'], 'bac-banker-third'));
  rows.push(scenario('C5', 'guest', surface, 'tie', ['player-1', 'banker-1', 'player-2', 'banker-2', 'settled'], 'bac-tie'));
  for (const tier of ['guest', 'live'] as const) {
    rows.push(scenario(
      'C6',
      tier,
      surface,
      'three bet zones',
      ['settled-player', 'settled-banker', 'settled-tie'],
    ));
  }
  rows.push(scenario('C7', 'live', surface, 'banker commission', ['settled'], 'bac-banker-natural'));
}

export const BACCARAT_SCENARIOS: readonly ScenarioDefinition[] =
  Object.freeze(rows);
