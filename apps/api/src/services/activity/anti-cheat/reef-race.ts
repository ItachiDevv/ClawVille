/**
 * Q2 Activity Portals — Reef Race anti-cheat (chunk #5).
 *
 * Per backend §4.5 + §4.7:
 *   - `validateLapTime(lapMs)` — flag if the lap completed faster than
 *     `MIN_LAP_MS`. The sim DROPS the lap (does not advance the lap
 *     counter) and emits the flag. Repeated under-min laps still each
 *     count one flag, so a sustained exploit hits the per-match
 *     `FLAG_FORFEIT_THRESHOLD = 5` ceiling fast.
 *   - `validateCheckpointSequence(avatarId, hitIndex, expectedIndex)` — out
 *     of order = silent reject. We track recent rejects in a 5s rolling
 *     window per avatar; 3+ in 5s → flag (`checkpoint_skip` kind). Silent
 *     reject of a single jitter event keeps the false-positive rate low
 *     (clients can land mid-checkpoint at the wrong moment under packet
 *     loss).
 *   - `validatePositionDelta` / `validateVelocityDelta` are reused from
 *     `bumper-shells.ts` with REEF-specific MAX_SPEED / MAX_ACCEL —
 *     same shape, just bigger numbers because karts are faster than
 *     bumper shells.
 *
 * Personal-best detection lives in chunk #7's reward pipeline (it owns
 * the historical query). The sim emits accurate `event.lap_completed`
 * frames with server-stamped `splitMs` + `totalMs`; reward pipeline
 * derives the PB flag from `score_ms` against the prior 30-day
 * minimum.
 *
 * Re-uses `BumperFlagCounter` from `bumper-shells.ts` rather than
 * forking a Reef-specific class — `FLAG_FORFEIT_THRESHOLD = 5` is the
 * shared ceiling per backend §4.7 across activities. The counter is
 * activity-agnostic; the flag-kind union is what differs.
 */

import {
  validatePositionDelta as bumperValidatePositionDelta,
  validateVelocityDelta as bumperValidateVelocityDelta,
  FLAG_FORFEIT_THRESHOLD,
  BumperFlagCounter,
  type PowerUpInventorySlot,
} from './bumper-shells';
import {
  type ValidationVerdict,
  DEFAULT_CLAMP_TOLERANCE,
} from './shared';
import {
  MIN_LAP_MS,
  REEF_MAX_SPEED,
  REEF_MAX_ACCEL,
  REEF_SKIP_PATTERN_WINDOW_MS,
  REEF_SKIP_PATTERN_THRESHOLD,
  REEF_CHECKPOINT_COUNT,
  REEF_MAX_POWER_UP_SLOTS,
} from '../sim/reef-race-config';
import {
  ReefSpline,
  type SplineControlPoint,
} from '../sim/reef-race-spline';
import {
  REEF_RACE_DEFAULT_TRACK,
  type ReefRaceSegmentRange,
} from '../sim/reef-race-track-layout';

// Re-export for convenience — Reef Race uses the same flag counter +
// forfeit threshold as Bumper. See module-doc above.
export { FLAG_FORFEIT_THRESHOLD };
export class ReefFlagCounter extends BumperFlagCounter {}

// ─── Position / velocity bounds ─────────────────────────────────────────────

/**
 * Position-delta validator using REEF_MAX_SPEED. Wraps the generic
 * Bumper validator with a per-activity ceiling. Clamping behaviour and
 * verdict shape are identical.
 */
export function validateReefPositionDelta(
  prev: { x: number; y: number },
  next: { x: number; y: number },
  dt: number,
  tolerance: number = DEFAULT_CLAMP_TOLERANCE,
): ValidationVerdict<{ x: number; y: number }> {
  // Re-implement here so we use REEF_MAX_SPEED instead of Bumper's
  // MAX_SPEED. The Bumper helper hard-codes its own constant.
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const dist = Math.hypot(dx, dy);
  const maxStep = REEF_MAX_SPEED * Math.max(dt, 0);
  const limit = maxStep * tolerance;
  if (dist <= limit) {
    return { ok: true, value: next, clamped: false, flagged: false };
  }
  const scale = dist === 0 ? 0 : maxStep / dist;
  const clampedNext = { x: prev.x + dx * scale, y: prev.y + dy * scale };
  return {
    ok: false,
    value: clampedNext,
    clamped: true,
    flagged: true,
    flagKind: 'overspeed',
    detail: `reef_position_delta_${dist.toFixed(2)}_over_${maxStep.toFixed(2)}`,
  };
}

/**
 * Velocity-delta validator using REEF_MAX_ACCEL + REEF_MAX_SPEED for
 * the resulting speed cap. Same verdict shape as Bumper's variant.
 */
export function validateReefVelocityDelta(
  prev: { x: number; y: number },
  next: { x: number; y: number },
  dt: number,
  tolerance: number = DEFAULT_CLAMP_TOLERANCE,
): ValidationVerdict<{ x: number; y: number }> {
  const dvx = next.x - prev.x;
  const dvy = next.y - prev.y;
  const dv = Math.hypot(dvx, dvy);
  const maxAccelStep = REEF_MAX_ACCEL * Math.max(dt, 0);
  const limit = maxAccelStep * tolerance;
  if (dv <= limit) {
    // Defensive — even within accel bound, cap absolute speed.
    const speed = Math.hypot(next.x, next.y);
    if (speed <= REEF_MAX_SPEED * tolerance) {
      return { ok: true, value: next, clamped: false, flagged: false };
    }
    const scale = REEF_MAX_SPEED / speed;
    return {
      ok: false,
      value: { x: next.x * scale, y: next.y * scale },
      clamped: true,
      flagged: true,
      flagKind: 'overspeed',
      detail: `reef_speed_${speed.toFixed(2)}_over_${REEF_MAX_SPEED.toFixed(2)}`,
    };
  }
  const scale = dv === 0 ? 0 : maxAccelStep / dv;
  const clampedNext = { x: prev.x + dvx * scale, y: prev.y + dvy * scale };
  // Cap absolute speed too.
  const speed = Math.hypot(clampedNext.x, clampedNext.y);
  if (speed > REEF_MAX_SPEED) {
    const s = REEF_MAX_SPEED / speed;
    clampedNext.x *= s;
    clampedNext.y *= s;
  }
  return {
    ok: false,
    value: clampedNext,
    clamped: true,
    flagged: true,
    flagKind: 'overaccel',
    detail: `reef_velocity_delta_${dv.toFixed(2)}_over_${maxAccelStep.toFixed(2)}`,
  };
}

// Re-export Bumper variants under explicit names for tests + future
// callers that want the Bumper bounds in a Reef context (e.g. testing
// the validator's clamp logic against a fixed MAX_SPEED).
export {
  bumperValidatePositionDelta,
  bumperValidateVelocityDelta,
};

// ─── Lap-time validator ─────────────────────────────────────────────────────

/**
 * Validate a lap-completion time. Flags + drops the lap if it's faster
 * than `MIN_LAP_MS`. Pure function — caller (the sim) decides whether
 * to advance the lap counter based on `ok`.
 */
export function validateLapTime(
  lapMs: number,
): ValidationVerdict<number> {
  if (!Number.isFinite(lapMs) || lapMs < 0) {
    return {
      ok: false,
      value: 0,
      clamped: true,
      flagged: true,
      flagKind: 'underminlap',
      detail: `lap_time_invalid_${lapMs}`,
    };
  }
  if (lapMs < MIN_LAP_MS) {
    return {
      ok: false,
      value: lapMs,
      clamped: false,
      flagged: true,
      flagKind: 'underminlap',
      detail: `lap_time_${lapMs}_under_${MIN_LAP_MS}`,
    };
  }
  return { ok: true, value: lapMs, clamped: false, flagged: false };
}

// ─── Checkpoint-sequence validator ──────────────────────────────────────────

/**
 * Validate a checkpoint hit against the per-avatar expected next index.
 *
 * Returns `ok: true` when the body crossed the expected next checkpoint.
 * Returns `ok: false, flagged: false` for a single out-of-order hit
 * (silent reject — could be jitter / packet loss). The sim does NOT
 * advance the avatar's `nextCheckpoint` pointer in either failure case.
 *
 * The `ReefCheckpointTracker` (below) folds `validateCheckpointSequence`
 * into a stateful per-match counter that escalates to a flag after
 * `REEF_SKIP_PATTERN_THRESHOLD` rejects in a `REEF_SKIP_PATTERN_WINDOW_MS`
 * rolling window — the recommended API for sim integration.
 */
export function validateCheckpointSequence(
  hitIndex: number,
  expectedIndex: number,
): ValidationVerdict<number> {
  if (
    !Number.isInteger(hitIndex) ||
    hitIndex < 0 ||
    hitIndex >= REEF_CHECKPOINT_COUNT
  ) {
    return {
      ok: false,
      value: hitIndex,
      clamped: false,
      flagged: true,
      flagKind: 'checkpoint_skip',
      detail: `checkpoint_index_invalid_${hitIndex}`,
    };
  }
  if (hitIndex !== expectedIndex) {
    return {
      ok: false,
      value: hitIndex,
      clamped: false,
      flagged: false,
      flagKind: 'checkpoint_skip',
      detail: `checkpoint_${hitIndex}_expected_${expectedIndex}`,
    };
  }
  return { ok: true, value: hitIndex, clamped: false, flagged: false };
}

/**
 * Per-avatar rolling-window tracker for checkpoint-skip patterns. The sim
 * holds one of these per room and calls `recordSkip(avatarId)` for every
 * silent-reject from `validateCheckpointSequence`. Returns true when
 * the pattern threshold trips — caller logs the flag + bumps the
 * BumperFlagCounter.
 */
export class ReefCheckpointSkipTracker {
  private skips = new Map<string, number[]>();

  /** Record a skip; returns true if the pattern threshold tripped. */
  recordSkip(avatarId: string, now: number = Date.now()): boolean {
    let times = this.skips.get(avatarId);
    if (!times) {
      times = [];
      this.skips.set(avatarId, times);
    }
    const cutoff = now - REEF_SKIP_PATTERN_WINDOW_MS;
    while (times.length > 0 && times[0] < cutoff) {
      times.shift();
    }
    times.push(now);
    return times.length >= REEF_SKIP_PATTERN_THRESHOLD;
  }

  forget(avatarId: string): void {
    this.skips.delete(avatarId);
  }

  /** Test hook. */
  __resetForTest(): void {
    this.skips.clear();
  }
}

// ─── Power-up slot use validator ────────────────────────────────────────────

/**
 * Validate a Reef power-up slot use. Same logic as the Bumper variant
 * but parameterised on `REEF_MAX_POWER_UP_SLOTS` and reuses the shared
 * `PowerUpInventorySlot` shape.
 */
export function validateReefPowerUpUse(
  slotIndex: number,
  inventory: PowerUpInventorySlot[],
  now: number,
): ValidationVerdict<PowerUpInventorySlot | null> {
  if (
    !Number.isInteger(slotIndex) ||
    slotIndex < 0 ||
    slotIndex >= REEF_MAX_POWER_UP_SLOTS
  ) {
    return {
      ok: false,
      value: null,
      clamped: false,
      flagged: true,
      flagKind: 'powerup_unowned',
      detail: `slot_index_out_of_range_${slotIndex}`,
    };
  }
  const slot = inventory[slotIndex];
  if (!slot || slot.kind === null || slot.charges <= 0) {
    return {
      ok: false,
      value: null,
      clamped: false,
      flagged: false,
      detail: 'no_charges_in_slot',
    };
  }
  if (slot.cooldownUntil > now) {
    return {
      ok: false,
      value: null,
      clamped: false,
      flagged: false,
      detail: 'cooldown_active',
    };
  }
  return { ok: true, value: slot, clamped: false, flagged: false };
}

export type { PowerUpInventorySlot } from './bumper-shells';

// ─── Reef Race v2 (spline sim) anti-cheat ────────────────────────────────────
//
// The live ellipse sim uses `validateLapTime` + `validateCheckpointSequence`
// (above). The v2 spline sim has no laps and no checkpoints — race progress is
// the body's spline parameter t ∈ [0, 1]. Per
// `.claude/plans/reef-race-v2-spline-architecture.md` §6, those validators are
// replaced (in the spline sim only) by:
//
//   • validateProgressMonotonic — flags large backward t-regressions
//   • validateSegmentTime       — flags too-fast traversals of a themed segment
//
// These are ADDITIVE — the legacy validators stay for the live ellipse sim.
// The spline sim opts in to the new ones via the `REEF_RACE_USE_SPLINE` flag.

/**
 * Maximum allowed backward drift of a body's spline progress (t ∈ [0,1]) per
 * server tick before flagging. 0.02 = 2% of the total track ≈ 600 wu on the
 * 30 000 wu locked layout. Sized to absorb the legitimate knockback windows
 * (tide-wave, whirlpool) called out in the architecture doc; anything bigger
 * is suspicious.
 *
 * Architecture doc §6: BACKWARD_TOLERANCE = 0.02.
 */
export const REEF_PROGRESS_REGRESSION_TOLERANCE = 0.02;

/**
 * Multiplier applied to the theoretical-fastest segment time to derive
 * `MIN_SEGMENT_MS`. 0.7 = 70% of theoretical fastest = a generous floor; a
 * body that crosses a segment in less time than that has either teleported
 * or accelerated past `REEF_MAX_SPEED`. Tuneable after first playtest.
 *
 * Architecture doc §6: "70% of theoretical-fastest = generous threshold;
 * calibrate after first playtest."
 */
export const REEF_SEGMENT_MIN_TIME_FRACTION = 0.7;

/**
 * Validate that a body's spline progress (t ∈ [0, 1]) has not regressed by
 * more than `REEF_PROGRESS_REGRESSION_TOLERANCE` since the previous tick.
 *
 * Pure function. Caller (spline sim) supplies prev/current t values that
 * have already been computed via `closestPointOnSpline(...).t`.
 *
 * CLOSED-LOOP (2026-06-22): on a periodic ring, t WRAPS 1→0 at the start/finish
 * seam every lap. A large backward drop (> 0.5) is therefore a FORWARD seam
 * crossing, NOT a regression — we wrap-adjust the delta before judging it. A
 * body moves ≤ ~0.0006 of the loop per tick, so a genuine 0.99→0.01 wrap is
 * unambiguous and is treated as forward progress.
 *
 * - wrapped delta >= -tol  → ok=true (forward progress, incl. a legit seam wrap
 *                            or a small knockback within tolerance).
 * - wrapped delta  < -tol  → ok=false, flagged='progress_regression'.
 *
 * The returned `value` is `currentT` unchanged in every branch — this
 * validator does NOT clamp progress (the spline sim owns the canonical t).
 */
export function validateProgressMonotonic(
  currentT: number,
  prevT: number,
): ValidationVerdict<number> {
  if (!Number.isFinite(currentT) || !Number.isFinite(prevT)) {
    return {
      ok: false,
      value: Number.isFinite(currentT) ? currentT : 0,
      clamped: false,
      flagged: true,
      flagKind: 'progress_regression',
      detail: `progress_value_invalid_curr_${currentT}_prev_${prevT}`,
    };
  }
  let delta = currentT - prevT;
  // Wrap-adjust a forward seam crossing: a drop bigger than half the loop is a
  // wrap (currentT is one loop ahead, just past the seam), so add 1.0.
  if (delta < -0.5) delta += 1;
  if (delta >= -REEF_PROGRESS_REGRESSION_TOLERANCE) {
    return { ok: true, value: currentT, clamped: false, flagged: false };
  }
  // delta < -tolerance → regression beyond knockback budget
  const regression = -delta;
  return {
    ok: false,
    value: currentT,
    clamped: false,
    flagged: true,
    flagKind: 'progress_regression',
    detail: `progress_regressed_${regression.toFixed(4)}_over_${REEF_PROGRESS_REGRESSION_TOLERANCE.toFixed(4)}`,
  };
}

/**
 * Per-segment t-range entry. Built once per segments-array reference. The
 * CLOSED-LOOP track (2026-06-22) carries explicit `tStart`/`tEnd` spline-
 * parameter fractions directly on each segment (z is NON-monotonic on a ring,
 * so the old z-bisection is retired) — `buildSegmentTRanges` reads them
 * verbatim and derives `minSegmentMs` from the segment's arc length.
 */
interface SegmentTRange {
  /** Index into the original segments array (parallel). */
  index: number;
  /** Inclusive lower-bound spline parameter for this segment. */
  tStart: number;
  /** Exclusive upper-bound spline parameter for this segment. */
  tEnd: number;
  /** Minimum allowed traversal time, ms. Pre-computed from z-length. */
  minSegmentMs: number;
  /** Diagnostic id (matches `ReefRaceSegmentRange.id`). */
  id: ReefRaceSegmentRange['id'];
}

/**
 * Cache: segments-array reference → built t-range table. Built lazily on
 * first call to `validateSegmentTime` (the spline construction is O(1000)
 * Simpson integrations and we don't want to pay it per validator call).
 *
 * WeakMap so a custom segments table passed in by tests doesn't keep its
 * built table alive forever.
 */
const segmentTRangeCache = new WeakMap<
  ReadonlyArray<ReefRaceSegmentRange>,
  ReadonlyArray<SegmentTRange>
>();

/**
 * Build the (segments) → (t-ranges) table. CLOSED-LOOP (2026-06-22): the
 * segments carry explicit `tStart`/`tEnd` directly, so this reads them
 * verbatim (NO z-bisection — z is non-monotonic on the ring). `minSegmentMs`
 * is derived from the segment's ARC LENGTH on the closed spline:
 *
 *   minSegmentMs = (arc(tEnd) − arc(tStart)) / REEF_MAX_SPEED
 *                  × REEF_SEGMENT_MIN_TIME_FRACTION × 1000
 *
 * (arc-length wu / wu-per-second = seconds; ×1000 = ms; ×0.7 = generous floor.)
 *
 * The spline is built `{ closed: true }` so the arc lengths match the sim's
 * lap math exactly.
 */
function buildSegmentTRanges(
  segments: ReadonlyArray<ReefRaceSegmentRange>,
  track: ReadonlyArray<SplineControlPoint> = REEF_RACE_DEFAULT_TRACK,
): ReadonlyArray<SegmentTRange> {
  const cached = segmentTRangeCache.get(segments);
  if (cached) return cached;

  const spline = new ReefSpline(track, { closed: true });

  const out: SegmentTRange[] = segments.map((seg, idx) => {
    const tStart = seg.tStart;
    const tEnd = seg.tEnd;
    const arcLen = Math.max(
      0,
      spline.arclengthFromT(tEnd) - spline.arclengthFromT(tStart),
    );
    const minSeconds =
      (arcLen / REEF_MAX_SPEED) * REEF_SEGMENT_MIN_TIME_FRACTION;
    const minSegmentMs = minSeconds * 1000;
    return { index: idx, tStart, tEnd, minSegmentMs, id: seg.id };
  });

  segmentTRangeCache.set(segments, out);
  return out;
}

/**
 * Locate the segment that contains a given parametric t. Returns the
 * matching `SegmentTRange` or `null` if t falls outside every segment's
 * range (only possible if the segments table is non-contiguous).
 *
 * O(log n) bisection — n=5 for the locked layout, but the binary-search
 * shape generalises if a future track adds segments.
 */
function segmentForT(
  t: number,
  ranges: ReadonlyArray<SegmentTRange>,
): SegmentTRange | null {
  if (ranges.length === 0) return null;
  // Clamp into the table's overall range
  if (t < ranges[0].tStart) return ranges[0];
  if (t >= ranges[ranges.length - 1].tEnd) return ranges[ranges.length - 1];
  // Binary search for the range that contains t
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (t < r.tStart) hi = mid - 1;
    else if (t >= r.tEnd) lo = mid + 1;
    else return r;
  }
  return null;
}

/**
 * Validate that a body has spent at least `MIN_SEGMENT_MS` traversing the
 * themed segment containing `currentT`. Replaces the retired
 * `validateLapTime` for the linear-river spline sim.
 *
 * @param currentT          Body's current spline parameter (0..1).
 * @param currentMs         Server timestamp at which `currentT` was sampled.
 * @param segmentEntryMs    Server timestamp at which the body first entered
 *                          the segment containing `currentT` (looked up
 *                          via `ReefProgressTracker.getEntryMs`).
 * @param segments          Segment table (typically `REEF_RACE_SEGMENTS`).
 *                          Pass a different table from a test if you want
 *                          to exercise a custom layout.
 *
 * Verdict shape: `value` is always `undefined` — this validator only
 * reports `ok` / `flagged`.
 *
 * Behaviour:
 *   - currentT outside every segment range  → ok=true (no-op; defer to other validators)
 *   - segment found AND elapsed >= minSegmentMs → ok=true
 *   - segment found AND elapsed <  minSegmentMs → ok=false, flagged='segment_too_fast'
 *   - bad timestamps (NaN, negative elapsed)    → ok=false, flagged='segment_too_fast'
 */
export function validateSegmentTime(
  currentT: number,
  currentMs: number,
  segmentEntryMs: number,
  segments: ReadonlyArray<ReefRaceSegmentRange>,
): ValidationVerdict<void> {
  if (
    !Number.isFinite(currentT) ||
    !Number.isFinite(currentMs) ||
    !Number.isFinite(segmentEntryMs)
  ) {
    return {
      ok: false,
      value: undefined,
      clamped: false,
      flagged: true,
      flagKind: 'segment_too_fast',
      detail: `segment_time_inputs_invalid_t_${currentT}_now_${currentMs}_entry_${segmentEntryMs}`,
    };
  }

  const ranges = buildSegmentTRanges(segments);
  const seg = segmentForT(currentT, ranges);
  if (!seg) {
    // No matching segment — treat as no-op rather than flag (don't punish
    // for an out-of-range progress; other validators own that domain).
    return { ok: true, value: undefined, clamped: false, flagged: false };
  }

  const elapsed = currentMs - segmentEntryMs;
  if (elapsed < 0) {
    return {
      ok: false,
      value: undefined,
      clamped: false,
      flagged: true,
      flagKind: 'segment_too_fast',
      detail: `segment_${seg.id}_negative_elapsed_${elapsed}`,
    };
  }
  if (elapsed < seg.minSegmentMs) {
    return {
      ok: false,
      value: undefined,
      clamped: false,
      flagged: true,
      flagKind: 'segment_too_fast',
      detail: `segment_${seg.id}_elapsed_${elapsed.toFixed(0)}_under_min_${seg.minSegmentMs.toFixed(0)}`,
    };
  }
  return { ok: true, value: undefined, clamped: false, flagged: false };
}

/**
 * Per-room tracker that records the timestamp at which each body first
 * entered each themed segment. The spline sim calls `recordEntry` once per
 * (avatar, segment) pair on the first tick where the body's t crosses into
 * that segment, and `getEntryMs` to feed `validateSegmentTime`.
 *
 * Mirrors `ReefCheckpointSkipTracker`'s shape: one tracker per room,
 * Map-backed, idempotent recordings, `forget(avatarId)` on disconnect.
 *
 * NOTE: idempotent — calling `recordEntry` more than once for the same
 * (avatar, segment) keeps the FIRST timestamp (so a body that gets knocked
 * back into a segment then re-enters does not reset the timer and game
 * the validator). This matches the architecture-doc intent of "first-time
 * entered" timestamps.
 */
export class ReefProgressTracker {
  private entries = new Map<string, Map<number, number>>();

  /**
   * Record the entry timestamp for a body into a segment.
   * Idempotent: silently keeps the first recorded timestamp on repeat calls.
   */
  recordEntry(avatarId: string, segmentIndex: number, ms: number): void {
    let perAvatar = this.entries.get(avatarId);
    if (!perAvatar) {
      perAvatar = new Map();
      this.entries.set(avatarId, perAvatar);
    }
    if (!perAvatar.has(segmentIndex)) {
      perAvatar.set(segmentIndex, ms);
    }
  }

  /**
   * Returns the recorded entry timestamp, or null if the body has never
   * been recorded entering this segment.
   */
  getEntryMs(avatarId: string, segmentIndex: number): number | null {
    const perAvatar = this.entries.get(avatarId);
    if (!perAvatar) return null;
    const ms = perAvatar.get(segmentIndex);
    return ms === undefined ? null : ms;
  }

  /** Drop tracking for an avatar on disconnect / match end. */
  forget(avatarId: string): void {
    this.entries.delete(avatarId);
  }

  /** Test hook — wipe all in-memory state. */
  __resetForTest(): void {
    this.entries.clear();
  }
}

/**
 * Internal accessor for tests + future callers (e.g. the spline sim's
 * "what segment am I in?" lookup) to query the cached t-ranges built from
 * a segments table. Not exported as part of the validator API surface.
 *
 * Exposed via a named function rather than re-exporting the cache so we
 * can swap the cache implementation later without breaking callers.
 */
export function __getSegmentTRangesForTest(
  segments: ReadonlyArray<ReefRaceSegmentRange>,
): ReadonlyArray<{ index: number; tStart: number; tEnd: number; minSegmentMs: number; id: ReefRaceSegmentRange['id'] }> {
  return buildSegmentTRanges(segments).map((r) => ({
    index: r.index,
    tStart: r.tStart,
    tEnd: r.tEnd,
    minSegmentMs: r.minSegmentMs,
    id: r.id,
  }));
}
