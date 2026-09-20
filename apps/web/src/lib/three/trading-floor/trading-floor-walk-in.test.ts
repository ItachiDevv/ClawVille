import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

/**
 * The walk-in poll runs on rAF. Capture the callbacks instead of running them
 * so each test drives the poll by hand.
 *
 * Installed with `defineProperty`, not assignment: whichever earlier test file
 * installs a jsdom global leaves `requestAnimationFrame` as a non-writable
 * accessor, and a plain assignment throws in the full-suite run while passing
 * when this file is run alone.
 */
const scheduled: Array<() => void> = [];
const originalRafDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  'requestAnimationFrame',
);

function installRafStub(): void {
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: () => void): number => {
      scheduled.push(callback);
      return scheduled.length;
    },
  });
}

function restoreRaf(): void {
  if (originalRafDescriptor) {
    Object.defineProperty(
      globalThis,
      'requestAnimationFrame',
      originalRafDescriptor,
    );
  } else {
    Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
}

/**
 * The poll abandons itself when the route leaves /game. Pin the pathname so
 * this file does not depend on whatever `window` an earlier test file left
 * behind — without this, a jsdom parked on "/" would cancel every walk-in and
 * the failure would read as a product bug.
 */
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  'window',
);

function setPathname(pathname: string): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { location: { pathname }, dispatchEvent: () => true },
  });
}

function restoreWindow(): void {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
}

const { avatarPositionRef, useGameStore } = await import('@/stores/game');
const {
  installWorldStageNavigationHandler,
  resetWorldStageNavigationForTests,
} = await import('@/components/three/world-stage/stage-navigation');
const {
  readVenueWalkInPendingForTests,
  resetVenueWalkInPendingForTests,
  triggerCoveWalkIn,
  triggerTradingFloorWalkIn,
} = await import('../arena-buildings');
const { TRADING_FLOOR_DOOR_PX } = await import('./trading-floor-location');

function drainScheduled(): void {
  const pending = scheduled.splice(0, scheduled.length);
  for (const callback of pending) callback();
}

let navigated: string[] = [];
let uninstall: (() => void) | null = null;

beforeEach(() => {
  installRafStub();
  setPathname('/game');
  scheduled.length = 0;
  navigated = [];
  resetVenueWalkInPendingForTests();
  resetWorldStageNavigationForTests();
  uninstall = installWorldStageNavigationHandler((request) => {
    navigated.push(request.to);
    return true;
  });
  useGameStore.setState({ controlMode: 'player' });
  useGameStore.getState().clearClickPath();
  // Start far from the door so the first poll does NOT satisfy arrival.
  avatarPositionRef.x = TRADING_FLOOR_DOOR_PX.x;
  avatarPositionRef.y = TRADING_FLOOR_DOOR_PX.y - 4_000;
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  resetVenueWalkInPendingForTests();
  resetWorldStageNavigationForTests();
  useGameStore.getState().clearClickPath();
  restoreRaf();
  restoreWindow();
});

describe('Trading Floor walk-in', () => {
  test('sets a two-waypoint click path ending at the door', () => {
    triggerTradingFloorWalkIn();
    const path = useGameStore.getState().clickPath;
    expect(path).not.toBeNull();
    expect(path).toHaveLength(2);
    expect(path![1]).toEqual({
      x: TRADING_FLOOR_DOOR_PX.x,
      y: TRADING_FLOOR_DOOR_PX.y,
    });
  });

  test('marks the walk-in pending until it resolves', () => {
    triggerTradingFloorWalkIn();
    expect(readVenueWalkInPendingForTests().tradingFloor).toBe(true);
  });

  // Double-click, the click/pill race, and a fast-travel arrival all land here.
  test('is idempotent while a walk-in is already in flight', () => {
    triggerTradingFloorWalkIn();
    const afterFirst = scheduled.length;
    triggerTradingFloorWalkIn();
    triggerTradingFloorWalkIn();
    expect(scheduled.length).toBe(afterFirst);
    expect(navigated).toEqual([]);
  });

  test('crosses to /trading-floor once the avatar reaches the door', () => {
    triggerTradingFloorWalkIn();
    avatarPositionRef.x = TRADING_FLOOR_DOOR_PX.x;
    avatarPositionRef.y = TRADING_FLOOR_DOOR_PX.y;
    drainScheduled();
    expect(navigated).toEqual(['/trading-floor']);
    expect(readVenueWalkInPendingForTests().tradingFloor).toBe(false);
    expect(useGameStore.getState().clickPath).toBeNull();
  });

  test('re-arms after the crossing, so the venue is re-enterable', () => {
    triggerTradingFloorWalkIn();
    avatarPositionRef.x = TRADING_FLOOR_DOOR_PX.x;
    avatarPositionRef.y = TRADING_FLOOR_DOOR_PX.y;
    drainScheduled();
    navigated = [];
    triggerTradingFloorWalkIn();
    expect(readVenueWalkInPendingForTests().tradingFloor).toBe(true);
  });

  test('explore mode crosses immediately — there is no avatar to walk', () => {
    useGameStore.setState({ controlMode: 'explore' });
    triggerTradingFloorWalkIn();
    expect(navigated).toEqual(['/trading-floor']);
    expect(scheduled).toHaveLength(0);
  });

  // The two venues share the walk-in helper; they must NOT share the guard.
  test('a pending cove walk-in does not block the Trading Floor', () => {
    triggerCoveWalkIn();
    expect(readVenueWalkInPendingForTests().cove).toBe(true);
    triggerTradingFloorWalkIn();
    expect(readVenueWalkInPendingForTests().tradingFloor).toBe(true);
  });

  // Codex adversarial finding 2026-09-19. Per-venue guards alone let BOTH
  // polls run; whichever fired first cleared the click path and navigated, so
  // the player's later choice lost.
  test('the newest venue wins: a superseded cove poll never navigates', () => {
    triggerCoveWalkIn();
    triggerTradingFloorWalkIn();
    // The cove is released the moment the Trading Floor supersedes it.
    expect(readVenueWalkInPendingForTests().cove).toBe(false);
    expect(readVenueWalkInPendingForTests().tradingFloor).toBe(true);

    // Put the avatar on the Trading Floor door and run BOTH polls. The cove
    // poll is first in the queue and its own arrival test would pass too.
    avatarPositionRef.x = TRADING_FLOOR_DOOR_PX.x;
    avatarPositionRef.y = TRADING_FLOOR_DOOR_PX.y;
    drainScheduled();

    expect(navigated).toEqual(['/trading-floor']);
    expect(navigated).not.toContain('/cove');
  });

  test('a superseded poll leaves the new click path alone', () => {
    triggerCoveWalkIn();
    triggerTradingFloorWalkIn();
    const pathAfterStart = useGameStore.getState().clickPath;
    expect(pathAfterStart![1]).toEqual({
      x: TRADING_FLOOR_DOOR_PX.x,
      y: TRADING_FLOOR_DOOR_PX.y,
    });
    // Run ONLY the stale cove poll — it must not clear the path it never set.
    const stale = scheduled.shift()!;
    stale();
    expect(useGameStore.getState().clickPath).toBe(pathAfterStart);
    expect(navigated).toEqual([]);
  });

  test('dropping into explore mode abandons the poll instead of navigating', () => {
    triggerTradingFloorWalkIn();
    useGameStore.setState({ controlMode: 'explore' });
    avatarPositionRef.x = TRADING_FLOOR_DOOR_PX.x;
    avatarPositionRef.y = TRADING_FLOOR_DOOR_PX.y;
    drainScheduled();
    expect(navigated).toEqual([]);
    expect(readVenueWalkInPendingForTests().tradingFloor).toBe(false);
    expect(useGameStore.getState().clickPath).toBeNull();
  });

  test('leaving /game abandons the poll instead of navigating', () => {
    triggerTradingFloorWalkIn();
    setPathname('/cove');
    avatarPositionRef.x = TRADING_FLOOR_DOOR_PX.x;
    avatarPositionRef.y = TRADING_FLOOR_DOOR_PX.y;
    drainScheduled();
    expect(navigated).toEqual([]);
    expect(readVenueWalkInPendingForTests().tradingFloor).toBe(false);
  });

  test('the cove still walks to the cove', () => {
    triggerCoveWalkIn();
    const path = useGameStore.getState().clickPath;
    expect(path).toHaveLength(2);
    expect(path![1]).not.toEqual({
      x: TRADING_FLOOR_DOOR_PX.x,
      y: TRADING_FLOOR_DOOR_PX.y,
    });
  });
});
