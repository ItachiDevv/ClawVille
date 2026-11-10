import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
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
import { WORLD_DEVICE_PROFILE } from './device-class';
import { DEFAULT_WORLD_PERF_FLAGS } from './PerfAudit';
import ArenaTerrain from './arena-terrain';
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
  decorationPlacement,
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

  it('sizes every prop between 20 and 150 wu (avatars are 179 wu tall)', () => {
    for (const t of DECO_TYPES) {
      expect(t.minSize).toBeGreaterThanOrEqual(20);
      expect(t.maxSize).toBeLessThanOrEqual(150);
      expect(t.minSize).toBeLessThan(t.maxSize);
    }
    const byModel = new Map(DECO_TYPES.map((t) => [t.model, t]));
    for (const d of decorations) {
      const t = byModel.get(d.model);
      expect(t).toBeDefined();
      expect(d.size).toBeGreaterThanOrEqual(t!.minSize);
      expect(d.size).toBeLessThanOrEqual(t!.maxSize);
    }
  });
});

describe('decorationPlacement', () => {
  const box = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) =>
    ({ minX, minY, minZ, maxX, maxY, maxZ });

  it('scales by the native max-dimension and grounds the lowest point on the sand', () => {
    // building-chest.glb: native max-dim 0.43 — the old raw scale 3-12 gave 1-5 wu.
    const chest = decorationPlacement({ x: 0, z: 0, size: 30, rotY: 0 }, box(-0.2, -0.2, -0.2, 0.23, 0.1, 0.1));
    expect(chest).not.toBeNull();
    expect(chest!.scale * 0.43).toBeCloseTo(30, 6);
    expect(chest!.y + -0.2 * chest!.scale).toBeCloseTo(-2, 6);
  });

  it('puts the rotated native X/Z centre on the site (kelp sits at native x -44.5)', () => {
    const kelp = box(-45.509, -15.891, -0.136, -43.507, -13.066, 2.175);
    for (const rotY of [0, 0.7, Math.PI / 2, 2.9, -1.3]) {
      const p = decorationPlacement({ x: 1500, z: -2200, size: 100, rotY }, kelp)!;
      const cx = (kelp.minX + kelp.maxX) / 2;
      const cz = (kelp.minZ + kelp.maxZ) / 2;
      const c = Math.cos(rotY);
      const s = Math.sin(rotY);
      expect(p.scale * (c * cx + s * cz) + p.x).toBeCloseTo(1500, 6);
      expect(p.scale * (-s * cx + c * cz) + p.z).toBeCloseTo(-2200, 6);
    }
  });

  it('rejects a degenerate bounding box', () => {
    const e = { x: 0, z: 0, size: 50, rotY: 0 };
    expect(decorationPlacement(e, box(0, 0, 0, 0, 0, 0))).toBeNull();
    expect(decorationPlacement(e, box(Number.NaN, 0, 0, 1, 1, 1))).toBeNull();
    expect(decorationPlacement(e, box(0, 0, 0, 1, Number.POSITIVE_INFINITY, 1))).toBeNull();
  });
});

// Lead decisions 2026-10-06: the seabed decorations follow the ground-cover
// switch. The device profile's `ambientGroundCover` (false on phones and
// tablets) decides whether they MOUNT; the `groundCover` flag (governor tier 1
// clears it) only toggles VISIBILITY, so a tier change never re-merges.
describe('seabed decorations follow the groundCover switch', () => {
  it('mounts on desktop profiles only', () => {
    for (const cls of ['desktop-low', 'desktop-capable'] as const) expect(WORLD_DEVICE_PROFILE[cls].ambientGroundCover).toBe(true);
    for (const cls of ['phone', 'tablet'] as const) expect(WORLD_DEVICE_PROFILE[cls].ambientGroundCover).toBe(false);
    expect(DEFAULT_WORLD_PERF_FLAGS.groundCover).toBe(true);
  });

  it('ArenaTerrain mounts the scatter per profile and passes visibility down', () => {
    const terrain = ArenaTerrain as unknown as (props: { decorationsMounted: boolean; decorationsVisible: boolean }) => ReactElement;
    const children = (el: ReactElement): ReactElement[] => {
      const out: ReactElement[] = [];
      const walk = (n: ReactNode) => {
        if (Array.isArray(n)) n.forEach(walk);
        else if (isValidElement(n)) out.push(n);
      };
      walk((el.props as { children?: ReactNode }).children);
      return out;
    };
    const nameOf = (k: ReactElement) => ((k.type as { name?: string }).name ?? String(k.type));
    // web-load T11: the scatter sits behind the first-show latch component.
    const deco = (el: ReactElement) => children(el).find((k) => nameOf(k) === 'SeabedDecorationsOnFirstShow');
    expect(children(terrain({ decorationsMounted: false, decorationsVisible: true })).map(nameOf)).toEqual(['SandFloor']);
    expect((deco(terrain({ decorationsMounted: true, decorationsVisible: false }))!.props as { visible: boolean }).visible).toBe(false);
    expect((deco(terrain({ decorationsMounted: true, decorationsVisible: true }))!.props as { visible: boolean }).visible).toBe(true);
  });

  it('World3DCanvas wires the profile to mount and showGroundCover to visibility', () => {
    const src = readFileSync(join(import.meta.dir, '../../components/three/World3DCanvas.tsx'), 'utf8');
    expect(src).toMatch(
      /<ArenaTerrain\s+decorationsMounted=\{CURRENT_WORLD_DEVICE_PROFILE\.ambientGroundCover\}\s+decorationsVisible=\{showGroundCover\}\s*\/>/,
    );
    // showGroundCover must still be the governor-driven flag.
    expect(src).toMatch(/const showGroundCover = flags\.groundCover && !staticOnly;/);
  });
});
