// @ts-nocheck — preview route crosses dual @types/three versions (0.170 from
// VRM deps, 0.182 from main three/webgpu). Runtime is unaffected.
'use client';

export const dynamic = 'force-dynamic';

/**
 * /preview/meshlet-spike-bare — NO R3F. Pure canvas + WebGPURenderer + rAF.
 *
 * Why this exists: the R3F-driven spike pages (/preview/meshlet-spike,
 * /preview/meshlet-spike-all-12) show "240 FPS" / "36 FPS" in the HUD but
 * produce a 100% transparent canvas. Compute passes complete without errors;
 * pixels never reach the swap chain. Working theory: R3F calls
 * `renderer.render(r3fScene, r3fCamera)` at the end of every frame against
 * its own (empty) scene, acquiring a fresh WebGPU swap-chain texture AFTER
 * useFrame finishes, so the rasterizer's framebuffer output is presented
 * to nothing and a blank texture is presented to the canvas.
 *
 * This page bypasses R3F entirely — pure HTML canvas, manual WebGPURenderer,
 * manual requestAnimationFrame loop. Mirrors the original Three.js example
 * `examples/webgpu_compute_nanite-style.html` exactly.
 *
 * If this page renders pixels → R3F is the bug; integration path needs rework.
 * If this page is also blank → the r182 port of the rasterizer is broken
 * silently and the spike is dead on our Three.js version.
 */

import * as THREE from 'three/webgpu';

import React, { useEffect, useRef, useState } from 'react';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import {
  geometryToMeshletAssetAsync,
  NaniteRasterizer,
} from '@/lib/three/experimental/nanite-rasterizer';

const MODEL_URL = '/models/building-lighthouse.glb?v=1';
const INSTANCE_DATA = new Float32Array([0, 0, 0, 1]);

function findFirstMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((obj) => {
    if (!found && (obj as THREE.Mesh).isMesh) found = obj as THREE.Mesh;
  });
  return found;
}

export default function MeshletSpikeBarePage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [webGpuAbsent] = useState<boolean>(() => {
    if (typeof navigator === 'undefined') return false;
    return !('gpu' in navigator);
  });

  const [fps, setFps] = useState<number>(0);
  const [status, setStatus] = useState<string>('Initialising…');
  const [pixelStats, setPixelStats] = useState<string>('—');
  const [loadInfo, setLoadInfo] = useState<string>('');

  useEffect(() => {
    if (webGpuAbsent || !canvasRef.current) return;

    const canvas = canvasRef.current;
    let disposed = false;
    let rafId = 0;
    let renderer: THREE.WebGPURenderer | null = null;
    let rasterizer: NaniteRasterizer | null = null;
    let camera: THREE.PerspectiveCamera | null = null;

    (async () => {
      setStatus('Sizing canvas…');
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);

      setStatus('Creating WebGPURenderer…');
      renderer = new THREE.WebGPURenderer({
        canvas,
        antialias: false,
        forceWebGL: false,
      });
      (renderer as any).setPixelRatio(dpr);
      await renderer.init();
      renderer.setSize(rect.width, rect.height, false);
      // CRITICAL: do NOT set autoClear = false here. The original example
      // lets the renderer manage clears for its hwScene render. The bare
      // page mirrors that exactly.

      setStatus('Loading lighthouse GLB…');
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await new Promise<any>((resolve, reject) => {
        loader.load(MODEL_URL, resolve, undefined, reject);
      });
      if (disposed) return;

      const mesh = findFirstMesh(gltf.scene);
      if (!mesh) throw new Error('No Mesh in GLB');

      setStatus('Building meshlet asset…');
      const asset = await geometryToMeshletAssetAsync(mesh.geometry);
      if (disposed) return;
      const coarsestTris = asset.lodTriCounts[asset.lodCount - 1] ?? asset.triangleCount;
      const reductionPct = asset.triangleCount > 0
        ? Math.round((1 - coarsestTris / asset.triangleCount) * 100)
        : 0;
      setLoadInfo(
        `${asset.totalVertices.toLocaleString()} verts · ` +
        `${asset.triangleCount.toLocaleString()} tris · ` +
        `${asset.totalChunks} chunks · ${asset.lodCount} LODs (→${reductionPct}%)`
      );

      setStatus('Constructing NaniteRasterizer…');
      rasterizer = new NaniteRasterizer(renderer, asset, {
        instanceCount: 1,
        staticInstanceData: INSTANCE_DATA,
        maxRasterSize: 16,
      });
      await rasterizer.init();
      if (disposed) return;

      // Camera mirrors the R3F page's default but using our own object.
      camera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.1, 5000);
      camera.position.set(0, 8, 20);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();

      setStatus('Running render loop…');

      // FPS / pixel-sample accumulators
      let frames = 0;
      let lastFpsT = performance.now();
      let lastPixelT = performance.now();

      const tick = async () => {
        if (disposed || !renderer || !rasterizer || !camera) return;
        try {
          await rasterizer.render(camera, canvas.width / dpr, canvas.height / dpr);
        } catch (err) {
          console.error('[meshlet-spike-bare] render error:', err);
        }

        frames++;
        const now = performance.now();
        if (now - lastFpsT >= 1000) {
          setFps(Math.round((frames * 1000) / (now - lastFpsT)));
          frames = 0;
          lastFpsT = now;
        }
        // Sample pixels every 2s to verify the canvas is actually painted.
        if (now - lastPixelT >= 2000) {
          lastPixelT = now;
          try {
            const probe = document.createElement('canvas');
            probe.width = canvas.width; probe.height = canvas.height;
            const ctx = probe.getContext('2d');
            if (ctx) {
              ctx.drawImage(canvas, 0, 0);
              const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              let nonZero = 0;
              const total = d.length / 4;
              const step = Math.max(1, Math.floor(total / 5000));
              let sampled = 0;
              for (let i = 0; i < d.length; i += 4 * step) {
                sampled++;
                if (d[i] || d[i+1] || d[i+2] || d[i+3]) nonZero++;
              }
              setPixelStats(`${nonZero}/${sampled} non-zero (${(nonZero/sampled*100).toFixed(1)}%)`);
            }
          } catch (e) {
            setPixelStats('probe failed: ' + (e as Error).message);
          }
        }

        rafId = requestAnimationFrame(tick);
      };

      tick();
    })().catch((err) => {
      console.error('[meshlet-spike-bare] init failed:', err);
      setStatus('FAILED: ' + String(err?.message ?? err));
    });

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rasterizer?.dispose();
      // Three.js WebGPURenderer has dispose() in r182; safe to call.
      try { (renderer as any)?.dispose?.(); } catch {}
    };
  }, [webGpuAbsent]);

  if (webGpuAbsent) {
    return (
      <div style={styles.errorPage}>
        <div style={styles.errorBox}>
          <div style={styles.errorTitle}>WebGPU Not Available</div>
          <div style={styles.errorBody}>
            This spike requires WebGPU. Enable in chrome://flags or use Chrome 113+.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <canvas ref={canvasRef} style={styles.canvas} />
      <div style={styles.overlay}>
        <div style={styles.overlayTitle}>Meshlet Spike — BARE (no R3F)</div>
        <Row label="FPS" value={String(fps)} />
        <Row label="Pixel probe" value={pixelStats} />
        <Row label="Status" value={status} />
        {loadInfo && <div style={styles.overlayRow}>{loadInfo}</div>}
        <div style={{ ...styles.overlayRow, marginTop: 6, fontSize: 10, opacity: 0.5 }}>
          {MODEL_URL.split('?')[0].split('/').pop()}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.overlayRow}>
      <span style={styles.overlayLabel}>{label}</span>
      <span style={styles.overlayValue}>{value}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { position: 'fixed', inset: 0, background: '#0a0a0a' },
  canvas: { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' },
  overlay: {
    position: 'absolute', top: 12, left: 12,
    padding: '10px 14px', background: 'rgba(0,0,0,0.78)',
    color: '#ffffff', font: '12px/1.5 "Courier New", monospace',
    borderRadius: 8, backdropFilter: 'blur(4px)',
    minWidth: 280, maxWidth: 360, pointerEvents: 'none',
  },
  overlayTitle: { fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: '0.02em', color: '#facc15' },
  overlayRow: { display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 2, fontSize: 11 },
  overlayLabel: { opacity: 0.65 },
  overlayValue: { fontWeight: 600, color: '#4ade80', textAlign: 'right', wordBreak: 'break-all' },
  errorPage: { position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', color: '#fff' },
  errorBox: { maxWidth: 480, padding: 32, background: '#1a1a1a', borderRadius: 12, border: '1px solid #333' },
  errorTitle: { fontSize: 22, fontWeight: 700, marginBottom: 12 },
  errorBody: { fontSize: 14, lineHeight: 1.5, opacity: 0.85 },
};
