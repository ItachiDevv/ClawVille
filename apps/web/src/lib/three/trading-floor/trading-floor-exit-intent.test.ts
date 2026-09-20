import { afterEach, describe, expect, test } from 'bun:test';
import {
  onTradingFloorExitRequest,
  requestTradingFloorExit,
  resetTradingFloorExitListenersForTests,
  tradingFloorExitListenerCount,
} from './trading-floor-exit-intent';

afterEach(() => {
  resetTradingFloorExitListenersForTests();
});

describe('Trading Floor exit intent', () => {
  test('delivers to the mounted page listener', () => {
    let calls = 0;
    onTradingFloorExitRequest(() => {
      calls += 1;
    });
    requestTradingFloorExit();
    expect(calls).toBe(1);
  });

  test('is a no-op with nothing mounted — the 3D side never throws', () => {
    expect(() => requestTradingFloorExit()).not.toThrow();
  });

  test('unsubscribes cleanly, so a stale route cannot navigate', () => {
    let calls = 0;
    const unsubscribe = onTradingFloorExitRequest(() => {
      calls += 1;
    });
    unsubscribe();
    requestTradingFloorExit();
    expect(calls).toBe(0);
    expect(tradingFloorExitListenerCount()).toBe(0);
  });

  test('a listener that unsubscribes itself mid-dispatch does not corrupt the set', () => {
    const seen: string[] = [];
    const unsubscribeFirst = onTradingFloorExitRequest(() => {
      seen.push('first');
      unsubscribeFirst();
    });
    onTradingFloorExitRequest(() => {
      seen.push('second');
    });
    expect(() => requestTradingFloorExit()).not.toThrow();
    expect(seen).toEqual(['first', 'second']);
    expect(tradingFloorExitListenerCount()).toBe(1);
  });
});
