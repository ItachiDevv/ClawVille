/**
 * model-load-error.ts — the tag for "this model failed to load".
 *
 * Created at the loader SOURCE, never by matching text in a boundary:
 * - vrm-loader.ts: the 'rejected' instance entry useVRMInstance rethrows.
 * - use-gltf-ktx2.ts: useGLTFWithKTX2 rethrows R3F's cached rejection for
 *   its own path as this type (R3F creates that Error inside its loadingFn
 *   with no hook; the hook that reads it is the first place we own).
 *
 * ModelLoadBoundary handles ONLY this type; every other error (a render bug
 * in a figure) goes on to the outer boundary.
 *
 * `clear()` evicts the cached rejection that produced this error (GLB:
 * useGLTF.clear(url); VRM: the 'rejected' instance entry, identity-guarded),
 * so the next mount of that figure requests the model again.
 */

export type ModelLoadPhase = 'fetch' | 'parse' | 'load-callback' | 'unknown';

const BRAND = Symbol.for('clawville.modelLoadError');

export class ModelLoadError extends Error {
  readonly [BRAND] = true;
  readonly url: string;
  readonly phase: ModelLoadPhase;
  /** The loader's own error (fetch TypeError, HttpError, parse error...). */
  readonly original: unknown;
  private readonly clearFn: (() => void) | undefined;

  constructor(options: {
    url: string;
    phase: ModelLoadPhase;
    original: unknown;
    message: string;
    clear?: () => void;
  }) {
    super(options.message);
    this.name = 'ModelLoadError';
    this.url = options.url;
    this.phase = options.phase;
    this.original = options.original;
    this.clearFn = options.clear;
  }

  /** Evict the cached rejection so a later mount loads again. Idempotent. */
  clear(): void {
    this.clearFn?.();
  }
}

export function isModelLoadError(error: unknown): error is ModelLoadError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[BRAND] === true
  );
}
