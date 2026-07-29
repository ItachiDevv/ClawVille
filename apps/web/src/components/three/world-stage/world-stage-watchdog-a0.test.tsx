import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  resetWorldStageNavigationForTests,
  requestWorldStageNavigation,
} from './stage-navigation';
import { useStageStore } from './stage-store';

const routerCalls: Array<{ method: 'push' | 'replace'; to: string }> = [];
const router = {
  push: (to: string) => routerCalls.push({ method: 'push', to }),
  replace: (to: string) => routerCalls.push({ method: 'replace', to }),
};
let threeState: {
  camera: object;
  gl: {
    compileAsync: () => Promise<void>;
    render: () => void;
  };
  scene: object;
};

mock.module('next/navigation', () => ({
  usePathname: () => '/cove',
  useRouter: () => router,
}));

mock.module('./WorldStageCanvas', () => ({
  WorldStageCanvas: () => null,
  readStageBackend: () => 'unknown',
  readStageCameraPoses: () => ({}),
  readStageRendererCounters: () => ({
    backend: 'unknown',
    textures: null,
    geometries: null,
    texturesSizeBytes: null,
    memoryTotalBytes: null,
    renderCallsLifetime: null,
    drawCallsFrame: null,
    memoryBreakdown: null,
  }),
}));

mock.module('./resource-ledger', () => ({
  readStageSceneInventory: () => ({}),
  withStageSlotFrustumCullingDisabled: (
    _sceneId: string,
    operation: () => unknown,
  ) => operation(),
}));

mock.module('./use-scene-frame', () => ({
  readStageFrameInvocations: () => ({}),
  resetStageFrameDiagnostics: () => {},
  useSceneActive: () => true,
}));

mock.module('@react-three/fiber', () => ({
  useThree: () => threeState,
}));

mock.module('@/lib/three/cove-interior', () => ({
  default: ({
    onReady,
  }: {
    onReady: () => void;
    onSceneEmpty: () => void;
  }) => {
    useEffect(() => {
      onReady();
    }, [onReady]);
    return null;
  },
}));

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root | null = null;
const originalGlobalDescriptors = new Map<
  string,
  PropertyDescriptor | undefined
>();

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost:3000/cove',
  });
  const testGlobals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(testGlobals)) {
    originalGlobalDescriptors.set(
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    );
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
});

afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of originalGlobalDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
  originalGlobalDescriptors.clear();
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(0));
  routerCalls.length = 0;
  resetWorldStageNavigationForTests();
  useStageStore.getState().resetStage();
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  jest.useRealTimers();
  resetWorldStageNavigationForTests();
});

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(0);
  });
}

describe('Fix A0 production-timing reproductions', () => {
  test('a parked ADOPT cannot survive the real 250ms opaque midpoint to the 45s watchdog', async () => {
    const { WorldStageRoot } = await import('./WorldStageRoot');
    await act(async () => {
      root!.render(
        createElement(
          WorldStageRoot,
          null,
          createElement('div', null, 'cove page'),
        ),
      );
    });
    await flushEffects();
    expect(useStageStore.getState().transition?.phase).toBe('fadingOut');

    let midwayCount = 0;
    expect(
      requestWorldStageNavigation({
        to: '/cove',
        onMidway: () => {
          midwayCount += 1;
        },
      }),
    ).toBe(true);

    // The opaque midpoint is the 250ms fade default. The jsdom/fake-timer
    // boundary is loose by ~1ms at exactly 249→250, so assert around the
    // midpoint (well before / well after) rather than at the exact edge —
    // the claim under test is "commits at the midpoint, not at 45s+".
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(midwayCount).toBe(0);
    expect(routerCalls).toHaveLength(0);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(midwayCount).toBe(1);
    expect(routerCalls).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(75_000);
    });
    expect(midwayCount).toBe(1);
    expect(routerCalls).toHaveLength(1);
  });

  test('a never-settling compile under the v3 interval model is bounded by retry then card', () => {
    const wedgedCompileAsync = new Promise<void>(() => {});
    expect(wedgedCompileAsync).toBeInstanceOf(Promise);
    let attemptElapsedMs = 0;
    let retryCount = 0;
    let totalElapsedMs = 0;
    let lastNoiseAtMs = 0;
    const verdicts: string[] = [];

    while (totalElapsedMs < 240_000) {
      totalElapsedMs += 5_000;
      attemptElapsedMs += 5_000;
      lastNoiseAtMs = attemptElapsedMs;
      const softStalled =
        attemptElapsedMs >= 45_000 &&
        attemptElapsedMs - lastNoiseAtMs >= 30_000;
      const hardCeilingReached = attemptElapsedMs >= 90_000;
      if (!softStalled && !hardCeilingReached) continue;

      if (retryCount === 0) {
        verdicts.push('silent-retry');
        retryCount += 1;
        attemptElapsedMs = 0;
        lastNoiseAtMs = 0;
        continue;
      }
      verdicts.push('fail-card');
      break;
    }

    expect(verdicts).toEqual(['silent-retry', 'fail-card']);
    expect(totalElapsedMs).toBe(180_000);
  });
});

describe('Fix C component renderer replacement', () => {
  test('StageHostedCoveScene warms an in-place replacement renderer exactly once', async () => {
    const firstCalls = { compile: 0, render: 0 };
    const replacementCalls = { compile: 0, render: 0 };
    const firstRenderer = {
      compileAsync: async () => {
        firstCalls.compile += 1;
      },
      render: () => {
        firstCalls.render += 1;
      },
    };
    const replacementRenderer = {
      compileAsync: async () => {
        replacementCalls.compile += 1;
      },
      render: () => {
        replacementCalls.render += 1;
      },
    };
    threeState = {
      camera: {},
      gl: firstRenderer,
      scene: {},
    };
    useStageStore.getState().registerScenes(['cove']);
    useStageStore.getState().requestScene('cove');
    const request = useStageStore.getState().pendingRequest!;
    useStageStore
      .getState()
      .ackCameraInstalled('cove', request.generation);
    const { default: StageHostedCoveScene } = await import(
      './StageHostedCoveScene'
    );

    await act(async () => {
      root!.render(
        createElement(StageHostedCoveScene, {
          onSceneEmpty: () => {},
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushEffects();
    expect(firstCalls).toEqual({ compile: 1, render: 1 });

    threeState = { ...threeState, gl: replacementRenderer };
    await act(async () => {
      root!.render(
        createElement(StageHostedCoveScene, {
          onSceneEmpty: () => {},
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushEffects();
    expect(replacementCalls).toEqual({ compile: 1, render: 1 });

    await act(async () => {
      root!.render(
        createElement(StageHostedCoveScene, {
          onSceneEmpty: () => {},
        }),
      );
      await Promise.resolve();
    });
    expect(firstCalls).toEqual({ compile: 1, render: 1 });
    expect(replacementCalls).toEqual({ compile: 1, render: 1 });
  });
});
