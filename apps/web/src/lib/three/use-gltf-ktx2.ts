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
import type { ObjectMap } from '@react-three/fiber';
import * as THREE from 'three';
import type { GLTF } from 'three-stdlib';
import { extendLoaderWithKTX2 } from './ktx2-loader-setup';
import { extendLoaderWithMeshopt } from './meshopt-loader-setup';
import { CURRENT_WORLD_DEVICE_PROFILE } from './device-class';
import { downscaleTextureForDevice } from './downscale-texture-for-device';
import { getLastGlbLoadFailure, installGlbFetchRetry, readOptionalGltf } from './glb-fetch-retry';
import { isModelLoadError, ModelLoadError } from './model-load-error';

type GLTFResult = GLTF & ObjectMap;
const TEXTURE_CAP_LOADERS = new WeakSet<object>();

function collectMaterialTextures(
  material: THREE.Material,
  textures: Set<THREE.Texture>,
): void {
  for (const value of Object.values(
    material as unknown as Record<string, unknown>,
  )) {
    if (value instanceof THREE.Texture) textures.add(value);
  }

  const shaderMaterial = material as THREE.ShaderMaterial;
  if (!shaderMaterial.isShaderMaterial) return;
  for (const uniform of Object.values(shaderMaterial.uniforms)) {
    const value = (uniform as { value?: unknown }).value;
    if (value instanceof THREE.Texture) textures.add(value);
  }
}

async function capUncompressedGltfTextures(gltf: GLTF): Promise<void> {
  const maxSize = CURRENT_WORLD_DEVICE_PROFILE.maxUncompressedTextureSize;
  if (maxSize === null) return;

  try {
    const textures = new Set<THREE.Texture>();
    const materials = new Set<THREE.Material>();
    const scenes = gltf.scenes.length > 0 ? gltf.scenes : [gltf.scene];
    for (const scene of scenes) {
      scene.traverse((object) => {
        const material = (object as THREE.Mesh).material;
        if (!material) return;
        const materialList = Array.isArray(material) ? material : [material];
        for (const entry of materialList) {
          if (!entry || materials.has(entry)) continue;
          materials.add(entry);
          collectMaterialTextures(entry, textures);
        }
      });
    }

    await Promise.allSettled(
      Array.from(textures, (texture) =>
        downscaleTextureForDevice(texture, maxSize),
      ),
    );
  } catch {
    // Texture reduction must never reject the GLTFLoader render path.
  }
}

export function extendLoaderWithTextureDeviceCap(
  loader: Parameters<typeof extendLoaderWithKTX2>[0],
): void {
  if (CURRENT_WORLD_DEVICE_PROFILE.maxUncompressedTextureSize === null) return;
  if (TEXTURE_CAP_LOADERS.has(loader)) return;
  TEXTURE_CAP_LOADERS.add(loader);
  loader.register(() => ({
    name: 'ClawVilleTextureDeviceCap',
    afterRoot: capUncompressedGltfTextures,
  }));
}

export function extendLoaderWithMeshoptAndTextureDeviceCap(
  loader: Parameters<typeof extendLoaderWithKTX2>[0],
): void {
  void extendLoaderWithMeshopt(loader);
  extendLoaderWithTextureDeviceCap(loader);
  installGlbFetchRetry(loader);
}

function extendLoaderForWorldTextures(
  loader: Parameters<typeof extendLoaderWithKTX2>[0],
): void {
  extendLoaderWithKTX2(loader);
  extendLoaderWithTextureDeviceCap(loader);
  // R3F shares ONE GLTFLoader instance per constructor, so this request
  // retry also covers plain useGLTF calls once any world-texture load ran.
  installGlbFetchRetry(loader);
}

/**
 * useGLTF with KTX2Loader attached.
 * Signature mirrors drei's useGLTF — path can be a string or string[].
 */
export function useGLTFWithKTX2(path: string): GLTFResult;
export function useGLTFWithKTX2(path: string[]): GLTFResult[];
export function useGLTFWithKTX2(path: string | string[]): GLTFResult | GLTFResult[] {
  try {
    if (typeof path === 'string') {
      return useGLTF(path, true, true, extendLoaderForWorldTextures);
    }
    return useGLTF(path, true, true, extendLoaderForWorldTextures);
  } catch (thrown) {
    throw tagGltfLoadRejection(thrown, path);
  }
}

/**
 * NON-HOOK read of the exact cache entry `useGLTFWithKTX2(path)` reads: the
 * SAME drei call, so the same suspend-react key ([GLTFLoader, path]) and the
 * same loader extender. For `warmSuspenseRead` (suspense-cache-warm.ts) only:
 * it runs OUTSIDE render, before a boot-critical member's release, so the
 * member's first render reads a resolved entry and never needs a Suspense
 * retry (web-load T7). Safe outside render because drei useGLTF / R3F 9.5
 * useLoader call no React hook (guarded by suspense-cache-warm.test.ts).
 * Throws the entry promise while loading and the cached Error on failure.
 */
export function readGLTFWithKTX2(path: string): GLTFResult {
  return useGLTF(path, true, true, extendLoaderForWorldTextures);
}

/**
 * R3F rejection errors whose cache entry was already evicted. suspend-react
 * stores ONE Error per failed entry and rethrows that same object on every
 * read, so the object identifies the entry. Only the FIRST clear() for it
 * evicts; a later clear() of any error from the same entry is a no-op, so a
 * NEWER entry for the key (a remount, useGLTF.preload, or any other caller)
 * is never evicted by a stale error. Sound because ModelLoadError.clear() is
 * the only code in apps/web that evicts GLB cache entries (the unused
 * useGLTFWithKTX2.clear export was deleted so it stays that way): when the
 * first clear() runs, the failed entry is still the cached one. A new
 * useGLTF.clear caller must keep this invariant.
 */
const EVICTED_REJECTIONS = new WeakSet<Error>();

/**
 * R3F useLoader caches a failed load and rethrows it as
 * `new Error("Could not load <input>: <message>")` (its loadingFn; no hook to
 * tag it). This hook is the first code we own that sees it, so the tag is
 * made HERE, for exactly the requested path(s): a ModelLoadError (same
 * message) carrying the original loader error + phase from glb-fetch-retry.
 *
 * - A NEW ModelLoadError per throw: two figures reading one cached rejection
 *   get two objects, so each boundary catch owns its own one-shot report
 *   cancel (ModelLoadBoundary).
 * - `clear()` evicts the cache entry with the SAME key the load used (the
 *   string, or the whole array), once per failed entry (EVICTED_REJECTIONS),
 *   so an old error never evicts a newer entry another figure awaits.
 * Thrown promises (Suspense) and any other error pass through unchanged.
 */
function tagGltfLoadRejection(thrown: unknown, path: string | string[]): unknown {
  if (!(thrown instanceof Error) || isModelLoadError(thrown)) return thrown;
  const paths = typeof path === 'string' ? [path] : path;
  const url = paths.find((p) => thrown.message.startsWith(`Could not load ${p}: `));
  if (url === undefined) return thrown;
  const failure = getLastGlbLoadFailure(url);
  return new ModelLoadError({
    url,
    phase: failure?.phase ?? 'unknown',
    original: failure?.error ?? thrown,
    message: thrown.message,
    clear: () => {
      if (EVICTED_REJECTIONS.has(thrown)) return;
      EVICTED_REJECTIONS.add(thrown);
      useGLTF.clear(path);
    },
  });
}

/**
 * useGLTFWithKTX2 for an OPTIONAL model. Returns null when THIS path failed
 * for any reason (request failure after the loader's retries, or a parse /
 * decode error), so the caller skips that model instead of crashing the
 * whole canvas. Fails visible: one console.error per path with the original
 * error class, message and phase. Still suspends while loading; any other
 * error is rethrown. Required models must keep useGLTFWithKTX2.
 */
export function useOptionalGLTFWithKTX2(path: string): GLTFResult | null {
  return readOptionalGltf(path, () => useGLTFWithKTX2(path));
}

/**
 * Preload a GLB with KTX2Loader attached.
 * Call at module level (same as useGLTF.preload) before the Canvas mounts.
 */
useGLTFWithKTX2.preload = (path: string | string[]) => {
  useGLTF.preload(path, true, true, extendLoaderForWorldTextures);
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

