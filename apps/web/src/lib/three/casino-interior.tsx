'use client';

/**
 * casino-interior.tsx
 *
 * Route-isolated R3F scene component for the casino interior.
 * Mounted exclusively at /casino — torn down on exit via Canvas key prop.
 *
 * Asset: /models/casino/casino-interior.glb (gameready, 4.2MB, Draco)
 *        /models/casino/casino-interior-fallback.glb (cartoon, 58KB, no Draco)
 *        Object_8 + Object_9 in fallback GLB = left-wall slot cluster
 *
 * Iris Xe invariants (enforced in this file):
 *   - NO shadows
 *   - NO drei Text / Billboard
 *   - NO InstancedMesh + ShaderMaterial
 *   - NO per-frame `new Vector3()` — module-scope scratch vectors only
 *   - matrixAutoUpdate=false on all static meshes after first transform
 *   - Draw calls < 120 (gameready ~21 meshes; hotspot boxes add 4-6)
 *
 * Concern 6.0.2 scope:
 *   - Click hotspots over slot machines → placeholder console.info handler
 *   - Walk-in animation (6.0.3) and 2D slot screen (6.0.4) are OUT of scope
 */

import { Suspense, useRef, useEffect, useMemo, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { CasinoLighting } from '@/components/three/CasinoLighting';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gameready GLB path — Draco compressed, 4.2MB, ~211k tris */
const INTERIOR_GLB = '/models/casino/casino-interior.glb';
/** Fallback cartoon GLB — no Draco, 58KB, 449 tris, CC-BY-4.0 */
const FALLBACK_GLB = '/models/casino/casino-interior-fallback.glb';

/** FPS threshold below which we auto-switch to fallback GLB.
 *  Checked during the first 5 seconds after scene load. */
const FPS_FALLBACK_THRESHOLD = 40;

/** Target world-unit height for auto-fit scale normalisation.
 *  Both GLBs are independently fitted to this target height. */
const INTERIOR_TARGET_HEIGHT = 600; // world units

// ---------------------------------------------------------------------------
// Module-scope scratch objects — NEVER allocated inside useFrame
// ---------------------------------------------------------------------------
const _bbox = new THREE.Box3();
const _center = new THREE.Vector3();
const _size = new THREE.Vector3();
const _meshBbox = new THREE.Box3();

// ---------------------------------------------------------------------------
// Draco loader singleton — shared across scene lifetime
// ---------------------------------------------------------------------------
const _dracoLoader = new DRACOLoader();
// Google CDN for the Draco decoder WASM (stable, versioned)
_dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

// Extend the shared GLTF loader with Draco for the gameready asset
const extendWithDraco = (loader: unknown) => {
  (loader as GLTFLoader).setDRACOLoader(_dracoLoader);
};

// Preload both GLBs at module scope — browser only (guards SSR)
if (typeof window !== 'undefined') {
  useGLTF.preload(INTERIOR_GLB, undefined, undefined, extendWithDraco);
  useGLTF.preload(FALLBACK_GLB);
  // Kick Draco WASM preload in background so first decode is instant
  _dracoLoader.preload();
}

// ---------------------------------------------------------------------------
// Utility: Box3 auto-fit — scale + pivot offsets from a cloned scene
// ---------------------------------------------------------------------------
interface FitResult {
  scale: number;
  offsetX: number; // subtract from world X to center geometry
  offsetY: number; // subtract from world Y to ground geometry (bbox.min.y * scale)
  offsetZ: number;
}

function computeAutoFit(scene: THREE.Object3D, targetHeight: number): FitResult {
  _bbox.makeEmpty();
  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh && mesh.geometry) {
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      _meshBbox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _bbox.union(_meshBbox);
    }
  });
  if (_bbox.isEmpty()) {
    _bbox.setFromObject(scene);
  }

  _bbox.getSize(_size);
  const h = _size.y > 0.001 ? _size.y : Math.max(_size.x, _size.y, _size.z);
  const scale = h > 0 ? targetHeight / h : 1;

  _bbox.getCenter(_center);
  return {
    scale,
    offsetX: _center.x * scale,
    offsetY: _bbox.min.y * scale,
    offsetZ: _center.z * scale,
  };
}

// ---------------------------------------------------------------------------
// Hotspot definitions
// ---------------------------------------------------------------------------
interface HotspotDef {
  position: [number, number, number];
  size: [number, number, number];
  machineSlug: string;
}

/**
 * Fallback GLB (cartoon, 58KB):
 * Object_8 + Object_9 are the left-wall slot cluster.
 * Positions are in world units after auto-fit scale (INTERIOR_TARGET_HEIGHT=600).
 */
const FALLBACK_HOTSPOTS: HotspotDef[] = [
  // Object_8 — left cabinet
  { position: [-80, 60, -40], size: [50, 80, 40], machineSlug: 'classic-3x5' },
  // Object_9 — right cabinet
  { position: [80, 60, -40],  size: [50, 80, 40], machineSlug: 'classic-3x5' },
];

/**
 * Gameready GLB (~211k tris):
 * Material names are generic (Material2, Material3 etc). Four floor-pedestal
 * clickboxes cover the left-wall cabinet zone where slot machines appear visually.
 * Positions in post-fit world units; adjust after first deploy verification.
 */
const GAMEREADY_HOTSPOTS: HotspotDef[] = [
  { position: [-200, 50, -80], size: [55, 90, 45], machineSlug: 'classic-3x5' },
  { position: [-120, 50, -80], size: [55, 90, 45], machineSlug: 'classic-3x5' },
  { position: [-40, 50, -80],  size: [55, 90, 45], machineSlug: 'classic-3x5' },
  { position: [40, 50, -80],   size: [55, 90, 45], machineSlug: 'classic-3x5' },
];

// ---------------------------------------------------------------------------
// Invisible slot machine clickbox component
// ---------------------------------------------------------------------------
function SlotHotspot({ def }: { def: HotspotDef }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // Static position — disable matrix auto-update
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, []);

  return (
    <mesh
      ref={meshRef}
      position={def.position}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        setHovered(false);
        if (typeof document !== 'undefined') document.body.style.cursor = 'default';
      }}
      onClick={(e) => {
        e.stopPropagation();
        console.info(`[slot-screen pending — Concern 6.0.4] machineSlug=${def.machineSlug}`);
      }}
    >
      <boxGeometry args={def.size} />
      {/*
       * Invisible click target. visible=false means Three.js skips rasterisation
       * but raycasting still works (raycast tests the geometry, not the rendered pixels).
       * hovered tracking is used internally; no visual change needed per brief.
       */}
      <meshBasicMaterial visible={false} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// GLB loader + scene subtree
// ---------------------------------------------------------------------------
interface InteriorSceneProps {
  useFallback: boolean;
  onFallbackRequest: () => void;
  /** Called if scene appears empty after 3s (meshCount=0 or no geometry visible) */
  onSceneEmpty: () => void;
}

function InteriorScene({ useFallback, onFallbackRequest, onSceneEmpty }: InteriorSceneProps) {
  const glbPath = useFallback ? FALLBACK_GLB : INTERIOR_GLB;
  const { scene } = useGLTF(
    glbPath,
    undefined,
    undefined,
    useFallback ? undefined : extendWithDraco,
  );
  const { camera } = useThree();

  const groupRef = useRef<THREE.Group>(null);

  // FPS tracking for auto-fallback (first 5s only, skipped if already on fallback)
  const fpsFrames  = useRef(0);
  const fpsAccum   = useRef(0);
  const fpsChecked = useRef(false);
  // Fail-safe: did we already call onSceneEmpty?
  const emptyFired = useRef(false);

  const { cloned, hotspots, meshCount } = useMemo(() => {
    const c = scene.clone(true);
    c.updateMatrixWorld(true);

    // Compute auto-fit at native scale (scale=1) — measures actual geometry bbox.
    // IMPORTANT: matrixAutoUpdate must still be TRUE here so updateMatrixWorld
    // propagates correctly. We disable it AFTER applying both scale AND position.
    const fitResult = computeAutoFit(c, INTERIOR_TARGET_HEIGHT);

    // Step 1: Apply scale directly onto the cloned root.
    // Do NOT pass scale as a R3F prop — if matrixAutoUpdate=false the prop write
    // never triggers a matrix recompute and the model stays at native micro-scale.
    c.scale.setScalar(fitResult.scale);

    // Step 2: Bake the centering offset into the cloned root's position.
    // This is safer than relying on the outer <group> position prop being reconciled
    // before matrixAutoUpdate is locked — R3F prop timing is not guaranteed to
    // complete before the useEffect that locks the matrix fires.
    // offsetX/Z: moves geometry center to scene origin (XZ centering).
    // offsetY: bbox.min.y*scale — grounds the floor at Y=0 of the parent.
    c.position.set(-fitResult.offsetX, -fitResult.offsetY, -fitResult.offsetZ);

    // Step 3: Propagate both transforms into matrixWorld BEFORE locking.
    c.updateMatrixWorld(true);

    // Step 4: Lock all nodes — matrices are current and correct.
    c.traverse((obj) => {
      obj.matrixAutoUpdate = false;
    });

    if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_CASINO_DEBUG === '1') {
      const bbox2 = new THREE.Box3().setFromObject(c);
      const sz = new THREE.Vector3(); bbox2.getSize(sz);
      const ct = new THREE.Vector3(); bbox2.getCenter(ct);
      console.info('[casino-interior] post-fit bbox center:', ct, 'size:', sz, 'scale:', fitResult.scale, 'offset applied:', fitResult);
    }

    const hotspotDefs = useFallback ? FALLBACK_HOTSPOTS : GAMEREADY_HOTSPOTS;

    // Count visible meshes so the fail-safe overlay can detect an empty scene.
    let count = 0;
    c.traverse((obj) => { if ((obj as THREE.Mesh).isMesh) count++; });

    return { cloned: c, hotspots: hotspotDefs, meshCount: count };
  }, [scene, useFallback]);

  // Dispose cloned geometry + materials when component unmounts
  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m) => m?.dispose());
        }
      });
    };
  }, [cloned]);

  // matrixAutoUpdate=false on the parent group.
  // The group stays at origin (0,0,0) — all centering is baked into cloned.position.
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.matrixAutoUpdate = false;
    g.updateMatrix();
  }, [cloned]);

  // Camera debug log — fires once on first frame when NEXT_PUBLIC_CASINO_DEBUG=1
  const debugLogged = useRef(false);
  useFrame(() => {
    if (debugLogged.current) return;
    debugLogged.current = true;
    if (process.env.NEXT_PUBLIC_CASINO_DEBUG === '1') {
      const cam = camera as THREE.PerspectiveCamera;
      const g = groupRef.current;
      console.info(
        '[casino-interior DEBUG]\n' +
        `  glb: ${glbPath}\n` +
        `  meshCount: ${meshCount}\n` +
        `  cloned.position: (${cloned.position.x.toFixed(1)}, ${cloned.position.y.toFixed(1)}, ${cloned.position.z.toFixed(1)})\n` +
        `  cloned.scale: ${cloned.scale.x.toFixed(4)}\n` +
        `  group.position: ${g ? `(${g.position.x.toFixed(1)}, ${g.position.y.toFixed(1)}, ${g.position.z.toFixed(1)})` : 'null'}\n` +
        `  camera.position: (${cam.position.x.toFixed(1)}, ${cam.position.y.toFixed(1)}, ${cam.position.z.toFixed(1)})\n` +
        `  camera.fov=${cam.fov} near=${cam.near} far=${cam.far}`
      );
    }
  });

  // Combined timing loop: FPS auto-fallback (5s) + scene-empty fail-safe (3s).
  useFrame((_, delta) => {
    if (useFallback && fpsChecked.current && emptyFired.current) return; // all checks done

    fpsAccum.current += delta;
    fpsFrames.current += 1;

    // Scene-empty fail-safe: after 3s, if no meshes were cloned, notify parent.
    // This catches edge cases where both GLBs silently produce zero geometry.
    if (!emptyFired.current && fpsAccum.current >= 3.0 && meshCount === 0) {
      emptyFired.current = true;
      onSceneEmpty();
    }

    // FPS auto-fallback: after 5s on the gameready GLB, check average FPS.
    if (!fpsChecked.current && !useFallback && fpsAccum.current >= 5.0) {
      fpsChecked.current = true;
      const avgFps = fpsFrames.current / fpsAccum.current;
      if (avgFps < FPS_FALLBACK_THRESHOLD) {
        console.warn(
          `[casino-interior] avg FPS ${avgFps.toFixed(1)} < ${FPS_FALLBACK_THRESHOLD} threshold — switching to fallback GLB`
        );
        onFallbackRequest();
      } else {
        console.log(`[casino-interior] FPS OK (avg ${avgFps.toFixed(1)}), staying on gameready GLB`);
      }
    }
  });

  return (
    <group
      ref={groupRef}
    >
      {/* scale and centering offset are both baked into cloned.position / cloned.scale
           in useMemo — do NOT pass scale or position props to <primitive>.
           R3F prop writes after matrixAutoUpdate=false don't trigger matrix recomputes. */}
      <primitive object={cloned} />

      {/* Invisible click hotspots over slot machine positions */}
      {hotspots.map((def, i) => (
        <SlotHotspot key={i} def={def} />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Default export — full casino interior scene (rendered inside R3F Canvas)
// onSceneEmpty is wired by CasinoCanvas (DOM context) via a module-level ref,
// so the fail-safe overlay can be rendered in the DOM tree, not the R3F tree.
// ---------------------------------------------------------------------------
export interface CasinoInteriorSceneProps {
  /** Called when meshCount===0 after 3s — lets CasinoCanvas render a DOM overlay */
  onSceneEmpty?: () => void;
}

export default function CasinoInteriorScene({ onSceneEmpty }: CasinoInteriorSceneProps = {}) {
  const [useFallback, setUseFallback] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('fallback') === '1';
  });

  return (
    <>
      <CasinoLighting />

      {/* Interior fog — short range, tinted neon-dark */}
      <fog attach="fog" args={[0x0a0015, 400, 1200]} />

      <Suspense fallback={null}>
        <InteriorScene
          useFallback={useFallback}
          onFallbackRequest={() => setUseFallback(true)}
          onSceneEmpty={onSceneEmpty ?? (() => {})}
        />
      </Suspense>
    </>
  );
}
