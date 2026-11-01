import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  HYDRA_HALO_HOT_LAYERS,
  HYDRA_HALO_SUIT_LAYERS,
  NO_HYDRA_HALO_MOUNT,
  buildHydraHaloGeometry,
  createHydraHaloSampler,
  mountHydraHalo,
  type HydraHaloLayer,
} from './hydra-halo';

/** Two triangles: tri 0 in the left half of UV space (u < 0.5), tri 1 in the right half. */
function makeSource(quantized = false) {
  const g = new THREE.BufferGeometry();
  const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0];
  if (quantized) {
    g.setAttribute('position', new THREE.BufferAttribute(new Int16Array(pos.map((v) => Math.round((v / 4) * 32767))), 3, true));
  } else {
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  }
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(Array(6).fill([0, 0, 1]).flat()), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0.1, 0.1, 0.2, 0.1, 0.1, 0.2, 0.8, 0.8, 0.9, 0.8, 0.8, 0.9]), 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint8Array([0, 1, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0, 5, 0, 0, 0]), 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(Array(6).fill([1, 0, 0, 0]).flat()), 4));
  g.setIndex([0, 1, 2, 3, 4, 5]);
  return g;
}

const LAYERS: HydraHaloLayer[] = [
  { channel: 0, push: 0.1, gain: 1.5 },
  { channel: 1, push: 0.2, gain: 0.5 },
];

describe('buildHydraHaloGeometry', () => {
  test('keeps only triangles whose mask channel is lit, per layer', () => {
    // channel 0 lit on the left half, channel 1 lit on the right half
    const sample = (u0: number, _v0: number, u1: number, _v1: number, ch: number) =>
      (ch === 0 ? (u1 < 0.5 ? 1 : 0) : u0 >= 0.5 ? 1 : 0);
    const g = buildHydraHaloGeometry(makeSource(), LAYERS, sample)!;
    expect(g.getIndex()!.count).toBe(6);
    expect(g.getAttribute('position').count).toBe(6);
    const push = g.getAttribute('aHaloPush'), gain = g.getAttribute('aHaloGain'), sel = g.getAttribute('aHaloSel');
    const uv = g.getAttribute('uv');
    for (let i = 0; i < 6; i++) {
      const left = uv.getX(i) < 0.5;
      expect(push.getX(i)).toBeCloseTo(left ? 0.1 : 0.2, 6);
      expect(gain.getX(i)).toBeCloseTo(left ? 1.5 : 0.5, 6);
      expect([sel.getX(i), sel.getY(i), sel.getZ(i)]).toEqual(left ? [1, 0, 0] : [0, 1, 0]);
    }
  });

  test('a triangle lit by two layers is emitted once per layer, unwelded across layers', () => {
    const g = buildHydraHaloGeometry(makeSource(), LAYERS, (_u0, _v0, u1) => (u1 < 0.5 ? 1 : 0))!;
    expect(g.getIndex()!.count).toBe(6); // tri 0 for layer 0 and layer 1
    expect(g.getAttribute('position').count).toBe(6);
  });

  test('queries the UV bounding box of each triangle', () => {
    const boxes: number[][] = [];
    buildHydraHaloGeometry(makeSource(), [LAYERS[0]!], (u0, v0, u1, v1) => { boxes.push([u0, v0, u1, v1]); return 0; });
    expect(boxes.map((b) => b.map((x) => +x.toFixed(4)))).toEqual([[0.1, 0.1, 0.2, 0.2], [0.8, 0.8, 0.9, 0.9]]);
  });

  test('returns null when nothing is lit', () => {
    expect(buildHydraHaloGeometry(makeSource(), LAYERS, () => 0)).toBeNull();
  });

  test('copies de-normalized quantized positions and skin data as WebGPU-safe types', () => {
    const g = buildHydraHaloGeometry(makeSource(true), LAYERS, (_u0, _v0, u1, _v1, ch) => (ch === 0 && u1 < 0.5 ? 1 : 0))!;
    const p = g.getAttribute('position');
    expect(p.array).toBeInstanceOf(Float32Array);
    expect(p.getX(1)).toBeCloseTo(0.25, 3); // 1 / 4 after de-normalization
    expect(g.getAttribute('skinIndex').array).toBeInstanceOf(Uint16Array);
    expect(g.getAttribute('skinIndex').getY(0)).toBe(1);
    expect(g.boundingSphere).not.toBeNull();
  });
});

describe('createHydraHaloSampler', () => {
  // 32 x 32 RGBA image, one lit texel: G = 200 at (x 20, y 5)
  const W = 32;
  const data = new Uint8Array(W * W * 4);
  data[(5 * W + 20) * 4 + 1] = 200;
  const sample = createHydraHaloSampler(data, W, W);

  test('a rectangle that holds the lit texel reads its value on that channel only', () => {
    expect(sample(18 / W, 0, 22 / W, 10 / W, 1)).toBeCloseTo(200 / 255, 6);
    expect(sample(18 / W, 0, 22 / W, 10 / W, 0)).toBe(0);
  });

  test('the one-cell dilation covers the filter footprint next to a lit cell', () => {
    // lit texel is in cell (2, 0); cell (1, 0) spans x 8..15 and is a neighbour
    expect(sample(9 / W, 1 / W, 10 / W, 2 / W, 1)).toBeCloseTo(200 / 255, 6);
  });

  test('a rectangle two cells away reads zero', () => {
    expect(sample(0, 24 / W, 7 / W, 31 / W, 1)).toBe(0);
  });
});

describe('layer tables (bench parity, founder-approved 2026-11-01)', () => {
  test('suit = bench HALO_LAYERS at Halo 2.0; hot = bench HOT_LAYERS at Eyes+H 2.5', () => {
    expect(HYDRA_HALO_SUIT_LAYERS.map((l) => [l.push, +l.gain.toFixed(4)])).toEqual([[0.005, 1.2], [0.015, 0.8], [0.035, 0.56]]);
    expect(HYDRA_HALO_HOT_LAYERS.map((l) => [l.push, +l.gain.toFixed(4)])).toEqual([[0.0012, 2.5], [0.003, 1.75], [0.006, 1.125]]);
    expect([...HYDRA_HALO_SUIT_LAYERS, ...HYDRA_HALO_HOT_LAYERS].map((l) => l.channel)).toEqual([0, 1, 2, 0, 1, 2]);
  });
});

describe('mountHydraHalo', () => {
  test('every other character gets the shared no-op mount and no fetch', () => {
    const scene = new THREE.Group();
    expect(mountHydraHalo(scene, 'hermes-female', false)).toBe(NO_HYDRA_HALO_MOUNT);
    expect(mountHydraHalo(scene, undefined, false)).toBe(NO_HYDRA_HALO_MOUNT);
    expect(NO_HYDRA_HALO_MOUNT.live).toBeNull();
  });
});
