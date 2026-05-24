// @ts-nocheck — preview route crosses dual @types/three versions (0.170 from
// VRM deps, 0.182 from main three/webgpu). Every Three.js value in this file
// hits that boundary; per-line casts are intractable. Runtime is unaffected;
// this is a dev-only spike preview route.
'use client';

// Three.js requires a browser canvas. Force dynamic so Next.js doesn't
// try to prerender this page.
export const dynamic = 'force-dynamic';

/**
 * /preview/meshlet-spike — GPU-driven Nanite-style rasterizer spike.
 *
 * What this page does:
 *   1. Hard-fails with a message if navigator.gpu is absent (WebGPU only).
 *   2. Loads /models/building-lighthouse.glb?v=1 (smallest building, ~59 KB).
 *   3. Walks the GLTF scene to get the first THREE.Mesh's geometry.
 *   4. Calls geometryToMeshletAsset() to produce meshlet data.
 *   5. Initialises NaniteRasterizer and drives it via useFrame().
 *   6. Bypasses R3F's normal scene render entirely — the rasterizer IS the renderer.
 *   7. Shows an FPS overlay via plain HTML DOM (NO drei <Text> — Iris Xe rule).
 *
 * Iris Xe invariants:
 *   - No drei <Text> / <Billboard>
 *   - No InstancedMesh + ShaderMaterial
 *   - No per-frame new Vector3() / new Matrix4() allocations
 *   - No dynamic import('three/webgpu') — static import only
 *
 * Route: https://clawville.world/preview/meshlet-spike
 */

// Static import — NEVER dynamic. A dynamic import creates a second webpack
// chunk with a separate module instance; IndexNode and other TSL singletons
// mismatch → crash on first load for non-WebGPU browsers.
import * as THREE from 'three/webgpu';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import {
  geometryToMeshletAsset,
  NaniteRasterizer,
  type MeshletAsset,
} from '@/lib/three/experimental/nanite-rasterizer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_URL = '/models/building-lighthouse.glb?v=1';

// Single instance, centred at origin, scale=1.
const INSTANCE_DATA = new Float32Array([0, 0, 0, 1]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk the GLTF scene and return the first Mesh found, or null. */
function findFirstMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((obj) => {
    if (!found && (obj as THREE.Mesh).isMesh) {
      found = obj as THREE.Mesh;
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// RasterizerScene — inner R3F component
// ---------------------------------------------------------------------------

interface RasterizerSceneProps {
  asset: MeshletAsset;
  onFps: (fps: number) => void;
}

function RasterizerScene({ asset, onFps }: RasterizerSceneProps) {
  const { gl, size } = useThree();
  const rasterizerRef = useRef<NaniteRasterizer | null>(null);
  const readyRef = useRef(false);

  // Stable refs for the zero-alloc render path:
  const fpsFramesRef = useRef(0);
  const fpsAccRef = useRef(0);
  const fpsLastRef = useRef(performance.now());

  useEffect(() => {
    // gl from R3F may be typed as WebGLRenderer — assert our renderer type.
    const renderer = gl as unknown as THREE.WebGPURenderer;

    const opts = {
      instanceCount: 1,
      staticInstanceData: INSTANCE_DATA,
      maxRasterSize: 16,
    };

    const r = new NaniteRasterizer(renderer, asset, opts);
    rasterizerRef.current = r;
    readyRef.current = false;

    r.init().then(() => {
      readyRef.current = true;
    }).catch((err) => {
      console.error('[meshlet-spike] NaniteRasterizer.init() failed:', err);
    });

    return () => {
      readyRef.current = false;
      rasterizerRef.current = null;
      r.dispose();
    };
  }, [gl, asset]);

  useFrame((state) => {
    if (!readyRef.current || !rasterizerRef.current) return;

    const camera = state.camera as unknown as THREE.PerspectiveCamera;
    const w = size.width;
    const h = size.height;

    // Awaiting a promise inside useFrame is intentional for this spike.
    // The rasterizer's render() path only awaits the GPU compute dispatch
    // which WebGPU batches; the JS side returns in microtask time.
    // Production code would use a command-queue pattern instead.
    rasterizerRef.current.render(camera, w, h).catch((err) => {
      console.error('[meshlet-spike] render error:', err);
    });

    // FPS meter — accumulate and report once per second.
    fpsFramesRef.current += 1;
    const now = performance.now();
    const elapsed = now - fpsLastRef.current;
    if (elapsed >= 1000) {
      onFps(Math.round((fpsFramesRef.current * 1000) / elapsed));
      fpsFramesRef.current = 0;
      fpsLastRef.current = now;
    }
  });

  // No R3F scene content — rasterizer owns the framebuffer entirely.
  return null;
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function MeshletSpikePage() {
  const [webGpuAbsent] = useState<boolean>(() => {
    if (typeof navigator === 'undefined') return false;
    return !('gpu' in navigator);
  });

  const [asset, setAsset] = useState<MeshletAsset | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fps, setFps] = useState<number>(0);
  const [meshletInfo, setMeshletInfo] = useState<string>('');

  // Load the GLTF and convert to meshlet data.
  useEffect(() => {
    if (webGpuAbsent) return;

    const loader = new GLTFLoader();
    // building-lighthouse.glb (like most ClawVille building GLBs) is processed
    // through gltfpack -cc which emits EXT_meshopt_compression buffers. Without
    // the decoder the loader throws "setMeshoptDecoder must be called before
    // loading compressed files" at first buffer read.
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(
      MODEL_URL,
      (gltf) => {
        const mesh = findFirstMesh(gltf.scene);
        if (!mesh) {
          setLoadError('No Mesh found in lighthouse GLB scene graph.');
          return;
        }

        try {
          const a = geometryToMeshletAsset(mesh.geometry);
          const coarsestTris = a.lodTriCounts[a.lodCount - 1] ?? a.triangleCount;
          const reductionPct = a.triangleCount > 0
            ? Math.round((1 - coarsestTris / a.triangleCount) * 100)
            : 0;
          const lodSuffix = a.lodCount > 1
            ? ` · ${a.lodCount} LODs (→${reductionPct}% fewer tris)`
            : ' · 1 LOD (no simplification)';
          setMeshletInfo(
            `${a.totalVertices.toLocaleString()} verts · ` +
            `${a.triangleCount.toLocaleString()} tris · ` +
            `${a.totalChunks} chunks` +
            lodSuffix
          );
          setAsset(a);
        } catch (err) {
          setLoadError(`geometryToMeshletAsset failed: ${String(err)}`);
        }
      },
      undefined,
      (err) => {
        setLoadError(`GLB load failed: ${String(err)}`);
      }
    );
  }, [webGpuAbsent]);

  // R3F gl factory — WebGPU ONLY (no fallback on this spike page).
  const glFactory = useCallback(async ({ canvas }: { canvas: HTMLCanvasElement }) => {
    // Pre-stamp canvas dimensions to avoid 300×150 depth-buffer mismatch
    // (same pattern as World3DCanvas.tsx createWebGPURenderer).
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    const renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: false,
      forceWebGL: false, // WebGPU ONLY — caller already checked navigator.gpu
    });
    renderer.setPixelRatio(dpr);
    await renderer.init();
    renderer.setSize(rect.width, rect.height, false);
    return renderer;
  }, []);

  const handleFps = useCallback((f: number) => setFps(f), []);

  // --- Render ---

  if (webGpuAbsent) {
    return (
      <div style={styles.errorPage}>
        <div style={styles.errorBox}>
          <div style={styles.errorTitle}>WebGPU Not Available</div>
          <div style={styles.errorBody}>
            This spike page requires WebGPU. Enable it in chrome://flags or use
            Chrome 113+. The production rendering path has a WebGL fallback;
            this dev spike deliberately does not.
          </div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={styles.errorPage}>
        <div style={styles.errorBox}>
          <div style={styles.errorTitle}>Load Error</div>
          <div style={styles.errorBody}>{loadError}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      {/* R3F Canvas — drives the rasterizer via useFrame */}
      <Canvas
        gl={glFactory as any}
        frameloop="always"
        camera={{ position: [0, 8, 20], fov: 45 }}
        style={styles.canvas}
        // Suppress R3F's default scene clear — the rasterizer manages its own
        // framebuffer via a fullscreen quad.
        onCreated={({ gl: renderer }) => {
          (renderer as any).autoClear = false;
        }}
      >
        {asset && (
          <RasterizerScene asset={asset} onFps={handleFps} />
        )}
      </Canvas>

      {/* FPS overlay — plain HTML DOM, NOT drei <Text> (Iris Xe invariant) */}
      <div style={styles.overlay}>
        <div style={styles.overlayTitle}>Meshlet Spike</div>
        <div style={styles.overlayRow}>
          <span style={styles.overlayLabel}>FPS</span>
          <span style={styles.overlayValue}>{fps}</span>
        </div>
        {meshletInfo && (
          <div style={{ ...styles.overlayRow, marginTop: 4, fontSize: 11, opacity: 0.75 }}>
            {meshletInfo}
          </div>
        )}
        <div style={{ ...styles.overlayRow, marginTop: 4, fontSize: 11, opacity: 0.6 }}>
          {MODEL_URL.split('?')[0].split('/').pop()}
        </div>
        {!asset && (
          <div style={{ ...styles.overlayRow, marginTop: 8, color: '#facc15' }}>
            Loading geometry…
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Static styles (no Tailwind — this is a plain CSS-in-JS preview page)
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'fixed',
    inset: 0,
    background: '#0a0a0a',
  },
  canvas: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
  },
  overlay: {
    position: 'absolute',
    top: 12,
    left: 12,
    padding: '10px 14px',
    background: 'rgba(0,0,0,0.72)',
    color: '#ffffff',
    font: '13px/1.5 "Courier New", monospace',
    borderRadius: 8,
    backdropFilter: 'blur(4px)',
    minWidth: 220,
    pointerEvents: 'none',
  },
  overlayTitle: {
    fontWeight: 700,
    fontSize: 15,
    marginBottom: 6,
    letterSpacing: '0.02em',
  },
  overlayRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
  },
  overlayLabel: {
    opacity: 0.7,
  },
  overlayValue: {
    fontWeight: 600,
    color: '#4ade80',
  },
  errorPage: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0a0a0a',
    color: '#fff',
  },
  errorBox: {
    maxWidth: 480,
    padding: 32,
    background: '#1a1a1a',
    borderRadius: 12,
    border: '1px solid #333',
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: 700,
    marginBottom: 12,
    color: '#f87171',
  },
  errorBody: {
    fontSize: 14,
    lineHeight: 1.6,
    color: '#d1d5db',
  },
};
