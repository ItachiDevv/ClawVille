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
import { Canvas, useFrame, useThree } from '@react-three/fiber';
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
type PreviewFit = { scale: number; offsetY: number };

function HermesAvatar({
  character,
  mode,
  vrmRef,
  fitRef,
}: {
  character: Character;
  mode: Mode;
  vrmRef: React.MutableRefObject<VRM | null>;
  fitRef: React.MutableRefObject<PreviewFit | null>;
}) {
  const path = `/avatars/hermes-${character}.vrm`;
  const vrm = useVRMInstance(path, `preview-${character}`);
  const animatorRef = useRef<VRMCharacterAnimator | null>(null);
  const [fit, setFit] = useState<PreviewFit | null>(null);

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
    const nextFit = { scale: autoScale, offsetY: autoOffsetY };
    fitRef.current = nextFit;
    setFit(nextFit);
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
      fitRef.current = null;
      animatorRef.current = null;
      animator.dispose();
      disposeVRMInstance(path, `preview-${character}`);
    };
  }, [vrm, character, path, fitRef]);

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
    if (vrm && fit) {
      vrm.scene.scale.setScalar(fit.scale);
      vrm.scene.position.set(0, fit.offsetY, 0);
      vrm.scene.rotation.set(0, -Math.PI / 2, 0);
      vrm.scene.updateMatrixWorld(true);
    }
  });

  if (!vrm || !fit) return null;
  // Avatar exported facing +X. Rotate -90° around Y so it faces +Z (toward
  // a camera positioned at +Z). Permanent fix should bake this into the
  // Blender export (apply armature rotation before VRM export).
  return <primitive object={vrm.scene} />;
}

// Tapered speed ribbons. They are camera-facing strips rebuilt from recent
// emitter positions, which gives the 2D speed-line silhouette without looking
// like physical cables attached to the model.
const TRAIL_HISTORY_LEN = 14;
const TRAIL_MIN_STEP = 0.025;
const TRAIL_RESET_DISTANCE = 1.4;

const TRAIL_VERTEX_SHADER = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FRAGMENT_SHADER = `
  uniform float time;
  uniform float hueOffset;
  uniform float alpha;
  varying vec2 vUv;

  vec3 hsb2rgb(vec3 c) {
    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    rgb = rgb * rgb * (3.0 - 2.0 * rgb);
    return c.z * mix(vec3(1.0), rgb, c.y);
  }

  void main() {
    float headFade = smoothstep(0.0, 0.16, vUv.x);
    float tailFade = 1.0 - smoothstep(0.72, 1.0, vUv.x);
    float edgeFade = 1.0 - smoothstep(0.36, 0.5, abs(vUv.y - 0.5));
    float dash = smoothstep(0.18, 0.72, fract((vUv.x * 3.2) - (time * 1.9) + hueOffset));
    float glow = mix(0.55, 1.0, dash);
    vec3 rgb = hsb2rgb(vec3(fract(hueOffset + vUv.x * 0.36 + time * 0.16), 0.95, 1.0));

    gl_FragColor = vec4(rgb * glow, alpha * headFade * tailFade * edgeFade);
  }
`;

const EMITTERS: Array<{
  bone: string;
  offset: THREE.Vector3;
  width: number;
  hue: number;
  alpha: number;
}> = [
  { bone: 'leftHand',      offset: new THREE.Vector3( 0.02, -0.03, -0.04), width: 0.16, hue: 0.96, alpha: 0.9 },
  { bone: 'leftHand',      offset: new THREE.Vector3(-0.04, -0.02,  0.05), width: 0.10, hue: 0.58, alpha: 0.8 },
  { bone: 'rightHand',     offset: new THREE.Vector3(-0.02, -0.03, -0.04), width: 0.16, hue: 0.50, alpha: 0.9 },
  { bone: 'rightHand',     offset: new THREE.Vector3( 0.04, -0.02,  0.05), width: 0.10, hue: 0.80, alpha: 0.8 },
  { bone: 'leftFoot',      offset: new THREE.Vector3( 0.02, -0.08,  0.04), width: 0.13, hue: 0.14, alpha: 0.82 },
  { bone: 'rightFoot',     offset: new THREE.Vector3(-0.02, -0.08,  0.04), width: 0.13, hue: 0.74, alpha: 0.82 },
  { bone: 'leftShoulder',  offset: new THREE.Vector3( 0.58,  0.18, -0.28), width: 0.22, hue: 0.34, alpha: 0.72 },
  { bone: 'leftShoulder',  offset: new THREE.Vector3( 0.86,  0.04, -0.44), width: 0.14, hue: 0.52, alpha: 0.66 },
  { bone: 'rightShoulder', offset: new THREE.Vector3(-0.58,  0.18, -0.28), width: 0.22, hue: 0.06, alpha: 0.72 },
  { bone: 'rightShoulder', offset: new THREE.Vector3(-0.86,  0.04, -0.44), width: 0.14, hue: 0.84, alpha: 0.66 },
];

interface SpeedTrail {
  bone: string;
  offset: THREE.Vector3;
  width: number;
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  material: THREE.ShaderMaterial;
  history: THREE.Vector3[];
  seeded: boolean;                // false until the first frame seeds the buffer
}

function SpeedLines({
  active,
  vrmRef,
  fitRef,
}: {
  active: boolean;
  vrmRef: React.MutableRefObject<VRM | null>;
  fitRef: React.MutableRefObject<PreviewFit | null>;
}) {
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const { camera } = useThree();

  const trails = useMemo<SpeedTrail[]>(() =>
    EMITTERS.map((e) => ({
      bone: e.bone,
      offset: e.offset.clone(),
      width: e.width,
      geometry: (() => {
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(TRAIL_HISTORY_LEN * 2 * 3);
        const uvs = new Float32Array(TRAIL_HISTORY_LEN * 2 * 2);
        const indices = new Uint16Array((TRAIL_HISTORY_LEN - 1) * 6);

        for (let j = 0; j < TRAIL_HISTORY_LEN; j++) {
          const t = j / (TRAIL_HISTORY_LEN - 1);
          const uv = j * 4;
          uvs[uv] = t;
          uvs[uv + 1] = 1;
          uvs[uv + 2] = t;
          uvs[uv + 3] = 0;

          if (j < TRAIL_HISTORY_LEN - 1) {
            const a = j * 2;
            const ii = j * 6;
            indices[ii] = a;
            indices[ii + 1] = a + 1;
            indices[ii + 2] = a + 2;
            indices[ii + 3] = a + 1;
            indices[ii + 4] = a + 3;
            indices[ii + 5] = a + 2;
          }
        }

        const positionAttr = new THREE.BufferAttribute(positions, 3);
        positionAttr.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('position', positionAttr);
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        return geometry;
      })(),
      positions: new Float32Array(0),
      material: new THREE.ShaderMaterial({
        uniforms: {
          time: { value: 0 },
          hueOffset: { value: e.hue },
          alpha: { value: e.alpha },
        },
        vertexShader: TRAIL_VERTEX_SHADER,
        fragmentShader: TRAIL_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
      history: Array.from({ length: TRAIL_HISTORY_LEN }, () => new THREE.Vector3()),
      seeded: false,
    })), []);

  useEffect(() => {
    for (const t of trails) {
      t.positions = (t.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    }

    return () => {
      for (const t of trails) {
        t.geometry.dispose();
        t.material.dispose();
      }
    };
  }, [trails]);

  // When toggling active off → on we want to reset the trail seed so
  // the ribbons start from the bone's current location instead of
  // snapping along a stale buffer.
  useEffect(() => {
    if (!active) {
      for (const t of trails) t.seeded = false;
    }
  }, [active, trails]);

  const scratch = useMemo(() => new THREE.Vector3(), []);
  const cameraDir = useMemo(() => new THREE.Vector3(), []);
  const tangent = useMemo(() => new THREE.Vector3(), []);
  const side = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    for (const trail of trails) {
      trail.material.uniforms.time.value = state.clock.elapsedTime;
    }

    const vrm = vrmRef.current;
    const fit = fitRef.current;
    if (!active || !vrm || !vrm.humanoid || !fit) return;

    vrm.scene.updateMatrixWorld(true);
    camera.getWorldDirection(cameraDir);

    for (let i = 0; i < trails.length; i++) {
      const trail = trails[i]!;
      const mesh = meshRefs.current[i];
      if (!mesh) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const boneNode = (vrm.humanoid as any).getNormalizedBoneNode?.(trail.bone) as THREE.Object3D | null;
      if (!boneNode) continue;
      scratch.copy(trail.offset).applyMatrix4(boneNode.matrixWorld);

      if (!trail.seeded || scratch.distanceToSquared(trail.history[0]!) > TRAIL_RESET_DISTANCE * TRAIL_RESET_DISTANCE) {
        for (let j = 0; j < trail.history.length; j++) trail.history[j].copy(scratch);
        trail.seeded = true;
      } else if (scratch.distanceToSquared(trail.history[0]!) > TRAIL_MIN_STEP * TRAIL_MIN_STEP) {
        for (let j = trail.history.length - 1; j > 0; j--) {
          trail.history[j].copy(trail.history[j - 1]!);
        }
        trail.history[0]!.copy(scratch);
      }

      for (let j = 0; j < trail.history.length; j++) {
        const p = trail.history[j]!;
        const prev = trail.history[Math.max(0, j - 1)]!;
        const next = trail.history[Math.min(trail.history.length - 1, j + 1)]!;
        tangent.subVectors(prev, next);
        if (tangent.lengthSq() < 0.0001) tangent.set(1, 0, 0);
        tangent.normalize();

        side.crossVectors(tangent, cameraDir);
        if (side.lengthSq() < 0.0001) side.set(0, 1, 0);
        side.normalize();

        const t = j / (trail.history.length - 1);
        const taper = Math.sin((1 - t) * Math.PI * 0.85);
        const width = trail.width * Math.max(0.08, taper);
        const pIndex = j * 6;
        trail.positions[pIndex] = p.x + side.x * width;
        trail.positions[pIndex + 1] = p.y + side.y * width;
        trail.positions[pIndex + 2] = p.z + side.z * width;
        trail.positions[pIndex + 3] = p.x - side.x * width;
        trail.positions[pIndex + 4] = p.y - side.y * width;
        trail.positions[pIndex + 5] = p.z - side.z * width;
      }

      const positionAttr = trail.geometry.getAttribute('position') as THREE.BufferAttribute;
      positionAttr.needsUpdate = true;
      trail.geometry.computeBoundingSphere();
    }
  });

  return (
    <group visible={active}>
      {trails.map((t, i) => (
        <mesh key={i} ref={(m) => { meshRefs.current[i] = m; }} geometry={t.geometry} material={t.material} renderOrder={20} />
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
  const fitRef = useRef<PreviewFit | null>(null);
  return (
    <>
      <hemisphereLight args={[0xffffff, 0xccccff, ambient]} />
      <directionalLight position={[10, 30, 10]} intensity={1.0} castShadow={false} />
      <Suspense fallback={null}>
        <HermesAvatar character={character} mode={mode} vrmRef={vrmRef} fitRef={fitRef} />
      </Suspense>
      <SpeedLines active={speedlinesActive} vrmRef={vrmRef} fitRef={fitRef} />
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
