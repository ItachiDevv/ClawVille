'use client';

/**
 * LandingScene.tsx — Cinematic establishing shot over the ClawVille town ring.
 *
 * Visual direction (frontend-design pass 2026-06-01): a deep, luminous,
 * bioluminescent underwater vista that MATCHES the real in-game world palette
 * — deep-blue fog (#0e3458), hemisphere sky #66bbdd / ground #223344, warm
 * key light — rather than the washed teal/tan it had before.
 *
 * Camera: a near-horizontal horizon shot (elevation ≈38° from horizon,
 * arm=295wu, height=380wu) that drifts gently (±0.22 rad sway + slow bob).
 * NOT a full 360° orbit — a gentle drift keeps a cinematic, stable composition.
 * lookAt Y=+220 (R6) aims the camera near-horizontal toward open water so the
 * sandy floor reads as a FOGGY HORIZON LINE at ~38–42% up from the bottom of
 * frame; the building ring sits in the LOWER ~40% of frame and the upper ~60%
 * is dark open water where the hero title/CTAs float with no buildings behind
 * them. (R5 used lookAt Y=−350 which aimed steeply DOWN at the floor, filling
 * ~70% of the frame with bright sand — the opposite of intent.)
 * Belt-and-suspenders: seabed is 6000wu wide so edges are always fully
 * fogged out (>fog.far from camera) — no hard edge can ever appear.
 *
 * Iris Xe GPU constraints:
 *   1. MAX 3 lights (hemisphere + 1 directional + 1 point)
 *   2. NO drei <Text> / <Billboard>
 *   3. NO InstancedMesh + ShaderMaterial
 *   4. NO new THREE.Vector3/Color/Matrix inside useFrame — module-scope scratch
 *   5. Dispose cloned building scenes + geo/mats on unmount
 *   6. Module-scope singletons (seabed geo/mat, sky texture) NEVER disposed
 *   7. frustumCulled handling on static meshes
 *   8. DPR [1, 1.25]
 *   9. useVisibleFrameloop → frameloop prop on <Canvas>
 *  10. import * as THREE from 'three' only
 *  11. matrixAutoUpdate=false on all static meshes after first transform
 *  12. >50 FPS on integrated GPU
 */

import { useRef, useMemo, useState, useEffect, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useVisibleFrameloop } from '@/lib/use-visible-frameloop';
import { extendLoaderWithMeshopt } from '@/lib/three/meshopt-loader-setup';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';
import { preloadKTX2Bytes, useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';

// ─── Ring layout constants ────────────────────────────────────────────────────

/** Target max dimension for each building in the landing scene (world units).
 *  Trimmed to 100 (R3) so buildings frame the centered text rather than
 *  crowding it. Was 118 (R2) which made the arcade dome cluster right behind
 *  the logo. Footprint cap = 100×1.5 = 150wu; slot arc-spacing =
 *  2π×195/10 = 122wu, so most buildings stay within one slot. */
const HERO_TARGET_MAX_DIM = 100;

/** Ring radius for the overview shot (world units). Tighter = town reads as a
 *  compact, CENTERED cluster behind the logo rather than spread to the edges. */
const HERO_RING_RADIUS = 195;

/** Number of building slots. */
const HERO_SLOT_COUNT = 10;

/** Camera height + orbit-arm length.
 *  CAM_ARM=295, CAM_Y=380 → elevation ≈ 52° from horizon (atan2(380,295)).
 *  R6: lowered CAM_Y 454→380 to flatten the shot toward a horizon establishing
 *  view; combined with CAM_LOOK_Y=+220 this gives ~18° below horizontal pitch
 *  (atan2(380-220, 295) ≈ 28° — foggy sandy horizon at ~38–42% frame height).
 *  Camera distance from origin: sqrt(380²+295²) ≈ 479wu. */
const CAM_Y   = 380;
const CAM_ARM = 295;

/** LookAt target Y.
 *  R6: changed from −350 → +220 (POSITIVE). Looking at (0,+220,0) from camera
 *  at height 380 and arm 295 gives pitch ≈ 28° BELOW horizontal — the sandy
 *  floor reads as a foggy horizon line at ~38–42% up from frame bottom, the
 *  building ring sits in the lower ~40%, and the upper ~58% is open dark water
 *  for the hero title + CTAs with no buildings behind them.
 *  (R5 used −350 which looked steeply DOWN at the floor, pitch≈56° below
 *  horizontal — the bright sandy floor filled ~70% of the frame.) */
const CAM_LOOK_Y = 220;

/** Base azimuth of the fixed 3/4 vantage (radians). The camera only sways a
 *  small amount around this — it never does a full revolution.
 *  Shifted slightly from -0.60π → -0.55π to improve left/right balance. */
const CAM_BASE_AZIMUTH = -Math.PI * 0.55;

// ─── Module-scope scratch objects (rule #4 — zero per-frame allocation) ──────

const _scratchVec3A = new THREE.Vector3();
const _scratchVec3B = new THREE.Vector3();

// ─── Module-scope colors — MATCH the in-game world palette ───────────────────
// (3dStructure.md §4: hemisphere sky 0x66bbdd / ground 0x223344, directional
//  warm 0xffeedd, fog 0x0e3458). This is what makes the hero read as the
//  actual game world, not a generic teal pool.

const _hemiSkyColor    = new THREE.Color('#66bbdd');
const _hemiGroundColor = new THREE.Color('#223344');
const _sunColor        = new THREE.Color('#ffeedd');
const _bioColor        = new THREE.Color('#3fe0ff');
const _fogColor        = new THREE.Color(0x0a2236);

// ─── Building definitions (subset of arena-buildings BUILDING_MODELS) ────────

interface LandingBuildingDef {
  model: string;
  rotY: number;
}

const LANDING_BUILDINGS: LandingBuildingDef[] = [
  { model: '/models/pineapple-house-opt1-ktx.glb?v=2',      rotY:  0.000 },  // visual-creation
  { model: '/models/chum-bucket-v2-opt1-ktx.glb?v=2',       rotY: -0.522 },  // code-development
  { model: '/models/krusty-krab-v2-opt1-ktx.glb?v=2',       rotY: -1.049 },  // mcp-tool-use
  { model: '/models/salty-spitoon-opt1-ktx.glb?v=2',        rotY: -2.093 },  // api-integrations
  { model: '/models/boating-school-opt1-ktx.glb?v=2',       rotY: -2.620 },  // app-publishing
  { model: '/models/patty-building-opt1-ktx.glb?v=2',       rotY:  3.142 },  // cron-automation
  { model: '/models/building-lighthouse-opt1-ktx.glb?v=2',  rotY:  2.620 },  // deployment-ops
  { model: '/models/arcade/claw-arcade-exterior-opt1-ktx.glb?v=2', rotY: 2.093 }, // claw-arcade
  { model: '/models/patricks-rock-v2-opt1-ktx.glb?v=3',    rotY:  1.049 },  // agent-security
  { model: '/models/squidward-house-opt1-ktx.glb?v=3',      rotY:  0.522 },  // memory-rag
];

// Preload all 10 buildings at module scope.
LANDING_BUILDINGS.forEach(({ model }) => {
  if (model.includes('-ktx.glb')) preloadKTX2Bytes(model);
  else useGLTF.preload(model, undefined, undefined, extendLoaderWithMeshopt);
});

// ─── Decorative mesh names to strip before bbox measurement ──────────────────

const _DECORATIVE_PARENT_NAMES = new Set(['Flowers', 'Path', 'Skybox', 'Road', 'Sand']);
const _DECORATIVE_NAME_PREFIXES = ['Skybox_'] as const;
const _BACKDROP_KILL_NAMES = new Set<string>(['Object_1']);

const _heroBbox    = new THREE.Box3();
const _heroMeshBox = new THREE.Box3();
const _heroSize    = new THREE.Vector3();
const _heroCenter  = new THREE.Vector3();

function stripDecorativeMeshes(scene: THREE.Object3D): void {
  const toRemove: THREE.Object3D[] = [];
  scene.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    if (child.name) {
      for (const prefix of _DECORATIVE_NAME_PREFIXES) {
        if (child.name.startsWith(prefix)) { toRemove.push(child); return; }
      }
      if (_BACKDROP_KILL_NAMES.has(child.name)) { toRemove.push(child); return; }
    }
    let p: THREE.Object3D | null = child.parent;
    while (p) {
      if (p.name && _DECORATIVE_PARENT_NAMES.has(p.name)) {
        toRemove.push(child);
        break;
      }
      p = p.parent;
    }
  });
  toRemove.forEach((obj) => obj.removeFromParent());
}

function stripGroundPlanes(scene: THREE.Object3D): void {
  scene.updateMatrixWorld(true);
  _heroBbox.makeEmpty();
  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      if (!bb) return;
      _heroMeshBox.copy(bb).applyMatrix4(mesh.matrixWorld);
      _heroBbox.union(_heroMeshBox);
    }
  });
  if (_heroBbox.isEmpty()) _heroBbox.setFromObject(scene);
  const fullMinY  = _heroBbox.min.y;
  const fullHeight = _heroBbox.max.y - _heroBbox.min.y;
  if (fullHeight === 0) return;

  const toRemove: THREE.Object3D[] = [];
  scene.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb) return;
    const sy = bb.max.y - bb.min.y;
    const sx = bb.max.x - bb.min.x;
    const sz = bb.max.z - bb.min.z;
    const maxXZ = Math.max(sx, sz);
    const isFlat     = maxXZ > 2 && sy / maxXZ < 0.005;
    const isAtBottom = bb.max.y < fullMinY + fullHeight * 0.05;
    if (isFlat && isAtBottom) toRemove.push(mesh);
  });
  toRemove.forEach((obj) => obj.removeFromParent());
}

function computeHeroScale(scene: THREE.Object3D, targetMaxDim: number): {
  scale: number;
  pivotOffsetX: number;
  pivotOffsetY: number;
  pivotOffsetZ: number;
} {
  scene.updateMatrixWorld(true);
  _heroBbox.makeEmpty();
  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      _heroMeshBox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _heroBbox.union(_heroMeshBox);
    }
  });
  if (_heroBbox.isEmpty()) _heroBbox.setFromObject(scene);

  _heroBbox.getSize(_heroSize);
  const maxDim = Math.max(_heroSize.x, _heroSize.y, _heroSize.z);
  let scale = maxDim > 0.001 ? targetMaxDim / maxDim : 1;

  const scaledMaxXZ = Math.max(_heroSize.x, _heroSize.z) * scale;
  const maxFootprint = targetMaxDim * 1.5;
  if (scaledMaxXZ > maxFootprint) {
    scale *= maxFootprint / scaledMaxXZ;
  }

  _heroBbox.getCenter(_heroCenter);
  return {
    scale,
    pivotOffsetX: _heroCenter.x * scale,
    pivotOffsetY: _heroBbox.min.y * scale,
    pivotOffsetZ: _heroCenter.z * scale,
  };
}

// ─── Gradient sky dome — deep-blue underwater "surface above" ────────────────

let _skyTexture: THREE.CanvasTexture | null = null;
function getSkyTexture(): THREE.CanvasTexture | null {
  if (_skyTexture) return _skyTexture;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  // width=1: a single-column texture has no U-axis seam. The sphere maps this
  // column across all 360° of azimuth, so the hard "date-line" UV discontinuity
  // on the sphere geometry has nothing to interpolate across → seam invisible.
  // (Prior width=2 left a 1-texel discontinuity at u=0/1 that showed as a bright
  // vertical line at the canvas edge under certain drift angles.)
  canvas.width  = 1;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  // DARK navy underwater — near-uniform with the page bg (#061520) so it never
  // produces a bright horizon band. Only the faintest lift at the very top.
  grad.addColorStop(0.0,  '#050e17');
  grad.addColorStop(0.5,  '#071624');
  grad.addColorStop(0.8,  '#0a2032');
  grad.addColorStop(1.0,  '#0e2c42');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1, 256);
  _skyTexture = new THREE.CanvasTexture(canvas);
  _skyTexture.needsUpdate = true;
  return _skyTexture;
}

function GradientSky() {
  const mat = useMemo(() => {
    const skyTex = getSkyTexture();
    if (!skyTex) return new THREE.MeshBasicMaterial({ color: '#0a233a', side: THREE.BackSide });
    return new THREE.MeshBasicMaterial({
      map: skyTex,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
  }, []);

  useEffect(() => {
    return () => { mat.dispose(); };
  }, [mat]);

  return (
    <mesh renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[1200, 32, 16]} />
      <primitive object={mat} attach="material" />
    </mesh>
  );
}

// ─── Seabed ───────────────────────────────────────────────────────────────────
// Procedural sandy seabed with multi-octave undulation + vertex color bands.
// R5: palette swapped to the REAL arena-terrain.tsx warm sandy tones so it
// reads as the actual in-game floor. Upper atmosphere stays dark navy (sky dome
// + fog) — only the floor (lower ~40% of frame) goes warm/tan. 6000wu so edges
// are >fog.far from camera at all drift angles. MeshStandardMaterial so the
// warm directional key (#ffeedd) actually tints the sandy surface — vertex
// colors alone (MeshBasicMaterial) couldn't read warm enough. Module-scope
// singleton (never disposed — same rule as _skyTexture).

// Moody deep-ocean sand palette — warm-hued but VALUE-DARKENED ~50% from R5's
// near-white arena-terrain tones. At depth, MeshStandardMaterial + directional
// 2.20 + hemi 1.60 will lift these toward a mid-warm sand tone; starting dark
// prevents the "blown-out bright beach" appearance that R5 had.
// (R5 values: ridge 0xfff0d4, high 0xe8d0a8, mid 0xc4a878, valley 0x8a7050,
//  deep 0x5c4a32 — all too bright for an underwater scene.)
const _sandRidge  = new THREE.Color(0x7a6848); // dark warm sand peaks
const _sandHigh   = new THREE.Color(0x5e4f36); // deep warm sand
const _sandMid    = new THREE.Color(0x473a28); // dark golden mid-tone
const _sandValley = new THREE.Color(0x2e2518); // near-black warm valley
const _sandDeep   = new THREE.Color(0x1a140d); // deepest trough

function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

let _seabedGeo: THREE.BufferGeometry | null = null;
function getSeabedGeo(): THREE.BufferGeometry {
  if (_seabedGeo) return _seabedGeo;
  const geo = new THREE.PlaneGeometry(6000, 6000, 60, 60);
  const pos    = geo.attributes.position as THREE.BufferAttribute;
  const count  = pos.count;
  const colors = new Float32Array(count * 3);
  const rng    = seededRng(42);
  const tmp    = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);

    // Multi-octave dunes — same algorithm as arena-terrain.tsx
    const dune1  = Math.sin(x * 0.004 + 1.3) * Math.cos(y * 0.006 + 0.7) * 14;
    const dune2  = Math.sin(x * 0.010 + 3.1) * Math.sin(y * 0.013 + 2.4) *  8;
    const dune3  = Math.sin(x * 0.025 + 0.5) * Math.cos(y * 0.030 + 1.2) *  4;
    const ripple = Math.sin(x * 0.08  + y * 0.06) * 2;
    const noise  = (rng() - 0.5) * 1.5;
    const h      = dune1 + dune2 + dune3 + ripple + noise;
    pos.setZ(i, h);

    // Map height −28..+28 to 0..1, apply moody underwater color bands
    const t = Math.max(0, Math.min(1, (h + 28) / 56));
    if      (t < 0.20) tmp.lerpColors(_sandDeep,   _sandValley, t / 0.20);
    else if (t < 0.40) tmp.lerpColors(_sandValley,  _sandMid,   (t - 0.20) / 0.20);
    else if (t < 0.65) tmp.lerpColors(_sandMid,     _sandHigh,  (t - 0.40) / 0.25);
    else if (t < 0.85) tmp.lerpColors(_sandHigh,    _sandRidge, (t - 0.65) / 0.20);
    else               tmp.copy(_sandRidge);

    // Occasional darker wet patches — same as arena terrain
    if (rng() < 0.08) tmp.lerp(_sandDeep, 0.45);

    colors[i * 3    ] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  _seabedGeo = geo;
  return _seabedGeo;
}

let _seabedMat: THREE.MeshStandardMaterial | null = null;
function getSeabedMat(): THREE.MeshStandardMaterial {
  if (!_seabedMat) {
    // MeshStandardMaterial: vertexColors + fog so the warm directional key
    // (#ffeedd) tints the sandy vertex colors — MeshBasicMaterial ignores
    // lights so warm tones read as flat unlit, which was the R4 "blue-grey"
    // complaint. roughness/metalness tuned for sandy ocean floor (no speculars).
    _seabedMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      fog:          true,
      roughness:    0.97,
      metalness:    0,
    });
  }
  return _seabedMat;
}

function Seabed() {
  const ref = useRef<THREE.Mesh>(null);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    m.updateMatrix();
    m.matrixAutoUpdate = false;
  }, []);
  return (
    <mesh
      ref={ref}
      geometry={getSeabedGeo()}
      material={getSeabedMat()}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -2, 0]}
      frustumCulled={false}
    />
  );
}

// ─── Reef decorations ─────────────────────────────────────────────────────────
// 10 GLB instances from the scene's already-preloaded asset set, scattered in
// a loose ring around the town (radius 240–400wu) to make the seabed read as
// a populated reef, not a void. Sizes 25–50wu. All Iris Xe rules apply:
//   - clone.traverse frustumCulled=false (small assets at known positions)
//   - matrixAutoUpdate=false after first transform
//   - clones disposed on unmount
//   - NO per-frame allocs
//   - NO new lights (stays within 3-light budget)

interface ReefDecoDef {
  model: string;
  x:    number;
  z:    number;
  size: number;  // targetMaxDim in wu
  rotY: number;
}

// Seeded placement: 10 pieces around the town ring at radius 240–400, outside
// the 195wu building ring. Each placed at a different angle band so coverage
// is even. Models reuse what is already preloaded by LANDING_BUILDINGS or the
// sw.js PRECACHE_GLBS list. underwater-decorations is the richest single GLB
// (coral clusters + kelp merged); coral-reef1/2/3 + kelp fill the rest.
// R5: sizes bumped ~15-20% so decos pop against the new sandy floor.
const REEF_DECOS: ReefDecoDef[] = [
  { model: '/models/coral-reef1-ktx.glb',            x:  260, z:   30, size: 52, rotY: 0.3 },
  { model: '/models/coral-reef2-ktx.glb',            x: -220, z:  120, size: 46, rotY: 1.8 },
  { model: '/models/coral-reef3-ktx.glb',            x:   80, z: -270, size: 49, rotY: 0.9 },
  { model: '/models/kelp.glb',                   x: -290, z: -100, size: 41, rotY: 2.4 },
  { model: '/models/kelp.glb',                   x:  160, z:  290, size: 35, rotY: 0.6 },
  { model: '/models/coral-reef1-ktx.glb',            x: -150, z: -310, size: 44, rotY: 3.1 },
  { model: '/models/coral-reef2-ktx.glb',            x:  310, z: -200, size: 42, rotY: 1.2 },
  { model: '/models/coral-reef3-ktx.glb',            x: -330, z:  180, size: 46, rotY: 2.7 },
  { model: '/models/underwater-decorations.glb', x:  220, z: -340, size: 58, rotY: 0.5 },
  { model: '/models/underwater-decorations.glb', x: -200, z:  340, size: 56, rotY: 1.5 },
];

// Preload all deco GLBs at module scope (deduped — coral-reef1/2/3, kelp may
// already be preloaded by the sw.js PRECACHE_GLBS; preload is a no-op if
// already resolved).
const _DECO_MODELS = [...new Set(REEF_DECOS.map((d) => d.model))];
_DECO_MODELS.forEach((m) => {
  if (m.includes('-ktx.glb')) preloadKTX2Bytes(m);
  else useGLTF.preload(m, undefined, undefined, extendLoaderWithMeshopt);
});

// Module-scope bbox scratch for deco sizing (avoids new allocations per mount)
const _decoBbox   = new THREE.Box3();
const _decoSize   = new THREE.Vector3();
const _decoCenter = new THREE.Vector3();

interface ReefDecoInnerProps { def: ReefDecoDef }

function ReefDecoInner({ def }: ReefDecoInnerProps) {
  const { scene } = useGLTFWithKTX2(def.model);
  const groupRef  = useRef<THREE.Group>(null);

  const { cloned, scale, pivotOffsetX, pivotOffsetY, pivotOffsetZ } = useMemo(() => {
    const c = scene.clone(true);
    c.updateMatrixWorld(true);
    _decoBbox.makeEmpty();
    c.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) {
        mesh.geometry.computeBoundingBox();
        if (mesh.geometry.boundingBox) {
          _decoBbox.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
        }
      }
    });
    if (_decoBbox.isEmpty()) _decoBbox.setFromObject(c);
    _decoBbox.getSize(_decoSize);
    const maxDim = Math.max(_decoSize.x, _decoSize.y, _decoSize.z);
    const s = maxDim > 0.001 ? def.size / maxDim : 1;
    _decoBbox.getCenter(_decoCenter);
    c.traverse((obj) => {
      (obj as THREE.Mesh).frustumCulled = false;
    });
    return {
      cloned:        c,
      scale:         s,
      pivotOffsetX:  _decoCenter.x * s,
      pivotOffsetY:  _decoBbox.min.y * s,
      pivotOffsetZ:  _decoCenter.z * s,
    };
  }, [scene, def.size]);

  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material?.dispose();
        }
      });
    };
  }, [cloned]);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.matrixAutoUpdate = false;
    g.updateMatrix();
    cloned.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
    });
  }, [cloned]);

  return (
    <group ref={groupRef} position={[def.x, -2, def.z]} rotation={[0, def.rotY, 0]}>
      <group position={[-pivotOffsetX, -pivotOffsetY, -pivotOffsetZ]}>
        <primitive object={cloned} scale={scale} />
      </group>
    </group>
  );
}

function ReefDeco({ def }: ReefDecoInnerProps) {
  return (
    <Suspense fallback={null}>
      <ReefDecoInner def={def} />
    </Suspense>
  );
}

function ReefDecorations() {
  return (
    <>
      {REEF_DECOS.map((def, i) => (
        <ReefDeco key={`reef-deco-${i}`} def={def} />
      ))}
    </>
  );
}

// ─── HeroBuilding ─────────────────────────────────────────────────────────────

interface HeroBuildingProps {
  def: LandingBuildingDef;
  posX: number;
  posZ: number;
}

function HeroBuildingInner({ def, posX, posZ }: HeroBuildingProps) {
  const { scene } = useGLTFWithKTX2(def.model);
  const groupRef = useRef<THREE.Group>(null);

  const { cloned, scale, pivotOffsetX, pivotOffsetY, pivotOffsetZ } = useMemo(() => {
    const c = scene.clone(true);
    stripDecorativeMeshes(c);
    stripGroundPlanes(c);
    const { scale: s, pivotOffsetX: px, pivotOffsetY: py, pivotOffsetZ: pz } =
      computeHeroScale(c, HERO_TARGET_MAX_DIM);
    c.traverse((obj) => { (obj as THREE.Mesh).frustumCulled = false; });
    return { cloned: c, scale: s, pivotOffsetX: px, pivotOffsetY: py, pivotOffsetZ: pz };
  }, [scene]);

  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material?.dispose();
        }
      });
    };
  }, [cloned]);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.matrixAutoUpdate = false;
    g.updateMatrix();
    cloned.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
    });
  }, [cloned]);

  return (
    <group ref={groupRef} position={[posX, -2, posZ]} rotation={[0, def.rotY, 0]}>
      <group position={[-pivotOffsetX, -pivotOffsetY, -pivotOffsetZ]}>
        <primitive object={cloned} scale={scale} />
      </group>
    </group>
  );
}

function HeroBuilding(props: HeroBuildingProps) {
  return (
    <Suspense fallback={null}>
      <HeroBuildingInner {...props} />
    </Suspense>
  );
}

function BuildingRing() {
  const buildings = useMemo(() => {
    const N = LANDING_BUILDINGS.length;
    const step = (Math.PI * 2) / N;
    const startAngle = -Math.PI / 2;
    return LANDING_BUILDINGS.map((def, i) => {
      const angle = startAngle + i * step;
      return { def, posX: Math.cos(angle) * HERO_RING_RADIUS, posZ: Math.sin(angle) * HERO_RING_RADIUS };
    });
  }, []);

  return (
    <>
      {buildings.map(({ def, posX, posZ }, i) => (
        <HeroBuilding key={`hero-bldg-${i}`} def={def} posX={posX} posZ={posZ} />
      ))}
    </>
  );
}

// ─── DriftCamera ──────────────────────────────────────────────────────────────
// Near-horizontal horizon shot (elevation ≈52°, arm=295wu) with GENTLE sway +
// bob. Never a full 360° orbit (seabed edge-on wall). lookAt Y=+220 (R6)
// aims the camera ~28° below horizontal so the sandy floor reads as a foggy
// horizon at ~38–42% from bottom; the building ring sits in the lower ~40% of
// frame and the upper ~58% is dark open water for the hero title + CTAs.

function DriftCamera() {
  useFrame(({ camera, clock }) => {
    const t = clock.elapsedTime;
    const azimuth = CAM_BASE_AZIMUTH + Math.sin(t * 0.13) * 0.22;
    const bob     = Math.sin(t * 0.2) * 14;
    _scratchVec3A.set(
      Math.cos(azimuth) * CAM_ARM,
      CAM_Y + bob,
      Math.sin(azimuth) * CAM_ARM,
    );
    camera.position.copy(_scratchVec3A);
    _scratchVec3B.set(0, CAM_LOOK_Y, 0); // +220 aims near-horizontal; ring in lower ~40%, water above
    camera.lookAt(_scratchVec3B);
  });
  return null;
}

// ─── Scene contents ───────────────────────────────────────────────────────────

function SceneContents() {
  return (
    <>
      <DriftCamera />

      {/* Lighting (MAX 3 — Iris Xe rule #1). Lit SUBJECTS on a DARK stage.
          hemisphere 1.60: warm ambient fill on buildings + seabed surface.
          directional 2.20 (#ffeedd) near-vertical [0,500,60]: even key coverage
          across all ring positions; also warms the sandy seabed — R5 switched
          seabed to MeshStandardMaterial so the warm key (#ffeedd) can actually
          tint the sandy vertex colors (MeshBasicMaterial ignores lights).
          Point 1.9 / [0,150,0]: bioluminescent cyan fill, touches reef decos. */}
      <hemisphereLight color={_hemiSkyColor} groundColor={_hemiGroundColor} intensity={1.60} />
      <directionalLight color={_sunColor} intensity={2.20} position={[0, 500, 60]} />
      <pointLight color={_bioColor} intensity={1.9} distance={760} position={[0, 150, 0]} />

      {/* Dark-blue underwater fog (#0a2236). near=360 keeps the compact ring
          (radius 195) + reef decos fully visible; far=1400 fades distance + hides
          the 6000wu seabed's edges (always >1400 from camera at ~481wu from origin). */}
      <fog attach="fog" args={[_fogColor, 360, 1400]} />

      <GradientSky />
      <Seabed />
      <ReefDecorations />
      <BuildingRing />
    </>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function LandingScene() {
  const [mounted, setMounted] = useState(false);
  const { ref, frameloop } = useVisibleFrameloop();

  useEffect(() => {
    setMounted(true);
    // _seabedGeo, _seabedMat, _skyTexture are module-scope lazy singletons —
    // do NOT dispose (they survive remount). Building clones dispose themselves.
  }, []);

  if (!mounted) return null;

  return (
    <div ref={ref} className="absolute inset-0 z-0">
      <Canvas
        gl={{ antialias: false, powerPreference: 'high-performance', alpha: false }}
        dpr={[1, 1.25]}
        frameloop={frameloop}
        camera={{
          fov:  50,
          near: 1,
          // far clears the sky dome (radius 1200) from the orbiting camera
          // (~479wu from origin at 52° elevation): 1200 + 479 ≈ 1679 < 2400.
          far:  2400,
          position: [CAM_ARM, CAM_Y, 0],
        }}
        onCreated={({ scene }) => {
          scene.background = new THREE.Color(0x081420);
        }}
      >
        <KTX2LoaderSetup />
        <SceneContents />
      </Canvas>
    </div>
  );
}
