/**
 * Q2 Activity Portals — Reef Race anti-cheat unit tests (chunk #5).
 *
 * Pure-function coverage for the validators in `anti-cheat/reef-race.ts`:
 *   - position-delta clamp at REEF_MAX_SPEED triggers flag + preserves direction
 *   - velocity-delta clamp at REEF_MAX_ACCEL triggers flag + caps speed
 *   - lap-time validator flags under-min laps
 *   - checkpoint-sequence validator silent-rejects out-of-order single hits
 *   - skip-tracker trips on REEF_SKIP_PATTERN_THRESHOLD in window
 *   - flag counter inherits 5-flag forfeit threshold from Bumper counter
 */

import { describe, expect, it } from 'bun:test';
import {
  validateReefPositionDelta,
  validateReefVelocityDelta,
  validateLapTime,
  validateCheckpointSequence,
  ReefCheckpointSkipTracker,
  ReefFlagCounter,
  FLAG_FORFEIT_THRESHOLD,
  validateProgressMonotonic,
  validateSegmentTime,
  ReefProgressTracker,
  REEF_PROGRESS_REGRESSION_TOLERANCE,
  REEF_SEGMENT_MIN_TIME_FRACTION,
  __getSegmentTRangesForTest,
} from '../reef-race';
import {
  REEF_MAX_SPEED,
  REEF_MAX_ACCEL,
  MIN_LAP_MS,
  REEF_SKIP_PATTERN_THRESHOLD,
  REEF_CHECKPOINT_COUNT,
} from '../../sim/reef-race-config';
import { REEF_RACE_SEGMENTS, REEF_RACE_DEFAULT_TRACK } from '../../sim/reef-race-track-layout';
import { ReefSpline } from '../../sim/reef-race-spline';

const DT_30HZ = 1 / 30;

// ─── Position-delta ────────────────────────────────────────────────────────

describe('validateReefPositionDelta — overspeed', () => {
  it('passes through a legitimate velocity integration', () => {
    const prev = { x: 0, y: 0 };
    const next = { x: REEF_MAX_SPEED * DT_30HZ * 0.9, y: 0 };
    const v = validateReefPositionDelta(prev, next, DT_30HZ);
    expect(v.ok).toBe(true);
    expect(v.flagged).toBe(false);
  });

  it('clamps an over-limit position delta and flags', () => {
    const prev = { x: 0, y: 0 };
    const next = { x: REEF_MAX_SPEED * DT_30HZ * 4, y: 0 };
    const v = validateReefPositionDelta(prev, next, DT_30HZ);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(true);
    expect(v.flagKind).toBe('overspeed');
    const dist = Math.hypot(v.value.x - prev.x, v.value.y - prev.y);
    expect(dist).toBeCloseTo(REEF_MAX_SPEED * DT_30HZ, 4);
  });

  it('preserves direction when clamping diagonal motion', () => {
    const prev = { x: 0, y: 0 };
    const next = { x: 99999, y: 99999 };
    const v = validateReefPositionDelta(prev, next, DT_30HZ);
    expect(v.flagged).toBe(true);
    const angle = Math.atan2(v.value.y - prev.y, v.value.x - prev.x);
    expect(angle).toBeCloseTo(Math.PI / 4, 4);
  });
});

// ─── Velocity-delta ─────────────────────────────────────────────────────────

describe('validateReefVelocityDelta — overaccel + speed cap', () => {
  it('passes through a legitimate accel step', () => {
    const v = validateReefVelocityDelta({ x: 0, y: 0 }, { x: REEF_MAX_ACCEL * DT_30HZ * 0.5, y: 0 }, DT_30HZ);
    expect(v.ok).toBe(true);
    expect(v.flagged).toBe(false);
  });

  it('clamps over-limit velocity delta and caps absolute speed', () => {
    const v = validateReefVelocityDelta(
      { x: 0, y: 0 },
      { x: REEF_MAX_ACCEL * DT_30HZ * 5, y: 0 },
      DT_30HZ,
    );
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(true);
    expect(Math.hypot(v.value.x, v.value.y)).toBeLessThanOrEqual(REEF_MAX_SPEED + 1e-6);
  });
});

// ─── Lap time ───────────────────────────────────────────────────────────────

describe('validateLapTime', () => {
  it('flags a sub-MIN_LAP_MS lap', () => {
    const v = validateLapTime(MIN_LAP_MS - 1);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(true);
    expect(v.flagKind).toBe('underminlap');
  });

  it('accepts a lap exactly at MIN_LAP_MS', () => {
    const v = validateLapTime(MIN_LAP_MS);
    expect(v.ok).toBe(true);
    expect(v.flagged).toBe(false);
  });

  it('flags negative lap time', () => {
    const v = validateLapTime(-100);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(true);
  });
});

// ─── Checkpoint sequence ────────────────────────────────────────────────────

describe('validateCheckpointSequence', () => {
  it('accepts a hit on the expected next checkpoint', () => {
    const v = validateCheckpointSequence(3, 3);
    expect(v.ok).toBe(true);
    expect(v.flagged).toBe(false);
  });

  it('silently rejects a single out-of-order hit (no flag)', () => {
    const v = validateCheckpointSequence(5, 3);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(false);
  });

  it('flags an out-of-range checkpoint index', () => {
    const v = validateCheckpointSequence(REEF_CHECKPOINT_COUNT + 1, 0);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(true);
    expect(v.flagKind).toBe('checkpoint_skip');
  });
});

describe('ReefCheckpointSkipTracker', () => {
  it('trips at the REEF_SKIP_PATTERN_THRESHOLD-th skip in the window', () => {
    const t = new ReefCheckpointSkipTracker();
    const now = 1_000_000;
    for (let i = 1; i < REEF_SKIP_PATTERN_THRESHOLD; i++) {
      expect(t.recordSkip('avatar-a', now + i)).toBe(false);
    }
    expect(t.recordSkip('avatar-a', now + REEF_SKIP_PATTERN_THRESHOLD)).toBe(true);
  });

  it('forgets stale skips outside the window', () => {
    const t = new ReefCheckpointSkipTracker();
    // Pile up old skips well outside window.
    t.recordSkip('avatar-a', 0);
    t.recordSkip('avatar-a', 1);
    // Now far in the future — old timestamps drop, new one is alone.
    const trippedNow = t.recordSkip('avatar-a', 999_999_999);
    expect(trippedNow).toBe(false);
  });
});

// ─── Flag counter forfeit ───────────────────────────────────────────────────

describe('ReefFlagCounter (inherits BumperFlagCounter)', () => {
  it('reports forfeit at exactly the 5th flag', () => {
    const counter = new ReefFlagCounter();
    for (let i = 1; i < FLAG_FORFEIT_THRESHOLD; i++) {
      expect(counter.bump('avatar-a')).toBe(false);
    }
    expect(counter.bump('avatar-a')).toBe(true);
    expect(counter.countFor('avatar-a')).toBe(FLAG_FORFEIT_THRESHOLD);
  });

  it('tracks avatars independently', () => {
    const counter = new ReefFlagCounter();
    counter.bump('avatar-a');
    counter.bump('avatar-a');
    counter.bump('avatar-b');
    expect(counter.countFor('avatar-a')).toBe(2);
    expect(counter.countFor('avatar-b')).toBe(1);
  });
});

// ─── Reef Race v2 (spline) anti-cheat ───────────────────────────────────────
//
// Spec: `.claude/plans/reef-race-v2-spline-architecture.md` §6.
// Replaces validateLapTime + validateCheckpointSequence (kept for live
// ellipse sim) with validateProgressMonotonic + validateSegmentTime.

describe('validateProgressMonotonic', () => {
  it('T1: ok when current === previous (no change)', () => {
    const v = validateProgressMonotonic(0.5, 0.5);
    expect(v.ok).toBe(true);
    expect(v.flagged).toBe(false);
    expect(v.value).toBe(0.5);
  });

  it('T2: ok when forward (current > previous)', () => {
    const v = validateProgressMonotonic(0.6, 0.5);
    expect(v.ok).toBe(true);
    expect(v.flagged).toBe(false);
    expect(v.value).toBe(0.6);
  });

  it('T3: ok when small regression within tolerance (≤ 0.02)', () => {
    const v = validateProgressMonotonic(0.49, 0.5);
    expect(v.ok).toBe(true);
    expect(v.flagged).toBe(false);
  });

  it('T3b: exactly at the tolerance edge is still ok', () => {
    // Construct prev/current so currentT - prevT === -tolerance EXACTLY
    // (avoid float drift by anchoring on the tolerance value).
    const prevT = REEF_PROGRESS_REGRESSION_TOLERANCE; // = 0.02
    const currentT = 0;                                // delta = -0.02 exactly
    const v = validateProgressMonotonic(currentT, prevT);
    expect(v.ok).toBe(true);
    expect(v.flagged).toBe(false);
  });

  it('T4: flags large backward regression (delta = 0.10 > tol = 0.02)', () => {
    const v = validateProgressMonotonic(0.4, 0.5);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(true);
    expect(v.flagKind).toBe('progress_regression');
    expect(v.detail).toContain('progress_regressed_');
  });

  it('flags non-finite inputs', () => {
    const v = validateProgressMonotonic(NaN, 0.5);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(true);
    expect(v.flagKind).toBe('progress_regression');
  });
});

describe('validateSegmentTime', () => {
  // The kelp segment (index 1) is the easiest to construct a deterministic test
  // from. On the CLOSED loop the segments carry explicit t-ranges (z is
  // non-monotonic), and `minSegmentMs` is derived from the segment's ARC LENGTH
  // on the live spline: minSegmentMs = segArc / REEF_MAX_SPEED * 0.7 * 1000.
  // v6 WIDE SURF ROAD: kelp t-range ≈ [0.083, 0.273] → arc ≈ 17 246 wu →
  // floor ≈ 9 286 ms (@ 2× cap 1300: 17246/1300*0.7*1000). The floor auto-tracks the
  // track geometry, so these tests assert the BEHAVIOUR (under-floor flags,
  // over-floor clears), with the elapsed times chosen relative to the v6 floor.
  const ranges = __getSegmentTRangesForTest(REEF_RACE_SEGMENTS);

  it('T5: flags too-fast traversal (segment crossed under min time)', () => {
    // Pick the kelp segment (index 1) and a t inside its range.
    // v6 WIDE SURF ROAD: kelp arc ≈ 17 246 wu → floor = (17246/1300)*0.7*1000
    // ≈ 9 286 ms (@ 2× cap). Floors are arc-derived from
    // the live spline, so they auto-track the track — the test asserts the
    // BEHAVIOUR (under-floor flags, over-floor clears), not a hardcoded number.
    const kelp = ranges[1];
    expect(kelp.id).toBe('kelp');
    const tMid = (kelp.tStart + kelp.tEnd) * 0.5;
    // Body entered the segment 1000ms ago — way under the ~9 286ms floor.
    const v = validateSegmentTime(tMid, 1_000_000, 999_000, REEF_RACE_SEGMENTS);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(true);
    expect(v.flagKind).toBe('segment_too_fast');
    expect(v.detail).toContain('kelp');
  });

  it('T6: ok when traversal exceeds min time (17.5s in a ~9.3s-floor segment)', () => {
    // v6 kelp arc ≈ 17 246 wu → floor = (17246/1300)*0.7*1000 ≈ 9 286 ms (@ 2× cap).
    // Scale the old 35s fixture by 650/1300: 17.5s keeps the same margin.
    const kelp = ranges[1];
    const tMid = (kelp.tStart + kelp.tEnd) * 0.5;
    const v = validateSegmentTime(tMid, 1_000_000, 982_500, REEF_RACE_SEGMENTS);
    expect(v.ok).toBe(true);
    expect(v.flagged).toBe(false);
  });

  it('flags non-finite timestamps', () => {
    const kelp = ranges[1];
    const tMid = (kelp.tStart + kelp.tEnd) * 0.5;
    const v = validateSegmentTime(tMid, NaN, 0, REEF_RACE_SEGMENTS);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(true);
    expect(v.flagKind).toBe('segment_too_fast');
  });

  it('flags negative elapsed time (clock skew / bad input)', () => {
    const kelp = ranges[1];
    const tMid = (kelp.tStart + kelp.tEnd) * 0.5;
    const v = validateSegmentTime(tMid, 1000, 2000, REEF_RACE_SEGMENTS);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(true);
    expect(v.flagKind).toBe('segment_too_fast');
    expect(v.detail).toContain('negative_elapsed');
  });

  it('verifies the min-time formula matches the spec (segment ARC-length / speed * 0.7)', () => {
    // CLOSED-LOOP (2026-06-22): the floor is derived from the segment's ARC
    // LENGTH on the closed ring (z is non-monotonic on a loop — the old
    // z-length formula is retired). Re-derive the kelp segment's arc here from
    // the same closed spline the validator uses, and assert the floor matches.
    const kelp = ranges[1];
    const kelpSeg = REEF_RACE_SEGMENTS[1];
    const spline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });
    const arcLen =
      spline.arclengthFromT(kelpSeg.tEnd) - spline.arclengthFromT(kelpSeg.tStart);
    const expectedMs =
      (arcLen / REEF_MAX_SPEED) * REEF_SEGMENT_MIN_TIME_FRACTION * 1000;
    expect(kelp.minSegmentMs).toBeCloseTo(expectedMs, 5);
    expect(kelp.minSegmentMs).toBeGreaterThan(0);
  });

  it('CLOSED-LOOP: a forward seam wrap (t 0.99→0.01) is forward progress, NOT a regression', () => {
    const v = validateProgressMonotonic(0.01, 0.99);
    expect(v.ok).toBe(true);
    expect(v.flagged).toBe(false);
  });
});

describe('ReefProgressTracker', () => {
  it('T7: recordEntry then getEntryMs round-trip', () => {
    const t = new ReefProgressTracker();
    t.recordEntry('avatar-a', 2, 12345);
    expect(t.getEntryMs('avatar-a', 2)).toBe(12345);
  });

  it('returns null for a never-recorded (avatar, segment) pair', () => {
    const t = new ReefProgressTracker();
    expect(t.getEntryMs('avatar-a', 0)).toBeNull();
    t.recordEntry('avatar-a', 0, 100);
    expect(t.getEntryMs('avatar-a', 1)).toBeNull(); // segment 1 untouched
    expect(t.getEntryMs('avatar-b', 0)).toBeNull(); // different avatar
  });

  it('is idempotent — first timestamp wins on repeat calls', () => {
    const t = new ReefProgressTracker();
    t.recordEntry('avatar-a', 0, 1000);
    t.recordEntry('avatar-a', 0, 9999);
    expect(t.getEntryMs('avatar-a', 0)).toBe(1000);
  });

  it('forget(avatarId) clears every segment for that avatar only', () => {
    const t = new ReefProgressTracker();
    t.recordEntry('avatar-a', 0, 100);
    t.recordEntry('avatar-a', 1, 200);
    t.recordEntry('avatar-b', 0, 300);
    t.forget('avatar-a');
    expect(t.getEntryMs('avatar-a', 0)).toBeNull();
    expect(t.getEntryMs('avatar-a', 1)).toBeNull();
    expect(t.getEntryMs('avatar-b', 0)).toBe(300);
  });
});

describe('Spline t-to-segment-index mapping', () => {
  const ranges = __getSegmentTRangesForTest(REEF_RACE_SEGMENTS);

  it('T8: mapping is monotonic (tStart strictly increases segment-by-segment)', () => {
    expect(ranges).toHaveLength(REEF_RACE_SEGMENTS.length);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].tStart).toBeGreaterThan(ranges[i - 1].tStart);
      // tEnd of one segment === tStart of the next (contiguous coverage)
      expect(ranges[i].tStart).toBeCloseTo(ranges[i - 1].tEnd, 5);
    }
  });

  it('first segment starts at t=0 and last ends at t=1', () => {
    expect(ranges[0].tStart).toBeCloseTo(0, 4);
    expect(ranges[ranges.length - 1].tEnd).toBeCloseTo(1, 4);
  });

  it('preserves segment ids in order: lagoon → kelp → shipwreck → coral → finish', () => {
    expect(ranges.map((r) => r.id)).toEqual([
      'lagoon',
      'kelp',
      'shipwreck',
      'coral',
      'finish',
    ]);
  });
});
