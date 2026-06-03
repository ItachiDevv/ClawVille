'use client';

/**
 * LandingScene.tsx — Cinematic establishing shot over the ClawVille town ring.
 *
 * Visual direction (frontend-design pass 2026-06-01): a deep, luminous,
 * bioluminescent underwater vista that MATCHES the real in-game world palette
 * — deep-blue fog (#0e3458), hemisphere sky #66bbdd / ground #223344, warm
 * key light — rather than the washed teal/tan it had before.
 *
 * Camera: a steep top-down 3/4 vantage (65° elevation, arm=280wu) that drifts
 * gently (±0.22 rad sway + slow bob) — NOT a full 360° orbit. A full orbit
 * swung the finite seabed plane edge-on into a "wall"; a gentle drift keeps a
 * cinematic, stable composition. The steeper 65° angle (was 49°) collapses
 * near/far size disparity so the ring reads as a balanced symmetric circle.
 * Belt-and-suspenders: the seabed is 6000wu wide so its edges are always FULLY
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

// ─── Ring layout constants ────────────────────────────────────────────────────

/** Target max dimension for each building in the landing scene (world units).
 *  Slightly larger than before to compensate for the steeper top-down angle
 *  compressing apparent building height. */
const HERO_TARGET_MAX_DIM = 96;

/** Ring radius for the overview shot (world units). Tighter = town reads as a
 *  compact, CENTERED cluster behind the logo rather than spread to the edges. */
const HERO_RING_RADIUS = 195;

/** Number of building slots. */
const HERO_SLOT_COUNT = 10;

/** Camera height + orbit-arm length.
 *  CAM_Y=600, CAM_ARM=280 → elevation ≈ 65° from horizon (atan2(600,280)).
 *  Steeper angle collapses near/far size disparity so the ring reads as a
 *  symmetric circle. Prior 49° (480/420) left front buildings 2-3× larger than
 *  back ones, creating a lopsided pile rather than a town overview. */
const CAM_Y   = 600;
const CAM_ARM = 280;

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
  { model: '/models/pineapple-house-opt1.glb?v=2',      rotY:  0.000 },  // visual-creation
  { model: '/models/chum-bucket-v2-opt1.glb?v=2',       rotY: -0.522 },  // code-development
  { model: '/models/krusty-krab-v2-opt1.glb?v=2',       rotY: -1.049 },  // mcp-tool-use
  { model: '/models/salty-spitoon-opt1.glb?v=2',        rotY: -2.093 },  // api-integrations
  { model: '/models/boating-school-opt1.glb?v=2',       rotY: -2.620 },  // app-publishing
  { model: '/models/patty-building-opt1.glb?v=2',       rotY:  3.142 },  // cron-automation
  { model: '/models/building-lighthouse-opt1.glb?v=2',  rotY:  2.620 },  // deployment-ops
  { model: '/models/arcade/claw-arcade-exterior-opt1.glb?v=2', rotY: 2.093 }, // claw-arcade
  { model: '/models/patricks-rock-v2-opt1.glb?v=3',    rotY:  1.049 },  // agent-security
  { model: '/models/squidward-house-opt1.glb?v=3',      rotY:  0.522 },  // memory-rag
];

// Preload all 10 buildings at module scope.
LANDING_BUILDINGS.forEach(({ model }) => {
  useGLTF.preload(model, undefined, undefined, extendLoaderWithMeshopt);
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
  canvas.width  = 2;
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
  ctx.fillRect(0, 0, 2, 256);
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
      <sphereGeometry args={[1200, 24, 12]} />
      <primitive object={mat} attach="material" />
    </mesh>
  );
}

// ─── Seabed ───────────────────────────────────────────────────────────────────
// HUGE flat lit sand floor. 6000wu wide so its edges are always >fog.far from
// the camera → fully fogged out → no hard edge / "wall" can ever appear at any
// drift angle. Lit (MeshStandardMaterial) so it responds to the scene lighting
// and the deep-blue fog blends its far reaches into the water.

let _seabedGeo: THREE.PlaneGeometry | null = null;
function getSeabedGeo(): THREE.PlaneGeometry {
  if (!_seabedGeo) _seabedGeo = new THREE.PlaneGeometry(6000, 6000, 1, 1);
  return _seabedGeo;
}

let _seabedMat: THREE.MeshStandardMaterial | null = null;
function getSeabedMat(): THREE.MeshStandardMaterial {
  if (!_seabedMat) {
    _seabedMat = new THREE.MeshStandardMaterial({
      color:     new THREE.Color('#172834'), // DARK navy seabed — flows into the page theme, fog blends it deeper
      roughness: 0.97,
      metalness: 0,
      fog:       true,
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

// ─── HeroBuilding ─────────────────────────────────────────────────────────────

interface HeroBuildingProps {
  def: LandingBuildingDef;
  posX: number;
  posZ: number;
}

function HeroBuildingInner({ def, posX, posZ }: HeroBuildingProps) {
  const { scene } = useGLTF(def.model, undefined, undefined, extendLoaderWithMeshopt);
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
// Steep top-down 3/4 vantage (65° elevation, arm=280wu) with GENTLE sway + bob.
// Never a full 360° orbit (seabed edge-on wall). LookAt lifted to Y=30 so the
// ring's upper buildings don't vanish above the frame at the steep angle.

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
    _scratchVec3B.set(0, 30, 0); // lifted slightly so the ring occupies frame center vertically
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
          Key changes for even ring coverage at the steeper 65° camera:
          - hemisphere raised 1.05 → 1.45: wraps all 10 buildings equally with
            sky/ground fill regardless of their angular position in the ring.
          - directional moved more overhead [180,420,140] → [0,500,60]: near-vertical
            key rakes building TOPS on all sides (elevation ≈ 83°) so the back-left
            buildings (patricks-rock, squidward, boating-school) get the same key
            contribution as the front-right ones. The small +Z offset keeps a faint
            directional cue so it isn't purely flat.
          - cyan point lifted [0,70,0] → [0,150,0]: sits above most building tops
            (~96wu target), emitting warm bioluminescent fill downward into the ring
            center from a higher vantage. */}
      <hemisphereLight color={_hemiSkyColor} groundColor={_hemiGroundColor} intensity={1.45} />
      <directionalLight color={_sunColor} intensity={1.75} position={[0, 500, 60]} />
      <pointLight color={_bioColor} intensity={1.9} distance={760} position={[0, 150, 0]} />

      {/* Dark-blue underwater fog (#0a2236). near=360 keeps the compact ring
          (radius 195) fully visible; far=1400 fades distance + fully hides the
          6000wu seabed's edges (always >1400 from camera at 659wu from origin). */}
      <fog attach="fog" args={[_fogColor, 360, 1400]} />

      <GradientSky />
      <Seabed />
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
          // (~659wu from origin at 65° elevation): 1200 + 659 ≈ 1859 < 2400.
          far:  2400,
          position: [CAM_ARM, CAM_Y, 0],
        }}
        onCreated={({ scene }) => {
          scene.background = new THREE.Color(0x081420);
        }}
      >
        <SceneContents />
      </Canvas>
    </div>
  );
}
