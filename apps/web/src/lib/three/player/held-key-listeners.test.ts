import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { JSDOM } from 'jsdom';
import {
  addStageWindowListener,
  useStageStore,
} from '@/components/three/world-stage/stage-store';
import {
  attachHeldKeyListeners,
  attachPlayerKeyListeners,
  playerKeyState,
  resetPlayerKeys,
} from './player-input';
import { WORLD_VRM_POLICY } from './player-motion-policy';

let dom: JSDOM;
const originalDescriptors = new Map<
  string,
  PropertyDescriptor | undefined
>();
const detachments: Array<() => void> = [];

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
  })) {
    originalDescriptors.set(
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

afterEach(() => {
  while (detachments.length > 0) detachments.pop()?.();
  resetPlayerKeys();
  dom.window.document.body.replaceChildren();
});

afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function attach(
  overrides: Partial<Parameters<typeof attachHeldKeyListeners>[0]> = {},
) {
  const down: string[] = [];
  const up: string[] = [];
  const detach = attachHeldKeyListeners({
    keyIdentity: 'code',
    keyTargetGuard: 'none',
    onKeyDown: (identity) => {
      down.push(identity);
      return false;
    },
    onKeyUp: (identity) => {
      up.push(identity);
    },
    onReset: () => {},
    ...overrides,
  });
  detachments.push(detach);
  return { down, up };
}

function keyboard(
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit,
) {
  return new dom.window.KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

describe('attachHeldKeyListeners', () => {
  test("keyIdentity:'code' uses event.code", () => {
    const seen = attach();
    window.dispatchEvent(
      keyboard('keydown', { code: 'KeyW', key: 'w' }),
    );
    expect(seen.down).toEqual(['KeyW']);
  });

  test("keyIdentity:'key' uses lower-cased event.key", () => {
    const seen = attach({ keyIdentity: 'key' });
    window.dispatchEvent(
      keyboard('keydown', { code: 'KeyW', key: 'W' }),
    );
    expect(seen.down).toEqual(['w']);
  });

  test("keyTargetGuard:'isEditable' skips editable keydown targets", () => {
    const seen = attach({ keyTargetGuard: 'isEditable' });
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    document.body.append(input, textarea, editable);
    input.dispatchEvent(keyboard('keydown', { code: 'KeyW' }));
    textarea.dispatchEvent(keyboard('keydown', { code: 'KeyA' }));
    editable.dispatchEvent(keyboard('keydown', { code: 'KeyS' }));
    expect(seen.down).toEqual([]);
  });

  test("keyTargetGuard:'none' accepts editable keydown targets", () => {
    const seen = attach({ keyTargetGuard: 'none' });
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(keyboard('keydown', { code: 'KeyW' }));
    expect(seen.down).toEqual(['KeyW']);
  });

  test('avatar-style keyup is never target-guarded', () => {
    const seen = attach({
      keyIdentity: 'key',
      keyTargetGuard: 'isEditable',
    });
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(keyboard('keyup', { key: 'W' }));
    expect(seen.up).toEqual(['w']);
  });

  test('activity-style keyup is never target-guarded', () => {
    const seen = attach({
      keyIdentity: 'code',
      keyTargetGuard: 'isEditable',
    });
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.dispatchEvent(keyboard('keyup', { code: 'KeyW' }));
    expect(seen.up).toEqual(['KeyW']);
  });

  test('a true keydown result prevents the default', () => {
    attach({ onKeyDown: () => true });
    const event = keyboard('keydown', { code: 'ArrowUp' });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test('a false keydown result preserves the default', () => {
    attach({ onKeyDown: () => false });
    const event = keyboard('keydown', { code: 'ArrowUp' });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  test('blur invokes the registered reset', () => {
    let resets = 0;
    attach({ onReset: () => { resets += 1; } });
    window.dispatchEvent(new dom.window.Event('blur'));
    expect(resets).toBe(1);
  });

  test('hidden visibilitychange invokes the registered reset', () => {
    let resets = 0;
    attach({ onReset: () => { resets += 1; } });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    expect(resets).toBe(1);
  });

  test('focus invokes the registered reset', () => {
    let resets = 0;
    attach({ onReset: () => { resets += 1; } });
    window.dispatchEvent(new dom.window.Event('focus'));
    expect(resets).toBe(1);
  });

  test('pageshow invokes the registered reset', () => {
    let resets = 0;
    attach({ onReset: () => { resets += 1; } });
    window.dispatchEvent(new dom.window.Event('pageshow'));
    expect(resets).toBe(1);
  });

  test('extra listeners share the attachment lifetime', () => {
    let calls = 0;
    const { down } = attach({
      extra: [
        {
          type: 'pointerdown',
          listener: () => { calls += 1; },
        },
      ],
    });
    window.dispatchEvent(new dom.window.Event('pointerdown'));
    detachments.pop()?.();
    window.dispatchEvent(new dom.window.Event('pointerdown'));
    expect({ calls, down }).toEqual({ calls: 1, down: [] });
  });

  test('custom activity actions use the string-typed stage helper', () => {
    let bit = 0;
    attach({
      extra: [
        {
          type: 'clawville:activity-action',
          listener: (event) => {
            bit = (event as CustomEvent<{ bit: number }>).detail.bit;
          },
        },
      ],
    });
    window.dispatchEvent(
      new dom.window.CustomEvent('clawville:activity-action', {
        detail: { bit: 2 },
      }),
    );
    expect(bit).toBe(2);
  });

  test('attach and detach balance every counted listener', () => {
    const baseline = useStageStore.getState().windowListenerCount;
    const detach = attachHeldKeyListeners({
      keyIdentity: 'code',
      keyTargetGuard: 'none',
      onKeyDown: () => false,
      onKeyUp: () => {},
      onReset: () => {},
      extra: [
        { type: 'pointerdown', listener: () => {} },
        { type: 'clawville:activity-action', listener: () => {} },
      ],
    });
    expect(useStageStore.getState().windowListenerCount).toBe(baseline + 4);
    detach();
    expect(useStageStore.getState().windowListenerCount).toBe(baseline);
  });

  test('avatar controller output matches its pre-extraction sequence', () => {
    const legacy = {
      w: false,
      arrowup: false,
      shift: false,
    };
    const replayLegacy = (
      type: 'keydown' | 'keyup',
      key: string,
      shiftKey = false,
    ) => {
      const normalized = key.toLowerCase();
      if (normalized === 'shift') legacy.shift = type === 'keydown';
      else {
        legacy.shift = shiftKey;
        if (normalized === 'w' || normalized === 'arrowup') {
          legacy[normalized] = type === 'keydown';
        }
      }
    };
    const detach = attachPlayerKeyListeners(WORLD_VRM_POLICY.input);
    detachments.push(detach);
    for (const [type, key, code, shiftKey] of [
      ['keydown', 'W', 'KeyW', false],
      ['keydown', 'Shift', 'ShiftLeft', true],
      ['keydown', 'ArrowUp', 'ArrowUp', true],
      ['keyup', 'W', 'KeyW', true],
      ['keyup', 'Shift', 'ShiftLeft', false],
    ] as const) {
      replayLegacy(type, key, shiftKey);
      window.dispatchEvent(keyboard(type, { key, code, shiftKey }));
    }
    expect({
      w: playerKeyState.w,
      arrowup: playerKeyState.arrowup,
      shift: playerKeyState.shift,
    }).toEqual(legacy);
  });

  test('activity keyboard output matches its pre-extraction sequence', () => {
    const actual = { w: false, actionBits: 0, oneShotBits: 0, dir: 0 };
    const legacy = { ...actual };
    const apply = (
      state: typeof actual,
      type: 'keydown' | 'keyup',
      code: string,
    ) => {
      if (code === 'KeyW') {
        state.w = type === 'keydown';
        state.dir = state.w ? -1 : 0;
      }
      if (code === 'Space') {
        if (type === 'keydown') {
          state.actionBits |= 1;
          state.oneShotBits |= 1;
        } else {
          state.actionBits &= ~1;
        }
      }
    };
    const detach = attachHeldKeyListeners({
      keyIdentity: 'code',
      keyTargetGuard: 'isEditable',
      onKeyDown: (code) => {
        apply(actual, 'keydown', code);
        return code === 'KeyW' || code === 'Space';
      },
      onKeyUp: (code) => {
        apply(actual, 'keyup', code);
      },
      onReset: () => {
        actual.w = false;
        actual.actionBits = 0;
        actual.oneShotBits = 0;
        actual.dir = 0;
      },
    });
    detachments.push(detach);
    for (const [type, code] of [
      ['keydown', 'KeyW'],
      ['keydown', 'Space'],
      ['keyup', 'KeyW'],
      ['keyup', 'Space'],
    ] as const) {
      apply(legacy, type, code);
      window.dispatchEvent(keyboard(type, { code }));
    }
    expect(actual).toEqual(legacy);
  });
});

function typeLevelCustomEventGuard() {
  // @ts-expect-error The typed helper deliberately rejects custom event names.
  return addStageWindowListener('clawville:activity-action', () => {});
}
void typeLevelCustomEventGuard;
