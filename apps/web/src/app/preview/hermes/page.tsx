// @ts-nocheck — preview route crosses dual @types/three versions (0.170 from
// VRM, 0.182 from main three). Every Three.js value hits the version
// boundary, making per-line casts untractable. Runtime is unaffected; this
// is a dev preview route only.
'use client';

// Three.js requires browser-only WebGL canvas. Force dynamic so the build
// doesn't try to prerender this page (matches /preview/avatar).
export const dynamic = 'force-dynamic';

/**
 * /preview/hermes — VRM validation page (dev-only, unadvertised).
 *
 * Loads apps/web/public/avatars/hermes-{character}.vrm via the project's
 * useVRMInstance + VRMCharacterAnimator stack so we verify the file works
 * against the real loader (not a generic external viewer).
 *
 * URL: /preview/hermes?c=female | male
 *
 * Iris Xe rules enforced:
 *   - No drei <Text> / <Billboard>
 *   - No InstancedMesh + ShaderMaterial
 *   - Plain WebGLRenderer (Canvas default), no three/webgpu
 *   - 1 hemisphere + 1 directional light, no shadows
 *   - frustumCulled=false on every SkinnedMesh in vrm.scene
 *   - MeshoptDecoder is wired by the existing meshopt-loader-setup
 */

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useVRMInstance, disposeVRMInstance, retainVRMInstance } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator } from '@/lib/three/vrm-character-animator';

const SCENE_BG = new THREE.Color(0xffffff); // white backdrop for video capture
// Target visual height — camera at y=8 looking at y=7 frames a 6.5u-tall avatar.
const TARGET_HEIGHT = 6.5;

type Character = 'female' | 'male' | 'tekk' | 'biggie';
type Mode = 'idle' | 'walk' | 'run' | 'swim' | 'fly' | 'pray';

// VRM URL + animator characterId per selectable character. Tekk is a
// stand-alone character (not hermes-*) so his override map key + file path
// differ from the hermes-female / hermes-male pattern.
const CHARACTER_META: Record<Character, { path: string; animatorId: string }> = {
  // ?v=2 — perf round 2 decimation bust 2026-06-13 (match the registry url so
  // the dev page shares the same cache entry as /game instead of fetching a 2nd).
  female: { path: '/avatars/hermes-female.vrm?v=2', animatorId: 'hermes-female' },
  male:   { path: '/avatars/hermes-male.vrm?v=2',   animatorId: 'hermes-male' },
  tekk:   { path: '/avatars/tekk.vrm?v=2',          animatorId: 'tekk' },
  // Biggie — bespoke Meshy VRM exclusive avatar (2026-07-23); dedicated animatorId
  // with idle/walk/run position tracks stripped (adinero-pattern underground guard).
  // ?v=2 — arms-rest-pose T-pose fix (fix-rig-tpose.mjs) re-baked the same path.
  biggie: { path: '/avatars/biggie.vrm?v=2',        animatorId: 'biggie' },
};

function HermesAvatar({ character, mode }: { character: Character; mode: Mode }) {
  const { path, animatorId } = CHARACTER_META[character];
  const vrm = useVRMInstance(path, `preview-${character}`);
  const animatorRef = useRef<VRMCharacterAnimator | null>(null);
  const [fit, setFit] = useState<{ scale: number; offsetY: number } | null>(null);

  useEffect(() => {
    if (!vrm) return;
    retainVRMInstance(path, `preview-${character}`); // cancel deferred dispose on StrictMode re-setup

    // Memory rule: every cloned SkinnedMesh in a VRM scene needs frustumCulled=false
    // (otherwise close-range traversal can cull the avatar mid-pose).
    vrm.scene.traverse((o) => {
      const sm = o as unknown as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) {
        sm.frustumCulled = false;
      }
    });

    // Auto-fit: measure natural bbox (scale=1) and compute the scale that
    // makes the avatar TARGET_HEIGHT tall with feet on y=0. Works for any
    // exporter (Mixamo cm, Tripo m, etc.) so the preview survives re-rigs.
    vrm.scene.scale.setScalar(1);
    vrm.scene.position.set(0, 0, 0);
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene as unknown as THREE.Object3D);
    const size = new THREE.Vector3();
    box.getSize(size);
    const autoScale = size.y > 0 ? TARGET_HEIGHT / size.y : 1;
    const autoOffsetY = -box.min.y * autoScale;
    setFit({ scale: autoScale, offsetY: autoOffsetY });

    const animator = new VRMCharacterAnimator(vrm, animatorId);
    animatorRef.current = animator;
    animator.init().catch((err) => {
      console.warn('[hermes preview] animator init failed:', err);
    });
    return () => {
      animatorRef.current = null;
      animator.dispose();
      disposeVRMInstance(path, `preview-${character}`);
    };
  }, [vrm, character, path]);

  // Reflect mode changes onto the animator each frame:
  //   - 'idle' → surfaceClip='idle', isMoving=false → plays idle
  //   - 'walk' → surfaceClip='idle', isMoving=true  → plays walk
  //   - 'run'  → surfaceClip='run',  isMoving=false → plays run on loop
  //   - 'swim' → surfaceClip='swimming', isMoving=false → plays swim on loop
  //   - 'fly'  → surfaceClip='flying',   isMoving=false → plays fly on loop
  //              (only meaningful for Tekk — Hermes-female has no flying clip)
  useEffect(() => {
    const a = animatorRef.current;
    if (!a) return;
    const surface =
      mode === 'run'  ? 'run' :
      mode === 'swim' ? 'swimming' :
      mode === 'fly'  ? 'flying' :
      mode === 'pray' ? 'praying' :
      'idle';
    a.setSurfaceClip(surface);
  }, [mode]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    animatorRef.current?.update(dt, mode === 'walk');
  });

  if (!vrm || !fit) return null;
  return (
    <primitive
      object={vrm.scene}
      scale={fit.scale}
      position={[0, fit.offsetY, 0]}
      rotation={[0, -Math.PI / 2, 0]}
    />
  );
}

function HermesScene({ character, mode }: { character: Character; mode: Mode }) {
  const ambient = useMemo(() => 0.7, []);
  return (
    <>
      <hemisphereLight args={[0xffffff, 0xccccff, ambient]} />
      <directionalLight position={[10, 30, 10]} intensity={1.0} castShadow={false} />
      <Suspense fallback={null}>
        <HermesAvatar character={character} mode={mode} />
      </Suspense>
    </>
  );
}

export default function PreviewHermesPage() {
  // Next.js 16 requires useSearchParams() to be inside a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <PreviewHermesInner />
    </Suspense>
  );
}

function PreviewHermesInner() {
  const searchParams = useSearchParams();
  const c = searchParams.get('c');
  const initial: Character =
    c === 'male' ? 'male' :
    c === 'tekk' ? 'tekk' :
    c === 'biggie' ? 'biggie' :
    'female';
  const [character, setCharacter] = useState<Character>(initial);
  const [mode, setMode] = useState<Mode>('idle');
  // ?az=<degrees> — initial camera azimuth for scripted QC screenshots (0 = +Z).
  const az = ((Number(searchParams.get('az')) || 0) * Math.PI) / 180;
  // Frame the avatar's torso (TARGET_HEIGHT=6.5 → mid-body ≈ 3.2), camera level
  // with it, so OrbitControls zoom converges on the BODY, not empty air above
  // the head (old target y=7 pushed the model to the bottom half when zooming).
  const camPos: [number, number, number] = [Math.sin(az) * 16, 4.2, Math.cos(az) * 16];

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#ffffff' }}>
      <Canvas
        camera={{ position: camPos, fov: 35 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        scene={{ background: SCENE_BG }}
      >
        <HermesScene character={character} mode={mode} />
        <OrbitControls target={[0, 3.2, 0]} enablePan={true} maxDistance={80} minDistance={1.5} />
      </Canvas>

      <div style={{
        position: 'absolute', top: 12, left: 12, padding: 12,
        background: 'rgba(0,0,0,0.65)', color: '#fff',
        font: '14px system-ui', borderRadius: 8, minWidth: 200,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Hermes VRM Preview</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button onClick={() => setCharacter('female')}
            style={btn(character === 'female')}>Female</button>
          <button onClick={() => setCharacter('male')}
            style={btn(character === 'male')}>Male</button>
          <button onClick={() => setCharacter('tekk')}
            style={btn(character === 'tekk')}>Tekk</button>
          <button onClick={() => setCharacter('biggie')}
            style={btn(character === 'biggie')}>Biggie</button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button onClick={() => setMode('idle')} style={btn(mode === 'idle')}>Idle</button>
          <button onClick={() => setMode('walk')} style={btn(mode === 'walk')}>Walk</button>
          <button onClick={() => setMode('run')}  style={btn(mode === 'run')}>Run</button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setMode('swim')} style={btn(mode === 'swim')}>Swim</button>
          {character === 'tekk' && (
            <button onClick={() => setMode('fly')} style={btn(mode === 'fly')}>Fly</button>
          )}
          {character === 'female' && (
            <button onClick={() => setMode('pray')} style={btn(mode === 'pray')}>Pray</button>
          )}
        </div>
        <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
          drag to rotate · scroll to zoom · {CHARACTER_META[character].path}
        </div>
      </div>
    </div>
  );
}

function btn(active: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    background: active ? '#3b82f6' : '#1f2937',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    flex: 1,
  };
}
