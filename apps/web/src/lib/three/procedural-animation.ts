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
  const { group, elapsed, seed } = state;
  const t = elapsed + seed;
  const walkSpeed = 8;

  // Bouncy walk cycle — squash/stretch on Y
  const bounce = Math.sin(t * walkSpeed) * 0.08;
  const squashY = 1.0 + bounce;
  const squashXZ = 1.0 - bounce * 0.4; // compress width when stretching height
  group.scale.set(squashXZ, squashY, squashXZ);

  // Forward tilt when walking
  group.rotation.x = -0.08;

  // Lean into movement direction (subtle side tilt)
  const lean = Math.sin(t * walkSpeed * 0.5) * 0.04;
  group.rotation.z = lean;
}

/**
 * Apply idle animation — gentle breathing, subtle sway, occasional shift.
 * Call this every frame when the character is NOT moving.
 */
export function applyIdleAnimation(state: AnimationState): void {
  const { group, elapsed, seed } = state;
  const t = elapsed + seed;

  // Gentle breathing — slow Y scale oscillation
  const breathe = Math.sin(t * 1.5) * 0.02;
  group.scale.set(1.0 - breathe * 0.3, 1.0 + breathe, 1.0 - breathe * 0.3);

  // Subtle underwater sway
  const sway = Math.sin(t * 0.7) * 0.02 + Math.sin(t * 1.1) * 0.01;
  group.rotation.z = sway;

  // Slight forward/back rock
  group.rotation.x = Math.sin(t * 0.9) * 0.015;
}

/**
 * Apply location NPC idle animation — more expressive since they're stationary.
 * Includes looking around and occasional weight shifts.
 */
export function applyStationaryIdleAnimation(state: AnimationState): void {
  const { group, elapsed, seed } = state;
  const t = elapsed + seed;

  // Breathing
  const breathe = Math.sin(t * 1.2) * 0.025;
  group.scale.set(1.0 - breathe * 0.3, 1.0 + breathe, 1.0 - breathe * 0.3);

  // More pronounced sway — they're standing in one spot underwater
  const sway = Math.sin(t * 0.6) * 0.03 + Math.sin(t * 1.3 + 1.5) * 0.015;
  group.rotation.z = sway;

  // Head bob / looking around — periodic rotation on Y axis
  const lookAround = Math.sin(t * 0.3) * 0.12 + Math.sin(t * 0.7 + 2.0) * 0.06;
  group.rotation.y = Math.PI + lookAround; // Base facing camera (PI) + look variation

  // Occasional weight shift — forward lean
  group.rotation.x = Math.sin(t * 0.5) * 0.02;
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
