/**
 * Stream commit budget (web-load T10): position-only world-stream snapshots
 * and idle time must NOT commit the R3F root.
 *
 * Why: the R3F root committed ~6 times a second forever (measured 5.9/s, N6
 * CPU 4x and unthrottled). Every such render discards pending Suspense retry
 * lanes (reconciler 0.31: retry lanes never expire, wait for the 300 ms
 * reveal throttle, and prepareFreshStack cancels the waiting commit), so on a
 * slow machine parts of the world never appeared
 * (gotchas/suspense-retry-lane-starvation-sync-store-updates.md). Sources:
 *   (A) ActivityIndicators selected NEW snapshot objects through useShallow,
 *       which never bails: one render per 200 ms snapshot while any NPC talks;
 *   (B) NpcSpeechBubbles ran a 1 s setInterval tick that committed even when
 *       it rendered nothing.
 *
 * Mounts the REAL ArenaNpcs, NpcSpeechBubbles, ActivityIndicators and
 * RemotePlayers in ONE real R3F root (fake renderer, frameloop 'never'), each
 * inside its own <Profiler>, and drives the REAL store write paths the world
 * stream calls (useNpcStore.updateFromSnapshot + usePlayerStore
 * .updateFromSnapshot, see world-presence-controller callbacks). Stand-ins,
 * as in arena-npcs-vrm-warm-read.test.tsx: GLTFLoader.parseAsync (a fake VRM
 * per path), fetch, VRMCharacterAnimator, DeferredWarmAttachment
 * (pass-through), decorative release (already released).
 *
 * Asserts, after the figures settled:
 *   phase 1: 25 position-only snapshots over 5 s (NPCs walk, two NPCs talk,
 *            one bubble lives, remote players stand still) -> 0 commits
 *            (before T10: ~25 indicator + ~5 bubble-tick commits);
 *   gap:     the bubble expiry -> exactly ONE bubble commit (the removal);
 *   phase 2: 5 s idle, no bubbles -> 0 commits (before T10: 5 tick commits
 *            + the 5 s cleanup interval re-rendered the indicators).
 * KNOWN source outside this task (owner T3, pinned by the second test): a
 * remote player that MOVES gets a new store object per snapshot (immutable
 * players store), so RemotePlayers commits on every snapshot.
 * Runs in its own process (mock.module is process-global).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Fragment, Profiler, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type * as THREE from 'three';
import type { PlayerSnapshot } from '@clawville/shared';
import type { NpcStoreState } from '@/stores/npc';

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

// ---------------------------------------------------------------------------
// Stand-ins (same as arena-npcs-vrm-warm-read.test.tsx)
// ---------------------------------------------------------------------------

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
const reportErrorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'reportError');
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const consoleErrors: string[] = [];

type R3F = typeof import('@react-three/fiber');
let r3f: R3F;
let ArenaNpcs: () => ReactNode;
let NpcSpeechBubbles: () => ReactNode;
let ActivityIndicators: () => ReactNode;
let RemotePlayers: () => ReactNode;
let vrmPathForSpecies: (species: string) => string;
let useNpcStore: typeof import('@/stores/npc').useNpcStore;
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
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  console.warn = () => undefined;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\.vrm(?:\?|$)/.test(url)) return new Response(new TextEncoder().encode(url), { status: 200 });
    return new Response('missing', { status: 404 });
  }) as typeof fetch;

  const realAnimator = await import('./vrm-character-animator');
  class StubAnimator {
    init(): Promise<void> {
      return Promise.resolve();
    }
    update(): void {}
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
  ArenaNpcs = npcs.default as unknown as () => ReactNode;
  vrmPathForSpecies = npcs.vrmPathForSpecies;
  NpcSpeechBubbles = (await import('./npc-speech-bubbles')).default as unknown as () => ReactNode;
  ActivityIndicators = (await import('./activity-indicators')).default as unknown as () => ReactNode;
  RemotePlayers = (await import('./remote-players')).default as unknown as () => ReactNode;
  ({ useNpcStore } = await import('@/stores/npc'));
  ({ usePlayerStore } = await import('@/stores/players'));
  // The world stream is connected: this stops the client demo wander loop
  // (a 100 ms store write that the live world never runs while connected).
  useNpcStore.getState().setConnected(true);
  // Only the snapshot roster renders (not the offline demo cast).
  useNpcStore.setState({ npcs: [], chatBubbles: [] });
});

afterAll(async () => {
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

const LAYERS = ['npcs', 'bubbles', 'indicators', 'players'] as const;
type Layer = (typeof LAYERS)[number];
const commits: Record<Layer, number> = { npcs: 0, bubbles: 0, indicators: 0, players: 0 };

function resetCommits(): void {
  for (const layer of LAYERS) commits[layer] = 0;
}

function snapshotCommits(): Record<Layer, number> {
  return { ...commits };
}

function profiled(layer: Layer, component: () => ReactNode): ReactNode {
  return createElement(
    Profiler,
    {
      id: layer,
      onRender: () => {
        commits[layer] += 1;
      },
    },
    createElement(component),
  );
}

async function mountWorld() {
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
        Fragment,
        null,
        profiled('npcs', ArenaNpcs),
        profiled('bubbles', NpcSpeechBubbles),
        profiled('indicators', ActivityIndicators),
        profiled('players', RemotePlayers),
      ),
    );
  });
  const committed = (path: string) =>
    store.getState().scene.getObjectByName(`fake-vrm:${path}`) as THREE.Object3D | undefined;
  return { root, store, committed };
}

type ServerSnapshot = Parameters<NpcStoreState['updateFromSnapshot']>[0];

/** Four wandering NPCs: two walk east, two stand and talk to each other. */
const ROSTER = [
  { id: 't10-walker-a', species: 'milady_official_7', walks: true, talks: false },
  { id: 't10-walker-b', species: 'milady_official_8', walks: true, talks: false },
  { id: 't10-talker-a', species: 'milady_official_2', walks: false, talks: true },
  { id: 't10-talker-b', species: 'hermes_female', walks: false, talks: true },
] as const;

/** One snapshot at tick `tick`: only walker x changes between ticks. */
function npcSnapshot(tick: number, conversationActive: boolean): ServerSnapshot {
  return {
    npcs: ROSTER.map((n, i) => ({
      id: n.id,
      name: n.id,
      x: 3_000 + i * 400 + (n.walks ? tick * 44 : 0),
      y: 3_000,
      direction: n.walks ? 'right' : 'idle',
      species: n.species,
      color: 0xffffff,
      hp: 100,
      maxHp: 100,
      isDead: false,
      hasSword: false,
      inCombat: false,
      inConversation: n.talks,
      inventory: [],
      isOpenClaw: false,
    })),
    conversations: conversationActive
      ? [
          {
            id: 't10-convo',
            npc1Id: 't10-talker-a',
            npc2Id: 't10-talker-b',
            messages: [{ npcId: 't10-talker-a', npcName: 'Vivi', text: 'gm, the reef is calm today' }],
            currentIndex: 0,
            state: 'active',
          },
        ]
      : [],
    combats: [],
    timestamp: Date.now(),
  };
}

function playerSnapshot(tick: number, moving: boolean): PlayerSnapshot[] {
  return [
    {
      id: 't10-remote-a',
      userId: null,
      kind: 'guest',
      name: 'Visitor',
      x: 4_000 + (moving ? tick * 30 : 0),
      y: 4_000,
      dirZ: 0,
      activity: moving ? 'walking' : 'idle',
      species: 'milady_official_5',
      color: 0xffffff,
    } as PlayerSnapshot,
  ];
}

async function pushSnapshot(tick: number, opts: { conversation: boolean; playersMoving: boolean }): Promise<void> {
  await r3f.act(async () => {
    useNpcStore.getState().updateFromSnapshot(npcSnapshot(tick, opts.conversation));
    usePlayerStore.getState().updateFromSnapshot(playerSnapshot(tick, opts.playersMoving));
  });
}

const SNAPSHOT_MS = 200;
const SNAPSHOTS = 25; // 5 s at the live 5 Hz cadence

/** The world after mount: figures committed, one bubble, two talkers. */
async function settledWorld(playersMoving: boolean) {
  const world = await mountWorld();
  await pushSnapshot(0, { conversation: true, playersMoving });
  await waitFor(
    () =>
      ROSTER.every((n) => world.committed(vrmPathForSpecies(n.species)) !== undefined) &&
      world.committed(vrmPathForSpecies('milady_official_5')) !== undefined,
    'every NPC figure and the remote player committed',
  );
  // Let mount-time state (stagger release, warm reads) finish committing.
  await settle(400);
  return world;
}

async function teardown(root: { unmount: () => void }): Promise<void> {
  await r3f.act(async () => root.unmount());
  await r3f.act(async () => {
    useNpcStore.setState({ npcs: [], chatBubbles: [] });
    usePlayerStore.getState().clear();
  });
  await settle(700);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stream commit budget (web-load T10)', () => {
  test(
    'position-only snapshots + idle time commit nothing (indicators, bubbles, NPCs, still players)',
    async () => {
      const { root } = await settledWorld(false);
      const created = useNpcStore.getState().chatBubbles.find((b) => b.npcId === 't10-talker-a');
      expect(created).toBeDefined();
      // Fix the bubble's life to outlast phase 1 on a slow runner (the store
      // dedupes the repeated line by npcId + text, so it keeps this object).
      const bubble = { ...created!, expiresAt: Date.now() + 7_500 };
      await r3f.act(async () => {
        useNpcStore.setState({ chatBubbles: [bubble] });
      });
      await settle(100);

      // Phase 1: 25 position-only snapshots over 5 s. The same conversation
      // line repeats (deduped: no new bubble); the walkers move.
      resetCommits();
      for (let tick = 1; tick <= SNAPSHOTS; tick += 1) {
        await pushSnapshot(tick, { conversation: true, playersMoving: false });
        await settle(SNAPSHOT_MS);
      }
      const phase1 = snapshotCommits();
      // The walkers really moved (mutated in place on the SAME objects).
      const walker = useNpcStore.getState().npcs.find((n) => n.id === 't10-walker-a')!;
      expect(walker.x).toBe(3_000 + SNAPSHOTS * 44);

      // Gap: the bubble expires -> exactly one bubble commit removes it.
      resetCommits();
      await waitFor(() => Date.now() > bubble.expiresAt + 150, 'the bubble expired', 4_000);
      await settle(50);
      const gap = snapshotCommits();

      // Phase 2: 5 s idle with no bubble (the 5 s store cleanup runs inside
      // it). Short act slices: one long act batches separate timer updates
      // into one commit, which a browser never does.
      resetCommits();
      for (let slice = 0; slice < 52; slice += 1) await settle(100);
      const phase2 = snapshotCommits();

      // One assertion over all three windows, so a failure shows every count.
      expect({ phase1, gap, phase2 }).toEqual({
        phase1: { npcs: 0, bubbles: 0, indicators: 0, players: 0 },
        gap: { npcs: 0, bubbles: 1, indicators: 0, players: 0 },
        phase2: { npcs: 0, bubbles: 0, indicators: 0, players: 0 },
      });

      expect(reported).toEqual([]);
      await teardown(root);
    },
    40_000,
  );

  // KNOWN commit source owned by T3 (RemotePlayers / players store): a remote
  // player that moves gets a NEW store object per snapshot (immutable update,
  // stores/players.ts), so useShallow(s => s.players) sees a changed element
  // and RemotePlayers commits on every snapshot (measured: 20 commits for 10
  // snapshots). The other layers must stay at 0. When T3 lands, change the
  // last assertion to `toBe(0)`: this test then fails until it is updated.
  test(
    'KNOWN (T3): a MOVING remote player commits RemotePlayers only; every other layer stays at 0',
    async () => {
      const { root } = await settledWorld(true);
      resetCommits();
      for (let tick = 1; tick <= 10; tick += 1) {
        await pushSnapshot(tick, { conversation: true, playersMoving: true });
        await settle(SNAPSHOT_MS);
      }
      const counts = snapshotCommits();
      await teardown(root);
      expect({ npcs: counts.npcs, bubbles: counts.bubbles, indicators: counts.indicators }).toEqual({
        npcs: 0,
        bubbles: 0,
        indicators: 0,
      });
      expect(counts.players).toBeGreaterThan(0);
      expect(reported).toEqual([]);
    },
    30_000,
  );
});
