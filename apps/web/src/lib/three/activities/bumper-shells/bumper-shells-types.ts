/**
 * bumper-shells-types.ts
 *
 * Local TypeScript interfaces for the Bumper Shells scene.
 *
 * ─── Coordination contract with general-purpose agent ────────────────────────
 *
 * The scene reads from `@/stores/activity` (ActivityStateForScene below).
 * General-purpose owns the WRITER side — the store + WS client that hydrates it
 * from incoming `ServerFrame` messages. The 3D scene is the READER only.
 *
 * Store import path (general-purpose will create this file):
 *   import { useActivityStore } from '@/stores/activity';
 *
 * Store shape the scene needs:
 *
 *   interface ActivityStateForScene {
 *     selfAvatarId: string | null;
 *     entities: Map<string, {
 *       avatarId: string;
 *       x: number;       // wu (world units, sim-space)
 *       y: number;       // wu (z in 3D)
 *       rot: number;     // radians
 *       vx: number;
 *       vy: number;
 *       alive: boolean;
 *       color?: string;  // hex tint for shell
 *       species?: string;
 *     }>;
 *     pickups: Map<string, {
 *       spawnId: string;
 *       kind: 'speed' | 'shield' | 'sticky-bomb' | 'whirlpool' | 'ghost' | 'tractor';
 *       x: number;
 *       y: number;
 *     }>;
 *     events: {
 *       hits: Array<{ at: number; x: number; y: number; power: number }>;
 *       eliminations: Array<{ at: number; avatarId: string }>;
 *     };
 *     matchPhase: 'pregame-countdown' | 'live' | 'ended';
 *     countdownSecondsRemaining: number;
 *     roundEndsAt: number | null;
 *   }
 *
 * The scene subscribes with `useActivityStore(state => state.entities)` etc.
 * High-frequency fields (entities) must be held in a Map for O(1) lookup in useFrame.
 *
 * ─── WS protocol source of truth ─────────────────────────────────────────────
 * See `packages/shared/src/activities/protocol.ts` — EntityDelta, PowerUpDelta,
 * ServerFrame. The store writer translates those deltas into this flat shape.
 */

// ─── Entity state the scene reads per player ─────────────────────────────────

export interface BumperShellEntity {
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
  /** Optional hex string tint applied to the shell material. */
  color?: string;
  /** 'lobster' | 'crayfish' — determines which GLB clone is used. */
  species?: string;
  /**
   * Reef Race Phase 1 — current drift charge tier (0..3). Optional —
   * Bumper Shells entities never set it. The store mirrors this from
   * `EntityDelta.changed.driftSparks` for the SELF avatar so the HUD can
   * subscribe to a primitive number selector. Audit S11 — first-insert
   * branch initialises this to 0 so a body that ships its first delta
   * with a non-zero value still surfaces correctly to consumers.
   */
  driftSparks?: 0 | 1 | 2 | 3;
  /**
   * Reef Race v2 (spline sim) — within-lap arclength progress (0..1) and
   * total lap count. Optional — Bumper Shells never sets these. Mirrored
   * from `EntityDelta.changed.progress`/`.totalLaps` by `applyEntityDelta`.
   */
  progress?: number;
  totalLaps?: number;
  /** Reef Race v2 — body height above the river bed in wu. */
  height?: number;
  /** Reef Race v2 — latest server-authoritative effective speed multiplier. */
  speedMod?: number;
  /** Reef Race v2 — true while any positive boost source is active. */
  boosting?: boolean;
  /** Reef Race v2 — true while server authority has the racer wiped out. */
  wipedOut?: boolean;
}

// ─── Pickup state ─────────────────────────────────────────────────────────────

export type BumperPickupKind =
  | 'speed'
  | 'shield'
  | 'sticky-bomb'
  | 'whirlpool'
  | 'ghost'
  | 'tractor';

export interface BumperPickup {
  spawnId: string;
  kind: BumperPickupKind;
  /** Sim-space X → Three.js X */
  x: number;
  /** Sim-space Y → Three.js Z */
  y: number;
}

// ─── Hit event ────────────────────────────────────────────────────────────────

export interface BumperHitEvent {
  /** Server timestamp in ms (Date.now() from backend). */
  at: number;
  /** Impact position in Three.js world-space X. */
  x: number;
  /** Impact position in Three.js world-space Z. */
  y: number;
  /** Knockback power (0–1 normalised, used for burst radius scaling). */
  power: number;
  /** avatarId of the shell that dealt the hit (higher-velocity body at impact). */
  srcAvatarId?: string;
  /** avatarId of the shell that received the hit (lower-velocity body at impact). */
  dstAvatarId?: string;
}

// ─── Elimination event ────────────────────────────────────────────────────────

export interface BumperEliminationEvent {
  at: number;
  avatarId: string;
}

// ─── Match phase ─────────────────────────────────────────────────────────────

export type BumperMatchPhase = 'pregame-countdown' | 'live' | 'ended';

// ─── Squash/stretch animation state (per player, managed by BumperShellsPlayer) ──

export interface ShellHitAnimState {
  active: boolean;
  /** Elapsed time in seconds since hit (0 = just hit). */
  elapsed: number;
}

// ─── Burst pool slot (managed by BumperShellsParticles) ──────────────────────

export interface BurstSlot {
  active: boolean;
  startedAt: number;
  color: string;
  /** Three.js world-space position of the burst origin. */
  x: number;
  y: number; // Three.js Y (ground level = 6 for top of disc)
  z: number; // Three.js Z
  /** Directional spread vectors (pre-computed at activation, not per-frame). */
  directions: Float32Array; // 16 * 3 floats
}
