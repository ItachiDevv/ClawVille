'use client';

/**
 * /preview/asset-ab — rung-2 texture-diet A/B judging harness (dev-only).
 *
 * Loads ONE GLB by URL and lights it with an ORBITING GRAZING directional
 * light — the census C-ladder acceptance test ("test under grazing/MOVING
 * light, not one static screenshot"). Screenshot the same asset at the same
 * ?lightphase before/after a diet and diff visually.
 *
 * URL params:
 *   ?glb=/models/lobster_plush-ktx.glb   (required; /models|/avatars only)
 *   ?lightphase=45      freeze light at N degrees (omit = orbiting)
 *   ?dist=1.8           camera distance in bounding-radius multiples
 *   ?spin=1             slow model turntable
 *
 * Renderer rules (same as /preview/avatar): plain 'three' WebGL on its OWN
 * page canvas — NO three/webgpu imports, no drei Text (Iris Xe).
 *
 * NOTE: like every /preview/* route this page ships publicly — it is a
 * production-accessible DIAGNOSTIC page (loads only same-origin /models|
 * /avatars assets, no auth surface, no writes), not a gated dev tool.
 */

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { KTX2LoaderSetup, getKTX2Loader } from '@/lib/three/ktx2-loader-setup';

let _loader: GLTFLoader | null = null;
function loader(): GLTFLoader {
  if (!_loader) {
    _loader = new GLTFLoader();
    _loader.setMeshoptDecoder(MeshoptDecoder);
  }
  const ktx2 = getKTX2Loader();
  if (ktx2) _loader.setKTX2Loader(ktx2);
  return _loader;
}

function sanitizeGlbParam(raw: string | null): string | null {
  if (!raw) return null;
  if (!/^\/(models|avatars)\/[A-Za-z0-9_\-./]+\.(glb|vrm)(\?v=\d+)?$/.test(raw)) return null;
  if (raw.includes('..')) return null;
  return raw;
}

function AssetScene({ url, lightPhase, dist, spin, onInfo }: {
  url: string;
  lightPhase: number | null;
  dist: number;
  spin: boolean;
  onInfo: (s: string) => void;
}) {
  const groupRef = useRef<THREE.Group>(null!);
  const lightRef = useRef<THREE.DirectionalLight>(null!);
  const radiusRef = useRef(1);

  useEffect(() => {
    let cancelled = false;
    const group = groupRef.current;
    const disposeTree = (obj: THREE.Object3D) => {
      obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m) => {
            if (!m) return;
            Object.values(m).forEach((v) => { if (v instanceof THREE.Texture) v.dispose(); });
            m.dispose();
          });
        }
      });
    };
    group.children.slice().forEach((c) => { disposeTree(c); group.remove(c); });
    loader().load(
      url,
      (gltf: GLTF) => {
        if (cancelled) { disposeTree(gltf.scene); return; }
        const root = gltf.scene;
        root.traverse((o) => { o.frustumCulled = false; });
        // center on origin, measure radius
        const box = new THREE.Box3().setFromObject(root);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
        root.position.sub(center);
        radiusRef.current = radius;
        group.add(root);
        let tris = 0;
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m.geometry) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position?.count ?? 0) / 3;
        });
        onInfo(`${url} | ${Math.round(tris)} tris | r=${radius.toFixed(1)}`);
      },
      undefined,
      (err) => onInfo(`LOAD ERROR: ${String((err as Error)?.message ?? err)}`),
    );
    return () => {
      cancelled = true;
      group.children.slice().forEach((c) => { disposeTree(c); group.remove(c); });
    };
  }, [url, onInfo]);

  useFrame((state) => {
    const r = radiusRef.current;
    // camera: fixed offset scaled by bounds
    state.camera.position.set(0, r * 0.35, r * dist);
    state.camera.lookAt(0, 0, 0);
    if (state.camera instanceof THREE.PerspectiveCamera) {
      state.camera.near = r / 100;
      state.camera.far = r * 20;
      state.camera.updateProjectionMatrix();
    }
    // grazing light: low elevation (~12°), orbiting unless frozen
    const t = lightPhase != null ? (lightPhase * Math.PI) / 180 : state.clock.elapsedTime * 0.6;
    if (lightRef.current) {
      lightRef.current.position.set(Math.cos(t) * r * 3, r * 0.6, Math.sin(t) * r * 3);
      lightRef.current.target.position.set(0, 0, 0);
      lightRef.current.target.updateMatrixWorld();
    }
    if (spin && groupRef.current) groupRef.current.rotation.y = state.clock.elapsedTime * 0.3;
  });

  return (
    <group>
      <ambientLight intensity={0.25} />
      <directionalLight ref={lightRef} intensity={2.2} castShadow={false} />
      <group ref={groupRef} />
    </group>
  );
}

function AssetABInner() {
  const params = useSearchParams();
  const glb = sanitizeGlbParam(params.get('glb'));
  const lightPhase = params.get('lightphase') != null ? Number(params.get('lightphase')) : null;
  const rawDist = Number(params.get('dist') ?? '1.8');
  const dist = Number.isFinite(rawDist) ? Math.min(20, Math.max(0.5, rawDist)) : 1.8;
  const spin = params.get('spin') === '1';
  const [info, setInfo] = useState('loading…');

  if (!glb) {
    return <div style={{ color: '#fff', padding: 24, fontFamily: 'monospace' }}>asset-ab: pass ?glb=/models/… or /avatars/… (.glb/.vrm, optional ?v=N)</div>;
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#25455e' }}>
      <Canvas camera={{ fov: 40, position: [0, 1, 4] }} gl={{ antialias: true }} dpr={[1, 1.5]}>
        <KTX2LoaderSetup />
        <Suspense fallback={null}>
          <AssetScene url={glb} lightPhase={Number.isFinite(lightPhase as number) ? lightPhase : null} dist={dist} spin={spin} onInfo={setInfo} />
        </Suspense>
      </Canvas>
      <div
        data-testid="asset-ab-info"
        style={{ position: 'fixed', top: 8, left: 8, color: '#9fd8ff', font: '12px monospace', background: 'rgba(0,0,0,0.55)', padding: '4px 8px', borderRadius: 4, maxWidth: '92vw' }}
      >
        {info}
      </div>
    </div>
  );
}

export default function AssetABPage() {
  return (
    <Suspense fallback={null}>
      <AssetABInner />
    </Suspense>
  );
}
