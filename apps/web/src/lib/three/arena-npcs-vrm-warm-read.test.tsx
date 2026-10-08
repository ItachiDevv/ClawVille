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
 *
 * GLB wanderers (web-load T10-D): the lobster wanderer still revealed through
 * <Suspense> around useGLTFWithKTX2 (no warm). NpcEntry now warm-reads it with
 * useGLBWarmRead (warmSuspenseRead + readGLTFWithKTX2, the same drei call).
 * drei's useGLTF is a recorder that emulates the suspend-react cache by path.
 * For every GLB wanderer in NPC_DEFINITIONS: a warm read before the first
 * render read, 0 suspended render reads, one load, identical (path, flags,
 * extender), the same GLTF object; a failed GLB skips only that figure with
 * one console.error and the boundary evicts the entry (a remount loads
 * again); an unmount mid-warm reads nothing more; StrictMode loads once.
 * Runs in its own process (mock.module is process-global).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Fragment, StrictMode, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type * as THREE from 'three';
import { NPC_DEFINITIONS } from '@clawville/shared';
import { isModelLoadError } from './model-load-error';
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

// ---------------------------------------------------------------------------
// GLB wanderer reads (web-load T10-D): drei's useGLTF is replaced by a
// recorder that emulates the suspend-react cache BY PATH (R3F useLoader keys
// [GLTFLoader, path]): the first read throws the load promise, later reads
// return the cached GLTF (the same object), a failed load rethrows R3F's
// cached `Could not load <path>: ...` Error until useGLTF.clear(path) evicts
// the entry. Every read records its (path, draco, meshopt, extender) and
// whether it ran inside warmSuspenseRead (warm) or in a React render.
// ---------------------------------------------------------------------------

type GlbRead = {
  seq: number;
  path: string;
  draco: unknown;
  meshopt: unknown;
  extender: unknown;
  warm: boolean;
  suspended: boolean;
  value: unknown;
  error: unknown;
};
const glbReads: GlbRead[] = [];
const glbCache = new Map<string, { scene: InstanceType<typeof threeCjs.Group> }>();
const glbFailed = new Map<string, Error>();
const glbLoading = new Map<string, Promise<void>>();
const glbLoads = new Map<string, number>();
const glbFailingPaths = new Set<string>();
/** While set, every GLB load waits for it (to unmount mid-warm). */
let glbGate: Promise<void> | null = null;

/** drei's own defaults: an undefined flag means `true`. */
const dreiFlag = (value: unknown) => (value === undefined ? true : value);

function recordingUseGLTF(path: string, draco?: unknown, meshopt?: unknown, extender?: unknown): unknown {
  const read: GlbRead = {
    seq: (seq += 1),
    path,
    draco: dreiFlag(draco),
    meshopt: dreiFlag(meshopt),
    extender,
    warm: (new Error().stack ?? '').includes('warmSuspenseRead'),
    suspended: false,
    value: undefined,
    error: undefined,
  };
  glbReads.push(read);
  const failure = glbFailed.get(path);
  if (failure) {
    read.error = failure;
    throw failure; // R3F rethrows the SAME cached Error on every read.
  }
  const cached = glbCache.get(path);
  if (cached) {
    read.value = cached;
    return cached;
  }
  let pending = glbLoading.get(path);
  if (!pending) {
    glbLoads.set(path, (glbLoads.get(path) ?? 0) + 1);
    const gate = glbGate;
    pending = new Promise<void>((resolve) => setTimeout(resolve, 2))
      .then(() => gate ?? undefined)
      .then(() => {
        if (glbFailingPaths.has(path)) {
          glbFailed.set(path, new Error(`Could not load ${path}: 404 test`));
          return;
        }
        const scene = new threeCjs.Group();
        scene.name = `fake-glb:${path}`;
        scene.add(
          new threeCjs.Mesh(new threeCjs.BoxGeometry(1, 1, 1), new threeCjs.MeshStandardMaterial()),
        );
        glbCache.set(path, { scene });
      });
    glbLoading.set(path, pending);
  }
  read.suspended = true;
  throw pending;
}

function clearGlbEntry(path: string | string[]): void {
  for (const p of typeof path === 'string' ? [path] : path) {
    glbCache.delete(p);
    glbFailed.delete(p);
    glbLoading.delete(p);
  }
}

function resetGlb(): void {
  glbReads.length = 0;
  glbCache.clear();
  glbFailed.clear();
  glbLoading.clear();
  glbLoads.clear();
  glbFailingPaths.clear();
  glbGate = null;
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
let glbPathForSpecies: ((species: string) => string) | undefined;
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

  const realDrei = await import('@react-three/drei');
  mock.module('@react-three/drei', () => ({
    ...realDrei,
    useGLTF: Object.assign(recordingUseGLTF, {
      preload: () => undefined,
      clear: clearGlbEntry,
      setDecoderPath: () => undefined,
    }),
  }));

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
  // Optional lookup so the fail-first run on the pre-T10-D module (no helper)
  // fails on the behaviour assertions, not at import.
  glbPathForSpecies = (npcs as Record<string, unknown>).glbPathForSpecies as typeof glbPathForSpecies;
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
  // GLBNpcMesh mounts a SkeletonUtils clone; Object3D.clone keeps the name.
  const committedGlb = (path: string) =>
    store.getState().scene.getObjectByName(`fake-glb:${path}`) as THREE.Object3D | undefined;
  return { root, committed, committedGlb };
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

function remotePlayer(id: string, species: string): RemotePlayerState {
  return {
    id,
    kind: 'human',
    userId: null,
    name: id,
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
    // The BOUNDARY evicted the failed entry on catch (error.clear()), long
    // before any dispose grace: only the healthy figure's entry is cached.
    expect(vrmLoader._vrmInstanceCount()).toBe(1);

    // Remount after the network recovers, INSIDE the 500 ms dispose grace
    // (the orphan bracket's dispose is still pending, so only the boundary's
    // clear can have removed the rejected entry): the figure requests again
    // and commits.
    failingPaths.delete(badPath);
    const before = requests.get(badPath) ?? 0;
    useNpcStore.setState({ npcs: [npcState(okDef.id, okDef.species, 0)] });
    await settle(20);
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
    const player = remotePlayer('remote-t9', species);
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

  test('a remote player LEAVING during a pending parse: 0 instances left, no late commit, no error', async () => {
    vrmLoader._vrmClearAllCaches();
    resetRecords();
    let openGate: () => void = () => undefined;
    parseGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const species = 'milady_official_6';
    expect(isVrmSpecies(species)).toBe(true);
    const path = vrmPathForSpecies(species);
    const player = remotePlayer('remote-t9-leaver', species);
    const parsesBefore = parses;
    usePlayerStore.setState({ players: [player] });
    const { root, committed } = await mount(createElement(RemotePlayers));
    await waitFor(() => parses > parsesBefore, 'the remote parse started');
    expect(vrmLoader._vrmInstanceCount()).toBe(1);

    // The player leaves while the parse is held open (inside act, so React's
    // test-only "not wrapped in act" warning cannot pollute the error check).
    await r3f.act(async () => {
      usePlayerStore.setState({ players: [] });
    });
    await settle(DISPOSE_GRACE_PLUS_MS);
    openGate();
    parseGate = null;
    await settle(100);
    expect(vrmLoader._vrmInstanceCount()).toBe(0);
    expect(committed(path)).toBeUndefined();
    expect(parses - parsesBefore).toBe(1);
    expect(renderReads.filter((r) => r.id === player.id)).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(reported).toEqual([]);
    await r3f.act(async () => root.unmount());
  }, 20_000);
});

// ---------------------------------------------------------------------------
// GLB wanderers (web-load T10-D)
// ---------------------------------------------------------------------------

const glbRoster = () => NPC_DEFINITIONS.filter((d) => !isVrmSpecies(d.species));
/** The model path the registry names for a GLB species. */
const registryGlbPath = (species: string) =>
  MODEL_REGISTRY[species as keyof typeof MODEL_REGISTRY]?.path;

describe('GLB wanderer figures commit without a Suspense retry (web-load T10-D)', () => {
  test('glbPathForSpecies is the GLB path for every GLB wanderer (incl. its ?v=)', () => {
    const roster = glbRoster();
    expect(roster.length).toBeGreaterThanOrEqual(1);
    expect(typeof glbPathForSpecies).toBe('function');
    for (const d of roster) {
      expect({ id: d.id, path: glbPathForSpecies!(d.species) }).toEqual({
        id: d.id,
        path: registryGlbPath(d.species)!,
      });
    }
  });

  test(
    'every GLB wanderer in NPC_DEFINITIONS: warm read first, same entry (path, flags, extender), 0 suspended render reads',
    async () => {
      vrmLoader._vrmClearAllCaches();
      resetRecords();
      resetGlb();
      const roster = glbRoster();
      expect(roster.length).toBeGreaterThanOrEqual(1);
      const paths = new Set<string>(roster.map((d) => registryGlbPath(d.species)!));
      useNpcStore.setState({ npcs: roster.map((d, i) => npcState(d.id, d.species, i)) });
      const { root, committedGlb } = await mount(createElement(ArenaNpcs));
      await waitFor(
        () => [...paths].every((p) => committedGlb(p) !== undefined),
        'every GLB wanderer figure committed',
      );

      const problems: string[] = [];
      for (const path of paths) {
        const forPath = glbReads.filter((r) => r.path === path);
        const firstRender = forPath.findIndex((r) => !r.warm);
        if (firstRender === -1) {
          problems.push(`${path}: never read by a render`);
          continue;
        }
        const warmBefore = forPath.slice(0, firstRender);
        if (warmBefore.length === 0) problems.push(`${path}: no warm read before the first render read`);
        const suspended = forPath.filter((r) => !r.warm && r.suspended).length;
        if (suspended > 0) problems.push(`${path}: ${suspended} render read(s) suspended`);
        const flags = new Set(forPath.map((r) => `${String(r.draco)}|${String(r.meshopt)}`));
        if (flags.size !== 1) problems.push(`${path}: loader flags differ ${[...flags].join(' vs ')}`);
        const extenders = new Set(forPath.map((r) => r.extender));
        if (extenders.size !== 1) problems.push(`${path}: ${extenders.size} different loader extenders`);
        if (glbLoads.get(path) !== 1) problems.push(`${path}: ${glbLoads.get(path) ?? 0} loads (want 1)`);
        // One cache entry: the warm's last read and the render read return
        // the SAME GLTF object, whose scene the figure cloned.
        const warmLast = warmBefore.at(-1);
        const render = forPath[firstRender]!;
        if (warmLast && render.value !== warmLast.value) problems.push(`${path}: warm and render read different entries`);
        if (render.value === undefined) problems.push(`${path}: the first render read returned nothing`);
      }
      for (const r of glbReads) {
        if (!paths.has(r.path)) problems.push(`${r.path}: read but not a GLB wanderer path`);
      }
      expect(problems).toEqual([]);
      expect(reported).toEqual([]);
      expect(consoleErrors).toEqual([]);

      useNpcStore.setState({ npcs: [] });
      await settle(20);
      for (const p of paths) expect(committedGlb(p)).toBeUndefined();
      await r3f.act(async () => root.unmount());
    },
    20_000,
  );

  test('a failed GLB wanderer skips only that figure (one console.error), the boundary clears its entry, a remount loads it again', async () => {
    vrmLoader._vrmClearAllCaches();
    resetRecords();
    resetGlb();
    const glbDef = glbRoster()[0]!;
    const okDef = NPC_DEFINITIONS.find((d) => d.id === 'milady-miu')!;
    const glbPath = registryGlbPath(glbDef.species)!;
    const okPath = vrmPathForSpecies(okDef.species);
    glbFailingPaths.add(glbPath);
    useNpcStore.setState({ npcs: [npcState(okDef.id, okDef.species, 0), npcState(glbDef.id, glbDef.species, 1)] });
    const { root, committed, committedGlb } = await mount(createElement(ArenaNpcs));
    await waitFor(() => committed(okPath) !== undefined, 'the healthy VRM figure committed');
    await waitFor(
      () => consoleErrors.some((m) => m.includes('figure skipped') && m.includes(glbPath)),
      'the failed GLB figure logged its skip',
    );
    await settle(20);
    expect(committedGlb(glbPath)).toBeUndefined();
    expect(consoleErrors.filter((m) => m.includes('figure skipped'))).toHaveLength(1);
    expect(glbReads.filter((r) => !r.warm && r.suspended)).toEqual([]);
    // The figure's render read the failed entry (it threw the cached Error
    // into the boundary), and the boundary evicted it on catch.
    expect(glbReads.some((r) => !r.warm && r.error instanceof Error)).toBe(true);
    expect(glbFailed.has(glbPath)).toBe(false);
    // R3F's caught-error report carries the TAGGED ModelLoadError for this
    // path (in a browser the boundary cancels that window "error" event; this
    // test's reportError stand-in dispatches no event, so it is recorded).
    expect(reported.length).toBeGreaterThan(0);
    for (const e of reported) {
      expect(isModelLoadError(e) && e.url === glbPath).toBe(true);
    }

    // The network recovers; the figure remounts and loads again.
    glbFailingPaths.delete(glbPath);
    const loadsBefore = glbLoads.get(glbPath) ?? 0;
    useNpcStore.setState({ npcs: [npcState(okDef.id, okDef.species, 0)] });
    await settle(20);
    useNpcStore.setState({ npcs: [npcState(okDef.id, okDef.species, 0), npcState(glbDef.id, glbDef.species, 1)] });
    await waitFor(() => committedGlb(glbPath) !== undefined, 'the remounted GLB figure committed');
    expect(glbLoads.get(glbPath) ?? 0).toBe(loadsBefore + 1);
    expect(glbReads.filter((r) => !r.warm && r.suspended)).toEqual([]);
    expect(consoleErrors.filter((m) => m.includes('figure skipped'))).toHaveLength(1);

    useNpcStore.setState({ npcs: [] });
    await settle(DISPOSE_GRACE_PLUS_MS);
    expect(vrmLoader._vrmInstanceCount()).toBe(0);
    await r3f.act(async () => root.unmount());
  }, 20_000);

  test('a GLB wanderer unmounted BEFORE its warm resolved: no render read, no commit, no read after cleanup, no error', async () => {
    vrmLoader._vrmClearAllCaches();
    resetRecords();
    resetGlb();
    let openGate: () => void = () => undefined;
    glbGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const def = glbRoster()[0]!;
    const path = registryGlbPath(def.species)!;
    useNpcStore.setState({ npcs: [npcState(def.id, def.species, 0)] });
    const { root, committedGlb } = await mount(createElement(ArenaNpcs));
    await waitFor(() => (glbLoads.get(path) ?? 0) === 1, 'the GLB load started');
    expect(glbReads.every((r) => r.warm)).toBe(true);

    await r3f.act(async () => {
      useNpcStore.setState({ npcs: [] });
    });
    const readsAtUnmount = glbReads.length;
    openGate();
    glbGate = null;
    await settle(50);
    expect(committedGlb(path)).toBeUndefined();
    expect(glbReads.filter((r) => !r.warm)).toEqual([]);
    // The cancelled warm did not re-read after its effect cleanup.
    expect(glbReads.length).toBe(readsAtUnmount);
    expect(glbLoads.get(path)).toBe(1);
    expect(consoleErrors).toEqual([]);
    expect(reported).toEqual([]);
    await r3f.act(async () => root.unmount());
  }, 20_000);

  test('StrictMode (effect setup/cleanup/setup): one GLB load, 0 suspended render reads, figure committed', async () => {
    vrmLoader._vrmClearAllCaches();
    resetRecords();
    resetGlb();
    const def = glbRoster()[0]!;
    const path = registryGlbPath(def.species)!;
    useNpcStore.setState({ npcs: [npcState(def.id, def.species, 0)] });
    const { root, committedGlb } = await mount(createElement(StrictMode, null, createElement(ArenaNpcs)));
    await waitFor(() => committedGlb(path) !== undefined, 'the StrictMode GLB figure committed');
    expect(glbLoads.get(path)).toBe(1);
    expect(glbReads.filter((r) => !r.warm && r.suspended)).toEqual([]);
    expect(glbReads.some((r) => r.warm)).toBe(true);
    expect(consoleErrors).toEqual([]);
    useNpcStore.setState({ npcs: [] });
    await settle(20);
    expect(committedGlb(path)).toBeUndefined();
    await r3f.act(async () => root.unmount());
  }, 20_000);
});
