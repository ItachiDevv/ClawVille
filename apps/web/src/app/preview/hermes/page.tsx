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

// Particle-emitter speed streaks. Each emitter is anchored to a VRM bone
// (hands, feet, plus offset positions near the shoulders to approximate wing
// tips). Particles spawn AT the emitter, then drift outward with their own
// velocity for `PARTICLE_LIFETIME` seconds, then respawn at the bone again.
const EMITTERS: Array<{ bone: string; offset: THREE.Vector3 }> = [
  { bone: 'leftHand',     offset: new THREE.Vector3( 0,    0, 0) },
  { bone: 'rightHand',    offset: new THREE.Vector3( 0,    0, 0) },
  { bone: 'leftFoot',     offset: new THREE.Vector3( 0, -0.05, 0) },
  { bone: 'rightFoot',    offset: new THREE.Vector3( 0, -0.05, 0) },
  // Wing-tip approximations: shoulder bone + lateral/back offset so the
  // emitter sits roughly where Tekk's mech wings extend. Mixamo's auto-rig
  // doesn't give us wing bones, so we ride the shoulder transform and let
  // the lateral offset trace the wing fan.
  { bone: 'leftShoulder',  offset: new THREE.Vector3( 0.4, 0.2, -0.3) },
  { bone: 'rightShoulder', offset: new THREE.Vector3(-0.4, 0.2, -0.3) },
];
const PARTICLES_PER_EMITTER = 10;
const TOTAL_PARTICLES = EMITTERS.length * PARTICLES_PER_EMITTER;
const PARTICLE_LIFETIME = 0.9;     // seconds before respawn
const STREAK_LENGTH = 0.9;         // long axis of each tube

interface Particle {
  emitterIdx: number;
  age: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  color: THREE.Color;
}

function SpeedLines({ active, vrmRef }: { active: boolean; vrmRef: React.MutableRefObject<VRM | null> }) {
  const refs = useRef<(THREE.Mesh | null)[]>([]);

  // Build particle pool once (positions filled in per-frame). Each emitter
  // gets PARTICLES_PER_EMITTER particles, staggered in age so the stream is
  // continuous instead of pulse-spawning every LIFETIME seconds.
  const particles = useMemo<Particle[]>(() => {
    const arr: Particle[] = [];
    for (let e = 0; e < EMITTERS.length; e++) {
      for (let i = 0; i < PARTICLES_PER_EMITTER; i++) {
        arr.push({
          emitterIdx: e,
          age: (i / PARTICLES_PER_EMITTER) * PARTICLE_LIFETIME,
          pos: new THREE.Vector3(),
          vel: new THREE.Vector3(),
          color: new THREE.Color(SPEEDLINE_COLORS[(e * PARTICLES_PER_EMITTER + i) % SPEEDLINE_COLORS.length]!),
        });
      }
    }
    return arr;
  }, []);

  // Reusable scratch — never allocated in the hot loop
  const scratchEmitter = useMemo(() => new THREE.Vector3(), []);
  const scratchDir = useMemo(() => new THREE.Vector3(), []);

  const respawnParticle = (p: Particle, emitterWorldPos: THREE.Vector3) => {
    p.age = 0;
    p.pos.copy(emitterWorldPos);
    // Random direction with a backward (-Z, away from camera) bias so streaks
    // trail behind him rather than into the lens.
    const ax = (Math.random() - 0.5) * 4;        // lateral spread
    const ay = (Math.random() - 0.5) * 2;        // mild vertical fan
    const az = -2 - Math.random() * 3;           // always backward, varying magnitude
    p.vel.set(ax, ay, az);
    // New rainbow colour each respawn for chromatic chaos
    p.color.setHex(parseInt(SPEEDLINE_COLORS[Math.floor(Math.random() * SPEEDLINE_COLORS.length)]!.slice(1), 16));
    // Apply colour to mesh material — material is unique per mesh below.
  };

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const vrm = vrmRef.current;
    if (!vrm || !vrm.humanoid) return;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!;
      const m = refs.current[i];
      if (!m) continue;
      p.age += dt;
      if (p.age >= PARTICLE_LIFETIME) {
        // Look up emitter bone world position
        const e = EMITTERS[p.emitterIdx]!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const boneNode = (vrm.humanoid as any).getNormalizedBoneNode?.(e.bone) as THREE.Object3D | null;
        if (boneNode) {
          boneNode.getWorldPosition(scratchEmitter);
          // Apply local-space offset transformed by the bone's world matrix so
          // wing-offsets stay attached to the shoulder orientation.
          scratchDir.copy(e.offset).applyMatrix4(boneNode.matrixWorld).sub(boneNode.getWorldPosition(scratchEmitter));
          boneNode.getWorldPosition(scratchEmitter).add(scratchDir);
          respawnParticle(p, scratchEmitter);
          (m.material as THREE.MeshBasicMaterial).color.copy(p.color);
        }
      } else {
        // Drift outward
        p.pos.x += p.vel.x * dt;
        p.pos.y += p.vel.y * dt;
        p.pos.z += p.vel.z * dt;
      }
      m.position.copy(p.pos);
      // Orient streak along its velocity so it visually trails
      m.lookAt(p.pos.x + p.vel.x, p.pos.y + p.vel.y, p.pos.z + p.vel.z);
      // Fade scale at end of life so streaks don't snap-cut on respawn
      const t = p.age / PARTICLE_LIFETIME;
      const opacityScale = Math.min(1, (1 - t) * 2);  // hold then fade in last half
      (m.material as THREE.MeshBasicMaterial).opacity = 0.9 * opacityScale;
    }
  });

  return (
    <group visible={active}>
      {particles.map((p, i) => (
        <mesh key={i} ref={(m) => { refs.current[i] = m; }}>
          {/* Thin elongated tube: 0.08 wide, 0.08 tall, STREAK_LENGTH long along Z */}
          <boxGeometry args={[0.08, 0.08, STREAK_LENGTH]} />
          <meshBasicMaterial
            color={p.color}
            transparent
            opacity={0.9}
            toneMapped={false}
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
