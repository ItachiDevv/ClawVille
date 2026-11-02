/**
 * hydra-halo-node.ts — node-material (TSL) half of the Hydra halo shells.
 *
 * The world renders with WebGPURenderer (also in forceWebGL mode), which turns
 * the classic MeshBasicMaterial of hydra-halo.ts into a MeshBasicNodeMaterial
 * by copying its properties (NodeLibrary.fromMaterial) and never runs
 * onBeforeCompile. This decorator sets the node overrides that match the GLSL
 * hook in hydra-halo.ts:
 *   positionNode: skinned position + normalize(skinned normal) * aHaloPush
 *                 (NodeMaterial.setupPosition applies positionNode AFTER skinning)
 *   colorNode:    neon x dot(mask.rgb, aHaloSel)
 *   opacityNode:  min(1, aHaloGain * uHaloK)
 * Kept out of hydra-halo.ts because three/tsl must not load in the classic
 * WebGLRenderer preview page.
 */
import type * as THREE from 'three';
import { attribute, float, min, normalLocal, positionLocal, texture, uniform, uv, vec4 } from 'three/tsl';

export function decorateHydraHaloNode(material: THREE.MeshBasicMaterial): (k: number) => void {
  const k = uniform(0);
  const map = material.map!;
  const mask = texture(map, uv()).rgb.dot(attribute<'vec3'>('aHaloSel', 'vec3'));
  const neon = material.color; // linear neon set by hydra-halo.ts
  const node = material as THREE.MeshBasicMaterial & {
    positionNode: unknown;
    colorNode: unknown;
    opacityNode: unknown;
  };
  node.positionNode = positionLocal.add(normalLocal.normalize().mul(attribute<'float'>('aHaloPush', 'float')));
  node.colorNode = vec4(float(neon.r).mul(mask), float(neon.g).mul(mask), float(neon.b).mul(mask), 1);
  node.opacityNode = min(float(1), attribute<'float'>('aHaloGain', 'float').mul(k));
  return (value: number) => {
    k.value = value;
  };
}
