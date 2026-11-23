import { buildingZones, MAP_WIDTH, MAP_HEIGHT, TILE_SIZE } from '@/lib/pixi/tilemap-data';

/**
 * Measured from the shipped office-v3 GLB: meshopt decoded with NodeIO,
 * normalized POSITION transformed by the node matrix, UV barycentric samples
 * (16 steps/triangle) read from the pipeline base.png. Select +Z-facing
 * triangles (normal.z > 0.7), x within +/-0.38, y -0.55..0.19, z 0..0.25.
 * Pink mask: r>170, r-g>55, 80<b<r. 15,843 samples give bounds
 * x -0.318922..0.314127, y -0.545518..0.127838, z 0.002825..0.249299.
 * XY midpoint (-0.002397,-0.208840); enclosing radius 0.355944.
 * Use radius 0.365 and plane z=0.26 (7.89 wu ahead of sampled facade).
 * Model normal (0,0,1); the selected central surface excludes the orbit arms.
 * Full decoded bbox: (-0.950551,-0.683793,-0.704027) to
 * (0.948393,0.680071,0.700637). Match computeBuildingScale and pivot correction.
 */
export const OFFICE_VORTEX_MODEL = Object.freeze({ x: -0.002397, y: -0.208840, z: 0.26, radius: 0.365 });
export const OFFICE_YAW = -2.093;
const SCALE = 1400 / (0.948392927646637 + 0.9505509734153748);
const zone = buildingZones.find((item) => item.id === 'api-integrations')!;
export const OFFICE_CENTER = Object.freeze({
  x: (zone.x + zone.width / 2) * TILE_SIZE - MAP_WIDTH / 2,
  z: (zone.y + zone.height / 2) * TILE_SIZE - MAP_HEIGHT / 2,
});
export const OFFICE_NORMAL = Object.freeze({ x: Math.sin(OFFICE_YAW), z: Math.cos(OFFICE_YAW) });
const modelX = (OFFICE_VORTEX_MODEL.x + 0.0010790228843688965) * SCALE;
const modelZ = (OFFICE_VORTEX_MODEL.z + 0.0016949772834777832) * SCALE;
export const OFFICE_VORTEX_WORLD = Object.freeze({
  x: OFFICE_CENTER.x + modelX * Math.cos(OFFICE_YAW) + modelZ * Math.sin(OFFICE_YAW),
  y: -2 + (OFFICE_VORTEX_MODEL.y + 0.6837932804702465) * SCALE,
  z: OFFICE_CENTER.z - modelX * Math.sin(OFFICE_YAW) + modelZ * Math.cos(OFFICE_YAW),
  radius: OFFICE_VORTEX_MODEL.radius * SCALE,
});
/** The shared collider corridor stops at depth 350; the trigger is in front
 * of that solid end. No walkable point enters the facade at depth 193.
 * halfWidth covers the corridor's walkable width (its walls sit at +/-160 wu
 * lateral; the stair-step rows only narrow it), so every path up the corridor
 * crosses the trigger before the solid end.
 */
export const OFFICE_TRIGGER = Object.freeze({ near: 420, far: 500, halfWidth: 160 });
export const OFFICE_EXIT_WORLD = Object.freeze({
  x: OFFICE_CENTER.x + OFFICE_NORMAL.x * 650,
  z: OFFICE_CENTER.z + OFFICE_NORMAL.z * 650,
});
export function isInsideOfficeVortex(x: number, z: number): boolean {
  const dx = x - OFFICE_CENTER.x, dz = z - OFFICE_CENTER.z;
  const depth = dx * OFFICE_NORMAL.x + dz * OFFICE_NORMAL.z;
  const side = dx * OFFICE_NORMAL.z - dz * OFFICE_NORMAL.x;
  return depth >= OFFICE_TRIGGER.near && depth <= OFFICE_TRIGGER.far && Math.abs(side) <= OFFICE_TRIGGER.halfWidth;
}
// Only the two local locomotion writers stamp this segment. Placement APIs do not.
let motionPending = false, motionFromX = 0, motionFromZ = 0, motionToX = 0, motionToZ = 0;
export function recordOfficeLocomotion(fromX: number, fromZ: number, toX: number, toZ: number): void {
  motionPending = true; motionFromX = fromX; motionFromZ = fromZ; motionToX = toX; motionToZ = toZ;
}
export function consumeOfficeLocomotion(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
  const matches = motionPending && Math.abs(fromX - motionFromX) < 0.001 && Math.abs(fromZ - motionFromZ) < 0.001
    && Math.abs(toX - motionToX) < 0.001 && Math.abs(toZ - motionToZ) < 0.001;
  motionPending = false; return matches;
}
export interface OfficeDoorEdge { initialized: boolean; inside: boolean; allowed: boolean; x: number; z: number }
/** Always sample blocked frames. A spawn, warp, or blocked crossing never arms a deferred entry. */
export function stepOfficeDoorEdge(edge: OfficeDoorEdge, x: number, z: number, allowed: boolean, walked: boolean): boolean {
  const inside = isInsideOfficeVortex(x, z);
  const continuous = Math.hypot(x - edge.x, z - edge.z) <= 90;
  const fire = edge.initialized && edge.allowed && !edge.inside && inside && allowed && walked && continuous;
  edge.initialized = true; edge.inside = inside; edge.allowed = allowed; edge.x = x; edge.z = z;
  return fire;
}
let returnFacing: number | null = null;
export function setOfficeReturnFacing(): void { returnFacing = OFFICE_YAW; }
export function consumeOfficeReturnFacing(): number | null {
  const value = returnFacing; returnFacing = null; return value;
}
