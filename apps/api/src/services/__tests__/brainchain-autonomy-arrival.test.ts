import { describe, expect, test } from 'bun:test';
import { AUTONOMY_ENTERABLE_PLACES, BUILDING_INTERACTION_RADIUS, MAP_LOCATIONS } from '@clawville/shared';
import { agentAutonomyDriver, centerPlaceDestinationForMove, destinationArrivalRadius } from '../agent-autonomy-driver';

// 2026-11-10: the BrainChain Office REPLACED the Salty Spitoon. It is the
// `api-integrations` teaching building, reached through enter_building, so no
// separate move-center place or venue radius exists any more.
describe('BrainChain Office arrival', () => {
  test('the Office is the api-integrations teaching building, not a separate place', () => {
    expect(MAP_LOCATIONS.find((location) => location.id === 'api-integrations')?.name).toBe('BrainChain Office');
    expect(AUTONOMY_ENTERABLE_PLACES.some((place) => place.placeId === 'brainchain-office' || place.destinationId === 'brainchain-office')).toBe(false);
    expect(destinationArrivalRadius('api-integrations')).toBe(BUILDING_INTERACTION_RADIUS);
  });

  test('a move to the old venue coordinates tracks no place destination', () => {
    const old = { x: 12024, y: 8664 }; // WORLD_CENTER_PX + the removed venue approach (760, -2600)
    const action = { verb: 'move', params: { x: String(old.x), y: String(old.y) } };
    expect(centerPlaceDestinationForMove(action, old)).toBeNull();
  });

  test('a place arrival never invokes teaching-building settlement', async () => {
    const driver = agentAutonomyDriver as unknown as {
      stepWalkingPhase: (entry: unknown, perception: unknown, now: number) => Promise<void>;
      recordDriverAction: (...args: unknown[]) => Promise<unknown>;
      arrivalSettle: (...args: unknown[]) => Promise<unknown>;
    };
    const kelp = AUTONOMY_ENTERABLE_PLACES.find((place) => place.placeId === 'kelp-forest');
    expect(kelp).toBeDefined();
    const record = driver.recordDriverAction;
    const settle = driver.arrivalSettle;
    let settlements = 0;
    driver.recordDriverAction = async () => null;
    driver.arrivalSettle = async () => { settlements++; return null; };
    const entry = { targetBuildingId: kelp!.destinationId, phase: 'walking', recentThoughts: [], talkPrefetch: null };
    try {
      await driver.stepWalkingPhase(entry, { nearbyBuildings: [], places: [{ destinationId: kelp!.destinationId, distance: 0 }] }, Date.now());
      expect(entry.phase).toBe('talking');
      expect(settlements).toBe(0);
    } finally {
      driver.recordDriverAction = record;
      driver.arrivalSettle = settle;
    }
  });
});
