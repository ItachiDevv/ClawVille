import { describe, expect, test } from 'bun:test';
import {
  COVE_FPS_FALLBACK_THRESHOLD,
  COVE_FPS_MIN_SAMPLES,
  COVE_FPS_SAMPLE_S,
  COVE_FPS_WARMUP_S,
  CoveFpsSampler,
  coveFpsThreshold,
  type CoveFpsDecision,
} from '../cove-fps-sampler';

/** Feed deltas (ms) until a decision; returns it, or null if none came. */
function run(sampler: CoveFpsSampler, deltasMs: number[]): CoveFpsDecision | null {
  for (const ms of deltasMs) {
    const d = sampler.push(ms / 1000);
    if (d) return d;
  }
  return null;
}
const repeat = (ms: number, count: number) => Array.from({ length: count }, () => ms);
/** Enough frames at `ms` to cover the warm-up plus one full sample window. */
const steady = (ms: number) => repeat(ms, Math.ceil(((COVE_FPS_WARMUP_S + COVE_FPS_SAMPLE_S) * 1000) / ms) + 2);

describe('coveFpsThreshold', () => {
  test('no cap keeps 40; the phone 30 FPS cap gives 24', () => {
    expect(coveFpsThreshold(null)).toBe(COVE_FPS_FALLBACK_THRESHOLD);
    expect(coveFpsThreshold(30)).toBe(24);
    expect(coveFpsThreshold(60)).toBe(COVE_FPS_FALLBACK_THRESHOLD);
  });
});

describe('CoveFpsSampler', () => {
  test('walk-in stalls on a capable machine do NOT trip it (the founder case)', () => {
    // Stalls inside the warm-up AND a few more inside the sample window. The
    // plain mean of the sample window is under 40 FPS here.
    const s = new CoveFpsSampler(null);
    const window = [...repeat(900, 2), ...repeat(600, 1), ...repeat(18, 150)];
    const mean = window.length / (window.reduce((a, b) => a + b, 0) / 1000);
    expect(mean).toBeLessThan(COVE_FPS_FALLBACK_THRESHOLD);
    const d = run(s, [1017, 217, 117, ...repeat(17, 100), ...window, ...repeat(18, 200)]);
    expect(d).not.toBeNull();
    expect(d!.fallback).toBe(false);
    expect(d!.fps).toBeGreaterThan(50);
    // The plain mean of the same window is what used to decide: under 40.
    expect(d!.rawFps).toBeLessThan(COVE_FPS_FALLBACK_THRESHOLD);
  });

  test('a phone at its 30 FPS cap does NOT trip it', () => {
    const d = run(new CoveFpsSampler(30), steady(33.3));
    expect(d!.fallback).toBe(false);
  });

  test('a phone well under its cap still trips it', () => {
    const d = run(new CoveFpsSampler(30), steady(50)); // 20 FPS
    expect(d!.fallback).toBe(true);
  });

  test('a desktop GPU that is really too slow trips it', () => {
    const d = run(new CoveFpsSampler(null), steady(34)); // ~29 FPS
    expect(d!.fallback).toBe(true);
  });

  test('uneven slow rendering trips it (two fast frames, one slow, repeated = 30 FPS)', () => {
    const pattern: number[] = [];
    for (let i = 0; i < 200; i++) pattern.push(16.7, 16.7, 66.7);
    const d = run(new CoveFpsSampler(null), pattern);
    expect(d!.fallback).toBe(true);
  });

  test('a machine under 1 FPS still gets a decision (and falls back)', () => {
    const d = run(new CoveFpsSampler(null), repeat(1250, COVE_FPS_MIN_SAMPLES + 20));
    expect(d).not.toBeNull();
    expect(d!.fallback).toBe(true);
  });

  test('one long pause cannot decide alone', () => {
    const s = new CoveFpsSampler(null);
    // Warm-up, then a 10 s freeze: the window time is full but frames are not.
    expect(run(s, [...steady(17).slice(0, 130), 10_000])).toBeNull();
    const d = run(s, repeat(17, COVE_FPS_MIN_SAMPLES));
    expect(d!.fallback).toBe(false);
  });

  test('exactly 40 FPS does not trip (Float64, strictly below only)', () => {
    const d = run(new CoveFpsSampler(null), steady(25));
    expect(d!.fallback).toBe(false);
  });

  test('a retained slot re-warms on each visit: re-entry stalls do not count', () => {
    const s = new CoveFpsSampler(null);
    // Visit 1: warm-up + part of a normal sample, then the player leaves.
    expect(run(s, repeat(17, 121))).toBeNull();
    // Visit 2 starts with six 900 ms entry stalls (Codex counterexample).
    s.startVisit();
    const d = run(s, [...repeat(900, 6), ...steady(17)]);
    expect(d!.fallback).toBe(false);
  });

  test('without startVisit the same re-entry stalls WOULD have counted (guards the test)', () => {
    const s = new CoveFpsSampler(null);
    run(s, repeat(17, 121));
    const d = run(s, [...repeat(900, 6), ...repeat(17, 40)]);
    expect(d!.fallback).toBe(true);
  });

  test('decides once, then ignores frames and visits', () => {
    const s = new CoveFpsSampler(null);
    expect(run(s, steady(17))!.fallback).toBe(false);
    expect(s.isDecided).toBe(true);
    s.startVisit();
    expect(run(s, steady(100))).toBeNull();
  });

  test('negative or NaN deltas are ignored', () => {
    const s = new CoveFpsSampler(null);
    expect(s.push(-1)).toBeNull();
    expect(s.push(Number.NaN)).toBeNull();
    expect(run(s, steady(17))!.fallback).toBe(false);
  });
});
