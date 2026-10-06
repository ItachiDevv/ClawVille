/**
 * Wandering NPC + remote player VRM figures commit WITHOUT a Suspense retry
 * (web-load T9).
 *
 * Why: local prod build, CPU 4x (T8 runs T1/T2/T3/TB1/TB2): 10, 1, 1, 5 and
 * 0 of the 16 wandering VRM figures waited > 10 s between their parse and
 * their commit (worst 26.6 s). NpcEntry revealed each figure through
 * <Suspense> around useVRMInstance, so the figure could commit only in a
 * Suspense RETRY lane, and the 5 Hz world-stream SyncLane renders discard
 * retry work (gotchas/suspense-retry-lane-starvation-sync-store-updates.md).
 * The fix applies the T7 pattern: after the stagger release, the entry
 * resolves the figure's VRM OUTSIDE React (warmSuspenseRead + readVRMInstance,
 * the non-hook body of useVRMInstance) and mounts the figure only after, so
 * the figure's first render reads a resolved entry.
 *
 * Mounts the REAL ArenaNpcs / RemotePlayers (real NpcEntry, VRMNpcMesh,
 * ModelLoadBoundary, vrm-loader cache, dispose grace) in a real R3F root
 * (fake renderer, frameloop 'never'). Stand-ins: GLTFLoader.parseAsync
 * (returns a fake VRM per path), fetch (bytes = the path; one path 404),
 * VRMCharacterAnimator (no clip loads), DeferredWarmAttachment (pass-through),
 * decorative release (already released). vrm-loader is the REAL module; its
 * two readers are wrapped only to record calls.
 *
 * Asserts:
 *   (a) 0 render reads suspended for every figure;
 *   (b) for every wandering VRM in NPC_DEFINITIONS: a warm read of the SAME
 *       (path, instanceId) ran before the first render read, and both
 *       returned the SAME VRM object (one cache entry);
 *   (c) an unmount before the warm resolved, and an unmount after commit,
 *       both leave 0 cached instances after the dispose grace;
 *   plus: a failed VRM skips only that figure with one console.error, and a
 *   remount loads it again.
 * Runs in its own process (mock.module is process-global).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Fragment, StrictMode, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type * as THREE from 'three';
import { NPC_DEFINITIONS } from '@clawville/shared';
import type { NpcSpriteState } from '@/stores/npc';
import type { RemotePlayerState } from '@/stores/players';

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
// Stand-ins
// ---------------------------------------------------------------------------

/** Paths whose request fails (404 is final at once, never retried). */
const failingPaths = new Set<string>();
const requests = new Map<string, number>();
/** While set, every parse waits for it (to unmount mid-warm). */
let parseGate: Promise<void> | null = null;
let parses = 0;

class FakeGLTFLoader {
  setMeshoptDecoder(): this {
    return this;
  }
  register(): this {
    return this;
  }
  async parseAsync(buffer: ArrayBuffer): Promise<unknown> {
    parses += 1;
    const path = new TextDecoder().decode(buffer);
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (parseGate) await parseGate;
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

type ReadRecord = { seq: number; path: string; id: string; value: unknown; suspended: boolean; error: unknown };
let seq = 0;
const warmReads: ReadRecord[] = [];
const renderReads: ReadRecord[] = [];
const isThenable = (v: unknown) =>
  v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function';

function recordRead(list: ReadRecord[], path: string, id: string, read: () => unknown): unknown {
  const record: ReadRecord = { seq: (seq += 1), path, id, value: undefined, suspended: false, error: undefined };
  list.push(record);
  try {
    record.value = read();
    return record.value;
  } catch (thrown) {
    if (isThenable(thrown)) record.suspended = true;
    else record.error = thrown;
    throw thrown;
  }
}

/** R3F 9 reports boundary-CAUGHT render errors through `reportError`
 * (captured at module load); installed before the R3F import, records. */
const reported: unknown[] = [];
const reportErrorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'reportError');
const consoleErrors: string[] = [];
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

type R3F = typeof import('@react-three/fiber');
let r3f: R3F;
let ArenaNpcs: () => ReactNode;
let RemotePlayers: () => ReactNode;
let vrmPathForSpecies: (species: string) => string;
let useNpcStore: typeof import('@/stores/npc').useNpcStore;
let usePlayerStore: typeof import('@/stores/players').usePlayerStore;
let vrmLoader: typeof import('./vrm-loader');
let MODEL_REGISTRY: typeof import('./agent-model-registry').MODEL_REGISTRY;

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
    requests.set(url, (requests.get(url) ?? 0) + 1);
    // Some registry paths carry a cache-bust query (`.vrm?v=2`).
    if (/\.vrm(?:\?|$)/.test(url) && !failingPaths.has(url)) {
      return new Response(new TextEncoder().encode(url), { status: 200 });
    }
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
  vrmLoader = await import('./vrm-loader');
  // Capture the REAL readers first: mock.module patches this same live
  // namespace, so reading them through it later would recurse.
  const realUse = vrmLoader.useVRMInstance;
  const realRead = vrmLoader.readVRMInstance;
  const realLoader = { ...vrmLoader };
  // The real useVRMInstance calls readVRMInstance through the module binding
  // that mock.module patches: a read nested in a render read is not a warm.
  let renderDepth = 0;
  mock.module('./vrm-loader', () => ({
    ...realLoader,
    useVRMInstance: (path: string, id: string) =>
      recordRead(renderReads, path, id, () => {
        renderDepth += 1;
        try {
          return realUse(path, id);
        } finally {
          renderDepth -= 1;
        }
      }),
    readVRMInstance: (path: string, id: string) =>
      renderDepth > 0 ? realRead(path, id) : recordRead(warmReads, path, id, () => realRead(path, id)),
  }));

  r3f = await import('@react-three/fiber');
  r3f.extend(threeCjs as never);
  const npcs = await import('./arena-npcs');
  ArenaNpcs = npcs.default as unknown as () => ReactNode;
  vrmPathForSpecies = npcs.vrmPathForSpecies;
  RemotePlayers = (await import('./remote-players')).default as unknown as () => ReactNode;
  ({ useNpcStore } = await import('@/stores/npc'));
  ({ usePlayerStore } = await import('@/stores/players'));
  ({ MODEL_REGISTRY } = await import('./agent-model-registry'));
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

async function mount(element: ReactNode) {
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
    store = root.render(element);
  });
  const committed = (path: string) =>
    store.getState().scene.getObjectByName(`fake-vrm:${path}`) as THREE.Object3D | undefined;
  return { root, committed };
}

function npcState(id: string, species: string, index: number): NpcSpriteState {
  const x = 2_000 + index * 150;
  const y = 2_000;
  return {
    id,
    name: id,
    x,
    y,
    prevX: x,
    prevY: y,
    ts: 0,
    tsDelta: 200,
    direction: 'idle',
    species,
    color: 0xffffff,
    hp: 100,
    maxHp: 100,
    isDead: false,
    hasSword: false,
    inCombat: false,
    inConversation: false,
    inventory: [],
    isOpenClaw: false,
    combatAction: null,
    combatActionAt: 0,
    facingAngle: null,
  } as unknown as NpcSpriteState;
}

const isVrmSpecies = (species: string) =>
  MODEL_REGISTRY[species as keyof typeof MODEL_REGISTRY]?.avatar_type === 'vrm';

function resetRecords(): void {
  warmReads.length = 0;
  renderReads.length = 0;
  reported.length = 0;
  consoleErrors.length = 0;
}

const DISPOSE_GRACE_PLUS_MS = 650;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VRM figures commit without a Suspense retry (web-load T9)', () => {
  test('readVRMInstance and useVRMInstance share ONE cache entry (same pending promise)', async () => {
    vrmLoader._vrmClearAllCaches();
    let warmThrown: unknown;
    let renderThrown: unknown;
    try {
      vrmLoader.readVRMInstance('/avatars/t9-parity.vrm', 'npc-a');
    } catch (thrown) {
      warmThrown = thrown;
    }
    try {
      vrmLoader.useVRMInstance('/avatars/t9-parity.vrm', 'npc-a');
    } catch (thrown) {
      renderThrown = thrown;
    }
    expect(isThenable(warmThrown)).toBe(true);
    expect(renderThrown).toBe(warmThrown);
    expect(vrmLoader._vrmInstanceCount()).toBe(1);
    await (warmThrown as Promise<unknown>).catch(() => undefined);
    const resolved = vrmLoader.readVRMInstance('/avatars/t9-parity.vrm', 'npc-a');
    expect(vrmLoader.useVRMInstance('/avatars/t9-parity.vrm', 'npc-a')).toBe(resolved);
    vrmLoader._vrmClearAllCaches();
  }, 10_000);

  test(
    'every wandering VRM in NPC_DEFINITIONS: warm read first, same entry, 0 suspended render reads',
    async () => {
      vrmLoader._vrmClearAllCaches();
      resetRecords();
      const roster = NPC_DEFINITIONS.filter((d) => isVrmSpecies(d.species));
      expect(roster.length).toBeGreaterThanOrEqual(10);
      useNpcStore.setState({ npcs: roster.map((d, i) => npcState(d.id, d.species, i)) });
      const { root, committed } = await mount(createElement(ArenaNpcs));
      await waitFor(
        () => roster.every((d) => committed(vrmPathForSpecies(d.species)) !== undefined),
        'every wandering VRM figure committed',
      );

      expect(renderReads.filter((r) => r.suspended)).toEqual([]);
      expect(reported).toEqual([]);
      for (const d of roster) {
        const path = vrmPathForSpecies(d.species);
        const warm = warmReads.filter((r) => r.path === path && r.id === d.id);
        const render = renderReads.filter((r) => r.path === path && r.id === d.id);
        expect({ id: d.id, warm: warm.length > 0 }).toEqual({ id: d.id, warm: true });
        expect(render.length).toBeGreaterThan(0);
        // The warm read came first and its final read returned the SAME VRM
        // object the render read: one cache entry for (path, instanceId).
        expect(warm[0]!.seq).toBeLessThan(render[0]!.seq);
        const warmVrm = warm.at(-1)!.value;
        expect(warmVrm).toBeDefined();
        expect(render[0]!.value).toBe(warmVrm);
        expect(committed(path)).toBe((warmVrm as { scene: THREE.Object3D }).scene);
      }
      // No read anywhere for a (path, id) the roster does not own.
      for (const r of [...warmReads, ...renderReads]) {
        const owner = roster.find((d) => d.id === r.id);
        expect(owner && vrmPathForSpecies(owner.species)).toBe(r.path);
      }

      // (c) unmount after commit: the figures' own brackets dispose every
      // instance after the grace window.
      useNpcStore.setState({ npcs: [] });
      await settle(DISPOSE_GRACE_PLUS_MS);
      expect(vrmLoader._vrmInstanceCount()).toBe(0);
      await r3f.act(async () => root.unmount());
    },
    30_000,
  );

  test('a failed VRM skips only that figure (one console.error); a remount loads it again', async () => {
    vrmLoader._vrmClearAllCaches();
    resetRecords();
    const okDef = NPC_DEFINITIONS.find((d) => d.id === 'milady-miu')!;
    const badDef = NPC_DEFINITIONS.find((d) => d.id === 'milady-kyoko')!;
    const okPath = vrmPathForSpecies(okDef.species);
    const badPath = vrmPathForSpecies(badDef.species);
    failingPaths.add(badPath);
    useNpcStore.setState({ npcs: [npcState(okDef.id, okDef.species, 0), npcState(badDef.id, badDef.species, 1)] });
    const { root, committed } = await mount(createElement(ArenaNpcs));
    await waitFor(() => committed(okPath) !== undefined, 'the healthy figure committed');
    await waitFor(
      () => consoleErrors.some((m) => m.includes('figure skipped') && m.includes(badPath)),
      'the failed figure logged its skip',
    );
    await settle(20);
    expect(committed(badPath)).toBeUndefined();
    expect(consoleErrors.filter((m) => m.includes('figure skipped'))).toHaveLength(1);
    expect(renderReads.filter((r) => r.suspended)).toEqual([]);

    // Remount after the network recovers: the figure requests and commits.
    failingPaths.delete(badPath);
    const before = requests.get(badPath) ?? 0;
    useNpcStore.setState({ npcs: [npcState(okDef.id, okDef.species, 0)] });
    await settle(DISPOSE_GRACE_PLUS_MS);
    useNpcStore.setState({ npcs: [npcState(okDef.id, okDef.species, 0), npcState(badDef.id, badDef.species, 1)] });
    await waitFor(() => committed(badPath) !== undefined, 'the remounted figure committed');
    expect(requests.get(badPath) ?? 0).toBeGreaterThan(before);
    expect(renderReads.filter((r) => r.suspended)).toEqual([]);

    useNpcStore.setState({ npcs: [] });
    await settle(DISPOSE_GRACE_PLUS_MS);
    expect(vrmLoader._vrmInstanceCount()).toBe(0);
    await r3f.act(async () => root.unmount());
  }, 30_000);

  test('(c) an unmount BEFORE the warm resolved leaves no cached instance and no later load', async () => {
    vrmLoader._vrmClearAllCaches();
    resetRecords();
    let openGate: () => void = () => undefined;
    parseGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const def = NPC_DEFINITIONS.find((d) => d.id === 'milady-vivi')!;
    const path = vrmPathForSpecies(def.species);
    const parsesBefore = parses;
    useNpcStore.setState({ npcs: [npcState(def.id, def.species, 0)] });
    const { root, committed } = await mount(createElement(ArenaNpcs));
    await waitFor(() => parses > parsesBefore, 'the parse started');
    expect(vrmLoader._vrmInstanceCount()).toBe(1);

    // The entry unmounts while its parse is in flight.
    useNpcStore.setState({ npcs: [] });
    await settle(DISPOSE_GRACE_PLUS_MS);
    openGate();
    parseGate = null;
    await settle(50);
    expect(vrmLoader._vrmInstanceCount()).toBe(0);
    expect(committed(path)).toBeUndefined();
    // The abandoned warm never created a new entry (one parse only).
    await settle(50);
    expect(parses - parsesBefore).toBe(1);
    expect(vrmLoader._vrmInstanceCount()).toBe(0);
    expect(renderReads.filter((r) => r.id === def.id)).toEqual([]);
    await r3f.act(async () => root.unmount());
  }, 20_000);

  test('StrictMode (effect setup/cleanup/setup): one parse per figure, 0 suspended, 0 left after leave', async () => {
    vrmLoader._vrmClearAllCaches();
    resetRecords();
    const roster = NPC_DEFINITIONS.filter((d) => isVrmSpecies(d.species)).slice(0, 3);
    const parsesBefore = parses;
    useNpcStore.setState({ npcs: roster.map((d, i) => npcState(d.id, d.species, i)) });
    const { root, committed } = await mount(createElement(StrictMode, null, createElement(ArenaNpcs)));
    await waitFor(
      () => roster.every((d) => committed(vrmPathForSpecies(d.species)) !== undefined),
      'every StrictMode figure committed',
    );
    await settle(DISPOSE_GRACE_PLUS_MS);
    // The simulated unmount's dispose was cancelled by the re-setup retain.
    expect(roster.every((d) => committed(vrmPathForSpecies(d.species)) !== undefined)).toBe(true);
    expect(vrmLoader._vrmInstanceCount()).toBe(roster.length);
    expect(parses - parsesBefore).toBe(roster.length);
    expect(renderReads.filter((r) => r.suspended)).toEqual([]);
    useNpcStore.setState({ npcs: [] });
    await settle(DISPOSE_GRACE_PLUS_MS);
    expect(vrmLoader._vrmInstanceCount()).toBe(0);
    await r3f.act(async () => root.unmount());
  }, 20_000);

  test('remote player VRM: warm read first, 0 suspended render reads, disposed on leave', async () => {
    vrmLoader._vrmClearAllCaches();
    resetRecords();
    const species = 'milady_official_5';
    expect(isVrmSpecies(species)).toBe(true);
    const path = vrmPathForSpecies(species);
    const player = {
      id: 'remote-t9',
      kind: 'human',
      userId: null,
      name: 'remote',
      x: 2_100,
      y: 2_100,
      prevX: 2_100,
      prevY: 2_100,
      ts: 0,
      tsDelta: 200,
      dirZ: 0,
      species,
      color: 0xffffff,
      activity: 'idle',
      isLocal: false,
    } as RemotePlayerState;
    usePlayerStore.setState({ players: [player] });
    const { root, committed } = await mount(createElement(RemotePlayers));
    await waitFor(() => committed(path) !== undefined, 'the remote figure committed');
    const warm = warmReads.filter((r) => r.path === path && r.id === player.id);
    const render = renderReads.filter((r) => r.path === path && r.id === player.id);
    expect(warm.length).toBeGreaterThan(0);
    expect(warm[0]!.seq).toBeLessThan(render[0]!.seq);
    expect(render[0]!.value).toBe(warm.at(-1)!.value);
    expect(renderReads.filter((r) => r.suspended)).toEqual([]);

    usePlayerStore.setState({ players: [] });
    await settle(DISPOSE_GRACE_PLUS_MS);
    expect(vrmLoader._vrmInstanceCount()).toBe(0);
    await r3f.act(async () => root.unmount());
  }, 20_000);
});
