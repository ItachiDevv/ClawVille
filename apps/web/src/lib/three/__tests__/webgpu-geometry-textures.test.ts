import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { makeObject3DWebGPUSafe } from '../webgpu-geometry';

// Pins the r185 WebGPU sampler trap fix (3dStructure.md §5a): no material texture may stay
// minFilter === magFilter === NearestFilter after makeObject3DWebGPUSafe().
function nearestTexture(mipLevels: number): THREE.Texture {
  const texture = new THREE.Texture();
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.mipmaps = Array.from({ length: mipLevels }, () => ({ data: new Uint8Array(4), width: 1, height: 1 }));
  return texture;
}

describe('makeObject3DWebGPUSafe texture filters', () => {
  test('nearest textures become filterable and keep a nearest look', () => {
    const map = nearestTexture(6);
    const roughnessMap = nearestTexture(0);
    const linear = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({ map, roughnessMap, emissiveMap: linear });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), [material, material]));

    makeObject3DWebGPUSafe(root);

    expect(map.minFilter).toBe(THREE.NearestMipmapNearestFilter);
    expect(map.magFilter).toBe(THREE.NearestFilter);
    expect(roughnessMap.minFilter).toBe(THREE.LinearFilter);
    expect(roughnessMap.magFilter).toBe(THREE.NearestFilter);
    expect(linear.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(linear.magFilter).toBe(THREE.LinearFilter);
  });
});
