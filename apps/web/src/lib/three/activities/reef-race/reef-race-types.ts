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
 *     petId: string;
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
 *     laps: Map<string, RaceEntityLap[]>;  // petId → lap records
 *     selfBestGhostPath: GhostFrame[] | null;
 *   }
 *
 * ─── WS protocol ─────────────────────────────────────────────────────────────
 * event.lap_completed → pushLap() action in store.
 * entity position deltas include lap/nextCheckpoint/finishedAt fields from sim.
 */

// ─── Racer entity state the scene reads ──────────────────────────────────────

export interface ReefRaceEntity {
  petId: string;
  /** Sim-space X → Three.js X */
  x: number;
  /** Sim-space Y → Three.js Z */
  y: number;
  rot: number;
  vx: number;
  vy: number;
  alive: boolean;
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
}

// ─── Ghost replay frame ───────────────────────────────────────────────────────

export interface GhostFrame {
  /** Server time in ms at which this frame was recorded. */
  t: number;
  x: number;
  /** Three.js Z (sim Y) */
  z: number;
  rot: number;
}

// ─── Lap completion record (one per lap per player) ──────────────────────────

export interface RaceEntityLap {
  petId: string;
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
