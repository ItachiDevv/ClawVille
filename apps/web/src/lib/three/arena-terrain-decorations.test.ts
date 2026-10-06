import { describe, expect, it } from 'bun:test';
import {
  KELP_FOREST_PORTAL_PROMPT_RADIUS_WU,
  KELP_FOREST_PORTAL_WORLD_CENTER,
  LAND_PARCELS,
  SPAWN_PX,
  WORLD_CENTER_PX,
  getServerColliders,
} from '@clawville/shared';
import { buildingZones } from '@/lib/pixi/tilemap-data';
import { getAllColliders } from './collision/world-colliders';
import {
  CHARACTER_POSITIONS,
  COVE_EXIT_WORLD_X,
  COVE_EXIT_WORLD_Z,
  TALK_RADIUS_WORLD,
} from './character-positions';
import {
  TRADING_FLOOR_DOOR_WORLD,
  TRADING_FLOOR_PROMPT_RADIUS_WU,
} from './trading-floor/trading-floor-location';
import {
  DECO_TYPES,
  DECO_INNER_EXCLUSION_R,
  generateDecorations,
  isNearBuilding,
} from './arena-terrain-decorations';

// Founder decision 2026-10-06: the seabed decorations come back, and buildings,
// land parcels, the spawn plaza, the building approach lanes and the portals
// stay clear. The clearances below are computed HERE from the shared world
// data, not read from the generator, so a generator bug cannot hide itself.

const TARGET_COUNT = 60;
const INNER_R = 800;
const OUTER_R = 3800;
const MIN_SPACING = 35;
/** Largest decoration footprint half-size (max dim ~150 wu) plus a walk gap. */
const CLEARANCE = 200;
/** Half-width of the walk lane from the plaza to each building's door. */
const LANE_HALF_WIDTH = 400;

const decorations = generateDecorations();

function outsideAabb(
  x: number,
  z: number,
  box: { centerX: number; centerZ: number; halfX: number; halfZ: number },
  pad: number,
): boolean {
  return (
    Math.abs(x - box.centerX) >= box.halfX + pad ||
    Math.abs(z - box.centerZ) >= box.halfZ + pad
  );
}

describe('seabed decoration scatter', () => {
  it('places the full target count', () => {
    expect(decorations.length).toBe(TARGET_COUNT);
  });

  it('is deterministic across calls', () => {
    expect(generateDecorations()).toEqual(decorations);
  });

  it('keeps every prop inside the visible 800-3800 wu band', () => {
    expect(DECO_INNER_EXCLUSION_R).toBe(INNER_R);
    for (const d of decorations) {
      const r = Math.hypot(d.x, d.z);
      expect(r).toBeGreaterThanOrEqual(INNER_R);
      expect(r).toBeLessThanOrEqual(OUTER_R);
    }
  });

  it('keeps every prop out of the legacy building exclusion circles', () => {
    for (const d of decorations) expect(isNearBuilding(d.x, d.z)).toBe(false);
  });

  it('keeps every prop clear of building, town-prop and portal colliders', () => {
    // Client table: all 12 buildings + town props. Server table: 10 buildings
    // (no cove / arcade), the same props and the kelp portal. Check both.
    const client = getAllColliders();
    for (const z of buildingZones) expect(client.some((c) => c.id === z.id)).toBe(true);
    const colliders = [...client, ...getServerColliders()];
    expect(colliders.some((c) => c.id === 'kelp-forest-portal')).toBe(true);
    for (const d of decorations) {
      for (const c of colliders) {
        if (!outsideAabb(d.x, d.z, c, CLEARANCE)) {
          throw new Error(`decoration (${d.x.toFixed(0)}, ${d.z.toFixed(0)}) inside ${c.id} + ${CLEARANCE} wu`);
        }
      }
    }
  });

  it('keeps every prop off land parcel footprints', () => {
    expect(LAND_PARCELS.length).toBeGreaterThan(0);
    for (const d of decorations) {
      for (const p of LAND_PARCELS) {
        const half = p.size / 2;
        const box = { centerX: p.cx, centerZ: p.cz, halfX: half, halfZ: half };
        if (!outsideAabb(d.x, d.z, box, CLEARANCE)) {
          throw new Error(`decoration (${d.x.toFixed(0)}, ${d.z.toFixed(0)}) inside parcel ${p.id}`);
        }
      }
    }
  });

  it('keeps every building approach lane and resident clear', () => {
    const residents = Object.values(CHARACTER_POSITIONS);
    expect(residents.length).toBe(10);
    for (const d of decorations) {
      for (const r of residents) {
        const dist = Math.hypot(d.x - r.worldX, d.z - r.worldZ);
        expect(dist).toBeGreaterThanOrEqual(TALK_RADIUS_WORLD + CLEARANCE);
      }
      // Lane = segment from the world centre to the building centre, widened.
      for (const c of getAllColliders()) {
        if (!buildingZones.some((z) => z.id === c.id)) continue;
        const len = Math.hypot(c.centerX, c.centerZ);
        const ux = c.centerX / len;
        const uz = c.centerZ / len;
        const t = d.x * ux + d.z * uz;
        if (t <= 0 || t >= len) continue;
        const perp = Math.abs(d.x * uz - d.z * ux);
        if (perp < LANE_HALF_WIDTH) {
          throw new Error(`decoration (${d.x.toFixed(0)}, ${d.z.toFixed(0)}) in the ${c.id} approach lane`);
        }
      }
    }
  });

  it('keeps the entrance prompt bands clear', () => {
    const entrances = [
      { id: 'kelp-portal', ...KELP_FOREST_PORTAL_WORLD_CENTER, r: KELP_FOREST_PORTAL_PROMPT_RADIUS_WU },
      { id: 'trading-floor-door', ...TRADING_FLOOR_DOOR_WORLD, r: TRADING_FLOOR_PROMPT_RADIUS_WU },
      // Cove tunnel prompt band x -3640..-3180, |z| <= 150, exit at x -3150.
      { id: 'cove-tunnel', x: COVE_EXIT_WORLD_X, z: COVE_EXIT_WORLD_Z, r: 500 },
    ];
    for (const d of decorations) {
      for (const e of entrances) {
        expect(Math.hypot(d.x - e.x, d.z - e.z)).toBeGreaterThanOrEqual(e.r + CLEARANCE);
      }
      const inCoveBand = d.x >= -3640 - CLEARANCE && d.x <= -3180 + CLEARANCE && Math.abs(d.z) <= 150 + CLEARANCE;
      expect(inCoveBand).toBe(false);
    }
  });

  it('keeps the spawn point clear', () => {
    const spawnX = SPAWN_PX.x - WORLD_CENTER_PX.x;
    const spawnZ = SPAWN_PX.y - WORLD_CENTER_PX.y;
    for (const d of decorations) {
      expect(Math.hypot(d.x - spawnX, d.z - spawnZ)).toBeGreaterThanOrEqual(INNER_R);
    }
  });

  it('keeps the minimum spacing between props', () => {
    for (let i = 0; i < decorations.length; i++) {
      for (let j = i + 1; j < decorations.length; j++) {
        const a = decorations[i];
        const b = decorations[j];
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(MIN_SPACING);
      }
    }
  });

  it('uses only known models with in-range scales', () => {
    const byModel = new Map(DECO_TYPES.map((t) => [t.model, t]));
    for (const d of decorations) {
      const t = byModel.get(d.model);
      expect(t).toBeDefined();
      expect(d.scale).toBeGreaterThanOrEqual(t!.minScale);
      expect(d.scale).toBeLessThanOrEqual(t!.maxScale);
    }
  });
});
