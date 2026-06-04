/**
 * reef-race-self-bus.ts
 *
 * Two tiny module-scope singletons that let the SELF player's input + rendered
 * pose flow between otherwise-decoupled subsystems without threading props or
 * incurring React re-renders. Both are read/written exclusively inside RAF /
 * 30 Hz timers — never during React render — so a plain mutable object is the
 * right primitive (no store, no allocation churn).
 *
 * Gated entirely behind `NEXT_PUBLIC_REEF_RACE_USE_SPLINE === 'true'` at the
 * call sites. When the v2 spline path is off (v1 ellipse), nothing writes the
 * buses and `valid` stays false, so every consumer falls back to its existing
 * server-interp behaviour. Reversible by flipping the env flag.
 *
 * ─── selfInputBus ─────────────────────────────────────────────────────────────
 * Written by the reef-race branch of `useActivityInput`'s 30 Hz send loop with
 * the SAME smoothed dir/thrust it ships on the wire (mapped sim {x,y} → {x,z}).
 * Read by `ReefRacePlayer` (self) so client prediction integrates the identical
 * intent the server will integrate — keeping prediction + authority consistent.
 *
 * ─── selfPoseBus ──────────────────────────────────────────────────────────────
 * Written by `ReefRacePlayer` (self) each frame with the RENDERED predicted XZ +
 * heading. Read by `ChaseCamera` so the camera follows the exact same pose the
 * body renders at (one timebase) — killing the 100 ms-body / 200 ms-camera
 * rubber-band. Stale-guarded via `updatedAt` so the camera reverts to its own
 * interp the instant the self body stops writing (spectator, v1, no-self).
 */

/** Steering intent for client prediction. `dir` is XZ sim-space (z = forward). */
export interface SelfInputBus {
  /** Normalised steer dir in XZ, or null when not steering. */
  dir: { x: number; z: number } | null;
  /** Thrust 0..1 (0 when not moving). */
  thrust: number;
  /** True once the reef-race input loop has written at least once this session. */
  valid: boolean;
}

/** Rendered predicted pose of the self kart, for the chase camera to follow. */
export interface SelfPoseBus {
  /** World/sim X (entity.x space). */
  x: number;
  /** World/sim Z (entity.y space). */
  z: number;
  /** Heading (rad), Three.js group.rotation.y. */
  rot: number;
  /** True while the self player is actively writing this each frame. */
  valid: boolean;
  /** performance.now() of the last write — consumers stale-guard on this. */
  updatedAt: number;
}

/** Singleton input bus. Mutated in place — never reassigned. */
export const selfInputBus: SelfInputBus = {
  dir: null,
  thrust: 0,
  valid: false,
};

/** Singleton pose bus. Mutated in place — never reassigned. */
export const selfPoseBus: SelfPoseBus = {
  x: 0,
  z: 0,
  rot: 0,
  valid: false,
  updatedAt: 0,
};

/**
 * Max age (ms) a pose-bus write is considered fresh by the camera. Two missed
 * RAF frames (~33 ms) at 60 fps is comfortably under this; a value this large
 * tolerates a brief tab-throttle without the camera snapping to its own interp
 * mid-corner, while still reverting within ~0.15 s once the self body unmounts.
 */
export const SELF_POSE_BUS_STALE_MS = 150;

/** Reset the input bus to its neutral, invalid state (called on input teardown). */
export function resetSelfInputBus(): void {
  selfInputBus.dir = null;
  selfInputBus.thrust = 0;
  selfInputBus.valid = false;
}

/** Reset the pose bus to its neutral, invalid state (called on self-player teardown). */
export function resetSelfPoseBus(): void {
  selfPoseBus.x = 0;
  selfPoseBus.z = 0;
  selfPoseBus.rot = 0;
  selfPoseBus.valid = false;
  selfPoseBus.updatedAt = 0;
}
