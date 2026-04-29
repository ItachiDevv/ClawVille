'use client';

/**
 * river-scene.tsx — Low-poly stylized river atmosphere for Reef Race v2.
 *
 * Visual target: Kagelok "The River" Sketchfab aesthetic.
 *   Bright sunny sky, flat-shaded OPAQUE cyan water ribbon,
 *   sandy cream bank ribbons on green grass hills.
 *   Low-poly trees / rocks / fences on the GREEN GRASS — not in the water.
 *
 * Contains:
 *   A. Green ground plane (large flat XZ plane under everything)
 *   B. Sandy bank ribbons (cream trianglestrip at water edge)
 *   C. Water ribbon swept along spline centerline (replaces rectangle "pool")
 *   D. Sky dome (SphereGeometry + MeshBasicMaterial vertexColors)
 *   E. ScenerySpawner (low-poly prop GLBs ON THE GRASS, not in water)
 *
 * Iris Xe invariants:
 *   - NO ShaderMaterial anywhere
 *   - NO InstancedMesh + ShaderMaterial combo
 *   - NO drei <Text> or <Billboard>
 *   - import from 'three' only (not 'three/webgpu')
 *   - All static geo/mat at module scope — zero per-frame GC
 *   - frustumCulled=false on all atmosphere meshes
 *   - matrixAutoUpdate=false on all static meshes
 *
 * Draw call budget:
 *   1 ground + 1 sand ribbon + 1 water ribbon + 1 dome + ≤6 scenery GLB types = ≤10 draw calls
 *
 * Tri count:
 *   Ground: 2 tris | Sand ribbon: 64×2=128 tris | Water ribbon: 64×2=128 tris
 *   Dome: ~1024 tris | Scenery: ~1000 tris est.
 *   Total new: ≈2300 tris — well within the ≤80k scene budget.
 *
 * Water Y placement:
 *   River bed at y=0. Water ribbon at y=40 (halfway up V2_BANK_HEIGHT=80).
 *   Sand ribbon at y=0.5 (just above river bed, below water surface).
 *   Ground plane at y=-1 (just below river bed — no z-fight with sandy river floor).
 */

import { Suspense, useRef, useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clientSpline } from './reef-race-spline-instance';

// ─── Track layout constants ───────────────────────────────────────────────────
// Track runs z=[0,18000]; slight overrun on each end for ground coverage.
const TRACK_LEN_Z    = 20000;
const TRACK_START_Z  = -500;
const TRACK_CENTER_Z = TRACK_START_Z + TRACK_LEN_Z / 2; // 9500

// ─── Ground plane ─────────────────────────────────────────────────────────────
const GROUND_W  = 8000;
const GROUND_L  = 22000;
const GROUND_Y  = -1;  // just below river bed at y=0

// ─── Sky dome ────────────────────────────────────────────────────────────────
const DOME_RADIUS  = 28000;
const DOME_W_SEGS  = 32;
const DOME_H_SEGS  = 16;
const DOME_HORIZON = new THREE.Color('#cfe9ff');
const DOME_ZENITH  = new THREE.Color('#5ab8e8');

// ─── Water / sand ribbon sampling ────────────────────────────────────────────
const RIBBON_SAMPLES = 64;  // number of cross-sections along the spline
const WATER_Y        = 40;  // halfway up V2_BANK_HEIGHT=80
const SAND_Y         = 0.5; // just above river bed, below water
const SAND_EXTRA_HW  = 120; // sand ribbon extends this many wu beyond water edge

// ─── Scenery spawning ────────────────────────────────────────────────────────
const SCENERY_PROP_PATHS = [
  '/models/reef-race/scenery/prop-tree-pine.glb',
  '/models/reef-race/scenery/prop-tree-leafy.glb',
  '/models/reef-race/scenery/prop-rock-1.glb',
  '/models/reef-race/scenery/prop-rock-2.glb',
  '/models/reef-race/scenery/prop-fence.glb',
  '/models/reef-race/scenery/prop-grass-tuft.glb',
] as const;

for (const path of SCENERY_PROP_PATHS) {
  try { useGLTF.preload(path); } catch { /* not yet available */ }
}

interface SpawnerDef {
  path: string;
  tValues: number[];
  side: number;   // +1 = left, -1 = right
  xJitter: number; // wu BEYOND bank edge (positive = further out onto grass)
  scaleMin: number;
  scaleMax: number;
  seed: number;
}

function seededRand(seed: number) {
  let s = (seed * 1664525 + 1013904223) | 0;
  return {
    next(): number {
      s = ((s ^ (s << 13)) ^ (s >>> 17) ^ (s << 5)) | 0;
      return ((s >>> 0) / 0xffffffff);
    },
  };
}

/** Sample spline bank edge + xJitter for a prop spawn position.
 *  Props are placed at: centerline ± normal*(halfWidth + xJitter)
 *  so they are guaranteed to be BEYOND the water edge and onto the grass. */
function spawnPos(t: number, side: number, xJitter: number): THREE.Vector3 {
  const c  = clientSpline.centerlineAt(t);
  const n  = clientSpline.normalAt(t);
  const hw = clientSpline.widthAt(t);
  const dist = hw + xJitter;  // total lateral offset from centerline
  return new THREE.Vector3(
    c.x + n.x * dist * side,
    0,
    c.z + n.z * dist * side,
  );
}

// Spawner defs with xJitter large enough to clear the water + sand ribbon.
// Water extends to halfWidth (200-500 wu). Sand extends halfWidth+120 wu.
// So props MUST have xJitter > 120 wu to clear the sand and land on grass.
//
// xJitter values below are BEYOND the water bank edge (not from centerline).
// At halfWidth=500 (widest), fence at xJitter=80 → 580 wu from center: still
// at the sand edge. At narrowest (halfWidth=200), fence is at 280 wu — inside
// the sand. That's acceptable for fences; they're meant to sit at the bank edge.
const SPAWNER_DEFS: SpawnerDef[] = [
  // Pine trees — left side, well onto grass
  {
    path: '/models/reef-race/scenery/prop-tree-pine.glb',
    tValues: Array.from({ length: 16 }, (_, i) => (i + 0.3) / 16),
    side: 1, xJitter: 350, scaleMin: 2.5, scaleMax: 3.5, seed: 1,
  },
  // Leafy trees — right side, well onto grass
  {
    path: '/models/reef-race/scenery/prop-tree-leafy.glb',
    tValues: Array.from({ length: 14 }, (_, i) => (i + 0.1) / 14),
    side: -1, xJitter: 450, scaleMin: 2.2, scaleMax: 3.2, seed: 2,
  },
  // Rocks — closer to bank edge, both sides
  {
    path: '/models/reef-race/scenery/prop-rock-1.glb',
    tValues: Array.from({ length: 10 }, (_, i) => (i + 0.05) / 10),
    side: 1, xJitter: 200, scaleMin: 0.7, scaleMax: 1.3, seed: 3,
  },
  {
    path: '/models/reef-race/scenery/prop-rock-2.glb',
    tValues: Array.from({ length: 10 }, (_, i) => (i + 0.55) / 10),
    side: -1, xJitter: 250, scaleMin: 0.8, scaleMax: 1.4, seed: 4,
  },
  // Fences — right at the sand/grass boundary
  {
    path: '/models/reef-race/scenery/prop-fence.glb',
    tValues: Array.from({ length: 24 }, (_, i) => i / 24),
    side: 1, xJitter: 80, scaleMin: 1.0, scaleMax: 1.0, seed: 5,
  },
  // Grass tufts — clustered near bank, on grass
  {
    path: '/models/reef-race/scenery/prop-grass-tuft.glb',
    tValues: Array.from({ length: 30 }, (_, i) => (i + 0.15) / 30),
    side: -1, xJitter: 150, scaleMin: 0.8, scaleMax: 1.5, seed: 6,
  },
];

// ─── Water ribbon geometry (module-scope, baked once) ────────────────────────
// Triangle strip swept along clientSpline centerline.
// Each cross-section: 2 verts at center ± normal*halfWidth.
// N=64 cross-sections → 63 quads × 2 tris = 126 tris total.
function buildWaterRibbonGeo(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals:   number[] = [];
  const uvs:       number[] = [];
  const indices:   number[] = [];

  for (let i = 0; i <= RIBBON_SAMPLES; i++) {
    const t  = i / RIBBON_SAMPLES;
    const c  = clientSpline.centerlineAt(t);
    const n  = clientSpline.normalAt(t);
    const hw = clientSpline.widthAt(t);

    // Left edge
    positions.push(c.x + n.x * hw, WATER_Y, c.z + n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(0, t);

    // Right edge
    positions.push(c.x - n.x * hw, WATER_Y, c.z - n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(1, t);

    if (i < RIBBON_SAMPLES) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,       2));
  geo.setIndex(indices);
  return geo;
}

// ─── Sand ribbon geometry (module-scope, baked once) ─────────────────────────
// Same approach as water but wider by SAND_EXTRA_HW and at y=SAND_Y.
// Sits ON the ground plane, BELOW the water surface — acts as beach strip.
function buildSandRibbonGeo(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals:   number[] = [];
  const uvs:       number[] = [];
  const indices:   number[] = [];

  for (let i = 0; i <= RIBBON_SAMPLES; i++) {
    const t  = i / RIBBON_SAMPLES;
    const c  = clientSpline.centerlineAt(t);
    const n  = clientSpline.normalAt(t);
    const hw = clientSpline.widthAt(t) + SAND_EXTRA_HW;

    // Left edge
    positions.push(c.x + n.x * hw, SAND_Y, c.z + n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(0, t);

    // Right edge
    positions.push(c.x - n.x * hw, SAND_Y, c.z - n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(1, t);

    if (i < RIBBON_SAMPLES) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,       2));
  geo.setIndex(indices);
  return geo;
}

// ─── Sky dome geometry ────────────────────────────────────────────────────────
function makeDomeGeo(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(DOME_RADIUS, DOME_W_SEGS, DOME_H_SEGS);
  const positions = geo.attributes.position!;
  const count = positions.count;
  const colorsArr = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const y = positions.getY(i);
    const tc = Math.max(0, Math.min(1, y / DOME_RADIUS * 0.5 + 0.5));
    const r = DOME_HORIZON.r + (DOME_ZENITH.r - DOME_HORIZON.r) * tc;
    const g = DOME_HORIZON.g + (DOME_ZENITH.g - DOME_HORIZON.g) * tc;
    const b = DOME_HORIZON.b + (DOME_ZENITH.b - DOME_HORIZON.b) * tc;
    colorsArr[i * 3 + 0] = r;
    colorsArr[i * 3 + 1] = g;
    colorsArr[i * 3 + 2] = b;
  }

  geo.setAttribute('color', new THREE.Float32BufferAttribute(colorsArr, 3));
  return geo;
}

// ─── Module-scope geometries (baked at module load, shared forever) ───────────
const _groundGeo  = new THREE.PlaneGeometry(GROUND_W, GROUND_L, 1, 1);
const _waterGeo   = buildWaterRibbonGeo();
const _sandGeo    = buildSandRibbonGeo();
const _domeGeo    = makeDomeGeo();

// ─── Module-scope materials (page-lifetime, never disposed) ──────────────────

/** Large green grass plane — MeshLambertMaterial, flat shading. */
const _groundMat = new THREE.MeshLambertMaterial({
  color: new THREE.Color('#7cb342'),
  flatShading: true,
  fog: true,
});

/** Sandy bank ribbon — cream/peach color at water's edge. */
const _sandMat = new THREE.MeshLambertMaterial({
  color: new THREE.Color('#e8d5a8'),
  flatShading: true,
  fog: true,
  side: THREE.DoubleSide,
});

/**
 * Water ribbon — OPAQUE bright cyan, flatShading for low-poly look.
 * No transparency: we want solid cyan, not a pool you can see through.
 * DoubleSide so both the top surface and underside render during orbit.
 */
const _waterMat = new THREE.MeshLambertMaterial({
  color: new THREE.Color('#4ec5e8'),
  flatShading: true,
  fog: true,
  side: THREE.DoubleSide,
});

/** Sky dome material — vertex colors, BackSide, no fog. */
const _domeMat = new THREE.MeshBasicMaterial({
  vertexColors: true,
  side: THREE.BackSide,
  fog: false,
  depthWrite: false,
});

// ─── Ground plane component ───────────────────────────────────────────────────

function GroundPlane() {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
  }, []);

  return (
    <mesh
      ref={meshRef}
      geometry={_groundGeo}
      material={_groundMat}
      // PlaneGeometry is XY; rotate to XZ and position centered on track
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, GROUND_Y, TRACK_CENTER_Z]}
      frustumCulled={false}
      matrixAutoUpdate={false}
      receiveShadow
      renderOrder={0}
    />
  );
}

// ─── Sand ribbon component ────────────────────────────────────────────────────

function SandRibbon() {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
  }, []);

  return (
    <mesh
      ref={meshRef}
      geometry={_sandGeo}
      material={_sandMat}
      frustumCulled={false}
      matrixAutoUpdate={false}
      receiveShadow
      renderOrder={1}
    />
  );
}

// ─── Water ribbon component ───────────────────────────────────────────────────

function WaterRibbon() {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
  }, []);

  return (
    <mesh
      ref={meshRef}
      geometry={_waterGeo}
      material={_waterMat}
      frustumCulled={false}
      matrixAutoUpdate={false}
      renderOrder={2}
    />
  );
}

// ─── Sky dome component ───────────────────────────────────────────────────────

function SkyDome() {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    m.position.set(0, 0, TRACK_CENTER_Z);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
  }, []);

  return (
    <mesh
      ref={meshRef}
      geometry={_domeGeo}
      material={_domeMat}
      frustumCulled={false}
      matrixAutoUpdate={false}
      renderOrder={-1}
    />
  );
}

// ─── Individual scenery prop component ───────────────────────────────────────

interface PropInstancesProps {
  def: SpawnerDef;
}

function PropInstances({ def }: PropInstancesProps) {
  const { scene: srcScene } = useGLTF(def.path);
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    const gr = groupRef.current;
    if (!gr || !srcScene) return;

    const rng = seededRand(def.seed);
    def.tValues.forEach((t) => {
      // Add random lateral jitter of ±30wu on top of the base xJitter
      const jitter = def.xJitter + rng.next() * 60 - 30;
      const pos    = spawnPos(t, def.side, jitter);
      const yRot   = rng.next() * Math.PI * 2;
      const scale  = def.scaleMin + rng.next() * (def.scaleMax - def.scaleMin);

      const clone = srcScene.clone(true);
      clone.traverse(o => { o.frustumCulled = false; });
      clone.position.copy(pos);
      clone.rotation.y = yRot;
      clone.scale.setScalar(scale);
      clone.matrixAutoUpdate = false;
      clone.updateMatrix();
      gr.add(clone);
    });

    gr.matrixAutoUpdate = false;
    gr.updateMatrix();

    return () => {
      while (gr.children.length > 0) gr.remove(gr.children[0]);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcScene]);

  return <group ref={groupRef} />;
}

// ─── Scenery spawner ──────────────────────────────────────────────────────────

function ScenerySpawner() {
  return (
    <>
      {SPAWNER_DEFS.map((def) => (
        <Suspense key={def.path} fallback={null}>
          <PropInstances def={def} />
        </Suspense>
      ))}
    </>
  );
}

// ─── Public composite component ───────────────────────────────────────────────

/**
 * RiverScene — drop-in atmosphere block for Reef Race v2.
 *
 * Wire into any R3F Canvas that uses the v2 spline track:
 *   - /preview/reef-race-v2: placed inside <SceneContents>
 *   - ReefRaceScene.tsx: placed inside production <SceneContents>
 *
 * Does NOT include lighting, fog, or track geometry — those are managed by
 * the parent scene. The parent SHOULD:
 *   - Use fog color '#a8d8ff' (sky-blue) not the old deep-navy '#061525'
 *   - Use <color attach="background" args={['#a8d8ff']} /> to match horizon
 *   - HEMI_GROUND_COLOR: '#7cb342' grass green (matches ground plane)
 *
 * Renders (render order):
 *   -1: Sky dome (sunny blue gradient, BackSide sphere)
 *    0: Green ground plane (large flat XZ grass plane)
 *    1: Sandy bank ribbons (cream, spline-following, at water edge)
 *    2: Cyan water ribbon (opaque, spline-following, above sand)
 *    ?: Scenery props along banks (on the grass, not in the water)
 *
 * Bank wall geometry from SplineTrack (buildSplineBankGeos) is intentionally
 * hidden by the parent page — set visible=false or recolor to grass green.
 * See page.tsx: _bankMat color is '#7cb342' grass green to blend with ground.
 */
export function RiverScene() {
  return (
    <>
      {/* -1: Sky dome — renders behind everything */}
      <SkyDome />

      {/* 0: Green grass ground plane — large flat base */}
      <GroundPlane />

      {/* 1: Sandy bank ribbons at water's edge */}
      <SandRibbon />

      {/* 2: Opaque cyan water ribbon following spline */}
      <WaterRibbon />

      {/* Scenery props on the grass */}
      <ScenerySpawner />
    </>
  );
}
