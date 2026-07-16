import { describe, expect, test } from 'bun:test';
import {
  dampTowardConfirmedTarget,
  NPC_INTERP_DAMPING_STIFFNESS,
} from './npc-interpolation-damping';

function advanceFrames(
  current: number,
  target: number,
  deltaSeconds: number,
  frameCount: number,
): number {
  let value = current;
  for (let frame = 0; frame < frameCount; frame++) {
    value = dampTowardConfirmedTarget(value, target, deltaSeconds);
  }
  return value;
}

describe('confirmed NPC interpolation-target damping', () => {
  test('stays strictly between current and target without overshoot', () => {
    const forward = dampTowardConfirmedTarget(0, 100, 1 / 60);
    const backward = dampTowardConfirmedTarget(100, 0, 1 / 60);

    expect(NPC_INTERP_DAMPING_STIFFNESS).toBe(10);
    expect(forward).toBeGreaterThan(0);
    expect(forward).toBeLessThan(100);
    expect(backward).toBeGreaterThan(0);
    expect(backward).toBeLessThan(100);
    expect(dampTowardConfirmedTarget(25, 100, 0)).toBe(25);
    expect(dampTowardConfirmedTarget(25, 100, -1)).toBe(25);
  });

  test('is frame-rate independent over equal elapsed time', () => {
    const at30Fps = advanceFrames(0, 100, 1 / 30, 30);
    const at60Fps = advanceFrames(0, 100, 1 / 60, 60);
    const analytical = 100 * (1 - Math.exp(-NPC_INTERP_DAMPING_STIFFNESS));

    expect(at30Fps).toBeCloseTo(at60Fps, 10);
    expect(at60Fps).toBeCloseTo(analytical, 10);
  });

  test('never advances beyond a confirmed target over repeated frames', () => {
    let value = 0;
    for (let frame = 0; frame < 120; frame++) {
      const next = dampTowardConfirmedTarget(value, 10, 1 / 60);
      expect(next).toBeGreaterThanOrEqual(value);
      expect(next).toBeLessThanOrEqual(10);
      value = next;
    }
  });
});
