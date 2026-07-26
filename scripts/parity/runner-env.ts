import type { ScenarioDefinition } from './types';

export function requiresFixtureOwnerPreflight(
  scenario: Pick<ScenarioDefinition, 'fixtureName'>,
): boolean {
  return typeof scenario.fixtureName === 'string'
    && scenario.fixtureName.length > 0;
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
