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
import { useFrame } from '@react-three/fiber';
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
}

function InteriorScene({ useFallback, onFallbackRequest }: InteriorSceneProps) {
  const glbPath = useFallback ? FALLBACK_GLB : INTERIOR_GLB;
  const { scene } = useGLTF(
    glbPath,
    undefined,
    undefined,
    useFallback ? undefined : extendWithDraco,
  );

  const groupRef = useRef<THREE.Group>(null);

  // FPS tracking for auto-fallback (first 5s only, skipped if already on fallback)
  const fpsFrames  = useRef(0);
  const fpsAccum   = useRef(0);
  const fpsChecked = useRef(false);

  const { cloned, fit, hotspots } = useMemo(() => {
    const c = scene.clone(true);
    c.updateMatrixWorld(true);

    // Lock all cloned nodes — they're static
    c.traverse((obj) => {
      obj.matrixAutoUpdate = false;
    });

    const fitResult = computeAutoFit(c, INTERIOR_TARGET_HEIGHT);
    const hotspotDefs = useFallback ? FALLBACK_HOTSPOTS : GAMEREADY_HOTSPOTS;

    return { cloned: c, fit: fitResult, hotspots: hotspotDefs };
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

  // matrixAutoUpdate=false on the parent group
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.matrixAutoUpdate = false;
    g.updateMatrix();
  }, [cloned]);

  // FPS auto-fallback — runs for first 5 seconds, then stops
  useFrame((_, delta) => {
    if (useFallback || fpsChecked.current) return;
    fpsAccum.current += delta;
    fpsFrames.current += 1;

    if (fpsAccum.current >= 5.0) {
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
      position={[-fit.offsetX, -fit.offsetY, -fit.offsetZ]}
    >
      <primitive object={cloned} scale={fit.scale} />

      {/* Invisible click hotspots over slot machine positions */}
      {hotspots.map((def, i) => (
        <SlotHotspot key={i} def={def} />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Default export — full casino interior scene
// ---------------------------------------------------------------------------
export default function CasinoInteriorScene() {
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
        />
      </Suspense>
    </>
  );
}
