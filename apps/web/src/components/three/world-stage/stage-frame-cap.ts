/**
 * Frame-cap admission for the stage scheduler (pure, allocation-free).
 *
 * With a frame cap (phones: 30 FPS), the scheduler admits a native frame
 * once `accMs` (time since the last admission plus the carried remainder)
 * reaches the interval, and carries the remainder so the AVERAGE admission
 * rate stays at the cap. That gating is unchanged here.
 *
 * What changed (2026-09-18): the delta handed to scene callbacks used to be
 * `accMs`, which INCLUDES the carried remainder, while the same remainder was
 * also carried into the next admission. So every carry was counted twice and,
 * whenever native frames were not an exact divisor of the interval (jank, a
 * 50 Hz display), scene time ran faster than wall time. Measured: at ~50 Hz
 * rAF the cove's FPS sampler saw 22 FPS for a real 30 (see
 * lib/three/cove-fps-sampler.ts). The delta is now `sinceAdmitMs`, the real
 * time since the last admitted frame (same 2-interval clamp as before).
 */
export interface FrameCapState {
  /** Gating accumulator: time since the last admission + carried remainder. */
  accMs: number;
  /** Real time since the last admitted frame (the delta handed to scenes). */
  sinceAdmitMs: number;
}

export function createFrameCapState(): FrameCapState {
  return { accMs: 0, sinceAdmitMs: 0 };
}

/**
 * Feed one native frame. Returns the scheduled delta in seconds when the frame
 * is admitted, or -1 when it is skipped. `recovery` admits one frame without
 * carrying a background-tab backlog (the caller clamps that frame's delta).
 */
export function stepFrameCap(
  state: FrameCapState,
  deltaMs: number,
  intervalMs: number,
  toleranceMs: number,
  recovery: boolean,
): number {
  const clampMs = intervalMs * 2;
  if (recovery) {
    state.accMs = intervalMs;
    state.sinceAdmitMs = intervalMs;
  } else {
    state.accMs = Math.min(state.accMs + deltaMs, clampMs);
    state.sinceAdmitMs = Math.min(state.sinceAdmitMs + deltaMs, clampMs);
  }
  if (state.accMs + toleranceMs < intervalMs) return -1;
  const scheduled = state.sinceAdmitMs / 1_000;
  state.accMs = Math.max(0, state.accMs - intervalMs);
  state.sinceAdmitMs = 0;
  return scheduled;
}
