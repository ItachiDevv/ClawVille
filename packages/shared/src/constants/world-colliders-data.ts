// ---------------------------------------------------------------------------
// world-colliders-data.ts  (packages/shared)
//
// Server-usable AABB collision data for the ClawVille open world.
// Mirrors the building + prop colliders defined in
// apps/web/src/lib/three/collision/world-colliders.ts but without any
// browser-only imports (no tilemap-data.ts, no @/ alias).
//
// COORDINATE SYSTEM:
//   The NPC simulation uses "game-pixel" coords (origin at top-left, 0..11520).
//   Three.js / world-colliders.ts uses centered coords (origin at map center).
//   Conversion: worldX = gameX - MAP_HALF,  worldZ = gameY - MAP_HALF
//   (MAP_HALF = 5760)
//
// ZERO PER-CALL ALLOCATIONS:
//   clampPosition2D uses module-scope scratch vars — safe for the 5 Hz
//   NPC simulation tick (Node.js is single-threaded).
//
// STRUCTURE-ON-MAP MANDATE (per 3dStructure.md §2h):
//   Adding or moving ANY building / prop on the world map REQUIRES a matching
//   AABB entry here (and in world-colliders.ts). Skip = ghost structure.
// ---------------------------------------------------------------------------

import { BUILDING_TILE_ZONES } from './npc-definitions';

// ---------------------------------------------------------------------------
// Constants — must match tilemap-data.ts values
// ---------------------------------------------------------------------------

const TILE_SIZE = 32;
const MAP_HALF = 5760; // MAP_WIDTH / 2 = MAP_HEIGHT / 2

/**
 * Scale factor applied to the 14-tile zone half-extent to get the AABB
 * half-extent. Must match BUILDING_SCALE_FACTOR in world-colliders.ts.
 */
const BUILDING_SCALE_FACTOR = 0.92;

// Half of the 14-tile zone in world units: (14 × 32) / 2 = 224 wu
const BUILDING_HALF_TILE_EXTENT = (14 * TILE_SIZE) / 2; // 224
const BUILDING_HALF = BUILDING_HALF_TILE_EXTENT * BUILDING_SCALE_FACTOR; // ≈ 206 wu

// ---------------------------------------------------------------------------
// Collider type
// ---------------------------------------------------------------------------

export interface ServerCollider2D {
  id: string;
  /** Three.js world-space center X (NOT game-pixel X). Conversion: worldX = gameX - MAP_HALF */
  centerX: number;
  /** Three.js world-space center Z (NOT game-pixel Y). Conversion: worldZ = gameY - MAP_HALF */
  centerZ: number;
  halfX: number;
  halfZ: number;
  /**
   * If true this zone does NOT block XZ movement — entity Y is raised to topY instead.
   * NPC simulation (server-side) ignores walkable zones in clampPosition2D (NPCs treat
   * walkable zones as passable ground), but the field is present for schema parity with
   * the client-side Collider2D interface. If server-side NPC Y-tracking is ever needed,
   * consume clamped.groundY from clampPosition2D (TBD).
   */
  walkable?: boolean;
  /**
   * World Y of the walkable surface top. Only meaningful when walkable === true.
   * Not currently consumed server-side (NPC Y is set by terrain raycast on the client).
   */
  topY?: number;
}

// ---------------------------------------------------------------------------
// Collider list — built once at module load
// ---------------------------------------------------------------------------

function buildServerColliders(): ServerCollider2D[] {
  const list: ServerCollider2D[] = [];

  // 1. Building colliders — derived from BUILDING_TILE_ZONES (shared constant).
  //    Zone upper-left: (zone.x, zone.y) in tile coords.
  //    Zone center tile: (zone.x + w/2, zone.y + h/2).
  //    Game-pixel center: centerTile × TILE_SIZE.
  //    Three.js world center: gamePx − MAP_HALF.
  for (const [id, zone] of Object.entries(BUILDING_TILE_ZONES)) {
    const centerTileX = zone.x + zone.w / 2;
    const centerTileY = zone.y + zone.h / 2;
    const gamePxX = centerTileX * TILE_SIZE;
    const gamePxY = centerTileY * TILE_SIZE;
    list.push({
      id,
      centerX: gamePxX - MAP_HALF,
      centerZ: gamePxY - MAP_HALF,
      halfX: BUILDING_HALF,
      halfZ: BUILDING_HALF,
    });
  }

  // 2. Town-center prop colliders — hardcoded Three.js world-space positions.
  //    These MUST match the prop colliders in world-colliders.ts PROPS array.
  //    halfX/halfZ match the values in that file.
  // Shisha-oasis mesh XZ center is offset from group origin due to asymmetric GLB layout.
  // World center: X = STALL_X(1273) + X_offset(-94.6) ≈ 1178, Z = STALL_Z(-120) + Z_offset(-120.2) ≈ -240.
  // Two zones replace the prior single AABB at (1273, -120) halfX=200 halfZ=160 (2026-05-22).
  //   shisha-approach: walkable outer ring — NPC simulation treats as passable (walkable=true ignored server-side).
  //   marketplace-stall: solid inner kiosk — blocks NPC pathfinding.
  // Must match PROPS array in world-colliders.ts.
  const SHISHA_SERVER_CENTER_X = 1178;
  const SHISHA_SERVER_CENTER_Z = -240;

  const PROP_COLLIDERS: ServerCollider2D[] = [
    { id: 'auction-podium',        centerX:     0, centerZ: -1000, halfX: 160, halfZ: 160 },
    { id: 'town-directory-sign',   centerX:     0, centerZ:  -120, halfX:  70, halfZ:  40 },
    { id: 'bazaar-stall',          centerX: -1273, centerZ:  -120, halfX: 180, halfZ: 140 },
    // Shisha-oasis outer walkable approach zone (2026-05-22 per-GLB collider rework).
    // Server-side NPC sim uses this as a passable area (walkable flag not enforced server-side).
    // topY documented for schema parity with client; not consumed by clampPosition2D.
    { id: 'shisha-approach',       centerX: SHISHA_SERVER_CENTER_X, centerZ: SHISHA_SERVER_CENTER_Z, halfX: 348, halfZ: 340, walkable: true, topY: 38 },
    // Shisha-oasis solid inner kiosk — blocks NPCs from entering the central structure.
    { id: 'marketplace-stall',     centerX: SHISHA_SERVER_CENTER_X, centerZ: SHISHA_SERVER_CENTER_Z, halfX: 200, halfZ: 195 },
    { id: 'quest-bounty-pavilion', centerX:     0, centerZ: -1220, halfX: 280, halfZ: 280 },
    { id: 'quest-npc',             centerX:  -110, centerZ:   -60, halfX:  40, halfZ:  40 },
    { id: 'town-guide',            centerX:     0, centerZ:   240, halfX:  40, halfZ:  40 },
  ];
  list.push(...PROP_COLLIDERS);

  return list;
}

// Eagerly built — module is loaded once at NPC simulation startup.
const SERVER_COLLIDERS: readonly ServerCollider2D[] = buildServerColliders();

export function getServerColliders(): readonly ServerCollider2D[] {
  return SERVER_COLLIDERS;
}

// ---------------------------------------------------------------------------
// Module-scope scratch — zero per-call allocations
// ---------------------------------------------------------------------------

let _cx = 0;
let _cz = 0;

/**
 * Clamp a desired position in THREE.JS WORLD SPACE (origin at map center)
 * against all world AABB colliders.
 *
 * Call BEFORE writing the NPC position — the caller must convert game-pixel
 * coords to world space first:
 *   worldX = npc.x - MAP_HALF
 *   worldZ = npc.y - MAP_HALF
 * then convert the result back:
 *   npc.x = result.x + MAP_HALF
 *   npc.y = result.z + MAP_HALF
 *
 * @param worldX     Desired Three.js world X.
 * @param worldZ     Desired Three.js world Z.
 * @param entityHalf Half-width of the moving entity (Minkowski expansion).
 *                   0 = point test. Typical: 30 for chibi NPC, 50 for adult.
 * @returns { x, z, hit } — clamped world position + whether any collider was hit.
 */
export function clampPosition2D(
  worldX: number,
  worldZ: number,
  entityHalf: number = 0,
): { x: number; z: number; hit: boolean } {
  _cx = worldX;
  _cz = worldZ;
  let hit = false;

  for (let i = 0; i < SERVER_COLLIDERS.length; i++) {
    const col = SERVER_COLLIDERS[i]!;
    const expandedHalfX = col.halfX + entityHalf;
    const expandedHalfZ = col.halfZ + entityHalf;
    const ox = expandedHalfX - Math.abs(_cx - col.centerX);
    const oz = expandedHalfZ - Math.abs(_cz - col.centerZ);
    if (ox > 0 && oz > 0) {
      hit = true;
      if (ox < oz) {
        _cx += _cx < col.centerX ? -ox : ox;
      } else {
        _cz += _cz < col.centerZ ? -oz : oz;
      }
    }
  }

  return { x: _cx, z: _cz, hit };
}

/** MAP_HALF constant for callers converting game-px ↔ world-space. */
export const WORLD_COLLIDER_MAP_HALF = MAP_HALF;
