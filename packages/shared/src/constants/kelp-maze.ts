/** Canonical world-space layout shared by rendering, player collision, and NPC A*. */

export interface KelpMazeWallAabb {
  readonly id: string;
  readonly centerX: number;
  readonly centerZ: number;
  readonly halfX: number;
  readonly halfZ: number;
}

export const KELP_MAZE_BOUNDS = Object.freeze({
  minX: 7328,
  maxX: 8320,
  minZ: -10384,
  maxZ: -9424,
});

export const KELP_MAZE_WALL_THICKNESS_WU = 24;

/**
 * Physical opening between wall AABBs. The live chibi/player half-width is
 * ENTITY_HALF_CHIBI=25 wu, so a 50-wu-wide body retains 25 wu total clearance
 * (12.5 wu per side). Openings are centered on 32-wu A* tile centers.
 */
export const KELP_MAZE_PATH_WIDTH_WU = 75;

export const KELP_MAZE_ENTRY = Object.freeze({
  side: 'south' as const,
  centerX: 7824,
  centerZ: KELP_MAZE_BOUNDS.maxZ,
  width: KELP_MAZE_PATH_WIDTH_WU,
  approachWorldX: 7824,
  approachWorldZ: -9360,
  insideWorldX: 7824,
  insideWorldZ: -9488,
});

export const KELP_MAZE_CLEARING = Object.freeze({
  centerX: 7824,
  centerZ: -10000,
  halfX: 240,
  halfZ: 160,
});

export const KELP_MAZE_LANDMARK = Object.freeze({
  worldX: KELP_MAZE_CLEARING.centerX,
  worldZ: KELP_MAZE_CLEARING.centerZ,
});

/**
 * Conservative AABB over the merged pearl/shell footprint. Measured relative
 * geometry bounds are x[-120,125.01], z[-105.09,94]; these extents include a
 * small visual/collision buffer while staying well inside the clearing.
 */
export const KELP_MAZE_LANDMARK_COLLIDER = Object.freeze({
  id: 'kelp-maze-pearl-shell-landmark',
  centerX: KELP_MAZE_LANDMARK.worldX,
  centerZ: KELP_MAZE_LANDMARK.worldZ,
  halfX: 132,
  halfZ: 112,
}) satisfies KelpMazeWallAabb;

/** Tile-center-aligned photo position west of the pearl, outside its chibi-expanded AABB. */
export const KELP_MAZE_PHOTO_SPOT = Object.freeze({
  worldX: 7600,
  worldZ: -10000,
});

/**
 * Eight stable AABBs form a south-entry switchback maze. Alternating 75-wu
 * gaps are aligned to A* cell centers: entry x=7824, east lane x=8272, and
 * west lane x=7376. No consumer may duplicate these numeric wall values.
 */
export const KELP_MAZE_WALLS = [
  { id: 'kelp-maze-outer-south-west', centerX: 7557.25, centerZ: -9424, halfX: 229.25, halfZ: 12 },
  { id: 'kelp-maze-outer-south-east', centerX: 8090.75, centerZ: -9424, halfX: 229.25, halfZ: 12 },
  { id: 'kelp-maze-outer-north', centerX: 7824, centerZ: -10384, halfX: 496, halfZ: 12 },
  { id: 'kelp-maze-outer-west', centerX: 7328, centerZ: -9904, halfX: 12, halfZ: 480 },
  { id: 'kelp-maze-outer-east', centerX: 8320, centerZ: -9904, halfX: 12, halfZ: 480 },
  { id: 'kelp-maze-switchback-south', centerX: 7780.5, centerZ: -9600, halfX: 452.5, halfZ: 12 },
  { id: 'kelp-maze-switchback-middle', centerX: 7867.5, centerZ: -9792, halfX: 452.5, halfZ: 12 },
  { id: 'kelp-maze-switchback-north', centerX: 7780.5, centerZ: -10240, halfX: 452.5, halfZ: 12 },
] as const satisfies readonly KelpMazeWallAabb[];

export const KELP_MAZE_WALL_COUNT = KELP_MAZE_WALLS.length;
export const KELP_MAZE_COLLIDER_COUNT = KELP_MAZE_WALL_COUNT + 1;
