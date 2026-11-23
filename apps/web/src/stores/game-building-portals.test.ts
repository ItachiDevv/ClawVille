import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getLiveActivitiesForBuilding } from '@clawville/shared';
import { useGameStore } from './game';

const initial = useGameStore.getState();
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    },
  });
});
afterEach(() => {
  useGameStore.setState(initial, true);
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('building portal destinations', () => {
  test('Office opens its portal without a live activity in either control mode', () => {
    expect(getLiveActivitiesForBuilding('api-integrations')).toEqual([]);
    for (const controlMode of ['explore', 'player'] as const) {
      useGameStore.setState({ ...initial, controlMode });
      useGameStore.getState().enterBuilding('api-integrations');
      expect(useGameStore.getState().currentPortalBuildingId).toBe('api-integrations');
      expect(useGameStore.getState().chatOpen).toBe(false);
      expect(useGameStore.getState().movementFrozen).toBe(true);
    }
  });

  test('Boating School offers both games with distinct lobby destinations', () => {
    const games = getLiveActivitiesForBuilding('app-publishing');
    expect(games.map((game) => game.id)).toEqual(['bumper-shells', 'reef-race']);
    for (const game of games) {
      expect(game.skillBuildingMatches).toEqual(['app-publishing']);
      useGameStore.getState().enterBuilding('app-publishing');
      expect(useGameStore.getState().currentPortalBuildingId).toBe('app-publishing');
      useGameStore.getState().openActivityLobby(game.id);
      expect(useGameStore.getState().activityLobbyId).toBe(game.id);
      expect(useGameStore.getState().currentPortalBuildingId).toBeNull();
    }
  });
});
