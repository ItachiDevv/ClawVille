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
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Component, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import * as THREE from 'three';

const testWindow = new Window({
  // seatModels (dev/localhost only) puts the rigless lobster GLB at hold'em
  // seat index 1 so one sibling figure loads while the VRM figures fail.
  url: 'http://localhost/cove/table?seatModels=milady_official_2,lobster,hermes_female,milady_official_7,milady_official_4',
});
const globalNames = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'Event', 'ErrorEvent', 'ProgressEvent', 'requestAnimationFrame', 'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
const originalReportError = globalThis.reportError;
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
let fallbackModule: typeof import('./local-player-model-fallback');
let gameStore: typeof import('../../stores/game');
let registry: typeof import('./agent-model-registry');
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
  cove = await import('./cove-interior');
  baccarat = await import('./baccarat-table-room');
  blackjack = await import('./blackjack-table-room');
  holdem = await import('./holdem-table-room');
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  globalThis.reportError = originalReportError;
  for (const instance of [THREE, threeCjs]) instance.DefaultLoadingManager.setURLModifier(undefined);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  await testWindow.happyDOM.close();
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

async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await r3f.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

interface Mounted {
  scene: THREE.Scene;
  outer: unknown[];
  logged: unknown[][];
  unmount: () => Promise<void>;
}

/** Render `element` in a real R3F root; wait until loads settle. */
async function mountScene(element: ReactNode): Promise<Mounted> {
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
  let store: ReturnType<typeof root.render> | undefined;
  try {
    await r3f.act(async () => {
      store = root.render(createElement(OuterBoundary, { onCatch: (e) => outer.push(e) }, element));
    });
    await settle();
  } finally {
    cap.restore();
  }
  return {
    scene: store!.getState().scene,
    outer,
    logged: cap.logged,
    unmount: async () => {
      const capUnmount = captureConsoleError();
      try {
        await r3f.act(async () => root.unmount());
        await settle(3);
      } finally {
        capUnmount.restore();
      }
    },
  };
}

const lines = (logged: unknown[][], prefix: string) =>
  logged.filter((args) => String(args[0]).startsWith(prefix)).map((args) => String(args[0]));
const skippedLines = (logged: unknown[][]) => lines(logged, '[3D] figure skipped');

function vrmPath(key: string): string {
  return (registry.MODEL_REGISTRY as Record<string, { path: string }>)[key]!.path;
}

function expectSceneSurvived(mounted: Mounted): void {
  expect(mounted.outer.map((e) => String((e as Error)?.message ?? e))).toEqual([]);
  expect(reported.every((event) => event.defaultPrevented)).toBe(true);
}

describe('cove table rooms: a failed figure model removes only that figure', () => {
  test('/cove/baccarat: dealer VRM 404 -> room, table, bet zones and plate render; no dealer; one line', async () => {
    const dealer = vrmPath('milady_official_6');
    replies.set(dealer, 404);
    const view = {
      settled: null,
      restored: null,
      betzoneSelected: null,
      betType: 'player',
      revealedStep: 0,
      dealSteps: [],
      phase: 'idle',
      stake: 10,
      correlation: null,
      shoe: null,
      bannerText: null,
    } as unknown as Parameters<typeof baccarat.BaccaratTableRoomScene>[0]['view'];
    const mounted = await mountScene(
      createElement(baccarat.BaccaratTableRoomScene, { instanceId: 'bac-test', view }),
    );
    expectSceneSurvived(mounted);
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-room-only.glb'))).toBeTruthy();
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-table-clean.glb'))).toBeTruthy();
    expect(mounted.scene.getObjectByName('baccarat-bet-zones-merged')).toBeTruthy();
    expect(mounted.scene.getObjectByName('baccarat-room-dealer')).toBeUndefined();
    const skipped = skippedLines(mounted.logged);
    expect(skipped.length).toBe(1);
    expect(skipped[0]).toContain(`baccarat-dealer ${dealer}`);
    await mounted.unmount();
  });

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
    );
    expectSceneSurvived(mounted);
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-room-only.glb'))).toBeTruthy();
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-table-clean.glb'))).toBeTruthy();
    expect(mounted.scene.getObjectByName('blackjack-room-dealer')).toBeUndefined();
    const skipped = skippedLines(mounted.logged);
    expect(skipped.length).toBe(1);
    expect(skipped[0]).toContain(`blackjack-dealer ${dealer}`);
    await mounted.unmount();
  });

  test('/cove/table (hold\'em): every VRM figure 404 -> room, table, all 5 chairs and the rigless lobster seat render; one line per figure URL', async () => {
    const vrmKeys = ['milady_official_2', 'hermes_female', 'milady_official_7', 'milady_official_4', 'milady_official_6'];
    for (const key of vrmKeys) replies.set(vrmPath(key), 404);
    const lobster = vrmPath('lobster');
    const mounted = await mountScene(createElement(holdem.HoldemTableRoomScene, { instanceId: 'holdem-test' }));
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
    const skipped = skippedLines(mounted.logged);
    expect(skipped.length).toBe(vrmKeys.length);
    for (const key of vrmKeys) {
      expect(skipped.filter((line) => line.includes(vrmPath(key))).length).toBe(1);
    }
    await mounted.unmount();
  });

  test('/cove/table (hold\'em): a rigless GLB seat that fails is skipped the same way', async () => {
    const lobster = vrmPath('lobster');
    replies.set(lobster, 404);
    const mounted = await mountScene(createElement(holdem.HoldemTableRoomScene, { instanceId: 'holdem-test-2' }));
    expectSceneSurvived(mounted);
    expect(mounted.scene.getObjectByName('holdem-avatar-lobster')).toBeUndefined();
    expect(mounted.scene.getObjectByName(nodeName('/models/cove-table-clean.glb'))).toBeTruthy();
    expect(skippedLines(mounted.logged).filter((line) => line.includes(lobster)).length).toBe(1);
    replies.delete(lobster);
    await mounted.unmount();
  });
});

describe('cove interior: local player + seated bust', () => {
  test('local player VRM 404 -> the cove lobster body renders instead; one "replaced by fallback" line; one notice', async () => {
    const playerKey = 'milady_official_5';
    const playerPath = vrmPath(playerKey);
    const lobster = vrmPath('lobster');
    replies.set(playerPath, 404);
    replies.set(lobster, 'cove-lobster-root');
    gameStore.useGameStore.setState({ avatarModelKey: playerKey, toasts: [] });
    const mounted = await mountScene(createElement(cove.CovePlayerAvatar));
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
  });

  test('local player VRM 404 AND lobster 404 -> no body, no crash, one line each, the no-body notice', async () => {
    const playerKey = 'milady_official_5';
    const playerPath = vrmPath(playerKey);
    const lobster = vrmPath('lobster');
    replies.set(playerPath, 404);
    replies.set(lobster, 404);
    gameStore.useGameStore.setState({ avatarModelKey: playerKey, toasts: [] });
    const mounted = await mountScene(createElement(cove.CovePlayerAvatar));
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
  });

  test('GLB (lobster) local player whose lobster 404s -> no body, no crash, one line, the no-body notice', async () => {
    const lobster = vrmPath('lobster');
    replies.set(lobster, 404);
    gameStore.useGameStore.setState({ avatarModelKey: 'lobster', toasts: [] });
    const mounted = await mountScene(createElement(cove.CovePlayerAvatar));
    expectSceneSurvived(mounted);
    const skipped = skippedLines(mounted.logged);
    expect(skipped.length).toBe(1);
    expect(skipped[0]).toContain(`cove-player ${lobster}`);
    const toasts = gameStore.useGameStore.getState().toasts.map((t) => t.message);
    expect(toasts).toEqual([fallbackModule.LOCAL_PLAYER_MODEL_NO_BODY_NOTICE]);
    await mounted.unmount();
    replies.delete(lobster);
  });

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
    );
    expectSceneSurvived(mounted);
    expect(mounted.scene.getObjectByName('bust-sibling')).toBeTruthy();
    const skipped = skippedLines(mounted.logged);
    expect(skipped.length).toBe(1);
    expect(skipped[0]).toContain(`cove-seat:1 ${path}`);
    await mounted.unmount();
  });
});
