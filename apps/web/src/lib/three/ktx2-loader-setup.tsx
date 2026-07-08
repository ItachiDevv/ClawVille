'use client';

/**
 * ktx2-loader-setup.tsx
 *
 * Provides a module-level KTX2Loader singleton and a React component that
 * initialises it against the current renderer (WebGPU or WebGL).
 *
 * KTX2Loader lives in three/examples/jsm/loaders/KTX2Loader (re-exported via
 * three-stdlib, which drei uses internally). It handles the KHR_texture_basisu
 * GLTF extension — textures are transcoded off-main-thread by a WASM worker and
 * uploaded to the GPU in BC7/ASTC/ETC2 format depending on hardware support.
 *
 * On Intel Iris Xe (desktop/laptop) with WebGPU: BC7 (BPTC) is used.
 * With the WebGL2 fallback: BPTC_RGBA extension selects BC7 if available,
 * otherwise falls back to RGBA8.
 *
 * detectSupport(renderer) in Three.js r182 handles both WebGPURenderer
 * (via renderer.hasFeature()) and WebGLRenderer (via renderer.extensions.has())
 * without requiring a throwaway context.
 *
 * The basis transcoder WASM is served from /basis/ (copied from
 * node_modules/three/examples/jsm/libs/basis/ in the compress-ktx2 script).
 *
 * Usage:
 *   - Render <KTX2LoaderSetup /> inside a Canvas (before any useGLTF calls)
 *   - Import useGLTFWithKTX2 instead of useGLTF for any GLB with KTX2 textures
 */

import { type ReactNode } from 'react';
import { useThree } from '@react-three/fiber';
// Use Three.js r182's KTX2Loader (not three-stdlib's) — it has detectSupport()
// with proper WebGPURenderer support via renderer.hasFeature().
// three-stdlib's KTX2Loader only checks renderer.extensions.has() (WebGL only).
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { GLTFLoader } from 'three-stdlib';

// ---------------------------------------------------------------------------
// Module-level singleton — shared across all useGLTF calls in the same page
// ---------------------------------------------------------------------------

let _ktx2Loader: KTX2Loader | null = null;

/**
 * Returns the initialised KTX2Loader singleton, or null if not yet ready.
 * Called by useGLTFWithKTX2's extendLoader callback.
 */
export function getKTX2Loader(): KTX2Loader | null {
  return _ktx2Loader;
}

/**
 * extendLoader callback — passed as the 4th arg to useGLTF / useGLTF.preload.
 * Attaches the KTX2Loader to the GLTFLoader instance so KHR_texture_basisu
 * textures are decoded via the WASM worker rather than the main thread.
 * Matches drei's ExtendLoader type: (loader: GLTFLoader) => void.
 * Safe to call before KTX2Loader is initialised — silently no-ops.
 */
export function extendLoaderWithKTX2(loader: GLTFLoader): void {
  if (_ktx2Loader) {
    // three-stdlib's setKTX2Loader expects its own KTX2Loader type;
    // we're passing three/addons KTX2Loader which is structurally identical
    // at runtime — cast suppresses the nominal type mismatch.
    loader.setKTX2Loader(_ktx2Loader as any);
  }
}

// ---------------------------------------------------------------------------
// KTX2LoaderSetup — renders inside Canvas, initialises _ktx2Loader once
// ---------------------------------------------------------------------------

/**
 * Render this component inside the R3F Canvas before any GLB loads.
 * It accesses the renderer via useThree and calls detectSupport(gl) so the
 * transcoder knows which GPU compressed formats are available.
 *
 * Runs once on mount; no JSX output.
 */
export function KTX2LoaderSetup(): ReactNode {
  const { gl } = useThree();

  if (!_ktx2Loader) {

    const loader = new KTX2Loader();
    loader.setTranscoderPath('/basis/');

    // detectSupport accepts both WebGPURenderer (via hasFeature) and
    // WebGLRenderer (via extensions.has) since Three.js r182.
    loader.detectSupport(gl as any);

    _ktx2Loader = loader;
  }

  return null;
}
