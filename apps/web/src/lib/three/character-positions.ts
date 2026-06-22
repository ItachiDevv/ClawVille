// ---------------------------------------------------------------------------
// character-positions.ts
// Shared source-of-truth for NPC/character world positions and talk-proximity.
//
// Exports:
//   VILLAGE_CENTER_TILE_X / Z  — shared with arena-location-npcs.tsx
//   NPC_INSET_WORLD            — shared with arena-location-npcs.tsx
//   CHARACTER_POSITIONS        — module-scope map: buildingId → world coords
//   TALK_RADIUS_WORLD          — proximity radius for chat activation
//   findNearestCharacter()     — pure-primitive, zero-alloc nearest-character check
// ---------------------------------------------------------------------------

import {
  buildingZones,
  TILE_SIZE,
  MAP_WIDTH,
  MAP_HEIGHT,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Shared constants (imported by arena-location-npcs.tsx — single source of truth)
// ---------------------------------------------------------------------------

/** Village center in tile space — derived from MAP_WIDTH so a future world grow
 *  re-centers automatically.
 *  Phase 0 land (2026-06-15): 576×576 tile grid, center at tile (288, 288).
 *  MAP_WIDTH/TILE_SIZE/2 = 18432/32/2 = 288.
 *  worldX = -9216 + 288*32 = 0, worldZ = -9216 + 288*32 = 0. */
export const VILLAGE_CENTER_TILE_X = MAP_WIDTH / TILE_SIZE / 2;
/** Tile Y column mapping to world Z axis — village center row. */
export const VILLAGE_CENTER_TILE_Z = MAP_HEIGHT / TILE_SIZE / 2;

/** How far (in world units) NPCs stand from their building center toward
 *  village center.  1300 = MAX_FOOTPRINT/2 (900) + 400 wu margin, placing NPCs
 *  clearly OUTSIDE the widest possible building (MAX_FOOTPRINT=1800 → half=900)
 *  with extra clearance for squat wide buildings like Patrick's Rock.
 *
 *  History:
 *    600 wu — Phase 6.0 (MAX_FOOTPRINT=1000). NPCs spawned INSIDE buildings when
 *             MAX_FOOTPRINT rose to 1500/1800 (Phase 6.1) because 600 < 900.
 *   1000 wu — Phase 6.1.1 fix: MAX_FOOTPRINT/2 + 100 wu clearance. Fixed Mrs. Puff
 *             and Sandy but not Patrick — rock dome extends further toward center.
 *   1300 wu — Phase 6.2 fix (2026-05-18): MAX_FOOTPRINT/2 + 400 wu clearance.
 *             With ring R=160 tiles (5120 wu), NPCs land at ~3820 wu from center
 *             vs building center at 5120 wu — 1300 wu in front of building face.
 *             Clears all buildings including Patrick's Rock (widest squat dome). */
export const NPC_INSET_WORLD = 1300; // world units

// ---------------------------------------------------------------------------
// World-space offsets (tile-space origin → Three.js world origin)
// ---------------------------------------------------------------------------
const OFFSET_X = -MAP_WIDTH  / 2; // -9216 (Phase 0 land: 18432-world)
const OFFSET_Z = -MAP_HEIGHT / 2; // -9216

// ---------------------------------------------------------------------------
// computeNpcPlacement — identical logic to arena-location-npcs.tsx.
// Kept here (not imported from there) so character-positions.ts has no React
// dependency.  arena-location-npcs.tsx imports the constants above and has its
// own copy of the function body; the outputs are guaranteed identical because
// both use the same constants.
// ---------------------------------------------------------------------------
function computeNpcPlacement(zone: { x: number; y: number; width: number; height: number }): {
  worldX: number;
  worldZ: number;
  facingRotY: number;
} {
  const bcx = zone.x + zone.width  / 2;
  const bcz = zone.y + zone.height / 2;

  const dx = VILLAGE_CENTER_TILE_X - bcx;
  const dz = VILLAGE_CENTER_TILE_Z - bcz;
  const len = Math.sqrt(dx * dx + dz * dz);

  let npcTileX = bcx;
  let npcTileZ = bcz;
  if (len > 0.001) {
    const invLen = 1 / len;
    const insetTiles = NPC_INSET_WORLD / TILE_SIZE;
    npcTileX = bcx + (dx * invLen) * insetTiles;
    npcTileZ = bcz + (dz * invLen) * insetTiles;
  }

  const worldX = OFFSET_X + npcTileX * TILE_SIZE;
  const worldZ = OFFSET_Z + npcTileZ * TILE_SIZE;
  const facingRotY = Math.atan2(dx, dz);

  return { worldX, worldZ, facingRotY };
}

// ---------------------------------------------------------------------------
// CHARACTER_NAMES — maps buildingId → canonical character name.
// Mirrors LOCATION_NPCS in arena-location-npcs.tsx.  Only primary NPCs are
// registered here; companions are not talk targets.
// ---------------------------------------------------------------------------
const CHARACTER_NAMES: Record<string, string> = {
  'visual-creation':     'SpongeBob',
  'memory-rag':      'Squidward',
  'app-publishing':       'Mrs. Puff',
  'deployment-ops':    'Larry',
  'mcp-tool-use':     'Mr. Krabs',
  'code-development':       'Plankton',
  'messaging-channels':    'Sandy',
  'agent-security': 'Patrick',
  'api-integrations':   'Flying Dutchman',
  'cron-automation':          'Pearl',
};

// ---------------------------------------------------------------------------
// CHARACTER_POSITIONS — computed once at module load, zero runtime cost.
// Positions are bit-identical to what arena-location-npcs.tsx renders because
// both run the same computeNpcPlacement() on the same buildingZones entries
// using the same shared constants.
// ---------------------------------------------------------------------------
export interface CharacterPosition {
  buildingId: string;
  characterName: string;
  worldX: number;
  worldZ: number;
  facingRotY: number;
}

export const CHARACTER_POSITIONS: Record<string, CharacterPosition> = (() => {
  const result: Record<string, CharacterPosition> = {};
  for (const zone of buildingZones) {
    const name = CHARACTER_NAMES[zone.id];
    if (!name) continue; // no character at this building
    const { worldX, worldZ, facingRotY } = computeNpcPlacement(zone);
    result[zone.id] = { buildingId: zone.id, characterName: name, worldX, worldZ, facingRotY };
  }
  return result;
})();

// ---------------------------------------------------------------------------
// TALK_RADIUS_WORLD — radius (world units) within which the player can talk
// to a character.  260 wu ≈ 1.5× CHARACTER_HEIGHT (55 wu) gives a small
// talk bubble around each character without bleeding into neighbors
// (buildings are ~1367 wu apart at the ring circumference).
// ---------------------------------------------------------------------------
export const TALK_RADIUS_WORLD = 260;

// Squared radius — avoids sqrt in the hot path.
const TALK_RADIUS_SQ = TALK_RADIUS_WORLD * TALK_RADIUS_WORLD;

// ---------------------------------------------------------------------------
// COVE proximity (town-ux-2026-06-19)
// The Cove casino has no NPC teacher, so it is NOT in CHARACTER_POSITIONS.
// We expose a separate check so player-avatar.tsx can set nearLocation='cove'
// when the player is close enough for the entry prompt to appear.
//
// Cove zone: id='cove', x=151, y=281, width=14, height=14.
//   Tile center: cx=158, cy=288.
//   World: worldX = -9216 + 158*32 = -4160, worldZ = -9216 + 288*32 = 0.
// ---------------------------------------------------------------------------
const COVE_WORLD_X = OFFSET_X + 158 * TILE_SIZE; // ≈ -4160 wu
const COVE_WORLD_Z = OFFSET_Z + 288 * TILE_SIZE; // ≈ 0 wu
/** Radius (wu) within which the cove entry prompt appears. 600 wu = comfortably
 *  visible from the approach path without triggering across the ring. */
export const COVE_PROXIMITY_RADIUS = 600;
const COVE_PROXIMITY_SQ = COVE_PROXIMITY_RADIUS * COVE_PROXIMITY_RADIUS;

// Tunnel corridor approach (town-ux controls-rework 2026-06-21).
// The walk-in tunnel runs along +X (town-facing) from the pyramid: mouth at
// world X ≈ -3275, and the cove collision AABB east edge is at X ≈ -3586, so the
// WALKABLE corridor segment is roughly X ∈ [-3586, -3275], Z ≈ 0 (±90 wide).
// The 600 wu circle above is centered at the pyramid (-4160) and does NOT reach
// the mouth (885 wu away), so the "Press E · Enter the Cove" prompt would only
// appear jammed against the wall. We widen proximity along the corridor so the
// prompt shows as the player approaches/enters the tunnel mouth.
const COVE_TUNNEL_PROMPT_MIN_X = -3640; // just east of the collision wall
const COVE_TUNNEL_PROMPT_MAX_X = -3180; // ~95 wu in front of the mouth
const COVE_TUNNEL_PROMPT_Z_HALF = 150;
/** Deeper threshold: when the player walks THIS far into the corridor the cove
 *  auto-enters (no click/E needed). -3450 sits between mid-tunnel (-3400) and the
 *  collision wall (-3586) so it is always reachable on foot. */
export const COVE_AUTO_ENTER_MAX_X = -3450;
const COVE_AUTO_ENTER_Z_HALF = 120;

/**
 * isCoveProximate — true when the player is within the cove entry-prompt range:
 * either inside the 600 wu circle around the pyramid OR inside the tunnel
 * approach corridor. Zero-alloc, pure-primitive, safe in useFrame.
 */
export function isCoveProximate(playerWorldX: number, playerWorldZ: number): boolean {
  const dx = playerWorldX - COVE_WORLD_X;
  const dz = playerWorldZ - COVE_WORLD_Z;
  if ((dx * dx + dz * dz) < COVE_PROXIMITY_SQ) return true;
  // Tunnel approach corridor (thin +X band centered on the tunnel).
  return (
    playerWorldX >= COVE_TUNNEL_PROMPT_MIN_X &&
    playerWorldX <= COVE_TUNNEL_PROMPT_MAX_X &&
    Math.abs(playerWorldZ - COVE_WORLD_Z) <= COVE_TUNNEL_PROMPT_Z_HALF
  );
}

/**
 * isInsideCoveTunnel — true when the player has walked DEEP into the corridor
 * (past COVE_AUTO_ENTER_MAX_X within the tunnel width). Drives the auto-enter
 * walk-in. Zero-alloc, pure-primitive, safe in useFrame.
 */
export function isInsideCoveTunnel(playerWorldX: number, playerWorldZ: number): boolean {
  return (
    playerWorldX <= COVE_AUTO_ENTER_MAX_X &&
    playerWorldX >= COVE_TUNNEL_PROMPT_MIN_X - 80 &&
    Math.abs(playerWorldZ - COVE_WORLD_Z) <= COVE_AUTO_ENTER_Z_HALF
  );
}

// ---------------------------------------------------------------------------
// findNearestCharacter — zero-alloc, pure-primitive proximity check.
// Arguments are primitive numbers so the caller never needs to allocate a
// scratch Vector3 before calling (safe in useFrame hot path).
//
// Returns the nearest character within TALK_RADIUS_WORLD, or null.
// ---------------------------------------------------------------------------
export function findNearestCharacter(
  playerWorldX: number,
  playerWorldZ: number,
): { buildingId: string; characterName: string; distance: number } | null {
  let bestId: string | null = null;
  let bestName = '';
  let bestDistSq = Infinity;

  for (const id in CHARACTER_POSITIONS) {
    const cp = CHARACTER_POSITIONS[id];
    const dxW = playerWorldX - cp.worldX;
    const dzW = playerWorldZ - cp.worldZ;
    const distSq = dxW * dxW + dzW * dzW;
    if (distSq < TALK_RADIUS_SQ && distSq < bestDistSq) {
      bestDistSq = distSq;
      bestId = id;
      bestName = cp.characterName;
    }
  }

  if (bestId === null) return null;
  return {
    buildingId: bestId,
    characterName: bestName,
    distance: Math.sqrt(bestDistSq),
  };
}
