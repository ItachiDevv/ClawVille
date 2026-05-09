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
import { useVRMInstance, disposeVRMInstance } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator } from '@/lib/three/vrm-character-animator';

const SCENE_BG = new THREE.Color(0x0d2b5e); // matches game fog
// Hermes-Female export has its mesh CENTERED at origin (Blender export
// didn't translate feet-to-z=0). After scale=13 the avatar spans y=-6.5..+6.5.
// Until we fix the export, offset the scene up so feet land at y=0.
const AVATAR_SCALE = 13;
const FEET_OFFSET_Y = 6.5; // half avatar height after scale=13

type Character = 'female' | 'male';

function HermesAvatar({ character, idle }: { character: Character; idle: boolean }) {
  const path = `/avatars/hermes-${character}.vrm`;
  const vrm = useVRMInstance(path, `preview-${character}`);
  const animatorRef = useRef<VRMCharacterAnimator | null>(null);

  // Set up animator + cleanup on character switch / unmount
  useEffect(() => {
    if (!vrm) return;

    // Memory rule: every cloned SkinnedMesh in a VRM scene needs frustumCulled=false
    // (otherwise close-range traversal can cull the avatar mid-pose).
    vrm.scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        (o as THREE.SkinnedMesh).frustumCulled = false;
      }
    });

    // ---- DEBUG: expose VRM + scene measurements so we can probe via DevTools.
    // Compute the world bbox of vrm.scene at this moment so we know if it's
    // visible from the camera or wildly off-position / wrong scale.
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const meshSummary: Array<{ name: string; verts: number; mat: string; visible: boolean; opacity: number }> = [];
    vrm.scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh || (o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material & { opacity?: number };
        meshSummary.push({
          name: m.name || m.type,
          verts: m.geometry.attributes.position?.count ?? 0,
          mat: mat?.type ?? 'none',
          visible: m.visible,
          opacity: (mat as { opacity?: number })?.opacity ?? 1,
        });
      }
    });
    (window as unknown as { __hermes: unknown }).__hermes = {
      vrm,
      scene: vrm.scene,
      bboxMin: box.min.toArray(),
      bboxMax: box.max.toArray(),
      bboxSize: size.toArray(),
      bboxCenter: center.toArray(),
      sceneScale: vrm.scene.scale.toArray(),
      scenePos: vrm.scene.position.toArray(),
      meshes: meshSummary,
    };
    console.log('[hermes preview] VRM mounted', (window as unknown as { __hermes: { bboxSize: number[]; bboxCenter: number[]; meshes: unknown[] } }).__hermes);

    const animator = new VRMCharacterAnimator(vrm);
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

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    animatorRef.current?.update(dt, idle);
  });

  if (!vrm) return null;
  // Avatar exported facing +X. Rotate -90° around Y so it faces +Z (toward
  // a camera positioned at +Z). Permanent fix should bake this into the
  // Blender export (apply armature rotation before VRM export).
  return (
    <primitive
      object={vrm.scene}
      scale={AVATAR_SCALE}
      position={[0, FEET_OFFSET_Y, 0]}
      rotation={[0, -Math.PI / 2, 0]}
    />
  );
}

function HermesScene({ character, idle }: { character: Character; idle: boolean }) {
  const ambient = useMemo(() => 0.5, []);
  return (
    <>
      <hemisphereLight args={[0xffffff, 0x223355, ambient]} />
      <directionalLight position={[10, 30, 10]} intensity={1.2} castShadow={false} />
      <gridHelper args={[40, 20, 0x224466, 0x163355]} position={[0, 0, 0]} />
      <Suspense fallback={null}>
        <HermesAvatar character={character} idle={idle} />
      </Suspense>
    </>
  );
}

export default function PreviewHermesPage() {
  // Next.js 16 requires useSearchParams() to be inside a Suspense boundary.
  // Wrap the inner component (which calls the hook) so the build's prerender
  // check passes; force-dynamic alone is not enough.
  return (
    <Suspense fallback={null}>
      <PreviewHermesInner />
    </Suspense>
  );
}

function PreviewHermesInner() {
  const searchParams = useSearchParams();
  const initial = (searchParams.get('c') === 'male' ? 'male' : 'female') as Character;
  const [character, setCharacter] = useState<Character>(initial);
  const [idle, setIdle] = useState(true);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0d2b5e' }}>
      <Canvas
        camera={{ position: [0, 8, 25], fov: 35 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        scene={{ background: SCENE_BG }}
      >
        <HermesScene character={character} idle={idle} />
        <OrbitControls target={[0, 7, 0]} enablePan={true} maxDistance={80} minDistance={5} />
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
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setIdle(true)}  style={btn(idle)}>Idle</button>
          <button onClick={() => setIdle(false)} style={btn(!idle)}>Walk</button>
        </div>
        <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
          drag to rotate · scroll to zoom · /avatars/hermes-{character}.vrm
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
