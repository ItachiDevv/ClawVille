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
}

function extendLoaderForWorldTextures(
  loader: Parameters<typeof extendLoaderWithKTX2>[0],
): void {
  extendLoaderWithKTX2(loader);
  extendLoaderWithTextureDeviceCap(loader);
}

/**
 * useGLTF with KTX2Loader attached.
 * Signature mirrors drei's useGLTF — path can be a string or string[].
 */
export function useGLTFWithKTX2(path: string): GLTFResult;
export function useGLTFWithKTX2(path: string[]): GLTFResult[];
export function useGLTFWithKTX2(path: string | string[]): GLTFResult | GLTFResult[] {
  if (typeof path === 'string') {
    return useGLTF(path, true, true, extendLoaderForWorldTextures);
  }
  return useGLTF(path, true, true, extendLoaderForWorldTextures);
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

/**
 * Clear a GLB from the loader cache.
 */
useGLTFWithKTX2.clear = (path: string | string[]) => {
  useGLTF.clear(path);
};
