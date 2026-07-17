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
 * Physical opening between wall AABBs — sized for the WIDEST live body class,
 * not just the player clamp. Reviewer finding (2026-07-17): the player clamp
 * uses ENTITY_HALF_CHIBI=25, but guest NPC-possession and humanoid NPC/agent
 * bodies clamp at ENTITY_HALF_HUMANOID=50 (100-wu body). A 75-wu opening
 * locked those classes out (and let server A*, rastered at 25, path a
 * humanoid body into a lane its client clamp cannot traverse). 128 wu =
 * 4 A* tiles: humanoid keeps 28 wu total clearance, chibi keeps 78 wu, and
 * every opening is centered on a 32-wu A* tile center so the humanoid-
 * expanded free band (128 − 100 = 28 wu... band [±14] around center) always
 * contains exactly one walkable tile-center lane.
 */
export const KELP_MAZE_PATH_WIDTH_WU = 128;

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
 * Eight stable AABBs form a south-entry switchback maze. Alternating 128-wu
 * openings sit on A* tile-center lanes: entry x=7824 (exact tile center),
 * east lane tile center x=8240 (free band 8226..8258 after humanoid
 * expansion), west lane tile center x=7408 (free band 7390..7422). No
 * consumer may duplicate these numeric wall values.
 */
export const KELP_MAZE_WALLS = [
  { id: 'kelp-maze-outer-south-west', centerX: 7544, centerZ: -9424, halfX: 216, halfZ: 12 },
  { id: 'kelp-maze-outer-south-east', centerX: 8104, centerZ: -9424, halfX: 216, halfZ: 12 },
  { id: 'kelp-maze-outer-north', centerX: 7824, centerZ: -10384, halfX: 496, halfZ: 12 },
  { id: 'kelp-maze-outer-west', centerX: 7328, centerZ: -9904, halfX: 12, halfZ: 480 },
  { id: 'kelp-maze-outer-east', centerX: 8320, centerZ: -9904, halfX: 12, halfZ: 480 },
  { id: 'kelp-maze-switchback-south', centerX: 7752, centerZ: -9600, halfX: 424, halfZ: 12 },
  { id: 'kelp-maze-switchback-middle', centerX: 7896, centerZ: -9792, halfX: 424, halfZ: 12 },
  { id: 'kelp-maze-switchback-north', centerX: 7752, centerZ: -10240, halfX: 424, halfZ: 12 },
] as const satisfies readonly KelpMazeWallAabb[];

export const KELP_MAZE_WALL_COUNT = KELP_MAZE_WALLS.length;
export const KELP_MAZE_COLLIDER_COUNT = KELP_MAZE_WALL_COUNT + 1;
