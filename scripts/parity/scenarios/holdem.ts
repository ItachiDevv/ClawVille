import type {
  ScenarioDefinition,
  Surface,
} from '../types';
import { driveScenario, reachedFor, teardownFor } from './runtime';

function scenario(
  row: string,
  tier: 'guest' | 'live',
  surface: Surface,
  name: string,
  phases: readonly string[],
  fixtureName?: string,
): ScenarioDefinition {
  return {
    id: `${row.toLowerCase()}.holdem.${tier}.${surface}`,
    row,
    game: 'holdem',
    tier,
    surface,
    name,
    required: true,
    phases,
    ...(fixtureName ? { fixtureName } : {}),
    feltReplay: surface.includes('-felt-')
      ? 'rendered-state-only'
      : 'not-applicable',
    reachedPredicate: reachedFor('holdem', row, surface),
    run: (driver) => driveScenario('holdem', row, surface, phases, driver),
    teardown: teardownFor('holdem'),
  };
}

export const HOLDEM_SCENARIOS: readonly ScenarioDefinition[] = Object.freeze([
  scenario('H1', 'guest', 'holdem-tray-practice', 'hole dealt', ['hole']),
  scenario('H1', 'guest', 'holdem-felt-practice', 'opponents concealed at deal', ['hole']),
  scenario('H2', 'guest', 'holdem-tray-practice', 'flop (3)', ['hole', 'flop']),
  scenario('H3', 'guest', 'holdem-tray-practice', 'turn (4th card)', ['hole', 'flop', 'turn']),
  scenario('H4', 'guest', 'holdem-tray-practice', 'river (5th card)', ['hole', 'flop', 'turn', 'river']),
  scenario(
    'H5',
    'guest',
    'holdem-felt-practice',
    'showdown reveal and muck',
    ['showdown', 'muck-fading', 'idle'],
    'holdem-multiway-showdown',
  ),
  scenario(
    'H5',
    'guest',
    'holdem-tray-practice',
    'showdown outcome',
    ['showdown'],
    'holdem-multiway-showdown',
  ),
  scenario(
    'H6',
    'guest',
    'holdem-felt-practice',
    'fold-win muck',
    ['showdown', 'muck-fading', 'idle'],
    'holdem-fold-win',
  ),
  scenario(
    'H6',
    'guest',
    'holdem-tray-practice',
    'fold-win outcome and net',
    ['showdown'],
    'holdem-fold-win',
  ),
  scenario('H7', 'guest', 'holdem-tray-practice', 'pot and blinds', ['hole']),
  scenario('H8', 'live', 'holdem-tray-3d', 'cash own hole cards', ['hole']),
  scenario('H8', 'live', 'holdem-felt-3d', 'cash opponents concealed', ['hole']),
  scenario(
    'H9',
    'live',
    'holdem-tray-3d',
    'cash ordered streets',
    ['hole', 'flop', 'turn', 'river'],
  ),
  scenario(
    'H10',
    'live',
    'holdem-tray-3d',
    'cash settlement and BA-1 metadata',
    ['showdown'],
    'holdem-multiway-showdown',
  ),
  scenario(
    'H10',
    'live',
    'holdem-felt-3d',
    'cash terminal public entitlement',
    ['showdown'],
    'holdem-multiway-showdown',
  ),
  scenario('H-neg', 'guest', 'holdem-felt-practice', 'opponent non-leak', ['every-step']),
  scenario('H-neg', 'guest', 'holdem-tray-practice', 'private tray non-leak', ['every-step']),
  scenario('H-neg', 'live', 'holdem-felt-3d', 'cash opponent non-leak', ['every-step']),
  scenario('H-neg', 'live', 'holdem-tray-3d', 'cash private tray non-leak', ['every-step']),
]);
