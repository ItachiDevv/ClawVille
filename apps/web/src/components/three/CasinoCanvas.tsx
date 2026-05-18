'use client';

/**
 * CasinoCanvas.tsx
 *
 * R3F Canvas for the casino interior scene.
 * Dynamically imported (ssr:false) by apps/web/src/app/casino/page.tsx.
 *
 * key={'casino-interior'} → React tears down and recreates the Canvas
 * whenever the route mounts/unmounts — ensures a clean WebGPU context
 * and no texture/geometry leaks from prior routes.
 *
 * Iris Xe invariants enforced globally here:
 *   - DPR cap: [0.55, 0.7] on low-end GPU, [0.75, 1] otherwise
 *   - No shadows (scene lights set castShadow=false in CasinoLighting)
 *   - camera.far=2000 (interior is small; fog far=1200 < camera.far ✓)
 *   - compileAsync fired once after first R3F commit
 */

import { Suspense, useEffect, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import CasinoInteriorScene from '@/lib/three/casino-interior';

// ---------------------------------------------------------------------------
// Low-end GPU detection — mirrors World3DCanvas pattern exactly
// ---------------------------------------------------------------------------
const LOW_END_GPU: boolean = (() => {
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : '';
    const isLowEnd = /\bintel\b|\biris\b|\buhd graphics\b|\bhd graphics\b|\bgma\b|adreno|mali|powervr|apple gpu/i.test(renderer);
    const isTouch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    return isLowEnd || isTouch;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// PreCompilePipelines — fire compileAsync after first R3F commit
// Eliminates the pipeline-compile hitch on first rendered frame.
// Same pattern as World3DCanvas.
// ---------------------------------------------------------------------------
function PreCompilePipelines() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (typeof (gl as any).compileAsync === 'function') {
        (gl as any).compileAsync(scene, camera).catch((err: unknown) => {
          console.warn('[CasinoCanvas] compileAsync failed (non-fatal):', err);
        });
      }
    });
    return () => cancelAnimationFrame(raf);
    // gl/scene/camera are stable R3F refs — intentionally omitted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

// ---------------------------------------------------------------------------
// Scene background setter — runs once inside the R3F context
// ---------------------------------------------------------------------------
const SCENE_BG = new THREE.Color(0x0a0015); // deep neon-dark purple

function SceneBackground() {
  const { scene } = useThree();
  useEffect(() => {
    scene.background = SCENE_BG;
  }, [scene]);
  return null;
}

// ---------------------------------------------------------------------------
// Scene-empty fail-safe overlay — pure DOM, rendered in this component
// (not inside the R3F Canvas) so it safely targets the DOM reconciler.
// ---------------------------------------------------------------------------
function SceneEmptyOverlay() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(10,0,21,0.85)',
        zIndex: 10,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          color: '#ff4dff',
          fontFamily: 'monospace',
          fontSize: 16,
          textAlign: 'center',
          padding: '24px 32px',
          border: '1px solid #ff00cc',
          borderRadius: 8,
          background: 'rgba(0,0,0,0.6)',
        }}
      >
        Casino interior failed to load — please refresh
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export — route-isolated Canvas
// ---------------------------------------------------------------------------
export default function CasinoCanvas() {
  const [sceneEmpty, setSceneEmpty] = useState(false);

  return (
    <div style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }}>
      <Canvas
        key="casino-interior"
        dpr={LOW_END_GPU ? [0.55, 0.7] : [0.75, 1]}
        frameloop="always"
        camera={{
          fov: 55,
          near: 1,
          far: 2000,
          position: [0, 120, 350],
        }}
        gl={{
          antialias: false,
          powerPreference: 'low-power',
        }}
      >
        <SceneBackground />
        <PreCompilePipelines />

        <Suspense fallback={null}>
          <CasinoInteriorScene onSceneEmpty={() => setSceneEmpty(true)} />
        </Suspense>
      </Canvas>

      {/* DOM fail-safe overlay — rendered over the Canvas in pure DOM context */}
      {sceneEmpty && <SceneEmptyOverlay />}
    </div>
  );
}
