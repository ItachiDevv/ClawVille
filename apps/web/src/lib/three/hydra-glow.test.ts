import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  HYDRA_ANIMATOR_ID,
  HYDRA_GLOW_STEADY_INTENSITY,
  NO_HYDRA_GLOW_MATERIALS,
  hydraGlowIntensity,
  prepareHydraGlow,
  updateHydraGlow,
} from './hydra-glow';

const PERIOD_S = 1 / 0.55;

function makeHydraLikeScene() {
  const glowMask = new THREE.Texture();
  const glowMat = new THREE.MeshStandardMaterial({
    emissive: new THREE.Color(1, 1, 1),
    emissiveMap: glowMask,
  });
  const plainMat = new THREE.MeshStandardMaterial();
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BufferGeometry(), glowMat);
  // Same material on a second mesh must be collected once.
  const bodyTwin = new THREE.Mesh(new THREE.BufferGeometry(), glowMat);
  const multi = new THREE.Mesh(new THREE.BufferGeometry(), [plainMat, glowMat]);
  root.add(body, bodyTwin, multi);
  return { root, glowMat, plainMat };
}

describe('hydraGlowIntensity', () => {
  test('matches 0.8 + 1.8 * (0.5 + 0.5 * sin(t * 2pi * 0.55))', () => {
    for (const t of [0, 0.1, 0.37, 1, 2.5, 13.7, 600.25]) {
      const expected = 0.8 + 1.8 * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 0.55));
      expect(hydraGlowIntensity(t)).toBeCloseTo(expected, 12);
    }
  });

  test('starts at mid glow, peaks at 2.6, floors at 0.8', () => {
    expect(hydraGlowIntensity(0)).toBeCloseTo(1.7, 12);
    expect(hydraGlowIntensity(PERIOD_S / 4)).toBeCloseTo(2.6, 12);
    expect(hydraGlowIntensity((3 * PERIOD_S) / 4)).toBeCloseTo(0.8, 12);
  });

  test('stays inside [0.8, 2.6] and repeats every 1/0.55 s', () => {
    for (let i = 0; i <= 400; i++) {
      const t = i * 0.0731;
      const v = hydraGlowIntensity(t);
      expect(v).toBeGreaterThanOrEqual(0.8 - 1e-12);
      expect(v).toBeLessThanOrEqual(2.6 + 1e-12);
      expect(hydraGlowIntensity(t + PERIOD_S)).toBeCloseTo(v, 9);
    }
  });

  test('steady reduced-motion value is the mid glow', () => {
    expect(HYDRA_GLOW_STEADY_INTENSITY).toBeCloseTo(1.7, 12);
  });
});

describe('prepareHydraGlow', () => {
  test('non-Hydra animatorIds get the shared empty list and no writes', () => {
    const { root, glowMat } = makeHydraLikeScene();
    for (const id of [undefined, 'vrm-milady', 'adinero', 'hermes-female', 'Hydra']) {
      expect(prepareHydraGlow(root, id, false)).toBe(NO_HYDRA_GLOW_MATERIALS);
      expect(prepareHydraGlow(root, id, true)).toBe(NO_HYDRA_GLOW_MATERIALS);
    }
    expect(glowMat.emissiveIntensity).toBe(1);
  });

  test('Hydra collects each glow-masked material exactly once', () => {
    const { root, glowMat, plainMat } = makeHydraLikeScene();
    const mats = prepareHydraGlow(root, HYDRA_ANIMATOR_ID, false);
    expect(mats).toHaveLength(1);
    expect(mats[0]).toBe(glowMat);
    expect(mats).not.toContain(plainMat);
  });

  test('reduced motion holds the steady mid glow and returns nothing to pulse', () => {
    const { root, glowMat, plainMat } = makeHydraLikeScene();
    const mats = prepareHydraGlow(root, HYDRA_ANIMATOR_ID, true);
    expect(mats).toBe(NO_HYDRA_GLOW_MATERIALS);
    expect(glowMat.emissiveIntensity).toBeCloseTo(HYDRA_GLOW_STEADY_INTENSITY, 12);
    expect(plainMat.emissiveIntensity).toBe(1);
  });
});

describe('updateHydraGlow', () => {
  test('writes the pulse value to every collected material', () => {
    const { root, glowMat, plainMat } = makeHydraLikeScene();
    const mats = prepareHydraGlow(root, HYDRA_ANIMATOR_ID, false);
    updateHydraGlow(mats, PERIOD_S / 4);
    expect(glowMat.emissiveIntensity).toBeCloseTo(2.6, 12);
    updateHydraGlow(mats, (3 * PERIOD_S) / 4);
    expect(glowMat.emissiveIntensity).toBeCloseTo(0.8, 12);
    expect(plainMat.emissiveIntensity).toBe(1);
  });

  test('empty list is a no-op', () => {
    expect(() => updateHydraGlow(NO_HYDRA_GLOW_MATERIALS, 1.23)).not.toThrow();
  });
});
