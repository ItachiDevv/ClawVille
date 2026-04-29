'use client';

/**
 * BuildingVisitVignette.tsx
 *
 * Looping landing-page vignette: a Milady character walks toward the Pineapple
 * House while the camera slowly orbits. Fills its parent container.
 *
 * Loop period: 10 s — walk cycle and orbit are locked to the same period for a
 * seamless, gapless loop.
 *
 * Constraints honored:
 *  - NO drei Text / Billboard (Iris Xe hard crash)
 *  - NO InstancedMesh + ShaderMaterial (silent WebGPU crash)
 *  - NO new Vector3/Quaternion inside useFrame (GC thrash)
 *  - Lights: HemisphereLight + 1 DirectionalLight (Iris Xe budget)
 *  - frustumCulled=false on all VRM nodes (bind-pose cull gotcha)
 *  - VRM facing: rotation.y = atan2(vx, vz) — verified ClawVille convention
 *  - Pixel ratio capped at [1, 1.5]
 *  - Geometry + mixer + VRM instance disposed on unmount
 *
 * VRM walk direction:
 *  After normaliseVRM / rotateVRM0 the VRM faces +Z at rotation.y = 0.
 *  Character walks toward building (−Z), so rotation.y = π = atan2(0, −1). ✓
 */

import { Suspense, useRef, useMemo, useEffect, memo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import {
  useVRMInstance,
  disposeVRMInstance,
  preloadVRMBytes,
} from '@/lib/three/vrm-loader';
import { retargetMixamoClip } from '@/lib/three/mixamo-retarget';
import type { VRM } from '@pixiv/three-vrm';

// ---------------------------------------------------------------------------
// Asset paths
// ---------------------------------------------------------------------------
const VRM_PATH  = '/avatars/milady-official-3.vrm';
const VRM_ID    = 'building-visit-vignette';
const WALK_PATH = '/avatars/animations/walk.glb';
const BLDG_PATH = '/models/pineapple-house.glb';

// ---------------------------------------------------------------------------
// Scene constants
// ---------------------------------------------------------------------------
const LOOP_S       = 10;    // seconds per full loop
const WALK_START_Z =  4;    // wu — character starts here (in front of door)
const WALK_END_Z   =  0.4;  // wu — stop just at the door threshold
const BLDG_H       =  3.2;  // world-unit target height for building
const ORBIT_R      =  7;    // orbit radius
const ORBIT_CAM_Y  =  2.5;  // camera height above ground
const LOOK_Y       =  1.5;  // orbit look-at Y

// ---------------------------------------------------------------------------
// Module-scope scratch — NEVER allocate inside useFrame
// ---------------------------------------------------------------------------
const _box    = new THREE.Box3();
const _size   = new THREE.Vector3();
const _center = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Preloads — fire-and-forget at module eval time (client-only via dynamic import)
// ---------------------------------------------------------------------------
preloadVRMBytes(VRM_PATH);
useGLTF.preload(BLDG_PATH);
useGLTF.preload(WALK_PATH);

// ---------------------------------------------------------------------------
// Building component
// ---------------------------------------------------------------------------
const BuildingMesh = memo(function BuildingMesh() {
  const { scene: src } = useGLTF(BLDG_PATH);

  // Normalise scale and compute centering offset once per src reference.
  // Return plain JS values so JSX position prop is always fresh/deterministic
  // rather than reading shared module-scope scratch after the fact.
  const { group, scale, px, py, pz } = useMemo(() => {
    const g = src.clone(true);

    // Measure only non-skinned meshes — avoids SkinnedMesh bind-pose bbox inflation
    _box.makeEmpty();
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m as unknown as THREE.SkinnedMesh).isSkinnedMesh) {
        _box.expandByObject(o);
      }
    });
    _box.getSize(_size);
    _box.getCenter(_center);

    // Normalise by height (not maxDim — see gotcha building-normalization-use-height)
    const h  = _size.y > 0.001 ? _size.y : 1;
    const sc = BLDG_H / h;

    // Position offsets: centre XZ, ground the base at Y=0
    const posX = -_center.x * sc;
    const posY = -(_box.min.y < Infinity ? _box.min.y : 0) * sc;
    const posZ = -_center.z * sc;

    g.traverse((o) => { o.frustumCulled = false; });

    return { group: g, scale: sc, px: posX, py: posY, pz: posZ };
  }, [src]);

  return (
    <primitive
      object={group}
      scale={scale}
      position={[px, py, pz]}
    />
  );
});

// ---------------------------------------------------------------------------
// Milady walker — inner Suspense leaf (throws Promise until VRM resolves)
// ---------------------------------------------------------------------------
const WalkerInner = memo(function WalkerInner() {
  const vrm: VRM         = useVRMInstance(VRM_PATH, VRM_ID);
  const { scene: walkScene, animations } = useGLTF(WALK_PATH);

  const groupRef = useRef<THREE.Group>(null);

  // Build mixer + retargeted walk action once.
  const mixer = useMemo(() => {
    const mx = new THREE.AnimationMixer(vrm.scene);
    const src = animations[0];
    if (!src) return mx;

    let clip: THREE.AnimationClip = src;
    try {
      // Pass the real walk.glb scene so retargetMixamoClip can look up Mixamo
      // bone rest-pose nodes (findNode → getObjectByName).
      clip = retargetMixamoClip({ scene: walkScene, animations: [src] }, vrm, 'walk');
    } catch {
      // Fallback: raw clip — VRM may T-pose but at least something plays.
    }

    const action = mx.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    return mx;
  }, [vrm, walkScene, animations]);

  // Dispose mixer + VRM instance on unmount
  useEffect(() => {
    return () => {
      mixer.stopAllAction();
      disposeVRMInstance(VRM_PATH, VRM_ID);
    };
  }, [mixer]);

  // R3F passes (state, delta) to useFrame — use the delta arg, NOT clock.getDelta()
  // (R3F already calls getDelta() internally; a second call returns ~0).
  useFrame((_state, delta) => {
    const g = groupRef.current;
    if (!g) return;

    const elapsed = _state.clock.getElapsedTime();

    // Walk: linear interpolation from WALK_START_Z → WALK_END_Z over LOOP_S, looping
    const t = (elapsed % LOOP_S) / LOOP_S;
    g.position.z = WALK_START_Z + t * (WALK_END_Z - WALK_START_Z);
    g.position.x = 0;
    g.position.y = 0;
    // Face −Z (toward building). atan2(0, −1) = π — verified VRM convention.
    g.rotation.y = Math.PI;

    mixer.update(delta);
    vrm.update?.(delta);
  });

  return (
    <group ref={groupRef}>
      <primitive object={vrm.scene} />
    </group>
  );
});

// ---------------------------------------------------------------------------
// Scene graph
// ---------------------------------------------------------------------------
function VignetteScene() {
  return (
    <>
      {/* Exponential underwater fog — matches site colour #0a3a55 */}
      <fogExp2 args={['#0a3a55', 0.038]} />

      {/* Lighting — hemisphere sky/ground + 1 directional (Iris Xe: stay under 7) */}
      <hemisphereLight args={['#1a9ab0', '#0a3a55', 0.85]} />
      <directionalLight position={[4, 8, 3]} intensity={1.1} color="#b8eef8" />

      {/* Sandy floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[30, 30]} />
        <meshStandardMaterial color="#c2a875" roughness={0.95} metalness={0} />
      </mesh>

      {/* Pineapple House */}
      <Suspense fallback={null}>
        <BuildingMesh />
      </Suspense>

      {/* Milady walker — null fallback so landing page renders immediately */}
      <Suspense fallback={null}>
        <WalkerInner />
      </Suspense>

      {/* Orbit — 10 s / revolution; no user interaction (all controls disabled) */}
      <OrbitControls
        target={[0, LOOK_Y, 0]}
        autoRotate
        autoRotateSpeed={6}
        enableRotate={false}
        enableZoom={false}
        enablePan={false}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Root export — thin Canvas wrapper
// ---------------------------------------------------------------------------
export default function BuildingVisitVignette() {
  return (
    <Canvas
      style={{ width: '100%', height: '100%' }}
      dpr={[1, 1.5]}
      camera={{
        position: [ORBIT_R, ORBIT_CAM_Y, 0],
        fov: 45,
        near: 0.1,
        far: 60,
      }}
      gl={{ antialias: false }}
    >
      <VignetteScene />
    </Canvas>
  );
}
