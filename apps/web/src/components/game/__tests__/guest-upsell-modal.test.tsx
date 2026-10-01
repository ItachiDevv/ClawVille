import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';

import {
  GUEST_UPSELL_PANEL_MAX_HEIGHT,
  GUEST_UPSELL_TOUCH_TARGET_PX,
  guestUpsellSizing,
} from '../guest-upsell-modal';

// Same DOM harness as the trading-floor tests: bun has no global DOM. The
// real `useRouter` reads the App Router context, so the test provides one
// instead of mocking `next/navigation` (a process-global module mock would
// leak into sibling files).
const testWindow = new Window({ url: 'http://localhost/trading-floor' });
const globalNames = ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver'] as const;
const installedNames = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT', ...globalNames] as const;
let createRoot: typeof import('react-dom/client').createRoot;
let GuestUpsellModal: typeof import('../guest-upsell-modal').GuestUpsellModal;
let root: Root | null = null;
let container: HTMLElement | null = null;
let previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();

const fakeRouter = {
  push: () => undefined,
  replace: () => undefined,
  refresh: () => undefined,
  back: () => undefined,
  forward: () => undefined,
  prefetch: () => undefined,
};

function installDom(): void {
  previousDescriptors = new Map(installedNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: testWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: testWindow.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: testWindow.navigator });
  for (const name of globalNames) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: testWindow[name as keyof typeof testWindow],
    });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
}

function restoreDom(): void {
  for (const [name, descriptor] of previousDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}

/** `useIsMobile` treats a viewport under 768 px wide as touch. */
function setViewportWidth(width: number): void {
  Object.defineProperty(testWindow, 'innerWidth', { configurable: true, value: width });
}

async function renderModal(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        AppRouterContext.Provider,
        { value: fakeRouter as never },
        createElement(GuestUpsellModal, {
          open: true,
          onClose: () => undefined,
          headline: 'Sign in to launch a paper trader',
          body: 'A body long enough to need the scroll area on a short landscape phone.',
        }),
      ),
    );
  });
  return container;
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

beforeAll(async () => {
  installDom();
  ({ createRoot } = await import('react-dom/client'));
  ({ GuestUpsellModal } = await import('../guest-upsell-modal'));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setViewportWidth(1024);
});

afterAll(() => {
  restoreDom();
  testWindow.close();
});

describe('Guest upsell modal: sizes by input type', () => {
  test('touch gets 44 px for the close button and every action; desktop keeps its old sizes', () => {
    expect(GUEST_UPSELL_TOUCH_TARGET_PX).toBe(44);
    expect(guestUpsellSizing(true)).toEqual({ closePx: 44, actionStyle: { minHeight: 44 } });
    expect(guestUpsellSizing(false)).toEqual({ closePx: 28, actionStyle: undefined });
  });

  test('on a touch-sized viewport the rendered close button and all three actions are 44 px', async () => {
    setViewportWidth(390);
    const host = await renderModal();
    const close = host.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    expect(close.style.width).toBe('44px');
    expect(close.style.height).toBe('44px');
    for (const label of ['Create free account', 'I already have an account', 'Keep looking around']) {
      expect({ label, minHeight: buttonByText(host, label).style.minHeight }).toEqual({ label, minHeight: '44px' });
    }
  });

  test('on desktop the close button stays 28 px and the actions carry no touch minimum', async () => {
    setViewportWidth(1280);
    const host = await renderModal();
    const close = host.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    expect(close.style.width).toBe('28px');
    expect(close.style.height).toBe('28px');
    expect(buttonByText(host, 'Keep looking around').style.minHeight).toBe('');
  });
});

describe('Guest upsell modal: fits a short viewport', () => {
  test('the panel is bounded by the viewport, the body scrolls, and the close button and actions stay outside the scroll area', async () => {
    const host = await renderModal();
    const panel = host.querySelector('[data-testid="guest-upsell-panel"]') as HTMLElement;
    const scroll = host.querySelector('[data-testid="guest-upsell-scroll"]') as HTMLElement;
    const actions = host.querySelector('[data-testid="guest-upsell-actions"]') as HTMLElement;
    const close = host.querySelector('button[aria-label="Close"]') as HTMLButtonElement;

    // The height bound: 100dvh minus the backdrop's 16 px margins, with the
    // 100vh class as the fallback where dvh is not supported.
    expect(GUEST_UPSELL_PANEL_MAX_HEIGHT).toBe('calc(100dvh - 32px)');
    expect(panel.className).toContain('max-h-[calc(100vh-2rem)]');
    expect(panel.className).toContain('flex-col');
    expect(panel.className).toContain('overflow-hidden');

    expect(scroll.className).toContain('overflow-y-auto');
    expect(scroll.className).toContain('min-h-0');
    expect(scroll.textContent).toContain('Sign in to launch a paper trader');

    expect(actions.className).toContain('shrink-0');
    expect(scroll.contains(close)).toBe(false);
    expect(close.parentElement).toBe(panel);
    for (const label of ['Create free account', 'I already have an account', 'Keep looking around']) {
      expect({ label, inActions: actions.contains(buttonByText(host, label)) }).toEqual({ label, inActions: true });
    }
  });

  test('the touch gate is useIsMobile, never a width media query', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'guest-upsell-modal.tsx'), 'utf8');
    expect(source).toContain('const touch = useIsMobile();');
    expect(source).not.toMatch(/\b(sm|md|lg|xl):/);
    expect(source).not.toContain('max-width');
    expect(source).not.toContain('matchMedia');
  });
});
