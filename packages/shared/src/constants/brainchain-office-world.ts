import { WORLD_CENTER_PX } from './world-dimensions';

/** Prop-class venue: never add this office to the teaching-building or boot cohorts. */
export const BRAINCHAIN_OFFICE_WORLD_CENTER = Object.freeze({ x: 760, z: -3040 });
export const BRAINCHAIN_OFFICE_HALF_X_WU = 300;
export const BRAINCHAIN_OFFICE_HALF_Z_WU = 250;
export const BRAINCHAIN_OFFICE_DOOR_WORLD = Object.freeze({ x: 760, z: -2790 });
export const BRAINCHAIN_OFFICE_DOOR_PROMPT_HALF_X_WU = 110;
export const BRAINCHAIN_OFFICE_DOOR_PROMPT_DEPTH_WU = 300;
export const BRAINCHAIN_OFFICE_GUIDE_WORLD = Object.freeze({ x: 540, z: -2640 });
export const BRAINCHAIN_OFFICE_GUIDE_TALK_RADIUS_WU = 220;
export const BRAINCHAIN_OFFICE_GUIDE_HALF_WU = 40;
export const BRAINCHAIN_OFFICE_GUIDE_ID = 'brainchain-office-guide';
/** Outside the solid footprint and its server navigation safety halo. */
export const BRAINCHAIN_OFFICE_APPROACH_WORLD = Object.freeze({ x: 760, z: -2600 });
export const BRAINCHAIN_OFFICE_DOOR_APPROACH_GAME = Object.freeze({
  x: WORLD_CENTER_PX.x + BRAINCHAIN_OFFICE_APPROACH_WORLD.x,
  y: WORLD_CENTER_PX.y + BRAINCHAIN_OFFICE_APPROACH_WORLD.z,
});
export const BRAINCHAIN_OFFICE_GUIDE_APPROACH_GAME = Object.freeze({
  x: WORLD_CENTER_PX.x + BRAINCHAIN_OFFICE_GUIDE_WORLD.x - 150,
  y: WORLD_CENTER_PX.y + BRAINCHAIN_OFFICE_GUIDE_WORLD.z + 100,
});
export const BRAINCHAIN_OFFICE_ARRIVAL_RADIUS_WU = 96;

export function isBrainchainOfficeDoorWorld(x: number, z: number): boolean {
  return Math.abs(x - BRAINCHAIN_OFFICE_DOOR_WORLD.x) <= BRAINCHAIN_OFFICE_DOOR_PROMPT_HALF_X_WU
    && z >= BRAINCHAIN_OFFICE_DOOR_WORLD.z
    && z <= BRAINCHAIN_OFFICE_DOOR_WORLD.z + BRAINCHAIN_OFFICE_DOOR_PROMPT_DEPTH_WU;
}

export function isBrainchainOfficeGuideWorld(x: number, z: number): boolean {
  if (isBrainchainOfficeDoorWorld(x, z)) return false;
  const dx = x - BRAINCHAIN_OFFICE_GUIDE_WORLD.x;
  const dz = z - BRAINCHAIN_OFFICE_GUIDE_WORLD.z;
  return dx * dx + dz * dz <= BRAINCHAIN_OFFICE_GUIDE_TALK_RADIUS_WU ** 2;
}

/** Shared exclusion for procedural ground cover, the doorway, and the guide. */
export function isBrainchainOfficeGroundCoverExcluded(x: number, z: number): boolean {
  return (Math.abs(x - BRAINCHAIN_OFFICE_WORLD_CENTER.x) < BRAINCHAIN_OFFICE_HALF_X_WU + 200
    && Math.abs(z - BRAINCHAIN_OFFICE_WORLD_CENTER.z) < BRAINCHAIN_OFFICE_HALF_Z_WU + 200)
    || Math.hypot(x - BRAINCHAIN_OFFICE_APPROACH_WORLD.x, z - BRAINCHAIN_OFFICE_APPROACH_WORLD.z) < 360
    || Math.hypot(x - BRAINCHAIN_OFFICE_GUIDE_WORLD.x, z - BRAINCHAIN_OFFICE_GUIDE_WORLD.z) < 420;
}

type Footprint = Readonly<{ id: string; centerX: number; centerZ: number; halfX: number; halfZ: number }>;

/** Independent AABB clearance; accepts existing geometry without a circular import. */
export function brainchainOfficeColliderClearance(collider: Footprint): number {
  const dx = Math.max(0, Math.abs(BRAINCHAIN_OFFICE_WORLD_CENTER.x - collider.centerX) - BRAINCHAIN_OFFICE_HALF_X_WU - collider.halfX);
  const dz = Math.max(0, Math.abs(BRAINCHAIN_OFFICE_WORLD_CENTER.z - collider.centerZ) - BRAINCHAIN_OFFICE_HALF_Z_WU - collider.halfZ);
  return Math.hypot(dx, dz);
}

export function assertBrainchainOfficePlacement(colliders: readonly Footprint[]): void {
  for (const collider of colliders) {
    if (collider.id === 'brainchain-office' || collider.id === BRAINCHAIN_OFFICE_GUIDE_ID) continue;
    const clearance = brainchainOfficeColliderClearance(collider);
    if (clearance < 200) throw new Error(`BrainChain Office clearance from ${collider.id}: ${clearance} wu; minimum 200 wu`);
  }
}
