/**
 * adaptive-quality-governor.ts — the world's FPS-driven ground-cover tier.
 *
 * Tier 0 = full quality; tier 1 = groundCover hidden (seaweed, kelp forest,
 * seabed decorations). The governor never touches activityFx or labels.
 *
 * Sampling: one rAF frame count per QUALITY_SAMPLE_MS window.
 * QUALITY_DEGRADE_SAMPLES consecutive windows below QUALITY_FPS_DOWN
 * degrade to tier 1 (a window at or above it resets the run);
 * QUALITY_RECOVER_SAMPLES consecutive windows at or above QUALITY_FPS_UP
 * recover one tier. The SECOND degrade of a session latches tier 1 (anti-flap).
 *
 * Why 2 windows below 55 (web-load T11, staging 4fe13447, headless runs
 * v4-A1..A5 / L1..L3 / B1..B5): the old rule (one window below 58) degraded on
 * 5 missed frames at 60 Hz. 9 of 13 trigger windows lost <= 9 frames, and
 * tier 1 did not lower the dip rate (windows < 58: 7.4% at tier 0, 11.8% at
 * tier 1), so the rule latched in 5/5 phase offsets on A2-A5, L2 and L3. Replayed
 * with 2 consecutive windows < 55, only A2 (heavy pollers) latched; the 4x
 * slow runs (windows at 4.8-19.2 FPS) still degraded 5/5.
 *
 * After arming, the post-load work signal is NOT read: every window counts.
 * A per-window busy skip was tried and removed (Codex E3 on 58d7d91b): work
 * that starts and ends between two frames is invisible to a per-frame poll
 * while its lost frames still count, and a brief job in every window could
 * skip every window, so a 40 FPS machine would never degrade. The replay of
 * the recorded runs showed no gain from it.
 *
 * Post-load gate (web-load T8): no frame counts until the world has finished
 * LOADING. Local prod build at 1342805d (RTX 3080, 3/3 cold loads): the
 * loader was dismissed at ~6 s, but post-load work (stream members, deferred
 * GPU warms, the seabed decoration warm) ran to ~17 s with 500 ms buckets at
 * 34-56 FPS. Sampling that load degraded to tier 1 at 9.3-11.8 s; the later
 * recovery plus one more dip latched tier 1 for the session. The gate opens
 * once the loader is dismissed AND the caller's post-load work signal stays
 * quiet for QUALITY_POST_LOAD_SETTLE_MS, or QUALITY_POST_LOAD_CEILING_MS after
 * the loader's own dismissal time (so post-load work that never goes quiet cannot disable the
 * governor). The gate opens once per governor; later stage visits only
 * restart the warmup.
 *
 * Pure state machine (no React, no DOM): World3DCanvas feeds it rAF
 * timestamps. No allocation per frame.
 */

export const QUALITY_SAMPLE_MS = 2500;
export const QUALITY_WARMUP_MS = 5000;
export const QUALITY_FPS_DOWN = 55;
/** Consecutive windows (after the warmup) below QUALITY_FPS_DOWN before a degrade. */
export const QUALITY_DEGRADE_SAMPLES = 2;
// Recovery threshold: 59 FPS is reachable on a 60 Hz display (vsync permits it).
// The old 90 threshold was unreachable at vsync, creating a one-way ratchet.
export const QUALITY_FPS_UP = 59;
// Only one degradation tier: hide groundCover (seaweed / decorations).
// activityFx and labels are gameplay-functional and must never be auto-degraded.
export const QUALITY_MAX_TIER = 1;
/** Consecutive stable-high samples (~7.5 s) before a recovery. */
export const QUALITY_RECOVER_SAMPLES = 3;
/** Post-load work must stay quiet this long before the first counted frame. */
export const QUALITY_POST_LOAD_SETTLE_MS = 3000;
/** After the loader dismissal, the gate opens at the latest after this long. */
export const QUALITY_POST_LOAD_CEILING_MS = 30_000;

export interface QualityGovernorSignals {
  /** The loader's own dismissal time (performance.now() timeline), or null while it is up. */
  getLoadingDismissedAt(): number | null;
  /** True while no post-load work (stream members, GPU warm jobs) is pending.
   * Read every frame until the gate opens, never after. Must not allocate. */
  isPostLoadQuiet(): boolean;
}

export interface QualityGovernor {
  /** Restart the sample window and the warmup (each effect start). */
  resume(now: number): void;
  /** Count one rAF frame. Returns the new tier when it changed, else null. */
  frame(now: number): number | null;
  readonly tier: number;
  readonly latched: boolean;
  /** True once the post-load gate opened (frames count from then on). */
  readonly armed: boolean;
}

export function createQualityGovernor(
  initialTier: number,
  signals: QualityGovernorSignals,
): QualityGovernor {
  let tier = initialTier;
  let degradeCount = 0;
  let latched = false;
  let stableHighSamples = 0;
  let lowSamples = 0;
  let frames = 0;
  let sampleStart = 0;
  let startedAt = 0;
  let armed = false;
  let dismissedAt: number | null = null;
  let quietSince: number | null = null;

  /** Post-load gate. While closed, the sample window restarts every frame. */
  const gateOpen = (now: number): boolean => {
    if (armed) return true;
    if (dismissedAt === null) {
      // The ceiling counts from the LOADER's dismissal time, not from the
      // first frame that observes it: when the world scene was inactive at
      // dismissal (a stage visit), the first frame can come much later
      // (Codex E3 on 9ec8bd50).
      dismissedAt = signals.getLoadingDismissedAt();
      if (dismissedAt === null) return false;
    }
    if (!signals.isPostLoadQuiet()) {
      quietSince = null;
    } else if (quietSince === null) {
      quietSince = now;
    }
    const settled = quietSince !== null && now - quietSince >= QUALITY_POST_LOAD_SETTLE_MS;
    if (!settled && now - dismissedAt < QUALITY_POST_LOAD_CEILING_MS) return false;
    armed = true;
    return true;
  };

  return {
    get tier() {
      return tier;
    },
    get latched() {
      return latched;
    },
    get armed() {
      return armed;
    },
    resume(now: number) {
      frames = 0;
      sampleStart = now;
      startedAt = now;
      stableHighSamples = 0;
      lowSamples = 0;
    },
    frame(now: number): number | null {
      if (!gateOpen(now)) {
        // Load-time frames never enter a sample: the first counted window
        // starts at the first frame after the gate opened.
        frames = 0;
        sampleStart = now;
        return null;
      }
      frames++;
      const elapsed = now - sampleStart;
      if (elapsed < QUALITY_SAMPLE_MS) return null;
      const fps = (frames * 1000) / elapsed;
      const warmed = now - startedAt >= QUALITY_WARMUP_MS;
      frames = 0;
      sampleStart = now;

      if (!latched && warmed) lowSamples = fps < QUALITY_FPS_DOWN ? lowSamples + 1 : 0;
      if (!latched && warmed && lowSamples >= QUALITY_DEGRADE_SAMPLES && tier < QUALITY_MAX_TIER) {
        tier = QUALITY_MAX_TIER;
        stableHighSamples = 0;
        lowSamples = 0;
        degradeCount += 1;
        // Second degrade in the same session: lock tier for the rest of the session.
        if (degradeCount >= 2) latched = true;
        return tier;
      }
      if (!latched && warmed && fps >= QUALITY_FPS_UP && tier > 0) {
        stableHighSamples += 1;
        if (stableHighSamples >= QUALITY_RECOVER_SAMPLES) {
          tier -= 1;
          stableHighSamples = 0;
          lowSamples = 0;
          return tier;
        }
        return null;
      }
      if (fps < QUALITY_FPS_UP) stableHighSamples = 0;
      return null;
    },
  };
}

/** The world's post-load work sources (World3DCanvas passes the real ones). */
export interface PostLoadWorkProbes {
  /** decorative-release getLoadingDismissedAt(). */
  loadingDismissedAt(): number | null;
  /** Every boot stream cohort member terminal (getStreamSettledAt() !== null). */
  streamSettled(): boolean;
  /** No deferred GPU warm job queued or running (isDeferredWarmQueueIdle()). */
  warmQueueIdle(): boolean;
  /** The seabed decoration GLB warm read (fetch + parse outside React) has not
   * finished: the decorations are not in the stream cohort and enqueue their
   * GPU warm only after it (Codex E3 on 9ec8bd50). */
  decorationWarmReadPending(): boolean;
}

/** Combine the probes into the governor's signals. Allocates once. */
export function worldQualitySignals(p: PostLoadWorkProbes): QualityGovernorSignals {
  return {
    getLoadingDismissedAt: p.loadingDismissedAt,
    isPostLoadQuiet: () =>
      p.streamSettled() && p.warmQueueIdle() && !p.decorationWarmReadPending(),
  };
}
