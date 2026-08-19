// resource-ledger-sync-culling.test.ts — slice E [R2-10]: the SYNC culling
// override must restore flags even when the task throws, must be atomic (no
// awaits — verified structurally by it accepting a sync task), and must
// no-op for an unregistered scene.
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  registerStageSlotRoot,
  withStageSlotFrustumCullingDisabledSync,
} from './resource-ledger';

const makeRoot = () => {
  const root = new THREE.Group();
  const culled = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  culled.frustumCulled = true;
  const alreadyUnculled = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  alreadyUnculled.frustumCulled = false;
  root.add(culled, alreadyUnculled);
  return { root, culled, alreadyUnculled };
};

describe('withStageSlotFrustumCullingDisabledSync', () => {
  test('disables inside the window and restores after, preserving pre-false flags', () => {
    const { root, culled, alreadyUnculled } = makeRoot();
    registerStageSlotRoot('sync-test', root);
    try {
      const seen: { insideCulled: boolean | null } = { insideCulled: null };
      const out = withStageSlotFrustumCullingDisabledSync('sync-test', () => {
        seen.insideCulled = culled.frustumCulled;
        return 42;
      });
      expect(out).toBe(42);
      expect(seen.insideCulled).toBe(false);
      expect(culled.frustumCulled).toBe(true); // restored
      expect(alreadyUnculled.frustumCulled).toBe(false); // never touched
    } finally {
      registerStageSlotRoot('sync-test', null);
    }
  });

  test('restores flags when the task throws [R2-10]', () => {
    const { root, culled } = makeRoot();
    registerStageSlotRoot('sync-test-throw', root);
    try {
      expect(() =>
        withStageSlotFrustumCullingDisabledSync('sync-test-throw', () => {
          throw new Error('front exploded');
        }),
      ).toThrow('front exploded');
      expect(culled.frustumCulled).toBe(true);
    } finally {
      registerStageSlotRoot('sync-test-throw', null);
    }
  });

  test('unregistered scene runs the task without touching anything', () => {
    const { culled } = makeRoot();
    const out = withStageSlotFrustumCullingDisabledSync('nope-never-registered', () => 7);
    expect(out).toBe(7);
    expect(culled.frustumCulled).toBe(true);
  });
});
