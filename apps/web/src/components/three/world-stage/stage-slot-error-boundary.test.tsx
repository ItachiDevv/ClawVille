import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { JSDOM } from 'jsdom';
import {
  act,
  createElement,
  useEffect,
  useState,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StageSlotErrorBoundary } from './StageSlotErrorBoundary';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root | null = null;
let consoleErrors: unknown[][] = [];
let originalConsoleError: typeof console.error;
const originalGlobalDescriptors = new Map<
  string,
  PropertyDescriptor | undefined
>();

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
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
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  consoleErrors = [];
  originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  console.error = originalConsoleError;
});

function CrashChild({
  crash,
  onMount,
}: {
  crash: boolean;
  onMount?: () => void;
}) {
  useEffect(() => {
    onMount?.();
  }, [onMount]);
  if (crash) throw new Error('slot-crash');
  return createElement('span', { 'data-child': 'healthy' }, 'healthy');
}

function boundary(
  resetKey: string,
  crash: boolean,
  onRuntimeError: (error: unknown, componentStack: string | null) => void = () => {},
  onMount?: () => void,
) {
  return createElement(
    StageSlotErrorBoundary,
    {
      resetKey,
      onRuntimeError,
      children: createElement(CrashChild, { crash, onMount }),
    },
  );
}

describe('StageSlotErrorBoundary', () => {
  test('healthy child keeps mount identity across generation resetKey changes', async () => {
    let mounts = 0;
    const onMount = () => {
      mounts += 1;
    };
    for (const resetKey of ['1:0', '2:0', '3:0', '4:0']) {
      await act(async () => {
        root!.render(boundary(resetKey, false, () => {}, onMount));
      });
    }
    expect(mounts).toBe(1);
    expect(container.querySelector('[data-child="healthy"]')).not.toBeNull();
  });

  test('runtime crash raises the DOM callback, logs stack, and renders no false chunk surface', async () => {
    const reports: Array<{
      error: unknown;
      componentStack: string | null;
    }> = [];
    await act(async () => {
      root!.render(
        boundary('1:0', true, (error, componentStack) => {
          reports.push({ error, componentStack });
        }),
      );
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.componentStack).toContain('CrashChild');
    expect(consoleErrors.some((entry) =>
      entry[0] === '[WorldStage] slot subtree crashed:'
    )).toBe(true);
    expect(container.innerHTML).toBe('');
    expect(container.textContent).not.toContain('Reload');
  });

  test('generation resetKey clears a failed boundary and remounts children', async () => {
    let mounts = 0;
    await act(async () => {
      root!.render(boundary('1:0', true));
    });
    await act(async () => {
      root!.render(boundary('2:0', false, () => {}, () => {
        mounts += 1;
      }));
    });
    expect(mounts).toBe(1);
    expect(container.textContent).toBe('healthy');
  });

  test('recovery-count-only resetKey clears a failed boundary', async () => {
    await act(async () => {
      root!.render(boundary('7:0', true));
    });
    await act(async () => {
      root!.render(boundary('7:1', false));
    });
    expect(container.textContent).toBe('healthy');
  });

  test('outer runtime flag clears on the same resetKey change', async () => {
    function RuntimeFlagHarness({
      resetKey,
      crash,
    }: {
      resetKey: string;
      crash: boolean;
    }) {
      const [failedAt, setFailedAt] = useState<string | null>(null);
      return createElement(
        'div',
        null,
        createElement(
          StageSlotErrorBoundary,
          {
            resetKey,
            onRuntimeError: () => setFailedAt(resetKey),
            children: createElement(CrashChild, { crash }),
          },
        ),
        failedAt === resetKey
          ? createElement('div', { role: 'alert' }, 'runtime failed')
          : null,
      );
    }

    await act(async () => {
      root!.render(createElement(RuntimeFlagHarness, {
        resetKey: '4:0',
        crash: true,
      }));
    });
    expect(container.textContent).toContain('runtime failed');
    await act(async () => {
      root!.render(createElement(RuntimeFlagHarness, {
        resetKey: '4:1',
        crash: false,
      }));
    });
    expect(container.textContent).toBe('healthy');
  });
});
