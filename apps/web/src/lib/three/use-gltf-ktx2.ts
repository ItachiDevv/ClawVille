/**
 * use-gltf-ktx2.ts
 *
 * Drop-in replacement for drei's useGLTF that attaches the KTX2Loader
 * singleton to the underlying GLTFLoader so KHR_texture_basisu textures
 * are transcoded off-main-thread via the WASM worker.
 *
 * Usage:
 *   import { useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';
 *   const { scene } = useGLTFWithKTX2('/models/mymodel.glb');
 *
 * Requirements:
 *   - <KTX2LoaderSetup /> must be rendered inside the same Canvas before
 *     any useGLTFWithKTX2 calls attempt to load a GLB.
 *   - The model must contain KHR_texture_basisu textures (KTX2-compressed).
 *     For GLBs with WebP or PNG textures useGLTF is fine as-is.
 *
 * Historical GLB compatibility note:
 *   gltf-transform 4.3.0 failed to process some GLBs that have both
 *   KHR_materials_clearcoat AND KHR_draco_mesh_compression (parse error:
 *   "Cannot read properties of undefined (reading 'source')"). The current
 *   compress-ktx2.ts pipeline processes characters/spongebob.glb successfully;
 *   use an alternative path or skip only if another asset reproduces the old
 *   parser limitation.
 */

import { useGLTF } from '@react-three/drei';
import type { GLTF } from 'three-stdlib';
import { extendLoaderWithKTX2 } from './ktx2-loader-setup';

type GLTFResult = GLTF & Record<string, unknown>;

/**
 * useGLTF with KTX2Loader attached.
 * Signature mirrors drei's useGLTF — path can be a string or string[].
 */
export function useGLTFWithKTX2(path: string): GLTFResult;
export function useGLTFWithKTX2(path: string[]): GLTFResult[];
export function useGLTFWithKTX2(path: string | string[]): GLTFResult | GLTFResult[] {
  return useGLTF(path as any, true, true, extendLoaderWithKTX2) as any;
}

/**
 * Preload a GLB with KTX2Loader attached.
 * Call at module level (same as useGLTF.preload) before the Canvas mounts.
 */
useGLTFWithKTX2.preload = (path: string | string[]) => {
  useGLTF.preload(path as any, true, true, extendLoaderWithKTX2);
};

/**
 * Warm the browser HTTP cache for KTX2 GLBs without parsing them. Use this
 * before <KTX2LoaderSetup /> exists, such as page-level boot preloads.
 */
export function preloadKTX2Bytes(path: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  // Returns the SETTLED fetch (never rejects) so slice-D boot-actor fetch
  // units can observe terminal state; existing void callers are unaffected.
  return fetch(path, { cache: 'force-cache' }).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Clear a GLB from the loader cache.
 */
useGLTFWithKTX2.clear = (path: string | string[]) => {
  useGLTF.clear(path as any);
};
