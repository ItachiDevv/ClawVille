import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { makeObject3DWebGPUSafe } from '../webgpu-geometry';

// Pins the r185 WebGPU sampler trap fix (3dStructure.md §5a): no material texture may stay
// minFilter === magFilter === NearestFilter after makeObject3DWebGPUSafe().
function nearest<T extends THREE.Texture>(texture: T): T {
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  return texture;
}

const mip = (): THREE.CompressedTextureMipmap => ({ data: new Uint8Array(4), width: 1, height: 1 });

function compressed(levels: number): THREE.CompressedTexture {
  return nearest(
    new THREE.CompressedTexture(Array.from({ length: levels }, mip), 4, 4, THREE.RGBA_ASTC_4x4_Format),
  );
}

function plain(generateMipmaps: boolean): THREE.Texture {
  const texture = nearest(new THREE.Texture());
  texture.generateMipmaps = generateMipmaps;
  return texture;
}

function run(object: THREE.Object3D): void {
  const root = new THREE.Group();
  root.add(object);
  makeObject3DWebGPUSafe(root);
}

describe('makeObject3DWebGPUSafe texture filters', () => {
  test('CompressedTexture with embedded mips -> NearestMipmapNearest, mag unchanged', () => {
    const map = compressed(6);
    run(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map })));
    expect(map.minFilter).toBe(THREE.NearestMipmapNearestFilter);
    expect(map.magFilter).toBe(THREE.NearestFilter);
  });

  test('CompressedTexture with one level -> LinearFilter (no mips can be generated)', () => {
    const map = compressed(1);
    map.generateMipmaps = true;
    run(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map })));
    expect(map.minFilter).toBe(THREE.LinearFilter);
  });

  test('plain Texture with generateMipmaps true -> NearestMipmapNearest', () => {
    const map = plain(true);
    run(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map })));
    expect(map.minFilter).toBe(THREE.NearestMipmapNearestFilter);
  });

  test('plain Texture with generateMipmaps false -> LinearFilter', () => {
    const map = plain(false);
    run(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map })));
    expect(map.minFilter).toBe(THREE.LinearFilter);
    expect(map.magFilter).toBe(THREE.NearestFilter);
  });

  test('Points, Line and Sprite materials are covered, including material arrays', () => {
    const pointsMap = plain(false);
    const lineMap = plain(false);
    const spriteMap = plain(false);
    const arrayMap = plain(false);
    run(new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: pointsMap })));
    run(new THREE.Line(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: lineMap })));
    run(new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteMap })));
    run(new THREE.Mesh(new THREE.BoxGeometry(), [
      new THREE.MeshBasicMaterial(),
      new THREE.MeshBasicMaterial({ map: arrayMap }),
    ]));
    for (const t of [pointsMap, lineMap, spriteMap, arrayMap]) expect(t.minFilter).toBe(THREE.LinearFilter);
  });

  test('already-uploaded texture (version > 0) gets needsUpdate; version 0 is not marked ready', () => {
    const ready = plain(true);
    ready.needsUpdate = true; // loaders do this when data arrives
    const readyVersion = ready.version;
    const pending = plain(true);
    run(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: ready, aoMap: pending })));
    expect(ready.version).toBe(readyVersion + 1);
    expect(pending.version).toBe(0);
    expect(pending.minFilter).toBe(THREE.NearestMipmapNearestFilter);
  });

  test('a shared texture is changed once; linear and depth textures are left alone', () => {
    const shared = plain(true);
    shared.needsUpdate = true;
    const linear = new THREE.Texture();
    const depth = nearest(new THREE.DepthTexture(4, 4));
    const material = new THREE.MeshStandardMaterial({ map: shared, emissiveMap: linear, alphaMap: depth });
    run(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const afterFirst = shared.version;
    run(new THREE.Mesh(new THREE.BoxGeometry(), material));
    expect(shared.version).toBe(afterFirst);
    expect(linear.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(linear.magFilter).toBe(THREE.LinearFilter);
    expect(depth.minFilter).toBe(THREE.NearestFilter);
    expect(depth.magFilter).toBe(THREE.NearestFilter);
  });
});
