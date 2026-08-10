import type { ScenarioDefinition } from './types';

export function routeForScenario(
  scenario: Pick<ScenarioDefinition, 'game' | 'surface'>,
  cashTableId: string | null,
): string {
  if (scenario.surface === 'blackjack-2d') {
    // apps/web/src/app/cove/page.tsx:142-150 emits the blackjack deep-link.
    return '/cove?table=blackjack';
  }
  if (scenario.surface === 'baccarat-2d') {
    // apps/web/src/app/cove/page.tsx:151-161 emits the baccarat deep-link.
    return '/cove?table=baccarat';
  }
  if (scenario.game === 'blackjack') return '/cove/blackjack';
  if (scenario.game === 'baccarat') return '/cove/baccarat';
  return `/cove/table${cashTableId
    ? `?tableId=${encodeURIComponent(cashTableId)}`
    : ''}`;
}
