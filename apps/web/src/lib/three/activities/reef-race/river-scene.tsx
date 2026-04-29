'use client';

/**
 * river-scene.tsx — Low-poly stylized river atmosphere for Reef Race v2.
 *
 * Visual target: Kagelok "The River" Sketchfab aesthetic.
 *   Bright sunny sky, flat-shaded cyan water, sandy banks, green hillsides.
 *   Low-poly trees / rocks / fences scattered along the banks.
 *
 * Contains:
 *   A. Animated water surface  (MeshLambertMaterial flatShading, vertex Y wave)
 *   B. Sky dome                (SphereGeometry + MeshBasicMaterial vertexColors)
 *   C. ScenerySpawner          (low-poly prop GLBs along spline — tries to load,
 *                                renders nothing if GLBs are missing during dev)
 *
 * Iris Xe invariants:
 *   - NO ShaderMaterial anywhere
 *   - NO InstancedMesh + ShaderMaterial combo
 *   - NO drei <Text> or <Billboard>
 *   - import from 'three' only (not 'three/webgpu')
 *   - All static geo/mat at module scope — zero per-frame GC
 *   - frustumCulled=false on all atmosphere meshes
 *   - matrixAutoUpdate=false on static meshes; water vertex animation mutates
 *     BufferAttribute directly (needsUpdate=true only on position attr)
 *
 * Draw call budget added by this file:
 *   1 water plane + 1 dome + up to ~6 scenery GLB types (deduplicated) = ≤8 draw calls
 *   Scenery GLBs share one material each via InstancedMesh (NOT ShaderMaterial) → safe.
 *   CORRECTION: scenery uses plain Mesh clones (not InstancedMesh + ShaderMaterial) to
 *   stay within Iris Xe constraints.  Estimated: ≤12 new draw calls total.
 *
 * Tri count added:
 *   Water: 64×32×2 ≈ 4096 tris | Dome: ~1024 tris | Scenery: ~1000 tris est.
 *   Total new: ≈6100 tris — well within the ≤80k scene budget.
 *
 * Water Y placement:
 *   V2_BANK_HEIGHT = 80 wu. River bed at y=0. Water at y=40 (halfway up bank walls)
 *   so surfboards at y≈0 appear to ride just below/at the surface.
 *
 * Fog tuning:
 *   FOG_COLOR changed to sky-blue '#a8d8ff' (update in preview page + ReefRaceScene).
 */

import { Suspense, useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clientSpline } from './reef-race-spline-instance';

// ─── Track layout constants ───────────────────────────────────────────────────
// Track runs z=[0,18000], x≈[-700,+700], river bed at y=0, bank walls to y=80.
const TRACK_HALF_X   = 1200;  // extra margin beyond actual ±700 bank edge
const TRACK_LEN_Z    = 20000; // track center z=[0,18000], slight overrun
const TRACK_START_Z  = -500;  // water starts 500wu before z=0
const TRACK_CENTER_Z = TRACK_START_Z + TRACK_LEN_Z / 2; // center for dome

// ─── Water surface ────────────────────────────────────────────────────────────
const WATER_Y      = 40;           // halfway up V2_BANK_HEIGHT=80
const WATER_W      = TRACK_HALF_X * 2;  // 2400 wu
const WATER_L      = TRACK_LEN_Z;       // 20000 wu
const WATER_SEG_X  = 64;          // enough for visible wave detail
const WATER_SEG_Z  = 128;         // longer axis gets more segments
const WAVE_AMP     = 4;           // ±4 wu max displacement
const WAVE_FREQ_X  = 0.0045;      // spatial frequency across width
const WAVE_FREQ_Z  = 0.0025;      // spatial frequency along length
const WAVE_SPEED   = 0.8;         // time multiplier

// ─── Sky dome ────────────────────────────────────────────────────────────────
const DOME_RADIUS  = 28000;       // safely covers camera.far=35000 frustum
const DOME_W_SEGS  = 32;
const DOME_H_SEGS  = 16;
// Bright sunny sky: lighter at horizon, deeper blue at zenith
const DOME_HORIZON = new THREE.Color('#cfe9ff'); // horizon haze
const DOME_ZENITH  = new THREE.Color('#5ab8e8'); // deep sky blue

// ─── Scenery spawning ────────────────────────────────────────────────────────
// Props are scattered along the spline at regular t-intervals, alternating sides.
// If a GLB is missing during dev transition, the spawner renders nothing for it
// (useGLTF will throw, Suspense will catch via fallback={null}).
const SCENERY_PROP_PATHS = [
  '/models/reef-race/scenery/prop-tree-pine.glb',
  '/models/reef-race/scenery/prop-tree-leafy.glb',
  '/models/reef-race/scenery/prop-rock-1.glb',
  '/models/reef-race/scenery/prop-rock-2.glb',
  '/models/reef-race/scenery/prop-fence.glb',
  '/models/reef-race/scenery/prop-grass-tuft.glb',
] as const;

/** Preload — wrapped in try/catch so missing files don't break build. */
for (const path of SCENERY_PROP_PATHS) {
  try { useGLTF.preload(path); } catch { /* not yet available */ }
}

// Each "spawner" definition: which GLB, how many, which t-values, side, scale range
interface SpawnerDef {
  path: string;
  tValues: number[];  // t in [0,1] along spline
  side: number;       // +1 = left of direction, -1 = right
  xJitter: number;    // ±wu offset beyond bank edge
  scaleMin: number;
  scaleMax: number;
  seed: number;
}

// Deterministic seeded rand
function seededRand(seed: number) {
  let s = (seed * 1664525 + 1013904223) | 0;
  return {
    next(): number {
      s = ((s ^ (s << 13)) ^ (s >>> 17) ^ (s << 5)) | 0;
      return ((s >>> 0) / 0xffffffff);
    },
  };
}

/** Sample spline bank edge + offset for a prop spawn position. */
function spawnPos(t: number, side: number, xJitter: number): THREE.Vector3 {
  const c   = clientSpline.centerlineAt(t);
  const n   = clientSpline.normalAt(t);
  const hw  = clientSpline.widthAt(t);
  // Bank edge = center ± normal * halfWidth; further out by side * xJitter
  const ex  = c.x + n.x * hw * side + n.x * xJitter * side;
  const ez  = c.z + n.z * hw * side + n.z * xJitter * side;
  return new THREE.Vector3(ex, 0, ez);
}

// Scale values — 2026-04-29 fix: blender07 authored each prop in WORLD UNITS
// already (e.g. pine bbox = ±68 wu, ±35 wu, [-233, -22] wu — i.e. ~140×70×211
// wu authored). Original spawner multiplied by 60–120 → trees rendered as
// ~14 000-wu green mountains filling the entire viewport. Targets:
//   Tree:  ~200 wu visible height → scale ≈ 3 (authored 70 wu tall)
//   Rock:  ~50  wu visible across → scale ≈ 1
//   Fence: ~150 wu visible wide   → scale ≈ 1
//   Grass: ~30  wu visible across → scale ≈ 1
// xJitter values are ALREADY in world units (added directly to spline-edge
// position — see spawnPos), so they didn't need rescaling. Same for tValues.
const SPAWNER_DEFS: SpawnerDef[] = [
  // Pine trees left side — 16 along track
  {
    path: '/models/reef-race/scenery/prop-tree-pine.glb',
    tValues: Array.from({ length: 16 }, (_, i) => (i + 0.3) / 16),
    side: 1, xJitter: 80, scaleMin: 2.5, scaleMax: 3.5, seed: 1,
  },
  // Leafy trees right side — 14 along track
  {
    path: '/models/reef-race/scenery/prop-tree-leafy.glb',
    tValues: Array.from({ length: 14 }, (_, i) => (i + 0.1) / 14),
    side: -1, xJitter: 100, scaleMin: 2.2, scaleMax: 3.2, seed: 2,
  },
  // Rocks scattered both sides — 20 total (10 each)
  {
    path: '/models/reef-race/scenery/prop-rock-1.glb',
    tValues: Array.from({ length: 10 }, (_, i) => (i + 0.05) / 10),
    side: 1, xJitter: 30, scaleMin: 0.7, scaleMax: 1.3, seed: 3,
  },
  {
    path: '/models/reef-race/scenery/prop-rock-2.glb',
    tValues: Array.from({ length: 10 }, (_, i) => (i + 0.55) / 10),
    side: -1, xJitter: 40, scaleMin: 0.8, scaleMax: 1.4, seed: 4,
  },
  // Fences along left bank edge — 24 segments
  {
    path: '/models/reef-race/scenery/prop-fence.glb',
    tValues: Array.from({ length: 24 }, (_, i) => i / 24),
    side: 1, xJitter: 10, scaleMin: 1.0, scaleMax: 1.0, seed: 5,
  },
  // Grass tufts — many, both sides
  {
    path: '/models/reef-race/scenery/prop-grass-tuft.glb',
    tValues: Array.from({ length: 30 }, (_, i) => (i + 0.15) / 30),
    side: -1, xJitter: 20, scaleMin: 0.8, scaleMax: 1.5, seed: 6,
  },
];

// ─── Module-scope water geometry (cloned per-mount so vertex mutation is safe) ──
// We generate a base grid once and clone it inside WaterSurface.
const _waterGeoTemplate = new THREE.PlaneGeometry(WATER_W, WATER_L, WATER_SEG_X, WATER_SEG_Z);

// ─── Dome geometry with vertex colors ────────────────────────────────────────
function makeDomeGeo(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(DOME_RADIUS, DOME_W_SEGS, DOME_H_SEGS);
  const positions = geo.attributes.position!;
  const count = positions.count;
  const colorsArr = new Float32Array(count * 3);

  // Map Y position → gradient t in [0,1]: bottom=0, top=1
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

const _domeGeo = makeDomeGeo();

// ─── Module-scope materials ───────────────────────────────────────────────────

/** Sky dome material — vertex colors, BackSide, no fog (it IS the sky). */
const _domeMat = new THREE.MeshBasicMaterial({
  vertexColors: true,
  side: THREE.BackSide,
  fog: false,
  depthWrite: false,
});

/**
 * Water surface — flat-shaded MeshLambertMaterial, cyan, semi-transparent.
 * flatShading=true gives the low-poly faceted look matching the reference.
 * fog=true so distant water blends into the horizon haze.
 */
const _waterMat = new THREE.MeshLambertMaterial({
  color: new THREE.Color('#4ec5e8'),
  transparent: true,
  opacity: 0.88,
  side: THREE.DoubleSide,
  depthWrite: false,
  fog: true,
  flatShading: true,
});

// ─── Water surface component ──────────────────────────────────────────────────
// Clones the template geometry so vertex mutation doesn't corrupt the template.

function WaterSurface() {
  const meshRef = useRef<THREE.Mesh>(null);

  // Clone template geometry once per mount so vertex mutation is per-instance
  const waterGeo = useMemo(() => {
    const geo = _waterGeoTemplate.clone();
    // PlaneGeometry is XY; we need XZ. rotateX is a geometry-level transform
    // applied to positions. We rotate in JSX, so leave geometry as XY and
    // let the mesh rotation=[-PI/2,0,0] handle it — same pattern as caustic.
    return geo;
  }, []);

  // Cache original Y positions for wave animation
  const origY = useMemo(() => {
    const pos = waterGeo.attributes.position!;
    // PlaneGeometry XY: store original Z values (which become Y after rotation)
    // Actually PlaneGeometry stores verts as (x, y, z=0); after rotation.x=-PI/2
    // the mesh Y is geometry Z. We animate geometry's Z attribute.
    const arr = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      arr[i] = 0; // base is flat
    }
    return arr;
  }, [waterGeo]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // No matrixAutoUpdate freeze here — mesh position set via JSX props
    // R3F applies them on initial commit before this useEffect runs, so
    // position is already in the matrix. We call updateMatrix to freeze it.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return () => {
      waterGeo.dispose();
    };
  }, [waterGeo]);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Accumulate time from delta (avoids Date.now() stale pattern)
    const elapsed = (mesh.userData.elapsed ?? 0) + delta;
    mesh.userData.elapsed = elapsed;
    const t = elapsed * WAVE_SPEED;

    const pos = waterGeo.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;

    // PlaneGeometry vertices layout: (x, y, 0) in local space
    // After mesh rotation=[-PI/2,0,0], local Y→world Z, local Z→world Y
    // So we animate local Z to get world Y displacement.
    for (let i = 0; i < pos.count; i++) {
      const x = arr[i * 3 + 0];  // local X (→ world X)
      const y = arr[i * 3 + 1];  // local Y (→ world Z)
      // Two interfering sine waves for organic-looking surface
      const w = Math.sin(x * WAVE_FREQ_X + t) * Math.sin(y * WAVE_FREQ_Z + t * 1.3);
      arr[i * 3 + 2] = w * WAVE_AMP;
    }
    pos.needsUpdate = true;
    // Recompute vertex normals so flat shading re-calculates face normals
    waterGeo.computeVertexNormals();
  });

  return (
    <mesh
      ref={meshRef}
      geometry={waterGeo}
      material={_waterMat}
      position={[0, WATER_Y, TRACK_CENTER_Z]}
      rotation={[-Math.PI / 2, 0, 0]}
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
    // Center dome over track midpoint
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
// Renders one prop GLB at each spawn point from a SpawnerDef.
// Wrapped in Suspense so missing GLBs render null without crashing the scene.

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
      const pos = spawnPos(t, def.side, def.xJitter + rng.next() * 40 - 20);
      const yRot = rng.next() * Math.PI * 2;
      const scale = def.scaleMin + rng.next() * (def.scaleMax - def.scaleMin);

      const clone = srcScene.clone(true);
      clone.traverse(o => { o.frustumCulled = false; });
      clone.position.copy(pos);
      clone.rotation.y = yRot;
      clone.scale.setScalar(scale);
      clone.matrixAutoUpdate = false;
      clone.updateMatrix();
      gr.add(clone);
    });

    // Freeze group matrix too
    gr.matrixAutoUpdate = false;
    gr.updateMatrix();

    return () => {
      // Clean up clones on unmount
      while (gr.children.length > 0) {
        gr.remove(gr.children[0]);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcScene]);

  return <group ref={groupRef} />;
}

// ─── Scenery spawner ──────────────────────────────────────────────────────────
// Each def is wrapped in its own Suspense(fallback=null) so a missing GLB
// file just renders nothing for that prop type without breaking the scene.

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
 *
 * Renders:
 *   A. Animated flat-shaded water surface at y=40
 *   B. Sky dome (bright sunny blue gradient, BackSide sphere)
 *   C. Scenery props along banks (low-poly trees, rocks, fences, grass)
 */
export function RiverScene() {
  return (
    <>
      {/* B. Sky dome — sunny blue gradient, renders first */}
      <SkyDome />

      {/* A. Water surface — flat-shaded cyan, animated vertex wave */}
      <WaterSurface />

      {/* C. Low-poly scenery along banks */}
      <ScenerySpawner />
    </>
  );
}
