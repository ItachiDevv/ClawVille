/**
 * World-space bounds of every placed seabed decoration (lead staging finding
 * 2026-10-06 on ac36e4e1): kelp.glb's mesh sits at native x ≈ −44.5, so a
 * transform that only scales + grounds Y put each kelp prop 945–2363 wu away
 * from its tested site (two landed ~4840 / ~5040 wu from the plaza, past the
 * 3800 wu band and the 4160 wu building ring).
 *
 * The native bounds table is checked against the GLB files, then each prop is
 * placed with the SAME placement the renderer uses and its world box must be
 * centred on its site and stay inside the band and every exclusion.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { LAND_PARCELS } from '@clawville/shared';
import { buildingZones } from '@/lib/pixi/tilemap-data';
import { getAllColliders } from './collision/world-colliders';
import { CHARACTER_POSITIONS, COVE_EXIT_WORLD_X, COVE_EXIT_WORLD_Z, TALK_RADIUS_WORLD } from './character-positions';
import { TRADING_FLOOR_DOOR_WORLD, TRADING_FLOOR_PROMPT_RADIUS_WU } from './trading-floor/trading-floor-location';
import * as deco from './arena-terrain-decorations';

type Bounds = { min: [number, number, number]; max: [number, number, number] };

/** Native scene bounds (glTF units), read from the files by the first test. */
const NATIVE_BOUNDS: Record<string, Bounds> = {
  '/models/coral-reef1-ktx.glb?v=2': { min: [-3.747, -0.011, -0.45], max: [3.69, 0.641, 0.174] },
  '/models/coral-reef2-ktx.glb?v=2': { min: [-3.416, -0.011, -0.498], max: [3.242, 1.047, 0.232] },
  '/models/coral-reef3-ktx.glb?v=2': { min: [-3.85, -0.036, -3.042], max: [3.783, 2.108, 1.06] },
  '/models/kelp.glb': { min: [-45.509, -15.891, -0.136], max: [-43.507, -13.066, 2.175] },
  '/models/building-shell-ktx.glb?v=2': { min: [-0.299, -0.816, -0.745], max: [0.299, 0.658, 0.935] },
  '/models/building-seashell-ktx.glb?v=2': { min: [-3.926, -2.528, -1.798], max: [1.337, 1.765, 1.367] },
  '/models/building-anchor.glb': { min: [-2.344, -3.172, -2.577], max: [2.344, 3.367, -2.173] },
  '/models/building-barrel.glb': { min: [-0.521, 0.006, -0.519], max: [0.521, 1.352, 0.515] },
  '/models/building-chest.glb': { min: [-0.229, -0.245, -0.193], max: [0.132, 0.136, 0.237] },
  '/models/building-lantern-ktx.glb?v=2': { min: [-0.32, 0, -0.32], max: [0.32, 0.925, 0.32] },
  '/models/crayfish-ktx.glb?v=2': { min: [-22.81, 0.002, -42.99], max: [22.81, 19.261, 42.99] },
  '/models/building-tower2.glb': { min: [-4.624, -0.096, -4.819], max: [4.813, 14.502, 4.156] },
};

const FLOOR_Y = -2;
const INNER_R = 800;
const OUTER_R = 3800;
/** Clearance the placement rule keeps around sites (arena-terrain-decorations.ts). */
const SITE_CLEARANCE = 200;
/** Max horizontal reach of a 150 wu prop from its centre (half-diagonal). */
const MAX_REACH = 150 * Math.SQRT1_2;
/** A prop's footprint must keep at least this gap from every exclusion. */
const BODY_GAP = SITE_CLEARANCE - MAX_REACH;

type Placement = { scale: number; x: number; y: number; z: number };
type PlaceFn = (
  entry: { x: number; z: number; size: number; rotY: number },
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
) => Placement | null;

/**
 * The renderer's placement. Before the fix the module exported only
 * decorationTransform (scale + Y lift; X/Z = the site), which is what the
 * renderer used — modelled here so the tests fail first on the real math.
 */
function place(entry: deco.DecoEntry, b: Bounds): Placement {
  const mod = deco as Record<string, unknown>;
  const box = { minX: b.min[0], minY: b.min[1], minZ: b.min[2], maxX: b.max[0], maxY: b.max[1], maxZ: b.max[2] };
  if (typeof mod.decorationPlacement === 'function') {
    const p = (mod.decorationPlacement as PlaceFn)(entry, box);
    if (!p) throw new Error(`no placement for ${entry.model}`);
    return p;
  }
  const legacy = mod.decorationTransform as (s: number, d: number, y: number) => { scale: number; y: number };
  const maxDim = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const t = legacy(entry.size, maxDim, b.min[1]);
  return { scale: t.scale, x: entry.x, y: t.y, z: entry.z };
}

/** World AABB of the native box under T(p) · Ry(rotY) · S(scale) — the renderer's matrix. */
function worldBox(entry: deco.DecoEntry, b: Bounds) {
  const p = place(entry, b);
  const c = Math.cos(entry.rotY);
  const s = Math.sin(entry.rotY);
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const corners: Array<[number, number]> = [];
  for (const x of [b.min[0], b.max[0]]) {
    for (const y of [b.min[1], b.max[1]]) {
      for (const z of [b.min[2], b.max[2]]) {
        const wx = p.scale * (c * x + s * z) + p.x;
        const wz = p.scale * (-s * x + c * z) + p.z;
        xs.push(wx);
        ys.push(p.scale * y + p.y);
        zs.push(wz);
        corners.push([wx, wz]);
      }
    }
  }
  return {
    cx: (Math.min(...xs) + Math.max(...xs)) / 2,
    cz: (Math.min(...zs) + Math.max(...zs)) / 2,
    minY: Math.min(...ys),
    corners,
  };
}

const decorations = deco.generateDecorations();

describe('decoration native bounds', () => {
  it('the table matches the GLB files', async () => {
    await MeshoptDecoder.ready;
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    expect(Object.keys(NATIVE_BOUNDS).sort()).toEqual(deco.DECO_TYPES.map((t) => t.model).sort());
    for (const [model, expected] of Object.entries(NATIVE_BOUNDS)) {
      const doc = await io.read(join(import.meta.dir, '../../../public', model.split('?')[0]));
      const root = doc.getRoot();
      const b = getBounds(root.getDefaultScene() ?? root.listScenes()[0]);
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(b.min[i] - expected.min[i])).toBeLessThan(0.002);
        expect(Math.abs(b.max[i] - expected.max[i])).toBeLessThan(0.002);
      }
    }
  }, 30_000);
});

describe('placed decorations in world space', () => {
  it('centres every prop on its tested site', () => {
    const misses: string[] = [];
    for (const d of decorations) {
      const w = worldBox(d, NATIVE_BOUNDS[d.model]);
      const off = Math.hypot(w.cx - d.x, w.cz - d.z);
      if (off > 2) misses.push(`${d.model} off by ${off.toFixed(0)} wu`);
    }
    expect(misses).toEqual([]);
  });

  it('sits every prop on the sand', () => {
    for (const d of decorations) {
      expect(Math.abs(worldBox(d, NATIVE_BOUNDS[d.model]).minY - FLOOR_Y)).toBeLessThan(0.01);
    }
  });

  it('keeps every prop body inside the 800-3800 wu band', () => {
    const out: string[] = [];
    for (const d of decorations) {
      for (const [x, z] of worldBox(d, NATIVE_BOUNDS[d.model]).corners) {
        const r = Math.hypot(x, z);
        if (r < INNER_R || r > OUTER_R) out.push(`${d.model} corner at r ${r.toFixed(0)}`);
      }
    }
    expect(out).toEqual([]);
  });

  it('keeps every prop body clear of colliders, parcels, lanes, residents and entrances', () => {
    const hits: string[] = [];
    const lanes = getAllColliders().filter((c) => buildingZones.some((z) => z.id === c.id));
    const boxes = [
      ...getAllColliders(),
      ...LAND_PARCELS.map((p) => ({ id: p.id, centerX: p.cx, centerZ: p.cz, halfX: p.size / 2, halfZ: p.size / 2 })),
    ];
    const circles = [
      ...Object.values(CHARACTER_POSITIONS).map((r) => ({ id: r.characterName, x: r.worldX, z: r.worldZ, r: TALK_RADIUS_WORLD })),
      { id: 'trading-floor-door', x: TRADING_FLOOR_DOOR_WORLD.x, z: TRADING_FLOOR_DOOR_WORLD.z, r: TRADING_FLOOR_PROMPT_RADIUS_WU },
      { id: 'cove-tunnel', x: COVE_EXIT_WORLD_X, z: COVE_EXIT_WORLD_Z, r: 500 },
    ];
    for (const d of decorations) {
      for (const [x, z] of worldBox(d, NATIVE_BOUNDS[d.model]).corners) {
        for (const b of boxes) {
          if (Math.abs(x - b.centerX) < b.halfX + BODY_GAP && Math.abs(z - b.centerZ) < b.halfZ + BODY_GAP) hits.push(`${d.model} in ${b.id}`);
        }
        for (const c of circles) if (Math.hypot(x - c.x, z - c.z) < c.r + BODY_GAP) hits.push(`${d.model} in ${c.id}`);
        for (const l of lanes) {
          const len = Math.hypot(l.centerX, l.centerZ);
          const t = (x * l.centerX + z * l.centerZ) / len;
          if (t > 0 && t < len && Math.abs(x * l.centerZ - z * l.centerX) / len < deco.DECO_LANE_HALF_WIDTH - MAX_REACH) {
            hits.push(`${d.model} in ${l.id} lane`);
          }
        }
      }
    }
    expect([...new Set(hits)]).toEqual([]);
  });

  it('renders every prop at its target size (max dimension)', () => {
    for (const d of decorations) {
      const b = NATIVE_BOUNDS[d.model];
      const maxDim = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      expect(place(d, b).scale * maxDim).toBeCloseTo(d.size, 6);
    }
  });
});
