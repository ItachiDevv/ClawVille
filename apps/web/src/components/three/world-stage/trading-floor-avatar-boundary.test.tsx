import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act, Component, createElement, type ComponentClass, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// Extract the boundary without importing the renderer into Bun's shared test process.
const source = readFileSync(new URL('../../../lib/three/trading-floor/trading-floor-interior.tsx', import.meta.url), 'utf8');
const file = ts.createSourceFile('interior.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = file.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'TradingFloorAvatarErrorBoundary',
);
if (!declaration) throw new Error('Trading Floor avatar boundary is missing');
const boundaryJs = ts.transpileModule(declaration.getText(file), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const AvatarBoundary = new Function(
  'Component',
  `${boundaryJs}\nreturn TradingFloorAvatarErrorBoundary;`,
)(Component) as ComponentClass<{ children: ReactNode }>;

test('avatar boundary contains a throwing child and renders null', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = Object.fromEntries(
    Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const originalWarn = console.warn;
  const originalError = console.error;
  const warnings: unknown[][] = [];
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    console.error = () => {}; // React reports caught child errors too.
    const container = dom.window.document.createElement('div');
    dom.window.document.body.append(container);
    root = createRoot(container);
    const error = new Error('avatar fetch failed');
    const Crash = (): never => { throw error; };
    await act(async () => {
      root!.render(createElement(AvatarBoundary, null, createElement(Crash)));
    });
    expect(container.innerHTML).toBe('');
    expect(warnings).toEqual([[
      '[TradingFloor] avatar failed to load; continuing without it',
      error,
    ]]);
  } finally {
    try {
      const mountedRoot = root;
      if (mountedRoot) await act(async () => mountedRoot.unmount());
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
      for (const [name, descriptor] of Object.entries(originals)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    }
  }
});

test('TradingFloorPlayer sits inside the avatar boundary and Suspense', () => {
  expect(source).toMatch(
    /<Suspense fallback=\{null\}>\s*<TradingFloorAvatarErrorBoundary>\s*<TradingFloorPlayer\b/,
  );
});
