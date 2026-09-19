/**
 * Where each ring building stands, seen from the town centre, computed from
 * `MAP_LOCATIONS` so the knowledge text cannot drift from the map.
 *
 * 2026-09-19, production: Nori told a guest the Downtown Building was
 * "directly north at (0, -1220)" (that is the Quest + Bounty Pavilion). No
 * knowledge surface said where the buildings are, so the model borrowed the
 * only coordinates it had. See feedback "knowledge must state PLACE".
 *
 * World axes (Three.js): +X is east, +Z is south, so north is -Z. World units
 * equal game pixels shifted by the world centre (`worldX = gameX - 11264`).
 * A building's point is the centre of its map zone, not the zone's corner.
 */

import { MAP_LOCATIONS } from './map-locations';
import { WORLD_CENTER_PX } from './world-dimensions';

const COMPASS_16 = [
  'north', 'north-northeast', 'northeast', 'east-northeast',
  'east', 'east-southeast', 'southeast', 'south-southeast',
  'south', 'south-southwest', 'southwest', 'west-southwest',
  'west', 'west-northwest', 'northwest', 'north-northwest',
] as const;

export type CompassPoint = (typeof COMPASS_16)[number];

/** 16-point compass word for a world-space offset (+X east, +Z south). */
export function compassFromWorldOffset(dx: number, dz: number): CompassPoint {
  const bearing = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  return COMPASS_16[Math.round(bearing / 22.5) % 16];
}

export interface TownBuildingPlace {
  id: string;
  name: string;
  /** Zone centre in world units (origin = town centre). */
  worldX: number;
  worldZ: number;
  /** Zone centre in game pixels (what REST `/api/agent/move` takes). */
  gameX: number;
  gameY: number;
  /** Straight-line distance from the town centre, world units. */
  distance: number;
  direction: CompassPoint;
}

/** The 12 ring buildings in map order (clockwise from north). */
export const TOWN_BUILDING_PLACES: readonly TownBuildingPlace[] = MAP_LOCATIONS.map((l) => {
  const gameX = Math.round(l.positionX + l.width / 2);
  const gameY = Math.round(l.positionY + l.height / 2);
  const worldX = gameX - WORLD_CENTER_PX.x;
  const worldZ = gameY - WORLD_CENTER_PX.y;
  return {
    id: l.id,
    name: l.name,
    worldX,
    worldZ,
    gameX,
    gameY,
    distance: Math.round(Math.hypot(worldX, worldZ)),
    direction: compassFromWorldOffset(worldX, worldZ),
  };
});

/** Ring radius rounded to the nearest 100 world units, for prose. */
export const TOWN_BUILDING_RING_RADIUS_WU =
  Math.round(
    TOWN_BUILDING_PLACES.reduce((sum, p) => sum + p.distance, 0) / TOWN_BUILDING_PLACES.length / 100,
  ) * 100;

/** One knowledge line: every ring building with its direction and world point. */
export function buildTownBuildingDirectionsLine(): string {
  const parts = TOWN_BUILDING_PLACES.map(
    (p) => `${p.name} is ${p.direction} at world (${p.worldX}, ${p.worldZ})`,
  );
  return (
    `Where the 12 buildings stand: they form one ring about ${TOWN_BUILDING_RING_RADIUS_WU.toLocaleString('en-US')} world units ` +
    'from the town centre at world (0, 0). North is toward the Quest + Bounty Pavilion and the Pineapple House; ' +
    'south is toward the spawn and the Downtown Building. Going clockwise from north: ' +
    `${parts.join('; ')}. Each teacher stands just outside their own building, on the side that faces the town centre.`
  );
}
