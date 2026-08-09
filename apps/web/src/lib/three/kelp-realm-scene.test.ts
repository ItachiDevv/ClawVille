import { describe, expect, test } from 'bun:test';
import * as THREE from 'three/webgpu';
import {
  KELP_REALM_DISCOVERY_TYPES,
  KELP_REALM_SPORE_BEACON_IDS,
} from '@clawville/shared';
import {
  createKelpRealmDiscoveryGeometry,
  createKelpRealmDiscoveryMaterial,
  createKelpRealmRayMaterial,
  createKelpRealmSporeGeometry,
  createKelpRealmSporeMaterial,
  KELP_REALM_SCENE_BUDGET,
  markKelpRealmSporeGeometryVisited,
} from './kelp-realm-scene';
import {
  cameraBoundarySegmentSafeT,
  parseKelpRealmBeaconVisitResponse,
} from './kelp-realm-player';

describe('Kelp Forest realm discoveries', () => {
  test('camera ignores interior kelp curtains but still clamps at the realm boundary', () => {
    expect(
      cameraBoundarySegmentSafeT(-4_800, -4_800, -3_600, -3_600, 435),
    ).toBe(1);
    expect(
      cameraBoundarySegmentSafeT(-4_800, -4_800, -4_800, -7_000, 435),
    ).toBeLessThan(1);
    expect(cameraBoundarySegmentSafeT(0, 6_000, 0, 6_560, 470)).toBe(1);
  });

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
    expect(KELP_REALM_SCENE_BUDGET.sporeDrawCalls).toBe(1);
    expect(KELP_REALM_SCENE_BUDGET.environmentDrawCalls).toBe(17);
    expect(KELP_REALM_SCENE_BUDGET.maxTotalDrawCallsIncludingAvatar).toBe(31);
    expect(KELP_REALM_SCENE_BUDGET.maxTotalDrawCallsIncludingAvatar)
      .toBeLessThanOrEqual(KELP_REALM_SCENE_BUDGET.hardTotalDrawCallCeiling);
    expect(KELP_REALM_SCENE_BUDGET.hardTotalDrawCallCeiling).toBe(32);
  });

  test('merges all three spore clusters into one backend-neutral additive draw', () => {
    expect(KELP_REALM_SPORE_BEACON_IDS).toHaveLength(3);
    const geometry = createKelpRealmSporeGeometry();
    const material = createKelpRealmSporeMaterial();
    try {
      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      const color = geometry.getAttribute('color') as THREE.BufferAttribute;
      expect(position.count).toBeGreaterThan(0);
      expect(color.count).toBe(position.count);
      expect(geometry.boundingBox?.isEmpty()).toBe(false);
      expect(Number.isFinite(geometry.boundingSphere?.radius)).toBe(true);
      expect(material.vertexColors).toBe(true);
      expect(material.blending).toBe(THREE.AdditiveBlending);
      expect(material.depthWrite).toBe(false);
      expect(material.fog).toBe(false);
      expect('isShaderMaterial' in material).toBe(false);

      const before = Array.from(color.array);
      const beforeVersion = color.version;
      markKelpRealmSporeGeometryVisited(geometry, KELP_REALM_SPORE_BEACON_IDS[0]!);
      const changedChannels = Array.from(color.array).filter((value, index) => value !== before[index]);
      expect(changedChannels.length).toBeGreaterThan(0);
      expect(changedChannels.length).toBeLessThan(color.array.length);
      expect(color.version).toBeGreaterThan(beforeVersion);
    } finally {
      geometry.dispose();
      material.dispose();
    }
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

  test('rejects malformed beacon progress before it can enter the token chain', () => {
    const valid = {
      token: 'signed-token',
      adjacent: [{ id: 'junction-1', kind: 'junction', bearingDeg: 90, distanceWu: 400 }],
      spores: { found: 1, total: 3 },
      spore: true,
    } as const;
    expect(parseKelpRealmBeaconVisitResponse(valid)).toEqual(valid);
    expect(parseKelpRealmBeaconVisitResponse({ ...valid, spores: { found: 1 } })).toBeNull();
    expect(parseKelpRealmBeaconVisitResponse({ ...valid, spores: { found: 4, total: 3 } })).toBeNull();
    expect(parseKelpRealmBeaconVisitResponse({ ...valid, unexpected: true })).toBeNull();
  });
});
