import { describe, expect, test } from 'bun:test';
import { BRAINCHAIN_OFFICE_DOOR_APPROACH_GAME as center } from '@clawville/shared';
import { agentAutonomyDriver, centerPlaceDestinationForMove } from '../agent-autonomy-driver';

describe('Office center-place arrival', () => {
  test('tracks only a successful exact shared-center move', () => {
    const action = { verb: 'move', params: { x: String(center.x), y: String(center.y) } };
    expect(centerPlaceDestinationForMove(action, center)).toBe('brainchain-office');
    expect(centerPlaceDestinationForMove(action, undefined)).toBeNull();
    expect(centerPlaceDestinationForMove(action, { x: center.x + 20, y: center.y })).toBeNull();
    expect(centerPlaceDestinationForMove({ verb: 'emote', params: action.params }, center)).toBeNull();
    expect(centerPlaceDestinationForMove({ verb: 'move', params: { x: 'NaN', y: String(center.y) } }, center)).toBeNull();
  });

  test('arrives within 96 wu without using the teaching-building radius', () => {
    const driver = agentAutonomyDriver as unknown as {
      hasArrived: (perception: unknown, entry: unknown) => boolean;
    };
    const entry = { targetBuildingId: 'brainchain-office' };
    const perception = (distance: number) => ({ nearbyBuildings: [], places: [{ destinationId: 'brainchain-office', distance }] });
    expect(driver.hasArrived(perception(96), entry)).toBe(true);
    expect(driver.hasArrived(perception(97), entry)).toBe(false);
    expect(driver.hasArrived(perception(900), entry)).toBe(false);
    expect(driver.hasArrived({ nearbyBuildings: [], places: [] }, entry)).toBe(false);
  });

  test('a place arrival never invokes teaching-building settlement', async () => {
    const driver = agentAutonomyDriver as unknown as {
      stepWalkingPhase: (entry: unknown, perception: unknown, now: number) => Promise<void>;
      recordDriverAction: (...args: unknown[]) => Promise<unknown>;
      arrivalSettle: (...args: unknown[]) => Promise<unknown>;
    };
    const record = driver.recordDriverAction;
    const settle = driver.arrivalSettle;
    let settlements = 0;
    driver.recordDriverAction = async () => null;
    driver.arrivalSettle = async () => { settlements++; return null; };
    const entry = { targetBuildingId: 'brainchain-office', phase: 'walking', recentThoughts: [], talkPrefetch: null };
    try {
      await driver.stepWalkingPhase(entry, { nearbyBuildings: [], places: [{ destinationId: 'brainchain-office', distance: 0 }] }, Date.now());
      expect(entry.phase).toBe('talking');
      expect(settlements).toBe(0);
    } finally {
      driver.recordDriverAction = record;
      driver.arrivalSettle = settle;
    }
  });
});
