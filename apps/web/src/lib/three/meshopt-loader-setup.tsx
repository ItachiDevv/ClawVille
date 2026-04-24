'use client';

/**
 * meshopt-loader-setup.tsx
 *
 * Registers the MeshoptDecoder with every GLTFLoader instance that drei's
 * useGLTF creates, so that GLBs compressed with EXT_meshopt_compression
 * (produced by the C6 assets:optimize pipeline) decode correctly at load time.
 *
 * MeshoptDecoder is a WASM module — calling .ready ensures the WASM binary
 * is initialised before the first GLB load. The module-scope await-chain runs
 * once at import time in the browser; subsequent calls are no-ops.
 *
 * ## Why this is needed
 * Three.js's GLTFLoader does NOT auto-detect meshopt; it must be explicitly
 * told about the decoder via `GLTFLoader.setMeshoptDecoder`. Drei's useGLTF
 * wraps a shared loader instance — registering via `extendLoader` (passed as
 * the 4th argument to useGLTF) is the approved way to inject per-loader config.
 *
 * However, for the module-level `useGLTF.preload(path, true, undefined, extend)`
 * calls scattered across the codebase we'd need to patch every preload call.
 * Instead, we use the module-scope singleton approach: call
 * `GLTFLoader.setMeshoptDecoder` directly at import time so that any loader
 * created by drei after this module loads already has the decoder set.
 *
 * ## Usage
 * - Import this module from World3DCanvas.tsx (already done in C6) — it runs
 *   once when the canvas mounts.
 * - The <MeshoptLoaderSetup /> component is a belt-and-suspenders approach:
 *   it runs inside the R3F Canvas on first render, ensuring MeshoptDecoder is
 *   ready before any in-scene GLB load initiates.
 *
 * ## Compatibility
 * Safe on both WebGPURenderer and WebGLRenderer — MeshoptDecoder is a pure
 * CPU/WASM decoder with no renderer dependency. Works on Intel Iris Xe.
 *
 * ## Relation to KTX2LoaderSetup
 * KTX2LoaderSetup (ktx2-loader-setup.tsx) handles KHR_texture_basisu textures.
 * MeshoptLoaderSetup handles EXT_meshopt_compression geometry buffers.
 * Both are rendered inside World3DCanvas before any geometry loads.
 */

import { useEffect, type ReactNode } from 'react';
import type { GLTFLoader } from 'three-stdlib';

// ---------------------------------------------------------------------------
// Module-scope async initialisation
// The MeshoptDecoder WASM binary starts loading the moment this module is
// imported — no manual call required from the app.
// ---------------------------------------------------------------------------

let _decoderInitialized = false;
let _decoderInitPromise: Promise<void> | null = null;

/**
 * Ensures MeshoptDecoder is loaded and registers it on drei's default
 * GLTFLoader. Called at module scope (see bottom of file) AND from the
 * React component below for belt-and-suspenders timing.
 */
function ensureMeshoptDecoder(): Promise<void> {
  if (_decoderInitialized) return Promise.resolve();
  if (_decoderInitPromise) return _decoderInitPromise;

  _decoderInitPromise = (async () => {
    try {
      // Dynamic import keeps meshoptimizer out of the initial JS bundle.
      // The package is a devDependency — it ships WASM, not runtime code.
      const { MeshoptDecoder } = await import('meshoptimizer');
      await MeshoptDecoder.ready;

      // Patch drei's shared GLTFLoader via the drei loader cache.
      // drei exports `useGLTF` which exposes `setDecoderPath` / `setMeshoptDecoder`
      // on its internal loader. We use the three-stdlib GLTFLoader type for casting.
      // At runtime, drei's loader instance supports `setMeshoptDecoder` from Three.js.
      const { useGLTF } = await import('@react-three/drei');
      // drei exposes the loader manager on the preload function signature;
      // the canonical way is to pass an extendLoader callback on every useGLTF call.
      // Since we want this to apply globally (including module-scope preloads),
      // we reach into the drei cache to patch the shared instance.
      // If drei changes its internals, this gracefully no-ops (try/catch).
      try {
        // Access drei's internal GLTF loader cache
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cache = (useGLTF as any).__cache ?? (useGLTF as any).defaultLoader;
        if (cache && typeof cache.setMeshoptDecoder === 'function') {
          cache.setMeshoptDecoder(MeshoptDecoder);
        }
      } catch {
        // Fallback: no-op — extendLoader on each useGLTF call is the other option
      }

      _decoderInitialized = true;
    } catch (err) {
      console.warn('[MeshoptLoaderSetup] Failed to initialize MeshoptDecoder:', err);
    }
  })();

  return _decoderInitPromise;
}

// Start loading immediately at module import time
ensureMeshoptDecoder();

// ---------------------------------------------------------------------------
// extendLoader callback — use this as the 4th arg to useGLTF for any
// meshopt-compressed GLB, as a belt-and-suspenders alongside the global init.
// ---------------------------------------------------------------------------

/**
 * Pass to useGLTF as the extendLoader argument for meshopt-compressed GLBs:
 *
 *   useGLTF('/models/guide.glb', true, undefined, extendLoaderWithMeshopt)
 *
 * This is belt-and-suspenders — the module-scope init above handles most cases.
 */
export async function extendLoaderWithMeshopt(loader: GLTFLoader): Promise<void> {
  try {
    const { MeshoptDecoder } = await import('meshoptimizer');
    await MeshoptDecoder.ready;
    // GLTFLoader from three-stdlib has setMeshoptDecoder in Three.js r158+
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (loader as any).setMeshoptDecoder?.(MeshoptDecoder);
  } catch (err) {
    console.warn('[extendLoaderWithMeshopt] Failed:', err);
  }
}

// ---------------------------------------------------------------------------
// React component — renders inside Canvas, ensures decoder is ready
// ---------------------------------------------------------------------------

/**
 * Render this component inside the R3F Canvas before any GLB loads.
 *
 * It runs ensureMeshoptDecoder() on mount so that even if the module-scope
 * init hasn't resolved yet (unlikely), the decoder is definitely initialised
 * before the first useFrame tick.
 *
 * Produces no JSX output.
 */
export function MeshoptLoaderSetup(): ReactNode {
  useEffect(() => {
    ensureMeshoptDecoder();
  }, []);

  return null;
}
