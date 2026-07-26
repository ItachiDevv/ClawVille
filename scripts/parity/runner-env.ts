import type { ScenarioDefinition } from './types';

export function requiresFixtureOwnerPreflight(
  scenario: Pick<ScenarioDefinition, 'fixtureName'>,
): boolean {
  return typeof scenario.fixtureName === 'string'
    && scenario.fixtureName.length > 0;
}

/**
 * Shoe/practice fixture deletion is the authoritative resource teardown and
 * must run while the page-local show-once credential still exists. Their
 * ordinary Walk Away flows replace the document and intentionally erase that
 * credential. Cash Hold'em is different: its normal leave/cash-out path must
 * settle the real ledger before the fixture run can be closed.
 */
export function fixtureTeardownRunsFirst(
  scenario: Pick<ScenarioDefinition, 'game' | 'tier' | 'fixtureName'>,
): boolean {
  return requiresFixtureOwnerPreflight(scenario)
    && !(scenario.game === 'holdem' && scenario.tier === 'live');
}

export function requiresGuestShoeReset(
  scenario: Pick<ScenarioDefinition, 'game' | 'tier' | 'fixtureName'>,
): boolean {
  return requiresFixtureOwnerPreflight(scenario)
    && scenario.tier === 'guest'
    && (scenario.game === 'blackjack' || scenario.game === 'baccarat');
}

export function resolveScenarioState(
  scenario: Pick<ScenarioDefinition, 'game' | 'tier' | 'fixtureName'>,
  env: NodeJS.ProcessEnv = process.env,
): { statePath: string | null; cashTableId: string | null } {
  const statePath = scenario.tier === 'live'
    ? env.CV_PARITY_AUTH_STATE ?? null
    : scenario.fixtureName
      ? env.CV_PARITY_GUEST_AUTH_STATE ?? null
      : null;
  if (scenario.tier === 'live' && !statePath) {
    throw new Error('live tier requires CV_PARITY_AUTH_STATE');
  }
  if (scenario.tier === 'guest' && scenario.fixtureName && !statePath) {
    throw new Error(
      'fixture-backed guest tier requires dedicated CV_PARITY_GUEST_AUTH_STATE',
    );
  }
  const cashTableId = scenario.game === 'holdem' && scenario.tier === 'live'
    ? env.CV_PARITY_CASH_TABLE_ID ?? null
    : null;
  if (scenario.game === 'holdem' && scenario.tier === 'live' && !cashTableId) {
    throw new Error('live holdem tier requires CV_PARITY_CASH_TABLE_ID');
  }
  return { statePath, cashTableId };
}
