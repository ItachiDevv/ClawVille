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
import type { VRM } from '@pixiv/three-vrm';
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

function HermesAvatar({ character, mode, vrmRef }: { character: Character; mode: Mode; vrmRef: React.MutableRefObject<VRM | null> }) {
  const path = `/avatars/hermes-${character}.vrm`;
  const vrm = useVRMInstance(path, `preview-${character}`);
  const animatorRef = useRef<VRMCharacterAnimator | null>(null);
  const [fit, setFit] = useState<{ scale: number; offsetY: number } | null>(null);

  // Share VRM upward so sibling components (SpeedLines) can read bone world
  // positions in their useFrame without re-running the loader hook.
  useEffect(() => {
    vrmRef.current = vrm ?? null;
    return () => { vrmRef.current = null; };
  }, [vrm, vrmRef]);

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

// Ribbon trails per emitter bone — fighter-game sword-trail style. Each
// emitter maintains a ring buffer of the last TRAIL_HISTORY_LEN positions
// of its anchor bone (in world space). Each frame we shift the buffer,
// push the bone's new world position to slot 0, then rebuild a smooth
// TubeGeometry along a Catmull-Rom curve through those points. The trail
// is physically attached to the bone — wherever Tekk's hand swings or his
// wing tip arcs, the ribbon follows.
const EMITTERS: Array<{ bone: string; offset: THREE.Vector3; color: string; radius: number }> = [
  { bone: 'leftHand',      offset: new THREE.Vector3( 0,    0,    0), color: '#ff2040', radius: 0.07 },
  { bone: 'rightHand',     offset: new THREE.Vector3( 0,    0,    0), color: '#00d0ff', radius: 0.07 },
  { bone: 'leftFoot',      offset: new THREE.Vector3( 0,   -0.04, 0), color: '#ffd000', radius: 0.07 },
  { bone: 'rightFoot',     offset: new THREE.Vector3( 0,   -0.04, 0), color: '#a040ff', radius: 0.07 },
  { bone: 'leftShoulder',  offset: new THREE.Vector3( 0.4,  0.2, -0.3), color: '#40e040', radius: 0.09 },
  { bone: 'rightShoulder', offset: new THREE.Vector3(-0.4,  0.2, -0.3), color: '#ff8000', radius: 0.09 },
];
const TRAIL_HISTORY_LEN = 18;     // recent positions tracked per bone
const TRAIL_TUBE_SEGMENTS = 32;   // smoothness along the trail
const TRAIL_RADIAL = 5;           // tube cross-section faces

interface Trail {
  bone: string;
  offset: THREE.Vector3;
  color: THREE.Color;
  radius: number;
  history: THREE.Vector3[];
  seeded: boolean;                // false until the first frame seeds the buffer
}

function SpeedLines({ active, vrmRef }: { active: boolean; vrmRef: React.MutableRefObject<VRM | null> }) {
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);

  const trails = useMemo<Trail[]>(() =>
    EMITTERS.map((e) => ({
      bone: e.bone,
      offset: e.offset,
      color: new THREE.Color(e.color),
      radius: e.radius,
      history: Array.from({ length: TRAIL_HISTORY_LEN }, () => new THREE.Vector3()),
      seeded: false,
    })), []);

  // When toggling active off → on we want to reset the trail seed so
  // the ribbons start from the bone's current location instead of
  // snapping along a stale buffer.
  useEffect(() => {
    if (!active) {
      for (const t of trails) t.seeded = false;
    }
  }, [active, trails]);

  const scratch = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    if (!active) return;
    const vrm = vrmRef.current;
    if (!vrm || !vrm.humanoid) return;

    for (let i = 0; i < trails.length; i++) {
      const trail = trails[i]!;
      const mesh = meshRefs.current[i];
      if (!mesh) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const boneNode = (vrm.humanoid as any).getNormalizedBoneNode?.(trail.bone) as THREE.Object3D | null;
      if (!boneNode) continue;
      scratch.copy(trail.offset).applyMatrix4(boneNode.matrixWorld);

      if (!trail.seeded) {
        // Seed every slot with the current position so the first frame's
        // curve is degenerate (zero-length tube) instead of a wild arc.
        for (let j = 0; j < trail.history.length; j++) trail.history[j].copy(scratch);
        trail.seeded = true;
      } else {
        // Shift back: history[N-1] takes history[N-2], etc., then write
        // current position into slot 0. The Vector3 instances are reused
        // (no allocation) so we copy values rather than reassigning refs.
        for (let j = trail.history.length - 1; j > 0; j--) {
          trail.history[j].copy(trail.history[j - 1]!);
        }
        trail.history[0]!.copy(scratch);
      }

      // Rebuild tube along a smooth curve through the history. Catmull-Rom
      // tension 0.5 keeps the curve from overshooting on sharp arcs (like
      // a wing flap reversing direction).
      const curve = new THREE.CatmullRomCurve3(trail.history, false, 'catmullrom', 0.5);
      const newGeom = new THREE.TubeGeometry(curve, TRAIL_TUBE_SEGMENTS, trail.radius, TRAIL_RADIAL, false);
      mesh.geometry.dispose();
      mesh.geometry = newGeom;
    }
  });

  return (
    <group visible={active}>
      {trails.map((t, i) => (
        <mesh key={i} ref={(m) => { meshRefs.current[i] = m; }}>
          {/* Geometry replaced every frame in useFrame */}
          <bufferGeometry />
          <meshBasicMaterial
            color={t.color}
            toneMapped={false}
            transparent
            opacity={0.92}
          />
        </mesh>
      ))}
    </group>
  );
}

function HermesScene({ character, mode }: { character: Character; mode: Mode }) {
  const ambient = useMemo(() => 0.7, []);
  const speedlinesActive = mode === 'run' || mode === 'fly';
  // Shared VRM ref so SpeedLines can read bone world positions each frame
  // without redoing the loader hook (cheap pointer share).
  const vrmRef = useRef<VRM | null>(null);
  return (
    <>
      <hemisphereLight args={[0xffffff, 0xccccff, ambient]} />
      <directionalLight position={[10, 30, 10]} intensity={1.0} castShadow={false} />
      <SpeedLines active={speedlinesActive} vrmRef={vrmRef} />
      <Suspense fallback={null}>
        <HermesAvatar character={character} mode={mode} vrmRef={vrmRef} />
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
