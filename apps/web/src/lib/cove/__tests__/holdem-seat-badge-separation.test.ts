import { describe, expect, test } from 'bun:test';
import { separateSeatBadges } from '../holdem-table-view';

// Staging 2026-10-21 at 844 x 390 (spectator, table 3f5ce6e6): the seat-2
// badge box was x 223 y 161 154 x 62 and the seat-3 box x 177 y 194 154 x 62,
// so seat 3 covered the lower 29 px of seat 2. Centres below.

describe('separateSeatBadges', () => {
  test('the measured staging overlap is pushed apart by at least the box height plus the gap', () => {
    const left = [0, 300, 254];
    const top = new Float64Array([0, 192, 225]);
    const width = [0, 154, 154];
    const height = [0, 62, 62];
    const shown = [0, 1, 1];
    separateSeatBadges(left, top, width, height, shown);
    expect(top[2]! - top[1]!).toBeGreaterThanOrEqual(62 + 4 - 1e-9);
    // Both move by the same amount: the pair keeps its centre.
    expect((top[1]! + top[2]!) / 2).toBeCloseTo((192 + 225) / 2, 9);
    expect(top[0]).toBe(0);
  });

  test('badges far apart on the horizontal axis do not move', () => {
    const top = new Float64Array([200, 205]);
    separateSeatBadges([100, 700], top, [154, 154], [62, 62], [1, 1]);
    expect([...top]).toEqual([200, 205]);
  });

  test('a hidden badge neither moves nor pushes', () => {
    const top = new Float64Array([200, 210]);
    separateSeatBadges([300, 300], top, [154, 154], [62, 62], [1, 0]);
    expect([...top]).toEqual([200, 210]);
  });

  test('three stacked badges end with no overlapping pair', () => {
    const left = [400, 410, 420];
    const top = new Float64Array([200, 210, 220]);
    const width = [120, 120, 120];
    const height = [40, 40, 40];
    separateSeatBadges(left, top, width, height, [1, 1, 1]);
    // Screen order is kept (no badge jumps over another) and the stack stays centred.
    expect(top[1]! - top[0]!).toBeGreaterThanOrEqual(44 - 1e-9);
    expect(top[2]! - top[1]!).toBeGreaterThanOrEqual(44 - 1e-9);
    expect((top[0]! + top[1]! + top[2]!) / 3).toBeCloseTo(210, 9);
  });
});
