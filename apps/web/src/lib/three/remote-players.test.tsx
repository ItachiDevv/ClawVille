/**
 * RemotePlayers commit budget + interpolation (web-load T3, Codex E3 BLOCKER).
 *
 * Before T3 the players store replaced a MOVED player's object on every
 * snapshot, so `useShallow((s) => s.players)` re-rendered RemotePlayers at the
 * 5 Hz stream rate per moving remote player (measured 20 commits for 10
 * snapshots in stream-commit-budget.test.tsx). Each such SyncLane render of the
 * R3F root discards pending Suspense retry lanes.
 *
 * Now position-only snapshots mutate the store object in place and the body
 * reads the live fields every frame. This file pins both halves:
 *   - 10 position-only snapshots of a MOVING remote player -> 0 commits;
 *   - the body still follows: it moves on every frame between snapshots and
 *     never passes the latest confirmed position (damp toward the confirmed
 *     target, no extrapolation). A frame read that froze on the mount
 *     position (the 2026-06-12 Codex #5 freeze) fails the "moves" half;
 *   - a join is a structural change -> exactly 1 commit at the join;
 *   - walking -> running -> idle flips (written in place, no render) still
 *     switch the animator input (moving / running) and the heading still
 *     turns the body, with 0 commits (Codex re-check).
 *
 * Mounts the REAL RemotePlayers -> DeferredRemoteBody -> RemotePlayerEntry ->
 * VRMNpcMesh in a real R3F root (fake renderer, frameloop 'never') and drives
 * the REAL store write path (usePlayerStore.updateFromSnapshot, as the world
 * stream calls it). Stand-ins as in stream-commit-budget.test.tsx:
 * GLTFLoader.parseAsync (a fake VRM per path), fetch, VRMCharacterAnimator,
 * DeferredWarmAttachment (pass-through), decorative release (released).
 * Runs in its own process (mock.module is process-global).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Fragment, Profiler, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type * as THREE from 'three';
import type { PlayerSnapshot } from '@clawville/shared';

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'HTMLDivElement', 'Event', 'ErrorEvent', 'requestAnimationFrame', 'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const threeCjs = require('three') as typeof import('three');

class FakeGLTFLoader {
  setMeshoptDecoder(): this {
    return this;
  }
  register(): this {
    return this;
  }
  async parseAsync(buffer: ArrayBuffer): Promise<unknown> {
    const path = new TextDecoder().decode(buffer);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const scene = new threeCjs.Group();
    scene.name = `fake-vrm:${path}`;
    scene.add(new threeCjs.Mesh(new threeCjs.BoxGeometry(0.5, 1.6, 0.3), new threeCjs.MeshBasicMaterial()));
    const vrm = { scene, meta: { metaVersion: '1' }, update: () => undefined };
    return { userData: { vrm }, parser: { associations: new Map() } };
  }
}

mock.module('three/addons/loaders/GLTFLoader.js', () => ({ GLTFLoader: FakeGLTFLoader }));
mock.module('./deferred-warm-attachment', () => ({
  DeferredWarmAttachment: ({ children }: { children: ReactNode | ((ready: boolean) => ReactNode) }) =>
    createElement(Fragment, null, typeof children === 'function' ? children(true) : children),
}));

const reported: unknown[] = [];
/** Last locomotion input each body's animator received, keyed by fake VRM scene name. */
const mixerInputs = new Map<string, { moving: boolean; running: boolean }>();
const reportErrorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'reportError');
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

type R3F = typeof import('@react-three/fiber');
let r3f: R3F;
let RemotePlayers: () => ReactNode;
let vrmPathForSpecies: (species: string) => string;
let getNpcRenderGroup: (id: string) => THREE.Object3D | undefined;
let HALF_W = 0;
let usePlayerStore: typeof import('@/stores/players').usePlayerStore;

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
  Object.defineProperty(globalThis, 'reportError', {
    value: (error: unknown) => {
      reported.push(error);
    },
    configurable: true,
    writable: true,
  });
  console.error = () => undefined;
  console.warn = () => undefined;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\.vrm(?:\?|$)/.test(url)) return new Response(new TextEncoder().encode(url), { status: 200 });
    return new Response('missing', { status: 404 });
  }) as typeof fetch;

  const realAnimator = await import('./vrm-character-animator');
  class StubAnimator {
    private readonly scene: string;
    constructor(vrm: { scene: { name: string } }) {
      this.scene = vrm.scene.name;
    }
    init(): Promise<void> {
      return Promise.resolve();
    }
    update(): void {}
    updateMixerOnly(_dt: number, moving: boolean, running: boolean): void {
      mixerInputs.set(this.scene, { moving, running });
    }
    updateSpringOnly(): void {}
    cancelOneShot(): void {}
    playOneShot(): Promise<void> {
      return Promise.resolve();
    }
    dispose(): void {}
    setSurfaceClip(): void {}
  }
  mock.module('./vrm-character-animator', () => ({
    ...realAnimator,
    VRMCharacterAnimator: StubAnimator,
    preloadMixamoClips: () => undefined,
  }));
  const realRelease = await import('./decorative-release');
  mock.module('./decorative-release', () => ({
    ...realRelease,
    isDecorativeReleased: () => true,
    onDecorativeReleaseStaggered: (callback: () => void) => {
      callback();
      return () => undefined;
    },
  }));

  r3f = await import('@react-three/fiber');
  r3f.extend(threeCjs as never);
  const npcs = await import('./arena-npcs');
  vrmPathForSpecies = npcs.vrmPathForSpecies;
  getNpcRenderGroup = npcs.getNpcRenderGroup;
  HALF_W = (await import('@/lib/pixi/tilemap-data')).MAP_WIDTH / 2;
  RemotePlayers = (await import('./remote-players')).default as unknown as () => ReactNode;
  ({ usePlayerStore } = await import('@/stores/players'));
});

afterAll(async () => {
  Date.now = realDateNow;
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  if (reportErrorDescriptor) Object.defineProperty(globalThis, 'reportError', reportErrorDescriptor);
  else delete (globalThis as Record<string, unknown>).reportError;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  await testWindow.happyDOM.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function settle(ms: number): Promise<void> {
  await r3f.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(ready: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await settle(5);
  }
}

let commits = 0;

async function mountRemotePlayers() {
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
    store = root.render(
      createElement(
        Profiler,
        {
          id: 'players',
          onRender: () => {
            commits += 1;
          },
        },
        createElement(RemotePlayers),
      ),
    );
  });
  const committed = (path: string) =>
    store.getState().scene.getObjectByName(`fake-vrm:${path}`) as THREE.Object3D | undefined;
  // frameloop 'never': R3F's frame delta is (timestamp - clock.elapsedTime),
  // so a seconds clock gives each frame an exact 40 ms delta.
  let frameSeconds = 0;
  const frame = async (stepMs: number) => {
    frameSeconds += stepMs / 1000;
    await r3f.act(async () => {
      r3f.advance(frameSeconds, true, store.getState());
    });
  };
  return { root, committed, frame };
}

const realDateNow = Date.now;
let heldNow: number | null = null;
function holdClock(): void {
  heldNow = realDateNow();
  Date.now = () => heldNow ?? realDateNow();
}
function advanceClock(ms: number): void {
  if (heldNow === null) throw new Error('clock is not held');
  heldNow += ms;
}
function releaseClock(): void {
  heldNow = null;
  Date.now = realDateNow;
}

const SPECIES_A = 'milady_official_5';
const SPECIES_B = 'hermes_female';
const START_X = 4_000;
const STEP_PX = 30; // per 200 ms snapshot = 150 px/s, a walking player

function remote(
  id: string,
  species: string,
  x: number,
  over: Partial<Pick<PlayerSnapshot, 'y' | 'dirZ' | 'activity'>> = {},
): PlayerSnapshot {
  return {
    id,
    userId: null,
    kind: 'guest',
    name: 'Visitor',
    x,
    y: 4_000,
    dirZ: Math.PI / 2,
    activity: 'walking',
    species,
    color: 0xffffff,
    ts: 0,
    ...over,
  };
}

async function ingest(players: PlayerSnapshot[]): Promise<void> {
  await r3f.act(async () => {
    usePlayerStore.getState().updateFromSnapshot(players);
  });
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('RemotePlayers: moving players commit nothing, the body still follows (web-load T3)', () => {
  test(
    '10 position-only snapshots -> 0 commits; body moves every frame and never passes the confirmed target; join -> 1 commit',
    async () => {
      usePlayerStore.getState().clear();
      const { root, committed, frame } = await mountRemotePlayers();
      await ingest([remote('t3-remote-a', SPECIES_A, START_X)]);
      await waitFor(() => committed(vrmPathForSpecies(SPECIES_A)) !== undefined, 'remote player A committed');
      await settle(400);
      const body = getNpcRenderGroup('t3-remote-a');
      expect(body).toBeDefined();
      await frame(40); // seeds the body at its confirmed target
      expect(body!.position.x).toBeCloseTo(START_X - HALF_W, 6);

      const trace: Array<{ tick: number; x: number; confirmed: number }> = [];
      let moveCommits = -1;
      let joinCommits = -1;
      let afterJoinCommits = -1;
      holdClock();
      try {
        // Phase 1: A walks east, one snapshot per 200 ms of held clock, five
        // 40 ms frames after each snapshot.
        commits = 0;
        let x = START_X;
        for (let tick = 1; tick <= 10; tick += 1) {
          x = START_X + tick * STEP_PX;
          await ingest([remote('t3-remote-a', SPECIES_A, x)]);
          for (let f = 0; f < 5; f += 1) {
            advanceClock(40);
            await frame(40);
            trace.push({ tick, x: body!.position.x, confirmed: x - HALF_W });
          }
        }
        moveCommits = commits;

        // Phase 2: B joins (structural) while A keeps walking.
        commits = 0;
        x += STEP_PX;
        await ingest([remote('t3-remote-a', SPECIES_A, x), remote('t3-remote-b', SPECIES_B, 6_000)]);
        joinCommits = commits;
      } finally {
        releaseClock();
      }

      // Every frame moved the body forward (no freeze on the mount position)
      // and never past the latest confirmed position (no extrapolation).
      let prevX = START_X - HALF_W;
      const stalls: typeof trace = [];
      const overshoots: typeof trace = [];
      for (const sample of trace) {
        if (!(sample.x > prevX)) stalls.push(sample);
        if (sample.x > sample.confirmed + 1e-9) overshoots.push(sample);
        prevX = sample.x;
      }
      expect({ moveCommits, stalls, overshoots }).toEqual({ moveCommits: 0, stalls: [], overshoots: [] });
      // It covered most of the walk (300 px in 2 s, ~one tick of render delay).
      const last = trace[trace.length - 1];
      expect(last.x - (START_X - HALF_W)).toBeGreaterThan(10 * STEP_PX - 2 * STEP_PX);
      expect(joinCommits).toBe(1);

      // B mounts; once it has committed, position-only snapshots of both
      // players commit nothing again.
      await waitFor(() => committed(vrmPathForSpecies(SPECIES_B)) !== undefined, 'remote player B committed');
      await settle(400);
      commits = 0;
      for (let tick = 1; tick <= 5; tick += 1) {
        await ingest([
          remote('t3-remote-a', SPECIES_A, START_X + 400 + tick * STEP_PX),
          remote('t3-remote-b', SPECIES_B, 6_000 - tick * STEP_PX),
        ]);
        await settle(20);
      }
      afterJoinCommits = commits;
      expect(afterJoinCommits).toBe(0);

      // Leave is structural too: B's body unmounts.
      await ingest([remote('t3-remote-a', SPECIES_A, START_X + 600)]);
      await settle(50);
      expect(getNpcRenderGroup('t3-remote-b')).toBeUndefined();
      expect(getNpcRenderGroup('t3-remote-a')).toBe(body);

      expect(reported).toEqual([]);
      await r3f.act(async () => root.unmount());
      await r3f.act(async () => usePlayerStore.getState().clear());
      await settle(700);
    },
    60_000,
  );

  // Codex re-check: idle/walking/running flips are written IN PLACE too (no
  // new object, no render). The animator must still switch on each flip, and
  // the heading (dirZ, in place) must still turn the body.
  test(
    'walking -> running -> idle via position-only snapshots: the animator input switches each time, the body turns, 0 commits',
    async () => {
      usePlayerStore.getState().clear();
      mixerInputs.clear();
      // Near the map centre: the test camera sits at the world origin, and a
      // body beyond the far-LOD distance does not tick its mixer at all.
      const CX = HALF_W;
      const CY = HALF_W; // MAP_HEIGHT === MAP_WIDTH
      const id = 't3-remote-anim';
      const scene = `fake-vrm:${vrmPathForSpecies(SPECIES_A)}`;
      const { root, committed, frame } = await mountRemotePlayers();
      await ingest([remote(id, SPECIES_A, CX, { y: CY, activity: 'idle' })]);
      await waitFor(() => committed(vrmPathForSpecies(SPECIES_A)) !== undefined, 'remote player committed');
      await settle(400);
      const storeObject = usePlayerStore.getState().players[0];
      const body = getNpcRenderGroup(id)!;
      expect(body).toBeDefined();
      await frame(40);

      const seen: Array<{ phase: string; moving: boolean; running: boolean }> = [];
      let x = CX;
      let phaseCommits = -1;
      const runPhase = async (
        phase: string,
        ticks: number,
        stepPx: number,
        activity: string,
        dirZ: number,
      ) => {
        for (let tick = 0; tick < ticks; tick += 1) {
          x += stepPx;
          await ingest([remote(id, SPECIES_A, x, { y: CY, activity, dirZ })]);
          for (let f = 0; f < 5; f += 1) {
            advanceClock(40);
            await frame(40);
          }
        }
        const input = mixerInputs.get(scene);
        seen.push({ phase, moving: input?.moving ?? false, running: input?.running ?? false });
      };

      holdClock();
      try {
        commits = 0;
        await runPhase('walking', 10, 30, 'walking', Math.PI / 2);
        await runPhase('running', 10, 60, 'running', Math.PI / 2);
        await runPhase('idle', 15, 0, 'idle', -Math.PI / 2);
        phaseCommits = commits;
      } finally {
        releaseClock();
      }

      expect({ phaseCommits, seen }).toEqual({
        phaseCommits: 0,
        seen: [
          { phase: 'walking', moving: true, running: false },
          { phase: 'running', moving: true, running: true },
          { phase: 'idle', moving: false, running: false },
        ],
      });
      // Same store object all along (in place), and it carries the last flip.
      expect(usePlayerStore.getState().players[0]).toBe(storeObject);
      expect(storeObject.activity).toBe('idle');
      // The body turned to the in-place heading (-PI/2), shortest path.
      let diff = body.rotation.y - -Math.PI / 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      expect(Math.abs(diff)).toBeLessThan(0.05);
      // And it stopped where the store says.
      expect(body.position.x).toBeCloseTo(x - HALF_W, 0);

      expect(reported).toEqual([]);
      await r3f.act(async () => root.unmount());
      await r3f.act(async () => usePlayerStore.getState().clear());
      await settle(700);
    },
    60_000,
  );
});
