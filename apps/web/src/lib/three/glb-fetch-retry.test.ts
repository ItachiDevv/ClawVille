import { describe, expect, test } from 'bun:test';
import {
  GLB_FETCH_RETRY_DELAYS_MS,
  installGlbFetchRetry,
  isTransientGlbFetchError,
  readOptionalGltf,
} from './glb-fetch-retry';

type Done = { kind: 'load'; data: string } | { kind: 'error'; error: unknown };

/** A loader whose Nth call fails with outcomes[N] (or succeeds when undefined). */
function scriptedLoader(outcomes: readonly unknown[]) {
  const calls: string[] = [];
  const loader = {
    load(
      url: string,
      onLoad: (data: string) => void,
      _onProgress?: (event: ProgressEvent) => void,
      onError?: (error: unknown) => void,
    ): void {
      const failure = outcomes[calls.length];
      calls.push(url);
      if (failure === undefined) onLoad(`gltf:${url}`);
      else onError?.(failure);
    },
  };
  return { loader, calls };
}

function manualSchedule() {
  const pending: Array<{ run: () => void; ms: number }> = [];
  return {
    pending,
    schedule: (run: () => void, ms: number) => {
      pending.push({ run, ms });
    },
    flush() {
      const next = pending.shift();
      if (!next) throw new Error('nothing scheduled');
      next.run();
      return next.ms;
    },
  };
}

function load(loader: { load: (...args: never[]) => void }, url: string): Done[] {
  const done: Done[] = [];
  (loader.load as (
    url: string,
    onLoad: (data: string) => void,
    onProgress: undefined,
    onError: (error: unknown) => void,
  ) => void)(
    url,
    (data) => done.push({ kind: 'load', data }),
    undefined,
    (error) => done.push({ kind: 'error', error }),
  );
  return done;
}

const networkError = () => new TypeError('Failed to fetch');
const httpError = (status: number) =>
  Object.assign(new Error(`fetch for "x" responded with ${status}`), {
    response: { status },
  });

describe('isTransientGlbFetchError', () => {
  test('network failures from fetch() are transient (Chrome, Firefox, Safari wording)', () => {
    expect(isTransientGlbFetchError(new TypeError('Failed to fetch'))).toBe(true);
    expect(
      isTransientGlbFetchError(
        new TypeError('NetworkError when attempting to fetch resource.'),
      ),
    ).toBe(true);
    expect(isTransientGlbFetchError(new TypeError('Load failed'))).toBe(true);
  });

  test('5xx, 408 and 429 responses are transient; 404 and 403 are not', () => {
    expect(isTransientGlbFetchError(httpError(503))).toBe(true);
    expect(isTransientGlbFetchError(httpError(502))).toBe(true);
    expect(isTransientGlbFetchError(httpError(408))).toBe(true);
    expect(isTransientGlbFetchError(httpError(429))).toBe(true);
    expect(isTransientGlbFetchError(httpError(404))).toBe(false);
    expect(isTransientGlbFetchError(httpError(403))).toBe(false);
  });

  test('parse errors and non-errors are not transient', () => {
    expect(
      isTransientGlbFetchError(new Error('THREE.GLTFLoader: Unsupported asset.')),
    ).toBe(false);
    expect(
      isTransientGlbFetchError(
        new TypeError("Cannot read properties of undefined (reading 'source')"),
      ),
    ).toBe(false);
    expect(isTransientGlbFetchError('Failed to fetch')).toBe(false);
    expect(isTransientGlbFetchError(undefined)).toBe(false);
  });
});

describe('installGlbFetchRetry', () => {
  test('one failed fetch is retried and the load succeeds (the prod 2026-10-04 case)', () => {
    const { loader, calls } = scriptedLoader([networkError()]);
    const timers = manualSchedule();
    installGlbFetchRetry(loader, { schedule: timers.schedule });

    const done = load(loader, '/models/building-chest.glb');
    expect(done).toEqual([]);
    expect(timers.flush()).toBe(GLB_FETCH_RETRY_DELAYS_MS[0]);

    expect(calls).toEqual(['/models/building-chest.glb', '/models/building-chest.glb']);
    expect(done).toEqual([{ kind: 'load', data: 'gltf:/models/building-chest.glb' }]);
  });

  test('gives up after the last delay and reports the last error once', () => {
    const last = networkError();
    const { loader, calls } = scriptedLoader([networkError(), networkError(), last]);
    const timers = manualSchedule();
    installGlbFetchRetry(loader, { schedule: timers.schedule });

    const done = load(loader, '/m.glb');
    const delays = GLB_FETCH_RETRY_DELAYS_MS.map(() => timers.flush());

    expect(delays).toEqual([...GLB_FETCH_RETRY_DELAYS_MS]);
    expect(timers.pending).toEqual([]);
    expect(calls.length).toBe(GLB_FETCH_RETRY_DELAYS_MS.length + 1);
    expect(done).toEqual([{ kind: 'error', error: last }]);
  });

  test('a non-transient error fails at once with no retry', () => {
    const notFound = httpError(404);
    const { loader, calls } = scriptedLoader([notFound]);
    const timers = manualSchedule();
    installGlbFetchRetry(loader, { schedule: timers.schedule });

    const done = load(loader, '/missing.glb');

    expect(timers.pending).toEqual([]);
    expect(calls).toEqual(['/missing.glb']);
    expect(done).toEqual([{ kind: 'error', error: notFound }]);
  });

  test('installing twice does not stack retries', () => {
    const { loader, calls } = scriptedLoader([
      networkError(),
      networkError(),
      networkError(),
      networkError(),
    ]);
    const timers = manualSchedule();
    installGlbFetchRetry(loader, { schedule: timers.schedule });
    installGlbFetchRetry(loader, { schedule: timers.schedule });

    load(loader, '/m.glb');
    while (timers.pending.length > 0) timers.flush();

    expect(calls.length).toBe(GLB_FETCH_RETRY_DELAYS_MS.length + 1);
  });

  test('without an onError callback the final error goes to console.error, as GLTFLoader does', () => {
    const final = httpError(404);
    const { loader } = scriptedLoader([final]);
    installGlbFetchRetry(loader, { schedule: () => {} });
    const original = console.error;
    const logged: unknown[] = [];
    console.error = (value: unknown) => logged.push(value);
    try {
      loader.load('/m.glb', () => {});
    } finally {
      console.error = original;
    }
    expect(logged).toEqual([final]);
  });
});

describe('readOptionalGltf', () => {
  test('returns the value when the read succeeds', () => {
    expect(readOptionalGltf('/a.glb', () => 'scene')).toBe('scene');
  });

  test('a cached loader rejection becomes null so only that model is skipped', () => {
    const original = console.warn;
    const warned: unknown[][] = [];
    console.warn = (...args: unknown[]) => warned.push(args);
    try {
      const read = () => {
        throw new Error('Could not load /b.glb: Failed to fetch');
      };
      expect(readOptionalGltf('/b.glb', read)).toBeNull();
      expect(readOptionalGltf('/b.glb', read)).toBeNull();
    } finally {
      console.warn = original;
    }
    // Re-renders read the cached rejection again; warn once per path.
    expect(warned.length).toBe(1);
  });

  test('a suspended read (thrown promise) is rethrown for Suspense', () => {
    const pending = new Promise(() => {});
    let thrown: unknown;
    try {
      readOptionalGltf('/c.glb', () => {
        throw pending;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(pending);
  });

  test('any other error is rethrown (render bugs must still surface)', () => {
    const bug = new Error('Suspense Exception: This is not a real error!');
    expect(() =>
      readOptionalGltf('/d.glb', () => {
        throw bug;
      }),
    ).toThrow(bug);
  });
});
