'use client';

/**
 * MiladyAvatarShowcase — self-contained R3F avatar viewer for the landing page hero.
 *
 * Renders one of the 8 Milady VRM avatars with slow Y-spin, subtle bob, and
 * styled lighting optimised for the dark page background (#061520).
 *
 * Click the canvas to cycle to the next avatar (wrap-around).
 *
 * GPU constraints (Iris Xe invariants):
 *   - NO drei Text/Billboard — hard crash
 *   - NO InstancedMesh + ShaderMaterial — silent WebGPU crash
 *   - NO per-frame `new Vector3()` / `new Quaternion()` — zero allocations in useFrame
 *   - frustumCulled=false applied by vrm-loader.ts normaliseVRM — no need to re-apply
 *   - hemisphere + 2 directional lights (no shadows, no point lights)
 *
 * VRM orientation: Milady VRMs are Mixamo-rigged, so rotateVRM0 in normaliseVRM
 * flips them from +Z to face toward +Z again (over-rotates to +Z). Camera at +Z
 * → avatar faces camera. No extra Math.PI rotation needed.
 *
 * Parent usage (drop-in):
 *   const MiladyAvatarShowcase = dynamic(
 *     () => import('@/components/landing/MiladyAvatarShowcase'),
 *     { ssr: false }
 *   );
 *   <div className="w-[280px] h-[360px]">
 *     <MiladyAvatarShowcase />
 *   </div>
 */

import React, { useRef, useState, useEffect, Suspense, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useVRMInstance, disposeVRMInstance, retainVRMInstance } from '@/lib/three/vrm-loader';
import { useVisibleFrameloop } from '@/lib/use-visible-frameloop';
import type { VRM } from '@pixiv/three-vrm';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VRM_PATHS = [
  '/avatars/milady-official-1.vrm',
  '/avatars/milady-official-2.vrm',
  '/avatars/milady-official-3.vrm',
  '/avatars/milady-official-4.vrm',
  '/avatars/milady-official-5.vrm',
  '/avatars/milady-official-6.vrm',
  '/avatars/milady-official-7.vrm',
  '/avatars/milady-official-8.vrm',
] as const;

const INSTANCE_ID = 'showcase';              // stable string — never React.useId()
const SPIN_SPEED  = 0.08;                    // rad/s Y-axis auto-rotate
const BOB_AMP     = 0.04;                   // ±0.04 units vertical bob
const BOB_FREQ    = (2 * Math.PI) / 3;      // one full cycle every 3 s
// Framing offset — keep the bob centered on this Y instead of Y=0 so
// the avatar (1.7u tall × 0.5 scale ≈ 0.85u) sits centered on origin.
const AVATAR_BASE_Y = -0.42;

// Module-scope scene background — one allocation, no per-render new Color()
const SCENE_BG = new THREE.Color(0x061520);

// Module-scope shadow plane — static lifetime = page lifetime (no dispose needed)
const _shadowGeo = new THREE.CircleGeometry(0.45, 32);
const _shadowMat = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
  side: THREE.DoubleSide,
});

// Random starting index — evaluated once at module load.
// `window` check guards against accidental SSR (parent should use ssr:false).
let _startIndex = 0;
if (typeof window !== 'undefined') {
  _startIndex = Math.floor(Math.random() * VRM_PATHS.length);
}

// ---------------------------------------------------------------------------
// VRMAvatarInner — Suspense-throwing inner component (one per active path)
// ---------------------------------------------------------------------------

function VRMAvatarInner({ path }: { path: string }) {
  // useVRMInstance throws a Promise while loading (Suspense protocol).
  // Returns resolved VRM on success. normaliseVRM already ran (frustumCulled=false,
  // rotateVRM0, outlineWidthMode=none, spring-bone stiffness). No extra work needed.
  const vrm: VRM = useVRMInstance(path, INSTANCE_ID);
  const groupRef = useRef<THREE.Group>(null!);

  // Dispose previous instance on path change and on unmount.
  // VRM_BYTES (raw bytes) are retained for fast re-swap; only parsed GPU data freed.
  useEffect(() => {
    retainVRMInstance(path, INSTANCE_ID); // cancel deferred dispose on StrictMode re-setup
    return () => { disposeVRMInstance(path, INSTANCE_ID); };
  }, [path]);

  // useFrame: frame-rate-invariant spin + sine bob AROUND the framing
  // offset. Critical: the previous version set `position.y = bob` which
  // overwrote the JSX `position={[0, -0.55, 0]}` framing offset every
  // frame, so the avatar bobbed around world Y=0 (head clipping the top
  // of the canvas) instead of Y=-0.55 (centered).
  useFrame(({ clock }, delta) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y += SPIN_SPEED * delta;
    groupRef.current.position.y  = AVATAR_BASE_Y + BOB_AMP * Math.sin(clock.getElapsedTime() * BOB_FREQ);
  });

  // Avatar framing: VRMs export ~1.7u tall with feet at Y=0. Scale to
  // 0.5 (≈0.85u tall — slightly more breathing room than 0.65) and
  // offset down so center lands at origin. Robust on every VRM.
  return (
    <group ref={groupRef} position={[0, AVATAR_BASE_Y, 0]} scale={0.5}>
      <primitive object={vrm.scene} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// ShowcaseLighting — hemisphere + 2 directionals, no shadows, no point lights
// ---------------------------------------------------------------------------

function ShowcaseLighting() {
  return (
    <>
      {/* Warm amber sky / dark ocean ground — ambient base */}
      <hemisphereLight args={[0xfff0cc, 0x061828, 0.85]} position={[0, 10, 0]} />
      {/* Warm fill: front-right key, slightly above — brings out face + hair */}
      <directionalLight args={[0xffddaa, 1.5]} position={[3, 5, 6]} castShadow={false} />
      {/* Cyan rim: back-left — gives 3D pop on dark background */}
      <directionalLight args={[0x00e5ff, 0.75]} position={[-4, 2, -5]} castShadow={false} />
    </>
  );
}

// ---------------------------------------------------------------------------
// MiladyAvatarShowcase — exported default
// ---------------------------------------------------------------------------

export default function MiladyAvatarShowcase() {
  const [index, setIndex] = useState(_startIndex);
  const path = VRM_PATHS[index % VRM_PATHS.length];

  // Pause the canvas frameloop when the showcase scrolls offscreen —
  // big perf win, the GPU goes idle when you're past the hero.
  const { ref, frameloop } = useVisibleFrameloop();

  const handleClick = useCallback(() => {
    setIndex((i) => (i + 1) % VRM_PATHS.length);
  }, []);

  return (
    <div
      ref={ref}
      style={{ width: '100%', height: '100%', cursor: 'pointer' }}
      onClick={handleClick}
      title="Click to see next avatar"
    >
      <Canvas
        style={{ width: '100%', height: '100%' }}
        camera={{ position: [0, 0, 2.4], fov: 38, near: 0.1, far: 40 }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        scene={{ background: SCENE_BG }}
        dpr={[1, 1.25]}
        frameloop={frameloop}
      >
        <ShowcaseLighting />

        {/* Soft shadow disc at avatar foot level (matches AVATAR_BASE_Y). */}
        <mesh
          geometry={_shadowGeo}
          material={_shadowMat}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, AVATAR_BASE_Y, 0]}
          scale={0.55}
        />

        {/* Suspense boundary: only the avatar remounts on swap, not the whole Canvas */}
        <Suspense fallback={null}>
          {/*
           * key={path} forces React to unmount the old VRMAvatarInner (triggering
           * disposeVRMInstance in its useEffect cleanup) and mount a fresh one for
           * the new path. Without key, the same component instance would receive a
           * new path prop and the useEffect cleanup would fire on next render cycle
           * only — potentially leaving a frame gap where both VRMs are alive.
           */}
          <VRMAvatarInner key={path} path={path} />
        </Suspense>
      </Canvas>
    </div>
  );
}
