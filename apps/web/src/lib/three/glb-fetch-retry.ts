/**
 * glb-fetch-retry.ts
 *
 * Two guards for one failed GLB load (prod 2026-10-04: a single
 * "Failed to fetch" on /models/building-chest.glb).
 *
 * R3F useLoader caches a load REJECTION in suspend-react's global cache for
 * the rest of the session and rethrows it on every render. Nothing in the
 * world scene catches it below R3F's <Canvas>, so the error reached
 * StageCanvasErrorBoundary and the whole 3D world was replaced by the
 * "This browser couldn't start the 3D view" panel.
 *
 * 1. installGlbFetchRetry: retries a failed GLB REQUEST (network failure or
 *    HTTP 408/429/5xx for that URL) inside the loader, before the rejection
 *    reaches the cache. Parse and decode errors are never retried.
 * 2. readOptionalGltf: for optional models only, turns the cached rejection
 *    of THAT exact path (fetch OR parse/decode failure) into `null` and logs
 *    one console.error per path. Required models keep throwing.
 *
 * How a failure is classified (three r185 + three-stdlib 2.36.1):
 * - GLTFLoader.load (three-stdlib loaders/GLTFLoader.js L79-112, three
 *   examples/jsm/loaders/GLTFLoader.js L266-337) fetches with a FileLoader
 *   and then calls `scope.parse( data, resourcePath, onLoad, _onError )`
 *   inside a try/catch that also routes to `_onError`. Every parse, decoder
 *   and dependent-resource error therefore passes through `parse` on the
 *   same instance. The wrapper below tags those error objects (phase
 *   'parse'). An untagged error comes from the FileLoader request itself.
 * - three/src/loaders/FileLoader.js r185: a non-200/0 status throws
 *   `new HttpError( \`fetch for "${response.url}" responded with
 *   ${response.status}: ...\`, response )` (L220); a rejected fetch() or a
 *   failed body read reaches `.catch( err => ... callback.onError( err ) )`
 *   (L288-306) as a TypeError; an abort arrives as DOMException AbortError.
 *   `new Request( url, ... )` (L129) can throw synchronously out of load().
 *
 * No three / React imports: pure logic, unit-tested in glb-fetch-retry.test.ts
 * and through the real R3F + drei + GLTFLoader path in
 * glb-fetch-retry.integration.test.ts.
 */

/** Wait before retry 1 and retry 2. A third request failure is final. */
export const GLB_FETCH_RETRY_DELAYS_MS: readonly number[] = [500, 2000];

export type GlbLoadFailurePhase = 'fetch' | 'parse';

export interface GlbLoadFailure {
  readonly phase: GlbLoadFailurePhase;
  readonly error: unknown;
  readonly attempts: number;
}

/** Schedules `run` after `ms`; returns a cancel function. */
export type GlbRetrySchedule = (run: () => void, ms: number) => () => void;

// Method syntax keeps parameter bivariance, so three-stdlib's GLTFLoader
// (onError: (event: ErrorEvent) => void) is assignable.
export interface RetryableGltfLoader {
  load(
    url: string,
    onLoad: (data: any) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: any) => void,
  ): void;
  parse?(
    data: any,
    path: string,
    onLoad: (data: any) => void,
    onError?: (error: any) => void,
  ): void;
  manager?: { abortController?: AbortController };
}

const RETRY_INSTALLED = new WeakSet<object>();
const PARSE_PHASE_ERRORS = new WeakSet<object>();
const LAST_FAILURE = new Map<string, GlbLoadFailure>();
const REPORTED_PATHS = new Set<string>();

const defaultSchedule: GlbRetrySchedule = (run, ms) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

function markParsePhase(error: unknown): void {
  if (typeof error === 'object' && error !== null) PARSE_PHASE_ERRORS.add(error);
}

function phaseOf(error: unknown): GlbLoadFailurePhase {
  return typeof error === 'object' && error !== null && PARSE_PHASE_ERRORS.has(error)
    ? 'parse'
    : 'fetch';
}

/**
 * True when a REQUEST-phase failure is worth one more request: an HttpError
 * with status 408, 429 or 5xx (sw.js answers an offline miss with 503), or a
 * TypeError (fetch() rejected or the body stream broke). 4xx, AbortError and
 * anything else are final. Call this only for request-phase errors: a parse
 * TypeError is never retried (installGlbFetchRetry checks the phase first).
 */
export function isRetryableGlbFetchError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || status >= 500;
  }
  return (error as { name?: unknown }).name === 'TypeError';
}

/** The final failure recorded for `url` by a retry-wrapped loader, if any. */
export function getLastGlbLoadFailure(url: string): GlbLoadFailure | undefined {
  return LAST_FAILURE.get(url);
}

/**
 * Wraps `load` (and `parse`, to tag parse-phase errors) once per loader
 * instance. R3F keeps ONE GLTFLoader per constructor, so this covers every
 * useGLTF call on that instance once installed.
 *
 * Per load call: onLoad / onError fire at most once in total (late callbacks
 * are dropped). No retry is scheduled, and a pending retry is cancelled with
 * the last error, when the loader's LoadingManager is aborted (the only
 * cancel the three loader API has; captured at call time because
 * LoadingManager.abort() replaces its controller). R3F and suspend-react
 * have no per-caller cancel: the cached promise outlives an unmounted
 * consumer, and a finished retry still fills the cache for a remount.
 */
export function installGlbFetchRetry(
  loader: RetryableGltfLoader,
  options: { schedule?: GlbRetrySchedule } = {},
): void {
  if (RETRY_INSTALLED.has(loader)) return;
  RETRY_INSTALLED.add(loader);
  const schedule = options.schedule ?? defaultSchedule;

  if (typeof loader.parse === 'function') {
    const baseParse = loader.parse.bind(loader);
    loader.parse = (data, path, onLoad, onError) => {
      try {
        baseParse(data, path, onLoad, (error: unknown) => {
          markParsePhase(error);
          if (onError) onError(error);
        });
      } catch (error) {
        markParsePhase(error);
        throw error;
      }
    };
  }

  const baseLoad = loader.load.bind(loader);
  loader.load = (url, onLoad, onProgress, onError) => {
    const signal = loader.manager?.abortController?.signal;
    let settled = false;
    let attempts = 0;
    let lastError: unknown;
    let cancelPending: (() => void) | null = null;

    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
      if (cancelPending) cancelPending();
      cancelPending = null;
    };
    const fail = (error: unknown, phase: GlbLoadFailurePhase): void => {
      if (settled) return;
      settled = true;
      cleanup();
      LAST_FAILURE.set(url, { phase, error, attempts });
      if (onError) onError(error);
      else console.error(error);
    };
    const succeed = (data: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      LAST_FAILURE.delete(url);
      onLoad(data);
    };
    function onAbort(): void {
      if (cancelPending) fail(lastError, 'fetch');
    }
    const progress = onProgress
      ? (event: ProgressEvent) => {
          if (!settled) onProgress(event);
        }
      : undefined;

    const attempt = (): void => {
      cancelPending = null;
      attempts += 1;
      const thisAttempt = attempts;
      let attemptFailed = false;
      try {
        baseLoad(url, succeed, progress, (error: unknown) => {
          // Only the CURRENT attempt's FIRST error may retry or fail; a
          // duplicate or stale error must not schedule a second timer.
          if (settled || attemptFailed || thisAttempt !== attempts) return;
          attemptFailed = true;
          const phase = phaseOf(error);
          const delay = GLB_FETCH_RETRY_DELAYS_MS[thisAttempt - 1];
          if (
            phase === 'fetch' &&
            delay !== undefined &&
            isRetryableGlbFetchError(error) &&
            !signal?.aborted
          ) {
            lastError = error;
            cancelPending = schedule(attempt, delay);
            return;
          }
          fail(error, phase);
        });
      } catch (error) {
        // FileLoader builds `new Request(url, ...)` synchronously; such a
        // throw never reaches onError. Final, never retried.
        fail(error, phaseOf(error));
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    attempt();
  };
}

/** "<class>: <message>". Uses the constructor name: three's HttpError keeps name "Error". */
function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    const ctor = (error as { constructor?: { name?: unknown } }).constructor?.name;
    const cls = typeof ctor === 'string' && ctor !== '' && ctor !== 'Object' ? ctor : String(name ?? 'Error');
    return `${cls}: ${String(message)}`;
  }
  return String(error);
}

/**
 * Reads an OPTIONAL model. When the read throws R3F's cached rejection for
 * exactly `path` (message `Could not load ${path}: ...`, the format of R3F
 * useLoader's loadingFn), returns `null` so the caller skips this model. That
 * covers EVERY failure of this model's own load: request failure after the
 * retries AND parse/decode failure (a corrupt optional prop must not crash
 * the world either). It FAILS VISIBLE: one console.error per path with the
 * original error class + message and the phase (fetch vs parse/decode).
 *
 * Rethrown unchanged: a thrown promise (Suspense), a rejection for any other
 * path, and every other error. Safe around useGLTF / useLoader: they call
 * no React hooks, so hook order is the same whether the read returns or throws.
 */
export function readOptionalGltf<T>(path: string, read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith(`Could not load ${path}: `)) {
      throw error;
    }
    if (!REPORTED_PATHS.has(path)) {
      REPORTED_PATHS.add(path);
      const failure = LAST_FAILURE.get(path);
      const kind = !failure
        ? 'unknown-phase error'
        : failure.phase === 'fetch'
          ? `fetch error after ${failure.attempts} request(s)`
          : 'parse/decode error';
      const original = failure?.error ?? error;
      console.error(
        `[GLB] optional model skipped: ${path} (${kind}) ${describeError(original)}`,
        original,
      );
    }
    return null;
  }
}
