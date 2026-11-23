import { describe, expect, test } from 'bun:test';
import { createNavigationStep, stepNavigationPath } from './navigation-path-step';

describe('frame distance along navigation paths', () => {
  test('spends the remainder after a waypoint and checks each turn separately', () => {
    const segments: number[][] = [], out = createNavigationStep();
    stepNavigationPath([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 20 }], 0, 0, 0, 10, (x, y, tx, ty) => { segments.push([x, y, tx, ty]); return { x: tx, y: ty }; }, out);
    expect(segments).toEqual([[0, 0, 5, 0], [5, 0, 5, 5]]);
    expect(out).toMatchObject({ x: 5, y: 5, index: 2, traveled: 10, complete: false });
  });
  test('keeps movement active at40FPS sprint until the final waypoint', () => {
    const points = [{ x: 0, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 32 }, { x: 64, y: 32 }];
    const out = createNavigationStep(); let x = 0, y = 0, index = 0, frames = 0;
    do {
      stepNavigationPath(points, index, x, y, 550 * 2.025 / 40, (_x, _y, tx, ty) => ({ x: tx, y: ty }), out);
      expect(out.traveled).toBeGreaterThan(0);
      x = out.x; y = out.y; index = out.index; frames++;
    } while (!out.complete && frames < 20);
    expect(frames).toBe(4);
    expect({ x, y }).toEqual(points.at(-1)!);
  });
  test('stops at collision and never spends the remainder through another segment', () => {
    const out = createNavigationStep(); let calls = 0;
    stepNavigationPath([{ x: 5, y: 0 }, { x: 5, y: 20 }], 0, 0, 0, 30, (_x, _y, tx, ty) => { calls++; return { x: Math.min(3, tx), y: ty }; }, out);
    expect(calls).toBe(1);
    expect(out).toMatchObject({ x: 3, y: 0, index: 0, complete: false });
  });
});

test('final arrival accepts the existing six-unit tolerance without skipping an intermediate turn', () => {
  const out = createNavigationStep();
  const blockedAtFive = (_x: number, _y: number, tx: number, ty: number) => ({ x: Math.min(5, tx), y: ty });
  stepNavigationPath([{ x: 10, y: 0 }], 0, 0, 0, 20, blockedAtFive, out, 6);
  expect(out).toMatchObject({ x: 5, y: 0, complete: true });
  stepNavigationPath([{ x: 10, y: 0 }, { x: 10, y: 20 }], 0, 0, 0, 30, blockedAtFive, out, 6);
  expect(out).toMatchObject({ x: 5, y: 0, index: 0, complete: false });
});


test('a blocked turn keeps the last segment that moved', () => {
  const out = createNavigationStep();
  stepNavigationPath([{ x: 5, y: 0 }, { x: 5, y: 20 }], 0, 0, 0, 20, (_x, _y, tx, ty) => ({ x: tx, y: Math.min(0, ty) }), out);
  expect(out).toMatchObject({ x: 5, y: 0, traveled: 5, vx: 1, vy: 0, complete: false });
});
