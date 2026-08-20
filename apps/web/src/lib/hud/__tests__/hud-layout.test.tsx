/**
 * D1 regression — the cove touch band must never outrank the seated poker
 * HUD again. See `../hud-layout.ts` and `apps/web/src/components/cove/CoveMobileControls.tsx`.
 *
 * Harness mirrors `apps/web/src/lib/cove/__tests__/modal-dom-honesty.test.tsx`
 * (happy-dom + a manually installed globalThis, since these components use
 * browser globals bun's default test environment doesn't provide).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { readFileSync } from 'node:fs';
import { act, createElement, type ComponentType } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { HUD_Z } from '../hud-layout';

const testWindow = new Window({ url: 'http://localhost/cove' });
const installedGlobals = [
  'Node',
  'Element',
  'HTMLElement',
  'HTMLDivElement',
  'HTMLButtonElement',
  'SVGElement',
  'Event',
  'MouseEvent',
  'TouchEvent',
  'KeyboardEvent',
  'MutationObserver',
  // CoveMobileControls transitively imports `@/lib/three/cove-interior`,
  // which fires a module-scope GLB/clip preload fetch on import. Bun's
  // runtime has no browser ProgressEvent global, so the loader's progress
  // callback throws a bare ReferenceError instead of a normal (harmless,
  // network-failure) load error — install happy-dom's so it degrades
  // quietly instead of crashing an unrelated later test.
  'ProgressEvent',
] as const;

let createRoot: typeof import('react-dom/client').createRoot;
let useCoveStore: typeof import('@/stores/cove').useCoveStore;
let CoveMobileControls: ComponentType;
let mountedRoot: Root | null = null;
let mountedContainer: HTMLElement | null = null;

function installDom(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: testWindow,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: testWindow.document,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: testWindow.navigator,
  });
  for (const name of installedGlobals) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: testWindow[name as keyof typeof testWindow],
    });
  }
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: testWindow.getComputedStyle.bind(testWindow),
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: testWindow.requestAnimationFrame.bind(testWindow),
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: testWindow.cancelAnimationFrame.bind(testWindow),
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  // useIsMobile() checks `window.matchMedia('(pointer: coarse)').matches`
  // first. happy-dom has no real "pointer" media feature to evaluate, so
  // stub matchMedia to force the mobile branch for these tests.
  Object.defineProperty(testWindow, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
  });
}

async function flushWork(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountCoveMobileControls(): Promise<HTMLElement> {
  mountedContainer = document.createElement('div');
  document.body.append(mountedContainer);
  mountedRoot = createRoot(mountedContainer);
  await act(async () => {
    mountedRoot?.render(createElement(CoveMobileControls));
    await Promise.resolve();
  });
  await flushWork();
  return mountedContainer;
}

beforeAll(async () => {
  installDom();
  process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4000';
  ({ createRoot } = await import('react-dom/client'));
  ({ useCoveStore } = await import('@/stores/cove'));
  CoveMobileControls = (await import('@/components/cove/CoveMobileControls')).default;
});

afterEach(async () => {
  if (mountedRoot) {
    await act(async () => mountedRoot?.unmount());
  }
  mountedContainer?.remove();
  mountedRoot = null;
  mountedContainer = null;
  useCoveStore.getState().resetCoveStore();
});

afterAll(() => {
  testWindow.close();
});

describe('HUD_Z ladder — D1 (cove touch band vs seated poker HUD)', () => {
  test('seatedGameHud outranks touchInput in the shared ladder', () => {
    expect(HUD_Z.seatedGameHud).toBeGreaterThan(HUD_Z.touchInput);
  });

  test("SeatedHoldemHud.module.css's .hud z-index stays in sync with HUD_Z.seatedGameHud", () => {
    // SeatedHoldemHud.module.css is a CSS Module — it cannot import the
    // HUD_Z TS constant, so its literal is kept in numeric sync by hand.
    // Parse the real stylesheet text (not the module's export, which under
    // bun's default CSS loader is just the resolved file path, not class
    // rules) so a future edit to either file that breaks the correspondence
    // fails this test instead of silently reintroducing D1.
    const cssPath = new URL(
      '../../../components/cove/holdem/SeatedHoldemHud.module.css',
      import.meta.url,
    );
    const css = readFileSync(cssPath, 'utf8');
    const hudBlock = css.match(/(?:^|\n)\.hud\s*\{[^}]*\}/);
    expect(hudBlock).not.toBeNull();
    const zIndexMatch = hudBlock?.[0].match(/z-index:\s*(\d+)/);
    expect(zIndexMatch).not.toBeNull();
    expect(Number(zIndexMatch?.[1])).toBe(HUD_Z.seatedGameHud);
  });

  test('CoveMobileControls renders no movement zone while a cove game surface is active', async () => {
    useCoveStore.setState({ seatedTable: { tableId: 'T1', seatIndex: 0 } });
    const container = await mountCoveMobileControls();
    expect(container.querySelector('[data-testid="cove-touch-zone-left"]')).toBeNull();
    // Camera zone is unaffected — only movement is suppressed while seated.
    expect(container.querySelector('[data-testid="cove-touch-zone-right"]')).not.toBeNull();
  });

  test('CoveMobileControls renders the movement zone when no cove game surface is active', async () => {
    useCoveStore.setState({ seatedTable: null });
    const container = await mountCoveMobileControls();
    expect(container.querySelector('[data-testid="cove-touch-zone-left"]')).not.toBeNull();
  });

  test('CoveMobileControls suppresses the movement zone for each cove modal flag', async () => {
    useCoveStore.setState({ slotScreenOpen: true });
    const container = await mountCoveMobileControls();
    expect(container.querySelector('[data-testid="cove-touch-zone-left"]')).toBeNull();
  });
});
