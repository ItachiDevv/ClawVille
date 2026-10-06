/**
 * Fingerprint visitor-ID cache (web-load T4, 2026-10-06).
 *
 * The FingerprintJS canvas pass costs a 0.47-0.58 s main-thread task on a
 * cold /game load, and every fingerprinted API call waits on it. The module
 * now persists the computed visitorId in localStorage (`cv:fp:v1`) and serves
 * it immediately on later loads, then re-computes it in the background after
 * the loader is gone. These tests pin the invariants: the header value is
 * always a FingerprintJS visitorId, '' is never cached, and a cached value
 * never runs FingerprintJS on the load path.
 *
 * Each test imports a FRESH module instance (`?case-N` query) so the
 * module-level memo does not leak between cases.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const VALID_A = '0123456789abcdef0123456789abcdef';
const VALID_B = 'fedcba9876543210fedcba9876543210';
const STORAGE_KEY = 'cv:fp:v1';

let nextVisitorId = VALID_A;
let loadShouldFail = false;
const getMock = mock(async () => ({ visitorId: nextVisitorId }));
const loadMock = mock(async () => {
  if (loadShouldFail) throw new Error('fpjs load failed');
  return { get: getMock };
});

mock.module('@fingerprintjs/fingerprintjs', () => ({
  default: { load: loadMock },
  load: loadMock,
}));

type FingerprintModule = typeof import('../fingerprint');

let importCounter = 0;
async function freshModule(): Promise<FingerprintModule> {
  importCounter += 1;
  return (await import(`../fingerprint?case-${importCounter}`)) as FingerprintModule;
}

type StorageMode = 'ok' | 'get-throws' | 'set-throws' | 'access-throws';

interface FakeWindow {
  store: Map<string, string>;
  timers: Array<() => void>;
  idle: Array<() => void>;
  /** Every delay passed to setTimeout, in call order. */
  timerDelays: Array<number | undefined>;
  /** Every `timeout` option passed to requestIdleCallback, in call order. */
  idleTimeouts: Array<number | undefined>;
  setItemCalls: number;
}

let fake: FakeWindow;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalWarn = console.warn;

function installWindow(mode: StorageMode = 'ok', initial?: string): FakeWindow {
  const state: FakeWindow = {
    store: new Map(),
    timers: [],
    idle: [],
    timerDelays: [],
    idleTimeouts: [],
    setItemCalls: 0,
  };
  if (initial !== undefined) state.store.set(STORAGE_KEY, initial);
  const storage = {
    getItem(key: string): string | null {
      if (mode === 'get-throws') throw new Error('SecurityError');
      return state.store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      state.setItemCalls += 1;
      if (mode === 'set-throws') throw new Error('QuotaExceededError');
      state.store.set(key, value);
    },
    removeItem(key: string): void {
      state.store.delete(key);
    },
  };
  const win: Record<string, unknown> = {
    setTimeout: (fn: () => void, delay?: number) => {
      state.timers.push(fn);
      state.timerDelays.push(delay);
      return state.timers.length;
    },
    clearTimeout: () => undefined,
    requestIdleCallback: (fn: () => void, options?: { timeout?: number }) => {
      state.idle.push(fn);
      state.idleTimeouts.push(options?.timeout);
      return state.idle.length;
    },
  };
  if (mode === 'access-throws') {
    Object.defineProperty(win, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage disabled');
      },
    });
  } else {
    win.localStorage = storage;
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: win });
  return state;
}

/**
 * Drain the microtask queue. The mocked FingerprintJS resolves through
 * promises only (no timers), so a bounded microtask flush settles the
 * refresh chain without a wall-clock sleep.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** Fire every queued timer, then every queued idle callback, then settle. */
async function runBackground(state: FakeWindow): Promise<void> {
  while (state.timers.length > 0 || state.idle.length > 0) {
    const timers = state.timers.splice(0);
    for (const fn of timers) fn();
    const idle = state.idle.splice(0);
    for (const fn of idle) fn();
    await flushMicrotasks();
  }
}

beforeEach(() => {
  nextVisitorId = VALID_A;
  loadShouldFail = false;
  loadMock.mockClear();
  getMock.mockClear();
  console.warn = () => undefined;
});

afterEach(() => {
  console.warn = originalWarn;
});

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: unknown }).window;
});

describe('getFingerprint visitor-ID cache', () => {
  test('a cached valid visitorId is returned without running FingerprintJS on the load path', async () => {
    fake = installWindow('ok', VALID_A);
    const { getFingerprint } = await freshModule();

    expect(await getFingerprint()).toBe(VALID_A);
    expect(await getFingerprint()).toBe(VALID_A);
    expect(loadMock).toHaveBeenCalledTimes(0);
  });

  test('a cached value is refreshed in the background, and a changed value applies from the next load', async () => {
    fake = installWindow('ok', VALID_A);
    nextVisitorId = VALID_B;
    const first = await freshModule();

    expect(await first.getFingerprint()).toBe(VALID_A);
    expect(loadMock).toHaveBeenCalledTimes(0);
    // Exactly one deferred refresh is queued, even after several calls.
    await first.getFingerprint();
    expect(fake.timers.length).toBe(1);
    // The refresh waits 30 s, past the measured cold loader (7.7-8.5 s
    // desktop, 23 s on the 4x-CPU proxy), then an idle slot capped at 30 s.
    expect(fake.timerDelays).toEqual([30_000]);

    await runBackground(fake);
    expect(fake.idleTimeouts).toEqual([30_000]);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(fake.store.get(STORAGE_KEY)).toBe(VALID_B);
    // Same page keeps one identity: no mid-session header switch.
    expect(await first.getFingerprint()).toBe(VALID_A);

    // Next page load reads the refreshed value.
    const second = await freshModule();
    expect(await second.getFingerprint()).toBe(VALID_B);
  });

  test('a background refresh failure keeps the cached value', async () => {
    fake = installWindow('ok', VALID_A);
    const { getFingerprint } = await freshModule();
    expect(await getFingerprint()).toBe(VALID_A);

    loadShouldFail = true;
    await runBackground(fake);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(fake.store.get(STORAGE_KEY)).toBe(VALID_A);
    expect(await getFingerprint()).toBe(VALID_A);
  });

  test('with no cache it computes once and stores the visitorId', async () => {
    fake = installWindow('ok');
    const { getFingerprint } = await freshModule();

    expect(await getFingerprint()).toBe(VALID_A);
    expect(await getFingerprint()).toBe(VALID_A);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(fake.store.get(STORAGE_KEY)).toBe(VALID_A);
    // A fresh compute needs no background refresh.
    expect(fake.timers.length).toBe(0);
  });

  test.each([
    ['not a hash', 'not-a-visitor-id'],
    ['uppercase hex', VALID_B.toUpperCase()],
    ['33 chars', `${VALID_B}0`],
    ['31 chars', VALID_B.slice(1)],
    ['empty string', ''],
    ['JSON blob', JSON.stringify({ visitorId: VALID_B })],
  ])('an invalid cache (%s) is ignored and overwritten', async (_label, corrupt) => {
    fake = installWindow('ok', corrupt);
    const { getFingerprint } = await freshModule();

    expect(await getFingerprint()).toBe(VALID_A);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(fake.store.get(STORAGE_KEY)).toBe(VALID_A);
  });

  test.each(['get-throws', 'set-throws', 'access-throws'] as const)(
    'storage that throws (%s) falls back to a live compute',
    async (mode) => {
      // get/access throws: a seeded value must be unreachable. set-throws: no
      // seed, so the live compute runs and the failing write is swallowed.
      fake = installWindow(mode, mode === 'set-throws' ? undefined : VALID_B);
      const { getFingerprint } = await freshModule();

      expect(await getFingerprint()).toBe(VALID_A);
      expect(await getFingerprint()).toBe(VALID_A);
      expect(loadMock).toHaveBeenCalledTimes(1);
    },
  );

  test("'' from a failed compute is never cached", async () => {
    fake = installWindow('ok');
    loadShouldFail = true;
    const { getFingerprint } = await freshModule();

    expect(await getFingerprint()).toBe('');
    expect(fake.setItemCalls).toBe(0);
    expect(fake.store.has(STORAGE_KEY)).toBe(false);
  });

  test("an empty visitorId is never cached", async () => {
    fake = installWindow('ok');
    nextVisitorId = '';
    const { getFingerprint } = await freshModule();

    expect(await getFingerprint()).toBe('');
    expect(fake.setItemCalls).toBe(0);
  });

  test('concurrent first calls share one computation', async () => {
    fake = installWindow('ok');
    const { getFingerprint } = await freshModule();

    const results = await Promise.all([getFingerprint(), getFingerprint(), getFingerprint()]);
    expect(results).toEqual([VALID_A, VALID_A, VALID_A]);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  test('SSR (no window) returns empty without touching FingerprintJS', async () => {
    delete (globalThis as { window?: unknown }).window;
    const { getFingerprint } = await freshModule();

    expect(await getFingerprint()).toBe('');
    expect(loadMock).toHaveBeenCalledTimes(0);
  });
});
