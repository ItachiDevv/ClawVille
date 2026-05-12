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

const SCENE_BG = new THREE.Color(0xffffff); // white backdrop for video capture
// Target visual height — camera at y=8 looking at y=7 frames a 6.5u-tall avatar.
const TARGET_HEIGHT = 6.5;

// RGB speed-line rainbow used during Run / Fly modes.
const SPEEDLINE_COLORS = [
  '#ff2040', '#ff8000', '#ffd000', '#40e040',
  '#00d0ff', '#3060ff', '#a040ff', '#ff20c0',
];


type Character = 'female' | 'male';
type Mode = 'idle' | 'walk' | 'run' | 'swim' | 'fly';

function HermesAvatar({ character, mode }: { character: Character; mode: Mode }) {
  const path = `/avatars/hermes-${character}.vrm`;
  const vrm = useVRMInstance(path, `preview-${character}`);
  const animatorRef = useRef<VRMCharacterAnimator | null>(null);
  const [fit, setFit] = useState<{ scale: number; offsetY: number } | null>(null);

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

    // Auto-fit: measure natural bbox (scale=1) and compute the scale that
    // makes the avatar TARGET_HEIGHT tall with feet on y=0. Works for any
    // exporter (Mixamo cm, Tripo m, etc.) so the preview survives re-rigs.
    vrm.scene.scale.setScalar(1);
    vrm.scene.position.set(0, 0, 0);
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const autoScale = size.y > 0 ? TARGET_HEIGHT / size.y : 1;
    const autoOffsetY = -box.min.y * autoScale;
    setFit({ scale: autoScale, offsetY: autoOffsetY });
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
      autoScale,
      autoOffsetY,
      sceneScale: vrm.scene.scale.toArray(),
      scenePos: vrm.scene.position.toArray(),
      meshes: meshSummary,
    };
    console.log('[hermes preview] VRM mounted', (window as unknown as { __hermes: { bboxSize: number[]; bboxCenter: number[]; meshes: unknown[] } }).__hermes);

    const animator = new VRMCharacterAnimator(vrm, `hermes-${character}`);
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
      mode === 'run' ? 'run' :
      mode === 'swim' ? 'swimming' :
      mode === 'fly' ? 'flying' :
      'idle';
    a.setSurfaceClip(surface);
  }, [mode]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    animatorRef.current?.update(dt, mode === 'walk');
  });

  if (!vrm || !fit) return null;
  // Avatar exported facing +X. Rotate -90° around Y so it faces +Z (toward
  // a camera positioned at +Z). Permanent fix should bake this into the
  // Blender export (apply armature rotation before VRM export).
  return (
    <primitive
      object={vrm.scene}
      scale={fit.scale}
      position={[0, fit.offsetY, 0]}
      rotation={[0, -Math.PI / 2, 0]}
    />
  );
}

// 3D hyperspace-style speed streaks. Each streak is a thin box elongated
// along Z that flies from far behind the character toward the camera, giving
// proper perspective + depth instead of flat 2D bars.
const STREAK_COUNT = 60;
const STREAK_Z_FAR = -60;     // spawn depth
const STREAK_Z_RESET = 22;    // when past this, wrap back to FAR
const STREAK_LENGTH = 3.5;    // along local Z

interface Streak {
  x: number;
  y: number;
  z: number;       // current depth, updated per frame
  speed: number;   // u/sec toward +Z (toward camera)
  color: string;
  scaleZ: number;  // some streaks are longer for variety
}

function SpeedLines({ active }: { active: boolean }) {
  // Generate one stable streak field for the lifetime of the component.
  // Position/speed/color all randomized once so each line has its own
  // parallax depth and won't snap on toggle.
  const streaks = useMemo<Streak[]>(() => {
    const rng = (seed: number) => {
      // Tiny deterministic PRNG so HMR keeps the same field across reloads
      let s = seed;
      return () => {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
      };
    };
    const r = rng(1337);
    return Array.from({ length: STREAK_COUNT }, (_, i) => ({
      x: (r() - 0.5) * 26,                    // -13 .. +13
      y: r() * 13 + 0.5,                      // 0.5 .. 13.5
      z: STREAK_Z_FAR + r() * (STREAK_Z_RESET - STREAK_Z_FAR),
      speed: 26 + r() * 28,                   // 26 .. 54 u/s
      color: SPEEDLINE_COLORS[i % SPEEDLINE_COLORS.length]!,
      scaleZ: 0.7 + r() * 1.8,                // 0.7 .. 2.5x length
    }));
  }, []);

  const refs = useRef<(THREE.Mesh | null)[]>([]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    for (let i = 0; i < streaks.length; i++) {
      const m = refs.current[i];
      const s = streaks[i]!;
      if (!m) continue;
      s.z += s.speed * dt;
      if (s.z > STREAK_Z_RESET) {
        // Wrap: respawn far behind with a NEW lateral position so the field
        // doesn't show a repeating pattern.
        s.z = STREAK_Z_FAR;
        s.x = (Math.random() - 0.5) * 26;
        s.y = Math.random() * 13 + 0.5;
      }
      m.position.set(s.x, s.y, s.z);
    }
  });

  return (
    <group visible={active}>
      {streaks.map((s, i) => (
        <mesh
          key={i}
          ref={(m) => { refs.current[i] = m; }}
          position={[s.x, s.y, s.z]}
          scale={[1, 1, s.scaleZ]}
        >
          {/* Thin elongated box: width 0.08, height 0.08, length STREAK_LENGTH along Z */}
          <boxGeometry args={[0.09, 0.09, STREAK_LENGTH]} />
          <meshBasicMaterial color={s.color} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function HermesScene({ character, mode }: { character: Character; mode: Mode }) {
  const ambient = useMemo(() => 0.7, []);
  const speedlinesActive = mode === 'run' || mode === 'fly';
  return (
    <>
      <hemisphereLight args={[0xffffff, 0xccccff, ambient]} />
      <directionalLight position={[10, 30, 10]} intensity={1.0} castShadow={false} />
      <SpeedLines active={speedlinesActive} />
      <Suspense fallback={null}>
        <HermesAvatar character={character} mode={mode} />
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
  const [mode, setMode] = useState<Mode>('idle');

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#ffffff' }}>
      <Canvas
        camera={{ position: [0, 8, 25], fov: 35 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        scene={{ background: SCENE_BG }}
      >
        <HermesScene character={character} mode={mode} />
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
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button onClick={() => setMode('idle')} style={btn(mode === 'idle')}>Idle</button>
          <button onClick={() => setMode('walk')} style={btn(mode === 'walk')}>Walk</button>
          <button onClick={() => setMode('run')}  style={btn(mode === 'run')}>Run</button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setMode('swim')} style={btn(mode === 'swim')}>Swim</button>
          {character === 'male' && (
            <button onClick={() => setMode('fly')} style={btn(mode === 'fly')}>Fly</button>
          )}
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
