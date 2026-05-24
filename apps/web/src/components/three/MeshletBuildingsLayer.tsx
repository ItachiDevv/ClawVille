// @ts-nocheck
/**
 * <MeshletBuildingsLayer />
 *
 * Out-of-tree React component that renders the 11 ClawVille buildings via the
 * Nanite-style WebGPU compute rasterizer (Phase A spike → Phase B integration).
 *
 * Mounts a transparent-background `<canvas>` at position:absolute / inset:0 /
 * z-index:0 — sits UNDER the R3F game canvas (which is also absolute inset:0
 * but with transparent background when the meshlet path is active, so this
 * layer shows through). HUD overlays at z-index:10+ are unaffected.
 *
 * Owns:
 *  - Its own WebGPURenderer (can NOT share R3F's renderer — monkey-patching
 *    renderer.render to suppress R3F's end-of-frame call also kills the
 *    rasterizer's own internal render calls; see spike-session journal).
 *  - Its own PerspectiveCamera, populated each frame from gameCameraRef
 *    (camera-exporter.tsx writes it inside R3F's frame).
 *  - Its own requestAnimationFrame loop, independent of R3F's frame loop.
 *
 * Behaviour gated by ?meshlets=1 URL query — see /game/page.tsx.
 *
 * KILL-THE-BUILD INVARIANT (CLAUDE.md): NO drei <Text>, NO drei <Billboard>.
 * This component renders no React-tree 3D — only the bare canvas + rasterizer.
 */
'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three/webgpu';
import { NaniteRasterizer } from '@/lib/three/experimental/nanite-rasterizer';
import { useMergedBuildingsAsset } from '@/lib/three/meshlet/use-merged-buildings-asset';
import { RING_BOUNDING_RADIUS } from '@/lib/three/meshlet/buildings-manifest';
import { gameCameraRef } from '@/lib/three/meshlet/game-camera-ref';

const ROOT_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  zIndex: 0,
  pointerEvents: 'none', // R3F canvas above us captures all input
};

const CANVAS_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  display: 'block',
  background: 'transparent',
};

export default function MeshletBuildingsLayer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { asset, state } = useMergedBuildingsAsset();

  useEffect(() => {
    if (!canvasRef.current || !asset) return;

    const canvas = canvasRef.current;
    let disposed = false;
    let rafId = 0;
    let renderer: THREE.WebGPURenderer | null = null;
    let rasterizer: NaniteRasterizer | null = null;
    const camera = new THREE.PerspectiveCamera(50, 1, 1, 10000);

    (async () => {
      // Size canvas to its parent (the inset-0 root div). Use dpr cap to
      // match World3DCanvas's [0.55, 0.7] Iris Xe budget.
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 0.7);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));

      renderer = new THREE.WebGPURenderer({
        canvas,
        antialias: false,
        forceWebGL: false,
        alpha: true, // transparent so R3F can composite over us
      });
      (renderer as any).setPixelRatio(dpr);
      await renderer.init();
      renderer.setSize(rect.width, rect.height, false);
      // Transparent clear so the R3F layer sees through to terrain/sky behind us.
      (renderer as any).setClearColor?.(0x000000, 0);
      if (disposed) return;

      // pixelErrorThreshold=0 forces LOD 0 — proven 167 FPS on Iris Xe at the
      // birds-eye spike camera. Real per-cluster LOD is the proper fix (tracked
      // separately) but full detail is fine for Phase B v1.
      rasterizer = new NaniteRasterizer(renderer, asset, {
        instanceCount: 1,
        staticInstanceData: new Float32Array([0, 0, 0, 1]),
        maxRasterSize: 16,
        instanceBoundingRadius: RING_BOUNDING_RADIUS,
        pixelErrorThreshold: 0,
      });
      await rasterizer.init();
      if (disposed) return;

      // ResizeObserver — keep canvas in sync with container dims.
      const ro = new ResizeObserver(() => {
        if (!renderer) return;
        const r = canvas.getBoundingClientRect();
        canvas.width = Math.max(1, Math.round(r.width * dpr));
        canvas.height = Math.max(1, Math.round(r.height * dpr));
        renderer.setSize(r.width, r.height, false);
        camera.aspect = r.width / Math.max(1, r.height);
        camera.updateProjectionMatrix();
      });
      ro.observe(canvas);

      const tick = async () => {
        if (disposed || !renderer || !rasterizer) return;
        try {
          // Sync camera from R3F's gameCameraRef (written by <CameraExporter />).
          if (gameCameraRef.ready) {
            camera.position.copy(gameCameraRef.position);
            camera.quaternion.copy(gameCameraRef.quaternion);
            if (
              camera.fov !== gameCameraRef.fov ||
              camera.near !== gameCameraRef.near ||
              camera.far !== gameCameraRef.far
            ) {
              camera.fov = gameCameraRef.fov;
              camera.near = gameCameraRef.near;
              camera.far = gameCameraRef.far;
              camera.updateProjectionMatrix();
            }
            camera.updateMatrixWorld();
          }
          const r = canvas.getBoundingClientRect();
          await rasterizer.render(camera, r.width, r.height);
        } catch (err) {
          console.error('[MeshletBuildingsLayer] render error:', err);
        }
        rafId = requestAnimationFrame(tick);
      };
      tick();

      // Cleanup binding (ro disconnect handled in outer return).
      (renderer as any).__meshletRO = ro;
    })().catch((err) => {
      console.error('[MeshletBuildingsLayer] init failed:', err);
    });

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      try { ((renderer as any)?.__meshletRO as ResizeObserver | undefined)?.disconnect(); } catch {}
      rasterizer?.dispose();
      try { (renderer as any)?.dispose?.(); } catch {}
    };
  }, [asset]);

  // While loading, render nothing visible — R3F's standard ArenaBuildings will
  // also be unmounted in /game when this layer is active, so for a few seconds
  // there will be no buildings drawn. That's acceptable; the loading screen
  // (SeaLoadingScreen) covers initial mount anyway.
  if (state === 'error') {
    console.error('[MeshletBuildingsLayer] asset load failed');
    return null;
  }

  return (
    <div style={ROOT_STYLE}>
      <canvas ref={canvasRef} style={CANVAS_STYLE} />
    </div>
  );
}
