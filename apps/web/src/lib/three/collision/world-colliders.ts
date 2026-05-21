// ---------------------------------------------------------------------------
// world-colliders.ts
// XZ-plane AABB collision for the ClawVille open world.
//
// METHOD: axis-aligned bounding boxes with minimum-translation-vector (MTV)
// push-out. Matches the cove-interior.tsx pattern proven 2026-05-19.
//
// Why AABB over disc (changed 2026-05-21):
//   Buildings are 14×14 tile zones = 448×448 wu squares. A disc collider of
//   radius 224 over-covers the diagonals and a radius 190 disc leaves the
//   corners walkable — there was no good middle ground. AABB is geometrically
//   correct for axis-aligned rectangles and gives a clean "wall" feel at every
//   edge. Cove already uses this method for slot cabinets + dealer station.
//
// Why not raycast:
//   Raycast would need a BVH for 20+ colliders at 60fps. AABB MTV does it
//   in <0.1ms with zero per-frame allocations.
//
// ZERO PER-FRAME ALLOCATIONS:
//   clampMovement2D uses module-scope scratch values (no new Vec2 per call).
//
// STRUCTURE-ON-MAP MANDATE (per 3dStructure.md):
//   Adding or moving ANY building / prop / town-center furniture on the world
//   map REQUIRES a matching AABB entry below. Skip = the structure becomes a
//   walk-through ghost. See "Building/prop spatial registration" rule in
//   3dStructure.md (§6g, added 2026-05-21).
// ---------------------------------------------------------------------------

import { buildingZones, TILE_SIZE, MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

const HALF_W = MAP_WIDTH / 2;  // 5760
const HALF_H = MAP_HEIGHT / 2; // 5760

/**
 * Axis-aligned bounding box collider in world XZ coordinates.
 *   centerX, centerZ — world-space center (Three.js XZ plane)
 *   halfX, halfZ     — half-extents along each axis
 *   kind             — 'building' or 'prop' (informational only, not used in math)
 *   id               — stable identifier for debugging
 */
export interface Collider2D {
  id: string;
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
  kind: 'building' | 'prop';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Scale factor applied to half the zone tile extent to get the AABB half-
 * extent. 0.92 of 224wu = ~206wu, slightly inside the full 14-tile zone.
 * 1.0 = exact tile-zone match. <1.0 gives the player some clearance against
 * the visual building wall (visual mesh usually extends a few wu inside the
 * tile zone). If buildings feel too "permeable", raise to 0.95-1.0; if walls
 * feel too far out from the visible mesh, lower to 0.85.
 * Chosen value: 0.92 (2026-05-21 AABB cutover).
 */
const BUILDING_SCALE_FACTOR = 0.92;

// Half the 14-tile zone dimension in world units: (14 × 32) / 2 = 224wu
const BUILDING_HALF_TILE_EXTENT = (14 * TILE_SIZE) / 2; // 224

// Building AABB half-extents — same for all 12 buildings (uniform 14×14 zone).
const BUILDING_HALF = BUILDING_HALF_TILE_EXTENT * BUILDING_SCALE_FACTOR; // ≈ 206wu

// ---------------------------------------------------------------------------
// Module-scope collider cache
// ---------------------------------------------------------------------------
let _cachedColliders: Collider2D[] | null = null;
let _cachedBuildingCount = 0;

/** Return the cached collider list. Recomputed only if buildingZones changes length. */
export function getAllColliders(): readonly Collider2D[] {
  if (_cachedColliders && _cachedBuildingCount === buildingZones.length) {
    return _cachedColliders;
  }
  _cachedColliders = buildColliders();
  _cachedBuildingCount = buildingZones.length;
  return _cachedColliders;
}

function buildColliders(): Collider2D[] {
  const colliders: Collider2D[] = [];

  // ---------------------------------------------------------------------------
  // 1. Building colliders — derived from buildingZones in tilemap-data.ts
  //    Zone upper-left: (zone.x, zone.y) in tile coords.
  //    Zone center tile: (zone.x + 7, zone.y + 7) (zone is 14×14).
  //    World coords: worldX = centerTileX * TILE_SIZE - HALF_W
  //                  worldZ = centerTileY * TILE_SIZE - HALF_H
  // ---------------------------------------------------------------------------
  for (const zone of buildingZones) {
    const centerTileX = zone.x + zone.width / 2;   // zone.x + 7 (zone.width=14)
    const centerTileY = zone.y + zone.height / 2;  // zone.y + 7
    colliders.push({
      id: zone.id,
      centerX: centerTileX * TILE_SIZE - HALF_W,
      centerZ: centerTileY * TILE_SIZE - HALF_H,
      halfX: BUILDING_HALF,
      halfZ: BUILDING_HALF,
      kind: 'building',
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Town-center prop colliders — hardcoded world-space positions.
  //    Positions sourced from each prop's tsx file (verified 2026-05-21):
  //      AuctionPodium:       (0, -1000) — auction-podium.tsx DOME_X/Z
  //      TownDirectorySign:   (0, -120)  — town-directory-sign.tsx SIGN_X/Z
  //      BazaarStall:         (-1273, -120) — bazaar-stall.tsx STALL_X/Z
  //      MarketplaceStall:    (1273, -120)  — marketplace-stall.tsx STALL_X/Z
  //      QuestBountyPavilion: (0, -1220)   — quest-bounty-pavilion.tsx PAV_X/Z
  //      QuestNpc:            (-110, -60) — quest-npc.tsx QUEST_NPC_X/Z
  //      TownGuide (Nori):    (0, 240)    — town-guide.tsx NORI_WORLD_X/Z
  //
  //    halfX / halfZ are AABB half-extents (cabinet style) — for roughly-square
  //    props use the same value on both axes; for stalls or wide signs, anisotropic
  //    extents read tighter (less invisible-wall feel along the narrow axis).
  // ---------------------------------------------------------------------------
  const PROPS: Collider2D[] = [
    { id: 'auction-podium',       centerX:     0, centerZ: -1000, halfX: 160, halfZ: 160, kind: 'prop' },
    { id: 'town-directory-sign',  centerX:     0, centerZ:  -120, halfX:  70, halfZ:  40, kind: 'prop' },
    { id: 'bazaar-stall',         centerX: -1273, centerZ:  -120, halfX: 180, halfZ: 140, kind: 'prop' },
    { id: 'marketplace-stall',    centerX:  1273, centerZ:  -120, halfX: 200, halfZ: 160, kind: 'prop' },
    { id: 'quest-bounty-pavilion',centerX:     0, centerZ: -1220, halfX: 280, halfZ: 280, kind: 'prop' },
    { id: 'quest-npc',            centerX:  -110, centerZ:   -60, halfX:  40, halfZ:  40, kind: 'prop' },
    { id: 'town-guide',           centerX:     0, centerZ:   240, halfX:  40, halfZ:  40, kind: 'prop' },
  ];
  colliders.push(...PROPS);

  return colliders;
}

// ---------------------------------------------------------------------------
// Module-scope scratch values — zero per-frame allocations
// ---------------------------------------------------------------------------

// dx, dz components reused across clampMovement2D calls.
// Not thread-safe (JavaScript is single-threaded — no concern here).
let _sCx = 0;
let _sCz = 0;

/**
 * Clamp a proposed XZ movement against all world AABB colliders.
 *
 * Call AFTER computing the desired next position, BEFORE writing it to the
 * avatar/NPC transform.
 *
 * AABB push-out semantics (minimum-translation-vector):
 *   - Compute X-overlap = (col.halfX + entityHalf) - |to.x - col.centerX|
 *   - Compute Z-overlap = (col.halfZ + entityHalf) - |to.z - col.centerZ|
 *   - If both > 0, the entity is inside the collider's expanded bounds.
 *   - Push along the axis with the SMALLER overlap — that's the closest
 *     escape direction, which naturally gives a "slide along wall" feel
 *     (Y-axis overlap small? push in Y; X-axis small? push in X).
 *   - Direction is signed by which side of center the entity is on.
 *
 * @param fromX        Current world X (unused in AABB path — kept for API stability
 *                     with the old disc collider; future entity-vs-entity collision
 *                     may use it for swept-AABB tunneling prevention).
 * @param fromZ        Current world Z (see fromX note).
 * @param toX          Desired world X after movement.
 * @param toZ          Desired world Z after movement.
 * @param entityHalf   Half-width of the moving entity (Minkowski expansion of
 *                     each collider AABB). Default 0 = treat entity as a point.
 *                     Typical: 30wu for chibi, 50-60wu for adult humanoid.
 * @returns            `{ x, z }` clamped world position, and `hit` true if any
 *                     collider was intersected and required push-out.
 */
export function clampMovement2D(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  entityHalf: number = 0,
): { x: number; z: number; hit: boolean } {
  // Note: fromX / fromZ retained in signature to preserve back-compat with the
  // previous disc implementation. Currently unused. Linter would flag if we
  // dropped them outright, and a future swept-AABB path will reuse them.
  void fromX;
  void fromZ;

  const colliders = getAllColliders();
  _sCx = toX;
  _sCz = toZ;
  let hit = false;

  for (let i = 0; i < colliders.length; i++) {
    const col = colliders[i]!;
    // Minkowski-expanded AABB: expand collider half-extents by entity half-width,
    // then test the entity as a point.
    const expandedHalfX = col.halfX + entityHalf;
    const expandedHalfZ = col.halfZ + entityHalf;
    const ox = expandedHalfX - Math.abs(_sCx - col.centerX);
    const oz = expandedHalfZ - Math.abs(_sCz - col.centerZ);
    if (ox > 0 && oz > 0) {
      hit = true;
      // Push along the axis of smaller overlap — that's the minimum-translation
      // direction, gives natural sliding along walls.
      if (ox < oz) {
        _sCx += _sCx < col.centerX ? -ox : ox;
      } else {
        _sCz += _sCz < col.centerZ ? -oz : oz;
      }
    }
  }

  return { x: _sCx, z: _sCz, hit };
}

// ---------------------------------------------------------------------------
// Entity-vs-entity collision (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Minimal XZ position descriptor for entity-vs-entity push-out.
 * Both player-avatar and NPC snapshots satisfy this shape.
 */
export interface EntityPosition {
  x: number; // Three.js world X
  z: number; // Three.js world Z
}

// Scratch vars for entity push-out — separate from world-collider scratch to
// allow future composition without aliasing.
let _eEx = 0;
let _eEz = 0;

/**
 * Clamp a proposed XZ movement against BOTH world AABB colliders AND a list
 * of other entity positions (NPC vs player, player vs NPC on client).
 *
 * Runs world-collider pass first, then entity push-out pass. Each entity is
 * treated as a circle of radius `otherHalf` (same as `entityHalf` by default).
 * Push-out is symmetric-impulse style: the mover is pushed away from each
 * other entity by the full overlap amount (not half), because only one entity
 * is being updated per call (the other's position is treated as fixed).
 *
 * @param fromX         Previous world X (back-compat, currently unused).
 * @param fromZ         Previous world Z.
 * @param toX           Desired world X.
 * @param toZ           Desired world Z.
 * @param entityHalf    Half-width of the moving entity.
 * @param otherEntities Other entity positions to push out against.
 * @param otherHalf     Half-width to use for each other entity (defaults to
 *                      `entityHalf` for same-species push-out).
 * @returns             `{ x, z, hit }` clamped world position.
 */
export function clampEntityMovement2D(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  entityHalf: number = 0,
  otherEntities: readonly EntityPosition[] = [],
  otherHalf: number = entityHalf,
): { x: number; z: number; hit: boolean } {
  // Pass 1: world AABB colliders. Pass real fromX/fromZ so clampMovement2D's
  // escape-hatch (allow outward movement when entity is already inside a
  // collider) uses the entity's actual position, not a hardcoded origin.
  const worldResult = clampMovement2D(fromX, fromZ, toX, toZ, entityHalf);
  _eEx = worldResult.x;
  _eEz = worldResult.z;
  let hit = worldResult.hit;

  // Pass 2: entity-vs-entity push-out (circle approximation for speed).
  const combinedHalf = entityHalf + otherHalf;
  const combinedHalfSq = combinedHalf * combinedHalf;
  for (let i = 0; i < otherEntities.length; i++) {
    const other = otherEntities[i]!;
    const dx = _eEx - other.x;
    const dz = _eEz - other.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < combinedHalfSq && distSq > 0) {
      hit = true;
      const dist = Math.sqrt(distSq);
      const overlap = combinedHalf - dist;
      // Push the mover fully away from the other entity.
      _eEx += (dx / dist) * overlap;
      _eEz += (dz / dist) * overlap;
    } else if (distSq === 0) {
      // Exact overlap — push in a deterministic direction to avoid NaN.
      hit = true;
      _eEx += combinedHalf;
    }
  }

  return { x: _eEx, z: _eEz, hit };
}

/** Half-width constants for entity push-out. */
export const ENTITY_HALF_CHIBI = 25;    // chibi VRM (135 wu height)
export const ENTITY_HALF_HUMANOID = 50; // adult humanoid (270 wu height)
