/**
 * Cove figure model-load isolation (3da I2, 2026-10-06).
 *
 * The REAL scene components (cove local player, cove seated bust, the
 * /cove/baccarat, /cove/blackjack and /cove/table rooms) render inside a REAL
 * R3F reconciler root (fake renderer, no WebGL) with a mocked fetch. A VRM
 * that fails every request (HTTP 404, final at once) must remove only its
 * own figure:
 *
 * - nothing reaches the outer boundary (the stand-in for the R3F Canvas
 *   error bridge that rethrows into StageCanvasErrorBoundary / the page
 *   error screen);
 * - the rest of the room (shell, table, chairs, bet zones, cards, plates)
 *   is still in the scene graph;
 * - one "[3D] figure skipped" console.error per failed figure URL; R3F's
 *   duplicate window "error" report is cancelled.
 * - the cove LOCAL player falls back to the cove's own lobster body (the
 *   GLB branch that also drives WASD, E-key and the follow camera); if the
 *   lobster also fails, the player body renders nothing and the scene runs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Component, createElement, type ComponentType, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import * as THREE from 'three';
import { SEAT_MODEL_RETRY } from './holdem-table-layout';

const testWindow = new Window({
  // seatModels (dev/localhost only) puts the rigless lobster GLB at hold'em
  // seat index 1 so one sibling figure loads while the VRM figures fail.
  url: 'http://localhost/cove/table?seatModels=milady_official_2,lobster,hermes_female,milady_official_7,milady_official_4',
});
const globalNames = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'Event', 'ErrorEvent', 'KeyboardEvent', 'ProgressEvent', 'requestAnimationFrame', 'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
const originalReportError = globalThis.reportError;
let addedResizeObserver = false;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const threeCjs = require('three') as typeof THREE;

// useAvatar needs a QueryClient + API; the cove player only reads clawTokens.
mock.module('../../hooks/use-avatar', () => ({ useAvatar: () => ({ data: null }) }));

/** GLTFLoader sanitizes node names (drops '/', ':', '.'): use a safe form. */
const nodeName = (key: string) => `n_${key.replace(/[^A-Za-z0-9]/g, '_')}`;
const GLTF_FOR = (node: string) =>
  JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: node }] });

/** url (path + query) -> reply. Default: '.vrm' 404, anything else a tiny valid glTF. */
const replies = new Map<string, number | string>();
const requests = new Map<string, number>();

type R3F = typeof import('@react-three/fiber');
let r3f: R3F;
let cove: typeof import('./cove-interior');
let baccarat: typeof import('./baccarat-table-room');
let blackjack: typeof import('./blackjack-table-room');
let holdem: typeof import('./holdem-table-room');
let figures: typeof import('./cove-seat-figures');
// Retries re-request a failed seat model and log again; zero them so each failed URL logs exactly once.
SEAT_MODEL_RETRY.maxRetries = 0;
let fallbackModule: typeof import('./local-player-model-fallback');
let gameStore: typeof import('../../stores/game');
let registry: typeof import('./agent-model-registry');
let coveStore: typeof import('../../stores/cove');
let drei: typeof import('@react-three/drei');

type HappyErrorEvent = InstanceType<typeof testWindow.ErrorEvent>;
const reported: HappyErrorEvent[] = [];

function pathOf(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, 'http://localhost');
  return url.origin === 'http://localhost' ? `${url.pathname}${url.search}` : url.href;
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
  // happy-dom has no 2D canvas: a no-op context so the CanvasTexture plates
  // (dealer plate, card backs) build. Not a figure, never under test.
  const noop2d: object = new Proxy({}, {
    // Every method returns the stub itself (createLinearGradient -> an
    // object whose addColorStop is a no-op), measureText a zero width.
    get: (_target, key) => (key === 'measureText' ? () => ({ width: 0 }) : () => noop2d),
    set: () => true,
  });
  testWindow.HTMLCanvasElement.prototype.getContext = (() => noop2d) as never;
  // WorldLabelsOverlay (full cove scene) observes its overlay size; happy-dom
  // has no ResizeObserver. A no-op is enough: labels are not under test.
  addedResizeObserver = !('ResizeObserver' in globalThis);
  if (addedResizeObserver) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // R3F's reconciler root reports caught errors with reportError (a window
  // "error" event in browsers). Same contract as model-load-boundary.test.
  globalThis.reportError = (error: unknown) => {
    const event = new testWindow.ErrorEvent('error', {
      error: error as Error,
      message: String((error as Error)?.message ?? error),
      cancelable: true,
    });
    testWindow.dispatchEvent(event);
    reported.push(event);
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const key = pathOf(input);
    requests.set(key, (requests.get(key) ?? 0) + 1);
    const reply = replies.get(key) ?? (key.includes('.vrm') ? 404 : 'gltf');
    if (typeof reply === 'number') return new Response('missing', { status: reply });
    const node = reply === 'gltf' ? nodeName(key) : reply;
    return new Response(new TextEncoder().encode(GLTF_FOR(node)), { status: 200 });
  }) as typeof fetch;
  // drei useGLTF hands relative paths to three's FileLoader; resolve them
  // against the test origin like a browser would. Under bun, R3F + drei load
  // the CJS three build (three.cjs) while app code imports the ESM build:
  // two module instances here (one in the Next bundle), so set both.
  for (const instance of [THREE, threeCjs]) {
    instance.DefaultLoadingManager.setURLModifier((url) => new URL(url, 'http://localhost').href);
  }

  r3f = await import('@react-three/fiber');
  // <Canvas> runs extend(THREE) with R3F's own three; this test has no Canvas.
  r3f.extend(threeCjs as never);
  registry = await import('./agent-model-registry');
  drei = await import('@react-three/drei');
  fallbackModule = await import('./local-player-model-fallback');
  gameStore = await import('../../stores/game');
  coveStore = await import('../../stores/cove');
  cove = await import('./cove-interior');
  baccarat = await import('./baccarat-table-room');
  blackjack = await import('./blackjack-table-room');
  holdem = await import('./holdem-table-room');
  figures = await import('./cove-seat-figures');
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  globalThis.reportError = originalReportError;
  if (addedResizeObserver) delete (globalThis as Record<string, unknown>).ResizeObserver;
  for (const instance of [THREE, threeCjs]) instance.DefaultLoadingManager.setURLModifier(undefined);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  await testWindow.happyDOM.close();
});

afterEach(async () => {
  for (const mounted of [...openMounts]) await mounted.unmount().catch(() => undefined);
});

beforeEach(() => {
  reported.length = 0;
  fallbackModule.__resetLocalPlayerFallbackForTests();
  // The lobster GLB is loaded OK by one test and 404 in another: start each
  // test with no cached lobster entry (R3F useLoader cache is per URL).
  drei.useGLTF.clear(registry.MODEL_REGISTRY.lobster.path);
});

/** Stand-in for the R3F Canvas error bridge (rethrows to the DOM page). */
class OuterBoundary extends Component<{ onCatch: (error: unknown) => void; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onCatch(error);
  }
  render() {
    return this.state.failed ? null : (this.props.children ?? null);
  }
}

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

function captureConsoleError() {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  return { logged, restore: () => (console.error = original) };
}

/** Real-time bound for one wait; well under each test's own timeout. */
const WAIT_TIMEOUT_MS = 6_000;
const TEST_TIMEOUT_MS = 20_000;

/**
 * Flush React + R3F work inside act() until `ready()` holds, polling on the
 * REAL clock (no fake timers), bounded by `timeoutMs`. No fixed number of
 * rounds: it returns as soon as the scene reached the expected state, then
 * flushes once more so effects queued by that commit land.
 */
async function waitFor(ready: () => boolean, what: string, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await r3f.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  await r3f.act(async () => {
    await Promise.resolve();
  });
}

/** Roots a failed test left mounted; afterEach unmounts them (and restores console.error). */
const openMounts = new Set<Mounted>();

interface Mounted {
  scene: THREE.Scene;
  store: ReturnType<ReturnType<R3F['createRoot']>['render']>;
  outer: unknown[];
  logged: unknown[][];
  /** Re-render the root with a new element and wait for `until`. */
  rerender: (element: ReactNode, until: (m: Mounted) => boolean, what: string, timeoutMs?: number) => Promise<void>;
  unmount: () => Promise<void>;
}

/**
 * Render `element` in a real R3F root and wait until `until(mounted)` holds.
 * The wait also ends as soon as an error reaches the outer boundary, so the
 * unfixed code fails on the boundary assertion, not on a timeout.
 */
async function mountScene(element: ReactNode, until: (m: Mounted) => boolean, what: string): Promise<Mounted> {
  const canvas = testWindow.document.createElement('canvas');
  testWindow.document.body.appendChild(canvas);
  const root = r3f.createRoot(canvas as unknown as HTMLCanvasElement);
  await root.configure({
    gl: fakeRenderer(canvas) as never,
    size: { width: 320, height: 200, top: 0, left: 0 },
    frameloop: 'never',
  });
  const outer: unknown[] = [];
  const cap = captureConsoleError();
  const tree = (child: ReactNode) => createElement(OuterBoundary, { onCatch: (e) => outer.push(e) }, child);
  let store!: Mounted['store'];
  await r3f.act(async () => {
    store = root.render(tree(element));
  });
  const mounted: Mounted = {
    scene: store.getState().scene,
    store,
    outer,
    logged: cap.logged,
    rerender: async (next, nextUntil, nextWhat, timeoutMs) => {
      await r3f.act(async () => {
        root.render(tree(next));
      });
      await waitFor(() => outer.length > 0 || nextUntil(mounted), nextWhat, timeoutMs);
    },
    unmount: async () => {
      openMounts.delete(mounted);
      try {
        await r3f.act(async () => root.unmount());
        await waitFor(() => mounted.scene.children.length === 0, 'unmount cleared the scene');
      } finally {
        cap.restore();
      }
    },
  };
  openMounts.add(mounted);
  await waitFor(() => outer.length > 0 || until(mounted), what);
  return mounted;
}

const lines = (logged: unknown[][], prefix: string) =>
  logged.filter((args) => String(args[0]).startsWith(prefix)).map((args) => String(args[0]));
const skippedLines = (logged: unknown[][]) => lines(logged, '[3D] figure skipped');
/** Hold'em seats pass a placeholder fallback, so a failed seat logs "replaced by fallback"; the dealer logs "skipped". */
const holdemFailedLines = (logged: unknown[][]) => [
  ...skippedLines(logged),
  ...lines(logged, '[3D] figure replaced by fallback'),
];

function vrmPath(key: string): string {
  return (registry.MODEL_REGISTRY as Record<string, { path: string }>)[key]!.path;
}

type FeltView = import('./baccarat-table-room').BaccaratFeltView;
type SeatView = import('@clawville/shared').BaccaratTableSeatView;

/** An idle felt (no coup on the table) in the frozen BaccaratFeltView shape. */
function idleFeltView(): FeltView {
  return {
    coup: null,
    revealedStep: 0,
    dealSteps: [],
    phase: 'idle',
    betType: 'player',
    stake: 10,
    correlation: null,
    shoeId: null,
    bannerText: null,
    betzoneSelected: null,
  };
}

function seatView(seatIndex: number, avatarId: string, modelKey: string): SeatView {
  return {
    seatIndex,
    avatarId,
    name: `Seat ${seatIndex + 1}`,
    modelKey,
    subjectType: 'human',
    isSeeded: false,
    currentBet: null,
  };
}

function expectSceneSurvived(mounted: Mounted): void {
  expect(mounted.outer.map((e) => String((e as Error)?.message ?? e))).toEqual([]);
  expect(reported.every((event) => event.defaultPrevented)).toBe(true);
}

describe('cove table rooms: a failed figure model removes only that figure', () => {
  test('/cove/baccarat: dealer VRM 404 -> room, table, bet zones and plate render; no dealer; one line', async () => {
    const dealer = vrmPath('milady_official_6');
    replies.set(dealer, 404);
    const view = idleFeltView();
    const chairRequestsBefore = requests.get('/models/cove-chair-clean.glb') ?? 0;
    const mounted = await mountScene(
      createElement(baccarat.BaccaratTableRoomScene, { instanceId: 'bac-test', view }),
      (m) => skippedLines(m.logged).length >= 1 && Boolean(m.scene.getObjectByName('baccarat-bet-zones-merged')),
      'baccarat: dealer line + bet zones',
    );
    expectSceneSurvived(mounted);
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-room-only.glb'))).toBeTruthy();
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-table-clean.glb'))).toBeTruthy();
    expect(mounted.scene.getObjectByName('baccarat-bet-zones-merged')).toBeTruthy();
    expect(mounted.scene.getObjectByName('baccarat-room-dealer')).toBeUndefined();
    // The solo room (no `seats` prop) draws no chairs and requests no chair GLB.
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-chair-clean.glb'))).toBeUndefined();
    expect(requests.get('/models/cove-chair-clean.glb') ?? 0).toBe(chairRequestsBefore);
    const skipped = skippedLines(mounted.logged);
    expect(skipped.length).toBe(1);
    expect(skipped[0]).toContain(`baccarat-dealer ${dealer}`);
    await mounted.unmount();
  }, TEST_TIMEOUT_MS);

  test('/cove/baccarat shared table: a failed seat VRM shows the placeholder; the room, 5 chairs, the dealer plate and the other seats keep rendering', async () => {
    // Seat 0 is the viewer (the camera): its model is never requested. Seat 1
    // and seat 4 are VRMs that 404 (every .vrm 404s by default here); seat 2
    // is the rigless lobster, which loads; seat 3 holds a key that is not in
    // the registry; seat 5 is empty (empty chair, no figure).
    const viewerPath = vrmPath('milady_official_2');
    const hermes = vrmPath('hermes_female');
    const helen = vrmPath('helen'); // picker-hidden owned key: still the REAL model
    const lobster = vrmPath('lobster');
    const hashedKey = figures.stableAvatarModelKey('avatar-seat-3');
    // Guard: the hashed key must not equal another seat's or the dealer's
    // model, or the per-URL request and line counts below would mix seats.
    expect(['milady_official_2', 'hermes_female', 'lobster', 'helen', 'milady_official_6']).not.toContain(hashedKey);
    const viewerRequestsBefore = requests.get(viewerPath) ?? 0;
    const seats = [
      seatView(0, 'avatar-viewer', 'milady_official_2'),
      seatView(1, 'avatar-seat-1', 'hermes_female'),
      seatView(2, 'avatar-seat-2', 'lobster'),
      seatView(3, 'avatar-seat-3', 'not_a_registry_key'),
      seatView(4, 'avatar-seat-4', 'helen'),
    ];
    const mounted = await mountScene(
      createElement(baccarat.BaccaratTableRoomScene, {
        instanceId: 'bac-shared-test',
        view: idleFeltView(),
        seats,
        povSeatIndex: 0,
      }),
      (m) => holdemFailedLines(m.logged).some((line) => line.includes(`baccarat-seat:1 ${hermes}`))
        && holdemFailedLines(m.logged).some((line) => line.includes(`baccarat-seat:4 ${helen}`))
        && Boolean(m.scene.getObjectByName('holdem-avatar-lobster'))
        && Boolean(m.scene.getObjectByName('baccarat-bet-zones-merged')),
      'baccarat shared: seat 1 + seat 4 failed lines, lobster seat, bet zones',
    );
    expectSceneSurvived(mounted);
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-room-only.glb'))).toBeTruthy();
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-table-clean.glb'))).toBeTruthy();
    expect(mounted.scene.getObjectByName('baccarat-bet-zones-merged')).toBeTruthy();
    let chairs = 0;
    mounted.scene.traverse((object) => {
      if (object.name === nodeName('/models/cove-chair-clean.glb')) chairs += 1;
    });
    expect(chairs).toBe(5);
    // Figures for the 4 occupied non-POV seats only.
    for (const seat of [1, 2, 3, 4]) {
      expect(mounted.scene.getObjectByName(`baccarat-seat-${seat}`)).toBeTruthy();
    }
    expect(mounted.scene.getObjectByName('baccarat-seat-0')).toBeUndefined();
    expect(mounted.scene.getObjectByName('baccarat-seat-5')).toBeUndefined();
    expect(requests.get(viewerPath) ?? 0).toBe(viewerRequestsBefore);
    // The failed VRM seats show the placeholder, never an empty chair.
    expect(mounted.scene.getObjectByName('holdem-placeholder-seat-1')).toBeTruthy();
    expect(mounted.scene.getObjectByName('holdem-placeholder-seat-4')).toBeTruthy();
    // The wire modelKey picks the model: seat 2 is the lobster perch, seat 4
    // requested the picker-hidden `helen` VRM, seat 3 fell back to the hash.
    expect(mounted.scene.getObjectByName('holdem-avatar-lobster')).toBeTruthy();
    expect(mounted.scene.getObjectByName(nodeName(lobster))).toBeTruthy();
    expect(requests.get(helen) ?? 0).toBeGreaterThanOrEqual(1);
    expect(requests.get(vrmPath(hashedKey)) ?? 0).toBeGreaterThanOrEqual(1);
    const failed = holdemFailedLines(mounted.logged);
    expect(failed.filter((line) => line.includes(`baccarat-seat:1 ${hermes}`)).length).toBe(1);
    expect(failed.filter((line) => line.includes(`baccarat-seat:4 ${helen}`)).length).toBe(1);
    expect(failed.some((line) => line.includes('baccarat-seat:2'))).toBe(false);
    await mounted.unmount();
  }, TEST_TIMEOUT_MS);

  test('/cove/blackjack: dealer VRM 404 -> room and table render; no dealer; one line', async () => {
    const dealer = vrmPath('milady_official_6');
    replies.set(dealer, 404);
    const view = {
      dealerCards: [],
      playerHands: [],
      didSplit: false,
      activeSlot: 0,
      handlers: { reportCardOverflow: () => {} },
    } as unknown as Parameters<typeof blackjack.BlackjackTableRoomScene>[0]['view'];
    const mounted = await mountScene(
      createElement(blackjack.BlackjackTableRoomScene, { instanceId: 'bj-test', view }),
      (m) => skippedLines(m.logged).length >= 1 && Boolean(m.scene.getObjectByName(nodeName('/models/cove-table-clean.glb'))),
      'blackjack: dealer line + table',
    );
    expectSceneSurvived(mounted);
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-room-only.glb'))).toBeTruthy();
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-table-clean.glb'))).toBeTruthy();
    expect(mounted.scene.getObjectByName('blackjack-room-dealer')).toBeUndefined();
    const skipped = skippedLines(mounted.logged);
    expect(skipped.length).toBe(1);
    expect(skipped[0]).toContain(`blackjack-dealer ${dealer}`);
    await mounted.unmount();
  }, TEST_TIMEOUT_MS);

  test('/cove/table (hold\'em): every VRM figure 404 -> room, table, all 5 chairs and the rigless lobster seat render; one line per figure URL', async () => {
    const vrmKeys = ['milady_official_2', 'hermes_female', 'milady_official_7', 'milady_official_4', 'milady_official_6'];
    for (const key of vrmKeys) replies.set(vrmPath(key), 404);
    const lobster = vrmPath('lobster');
    const mounted = await mountScene(
      createElement(holdem.HoldemTableRoomScene, { instanceId: 'holdem-test' }),
      (m) => holdemFailedLines(m.logged).length >= vrmKeys.length && Boolean(m.scene.getObjectByName('holdem-avatar-lobster')),
      'holdem: 5 figure lines + the lobster seat',
    );
    expectSceneSurvived(mounted);
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-room-only.glb'))).toBeTruthy();
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-table-clean.glb'))).toBeTruthy();
    let chairs = 0;
    mounted.scene.traverse((object) => {
      if (object.name === nodeName('/models/cove-chair-clean.glb')) chairs += 1;
    });
    expect(chairs).toBe(5);
    // Sibling survival: the rigless GLB seat loaded while the VRM seats failed.
    expect(mounted.scene.getObjectByName('holdem-avatar-lobster')).toBeTruthy();
    expect(mounted.scene.getObjectByName(nodeName(lobster))).toBeTruthy();
    expect(mounted.scene.getObjectByName('holdem-room-dealer')).toBeUndefined();
    for (let seat = 1; seat <= 5; seat += 1) {
      expect(mounted.scene.getObjectByName(`holdem-seat-${seat}`)).toBeTruthy();
    }
    const skipped = holdemFailedLines(mounted.logged);
    expect(skipped.length).toBe(vrmKeys.length);
    for (const key of vrmKeys) {
      expect(skipped.filter((line) => line.includes(vrmPath(key))).length).toBe(1);
    }
    await mounted.unmount();
  }, TEST_TIMEOUT_MS);

  test('/cove/table (hold\'em): a rigless GLB seat that fails is skipped the same way', async () => {
    const lobster = vrmPath('lobster');
    replies.set(lobster, 404);
    const mounted = await mountScene(
      createElement(holdem.HoldemTableRoomScene, { instanceId: 'holdem-test-2' }),
      (m) => holdemFailedLines(m.logged).some((line) => line.includes(lobster))
        && Boolean(m.scene.getObjectByName(nodeName('/models/cove-table-clean.glb'))),
      'holdem: lobster seat line + table',
    );
    expectSceneSurvived(mounted);
    // The failed seat keeps a visible placeholder figure instead of an empty chair.
    expect(mounted.scene.getObjectByName('holdem-avatar-lobster')).toBeUndefined();
    expect(mounted.scene.getObjectByName('holdem-placeholder-seat-2')).toBeTruthy();
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-table-clean.glb'))).toBeTruthy();
    expect(holdemFailedLines(mounted.logged).filter((line) => line.includes(lobster)).length).toBe(1);
    replies.delete(lobster);
    await mounted.unmount();
  }, TEST_TIMEOUT_MS);

  test("/cove/table (hold'em): same figure id, NEW model path after a failure -> the seat boundary resets and requests the new model", async () => {
    // Seat slot 0 (engine seat 1) is milady_official_2 (seatModels query).
    // Its figure id is built from the model KEY, so changing only the path
    // keeps the id: the case of one avatar id whose model changed.
    const entry = registry.MODEL_REGISTRY.milady_official_2 as { path: string };
    const original = entry.path;
    const swapped = '/avatars/i2-swapped-model.vrm';
    replies.set(original, 404);
    replies.set(swapped, 404);
    try {
      const mounted = await mountScene(
        createElement(holdem.HoldemTableRoomScene, { instanceId: 'holdem-test-3' }),
        (m) => holdemFailedLines(m.logged).some((line) => line.includes(`holdem-seat:1 ${original}`)),
        'holdem: seat 1 first model failed',
      );
      expectSceneSurvived(mounted);
      expect(requests.get(swapped) ?? 0).toBe(0);
      entry.path = swapped;
      await mounted.rerender(
        createElement(holdem.HoldemTableRoomScene, { instanceId: 'holdem-test-3b' }),
        () => (requests.get(swapped) ?? 0) >= 1 && holdemFailedLines(mounted.logged).some((line) => line.includes(swapped)),
        'holdem: seat 1 boundary reset and requested the new model',
        3_000,
      );
      expectSceneSurvived(mounted);
      expect(requests.get(swapped)).toBeGreaterThanOrEqual(1);
      expect(holdemFailedLines(mounted.logged).filter((line) => line.includes(`holdem-seat:1 ${swapped}`)).length).toBe(1);
      await mounted.unmount();
    } finally {
      entry.path = original;
    }
  }, TEST_TIMEOUT_MS);
});

describe('cove interior: local player + seated bust', () => {
  test('local player VRM 404 -> the cove lobster body renders instead; one "replaced by fallback" line; one notice', async () => {
    const playerKey = 'milady_official_5';
    const playerPath = vrmPath(playerKey);
    const lobster = vrmPath('lobster');
    replies.set(playerPath, 404);
    replies.set(lobster, 'cove-lobster-root');
    gameStore.useGameStore.setState({ avatarModelKey: playerKey, toasts: [] });
    const mounted = await mountScene(
      createElement(cove.CovePlayerAvatar),
      (m) => Boolean(m.scene.getObjectByName('cove-lobster-root')) && gameStore.useGameStore.getState().toasts.length >= 1,
      'cove: lobster fallback body + notice',
    );
    expectSceneSurvived(mounted);
    expect(mounted.scene.getObjectByName('cove-lobster-root')).toBeTruthy();
    const replaced = lines(mounted.logged, '[3D] figure replaced by fallback');
    expect(replaced.length).toBe(1);
    expect(replaced[0]).toContain(`cove-player ${playerPath}`);
    expect(skippedLines(mounted.logged)).toEqual([]);
    const toasts = gameStore.useGameStore.getState().toasts.map((t) => t.message);
    expect(toasts).toEqual([fallbackModule.LOCAL_PLAYER_MODEL_FALLBACK_NOTICE]);
    await mounted.unmount();
    replies.delete(lobster);
  }, TEST_TIMEOUT_MS);

  test('full cove scene, player VRM 404: the lobster fallback walks on real key presses; the follow camera and the slot-bank E-key proximity update', async () => {
    // The whole CoveInteriorScene (active) mounts, so the REAL key listeners
    // attach (attachCoveKeyListeners on window). Frames are driven with R3F
    // advance() on a frameloop:'never' root: each call runs every useFrame /
    // useSceneFrame subscriber once with an exact delta.
    const playerKey = 'milady_official_5';
    const playerPath = vrmPath(playerKey);
    const lobster = vrmPath('lobster');
    replies.set(playerPath, 404);
    replies.set(lobster, 'cove-lobster-root');
    gameStore.useGameStore.setState({ avatarModelKey: playerKey, toasts: [] });
    coveStore.useCoveStore.setState({ slotScreenOpen: false });
    const mounted = await mountScene(
      // The default export takes an OPTIONAL props object, which createElement's
      // overloads do not accept; the cast names the real props type.
      createElement(cove.default as ComponentType<import('./cove-interior').CoveInteriorSceneProps>, { active: true }),
      (m) => Boolean(m.scene.getObjectByName('cove-lobster-root')),
      'cove scene: lobster fallback body mounted',
    );
    try {
      expectSceneSurvived(mounted);
      expect(lines(mounted.logged, '[3D] figure replaced by fallback').filter((l) => l.includes(`cove-player ${playerPath}`)).length).toBe(1);
      // lobster root -> cloned GLB scene -> the avatar group the frame loop moves.
      const body = mounted.scene.getObjectByName('cove-lobster-root')!.parent!.parent!;
      const camera = mounted.store.getState().camera;
      let clock = 0;
      const frames = async (count: number) => {
        await r3f.act(async () => {
          for (let i = 0; i < count; i += 1) {
            clock += 1 / 60;
            r3f.advance(clock, false, mounted.store.getState());
          }
        });
      };
      const hold = async (key: string, count: number) => {
        testWindow.dispatchEvent(new testWindow.KeyboardEvent('keydown', { key }));
        try {
          await frames(count);
        } finally {
          testWindow.dispatchEvent(new testWindow.KeyboardEvent('keyup', { key }));
        }
      };
      const slotOpen = () => coveStore.useCoveStore.getState().slotScreenOpen;

      await frames(5); // body at spawn, camera behind it
      const spawn = body.position.clone();
      await frames(30);
      expect(body.position.distanceTo(spawn)).toBe(0); // no key: no movement

      // E at spawn: more than 300 wu from the classic slot bank (arm radius 200): nothing.
      expect(Math.hypot(spawn.x + 323, spawn.z + 458)).toBeGreaterThan(300);
      await hold('e', 3);
      expect(slotOpen()).toBe(false);

      // D (camera-relative strafe toward -X), 26 frames at 450 wu/s.
      const cameraAtSpawn = camera.position.clone();
      await hold('d', 26);
      const strafed = body.position.clone();
      expect(spawn.x - strafed.x).toBeGreaterThan(100);
      expect(camera.position.distanceTo(cameraAtSpawn)).toBeGreaterThan(10);

      // Now inside the classic bank's arm radius (centroid -323, -458): E opens the slot screen.
      expect(Math.hypot(strafed.x + 323, strafed.z + 458)).toBeLessThan(200);
      await hold('e', 3);
      expect(slotOpen()).toBe(true);
      coveStore.useCoveStore.setState({ slotScreenOpen: false });

      // W (forward, +Z), 30 frames; the follow camera tracks it.
      const cameraBeforeWalk = camera.position.clone();
      await hold('w', 30);
      const walked = body.position.clone();
      expect(walked.z - strafed.z).toBeGreaterThan(100);
      expect(camera.position.distanceTo(cameraBeforeWalk)).toBeGreaterThan(10);

      await frames(30); // key released: the body stops
      expect(body.position.distanceTo(walked)).toBeLessThan(0.001);
      expectSceneSurvived(mounted);
    } finally {
      coveStore.useCoveStore.setState({ slotScreenOpen: false });
      await mounted.unmount();
      replies.delete(lobster);
    }
  }, TEST_TIMEOUT_MS);

  test('local player VRM 404 AND lobster 404 -> no body, no crash, one line each, the no-body notice', async () => {
    const playerKey = 'milady_official_5';
    const playerPath = vrmPath(playerKey);
    const lobster = vrmPath('lobster');
    replies.set(playerPath, 404);
    replies.set(lobster, 404);
    gameStore.useGameStore.setState({ avatarModelKey: playerKey, toasts: [] });
    const mounted = await mountScene(
      createElement(cove.CovePlayerAvatar),
      (m) => skippedLines(m.logged).length >= 1 && gameStore.useGameStore.getState().toasts.length >= 1,
      'cove: fallback lobster line + notice',
    );
    expectSceneSurvived(mounted);
    expect(mounted.scene.getObjectByName('cove-lobster-root')).toBeUndefined();
    expect(lines(mounted.logged, '[3D] figure replaced by fallback').length).toBe(1);
    const skipped = skippedLines(mounted.logged);
    expect(skipped.length).toBe(1);
    expect(skipped[0]).toContain(`cove-player-fallback ${lobster}`);
    const toasts = gameStore.useGameStore.getState().toasts.map((t) => t.message);
    expect(toasts).toEqual([fallbackModule.LOCAL_PLAYER_MODEL_NO_BODY_NOTICE]);
    await mounted.unmount();
    replies.delete(lobster);
  }, TEST_TIMEOUT_MS);

  test('GLB (lobster) local player whose lobster 404s -> no body, no crash, one line, the no-body notice', async () => {
    const lobster = vrmPath('lobster');
    replies.set(lobster, 404);
    gameStore.useGameStore.setState({ avatarModelKey: 'lobster', toasts: [] });
    const mounted = await mountScene(
      createElement(cove.CovePlayerAvatar),
      (m) => skippedLines(m.logged).length >= 1 && gameStore.useGameStore.getState().toasts.length >= 1,
      'cove: GLB-branch lobster line + notice',
    );
    expectSceneSurvived(mounted);
    const skipped = skippedLines(mounted.logged);
    expect(skipped.length).toBe(1);
    expect(skipped[0]).toContain(`cove-player ${lobster}`);
    const toasts = gameStore.useGameStore.getState().toasts.map((t) => t.message);
    expect(toasts).toEqual([fallbackModule.LOCAL_PLAYER_MODEL_NO_BODY_NOTICE]);
    await mounted.unmount();
    replies.delete(lobster);
  }, TEST_TIMEOUT_MS);

  test('seated bust (TableSeatedBust) VRM 404 -> skipped, siblings render', async () => {
    const path = vrmPath('milady_official_8');
    replies.set(path, 404);
    const reg = (registry.MODEL_REGISTRY as Record<string, unknown>).milady_official_8 as Parameters<typeof cove.TableSeatedBust>[0]['reg'];
    const mounted = await mountScene(
      createElement(
        'group',
        null,
        createElement(cove.TableSeatedBust, {
          reg,
          seat: { x: 0, z: 0, faceYaw: 0 } as Parameters<typeof cove.TableSeatedBust>[0]['seat'],
          seatIndex: 1,
          instanceId: 'cove-t1-seat-1',
          targetHeight: 160,
        }),
        createElement('group', { name: 'bust-sibling' }),
      ),
      (m) => skippedLines(m.logged).length >= 1 && Boolean(m.scene.getObjectByName('bust-sibling')),
      'cove: seated bust line + sibling',
    );
    expectSceneSurvived(mounted);
    expect(mounted.scene.getObjectByName('bust-sibling')).toBeTruthy();
    const skipped = skippedLines(mounted.logged);
    expect(skipped.length).toBe(1);
    expect(skipped[0]).toContain(`cove-seat:1 ${path}`);
    await mounted.unmount();
  }, TEST_TIMEOUT_MS);
});

describe('/cove/baccarat felt view + shared seat mapping (pure)', () => {
  type RoomState = import('../cove/baccarat-room-controller').BaccaratRoomState;
  const settledCoup = { winner: 'banker', tag: 'settled' };
  const restoredCoup = { winner: 'player', tag: 'restored' };
  const dealSteps = [{ side: 'player', handCardIndex: 0, token: 'p0' }] as const;

  function soloState(overrides: Partial<Record<keyof RoomState, unknown>>): RoomState {
    return {
      settled: { outcome: settledCoup },
      restored: { outcome: restoredCoup },
      shoe: { id: 'shoe-1' },
      revealedStep: 3,
      dealSteps,
      phase: 'revealing',
      betType: 'banker',
      stake: 25,
      correlation: { hand: 'shoe-1:4' },
      bannerText: 'BANKER WINS',
      betzoneSelected: 'tie',
      ...overrides,
    } as unknown as RoomState;
  }

  test('soloFeltView maps the solo controller state 1:1', () => {
    const view = baccarat.soloFeltView(soloState({}));
    expect(view).toEqual({
      coup: settledCoup,
      revealedStep: 3,
      dealSteps,
      phase: 'revealing',
      betType: 'banker',
      stake: 25,
      correlation: { hand: 'shoe-1:4' },
      shoeId: 'shoe-1',
      bannerText: 'BANKER WINS',
      betzoneSelected: 'tie',
    } as unknown as FeltView);
    expect(view.dealSteps).toBe(dealSteps);
    expect(Object.keys(view).sort()).toEqual([
      'bannerText', 'betType', 'betzoneSelected', 'correlation', 'coup',
      'dealSteps', 'phase', 'revealedStep', 'shoeId', 'stake',
    ]);
  });

  test('soloFeltView: coup = settled ?? restored ?? null; no shoe -> shoeId null', () => {
    expect(baccarat.soloFeltView(soloState({ settled: null })).coup).toEqual(restoredCoup as never);
    expect(baccarat.soloFeltView(soloState({ settled: null, restored: null })).coup).toBeNull();
    const empty = baccarat.soloFeltView(soloState({
      settled: null, restored: null, shoe: null, correlation: null, bannerText: null, betzoneSelected: null,
    }));
    expect(empty.shoeId).toBeNull();
    expect(empty.correlation).toBeNull();
    expect(empty.bannerText).toBeNull();
    expect(empty.betzoneSelected).toBeNull();
  });

  test('POV seat: own seat when seated; lowest free seat for a spectator; seat 0 at a full table', () => {
    const seats = (indices: number[]) => indices.map((seatIndex) => ({ seatIndex }));
    expect(baccarat.resolveBaccaratPovSeat(seats([0, 1, 4]), 4)).toBe(4);
    expect(baccarat.resolveBaccaratPovSeat(seats([0, 1, 4]), null)).toBe(2);
    expect(baccarat.resolveBaccaratPovSeat(seats([0, 1, 4]), undefined)).toBe(2);
    expect(baccarat.resolveBaccaratPovSeat(seats([]), null)).toBe(0);
    expect(baccarat.resolveBaccaratPovSeat(seats([0, 1, 2, 3, 4, 5]), null)).toBe(0);
    // Out-of-range or non-integer input is treated as a spectator.
    expect(baccarat.resolveBaccaratPovSeat(seats([0]), 7)).toBe(1);
    expect(baccarat.resolveBaccaratPovSeat(seats([0]), 1.5)).toBe(1);
  });

  test('room seats: the 5 drawn slots run clockwise from the POV and never include it', () => {
    for (let pov = 0; pov < baccarat.BACCARAT_SHARED_SEAT_COUNT; pov += 1) {
      const engine = baccarat.baccaratRoomSeats(pov).map((seat) => seat.engineSeatIndex);
      expect(engine.length).toBe(5);
      expect(engine).not.toContain(pov);
      expect(engine).toEqual([1, 2, 3, 4, 5].map((step) => (pov + step) % 6));
    }
  });

  test('seat model: the real wire key when it is a registry key (picker-hidden included), else the stable hash', () => {
    expect(baccarat.baccaratSeatModelKey({ modelKey: 'hermes_female', avatarId: 'a' })).toBe('hermes_female' as never);
    expect(baccarat.baccaratSeatModelKey({ modelKey: 'helen', avatarId: 'a' })).toBe('helen' as never);
    expect(baccarat.baccaratSeatModelKey({ modelKey: 'not_a_registry_key', avatarId: 'avatar-x' }))
      .toBe(figures.stableAvatarModelKey('avatar-x'));
    // A prototype name is not a registry key.
    expect(baccarat.baccaratSeatModelKey({ modelKey: 'constructor', avatarId: 'avatar-x' }))
      .toBe(figures.stableAvatarModelKey('avatar-x'));
  });
});
