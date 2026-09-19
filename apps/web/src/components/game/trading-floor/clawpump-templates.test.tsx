import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

import { CLAWPUMP_DASHBOARD_URL, TRADING_AGENT_TEMPLATES } from '@clawville/shared';

// Same DOM harness as floor-components.test.tsx: bun has no global DOM, so the
// happy-dom window is installed and torn down around the render.
const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'Node',
  'Element',
  'HTMLElement',
  'HTMLAnchorElement',
  'Event',
  'MouseEvent',
  'MutationObserver',
] as const;
const installedNames = [
  'window',
  'document',
  'navigator',
  'IS_REACT_ACT_ENVIRONMENT',
  ...globalNames,
] as const;

let createRoot: typeof import('react-dom/client').createRoot;
let ClawPumpTemplatesSection: typeof import('./clawpump-templates').ClawPumpTemplatesSection;
let root: Root | null = null;
let container: HTMLElement | null = null;
let previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();

function rememberDom(): void {
  previousDescriptors = new Map(
    installedNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
}

function restoreDom(): void {
  for (const [name, descriptor] of previousDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}

function installDom(): void {
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

async function renderSection(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(ClawPumpTemplatesSection));
  });
  return container;
}

beforeAll(async () => {
  rememberDom();
  installDom();
  ({ createRoot } = await import('react-dom/client'));
  ({ ClawPumpTemplatesSection } = await import('./clawpump-templates'));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

afterAll(() => {
  restoreDom();
  testWindow.close();
});

describe('ClawPump templates section', () => {
  test('renders one card per template with both copy buttons', async () => {
    const host = await renderSection();
    for (const template of TRADING_AGENT_TEMPLATES) {
      expect(host.textContent).toContain(template.displayName);
    }
    const buttons = [...host.querySelectorAll('button')].map((node) => node.textContent);
    expect(buttons.filter((label) => label === 'Copy persona')).toHaveLength(5);
    expect(buttons.filter((label) => label === 'Copy skills')).toHaveLength(5);
  });

  test('gives every tap target at least 44 pixels', async () => {
    const host = await renderSection();
    const targets = [...host.querySelectorAll('button'), ...host.querySelectorAll('a')];
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect((target as HTMLElement).style.minHeight).toBe('44px');
    }
  });

  test('opens the ClawPump dashboard safely in a new tab', async () => {
    const host = await renderSection();
    const link = [...host.querySelectorAll('a')].find(
      (node) => node.getAttribute('href') === CLAWPUMP_DASHBOARD_URL,
    );
    expect(link).toBeDefined();
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('tells the truth about registering a ClawPump wallet and offers no dead button', async () => {
    const host = await renderSection();
    const text = host.textContent ?? '';
    expect(text).toContain('ownership proof that ClawVille does not offer yet');
    // Not merely unranked: no verified_trades row is written, so the trade is
    // absent from the public tape and from GET /api/exchange/trades/mine too.
    expect(text).toContain('cannot verify, show, or rank its trades');
    // The report route refuses an unbound signer (`wallet_not_bound`, 409), so
    // the section must NOT tell anyone to paste a signature instead.
    expect(text).not.toContain('Report a signature');
    const labels = [...host.querySelectorAll('button')].map((node) => node.textContent);
    expect(labels).not.toContain('Register wallet');
    const anchor = [...host.querySelectorAll('a')].find(
      (node) => node.getAttribute('href') === '#trading-floor-wallets',
    );
    expect(anchor).toBeDefined();
  });

  test('lists the six ClawPump steps and names the persona field', async () => {
    const host = await renderSection();
    expect(host.querySelectorAll('ol li')).toHaveLength(6);
    const text = host.textContent ?? '';
    expect(text).toContain('persona field, not the system prompt');
    expect(text).toContain('Buy AI credits');
  });

  test('marks the model as a suggestion and carries the free-tier caveat', async () => {
    const host = await renderSection();
    const text = host.textContent ?? '';
    // ClawPump's free tier answers on its own model regardless of the one the
    // user sets, so naming the model without this caveat is a false claim.
    expect(text).toContain('Suggested model');
    expect(text).toContain('free-tier model until you buy AI credits');
  });

  test('reveals the text when the clipboard is unavailable', async () => {
    // A denied permission, an insecure origin and an in-app webview all reject
    // here. The text still has to reach the user, so the card must fall back to
    // selectable text rather than silently doing nothing.
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('clipboard blocked')) },
    });
    const host = await renderSection();
    expect(host.querySelectorAll('textarea')).toHaveLength(0);
    const copyPersona = [...host.querySelectorAll('button')].find(
      (node) => node.textContent === 'Copy persona',
    );
    expect(copyPersona).toBeDefined();
    await act(async () => {
      copyPersona?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The handler is fire-and-forget, so its state update lands a microtask
    // after the dispatch; this second pass flushes it.
    await act(async () => {});
    const revealed = host.querySelectorAll('textarea');
    expect(revealed).toHaveLength(1);
    expect((revealed[0] as HTMLTextAreaElement).readOnly).toBe(true);
    expect((revealed[0] as HTMLTextAreaElement).value).toBe(
      TRADING_AGENT_TEMPLATES[0]!.personaText,
    );
  });
});
