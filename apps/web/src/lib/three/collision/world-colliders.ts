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
//
// WALKABLE COLLIDERS (added 2026-05-22):
//   Colliders with walkable:true do NOT block XZ movement. Instead, when the
//   entity's XZ position overlaps the walkable AABB, clampMovement2D/3D returns
//   the topY so the caller can raise the entity's Y to that surface. The entity
//   rides the surface instead of being stopped by an invisible wall.
//   Use case: shisha-oasis stair approach and platform deck.
// ---------------------------------------------------------------------------

import { buildingZones, TILE_SIZE, MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

const HALF_W = MAP_WIDTH / 2;  // 5760
const HALF_H = MAP_HEIGHT / 2; // 5760

/**
 * Axis-aligned bounding box collider in world XZ coordinates.
 *
 *   centerX, centerZ — world-space center (Three.js XZ plane)
 *   halfX, halfZ     — half-extents along each axis
 *   kind             — 'building' or 'prop' (informational only, not used in math)
 *   id               — stable identifier for debugging
 *   walkable         — if true, entity XZ is NOT blocked; instead clampMovement2D
 *                      returns the surface topY via result.groundY so the caller
 *                      can lift the entity's Y rather than stopping it.
 *   topY             — world Y of the walkable surface top (Three.js Y axis, upward).
 *                      Only meaningful when walkable === true.
 *                      Default 0 (sand floor level ≈ -2; raise as needed).
 */
export interface Collider2D {
  id: string;
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
  kind: 'building' | 'prop';
  /** If true this zone lifts entity Y instead of blocking XZ movement. */
  walkable?: boolean;
  /**
   * World Y (Three.js upward) of the surface the entity stands on when
   * inside this walkable zone. Only used when walkable === true.
   *
   * Derivation for shisha-oasis (2026-05-22):
   *   GLB native minY (after 0.01 FBX node scale) = 0.00183
   *   Applied scale  = TARGET_HEIGHT_WU / maxDim = 994 / 0.08355 ≈ 11,897
   *   GLB minY in wu = 0.00183 × 11,897 ≈ 21.8 wu above GLB origin
   *   groundedYOffset puts bbox.min.y at SAND_BASELINE_Y = -2:
   *     groupY = -2 - 21.8 = -23.8 wu (+ FLOOR_NUDGE_Y -30 = -53.8 wu)
   *   First stair step height is approximately 10-15% of total structure
   *   height (833 wu) = ~83-125 wu above group origin.
   *   Estimated lower step world Y = -53.8 + 90 ≈ 36 wu → round to 38 wu.
   *   Player avatar height = 179 wu; step at 38 wu is walkable (≈21% of height).
   *
   *   Conservative pick: 38 wu above world Y=0 (sand floor at -2).
   *   If it reads visually wrong, adjust in marketplace-stall.tsx by changing
   *   SHISHA_STEP_TOP_Y and bumping the collider entry here.
   */
  topY?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Per-building AABB half-extents derived from GLB bbox measurement.
 *
 * Method (2026-05-22, scripts/inspect-building-bboxes.mjs + inline Node.js
 * for Draco-compressed GLBs):
 *   1. Measure native GLB bbox via gltf-transform, applying recursive TRS
 *      world transforms (required for GLBs with root-node rotations like
 *      patty-building which has a -0.5,-0.5,-0.5,0.5 quaternion).
 *   2. Apply arena-buildings.tsx targetMaxDim scale:
 *        scale = targetMaxDim / nativeMaxDim
 *        worldX = nativeSizeX * scale (capped by MAX_FOOTPRINT=2000wu)
 *        worldZ = nativeSizeZ * scale (capped by MAX_FOOTPRINT=2000wu)
 *   3. Tighten by TIGHTEN=0.85 to exclude eaves / lantern overhang.
 *        halfX = worldX / 2 * 0.85
 *        halfZ = worldZ / 2 * 0.85
 *   4. AABB center = tile-zone world center (NO additional offset needed).
 *      computeBuildingScale() in arena-buildings.tsx subtracts pivotOffsetX/Z
 *      (= bbox_center_XZ * scale) from the inner group position, so the
 *      visual mesh center is already at the tile-zone world center. The AABB
 *      must use the same center — no offset required regardless of how far
 *      off-origin the GLB geometry sits.
 *
 * Special cases:
 *   - cove: uses box3Recenter=true in arena-buildings.tsx, which re-centers
 *     the geometry to (0,0,0) after load. Center = tile-zone center, no offset.
 *   - messaging-channels (sandy-treedome-v3) and api-integrations (salty-spitoon):
 *     targetMaxDim=2500 exceeds MAX_FOOTPRINT=2000wu, so worldX=worldZ=2000.
 *   - cron-automation (patty-building): X exceeds footprint cap, Z does not.
 *
 * Fallback BUILDING_HALF (≈206wu) is retained for any zone ID not in this
 * table (defensive — all 12 buildings are covered below).
 */
const BUILDING_EXTENTS: Readonly<Record<string, { halfX: number; halfZ: number }>> = {
  // GLB: pineapple-house.glb, targetMaxDim=1100
  // Native size: 30.984×23.666, scale=35.50 → worldX=1100, worldZ=840 → ×0.85
  'visual-creation':    { halfX: 468, halfZ: 357 },

  // GLB: chum-bucket-v2.glb, targetMaxDim=1400
  // Native size: ≈33.5×33.6, scale≈41.79 → worldX=1392, worldZ=1400 → ×0.85
  'code-development':   { halfX: 591, halfZ: 595 },

  // GLB: krusty-krab-v2.glb, targetMaxDim=1400
  // Native size: ≈34.4×33.6, scale≈40.70 → worldX=1386, worldZ=1400 → ×0.85
  'mcp-tool-use':       { halfX: 589, halfZ: 595 },

  // GLB: sandy-treedome-v3.glb, targetMaxDim=2500 (Draco-compressed)
  // Native size: 25.873×25.873, scale≈96.6 → footprint cap → worldX=worldZ=2000 → ×0.85
  'messaging-channels': { halfX: 850, halfZ: 850 },

  // GLB: salty-spitoon.glb, targetMaxDim=2500
  // footprint cap applied → worldX=worldZ=2000 → ×0.85
  'api-integrations':   { halfX: 850, halfZ: 850 },

  // GLB: boating-school.glb, targetMaxDim=1000
  // Approximately square footprint → worldX=1000, worldZ=995 → ×0.85
  'app-publishing':     { halfX: 425, halfZ: 423 },

  // GLB: patty-building.glb, targetMaxDim=2200
  // Root node has quaternion (-0.5,-0.5,-0.5,0.5) [90° rotation] — TRS applied.
  // Native size: 255.782×150.001 (longest axis post-transform), scale=8.60
  // worldX=2000 (footprint cap), worldZ=1173 → ×0.85
  'cron-automation':    { halfX: 850, halfZ: 498 },

  // GLB: building-lighthouse.glb, targetMaxDim=1400
  // Tall, narrow footprint → worldX=714, worldZ=776 → ×0.85
  'deployment-ops':     { halfX: 303, halfZ: 330 },

  // GLB: claw-arcade-exterior.glb, targetMaxDim=1100
  // Nearly square → worldX=1100, worldZ=1058 → ×0.85
  'claw-arcade':        { halfX: 468, halfZ: 450 },

  // GLB: cove-exterior.glb, targetMaxDim=1300, box3Recenter=true
  // arena-buildings.tsx re-centers after load → center = tile-zone center (no offset)
  // worldX=1284, worldZ=1300 → ×0.85
  'cove':               { halfX: 546, halfZ: 553 },

  // GLB: patricks-rock-v2.glb, targetMaxDim=1100
  // Roughly round footprint → worldX=1082, worldZ=1100 → ×0.85
  'agent-security':     { halfX: 460, halfZ: 468 },

  // GLB: squidward-house.glb, targetMaxDim=1700
  // Square footprint → worldX=worldZ=1700 → ×0.85
  'memory-rag':         { halfX: 722, halfZ: 723 },
} as const;

// Fallback half-extent for any zone ID not listed above (defensive coding).
// Half the 14-tile zone dimension in world units: (14 × 32) / 2 = 224wu
const BUILDING_HALF_TILE_EXTENT = (14 * TILE_SIZE) / 2; // 224
const BUILDING_HALF = BUILDING_HALF_TILE_EXTENT * 0.92;  // ≈206wu fallback

// Small uniform buffer added to every BUILDING collider's half-extents. The
// BUILDING_EXTENTS above are sized to the building GEOMETRY, but each building's
// visible TEXTURE/silhouette bleeds a little past the geometry box — without a
// buffer the player can walk into that outer texture before collision blocks them.
// This pads the collision boundary outward so it covers the texture overhang.
// Buildings only (props in PROPS[] are individually tuned). User-tunable.
const BUILDING_COLLISION_BUFFER = 28; // wu

// ---------------------------------------------------------------------------
// Shisha-oasis collider constants (verified from GLB inspection 2026-05-22)
// ---------------------------------------------------------------------------

// GLB scene bbox at Three.js scale=1 (after 0.01 FBX node scale baked in):
//   min: (-0.04972, 0.00183, -0.05097)
//   max: ( 0.03383, 0.07189,  0.03076)
//   size X = 0.08355, Y = 0.07006, Z = 0.08173
//   maxDim = X = 0.08355
//
// Applied scale (TARGET_HEIGHT_WU=994): 994 / 0.08355 = 11,897
// World dimensions at that scale:
//   X = 994 wu, Y = 833 wu, Z = 972 wu
//
// XZ center of the GLB bbox relative to GLB origin (group center at STALL_X/Z):
//   X_center_offset = (0.03383 - 0.04972) / 2 × 11897 = -94.6 wu
//   Z_center_offset = (0.03076 - 0.05097) / 2 × 11897 = -120.2 wu
//
// World XZ center of the shisha-oasis mesh:
//   X = STALL_X + X_center_offset = 1273 + (-94.6) ≈ 1178 wu
//   Z = STALL_Z + Z_center_offset = -120 + (-120.2) ≈ -240 wu
//
// Full footprint half-extents: halfX = 497 wu, halfZ = 486 wu
// Central kiosk (estimated inner 40%): halfX = 200 wu, halfZ = 195 wu
// Lower stair approach zone (estimated 70% of footprint): halfX = 350 wu, halfZ = 340 wu

/** World XZ center of the shisha-oasis mesh (offset from GLB scene origin). */
export const SHISHA_CENTER_X = 1178;
export const SHISHA_CENTER_Z = -240;

/**
 * Step surface height in world Y (Three.js upward axis).
 * Derived: groupY≈-54 + first structural step ≈90 wu above GLB origin = 36 wu.
 * Rounded up to 38 wu to ensure avatar clears sand surface.
 * Bump this constant + update colliders below if visual step height changes.
 */
export const SHISHA_STEP_TOP_Y = 38;

/**
 * Platform deck height in world Y — the main elevated interior floor.
 * Estimated from GLB mesh 1 (glass/lantern elements) minY × scale:
 *   0.02049 × 11897 ≈ 244 wu above GLB origin.
 *   groupY ≈ -54 + 244 ≈ 190 wu.
 * This is ABOVE avatar head height (179 wu) — cannot be walked on.
 * Documented here for completeness; no walkable collider at this height.
 */
export const SHISHA_PLATFORM_DECK_Y = 190;

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
    const extents = BUILDING_EXTENTS[zone.id];
    colliders.push({
      id: zone.id,
      centerX: centerTileX * TILE_SIZE - HALF_W,
      centerZ: centerTileY * TILE_SIZE - HALF_H,
      halfX: (extents?.halfX ?? BUILDING_HALF) + BUILDING_COLLISION_BUFFER,
      halfZ: (extents?.halfZ ?? BUILDING_HALF) + BUILDING_COLLISION_BUFFER,
      kind: 'building',
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Town-center prop colliders — hardcoded world-space positions.
  //    Positions sourced from each prop's tsx file (verified 2026-05-21):
  //      AuctionPodium removed 2026-07-15 — superseded by quest-bounty-pavilion.
  //      TownDirectorySign:   (0, -120)  — town-directory-sign.tsx SIGN_X/Z
  //      BazaarStall:         (-1273, -120) — bazaar-stall.tsx STALL_X/Z
  //      MarketplaceStall:    (1273, -120)  — marketplace-stall.tsx STALL_X/Z
  //      QuestBountyPavilion: (0, -1220)   — quest-bounty-pavilion.tsx PAV_X/Z
  //      QuestNpc:            (-110, -60) — quest-npc.tsx QUEST_NPC_X/Z
  //      TownGuide (Nori):    (0, 240)    — town-guide.tsx NORI_WORLD_X/Z
  //
  //    Shisha-oasis (MarketplaceStall) gets THREE collider zones (2026-05-22):
  //      a. Outer walkable approach zone — large, lifts player Y to stair step.
  //      b. Inner solid kiosk — the central column+bar structure, blocks entry.
  //
  //    GLB mesh center is offset from group origin due to asymmetric layout:
  //      worldX = STALL_X (1273) + X_center_offset (-94.6) ≈ 1178
  //      worldZ = STALL_Z (-120) + Z_center_offset (-120.2) ≈ -240
  //
  //    halfX / halfZ are AABB half-extents (cabinet style) — for roughly-square
  //    props use the same value on both axes; for stalls or wide signs, anisotropic
  //    extents read tighter (less invisible-wall feel along the narrow axis).
  // ---------------------------------------------------------------------------
  const PROPS: Collider2D[] = [
    { id: 'town-directory-sign',  centerX:     0, centerZ:  -120, halfX:  70, halfZ:  40, kind: 'prop' },
    { id: 'bazaar-stall',         centerX: -1273, centerZ:  -120, halfX: 180, halfZ: 140, kind: 'prop' },
    // -----------------------------------------------------------------------
    // Shisha-oasis (MarketplaceStall) — 2026-05-22 ROUND 2 (pure-solid).
    //
    // The earlier walkable-outer-ring (halfX=348 halfZ=340 topY=38) was wrong:
    // 38 wu lift is only ~21% of avatar height, so crossing the visible wall
    // produced "phasing through the wall" rather than "climbing a porch step".
    // User reported NPCs spawning inside the mesh and the player walking into
    // the visible structure with no resistance.
    //
    // Real stair-climb is deferred until per-step GLB geometry can be measured
    // in Blender — the merged single-mesh GLB doesn't expose stairs vs walls
    // via gltf-transform inspection (only 3 merged meshes: main body, canopy,
    // lantern emission). Until then the whole structure is a solid blocker.
    //
    // Footprint: manager measured GLB native maxDim=0.0836, applied scale
    // 994/0.0836 = 11,897, world footprint 994×972 wu. Tightened by ~15% to
    // halfX=420 halfZ=410 to exclude lantern-overhang bbox padding.
    // -----------------------------------------------------------------------
    {
      id: 'marketplace-stall',
      centerX: SHISHA_CENTER_X,
      centerZ: SHISHA_CENTER_Z,
      halfX: 420,
      halfZ: 410,
      kind: 'prop',
    },
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
// Scratch for walkable-zone Y result
let _sGroundY = -2; // default: sand floor

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
 *   - For SOLID colliders: push along the axis of SMALLER overlap — gives
 *     natural "slide along wall" feel.
 *   - For WALKABLE colliders: do NOT push XZ. Instead, record the surface
 *     topY so the caller can raise the entity's Y. The last encountered
 *     walkable zone wins (outermost-first list order, inner kiosk is solid).
 *
 * @param fromX        Current world X (retained for API stability with old disc
 *                     collider; used by clampEntityMovement2D for the outward-
 *                     movement escape hatch in future swept-AABB work).
 * @param fromZ        Current world Z (see fromX note).
 * @param toX          Desired world X after movement.
 * @param toZ          Desired world Z after movement.
 * @param entityHalf   Half-width of the moving entity (Minkowski expansion of
 *                     each collider AABB). Default 0 = treat entity as a point.
 *                     Typical: 30wu for chibi, 50-60wu for adult humanoid.
 * @returns            `{ x, z, hit, groundY }` where:
 *                       x, z    — clamped world position.
 *                       hit     — true if any solid collider was entered.
 *                       groundY — world Y of the walkable surface the entity is
 *                                 standing on, or -2 (sand floor) if not on any
 *                                 walkable zone. Use this to raise avatar.y.
 */
export function clampMovement2D(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  entityHalf: number = 0,
): { x: number; z: number; hit: boolean; groundY: number } {
  // Note: fromX / fromZ retained in signature to preserve back-compat with the
  // previous disc implementation. Currently unused. Linter would flag if we
  // dropped them outright, and a future swept-AABB path will reuse them.
  void fromX;
  void fromZ;

  const colliders = getAllColliders();
  _sCx = toX;
  _sCz = toZ;
  _sGroundY = -2; // reset to sand floor default each call
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
      if (col.walkable) {
        // Walkable zone — record surface Y, do NOT push XZ.
        // The caller is responsible for blending the entity's Y toward groundY.
        // Use topY ?? -2 so missing topY falls back to sand floor.
        _sGroundY = col.topY ?? -2;
      } else {
        // Solid zone — push along the axis of smaller overlap.
        hit = true;
        if (ox < oz) {
          _sCx += _sCx < col.centerX ? -ox : ox;
        } else {
          _sCz += _sCz < col.centerZ ? -oz : oz;
        }
      }
    }
  }

  return { x: _sCx, z: _sCz, hit, groundY: _sGroundY };
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
 * @returns             `{ x, z, hit, groundY }` clamped world position.
 */
export function clampEntityMovement2D(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  entityHalf: number = 0,
  otherEntities: readonly EntityPosition[] = [],
  otherHalf: number = entityHalf,
): { x: number; z: number; hit: boolean; groundY: number } {
  // Pass 1: world AABB colliders. Pass real fromX/fromZ so clampMovement2D's
  // escape-hatch (allow outward movement when entity is already inside a
  // collider) uses the entity's actual position, not a hardcoded origin.
  const worldResult = clampMovement2D(fromX, fromZ, toX, toZ, entityHalf);
  _eEx = worldResult.x;
  _eEz = worldResult.z;
  let hit = worldResult.hit;
  const groundY = worldResult.groundY;

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

  return { x: _eEx, z: _eEz, hit, groundY };
}

/** Half-width constants for entity push-out. */
export const ENTITY_HALF_CHIBI = 25;    // chibi VRM (135 wu height)
export const ENTITY_HALF_HUMANOID = 50; // adult humanoid (270 wu height)
