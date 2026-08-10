import { describe, expect, test } from 'bun:test';
import { routeForScenario } from '../scenario-route';

describe('parity scenario routing', () => {
  test('routes shipping 2D surfaces through their cove deep links', () => {
    expect(routeForScenario({
      game: 'blackjack',
      surface: 'blackjack-2d',
    }, null)).toBe('/cove?table=blackjack');
    expect(routeForScenario({
      game: 'baccarat',
      surface: 'baccarat-2d',
    }, null)).toBe('/cove?table=baccarat');
  });

  test('leaves 3D and Holdem routes unchanged', () => {
    expect(routeForScenario({
      game: 'blackjack',
      surface: 'blackjack-3d',
    }, null)).toBe('/cove/blackjack');
    expect(routeForScenario({
      game: 'baccarat',
      surface: 'baccarat-3d',
    }, null)).toBe('/cove/baccarat');
    expect(routeForScenario({
      game: 'holdem',
      surface: 'holdem-tray-3d',
    }, 'table/id')).toBe('/cove/table?tableId=table%2Fid');
  });
});
