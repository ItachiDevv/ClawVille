import * as THREE from 'three';

/** Office-only compatibility: normalize and unpack attributes before the first WebGPU upload. */
export function cloneOfficeSceneForGpu(source: THREE.Object3D): { scene: THREE.Object3D; dispose: () => void } {
  const scene = source.clone(true);
  const geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  scene.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const mesh = object as THREE.Mesh;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) throw new Error('Office geometry must be static');
    const original = mesh.geometry;
    let geometry = geometries.get(original);
    if (!geometry) {
      geometry = original.clone();
      for (const name of ['position', 'normal', 'uv']) {
        const attribute = original.getAttribute(name);
        if (!attribute) continue;
        const values = new Float32Array(attribute.count * attribute.itemSize);
        for (let index = 0; index < attribute.count; index++) {
          for (let component = 0; component < attribute.itemSize; component++) {
            values[index * attribute.itemSize + component] = attribute.getComponent(index, component);
          }
        }
        geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, attribute.itemSize));
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      geometries.set(original, geometry);
    }
    mesh.geometry = geometry;
  });
  return { scene, dispose: () => { for (const geometry of geometries.values()) geometry.dispose(); } };
}
