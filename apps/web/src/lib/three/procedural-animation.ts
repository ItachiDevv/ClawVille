import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Procedural animation system for GLB characters without skeletal animations
// Applies squash/stretch, tilt, bob, and sway to make characters feel alive
// ---------------------------------------------------------------------------

export interface AnimationState {
  /** Root group ref to animate */
  group: THREE.Group;
  /** Whether the character is currently moving */
  isMoving: boolean;
  /** Elapsed time from clock */
  elapsed: number;
  /** Continuous speed-matched phase for walk cycles */
  walkPhase?: number;
  /** Frame delta */
  delta: number;
  /** Movement direction string */
  direction: string;
  /** Unique seed for this character (prevents all NPCs from syncing) */
  seed: number;
}

/**
 * Apply walking animation — squash/stretch bounce, forward tilt, lean into turns.
 * Call this every frame when the character is moving.
 */
export function applyWalkAnimation(state: AnimationState): void {
  const { group, elapsed, walkPhase, seed } = state;
  const t = (walkPhase ?? elapsed) + seed;
  const walkSpeed = 8;

  // Bouncy walk cycle — exaggerated squash/stretch for cartoon feel
  const bounce = Math.sin(t * walkSpeed) * 0.18;
  const squashY = 1.0 + bounce;
  const squashXZ = 1.0 - bounce * 0.5;
  group.scale.set(squashXZ, squashY, squashXZ);

  // Forward tilt when walking — noticeable lean
  group.rotation.x = -0.15;

  // Lean into movement direction — visible side-to-side sway
  const lean = Math.sin(t * walkSpeed * 0.5) * 0.1;
  group.rotation.z = lean;
}

/**
 * Apply idle animation — gentle breathing, subtle sway, occasional shift.
 * Call this every frame when the character is NOT moving.
 */
export function applyIdleAnimation(state: AnimationState): void {
  const { group, elapsed, seed } = state;
  const t = elapsed + seed;

  // Visible breathing — scale oscillation you can actually see
  const breathe = Math.sin(t * 1.5) * 0.06;
  group.scale.set(1.0 - breathe * 0.4, 1.0 + breathe, 1.0 - breathe * 0.4);

  // Visible underwater sway — like floating in current
  const sway = Math.sin(t * 0.7) * 0.06 + Math.sin(t * 1.1) * 0.03;
  group.rotation.z = sway;

  // Forward/back rock
  group.rotation.x = Math.sin(t * 0.9) * 0.04;
}

/**
 * Apply location NPC idle animation — more expressive since they're stationary.
 * Includes looking around and occasional weight shifts.
 */
export function applyStationaryIdleAnimation(state: AnimationState): void {
  const { group, elapsed, seed } = state;
  const t = elapsed + seed;

  // Visible breathing
  const breathe = Math.sin(t * 1.2) * 0.07;
  group.scale.set(1.0 - breathe * 0.4, 1.0 + breathe, 1.0 - breathe * 0.4);

  // Pronounced sway — floating in underwater current
  const sway = Math.sin(t * 0.6) * 0.08 + Math.sin(t * 1.3 + 1.5) * 0.04;
  group.rotation.z = sway;

  // Looking around — relative sway around the parent group's current facing direction.
  // Do NOT add Math.PI here: the outer groupRef already has facingRotY baked in
  // (which includes the -Z model correction). Adding PI again would flip all NPCs 180°.
  const lookAround = Math.sin(t * 0.3) * 0.2 + Math.sin(t * 0.7 + 2.0) * 0.1;
  group.rotation.y = lookAround;

  // Weight shift — forward lean
  group.rotation.x = Math.sin(t * 0.5) * 0.05;
}

/**
 * Generate a stable seed from an ID string — for consistent per-character timing offsets.
 */
export function idToSeed(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 1000) / 100; // 0..10 range
}
