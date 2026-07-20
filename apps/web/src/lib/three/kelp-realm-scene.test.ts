import { describe, expect, test } from 'bun:test';
import * as THREE from 'three/webgpu';
import { KELP_REALM_DISCOVERY_TYPES } from '@clawville/shared';
import {
  createKelpRealmDiscoveryGeometry,
  createKelpRealmDiscoveryMaterial,
  createKelpRealmRayMaterial,
  KELP_REALM_SCENE_BUDGET,
} from './kelp-realm-scene';

describe('Kelp Forest realm discoveries', () => {
  test('constructs one deterministic merged animated geometry per discovery type', () => {
    for (const type of KELP_REALM_DISCOVERY_TYPES) {
      const first = createKelpRealmDiscoveryGeometry(type);
      const second = createKelpRealmDiscoveryGeometry(type);
      try {
        const firstPosition = first.getAttribute('position') as THREE.BufferAttribute;
        const secondPosition = second.getAttribute('position') as THREE.BufferAttribute;
        expect(firstPosition.count).toBeGreaterThan(0);
        expect(secondPosition.count).toBe(firstPosition.count);
        for (const attributeName of [
          'aDiscoveryPhase',
          'aDiscoveryWeight',
          'aDiscoveryBubble',
          'aDiscoveryProgress',
        ]) {
          expect(first.getAttribute(attributeName)?.count).toBe(firstPosition.count);
        }
        const sampleStride = Math.max(1, Math.floor(firstPosition.array.length / 31));
        for (let index = 0; index < firstPosition.array.length; index += sampleStride) {
          expect(firstPosition.array[index]).toBe(secondPosition.array[index]);
        }
        expect(first.boundingBox?.isEmpty()).toBe(false);
        expect(Number.isFinite(first.boundingSphere?.radius)).toBe(true);
      } finally {
        first.dispose();
        second.dispose();
      }
    }
  });

  test('pins exactly three discovery draws under the raised realm ceiling', () => {
    expect(KELP_REALM_SCENE_BUDGET.discoveryDrawCalls).toBe(3);
    expect(KELP_REALM_SCENE_BUDGET.environmentDrawCalls).toBe(13);
    expect(KELP_REALM_SCENE_BUDGET.maxTotalDrawCallsIncludingAvatar).toBe(27);
    expect(KELP_REALM_SCENE_BUDGET.maxTotalDrawCallsIncludingAvatar)
      .toBeLessThanOrEqual(KELP_REALM_SCENE_BUDGET.hardTotalDrawCallCeiling);
    expect(KELP_REALM_SCENE_BUDGET.hardTotalDrawCallCeiling).toBe(32);
  });

  test('forces transparent double-sided glow materials into one pass', () => {
    const materials: THREE.Material[] = [createKelpRealmRayMaterial()];
    for (const type of KELP_REALM_DISCOVERY_TYPES) {
      materials.push(createKelpRealmDiscoveryMaterial(type, false).material);
      materials.push(createKelpRealmDiscoveryMaterial(type, true).material);
    }
    try {
      for (const material of materials) {
        expect(material.transparent).toBe(true);
        expect(material.side).toBe(THREE.DoubleSide);
        expect(material.depthWrite).toBe(false);
        expect(material.blending).toBe(THREE.AdditiveBlending);
        expect(material.forceSinglePass).toBe(true);
      }
    } finally {
      for (const material of materials) material.dispose();
    }
  });
});
