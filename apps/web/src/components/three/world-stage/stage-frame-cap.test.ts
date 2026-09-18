import { describe, expect, test } from 'bun:test';
import { createFrameCapState, stepFrameCap } from './stage-frame-cap';

const INTERVAL = 1000 / 30;
const TOL = 1;

/** Run `frames` native frames of `ms`; returns admitted count and delta sum (s). */
function run(ms: number, frames: number) {
  const s = createFrameCapState();
  let admitted = 0;
  let sum = 0;
  for (let i = 0; i < frames; i++) {
    const d = stepFrameCap(s, ms, INTERVAL, TOL, false);
    if (d >= 0) { admitted++; sum += d; }
  }
  return { admitted, sum, wall: (ms * frames) / 1000 };
}

describe('stepFrameCap (30 FPS cap)', () => {
  test('60 Hz: 30 admissions per second, deltas sum to wall time', () => {
    const r = run(1000 / 60, 600); // 10 s
    expect(r.admitted).toBeGreaterThanOrEqual(299);
    expect(r.admitted).toBeLessThanOrEqual(301);
    expect(Math.abs(r.sum - r.wall)).toBeLessThan(0.05);
  });

  test('120 Hz: 30 admissions per second, deltas sum to wall time', () => {
    const r = run(1000 / 120, 1200);
    expect(r.admitted).toBeGreaterThanOrEqual(299);
    expect(r.admitted).toBeLessThanOrEqual(301);
    expect(Math.abs(r.sum - r.wall)).toBeLessThan(0.05);
  });

  test('50 Hz: still ~30 admissions per second, and deltas no longer overrun wall time', () => {
    // Before the fix the delta included the carried remainder, which was also
    // carried forward, so these 10 s summed to ~13 s (scene time ran fast).
    const r = run(20, 500);
    expect(r.admitted).toBeGreaterThanOrEqual(299);
    expect(r.admitted).toBeLessThanOrEqual(301);
    expect(Math.abs(r.sum - r.wall)).toBeLessThan(0.05);
  });

  test('a frame slower than the cap is admitted with its real delta', () => {
    const s = createFrameCapState();
    expect(stepFrameCap(s, 50, INTERVAL, TOL, false)).toBeCloseTo(0.05, 6);
  });

  test('a long stall is clamped to two intervals, as before', () => {
    const s = createFrameCapState();
    expect(stepFrameCap(s, 5000, INTERVAL, TOL, false)).toBeCloseTo((2 * INTERVAL) / 1000, 6);
  });

  test('recovery admits one frame at one interval and drops the backlog', () => {
    const s = createFrameCapState();
    stepFrameCap(s, 20, INTERVAL, TOL, false); // 20 ms pending, skipped
    expect(stepFrameCap(s, 9000, INTERVAL, TOL, true)).toBeCloseTo(INTERVAL / 1000, 6);
    // Nothing carried: the next 20 ms frame is skipped again.
    expect(stepFrameCap(s, 20, INTERVAL, TOL, false)).toBe(-1);
  });

  test('skips return -1 and do not reset the elapsed time', () => {
    const s = createFrameCapState();
    expect(stepFrameCap(s, 16, INTERVAL, TOL, false)).toBe(-1);
    expect(stepFrameCap(s, 17, INTERVAL, TOL, false)).toBeCloseTo(0.033, 6);
  });
});
