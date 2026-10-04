/**
 * glb-fetch-retry.ts
 *
 * Two guards for one failed GLB fetch (prod 2026-10-04: a single
 * "Failed to fetch" on /models/building-chest.glb).
 *
 * R3F useLoader caches a load REJECTION in suspend-react's global cache for
 * the rest of the session and rethrows it on every render. Nothing in the
 * world scene catches it below R3F's <Canvas>, so the error reached
 * StageCanvasErrorBoundary and the whole 3D world was replaced by the
 * "This browser couldn't start the 3D view" panel.
 *
 * 1. installGlbFetchRetry: retries a transient fetch failure inside the
 *    loader, BEFORE the rejection reaches the cache.
 * 2. readOptionalGltf: for optional models only, turns a cached loader
 *    rejection into `null`, so the caller skips that one model.
 *
 * No three / React imports: pure logic, unit-tested in glb-fetch-retry.test.ts.
 */

/** Wait before retry 1 and retry 2. A third failure is final. */
export const GLB_FETCH_RETRY_DELAYS_MS: readonly number[] = [500, 2000];

type LoadFn<T> = (
  url: string,
  onLoad: (data: T) => void,
  onProgress?: (event: ProgressEvent) => void,
  // Matches three-stdlib GLTFLoader's (event: ErrorEvent) => void by bivariance.
  onError?: (error: any) => void,
) => void;

type Schedule = (run: () => void, ms: number) => void;

const RETRY_INSTALLED = new WeakSet<object>();
const WARNED_PATHS = new Set<string>();

/**
 * True for a fetch() network failure (TypeError: Chrome "Failed to fetch",
 * Firefox "NetworkError ...", Safari "Load failed") and for HTTP 408, 429
 * and 5xx (three's FileLoader HttpError carries `response`; the service
 * worker answers an offline miss with 503). Parse errors and 4xx are final.
 */
export function isTransientGlbFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || status >= 500;
  }
  return (
    error.name === 'TypeError' &&
    /failed to fetch|networkerror|load failed/i.test(error.message)
  );
}

/**
 * Wraps `loader.load` once per loader instance. A transient failure is
 * retried after each delay in GLB_FETCH_RETRY_DELAYS_MS; the caller's
 * onError gets only the final error. Each attempt is a full GLTFLoader.load
 * (its own manager itemStart/itemEnd pair), and FileLoader drops a failed
 * URL from its in-flight map, so every retry is a new request.
 */
export function installGlbFetchRetry<T>(
  loader: { load: LoadFn<T> },
  options: { schedule?: Schedule } = {},
): void {
  if (RETRY_INSTALLED.has(loader)) return;
  RETRY_INSTALLED.add(loader);
  const schedule: Schedule =
    options.schedule ?? ((run, ms) => void setTimeout(run, ms));
  const baseLoad = loader.load.bind(loader);

  loader.load = (url, onLoad, onProgress, onError) => {
    let retries = 0;
    const attempt = (): void => {
      baseLoad(url, onLoad, onProgress, (error: unknown) => {
        const delay = GLB_FETCH_RETRY_DELAYS_MS[retries];
        if (delay !== undefined && isTransientGlbFetchError(error)) {
          retries += 1;
          schedule(attempt, delay);
          return;
        }
        if (onError) onError(error);
        else console.error(error);
      });
    };
    attempt();
  };
}

/**
 * Reads an OPTIONAL model. Returns `null` when the read throws R3F's cached
 * loader rejection ("Could not load <url>: ..."), so one missing model is
 * skipped instead of crashing the canvas. A thrown promise (Suspense) and
 * every other error are rethrown unchanged.
 *
 * Safe around useGLTF / useLoader: they call no React hooks, so hook order
 * is the same whether the read returns or throws.
 */
export function readOptionalGltf<T>(path: string, read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Could not load ')) {
      throw error;
    }
    if (!WARNED_PATHS.has(path)) {
      WARNED_PATHS.add(path);
      console.warn(`[GLB] optional model skipped after retries: ${path}`, error);
    }
    return null;
  }
}
