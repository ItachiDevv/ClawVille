// ---------------------------------------------------------------------------
// world-colliders.ts
// XZ-plane disc collision for the ClawVille open world.
//
// No physics engine, no draw calls, no vertical collision.
// Pure math: circle vs circle in the flat XZ plane.
//
// SCALE FACTOR RATIONALE (scaleFactor = 0.85):
//   Building tile zones are 14×14 tiles = 448×448 wu each.
//   Half-extent = 224wu. At 0.85× that gives radius ≈ 190wu.
//   0.85 gives slight clearance so a player can pass close to a corner
//   without an obvious invisible wall, while still blocking interior access.
//   If testing shows corners are still enterable, raise to 0.90-0.95.
//   If the wall feels too far out, lower to 0.75-0.80.
//   Chosen value: 0.85 (2026-05-19 initial ship).
//
// ZERO PER-FRAME ALLOCATIONS:
//   clampMovement2D uses module-scope scratch arrays (no new Vec2 each call).
// ---------------------------------------------------------------------------

import { buildingZones, TILE_SIZE, MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

const HALF_W = MAP_WIDTH / 2;  // 5760
const HALF_H = MAP_HEIGHT / 2; // 5760

/**
 * Axis-aligned disc collider in world XZ coordinates.
 *   x, z  — world-space center (Three.js XZ plane)
 *   radius — collision radius in world units
 *   kind   — 'building' or 'prop' (informational only, not used in math)
 *   id     — stable identifier for debugging
 */
export interface Collider2D {
  id: string;
  x: number;
  z: number;
  radius: number;
  kind: 'building' | 'prop';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Scale factor applied to half the zone tile extent to get building
 * collision radius. 0.85 of half the 448wu tile zone = ~190wu radius.
 * Matches the visual footprint closely while allowing corner scraping.
 */
const BUILDING_SCALE_FACTOR = 0.85;

// Half the 14-tile zone dimension in world units: (14 × 32) / 2 = 224wu
const BUILDING_HALF_TILE_EXTENT = (14 * TILE_SIZE) / 2; // 224

// Building collision radius — same for all 12 buildings (uniform tile zone).
const BUILDING_RADIUS = BUILDING_HALF_TILE_EXTENT * BUILDING_SCALE_FACTOR; // ≈ 190.4wu

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
      x: centerTileX * TILE_SIZE - HALF_W,
      z: centerTileY * TILE_SIZE - HALF_H,
      radius: BUILDING_RADIUS,
      kind: 'building',
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Town-center prop colliders — hardcoded world-space positions.
  //    Positions sourced from each prop's tsx file (verified 2026-05-19):
  //      AuctionPodium:       (0, -1000) — auction-podium.tsx DOME_X/Z
  //      TownDirectorySign:   (0, -120)  — town-directory-sign.tsx SIGN_X/Z
  //      BazaarStall:         (-1273, 450) — bazaar-stall.tsx STALL_X/Z
  //      MarketplaceStall:    (1273, 450)  — marketplace-stall.tsx STALL_X/Z
  //      BountyBoardObject:   (50, 0)     — bounty-board-object.tsx BOARD_X/Z
  //      QuestNpc:            (-110, -60) — quest-npc.tsx QUEST_NPC_X/Z
  //      TownGuide (Nori):    (0, 240)    — town-guide.tsx NORI_WORLD_X/Z
  //
  //  Radius tuning:
  //    AuctionPodium:     180wu — dome is relatively small (~200wu base radius)
  //    TownDirectorySign:  80wu — narrow sign, doesn't need large exclusion
  //    BazaarStall:       200wu — tall tent, wide physical footprint
  //    MarketplaceStall:  220wu — slightly wider stall
  //    BountyBoardObject:  60wu — flat board on a post
  //    QuestNpc:           50wu — character NPC, tight enough to chat with
  //    TownGuide:          50wu — same as QuestNpc; tight so talking is easy
  // ---------------------------------------------------------------------------
  const PROPS: Collider2D[] = [
    { id: 'auction-podium',     x:    0, z: -1000, radius: 180, kind: 'prop' },
    { id: 'town-directory-sign',x:    0, z:  -120, radius:  80, kind: 'prop' },
    { id: 'bazaar-stall',       x: -1273, z:   450, radius: 200, kind: 'prop' },
    { id: 'marketplace-stall',  x:  1273, z:   450, radius: 220, kind: 'prop' },
    { id: 'bounty-board',       x:   50, z:     0, radius:  60, kind: 'prop' },
    { id: 'quest-npc',          x: -110, z:   -60, radius:  50, kind: 'prop' },
    { id: 'town-guide',         x:    0, z:   240, radius:  50, kind: 'prop' },
  ];
  colliders.push(...PROPS);

  return colliders;
}

// ---------------------------------------------------------------------------
// Module-scope scratch values — zero per-frame allocations
// ---------------------------------------------------------------------------

// dx, dz components reused across clampMovement2D calls.
// Not thread-safe (JavaScript is single-threaded — no concern here).
let _sDx = 0;
let _sDz = 0;

/**
 * Clamp a proposed XZ movement against all world colliders.
 *
 * Call AFTER computing the desired next position, BEFORE writing it to the
 * avatar/NPC transform.
 *
 * Soft-clamp semantics:
 *   - If `to` is outside all colliders → returns `to` unchanged (hit=false).
 *   - If `to` is inside a collider's radius → push `to` radially outward to
 *     the collider boundary, then test remaining colliders with the adjusted
 *     position. This naturally gives "slide along wall" feel — you can run
 *     along the edge of a building corner without stopping dead.
 *   - If `from` is ALREADY inside a collider (rare — e.g. a new collider was
 *     placed on top of an existing entity), we allow outward movement (dist
 *     to center increases) and block inward movement. This prevents the player
 *     from getting permanently trapped.
 *
 * @param fromX  Current world X
 * @param fromZ  Current world Z
 * @param toX    Desired world X after movement
 * @param toZ    Desired world Z after movement
 * @returns      `{ x, z }` clamped world position, and `hit` true if any
 *               collider was intersected.
 */
export function clampMovement2D(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): { x: number; z: number; hit: boolean } {
  const colliders = getAllColliders();
  let cx = toX;
  let cz = toZ;
  let hit = false;

  for (let i = 0; i < colliders.length; i++) {
    const col = colliders[i];
    _sDx = cx - col.x;
    _sDz = cz - col.z;
    const distSq = _sDx * _sDx + _sDz * _sDz;
    const r = col.radius;
    const rSq = r * r;

    if (distSq < rSq) {
      // `to` is inside this collider.
      // Check the escape hatch: if `from` is also inside this collider,
      // allow the movement IF it is moving OUTWARD (dist increases).
      const fDx = fromX - col.x;
      const fDz = fromZ - col.z;
      const fromDistSq = fDx * fDx + fDz * fDz;
      if (fromDistSq < rSq) {
        // Both from and to are inside the collider.
        // Allow only outward motion: if moving outward, don't clamp.
        if (distSq >= fromDistSq) continue;
        // Moving further in — clamp.
      }

      hit = true;
      // Push `to` to the boundary — radial outward from collider center.
      const dist = Math.sqrt(distSq);
      if (dist < 0.001) {
        // Exactly on center — push north (arbitrary safe direction).
        cx = col.x;
        cz = col.z + r;
      } else {
        const invDist = 1 / dist;
        cx = col.x + _sDx * invDist * r;
        cz = col.z + _sDz * invDist * r;
      }
    }
  }

  return { x: cx, z: cz, hit };
}
