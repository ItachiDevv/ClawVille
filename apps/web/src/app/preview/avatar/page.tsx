'use client';

// useSearchParams + Three.js (browser-only WebGL canvas) require dynamic
// rendering at request time. Without this the build fails during static
// prerender of /preview/avatar with "Error occurred prerendering page".
export const dynamic = 'force-dynamic';

/**
 * /preview/avatar — standalone animation comparison page (dev-only, unadvertised).
 *
 * URL: /preview/avatar?mode=<mode>
 * Modes: static | procedural | rigged-idle | rigged-swim | rigged-hit | sketchfab
 *
 * Iris Xe rules enforced:
 *   - No drei <Text> / <Billboard>
 *   - No InstancedMesh + ShaderMaterial
 *   - No per-frame allocations (module-scope scratch)
 *   - import from 'three' (NOT 'three/webgpu')
 *   - frustumCulled=false traversed on every clone
 *   - MeshoptDecoder wired into GLTFLoader
 *   - 1 hemisphere + 1 directional light, no shadows
 *   - Background #0d2b5e (matches game FOG_COLOR)
 */

import { Suspense, useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { applyTransformSwim } from '@/lib/three/sea-creature-swim';
import { KTX2LoaderSetup, getKTX2Loader } from '@/lib/three/ktx2-loader-setup';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AVATAR_SCALE = 20;
const AUTO_ROTATE_SPEED = 0.005; // rad/frame at 60fps
const BG_COLOR = '#0d2b5e';

const MODES = [
  'static',
  'procedural',
  'rigged-idle',
  'rigged-swim',
  'rigged-hit',
  'sketchfab',
] as const;
type PreviewMode = (typeof MODES)[number];

function isValidMode(m: string | null): m is PreviewMode {
  return MODES.includes(m as PreviewMode);
}

const GLB_BASE = '/models/lobster-ktx.glb?v=2';
const GLB_RIGGED_BASE = '/models/sea-creatures/lobster/base-ktx.glb?v=2';
const GLB_IDLE = '/models/sea-creatures/lobster/animations/idle-ktx.glb?v=2';
const GLB_SWIM = '/models/sea-creatures/lobster/animations/swim-ktx.glb?v=2';
const GLB_HIT = '/models/sea-creatures/lobster/animations/hit-ktx.glb?v=2';
const GLB_SKETCHFAB = '/models/sea-creatures/sketchfab/cc0-crab.glb';

// ---------------------------------------------------------------------------
// Module-scope GLB cache — load-once per URL, zero per-frame allocations
// ---------------------------------------------------------------------------

type CacheEntry =
  | { status: 'pending'; promise: Promise<GLTF> }
  | { status: 'resolved'; gltf: GLTF }
  | { status: 'rejected'; error: unknown };

const _glbCache = new Map<string, CacheEntry>();
let _gltfLoader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  if (!_gltfLoader) {
    _gltfLoader = new GLTFLoader();
    _gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  }
  const ktx2 = getKTX2Loader();
  if (ktx2) _gltfLoader.setKTX2Loader(ktx2);
  return _gltfLoader;
}

function loadGlb(url: string): Promise<GLTF> {
  const cached = _glbCache.get(url);
  if (cached) {
    if (cached.status === 'resolved') return Promise.resolve(cached.gltf);
    if (cached.status === 'rejected') return Promise.reject(cached.error);
    return cached.promise;
  }
  const promise = getLoader()
    .loadAsync(url)
    .then((gltf) => { _glbCache.set(url, { status: 'resolved', gltf }); return gltf; })
    .catch((err: unknown) => { _glbCache.set(url, { status: 'rejected', error: err }); throw err; });
  _glbCache.set(url, { status: 'pending', promise });
  return promise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countTris(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const idx = mesh.geometry.index;
      tris += idx ? idx.count / 3 : (mesh.geometry.attributes.position?.count ?? 0) / 3;
    }
  });
  return Math.round(tris);
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => m?.dispose());
    }
  });
}

// ---------------------------------------------------------------------------
// AvatarScene — R3F scene component
// ---------------------------------------------------------------------------

function AvatarScene({
  mode,
  onTriCount,
  onSketchfabMissing,
}: {
  mode: PreviewMode;
  onTriCount: (n: number) => void;
  onSketchfabMissing: () => void;
}) {
  const groupRef = useRef<THREE.Group>(null!);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const meshRootRef = useRef<THREE.Object3D | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Tear down previous avatar
    const group = groupRef.current;
    group.children.slice().forEach((c) => { disposeObject(c); group.remove(c); });
    mixerRef.current?.stopAllAction();
    mixerRef.current = null;
    meshRootRef.current = null;

    async function load() {
      try {
        if (mode === 'static' || mode === 'procedural') {
          const gltf = await loadGlb(GLB_BASE);
          if (cancelled) return;
          const cloned = skeletonClone(gltf.scene);
          // CRITICAL: frustumCulled=false — SkinnedMesh bind-pose bbox doesn't
          // track animated geometry; Three.js culls mesh at close camera angles.
          cloned.traverse((o) => { o.frustumCulled = false; });
          cloned.scale.setScalar(AVATAR_SCALE);
          group.add(cloned);
          meshRootRef.current = cloned;
          onTriCount(countTris(cloned));
          // procedural: animation applied per-frame in useFrame; nothing else needed here
        }

        else if (mode === 'rigged-idle' || mode === 'rigged-swim' || mode === 'rigged-hit') {
          const animUrl =
            mode === 'rigged-idle' ? GLB_IDLE :
            mode === 'rigged-swim' ? GLB_SWIM :
            GLB_HIT;

          const [baseGltf, animGltf] = await Promise.all([
            loadGlb(GLB_RIGGED_BASE),
            loadGlb(animUrl),
          ]);
          if (cancelled) return;

          const cloned = skeletonClone(baseGltf.scene);
          cloned.traverse((o) => { o.frustumCulled = false; });
          cloned.scale.setScalar(AVATAR_SCALE);
          group.add(cloned);
          meshRootRef.current = cloned;
          onTriCount(countTris(cloned));

          const mixer = new THREE.AnimationMixer(cloned);
          mixerRef.current = mixer;

          if (animGltf.animations.length > 0) {
            // Blender export quirk: single clip named "Animation" — take animations[0]
            const clip = animGltf.animations[0]!.clone();
            clip.name = mode;
            const action = mixer.clipAction(clip);
            // Task spec: rigged-hit uses LoopRepeat so user can watch it cycle
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.clampWhenFinished = false;
            action.reset().play();
          }
        }

        else if (mode === 'sketchfab') {
          let gltf: GLTF;
          try {
            gltf = await loadGlb(GLB_SKETCHFAB);
          } catch {
            if (!cancelled) onSketchfabMissing();
            return;
          }
          if (cancelled) return;

          const cloned = skeletonClone(gltf.scene);
          cloned.traverse((o) => { o.frustumCulled = false; });
          cloned.scale.setScalar(AVATAR_SCALE);
          group.add(cloned);
          meshRootRef.current = cloned;
          onTriCount(countTris(cloned));

          // Play first bundled animation if any exist
          if (gltf.animations.length > 0) {
            const mixer = new THREE.AnimationMixer(cloned);
            mixerRef.current = mixer;
            const action = mixer.clipAction(gltf.animations[0]!);
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.clampWhenFinished = false;
            action.reset().play();
          }
        }
      } catch (err) {
        if (!cancelled) console.error('[avatar-preview] load error:', err);
      }
    }

    load();

    return () => {
      cancelled = true;
      const g = groupRef.current;
      if (g) {
        g.children.slice().forEach((c) => { disposeObject(c); g.remove(c); });
      }
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
      meshRootRef.current = null;
    };
  // onTriCount and onSketchfabMissing are stable useCallback refs; mode is the only dependency
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useFrame((_state, delta) => {
    const dt = Math.min(delta, 0.1);
    const group = groupRef.current;
    if (!group) return;

    // Slow auto-rotate around Y so all sides are visible
    group.rotation.y += AUTO_ROTATE_SPEED;

    // Advance AnimationMixer (rigged / sketchfab modes)
    mixerRef.current?.update(dt);

    // Procedural swim transform — static mesh, speed=300, baseY=0
    if (mode === 'procedural' && meshRootRef.current) {
      applyTransformSwim(meshRootRef.current, 'preview', dt, 300, 0);
    }
  });

  return (
    <>
      {/* 1 hemisphere + 1 directional — no shadows; Iris Xe budget: 7+ point lights = crash */}
      <hemisphereLight args={['#b9d5ff', '#080820', 1.2]} />
      <directionalLight position={[5, 10, 5]} intensity={1.5} castShadow={false} />
      {/* Avatar mounts here; lowered so centroid is roughly at canvas center */}
      <group ref={groupRef} position={[0, -10, 0]} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Sketchfab missing overlay — DOM, never canvas (no drei Html dependency)
// ---------------------------------------------------------------------------

function SketchfabMissingBanner() {
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'rgba(0,0,0,0.75)',
        color: '#fff',
        padding: '20px 32px',
        borderRadius: 8,
        maxWidth: 480,
        textAlign: 'center',
        fontSize: 14,
        lineHeight: 1.6,
        pointerEvents: 'none',
        zIndex: 10,
      }}
    >
      Sketchfab CC0 crab not yet downloaded — check Option 1 description.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root page
// ---------------------------------------------------------------------------

// Next.js 16 enforces wrapping useSearchParams in <Suspense> at page level
// even when the page is `'use client'` and `dynamic = 'force-dynamic'` is
// set. Without the wrap the build fails with:
//   useSearchParams() should be wrapped in a suspense boundary at page
// The outer component is the suspense boundary; the inner reads the params.
export default function AvatarPreviewPage() {
  return (
    <Suspense fallback={null}>
      <AvatarPreviewInner />
    </Suspense>
  );
}

function AvatarPreviewInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const rawMode = searchParams.get('mode');
  const mode: PreviewMode = isValidMode(rawMode) ? rawMode : 'static';

  const [triCount, setTriCount] = useState<number | null>(null);
  const [sketchfabMissing, setSketchfabMissing] = useState(false);

  // Stable callbacks — prevent AvatarScene re-mounting when parent state updates
  const handleTriCount = useCallback((n: number) => { setTriCount(n); }, []);
  const handleSketchfabMissing = useCallback(() => { setSketchfabMissing(true); }, []);

  // Reset status on mode change
  useEffect(() => {
    setTriCount(null);
    setSketchfabMissing(false);
  }, [mode]);

  function handleModeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    router.push(`/preview/avatar?mode=${e.target.value as PreviewMode}`);
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        background: BG_COLOR,
        overflow: 'hidden',
        fontFamily: 'monospace',
      }}
    >
      {/* Top bar: mode selector */}
      <div
        style={{
          flexShrink: 0,
          padding: '8px 16px',
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          color: '#cde',
          fontSize: 13,
          zIndex: 20,
        }}
      >
        <span style={{ fontWeight: 'bold', letterSpacing: 1 }}>Avatar Preview</span>
        <select
          value={mode}
          onChange={handleModeChange}
          style={{
            background: '#1a3a6b',
            color: '#cde',
            border: '1px solid #4488cc',
            borderRadius: 4,
            padding: '3px 8px',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {/* Canvas + overlays */}
      <div style={{ flex: 1, position: 'relative' }}>
        <Canvas
          gl={{ antialias: true }}
          camera={{ position: [0, 0, 60], fov: 50, near: 0.1, far: 2000 }}
          style={{ background: BG_COLOR, width: '100%', height: '100%' }}
        >
          <KTX2LoaderSetup />
          <color attach="background" args={[BG_COLOR]} />
          <Suspense fallback={null}>
            <AvatarScene
              mode={mode}
              onTriCount={handleTriCount}
              onSketchfabMissing={handleSketchfabMissing}
            />
          </Suspense>
        </Canvas>

        {sketchfabMissing && <SketchfabMissingBanner />}
      </div>

      {/* Bottom status bar */}
      <div
        style={{
          flexShrink: 0,
          padding: '5px 16px',
          background: 'rgba(0,0,0,0.5)',
          color: '#8ab',
          fontSize: 12,
          display: 'flex',
          gap: 24,
          zIndex: 20,
        }}
      >
        <span>
          mode: <strong style={{ color: '#cde' }}>{mode}</strong>
        </span>
        <span>
          tris:{' '}
          <strong style={{ color: '#cde' }}>
            {triCount !== null ? triCount.toLocaleString() : '—'}
          </strong>
        </span>
      </div>
    </div>
  );
}
