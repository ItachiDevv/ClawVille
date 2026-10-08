/**
 * Post-reveal (slice-D) warm reads (web-load T10-C).
 *
 * Why: CPU-4x run N6 (T9 probe, mesh count at 114 s vs unthrottled) left
 * quest-bounty-pavilion 0/27, marketplace-stall 0/3 and quest-npc 0/3. These
 * props stream on the POST-REVEAL lane (`PostRevealGate`), whose release
 * render suspended on the GLB and could then commit only in a React Suspense
 * retry lane. Retry lanes never expire and every ~6/s SyncLane render of the
 * R3F root discards the retry work (gotcha
 * suspense-retry-lane-starvation-sync-store-updates.md). T7 fixed the
 * boot-critical lane with `warmRead`; `PostRevealGate` ignored it.
 *
 * Part 1 mounts the four REAL production props (quest-npc, marketplace-stall,
 * quest-bounty-pavilion, bazaar-stall) in a real R3F root on the REAL
 * post-reveal queue, with drei `useGLTF` wrapped by a recorder (pattern:
 * boot-critical-warm-read-parity.test.tsx). Per path it asserts: a warm read
 * ran outside render before the first render read, 0 render reads suspended,
 * and every read used the same (draco, meshopt, extender).
 *
 * Part 2 drives `BootStreamedContent` (post-reveal lane) with the REAL R3F
 * useLoader / suspend-react cache and a controllable loader: without
 * `warmRead` the lane behaves exactly as before (reports 'loading' at the
 * release, suspends once, commits after the load); with `warmRead` it loads
 * outside React, commits with 0 suspensions (also under StrictMode), keeps
 * the failure path, and an unmount before the warm resolves cancels the flip.
 *
 * One stand-in: the warm attachment (pass-through). Runs in its own process
 * (mock.module is process-global).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Fragment, StrictMode, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type * as THREE from 'three';

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'HTMLDivElement', 'Event', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const threeCjs = require('three') as typeof import('three');

// --- Part 1: drei useGLTF recorder ------------------------------------------

type Read = {
  path: string;
  draco: unknown;
  meshopt: unknown;
  extender: unknown;
  inRender: boolean;
  threw: boolean;
};
const reads: Read[] = [];
const gltfCache = new Map<string, { scene: InstanceType<typeof threeCjs.Group>; animations: never[] }>();
const gltfLoading = new Map<string, Promise<void>>();

function cannedGltf(path: string) {
  let gltf = gltfCache.get(path);
  if (!gltf) {
    const scene = new threeCjs.Group();
    const mesh = new threeCjs.Mesh(
      new threeCjs.BoxGeometry(10, 20, 10),
      new threeCjs.MeshStandardMaterial(),
    );
    mesh.name = 'post-reveal-mesh';
    scene.add(mesh);
    gltf = { scene, animations: [] };
    gltfCache.set(path, gltf);
  }
  return gltf;
}

/** drei's own defaults: an undefined flag means `true`. */
const flag = (value: unknown) => (value === undefined ? true : value);

function recordingUseGLTF(path: string, draco?: unknown, meshopt?: unknown, extender?: unknown) {
  const read: Read = {
    path,
    draco: flag(draco),
    meshopt: flag(meshopt),
    extender,
    // A warm read runs inside warmSuspenseRead (outside React); every other
    // read here comes from a member's render.
    inRender: !(new Error().stack ?? '').includes('warmSuspenseRead'),
    threw: false,
  };
  reads.push(read);
  if (gltfCache.has(path)) return cannedGltf(path);
  let pending = gltfLoading.get(path);
  if (!pending) {
    pending = new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() => {
      cannedGltf(path);
    });
    gltfLoading.set(path, pending);
  }
  read.threw = true;
  throw pending;
}

mock.module('./deferred-warm-attachment', () => ({
  DeferredWarmAttachment: ({ children }: { children: ReactNode | ((ready: boolean) => ReactNode) }) =>
    createElement(Fragment, null, typeof children === 'function' ? children(true) : children),
}));

// --- Part 2: controllable three-style loader for the real useLoader ----------

type PendingLoad = { url: string; onLoad: (data: unknown) => void; onError: (error: unknown) => void };
const pendingLoads: PendingLoad[] = [];

class ControlledLoader {
  load(url: string, onLoad: (data: unknown) => void, _onProgress?: unknown, onError?: (error: unknown) => void): void {
    pendingLoads.push({ url, onLoad, onError: onError ?? (() => undefined) });
  }
}

type R3F = typeof import('@react-three/fiber');
let r3f: R3F;
let BootStreamedContent: typeof import('./boot-streamed-content').BootStreamedContent;
let props: Record<string, () => ReactNode>;

/** Cohort transitions in report order (the real reporter still runs). */
const cohortLog: Array<[string, string]> = [];
let cohort: typeof import('./boot-stream-cohort');

let suspensions = 0;
const reported: unknown[] = [];
const reportErrorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'reportError');

function readModel(url: string): unknown {
  return r3f.useLoader(ControlledLoader as never, url);
}

function Content({ url, name }: { url: string; name: string }) {
  try {
    readModel(url);
  } catch (thrown) {
    if (thrown && typeof (thrown as { then?: unknown }).then === 'function') suspensions += 1;
    throw thrown;
  }
  return createElement('mesh', { name });
}

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
  // R3F 9 reports boundary-CAUGHT render errors through `reportError`
  // (captured at module load); record instead of failing the test.
  Object.defineProperty(globalThis, 'reportError', {
    value: (error: unknown) => {
      reported.push(error);
    },
    configurable: true,
    writable: true,
  });

  const realCohort = await import('./boot-stream-cohort');
  const realReport = realCohort.reportCohortState;
  mock.module('./boot-stream-cohort', () => ({
    ...realCohort,
    reportCohortState: (id: string, state: string) => {
      cohortLog.push([id, state]);
      realReport(id, state as never);
    },
  }));
  const realDrei = await import('@react-three/drei');
  mock.module('@react-three/drei', () => ({
    ...realDrei,
    useGLTF: Object.assign(recordingUseGLTF, {
      preload: () => undefined,
      clear: () => undefined,
      setDecoderPath: () => undefined,
    }),
  }));

  r3f = await import('@react-three/fiber');
  r3f.extend(threeCjs as never);
  cohort = await import('./boot-stream-cohort');
  ({ BootStreamedContent } = await import('./boot-streamed-content'));
  props = {
    'npc:quest-npc': (await import('./quest-npc')).default as never,
    'prop:marketplace-stall': (await import('./marketplace-stall')).default as never,
    'prop:quest-bounty-pavilion': (await import('./quest-bounty-pavilion')).default as never,
    'prop:bazaar-stall': (await import('./bazaar-stall')).default as never,
  };

  // Post-reveal eligibility = boot-core presented + decorative release +
  // overlay/curtain gone + visible (recipe: boot-core-sliceD.test.ts).
  const release = await import('./decorative-release');
  (testWindow as unknown as { __W3D_READY?: boolean }).__W3D_READY = true;
  release.armBootCorePresented('t10c-test');
  release.notifyBootCoreScenePresented();
  release.notifyBootCoreScenePresented();
  release.armDecorativeReleaseOnFirstPaint('t10c-test');
  release.releaseDecorative('t10c-test');
  expect(release.isBootStreamEligible()).toBe(true);
});

afterAll(async () => {
  if (reportErrorDescriptor) Object.defineProperty(globalThis, 'reportError', reportErrorDescriptor);
  else delete (globalThis as Record<string, unknown>).reportError;
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

async function waitFor(ready: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await r3f.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function createTestRoot() {
  const canvas = testWindow.document.createElement('canvas');
  testWindow.document.body.appendChild(canvas);
  const root = r3f.createRoot(canvas as unknown as HTMLCanvasElement);
  await root.configure({
    gl: fakeRenderer(canvas) as never,
    size: { width: 320, height: 200, top: 0, left: 0 },
    frameloop: 'never',
  });
  return root;
}

const statesFor = (id: string) => cohortLog.filter(([member]) => member === id).map(([, state]) => state);

describe('post-reveal props: warm read matches the production render read (T10-C)', () => {
  test(
    'quest-npc, marketplace-stall, quest-bounty-pavilion, bazaar-stall: warmed outside render, 0 render suspensions',
    async () => {
      const root = await createTestRoot();
      await r3f.act(async () => {
        root.render(
          createElement(
            Fragment,
            null,
            ...Object.entries(props).map(([id, Prop]) => createElement(Prop, { key: id })),
          ),
        );
      });

      // A render read that RETURNED = the content committed its model read.
      const committedPaths = () =>
        new Set(reads.filter((r) => r.inRender && !r.threw).map((r) => r.path));
      // One member per idle tick after the 1.5 s first-drain quiet period.
      await waitFor(() => committedPaths().size >= 4, '4 props read their model');

      const paths = [...committedPaths()].sort();
      expect(paths).toEqual([
        '/models/bazaar-merchant-stand-ktx.glb?v=3',
        '/models/crayfish-ktx.glb?v=2',
        '/models/quest-bounty-pavilion-nonorm-ktx.glb',
        '/models/shisha-oasis-mo-ktx.glb',
      ]);

      const problems: string[] = [];
      for (const path of paths) {
        const forPath = reads.filter((r) => r.path === path);
        const firstRender = forPath.findIndex((r) => r.inRender);
        const warmBefore = forPath.slice(0, firstRender).filter((r) => !r.inRender);
        if (warmBefore.length === 0) problems.push(`${path}: no warm read outside render before the first render read`);
        const suspended = forPath.filter((r) => r.inRender && r.threw).length;
        if (suspended > 0) problems.push(`${path}: ${suspended} render read(s) suspended`);
        const options = new Set(forPath.map((r) => `${String(r.draco)}|${String(r.meshopt)}`));
        const extenders = new Set(forPath.map((r) => r.extender));
        if (options.size !== 1) problems.push(`${path}: loader flags differ ${[...options].join(' vs ')}`);
        if (extenders.size !== 1) problems.push(`${path}: ${extenders.size} different loader extenders`);
      }
      const warmOnly = [...new Set(reads.filter((r) => !r.inRender).map((r) => r.path))].filter(
        (p) => !paths.includes(p),
      );
      for (const p of warmOnly) problems.push(`${p}: warmed but never read by a render (path mismatch)`);
      expect(problems).toEqual([]);

      // Cohort order: 'loading' never lands after the content commit probe.
      for (const id of Object.keys(props)) {
        const states = statesFor(id);
        expect(states).toContain('warm-pending');
        expect(states.lastIndexOf('loading')).toBeLessThan(states.indexOf('warm-pending'));
      }
      expect(reported).toEqual([]);

      await r3f.act(async () => root.unmount());
    },
    30_000,
  );
});

describe('BootStreamedContent post-reveal lane with the real useLoader cache', () => {
  const loadFor = (url: string) => pendingLoads.find((p) => p.url === url);

  async function mountMember(
    cohortId: string,
    url: string,
    name: string,
    opts: { warm: boolean; strict?: boolean; revealRequired?: boolean; read?: () => unknown },
  ) {
    const root = await createTestRoot();
    const warmRead = opts.read ?? (opts.warm ? () => readModel(url) : undefined);
    const member = createElement(BootStreamedContent, {
      cohortId,
      priority: 0,
      ...(opts.revealRequired ? { revealRequired: true } : {}),
      ...(warmRead ? { warmRead } : {}),
      children: createElement(Content, { url, name }),
    });
    let store!: ReturnType<typeof root.render>;
    await r3f.act(async () => {
      store = root.render(opts.strict ? createElement(StrictMode, null, member) : member);
    });
    const find = () => store.getState().scene.getObjectByName(name) as THREE.Object3D | undefined;
    return { root, find };
  }

  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  test(
    'without warmRead: unchanged (loading at release, suspends in render, commits after the load)',
    async () => {
      suspensions = 0;
      const id = 'building:cove';
      const url = '/models/t10c-no-warm.glb';
      const { root, find } = await mountMember(id, url, 't10c-no-warm', { warm: false });
      // The release render itself starts the load (no warm read).
      await waitFor(() => loadFor(url) !== undefined, 'release render started the load');
      expect(statesFor(id)).toEqual(['mounted', 'loading']);
      // The release render suspends (React 19 renders the suspended tree
      // twice); the content can then commit only through a retry.
      expect(suspensions).toBeGreaterThanOrEqual(1);
      const atRelease = suspensions;
      expect(find()).toBeUndefined();

      await r3f.act(async () => {
        loadFor(url)!.onLoad({});
        await flush();
      });
      await waitFor(() => find() !== undefined, 'content committed after the load');
      expect(suspensions).toBe(atRelease);
      expect(statesFor(id)).toEqual(['mounted', 'loading', 'warm-pending']);
      expect(pendingLoads.filter((p) => p.url === url).length).toBe(1);
      await r3f.act(async () => root.unmount());
    },
    20_000,
  );

  test(
    'with warmRead (StrictMode): loads outside React, commits with 0 suspensions, one load',
    async () => {
      suspensions = 0;
      const id = 'building:memory-rag';
      const url = '/models/t10c-warm.glb';
      const { root, find } = await mountMember(id, url, 't10c-warm', { warm: true, strict: true });
      await waitFor(() => loadFor(url) !== undefined, 'admission started the load');
      expect(find()).toBeUndefined();
      expect(statesFor(id).at(-1)).toBe('loading');

      await r3f.act(async () => {
        loadFor(url)!.onLoad({});
        await flush();
      });
      expect(suspensions).toBe(0);
      expect(find()).toBeDefined();
      expect(statesFor(id).at(-1)).toBe('warm-pending');
      expect(pendingLoads.filter((p) => p.url === url).length).toBe(1);
      expect(reported).toEqual([]);
      await r3f.act(async () => root.unmount());
    },
    20_000,
  );

  test(
    'with warmRead: a failed load releases and the render rethrows into the boundary (failed, 0 suspensions)',
    async () => {
      suspensions = 0;
      reported.length = 0;
      const id = 'building:agent-security';
      const url = '/models/t10c-missing.glb';
      const failedBefore = cohort.getCohortCounts().failed;
      const warn = console.warn;
      console.warn = () => undefined; // StreamBoundary logs the drop.
      try {
        const { root, find } = await mountMember(id, url, 't10c-missing', { warm: true });
        await waitFor(() => loadFor(url) !== undefined, 'admission started the load');
        await r3f.act(async () => {
          loadFor(url)!.onError(new Error('404'));
          await flush();
        });
        expect(suspensions).toBe(0);
        expect(find()).toBeUndefined();
        expect(cohort.getCohortCounts().failed).toBe(failedBefore + 1);
        expect(reported.map((e) => (e as Error).message)).toEqual([
          'Could not load /models/t10c-missing.glb: 404',
        ]);
        await r3f.act(async () => root.unmount());
      } finally {
        console.warn = warn;
      }
    },
    20_000,
  );

  test(
    'with warmRead: unmount before the warm resolves cancels the release',
    async () => {
      suspensions = 0;
      reported.length = 0;
      const id = 'building:cron-automation';
      const url = '/models/t10c-cancel.glb';
      const { root, find } = await mountMember(id, url, 't10c-cancel', { warm: true });
      await waitFor(() => loadFor(url) !== undefined, 'admission started the load');
      await r3f.act(async () => root.unmount());
      const before = statesFor(id).length;
      await r3f.act(async () => {
        loadFor(url)!.onLoad({});
        await flush();
      });
      expect(find()).toBeUndefined();
      expect(suspensions).toBe(0);
      expect(statesFor(id).length).toBe(before);
      expect(statesFor(id)).not.toContain('warm-pending');
      expect(reported).toEqual([]);
    },
    20_000,
  );

  // Codex E3 BLOCKER (T10 batch, 14:41Z): the stream queue marks a member
  // delivered at ADMISSION, before its warm read resolves. A remount in that
  // window used to start released and read the still-loading entry in
  // render (a suspension -> the starvable retry lane). Each hook instance
  // must see its own resolved warm read before its content renders.
  for (const lane of [
    { name: 'post-reveal', revealRequired: false, ids: ['building:deployment-ops', 'building:claw-arcade'] },
    { name: 'boot-critical', revealRequired: true, ids: ['building:visual-creation', 'building:code-development'] },
  ] as const) {
    test(
      `${lane.name}: admit -> unmount during the pending warm -> remount: 0 suspensions, commits after the warm`,
      async () => {
        suspensions = 0;
        reported.length = 0;
        const url = `/models/t10c-remount-pending-${lane.name}.glb`;
        const name = `t10c-remount-pending-${lane.name}`;
        const opts = { warm: true, revealRequired: lane.revealRequired };
        const first = await mountMember(lane.ids[0], url, name, opts);
        await waitFor(() => loadFor(url) !== undefined, 'admission started the load');
        await r3f.act(async () => first.root.unmount());

        // The member is now delivered; its load is still pending.
        const second = await mountMember(lane.ids[0], url, name, opts);
        await r3f.act(async () => {
          await flush();
        });
        expect(second.find()).toBeUndefined();
        expect(suspensions).toBe(0);

        await r3f.act(async () => {
          loadFor(url)!.onLoad({});
          await flush();
        });
        await waitFor(() => second.find() !== undefined, 'remounted content committed after the warm');
        expect(suspensions).toBe(0);
        expect(pendingLoads.filter((p) => p.url === url).length).toBe(1);
        expect(reported).toEqual([]);
        await r3f.act(async () => second.root.unmount());
      },
      20_000,
    );

    test(
      `${lane.name}: remount after the warm finished releases at once with 0 suspensions`,
      async () => {
        suspensions = 0;
        reported.length = 0;
        const url = `/models/t10c-remount-warm-${lane.name}.glb`;
        const name = `t10c-remount-warm-${lane.name}`;
        const opts = { warm: true, revealRequired: lane.revealRequired };
        const first = await mountMember(lane.ids[1], url, name, opts);
        await waitFor(() => loadFor(url) !== undefined, 'admission started the load');
        await r3f.act(async () => {
          loadFor(url)!.onLoad({});
          await flush();
        });
        await waitFor(() => first.find() !== undefined, 'first mount committed');
        await r3f.act(async () => first.root.unmount());

        // Content commits in the remount's FIRST commit: no queue tick, no
        // load, no suspension, no extra render. Proof: child passive effects
        // run before parent ones in one commit, so the content probe's
        // 'warm-pending' precedes StreamedChain's 'mounted'. A release one
        // render later would log 'mounted' first.
        const logBefore = statesFor(lane.ids[1]).length;
        const second = await mountMember(lane.ids[1], url, name, opts);
        expect(second.find()).toBeDefined();
        expect(statesFor(lane.ids[1]).slice(logBefore)).toEqual(['warm-pending', 'mounted']);
        expect(suspensions).toBe(0);
        expect(pendingLoads.filter((p) => p.url === url).length).toBe(1);
        expect(reported).toEqual([]);
        await r3f.act(async () => second.root.unmount());
      },
      20_000,
    );
  }

  // Codex E3 re-check BLOCKER (15:01Z): warmSuspenseRead never rejects, so
  // its completion does not prove the entry is still ready. A failed entry
  // that is CLEARED after the warm saw it (ModelLoadBoundary clear(), any
  // eviction) made the release render start a NEW load and suspend. The
  // reader below clears the entry in the microtask after a read threw the
  // cached Error: after warmSuspenseRead returned, before the release.
  const isThen = (value: unknown) =>
    !!value && typeof (value as { then?: unknown }).then === 'function';
  function clearingRead(url: string, clears: { left: number }) {
    return () => {
      try {
        return readModel(url);
      } catch (thrown) {
        if (!isThen(thrown) && clears.left > 0) {
          clears.left -= 1;
          queueMicrotask(() => r3f.useLoader.clear(ControlledLoader as never, url));
        }
        throw thrown;
      }
    };
  }
  const loadsFor = (url: string) => pendingLoads.filter((p) => p.url === url);

  for (const lane of [
    { name: 'post-reveal', revealRequired: false, id: 'building:app-publishing' },
    { name: 'boot-critical', revealRequired: true, id: 'building:api-integrations' },
  ] as const) {
    test(
      `${lane.name}: failed read, entry cleared, retry load -> 0 suspended render reads before the retry resolves`,
      async () => {
        suspensions = 0;
        reported.length = 0;
        const url = `/models/t10c-cleared-${lane.name}.glb`;
        const name = `t10c-cleared-${lane.name}`;
        const read = clearingRead(url, { left: 1 });
        const { root, find } = await mountMember(lane.id, url, name, {
          warm: true,
          revealRequired: lane.revealRequired,
          read,
        });
        await waitFor(() => loadsFor(url).length === 1, 'admission started the load');
        await r3f.act(async () => {
          loadsFor(url)[0]!.onError(new Error('flaky'));
          await flush();
        });
        // The cleared entry needs a retry load; nothing may render-suspend.
        await waitFor(() => loadsFor(url).length === 2, 'the retry load started');
        expect(suspensions).toBe(0);
        expect(find()).toBeUndefined();

        await r3f.act(async () => {
          loadsFor(url)[1]!.onLoad({});
          await flush();
        });
        await waitFor(() => find() !== undefined, 'content committed after the retry load');
        expect(suspensions).toBe(0);
        expect(loadsFor(url).length).toBe(2);
        expect(reported).toEqual([]);
        await r3f.act(async () => root.unmount());
      },
      20_000,
    );
  }

  test(
    'a permanent failure with clears does not loop: bounded loads, then the member fails',
    async () => {
      suspensions = 0;
      reported.length = 0;
      const id = 'npc:town-guide';
      const url = '/models/t10c-permanent.glb';
      const failedBefore = cohort.getCohortCounts().failed;
      const settled = new Set<PendingLoad>();
      const failAll = () => {
        for (const load of loadsFor(url)) {
          if (settled.has(load)) continue;
          settled.add(load);
          load.onError(new Error('gone'));
        }
      };
      const warn = console.warn;
      console.warn = () => undefined; // StreamBoundary logs the drop.
      try {
        const { root } = await mountMember(id, url, 't10c-permanent', {
          warm: true,
          read: clearingRead(url, { left: 100 }),
        });
        const deadline = Date.now() + 10_000;
        while (cohort.getCohortCounts().failed === failedBefore) {
          if (Date.now() > deadline) throw new Error('member never failed');
          await r3f.act(async () => {
            failAll();
            await new Promise((resolve) => setTimeout(resolve, 10));
          });
        }
        const loads = loadsFor(url).length;
        // 1 admission load + at most 3 warm-round retries + 1 render load.
        expect(loads).toBeLessThanOrEqual(5);
        await r3f.act(async () => {
          failAll();
          await new Promise((resolve) => setTimeout(resolve, 200));
        });
        expect(loadsFor(url).length).toBe(loads);
        await r3f.act(async () => root.unmount());
      } finally {
        console.warn = warn;
      }
    },
    20_000,
  );

  // Codex E3 (15:08Z) BLOCKER: a clear AFTER the final out-of-render peek
  // (before the release render) still made the release render suspend.
  // Inside one act, React holds the release render until the act ends, so
  // the test clears the failed entry exactly in that window. The gate must
  // re-check during its render, render null, warm again, and commit after
  // the retry load. Ids outside the cohort: reportCohortState warns only.
  for (const lane of [
    { name: 'post-reveal', revealRequired: false },
    { name: 'boot-critical', revealRequired: true },
  ] as const) {
    test(
      `${lane.name}: entry cleared after the warm, before the release render -> 0 suspensions, re-warm, commit after the retry`,
      async () => {
        suspensions = 0;
        reported.length = 0;
        const id = `test:t10c-late-clear-${lane.name}`;
        const url = `/models/t10c-late-clear-${lane.name}.glb`;
        const name = `t10c-late-clear-${lane.name}`;
        const warn = console.warn;
        console.warn = () => undefined;
        try {
          const { root, find } = await mountMember(id, url, name, {
            warm: true,
            revealRequired: lane.revealRequired,
          });
          await waitFor(() => loadsFor(url).length === 1, 'admission started the load');
          await r3f.act(async () => {
            loadsFor(url)[0]!.onError(new Error('flaky'));
            await flush(); // every warm/peek microtask settles; no render yet
            r3f.useLoader.clear(ControlledLoader as never, url);
          });
          await waitFor(() => loadsFor(url).length === 2, 'the gate restarted the load');
          expect(suspensions).toBe(0);
          expect(find()).toBeUndefined();

          await r3f.act(async () => {
            loadsFor(url)[1]!.onLoad({});
            await flush();
          });
          await waitFor(() => find() !== undefined, 'content committed after the retry load');
          expect(suspensions).toBe(0);
          expect(loadsFor(url).length).toBe(2);
          expect(reported).toEqual([]);
          await r3f.act(async () => root.unmount());
        } finally {
          console.warn = warn;
        }
      },
      20_000,
    );
  }

  test(
    'a released member stays released: a cleared failed entry + a gate re-render start no retry',
    async () => {
      suspensions = 0;
      reported.length = 0;
      const id = 'test:t10c-latch';
      const url = '/models/t10c-latch.glb';
      const read = () => readModel(url);
      const tree = (priority: number) =>
        createElement(BootStreamedContent, {
          cohortId: id,
          priority,
          warmRead: read,
          children: createElement(Content, { url, name: 't10c-latch' }),
        });
      const warn = console.warn;
      console.warn = () => undefined;
      try {
        const root = await createTestRoot();
        await r3f.act(async () => {
          root.render(tree(0));
        });
        await waitFor(() => loadsFor(url).length === 1, 'admission started the load');
        await r3f.act(async () => {
          loadsFor(url)[0]!.onError(new Error('404'));
          await flush();
        });
        await waitFor(() => reported.length === 1, 'the boundary caught the load error');
        // A clear of the failed entry (ModelLoadBoundary-style), then a
        // re-render of the gate with new props.
        await r3f.act(async () => {
          r3f.useLoader.clear(ControlledLoader as never, url);
          root.render(tree(1));
          await flush();
        });
        await r3f.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(loadsFor(url).length).toBe(1);
        expect(reported.length).toBe(1);
        expect(suspensions).toBe(0);
        await r3f.act(async () => root.unmount());
      } finally {
        console.warn = warn;
      }
    },
    20_000,
  );

  // Codex E3 (15:08Z) SHOULD-FIX: bgrParsed only after a successful READY
  // read: never after exhausted rounds, never on a cached failure.
  const phasesNow = () =>
    (globalThis.window as unknown as { __W3D_PHASES?: Record<string, unknown> }).__W3D_PHASES ?? {};

  test(
    'boot-critical: a failed load releases into the boundary without a bgrParsed stamp',
    async () => {
      reported.length = 0;
      const id = 'test:t10c-fail-stamp';
      const url = '/models/t10c-fail-stamp.glb';
      const warn = console.warn;
      console.warn = () => undefined;
      try {
        const { root, find } = await mountMember(id, url, 't10c-fail-stamp', {
          warm: true,
          revealRequired: true,
        });
        await waitFor(() => loadsFor(url).length === 1, 'admission started the load');
        await r3f.act(async () => {
          loadsFor(url)[0]!.onError(new Error('404'));
          await flush();
        });
        await waitFor(() => reported.length === 1, 'the boundary caught the load error');
        expect(find()).toBeUndefined();
        expect(phasesNow()[`bgrParsed:${id}`]).toBeUndefined();
        await r3f.act(async () => root.unmount());
      } finally {
        console.warn = warn;
      }
    },
    20_000,
  );

  test(
    'boot-critical: exhausted warm rounds release without a bgrParsed stamp',
    async () => {
      reported.length = 0;
      const id = 'test:t10c-exhausted-stamp';
      const url = '/models/t10c-exhausted-stamp.glb';
      const settled = new Set<PendingLoad>();
      const failAll = () => {
        for (const load of loadsFor(url)) {
          if (settled.has(load)) continue;
          settled.add(load);
          load.onError(new Error('gone'));
        }
      };
      const warn = console.warn;
      console.warn = () => undefined;
      try {
        const { root } = await mountMember(id, url, 't10c-exhausted-stamp', {
          warm: true,
          revealRequired: true,
          read: clearingRead(url, { left: 100 }),
        });
        const deadline = Date.now() + 10_000;
        while (reported.length === 0) {
          if (Date.now() > deadline) throw new Error('member never failed');
          await r3f.act(async () => {
            failAll();
            await new Promise((resolve) => setTimeout(resolve, 10));
          });
        }
        expect(loadsFor(url).length).toBeLessThanOrEqual(5);
        expect(phasesNow()[`bgrParsed:${id}`]).toBeUndefined();
        await r3f.act(async () => root.unmount());
      } finally {
        console.warn = warn;
      }
    },
    20_000,
  );

  test(
    'boot-critical: a remount warmed in its first render still stamps bgrParsed',
    async () => {
      const id = 'building:mcp-tool-use';
      const url = '/models/t10c-stamp.glb';
      const name = 't10c-stamp';
      const phases = () =>
        (globalThis.window as unknown as { __W3D_PHASES?: Record<string, unknown> }).__W3D_PHASES ?? {};
      const first = await mountMember(id, url, name, { warm: true, revealRequired: true });
      await waitFor(() => loadFor(url) !== undefined, 'admission started the load');
      // The first mount ends before its warm resolves: it must not stamp.
      await r3f.act(async () => first.root.unmount());
      await r3f.act(async () => {
        loadFor(url)!.onLoad({});
        await flush();
      });
      expect(phases()[`bgrParsed:${id}`]).toBeUndefined();

      const second = await mountMember(id, url, name, { warm: true, revealRequired: true });
      expect(second.find()).toBeDefined();
      expect(typeof phases()[`bgrParsed:${id}`]).toBe('number');
      await r3f.act(async () => second.root.unmount());
    },
    20_000,
  );
});
