/**
 * Activity indicators reuse ONE material + geometry per look (web-load T9).
 *
 * Why (T8, Iris Xe rule): every indicator show built a NEW
 * MeshBasicMaterial (JSX <meshBasicMaterial>), so each show cost one
 * synchronous pipeline creation (one every 8-16 s on the live world), and the
 * typing dots allocated an array in every frame callback.
 *
 * Mounts the REAL ActivityIndicators in a real R3F root (fake renderer,
 * frameloop 'never') with the real NPC store. Asserts:
 *   - the three typing dots share one material and one geometry;
 *   - two NPCs share the same activity material;
 *   - hide -> show again reuses the SAME material and geometry objects;
 *   - nothing shared is disposed while the layer stays mounted, and each
 *     shared material + geometry is disposed once when the layer unmounts;
 *   - the dots still bounce (staggered) on a manual frame.
 * Runs in its own process.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type * as THREE from 'three';
import type { NpcSpriteState } from '@/stores/npc';

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'Event', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const threeCjs = require('three') as typeof import('three');

type R3F = typeof import('@react-three/fiber');
let r3f: R3F;
let ActivityIndicators: () => ReactNode;
let useNpcStore: typeof import('@/stores/npc').useNpcStore;

beforeAll(async () => {
  for (const name of globalNames) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value =
      name === 'IS_REACT_ACT_ENVIRONMENT'
        ? true
        : name === 'window'
          ? testWindow
          : name === 'requestAnimationFrame'
            ? (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number
            : name === 'cancelAnimationFrame'
              ? (id: number) => clearTimeout(id)
              : (testWindow as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  r3f = await import('@react-three/fiber');
  r3f.extend(threeCjs as never);
  ActivityIndicators = (await import('./activity-indicators')).default as unknown as () => ReactNode;
  ({ useNpcStore } = await import('@/stores/npc'));
});

afterAll(async () => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  await testWindow.happyDOM.close();
});

function fakeRenderer(canvas: unknown) {
  return {
    domElement: canvas,
    shadowMap: { enabled: false, type: 0, needsUpdate: false },
    outputColorSpace: '',
    toneMapping: 0,
    render() {},
    setSize() {},
    setPixelRatio() {},
    getPixelRatio: () => 1,
    dispose() {},
  };
}

function npc(id: string, inConversation: boolean, index: number): NpcSpriteState {
  return {
    id,
    name: id,
    x: 1_000 + index * 100,
    y: 1_000,
    prevX: 1_000,
    prevY: 1_000,
    ts: 0,
    tsDelta: 200,
    direction: 'idle',
    species: 'lobster',
    color: 0xffffff,
    hp: 100,
    maxHp: 100,
    isDead: false,
    hasSword: false,
    inCombat: false,
    inConversation,
    inventory: [],
    isOpenClaw: false,
    combatAction: null,
    combatActionAt: 0,
    facingAngle: null,
  } as unknown as NpcSpriteState;
}

async function setNpcs(npcs: NpcSpriteState[]): Promise<void> {
  await r3f.act(async () => {
    useNpcStore.setState({ npcs });
  });
}

const CYAN = 0x00e5ff;
const DOT = 0xcccccc;

function meshesByColor(scene: THREE.Object3D, color: number): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.MeshBasicMaterial;
    if (material.color?.getHex() === color) out.push(mesh);
  });
  return out;
}

describe('activity indicators share materials + geometry per look (web-load T9)', () => {
  test('stable identity across shows; one dispose per shared resource on layer unmount; dots bounce', async () => {
    await setNpcs([]);
    const canvas = testWindow.document.createElement('canvas');
    testWindow.document.body.appendChild(canvas);
    const root = r3f.createRoot(canvas as unknown as HTMLCanvasElement);
    await root.configure({
      gl: fakeRenderer(canvas) as never,
      size: { width: 320, height: 200, top: 0, left: 0 },
      frameloop: 'never',
    });
    let store!: ReturnType<typeof root.render>;
    await r3f.act(async () => {
      store = root.render(createElement(ActivityIndicators));
    });
    const scene = () => store.getState().scene;

    // Show #1: one NPC talking -> one activity sphere + three typing dots.
    await setNpcs([npc('a', true, 0)]);
    const sphere1 = meshesByColor(scene(), CYAN);
    const dots1 = meshesByColor(scene(), DOT);
    expect(sphere1).toHaveLength(1);
    expect(dots1).toHaveLength(3);
    expect(new Set(dots1.map((m) => m.material)).size).toBe(1);
    expect(new Set(dots1.map((m) => m.geometry)).size).toBe(1);
    const activityMaterial = sphere1[0]!.material as THREE.Material;
    const activityGeometry = sphere1[0]!.geometry;
    const dotMaterial = dots1[0]!.material as THREE.Material;
    const dotGeometry = dots1[0]!.geometry;

    const disposed = new Map<object, number>();
    for (const resource of [activityMaterial, activityGeometry, dotMaterial, dotGeometry]) {
      resource.addEventListener('dispose', () => disposed.set(resource, (disposed.get(resource) ?? 0) + 1));
    }

    // The dots bounce, staggered by index, on a manual frame.
    await r3f.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      r3f.advance(performance.now(), true, store.getState());
    });
    const t = store.getState().clock.elapsedTime;
    const ys = dots1.map((m) => m.position.y);
    for (let i = 0; i < 3; i += 1) {
      expect(ys[i]).toBeCloseTo(9 + Math.abs(Math.sin((t + i * 0.2) * 4)) * 1.5, 5);
    }

    // Hide, then show again (and a second NPC): the SAME objects come back.
    await setNpcs([npc('a', false, 0)]);
    expect(meshesByColor(scene(), CYAN)).toHaveLength(0);
    await setNpcs([npc('a', true, 0), npc('b', true, 1)]);
    const sphere2 = meshesByColor(scene(), CYAN);
    const dots2 = meshesByColor(scene(), DOT);
    expect(sphere2).toHaveLength(2);
    expect(dots2).toHaveLength(6);
    for (const mesh of sphere2) {
      expect(mesh.material).toBe(activityMaterial);
      expect(mesh.geometry).toBe(activityGeometry);
    }
    for (const mesh of dots2) {
      expect(mesh.material).toBe(dotMaterial);
      expect(mesh.geometry).toBe(dotGeometry);
    }
    // Nothing shared was disposed by the hide/show cycle.
    expect(disposed.size).toBe(0);

    // The layer unmounts: each shared resource is disposed exactly once.
    await r3f.act(async () => root.unmount());
    for (const resource of [activityMaterial, activityGeometry, dotMaterial, dotGeometry]) {
      expect(disposed.get(resource)).toBe(1);
    }
    await setNpcs([]);
  }, 20_000);
});
