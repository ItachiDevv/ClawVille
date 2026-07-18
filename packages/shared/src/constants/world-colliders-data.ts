// ---------------------------------------------------------------------------
// world-colliders-data.ts  (packages/shared)
//
// Server-usable AABB collision data for the ClawVille open world.
// Mirrors the building + prop colliders defined in
// apps/web/src/lib/three/collision/world-colliders.ts but without any
// browser-only imports (no tilemap-data.ts, no @/ alias).
//
// COORDINATE SYSTEM:
//   The NPC simulation uses "game-pixel" coords (origin at top-left, 0..22528).
//   Three.js / world-colliders.ts uses centered coords (origin at map center).
//   Conversion: worldX = gameX - MAP_HALF,  worldZ = gameY - MAP_HALF
//   (MAP_HALF = 11264 — land-builder-economics 2026-06-24; was 9216)
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
// MAP_WIDTH / 2 = MAP_HEIGHT / 2. Land-builder-economics (2026-06-24): 18432-world → 22528-world.
// MUST match the client MAP_WIDTH/2 in apps/web/src/lib/pixi/tilemap-data.ts (22528/2).
// Note: building collider centerX/Z stay INVARIANT across this change — the +2048 px
// (+64 tile) shift in BUILDING_TILE_ZONES is exactly cancelled by the +2048 MAP_HALF bump
// (centerX = gamePxX − MAP_HALF), so each building's WORLD position is unchanged.
const MAP_HALF = 11264;

// Server-side entity-half constants. KEEP IN SYNC with the client exports in
// apps/web/src/lib/three/collision/world-colliders.ts.
export const ENTITY_HALF_CHIBI = 25;    // chibi VRM (135 wu height)
export const ENTITY_HALF_HUMANOID = 50; // adult humanoid (270 wu height)

/**
 * Per-building AABB half-extents — mirrors BUILDING_EXTENTS in world-colliders.ts.
 * Must be updated in the same diff as world-colliders.ts. See that file for the
 * full measurement methodology and derivation notes (2026-05-22).
 *
 * All centers use tile-zone world center (no offset). computeBuildingScale() in
 * arena-buildings.tsx corrects the pivot so the visual mesh center == tile-zone
 * world center, making AABB center == tile-zone center for all 12 buildings.
 */
const BUILDING_EXTENTS: Readonly<Record<string, { halfX: number; halfZ: number }>> = {
  'visual-creation':    { halfX: 468, halfZ: 357 },
  'code-development':   { halfX: 591, halfZ: 595 },
  'mcp-tool-use':       { halfX: 589, halfZ: 595 },
  'messaging-channels': { halfX: 850, halfZ: 850 },
  'api-integrations':   { halfX: 850, halfZ: 850 },
  'app-publishing':     { halfX: 425, halfZ: 423 },
  'cron-automation':    { halfX: 850, halfZ: 498 },
  'deployment-ops':     { halfX: 303, halfZ: 330 },
  'claw-arcade':        { halfX: 468, halfZ: 450 },
  'cove':               { halfX: 546, halfZ: 553 },
  'agent-security':     { halfX: 460, halfZ: 468 },
  'memory-rag':         { halfX: 722, halfZ: 723 },
} as const;

// Fallback half-extent for any zone ID not in the table above (defensive).
// Half of the 14-tile zone in world units: (14 × 32) / 2 = 224 wu
const BUILDING_HALF_TILE_EXTENT = (14 * TILE_SIZE) / 2; // 224
const BUILDING_HALF = BUILDING_HALF_TILE_EXTENT * 0.92;  // ≈ 206 wu fallback

// Small uniform buffer added to every building collider's half-extents so the
// collision boundary covers the building's visual texture overhang (the extents
// are sized to geometry; the texture bleeds slightly past it). MUST match
// BUILDING_COLLISION_BUFFER in world-colliders.ts (client) — §2h same-diff rule.
const BUILDING_COLLISION_BUFFER = 28; // wu

// ---------------------------------------------------------------------------
// Collider type
// ---------------------------------------------------------------------------

export type PathfindingRasterPolicy =
  | { readonly mode: 'legacy-safety-tiles' }
  | { readonly mode: 'cell-center-expanded-aabb'; readonly paddingWu: number };

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
  /**
   * Optional A* raster policy. Undefined preserves the legacy 4-tile safety
   * expansion byte-for-byte. Narrow structures may opt into exact tile-center
   * intersection against the AABB expanded by the moving entity half-width.
   */
  pathfindingRaster?: PathfindingRasterPolicy;
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
  //    Per-building halfX/halfZ from BUILDING_EXTENTS (GLB-measured, 2026-05-22).
  for (const [id, zone] of Object.entries(BUILDING_TILE_ZONES)) {
    const centerTileX = zone.x + zone.w / 2;
    const centerTileY = zone.y + zone.h / 2;
    const gamePxX = centerTileX * TILE_SIZE;
    const gamePxY = centerTileY * TILE_SIZE;
    const extents = BUILDING_EXTENTS[id];
    list.push({
      id,
      centerX: gamePxX - MAP_HALF,
      centerZ: gamePxY - MAP_HALF,
      halfX: (extents?.halfX ?? BUILDING_HALF) + BUILDING_COLLISION_BUFFER,
      halfZ: (extents?.halfZ ?? BUILDING_HALF) + BUILDING_COLLISION_BUFFER,
    });
  }

  // 2. Town-center prop colliders — hardcoded Three.js world-space positions.
  //    These MUST match the prop colliders in world-colliders.ts PROPS array.
  //    halfX/halfZ match the values in that file.
  // Shisha-oasis mesh XZ center is offset from group origin due to asymmetric GLB layout.
  // World center: X = STALL_X(1273) + X_offset(-94.6) ≈ 1178, Z = STALL_Z(-120) + Z_offset(-120.2) ≈ -240.
  // 2026-05-22 ROUND 2: pure-solid AABB. The earlier walkable outer ring was wrong
  // (lift too small to feel like "climbing a step"). Real stair-climb deferred until
  // per-step GLB geometry can be measured in Blender.
  const SHISHA_SERVER_CENTER_X = 1178;
  const SHISHA_SERVER_CENTER_Z = -240;

  const PROP_COLLIDERS: ServerCollider2D[] = [
    { id: 'town-directory-sign',   centerX:     0, centerZ:  -120, halfX:  70, halfZ:  40 },
    { id: 'bazaar-stall',          centerX: -1273, centerZ:  -120, halfX: 180, halfZ: 140 },
    // Shisha-oasis — solid blocker covering the visible structure footprint.
    // Tightened by ~15% from full GLB bbox (994×972) to exclude lantern overhang.
    { id: 'marketplace-stall',     centerX: SHISHA_SERVER_CENTER_X, centerZ: SHISHA_SERVER_CENTER_Z, halfX: 420, halfZ: 410 },
    { id: 'quest-bounty-pavilion', centerX:     0, centerZ: -1220, halfX: 280, halfZ: 280 },
    { id: 'quest-npc',             centerX:  -110, centerZ:   -60, halfX:  40, halfZ:  40 },
    { id: 'town-guide',            centerX:     0, centerZ:   240, halfX:  40, halfZ:  40 },
    // Must match the client prop AABB in world-colliders.ts exactly.
    { id: 'kelp-forest-portal',     centerX:  7808, centerZ: -9900, halfX: 170, halfZ:  42 },
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
// Building interaction geometry — edge-distance, NOT center-distance.
// ---------------------------------------------------------------------------
// The agent building-interaction gates (visit-building, building/:id/chat,
// talk_to_npc, the autonomy driver's hasArrived) must measure proximity to a
// building's actual FOOTPRINT, not its center. The buildings are large
// (memory-rag 722×723 wu half-extents, messaging-channels / api-integrations
// 850×850), and their collider (+buffer +the moving entity's half-width +A*
// padding) pushes the nearest WALKABLE approach well beyond 1000 wu from the
// center — so a `distToCenter <= BUILDING_INTERACTION_RADIUS(=1000)` gate is
// geometrically UNSATISFIABLE for the bigger buildings (a latent bug for the
// hosted house agent too, not just connected agents). Measuring to the collider
// AABB edge makes "near the building" reachable regardless of footprint.
const BUILDING_COLLIDER_BY_ID: Readonly<Record<string, ServerCollider2D>> = Object.freeze(
  Object.fromEntries(
    SERVER_COLLIDERS.filter((c) => Object.hasOwn(BUILDING_TILE_ZONES, c.id)).map((c) => [c.id, c]),
  ),
);

/**
 * Distance in GAME-PIXEL units from a game-pixel point to the EDGE of a
 * building's collider AABB (0 when the point is inside the footprint). Returns
 * `null` for an unknown / non-building id (fail-closed at the call site).
 * `halfX/halfZ` on the collider already include BUILDING_COLLISION_BUFFER.
 */
export function buildingEdgeDistanceGamePx(x: number, y: number, buildingId: string): number | null {
  if (!Object.hasOwn(BUILDING_COLLIDER_BY_ID, buildingId)) return null;
  const col = BUILDING_COLLIDER_BY_ID[buildingId]!;
  const cx = col.centerX + MAP_HALF; // world-space → game-pixel
  const cy = col.centerZ + MAP_HALF;
  const dx = Math.max(0, Math.abs(x - cx) - col.halfX);
  const dy = Math.max(0, Math.abs(y - cy) - col.halfZ);
  return Math.hypot(dx, dy);
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

/** TILE_SIZE for game-px → tile conversions. Mirrors tilemap-data.ts. */
export const WORLD_COLLIDER_TILE_SIZE = TILE_SIZE;
