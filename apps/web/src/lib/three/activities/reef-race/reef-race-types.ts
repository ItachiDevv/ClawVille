/**
 * reef-race-types.ts
 *
 * Local TypeScript interfaces for the Reef Race 3D scene.
 *
 * ─── Coordination contract with activity store ────────────────────────────────
 *
 * The scene is a READER of `@/stores/activity`. Reef Race extends the store's
 * Entity interface with optional lap/checkpoint/finish fields (chunk #6 additive
 * extension — Bumper Shells consumers unaffected). Ghost data lives in the
 * `reefRace` slice added in activity.ts.
 *
 * Entity fields the scene reads:
 *   {
 *     avatarId: string;
 *     x: number;         // sim-space X → Three.js X
 *     y: number;         // sim-space Y → Three.js Z
 *     rot: number;       // radians
 *     vx: number;
 *     vy: number;
 *     alive: boolean;
 *     color?: string;    // hex tint for kart
 *     species?: string;  // 'sea_horse' | 'lobster' fallback
 *     // Reef Race extensions (may be undefined on Bumper Shells frames)
 *     lap?: number;
 *     nextCheckpoint?: number;
 *     finishedAt?: number;     // unix ms
 *     totalTimeMs?: number;
 *     bestLapMs?: number;
 *   }
 *
 * Ghost slice the scene reads:
 *   reefRace: {
 *     laps: Map<string, RaceEntityLap[]>;  // avatarId → lap records
 *     selfBestGhostPath: GhostFrame[] | null;
 *   }
 *
 * ─── WS protocol ─────────────────────────────────────────────────────────────
 * event.lap_completed → pushLap() action in store.
 * entity position deltas include lap/nextCheckpoint/finishedAt fields from sim.
 */

// ─── Racer entity state the scene reads ──────────────────────────────────────

export interface ReefRaceEntity {
  avatarId: string;
  /** Sim-space X → Three.js X */
  x: number;
  /** Sim-space Y → Three.js Z */
  y: number;
  rot: number;
  vx: number;
  vy: number;
  alive: boolean;
  /** Authoritative sample time mapped onto the client's performance clock. */
  snapshotAtMs?: number;
  /** Optional hex string tint applied to the kart material. */
  color?: string;
  /** 'sea_horse' | 'lobster' — determines which GLB clone is used. */
  species?: string;
  /** Current lap number (1-indexed). */
  lap?: number;
  /** Index of the next checkpoint the racer must pass. */
  nextCheckpoint?: number;
  /** Unix timestamp (ms) when the racer crossed the finish line. */
  finishedAt?: number;
  /** Total race time in ms (only set after finishing). */
  totalTimeMs?: number;
  /** Best single-lap time in ms. */
  bestLapMs?: number;
  /**
   * v2 CLOSED-LOOP spline sim — within-lap arclength progress (0..1).
   * Forwarded from `EntityDelta.changed.progress` by `applyEntityDelta`
   * (bug fix 2026-07-10 — this field existed on the wire and was already
   * read by the HUD's ProgressBar/BestLapTile via `as any`, but the store
   * never actually copied it onto the entity map, so it always read
   * `undefined`). See `applyEntityDelta` in `stores/activity.ts`.
   */
  progress?: number;
  /** v2 CLOSED-LOOP spline sim — total laps in the race (bug-fix, see `progress`). */
  totalLaps?: number;
  /** v2 spline sim — body height above the river bed in wu (jump/ramp airborne offset). */
  height?: number;
  /**
   * v2 spline sim - latest server-authoritative effective speed multiplier.
   * Self prediction consumes this for presentation parity; authority stays server-side.
   */
  speedMod?: number;
  /**
   * v2 mechanics — true while ANY positive boost is active for this body
   * (boost pad / launch / slipstream). Drives the trail/speed-
   * cone FX via `ReefRaceBoostFX` (OR'd into the existing item-boost
   * `boostActive` computation in `ReefRaceScene.tsx`).
   */
  boosting?: boolean;
}

// ─── Ghost replay frame ───────────────────────────────────────────────────────
//
// Phase 4 — moved canonical declaration into `@clawville/shared` so the
// server (capture path in `reef-race-personal-best-service.ts` +
// `reef-race-sim.ts`) and the client (playback in `ReefRaceGhost.tsx` +
// store hydration) reference the SAME type. We re-export here to keep
// existing imports (`./reef-race-types`) working unchanged.
//
// `t` is now lap-relative milliseconds (lap start = 0) so the ghost loops
// cleanly regardless of when the original PB was set.
export type { GhostFrame } from '@clawville/shared';

// ─── Lap completion record (one per lap per player) ──────────────────────────

export interface RaceEntityLap {
  avatarId: string;
  lap: number;
  splitMs: number;
  totalMs: number;
  recordedAt: number; // local Date.now()
}

// ─── Match phase (mirrors Bumper naming convention) ──────────────────────────

export type ReefRaceMatchPhase = 'pregame-countdown' | 'live' | 'ended';

// ─── Pickup box instance state ────────────────────────────────────────────────

export interface PickupBoxSlot {
  spawnId: string | null;
  /** True when the box is visible (active spawn on track). */
  active: boolean;
  x: number;
  z: number; // Three.js Z (sim Y)
}

// ─── Boost trail state (managed by ReefRaceBoostFX) ──────────────────────────

export interface TrailState {
  active: boolean;
  /** Ring-buffer write head. */
  head: number;
  /** Flat xyz buffer: TRAIL_MAX_POINTS * 3 floats. */
  positions: Float32Array;
  /** How many valid points are in the buffer (ramps up from 0). */
  count: number;
}
