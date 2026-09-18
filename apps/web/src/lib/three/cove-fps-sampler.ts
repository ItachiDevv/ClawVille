/**
 * Cove FPS auto-fallback sampler (pure, no three.js imports).
 *
 * The cove swaps its room to the cartoon fallback GLB when the machine cannot
 * render the real room. The swap is one-way for the mount and the fallback
 * room reads as a broken build (dark, black table slabs), so a false trip is a
 * visible regression (founder-reported on prod 2026-09-18).
 *
 * What the old sampler got wrong (mean FPS over the first 5 s after mount):
 *   - Walk-in stalls. Walking in from the world, the first frames carry the
 *     stage transition, pipeline compiles and texture uploads. Measured
 *     locally 2026-09-18: 5 frames in the first second (single frames of
 *     1017, 217 and 117 ms), then a steady 59 FPS. A few such stalls on a
 *     slower GPU pulled the mean under 40 on a machine that renders the room
 *     at 52-60 FPS.
 *   - Phones. The stage caps phones at 30 FPS on purpose
 *     (`PHONE_PROFILE.fpsCap`), so a fixed 40 FPS threshold sent EVERY phone
 *     to the fallback room.
 *   - Retained stage slots. A sample left unfinished when the player left
 *     resumed on the next visit with no warm-up, so that visit's entry stalls
 *     counted.
 *   - Under 1 FPS. Frames longer than 1 s were skipped, so a machine that
 *     slow never collected a sample and never fell back.
 *
 * So: until a decision is made, every visit starts with COVE_FPS_WARMUP_S
 * seconds that are not sampled (a decision, once made, holds for the mount);
 * then frame deltas are collected until COVE_FPS_SAMPLE_S seconds AND at
 * least COVE_FPS_MIN_SAMPLES frames; the decision is the mean frame time
 * after dropping the longest COVE_FPS_TRIM_FRACTION of frames (stalls and
 * pauses), against a threshold that follows the frame cap.
 */

/** Threshold with no frame cap (desktop, tablet). */
export const COVE_FPS_FALLBACK_THRESHOLD = 40;
/** With a frame cap, the threshold is this fraction of the cap (phone 30 -> 24). */
export const COVE_FPS_CAPPED_THRESHOLD_FRACTION = 0.8;
/** Seconds of scene time ignored at the start of every visit. */
export const COVE_FPS_WARMUP_S = 2.0;
/** Seconds of frames sampled after the warm-up. */
export const COVE_FPS_SAMPLE_S = 5.0;
/** Frames needed before a decision, so one long pause cannot decide alone. */
export const COVE_FPS_MIN_SAMPLES = 30;
/** Longest frames dropped before the mean (stalls, pauses, compiles). */
export const COVE_FPS_TRIM_FRACTION = 0.05;
/** Sample buffer capacity (frames). A machine that fills it is fast. */
export const COVE_FPS_SAMPLE_CAPACITY = 1024;

/** FPS below which the fallback is chosen, for a stage frame cap (null = none). */
export function coveFpsThreshold(fpsCap: number | null): number {
  if (fpsCap === null || !(fpsCap > 0)) return COVE_FPS_FALLBACK_THRESHOLD;
  return Math.min(COVE_FPS_FALLBACK_THRESHOLD, fpsCap * COVE_FPS_CAPPED_THRESHOLD_FRACTION);
}

export interface CoveFpsDecision {
  /** Frames per second from the trimmed mean frame time (the decision). */
  fps: number;
  /** Plain mean FPS over every sampled frame (reported, not decided on). */
  rawFps: number;
  /** Frames the decision used (after trimming). */
  frames: number;
  /** The threshold it was compared with. */
  threshold: number;
  /** True when the machine is below the threshold. */
  fallback: boolean;
}

/**
 * Decide from the first `count` deltas (seconds) in `samples`. Sorts that
 * range IN PLACE (no buffer copy; a subarray view and the small result object
 * are the only allocations); call once per sample window.
 */
export function decideCoveFallback(
  samples: Float64Array,
  count: number,
  threshold: number,
): CoveFpsDecision {
  const n = Math.min(count, samples.length);
  if (n === 0) return { fps: 0, rawFps: 0, frames: 0, threshold, fallback: false };
  const view = samples.subarray(0, n);
  view.sort();
  const keep = n - Math.floor(n * COVE_FPS_TRIM_FRACTION);
  let sum = 0;
  for (let i = 0; i < keep; i++) sum += view[i];
  const meanFrame = sum / keep;
  let total = sum;
  for (let i = keep; i < n; i++) total += view[i];
  const fps = meanFrame > 0 ? 1 / meanFrame : Infinity;
  const rawFps = total > 0 ? n / total : Infinity;
  return { fps, rawFps, frames: keep, threshold, fallback: fps < threshold };
}

/**
 * Per-mount sampler. Feed it every accepted frame delta with `push`; call
 * `startVisit` whenever the scene becomes active. Allocation-free per frame.
 */
export class CoveFpsSampler {
  readonly threshold: number;
  private readonly samples = new Float64Array(COVE_FPS_SAMPLE_CAPACITY);
  private count = 0;
  private sampleTime = 0;
  private warmup = 0;
  private decided = false;

  constructor(fpsCap: number | null) {
    this.threshold = coveFpsThreshold(fpsCap);
  }

  /** True once a decision was made; the sampler then ignores frames. */
  get isDecided(): boolean {
    return this.decided;
  }

  /** A new visit (scene became active): drop any unfinished sample and warm up again. */
  startVisit(): void {
    if (this.decided) return;
    this.count = 0;
    this.sampleTime = 0;
    this.warmup = 0;
  }

  /** Returns the decision on the frame that completes the sample, else null. */
  push(delta: number): CoveFpsDecision | null {
    if (this.decided || !(delta >= 0)) return null;
    if (this.warmup < COVE_FPS_WARMUP_S) {
      this.warmup += delta;
      return null;
    }
    if (this.count < COVE_FPS_SAMPLE_CAPACITY) {
      this.samples[this.count] = delta;
      this.count += 1;
    }
    this.sampleTime += delta;
    if (this.sampleTime < COVE_FPS_SAMPLE_S || this.count < COVE_FPS_MIN_SAMPLES) return null;
    this.decided = true;
    return decideCoveFallback(this.samples, this.count, this.threshold);
  }
}
