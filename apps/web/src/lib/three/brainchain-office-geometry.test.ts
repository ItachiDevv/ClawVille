import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { cloneOfficeSceneForGpu } from './brainchain-office-geometry';

describe('Office pre-upload attribute conversion', () => {
  test('preserves normalized positions, normals, UVs and transformed bounds without changing cached geometry', () => {
    const source = new THREE.Group();
    source.position.set(9, 4, -8);
    source.scale.set(2, 3, 4);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Int16Array([-32767, 0, 0, 0, 32767, 0, 0, 0, 32767]), 3, true));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Int8Array([0, 0, 127, 0, 127, 0, 127, 0, 0]), 3, true));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Uint16Array([0, 0, 65535, 0, 65535, 65535]), 2, true));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    source.add(mesh);
    const before = new THREE.Box3().setFromObject(source);
    const prepared = cloneOfficeSceneForGpu(source);
    const copied = (prepared.scene.children[0] as THREE.Mesh).geometry;
    for (const name of ['position', 'normal', 'uv']) {
      const original = geometry.getAttribute(name), next = copied.getAttribute(name);
      expect(next.array).toBeInstanceOf(Float32Array);
      expect(next.normalized).toBe(false);
      expect(next).not.toBe(original);
      for (let i = 0; i < original.count; i++) for (let c = 0; c < original.itemSize; c++) {
        expect(next.getComponent(i, c)).toBeCloseTo(original.getComponent(i, c), 6);
      }
    }
    expect(geometry.getAttribute('position').array).toBeInstanceOf(Int16Array);
    expect(geometry.getAttribute('normal').array).toBeInstanceOf(Int8Array);
    expect(geometry.getAttribute('uv').array).toBeInstanceOf(Uint16Array);
    const after = new THREE.Box3().setFromObject(prepared.scene);
    expect(after.min.distanceTo(before.min)).toBeLessThan(0.00001);
    expect(after.max.distanceTo(before.max)).toBeLessThan(0.00001);
    expect((prepared.scene.children[0] as THREE.Mesh).material).toBe(mesh.material);
    prepared.dispose();
  });

  test('allocates one clone per shared source geometry and disposes only that clone', () => {
    const geometry = new THREE.BoxGeometry();
    const source = new THREE.Group();
    source.add(new THREE.Mesh(geometry), new THREE.Mesh(geometry));
    const prepared = cloneOfficeSceneForGpu(source);
    const a = (prepared.scene.children[0] as THREE.Mesh).geometry;
    const b = (prepared.scene.children[1] as THREE.Mesh).geometry;
    expect(a).toBe(b);
    expect(a).not.toBe(geometry);
    let cloneDisposals = 0, sourceDisposals = 0;
    a.addEventListener('dispose', () => { cloneDisposals++; });
    geometry.addEventListener('dispose', () => { sourceDisposals++; });
    prepared.dispose();
    expect(cloneDisposals).toBe(1);
    expect(sourceDisposals).toBe(0);
  });
});
