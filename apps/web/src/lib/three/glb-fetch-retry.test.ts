import { describe, expect, test } from 'bun:test';
import {
  GLB_FETCH_RETRY_DELAYS_MS,
  getLastGlbLoadFailure,
  installGlbFetchRetry,
  isRetryableGlbFetchError,
  readOptionalGltf,
  type RetryableGltfLoader,
} from './glb-fetch-retry';

/**
 * Mock with the same shape as GLTFLoader.load: the "request" either fails
 * (outcome.fetchError) or delivers bytes, and bytes go through `this.parse`
 * exactly like `scope.parse( data, resourcePath, onLoad, _onError )`.
 */
type Outcome = { fetchError: unknown } | { data: string };

function scriptedLoader(outcomes: readonly Outcome[]) {
  const calls: string[] = [];
  const parses: string[] = [];
  const loader: RetryableGltfLoader & { manager: { abortController: AbortController } } = {
    manager: { abortController: new AbortController() },
    load(url, onLoad, _onProgress, onError) {
      const outcome = outcomes[calls.length] ?? { data: 'ok' };
      calls.push(url);
      if ('fetchError' in outcome) {
        onError?.(outcome.fetchError);
        return;
      }
      try {
        this.parse!(outcome.data, '', onLoad, onError);
      } catch (error) {
        onError?.(error);
      }
    },
    parse(data, _path, onLoad, onError) {
      parses.push(data);
      if (data === 'json-garbage') onError?.(new SyntaxError('Unexpected token'));
      else if (data === 'decoder-typeerror') {
        onError?.(new TypeError("Cannot read properties of undefined (reading 'source')"));
      } else if (data === 'throws') throw new Error('THREE.GLTFLoader: Unsupported asset.');
      else onLoad(`gltf:${data}`);
    },
  };
  return { loader, calls, parses };
}

function manualSchedule() {
  const pending: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  return {
    pending: () => pending.filter((p) => !p.cancelled),
    schedule: (run: () => void, ms: number) => {
      const entry = { run, ms, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    flush() {
      const next = pending.find((p) => !p.cancelled);
      if (!next) throw new Error('nothing scheduled');
      next.cancelled = true;
      next.run();
      return next.ms;
    },
  };
}

type Done = { kind: 'load'; data: unknown } | { kind: 'error'; error: unknown };

function load(loader: RetryableGltfLoader, url: string): Done[] {
  const done: Done[] = [];
  loader.load(
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
    name: 'HttpError',
    response: { status },
  });

describe('isRetryableGlbFetchError (request-phase errors only)', () => {
  test('a rejected fetch / broken body (TypeError) is retryable', () => {
    expect(isRetryableGlbFetchError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryableGlbFetchError(new TypeError('network error'))).toBe(true);
    expect(isRetryableGlbFetchError(new TypeError('Load failed'))).toBe(true);
  });

  test('HTTP 408, 429 and 5xx are retryable; 404 and 403 are not', () => {
    for (const s of [408, 429, 500, 502, 503]) expect(isRetryableGlbFetchError(httpError(s))).toBe(true);
    for (const s of [400, 403, 404]) expect(isRetryableGlbFetchError(httpError(s))).toBe(false);
  });

  test('AbortError and non-errors are not retryable', () => {
    expect(isRetryableGlbFetchError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
    expect(isRetryableGlbFetchError('Failed to fetch')).toBe(false);
    expect(isRetryableGlbFetchError(undefined)).toBe(false);
  });
});

describe('installGlbFetchRetry', () => {
  test('one failed request is retried and the load succeeds (the prod 2026-10-04 case)', () => {
    const { loader, calls } = scriptedLoader([{ fetchError: networkError() }]);
    const timers = manualSchedule();
    installGlbFetchRetry(loader, { schedule: timers.schedule });

    const done = load(loader, '/models/building-chest.glb');
    expect(done).toEqual([]);
    expect(timers.flush()).toBe(GLB_FETCH_RETRY_DELAYS_MS[0]);

    expect(calls).toEqual(['/models/building-chest.glb', '/models/building-chest.glb']);
    expect(done).toEqual([{ kind: 'load', data: 'gltf:ok' }]);
    expect(getLastGlbLoadFailure('/models/building-chest.glb')).toBeUndefined();
  });

  test('gives up after the last delay, reports the last error once, records phase fetch', () => {
    const last = httpError(503);
    const { loader, calls } = scriptedLoader([
      { fetchError: networkError() },
      { fetchError: networkError() },
      { fetchError: last },
    ]);
    const timers = manualSchedule();
    installGlbFetchRetry(loader, { schedule: timers.schedule });

    const done = load(loader, '/m.glb?v=3');
    const delays = GLB_FETCH_RETRY_DELAYS_MS.map(() => timers.flush());

    expect(delays).toEqual([...GLB_FETCH_RETRY_DELAYS_MS]);
    expect(timers.pending()).toEqual([]);
    expect(calls.length).toBe(GLB_FETCH_RETRY_DELAYS_MS.length + 1);
    expect(done).toEqual([{ kind: 'error', error: last }]);
    expect(getLastGlbLoadFailure('/m.glb?v=3')).toEqual({ phase: 'fetch', error: last, attempts: 3 });
  });

  test('a non-retryable request error (404) fails at once', () => {
    const notFound = httpError(404);
    const { loader, calls } = scriptedLoader([{ fetchError: notFound }]);
    const timers = manualSchedule();
    installGlbFetchRetry(loader, { schedule: timers.schedule });

    expect(load(loader, '/missing.glb')).toEqual([{ kind: 'error', error: notFound }]);
    expect(timers.pending()).toEqual([]);
    expect(calls).toEqual(['/missing.glb']);
  });

  test('parse errors are never retried, even a TypeError, and record phase parse', () => {
    for (const data of ['json-garbage', 'decoder-typeerror', 'throws']) {
      const { loader, calls, parses } = scriptedLoader([{ data }]);
      const timers = manualSchedule();
      installGlbFetchRetry(loader, { schedule: timers.schedule });

      const url = `/bad-${data}.glb`;
      const done = load(loader, url);

      expect(timers.pending()).toEqual([]);
      expect(calls).toEqual([url]);
      expect(parses).toEqual([data]);
      expect(done.length).toBe(1);
      expect(done[0].kind).toBe('error');
      expect(getLastGlbLoadFailure(url)?.phase).toBe('parse');
    }
  });

  test('installing twice does not stack retries', () => {
    const { loader, calls } = scriptedLoader(
      Array.from({ length: 6 }, () => ({ fetchError: networkError() })),
    );
    const timers = manualSchedule();
    installGlbFetchRetry(loader, { schedule: timers.schedule });
    installGlbFetchRetry(loader, { schedule: timers.schedule });

    load(loader, '/m.glb');
    while (timers.pending().length > 0) timers.flush();

    expect(calls.length).toBe(GLB_FETCH_RETRY_DELAYS_MS.length + 1);
  });

  test('without an onError callback the final error goes to console.error, as GLTFLoader does', () => {
    const final = httpError(404);
    const { loader } = scriptedLoader([{ fetchError: final }]);
    installGlbFetchRetry(loader, { schedule: () => () => {} });
    const original = console.error;
    const logged: unknown[] = [];
    console.error = (value: unknown) => logged.push(value);
    try {
      loader.load('/m-no-onerror.glb', () => {});
    } finally {
      console.error = original;
    }
    expect(logged).toEqual([final]);
  });

  test('a synchronous throw from the base load becomes one final onError, no retry', () => {
    const thrown = new TypeError("Failed to construct 'Request': Invalid URL");
    const loader: RetryableGltfLoader = {
      load() {
        throw thrown;
      },
    };
    const timers = manualSchedule();
    installGlbFetchRetry(loader, { schedule: timers.schedule });
    expect(load(loader, 'bad url')).toEqual([{ kind: 'error', error: thrown }]);
    expect(timers.pending()).toEqual([]);
  });

  describe('at most one terminal callback', () => {
    function capturingLoader() {
      const captured: Array<{ onLoad: (d: unknown) => void; onError?: (e: unknown) => void }> = [];
      const loader: RetryableGltfLoader = {
        load(_url, onLoad, _onProgress, onError) {
          captured.push({ onLoad, onError });
        },
      };
      return { loader, captured };
    }

    test('a late onError / onLoad after success is dropped', () => {
      const { loader, captured } = capturingLoader();
      installGlbFetchRetry(loader, { schedule: manualSchedule().schedule });
      const done = load(loader, '/late-after-success.glb');

      captured[0].onLoad('first');
      captured[0].onError?.(networkError());
      captured[0].onLoad('second');

      expect(done).toEqual([{ kind: 'load', data: 'first' }]);
    });

    test('a late onLoad / onError after the final failure is dropped', () => {
      const { loader, captured } = capturingLoader();
      installGlbFetchRetry(loader, { schedule: manualSchedule().schedule });
      const notFound = httpError(404);
      const done = load(loader, '/late-after-failure.glb');

      captured[0].onError?.(notFound);
      captured[0].onLoad('late');
      captured[0].onError?.(networkError());

      expect(done).toEqual([{ kind: 'error', error: notFound }]);
    });

    test('a stale attempt that succeeds after a retry was scheduled settles once; the retry is cancelled', () => {
      const { loader, captured } = capturingLoader();
      const timers = manualSchedule();
      installGlbFetchRetry(loader, { schedule: timers.schedule });
      const done = load(loader, '/stale.glb');

      captured[0].onError?.(networkError());
      expect(timers.pending().length).toBe(1);
      captured[0].onLoad('stale-success');

      expect(done).toEqual([{ kind: 'load', data: 'stale-success' }]);
      expect(timers.pending()).toEqual([]);
      expect(captured.length).toBe(1);
    });
    test("an exception thrown by the caller's onLoad reaches onError once, terminal, no retry", () => {
      const { loader, captured } = capturingLoader();
      const timers = manualSchedule();
      installGlbFetchRetry(loader, { schedule: timers.schedule });
      const boom = new Error('buildGraph failed');
      const loads: unknown[] = [];
      const errors: unknown[] = [];
      loader.load(
        '/onload-throws.glb',
        (data) => {
          loads.push(data);
          throw boom;
        },
        undefined,
        (error) => errors.push(error),
      );

      // three-stdlib GLTFLoader: parser.parse(...).then(onLoad).catch(onError)
      try {
        captured[0].onLoad('gltf');
      } catch (error) {
        captured[0].onError?.(error);
      }
      captured[0].onError?.(networkError()); // any later callback is dropped
      captured[0].onLoad('late');

      expect(loads).toEqual(['gltf']);
      expect(errors).toEqual([boom]);
      expect(timers.pending()).toEqual([]);
      expect(captured.length).toBe(1);
      expect(getLastGlbLoadFailure('/onload-throws.glb')).toEqual({
        phase: 'load-callback',
        error: boom,
        attempts: 1,
      });
    });

    test('a duplicate or stale onError never schedules a second retry', () => {
      const { loader, captured } = capturingLoader();
      const timers = manualSchedule();
      installGlbFetchRetry(loader, { schedule: timers.schedule });
      const done = load(loader, '/dup.glb');

      captured[0].onError?.(networkError());
      captured[0].onError?.(networkError()); // duplicate from attempt 1
      expect(timers.pending().length).toBe(1);

      timers.flush(); // attempt 2 starts
      captured[0].onError?.(networkError()); // stale error from attempt 1
      expect(timers.pending()).toEqual([]);
      expect(captured.length).toBe(2);

      captured[1].onLoad('second-attempt');
      expect(done).toEqual([{ kind: 'load', data: 'second-attempt' }]);
    });
  });

  describe('LoadingManager abort', () => {
    test('an abort during the retry wait cancels the retry and fails with the last error', () => {
      const first = networkError();
      const { loader, calls } = scriptedLoader([{ fetchError: first }]);
      const timers = manualSchedule();
      installGlbFetchRetry(loader, { schedule: timers.schedule });

      const done = load(loader, '/abort-wait.glb');
      expect(timers.pending().length).toBe(1);
      loader.manager.abortController.abort();

      expect(timers.pending()).toEqual([]);
      expect(calls.length).toBe(1);
      expect(done).toEqual([{ kind: 'error', error: first }]);
    });

    test('no retry is scheduled when the manager was already aborted', () => {
      const first = networkError();
      const { loader, calls } = scriptedLoader([{ fetchError: first }]);
      const timers = manualSchedule();
      installGlbFetchRetry(loader, { schedule: timers.schedule });
      loader.manager.abortController.abort();

      expect(load(loader, '/abort-before.glb')).toEqual([{ kind: 'error', error: first }]);
      expect(timers.pending()).toEqual([]);
      expect(calls.length).toBe(1);
    });
  });
});

describe('readOptionalGltf', () => {
  function captureConsoleError<T>(run: () => T): { result: T; logged: unknown[][] } {
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      return { result: run(), logged };
    } finally {
      console.error = original;
    }
  }

  test('returns the value when the read succeeds', () => {
    expect(readOptionalGltf('/a.glb', () => 'scene')).toBe('scene');
  });

  test('the cached rejection for exactly this path (with ?v=N) becomes null; console.error once', () => {
    const path = '/models/b.glb?v=2';
    const read = () => {
      throw new Error(`Could not load ${path}: Failed to fetch`);
    };
    const { result, logged } = captureConsoleError(() => [
      readOptionalGltf(path, read),
      readOptionalGltf(path, read),
    ]);
    expect(result).toEqual([null, null]);
    expect(logged.length).toBe(1);
    expect(String(logged[0][0])).toContain(`[GLB] optional model skipped: ${path}`);
  });

  test('the console.error names the phase and the original error class from the loader', () => {
    const path = '/models/corrupt.glb?v=4';
    const { loader } = scriptedLoader([{ data: 'json-garbage' }]);
    installGlbFetchRetry(loader, { schedule: manualSchedule().schedule });
    load(loader, path);

    const { result, logged } = captureConsoleError(() =>
      readOptionalGltf(path, () => {
        throw new Error(`Could not load ${path}: Unexpected token`);
      }),
    );
    expect(result).toBeNull();
    expect(String(logged[0][0])).toContain('(parse/decode error) SyntaxError: Unexpected token');
    expect(logged[0][1]).toBeInstanceOf(SyntaxError);
  });

  test('a rejection for another path (even a different ?v=) is rethrown', () => {
    const other = new Error('Could not load /models/b.glb?v=3: Failed to fetch');
    expect(() =>
      readOptionalGltf('/models/b.glb?v=2', () => {
        throw other;
      }),
    ).toThrow(other);
    const prefix = new Error('Could not load /models/b.glb?v=22: Failed to fetch');
    expect(() =>
      readOptionalGltf('/models/b.glb?v=2', () => {
        throw prefix;
      }),
    ).toThrow(prefix);
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
