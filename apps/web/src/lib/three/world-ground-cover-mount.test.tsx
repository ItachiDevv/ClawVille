/**
 * Mounted check of the seaweed + kelp-forest ground cover (web-load T8).
 *
 * Why: local prod build at 1342805d (RTX 3080, 3/3 cold loads). Each tier
 * 1 -> 0 recovery of the adaptive governor REMOUNTED MergedSeaweed (an
 * 18,000-blade merge + a new TSL material) and KelpForestAmbient (3 merged
 * variants + 3 new materials): one 154-181 ms main-thread task, then 4-6
 * synchronous createRenderPipeline calls on the first visible frame
 * (labels renderPipeline_MeshBasicNodeMaterial_* and
 * renderPipeline_MeshStandardNodeMaterial_*). That frame cost dropped the next
 * 2.5 s sample below 58 FPS, so the governor degraded again 2.3 s later and
 * latched tier 1: seabed decorations hidden for the session.
 *
 * Pins: after the first show, a governor toggle only flips visibility
 * (0 remounts, 0 unmounts); the perf chunk roots keep their names (the boot
 * compile whitelist keys on them); a layer that was never shown never mounts
 * (an initial-tier-1 profile pays nothing at boot).
 *
 * Real R3F root (fake renderer, frameloop 'never'). Stand-ins: the two layer
 * components (mount/unmount counters). Runs in its own process (mock.module
 * is process-global).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createElement, useEffect, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type * as THREE from 'three';

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'Event', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const threeCjs = require('three') as typeof import('three');

const counts = { seaweedMounts: 0, seaweedUnmounts: 0, kelpMounts: 0, kelpUnmounts: 0 };

function SeaweedStandIn() {
  useEffect(() => {
    counts.seaweedMounts += 1;
    return () => {
      counts.seaweedUnmounts += 1;
    };
  }, []);
  return createElement('mesh', { name: 'seaweed-stand-in' });
}

function KelpStandIn() {
  useEffect(() => {
    counts.kelpMounts += 1;
    return () => {
      counts.kelpUnmounts += 1;
    };
  }, []);
  return createElement('mesh', { name: 'kelp-stand-in' });
}

mock.module('./merged-seaweed', () => ({ default: SeaweedStandIn }));
mock.module('./kelp-forest', () => ({ KelpForestAmbient: KelpStandIn }));

type R3F = typeof import('@react-three/fiber');
let r3f: R3F;
let WorldGroundCover: (props: {
  show: boolean;
  seaweedEligible: boolean;
  kelpEligible: boolean;
  forceWebGL: boolean;
}) => ReactNode;

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
  ({ WorldGroundCover } = (await import('./world-ground-cover')) as never);
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

/** True when the object and every ancestor are visible (what the renderer draws). */
function drawn(object: THREE.Object3D | undefined): boolean {
  if (!object) return false;
  for (let o: THREE.Object3D | null = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

async function createScene() {
  const canvas = testWindow.document.createElement('canvas');
  testWindow.document.body.appendChild(canvas);
  const root = r3f.createRoot(canvas as unknown as HTMLCanvasElement);
  await root.configure({
    gl: fakeRenderer(canvas) as never,
    size: { width: 320, height: 200, top: 0, left: 0 },
    frameloop: 'never',
  });
  let store!: ReturnType<typeof root.render>;
  const render = async (show: boolean, eligible = true) => {
    await r3f.act(async () => {
      store = root.render(
        createElement(WorldGroundCover, {
          show,
          seaweedEligible: eligible,
          kelpEligible: eligible,
          forceWebGL: false,
        }),
      );
    });
  };
  const find = (name: string) => store.getState().scene.getObjectByName(name) as THREE.Object3D | undefined;
  return { root, render, find };
}

function resetCounts() {
  counts.seaweedMounts = 0;
  counts.seaweedUnmounts = 0;
  counts.kelpMounts = 0;
  counts.kelpUnmounts = 0;
}

describe('WorldGroundCover, mounted', () => {
  test('governor toggles after the first show flip visibility only (no remount)', async () => {
    resetCounts();
    const { root, render, find } = await createScene();

    // Desktop-capable boot: tier 0, both layers mount visible under their perf roots.
    await render(true);
    expect(counts.seaweedMounts).toBe(1);
    expect(counts.kelpMounts).toBe(1);
    expect(find('perf:seaweed')?.userData.perfChunk).toBe('seaweed');
    expect(find('perf:kelp-forest')?.userData.perfChunk).toBe('kelp-forest');
    expect(drawn(find('seaweed-stand-in'))).toBe(true);
    expect(drawn(find('kelp-stand-in'))).toBe(true);

    // Governor: 0 -> 1 -> 0 -> 1 -> 0.
    for (const show of [false, true, false, true]) {
      await render(show);
      expect(drawn(find('seaweed-stand-in'))).toBe(show);
      expect(drawn(find('kelp-stand-in'))).toBe(show);
    }
    expect(counts).toEqual({ seaweedMounts: 1, seaweedUnmounts: 0, kelpMounts: 1, kelpUnmounts: 0 });

    // A real unmount (world teardown) still unmounts both layers once.
    await r3f.act(async () => root.unmount());
    expect(counts).toEqual({ seaweedMounts: 1, seaweedUnmounts: 1, kelpMounts: 1, kelpUnmounts: 1 });
  });

  test('initial tier 1: nothing mounts until the first show; then toggles never remount', async () => {
    resetCounts();
    const { root, render, find } = await createScene();

    await render(false);
    expect(counts.seaweedMounts + counts.kelpMounts).toBe(0);
    expect(find('perf:seaweed')).toBeUndefined();
    expect(find('perf:kelp-forest')).toBeUndefined();

    await render(true);
    expect(counts.seaweedMounts).toBe(1);
    expect(counts.kelpMounts).toBe(1);
    for (const show of [false, true]) await render(show);
    expect(counts).toEqual({ seaweedMounts: 1, seaweedUnmounts: 0, kelpMounts: 1, kelpUnmounts: 0 });

    await r3f.act(async () => root.unmount());
  });

  test('an ineligible profile never mounts either layer', async () => {
    resetCounts();
    const { root, render, find } = await createScene();
    for (const show of [true, false, true]) await render(show, false);
    expect(counts.seaweedMounts + counts.kelpMounts).toBe(0);
    expect(find('perf:seaweed')).toBeUndefined();
    await r3f.act(async () => root.unmount());
  });
});
