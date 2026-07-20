'use client';

/**
 * CoveVignette.tsx
 *
 * ~16-second looping cinematic preview of the ClawVille Cove (in-game casino).
 * Slow lateral dolly across the neon-lit gaming floor with 4 Milady avatars
 * visibly seated/standing at the blackjack and holdem tables.
 *
 * Consumed via:
 *   dynamic(() => import('@/components/landing/CoveVignette'), { ssr: false })
 *
 * Iris Xe / WebGPU constraints honored:
 *   1. Lights: hemisphere + 2 point lights = 3 total (Iris Xe max-3 budget).
 *      CoveLighting (5 lights) is NOT used here — vignette uses a trimmed inline rig.
 *   2. NO drei <Text> / <Billboard> — any in-world text uses CanvasTexture only.
 *   3. NO InstancedMesh + ShaderMaterial.
 *   4. NO new THREE.Vector3/Quaternion inside useFrame — module-scope scratch only.
 *   5. Dispose all geometries, materials, textures, cloned GLB on unmount.
 *   6. frustumCulled=false on every SkinnedMesh / VRM mesh.
 *   7. DPR capped at [1, 1.25].
 *   8. useVisibleFrameloop() pauses canvas when scrolled offscreen.
 *   9. import * as THREE from 'three' only — never 'three/webgpu'.
 */

import { useRef, useEffect, useMemo, Suspense } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { useVisibleFrameloop } from '@/lib/use-visible-frameloop';
import { useVRMInstance, disposeVRMInstance, retainVRMInstance } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator } from '@/lib/three/vrm-character-animator';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Draco decoder path — same singleton as cove-interior.tsx */
const DRACO_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';

/** Interior GLB — same path as INTERIOR_GLB in cove-interior.tsx */
const INTERIOR_GLB = '/models/cove/cove-interior-cleaned-v1.glb?v=5';
/** Lighter fallback (58KB, no Draco). Used as safety net — prefer cleaned-v1
 *  for fidelity; cleaned-v1 is preloaded so initial parse cost is avoided. */
const FALLBACK_GLB = '/models/cove/cove-interior-fallback.glb';

/** Auto-fit target: same as INTERIOR_TARGET_HEIGHT in cove-interior.tsx */
const INTERIOR_TARGET_HEIGHT = 2000; // world units

/**
 * Avatar target height — bumped to 240wu so the Miladys read clearly at the
 * vignette camera distances.  COVE_VRM_TARGET_HEIGHT in cove-interior.tsx is
 * 160wu (in-game, calibrated to slot cabinets).  Here we want them visibly
 * large for the cinematic, so 240wu ≈ 1.5× in-room scale.
 */
const AVATAR_TARGET_HEIGHT = 175; // world units

// ---------------------------------------------------------------------------
// Four Milady VRMs — distinct skins, distinct instance IDs
// VRM faces -Z at rotation.y=0 (Mixamo-rigged VRMs in ClawVille follow the
// same convention as documented in patterns/vrm-mixamo-retarget.md).
//
// Table positions (from cove-interior.tsx):
//   Blackjack: _DEALER_CENTER_X=-299, _DEALER_CENTER_Z=331
//   Holdem:    _HOLDEM_CENTER_X=294,  _HOLDEM_CENTER_Z=335
//
// Avatar 1 (milady-official-1) — left side of blackjack table
//   x = -299 - 120 = -419, z=331, faces +X (toward table) → rotY = Math.PI/2
// Avatar 2 (milady-official-2) — right side of blackjack table
//   x = -299 + 120 = -179, z=331, faces -X (toward table) → rotY = -Math.PI/2
// Avatar 3 (milady-official-3) — near side of holdem table (lower Z)
//   x = 294, z=335-120=215, faces +Z (toward table) → rotY = Math.PI
// Avatar 4 (milady-official-4) — far side of holdem table (higher Z)
//   x = 294, z=335+120=455, faces -Z (toward table) → rotY = 0
// ---------------------------------------------------------------------------
interface AvatarDef {
  path: string;
  instanceId: string;
  posX: number;
  posZ: number;
  rotY: number;
}

const AVATAR_DEFS: AvatarDef[] = [
  {
    path: '/avatars/milady-official-1.vrm',
    instanceId: 'cove-vig-1',
    posX: -419,
    posZ: 331,
    rotY: Math.PI / 2,   // faces +X — toward blackjack table from left
  },
  {
    path: '/avatars/milady-official-2.vrm',
    instanceId: 'cove-vig-2',
    posX: -179,
    posZ: 331,
    rotY: -Math.PI / 2,  // faces -X — toward blackjack table from right
  },
  {
    path: '/avatars/milady-official-3.vrm',
    instanceId: 'cove-vig-3',
    posX: 294,
    posZ: 215,
    rotY: Math.PI,       // faces +Z — toward holdem table from near side
  },
  {
    path: '/avatars/milady-official-4.vrm',
    instanceId: 'cove-vig-4',
    posX: 294,
    posZ: 455,
    rotY: 0,             // faces -Z — toward holdem table from far side
  },
];

/** Fog — matches cove page. */
const FOG_COLOR = 0x0a0015;
/** Fog near/far tuned for the 2000wu room so the back wall fades naturally
 *  without crushing the foreground to black. */
const FOG_NEAR = 600;
const FOG_FAR  = 3000;

/**
 * Cinematic dolly — camera glides laterally across the table cluster.
 *
 * Tables span X≈-419..+294, Z≈215..455.  Camera is placed at Z≈-120
 * (in front of the tables, looking toward them from the near side of the room)
 * and swept from X=-150 to X=+450 over 16s so it passes both the blackjack
 * and holdem groups.
 *
 * CAM_Y = 200: lower than before (260) so the 240wu avatars fill the frame.
 * CAM_LOOK_Y = 120: chest-height of a 240wu avatar.
 * CAM_LOOK_Z = 333: depth midpoint of the two tables.
 *
 * The look-at X drifts at 60% of the camera X travel speed, producing a
 * pan-with-lag parallax feel where the Miladys stay in frame longer.
 */
const CAM_Y       = 220;   // world units — slightly higher; avatars are 175wu now
const CAM_Z       = -230;  // world units — pulled back so avatars read as people at tables (not giants)
const CAM_LOOK_Y  = 95;    // look-at Y — chest height for 175wu avatar
const CAM_LOOK_Z  = 333;   // look-at Z — depth midpoint of both tables
const DOLLY_X_START = -150; // left edge of sweep (near blackjack)
const DOLLY_X_END   =  450; // right edge of sweep (past holdem)
const DOLLY_DURATION = 16;  // seconds for full one-way sweep (ping-pong)

// ---------------------------------------------------------------------------
// Module-scope scratch vectors — NEVER allocated inside useFrame
// ---------------------------------------------------------------------------
const _camPos    = new THREE.Vector3();
const _camTarget = new THREE.Vector3();

// Light colors + fog color — module scope, not re-created per render (rule #4)
const _CYAN_COLOR    = new THREE.Color(0x00ffe0);
const _MAGENTA_COLOR = new THREE.Color(0xff00cc);
const _FOG_COLOR_OBJ = new THREE.Color(FOG_COLOR);

// ---------------------------------------------------------------------------
// Draco singleton — same pattern as cove-interior.tsx
// ---------------------------------------------------------------------------
const _dracoLoader = new DRACOLoader();
_dracoLoader.setDecoderPath(DRACO_PATH);

const extendWithDraco = (loader: unknown) => {
  (loader as GLTFLoader).setDRACOLoader(_dracoLoader);
};

// NOTE: Preload is NOT at module scope. It is deferred until the component
// mounts (IntersectionObserver viewport entry via useVisibleFrameloop) so that
// the 4.9 MB Draco decode does not compete with the hero LandingScene's 11 GLBs
// during initial page paint. The Suspense fallback <CoveRoomFallback /> covers
// the loading state gracefully.

// ---------------------------------------------------------------------------
// Utility — copy of computeAutoFit from cove-interior.tsx
// Avoids SkinnedMesh bbox inflation; uses only static mesh geometry bounds.
// ---------------------------------------------------------------------------
const _fitBbox     = new THREE.Box3();
const _fitCenter   = new THREE.Vector3();
const _fitSize     = new THREE.Vector3();
const _fitMeshBbox = new THREE.Box3();

interface FitResult {
  scale: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

function computeAutoFit(scene: THREE.Object3D, targetHeight: number): FitResult {
  _fitBbox.makeEmpty();
  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh && mesh.geometry) {
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      _fitMeshBbox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _fitBbox.union(_fitMeshBbox);
    }
  });
  if (_fitBbox.isEmpty()) {
    _fitBbox.setFromObject(scene);
  }
  _fitBbox.getSize(_fitSize);
  const maxDim = Math.max(_fitSize.x, _fitSize.y, _fitSize.z);
  const scale  = maxDim > 0.001 ? targetHeight / maxDim : 1;
  _fitBbox.getCenter(_fitCenter);
  return {
    scale,
    offsetX: _fitCenter.x * scale,
    offsetY: _fitBbox.min.y * scale,
    offsetZ: _fitCenter.z * scale,
  };
}

// ---------------------------------------------------------------------------
// CoveRoom — loads and renders the interior GLB, scaled to INTERIOR_TARGET_HEIGHT.
// matrixAutoUpdate=false after first transform (static geometry).
// ---------------------------------------------------------------------------
function CoveRoom() {
  const { scene } = useGLTF(INTERIOR_GLB, undefined, undefined, extendWithDraco);
  const groupRef = useRef<THREE.Group>(null);

  const { cloned, fit } = useMemo(() => {
    const c = scene.clone(true);
    // Clone every material so this renderer context gets its own GPU programs.
    c.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map((m) => m.clone());
        } else {
          mesh.material = mesh.material.clone();
        }
      }
      // Disable frustum culling on skinned meshes (bind-pose bbox would cull)
      if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
        obj.frustumCulled = false;
      }
    });
    // Compute fit BEFORE locking matrixAutoUpdate
    c.updateMatrixWorld(true);
    const f = computeAutoFit(c, INTERIOR_TARGET_HEIGHT);
    return { cloned: c, fit: f };
  }, [scene]);

  // Apply scale + center offset; lock matrixAutoUpdate on the static room.
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.updateMatrixWorld(true);
    g.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
    });
    g.matrixAutoUpdate = false;
    g.updateMatrix();
  }, [fit]);

  // Dispose cloned room on unmount (source stays in useGLTF cache).
  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m: THREE.Material) => m.dispose());
        }
      });
    };
  }, [cloned]);

  return (
    <group
      ref={groupRef}
      scale={[fit.scale, fit.scale, fit.scale]}
      position={[-fit.offsetX, -fit.offsetY, -fit.offsetZ]}
    >
      <primitive object={cloned} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// CoveRoomFallback — lightweight fallback for old GPUs / load failures.
// Simple dark floor plane so the vignette isn't completely empty while
// the room GLB is loading or if the Draco parse fails.
// ---------------------------------------------------------------------------
const _floorGeo = new THREE.PlaneGeometry(800, 1800, 1, 1);
const _floorMat = new THREE.MeshStandardMaterial({ color: 0x0d0520, roughness: 0.9, metalness: 0.1 });

function CoveRoomFallback() {
  return (
    <mesh
      geometry={_floorGeo}
      material={_floorMat}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, 0]}
    />
  );
}

// ---------------------------------------------------------------------------
// VignetteAvatarInner — one Milady VRM standing idle at a table.
// Loads via useVRMInstance (per-instance cache — Codex Critical #1 compliance:
// each avatar has a unique instanceId so no two share a parsed VRM).
// Disposes via disposeVRMInstance on unmount.
// ---------------------------------------------------------------------------
interface VignetteAvatarInnerProps {
  def: AvatarDef;
}

function VignetteAvatarInner({ def }: VignetteAvatarInnerProps) {
  const vrm = useVRMInstance(def.path, def.instanceId);

  const { scale: vrmScale, offsetY: vrmOffsetY } = useMemo(
    () => computeVRMAvatarFit(vrm, 'milady', AVATAR_TARGET_HEIGHT),
    [vrm],
  );

  // Dispose on unmount — each avatar disposes its own instance
  const { path, instanceId } = def;
  useEffect(() => {
    retainVRMInstance(path, instanceId); // cancel deferred dispose on StrictMode re-setup
    return () => disposeVRMInstance(path, instanceId);
  }, [path, instanceId]);

  // Set frustumCulled=false on every mesh (bind-pose bbox culls when camera is close)
  useEffect(() => {
    if (!vrm) return;
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });
  }, [vrm]);

  // VRM character animator — idle only (no locomotion clips needed)
  const animRef = useRef<VRMCharacterAnimator | null>(null);
  useEffect(() => {
    if (!vrm) return;
    const anim = new VRMCharacterAnimator(vrm, 'milady');
    animRef.current = anim;
    anim.init().catch((e) => console.warn('[CoveVignette] animator init:', e));
    return () => {
      animRef.current = null;
      anim.dispose();
    };
  }, [vrm]);

  // Drive the VRM mixer each frame (isMoving=false → stays in idle)
  useFrame((_, delta) => {
    const anim = animRef.current;
    if (anim) anim.update(Math.min(delta, 0.1), false, false);
  });

  return (
    <group
      position={[def.posX, 0, def.posZ]}
      rotation={[0, def.rotY, 0]}
    >
      <primitive
        object={vrm.scene}
        scale={[vrmScale, vrmScale, vrmScale]}
        position={[0, vrmOffsetY, 0]}
      />
    </group>
  );
}

function VignetteAvatarWrapper({ def }: VignetteAvatarInnerProps) {
  return (
    <Suspense fallback={null}>
      <VignetteAvatarInner def={def} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// CinematicCamera — slow lateral dolly across the gaming floor.
//
// Motion: ping-pong lerp over DOLLY_DURATION seconds.
//   t = 0 → camera at DOLLY_X_START (near slot bank), looking toward tables.
//   t = 1 → camera at DOLLY_X_END (near holdem side), looking toward slot bank.
//
// Camera is positioned at (x, CAM_Y, CAM_Z) and looks at (x, CAM_LOOK_Y, CAM_LOOK_Z)
// where x is the dolly position. This produces a slow pan that naturally reveals
// the full gaming floor without jarring cuts.
// ---------------------------------------------------------------------------
function CinematicCamera() {
  const { camera } = useThree();

  // Seed camera at frame 0 on the left side
  useEffect(() => {
    camera.position.set(DOLLY_X_START, CAM_Y, CAM_Z);
    (camera as THREE.PerspectiveCamera).lookAt(DOLLY_X_START, CAM_LOOK_Y, CAM_LOOK_Z);
  }, [camera]);

  useFrame(({ clock }) => {
    const elapsed = clock.elapsedTime;
    // Ping-pong: 0→1→0 over DOLLY_DURATION each leg
    const cycle  = elapsed / DOLLY_DURATION;
    const ping   = cycle % 2; // 0..1 forward, 1..2 backward
    const t      = ping < 1 ? ping : 2 - ping; // triangle wave 0→1→0

    // Smooth the triangle via cubic ease-in-out for a cinematic feel
    const ease   = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const dollX  = DOLLY_X_START + (DOLLY_X_END - DOLLY_X_START) * ease;

    // Set camera position directly — module-scope scratch, no allocation
    _camPos.set(dollX, CAM_Y, CAM_Z);
    // Very gentle sway: camera floats slightly toward the avatar as we pass it
    // (add a small +Z drift at the midpoint for a natural arc feel)
    const arcZ = CAM_Z + Math.sin(ease * Math.PI) * 80;
    _camPos.z = arcZ;

    // Look-at: as the camera trucks right, it keeps looking at the
    // holdem table area so the avatar is naturally in frame at mid-dolly.
    // The look-at X drifts slower than the camera X for a pan-with-lag feel.
    const lookX = DOLLY_X_START + (DOLLY_X_END - DOLLY_X_START) * (ease * 0.6 + 0.2);
    _camTarget.set(lookX, CAM_LOOK_Y, CAM_LOOK_Z);

    camera.position.copy(_camPos);
    camera.lookAt(_camTarget);
  });

  return null;
}

// ---------------------------------------------------------------------------
// VignetteScene — inner scene (must be inside <Canvas>)
// ---------------------------------------------------------------------------
function VignetteScene() {
  return (
    <>
      {/* Background color matches the cove fog color */}
      <color attach="background" args={[FOG_COLOR]} />

      {/* Cove fog — tuned so the room reads without crushing to black.
          FOG_NEAR=600 lets the foreground read; FOG_FAR=3000 fades the
          back walls softly. */}
      <fog attach="fog" args={[_FOG_COLOR_OBJ, FOG_NEAR, FOG_FAR]} />

      {/* Trimmed neon rig — hemisphere + 2 point lights = 3 total (Iris Xe budget).
          Removed ambientLight and third fill pointLight to stay at max 3 lights. */}
      <hemisphereLight args={[0x4a3a7a, 0x6a4a3a, 2.5]} />
      <pointLight
        position={[-180, 200, 200]}
        color={_CYAN_COLOR}
        intensity={12.0}
        distance={1600}
        decay={1}
        castShadow={false}
      />
      <pointLight
        position={[300, 200, 200]}
        color={_MAGENTA_COLOR}
        intensity={12.0}
        distance={1600}
        decay={1}
        castShadow={false}
      />

      {/* Interior room — ~4.9MB Draco, preloaded at module scope */}
      <Suspense fallback={<CoveRoomFallback />}>
        <CoveRoom />
      </Suspense>

      {/* Four Milady avatars — 2 at blackjack table, 2 at holdem table */}
      {AVATAR_DEFS.map((def) => (
        <VignetteAvatarWrapper key={def.instanceId} def={def} />
      ))}

      {/* Cinematic camera dolly */}
      <CinematicCamera />
    </>
  );
}

// ---------------------------------------------------------------------------
// CoveVignette — public default export
// Consumed via dynamic(() => import('@/components/landing/CoveVignette'), { ssr: false })
// ---------------------------------------------------------------------------
export default function CoveVignette() {
  const { ref, frameloop } = useVisibleFrameloop();

  // Deferred preload — fires on first mount (when the tile's dynamic import
  // resolves). This keeps the Draco parse off the critical hero-paint path.
  useEffect(() => {
    useGLTF.preload(INTERIOR_GLB, undefined, undefined, extendWithDraco);
    _dracoLoader.preload();
  }, []);

  return (
    <div ref={ref} style={{ width: '100%', height: '100%' }}>
      <Canvas
        style={{ width: '100%', height: '100%' }}
        dpr={[1, 1.25]}
        camera={{ fov: 65, near: 1, far: 3000 }}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        frameloop={frameloop}
      >
        <VignetteScene />
      </Canvas>
    </div>
  );
}
