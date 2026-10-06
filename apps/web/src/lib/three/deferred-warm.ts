import * as THREE from 'three/webgpu';
import {
  chainBootCompile,
  isRendererCompileTimedOut,
  markRendererCompileTimedOut,
} from '@/lib/three/boot-core-compile';

// Keep this gentle path aligned with WorldWarmup's proven post-ready uploader.
// WorldWarmup itself stays untouched: its 2026-07-14 loader/commit ordering is a
// structural reveal gate, while these jobs begin only after decorative release.
export const DEFERRED_WARM_IDLE_SLICE_BUDGET_MS = 6;
export const DEFERRED_WARM_IDLE_MAX_TEXTURES_PER_SLICE = 4;
export const DEFERRED_WARM_RAF_FALLBACK_BATCH = 4;
export const DEFERRED_WARM_COMPILE_TIMEOUT_MS = 20_000;

export const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'lightMap',
  'envMap',
  'alphaMap',
  'bumpMap',
  'displacementMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'transmissionMap',
  'thicknessMap',
  'specularMap',
  'specularColorMap',
  'specularIntensityMap',
  'anisotropyMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
] as const;

export type DeferredWarmState = 'queued' | 'warming' | 'ready' | 'cancelled';

/**
 * Cancellation check handed to a warm job. The queue's check also carries
 * `signal`, aborted when the job is cancelled, so a not-yet-run compile task
 * releases its references at once (the attachment passes this same function
 * through to warmDeferredObject). The signal is never handed to postTask (see
 * runInUserVisibleTask). A plain `() => boolean` is accepted too.
 */
export type DeferredWarmCancelCheck = (() => boolean) & {
  readonly signal?: AbortSignal;
};

export type DeferredWarmJob = {
  priority?: number;
  warm: (isCancelled: DeferredWarmCancelCheck) => Promise<void>;
  onStateChange?: (state: DeferredWarmState) => void;
  onError?: (error: unknown) => void;
};

export type DeferredWarmQueueSchedule = (callback: () => void) => () => void;

type QueueEntry = {
  active: boolean;
  abort: AbortController;
  job: DeferredWarmJob;
  priority: number;
  sequence: number;
};

// ---------------------------------------------------------------------------
// Task priority (web-load T6, 2026-10-06). three r185 `compileAsync` yields
// with `scheduler.yield()` between pipeline-build stages. Per the WICG
// scheduling spec a `requestIdleCallback` callback runs with a BACKGROUND
// scheduling state, and an `await` keeps the state of the code that
// registered it (not the state of the task that resolves the promise). The
// warm job used to START inside the queue's idle callback, so every await in
// the job, and every yield inside the deferred compile, was a background
// continuation: on a saturated main thread (CPU 4x proxy) the first yield
// never resolved, Nori's compile hit the 20 s escape, and the renderer was
// poisoned for every later building. A postTask callback sets its OWN
// scheduling state, so the compile front now starts in a fresh user-visible
// task and three's yields resume at user-visible priority. (Timer, rAF and
// MessageChannel tasks carry no state, so a chain started there is already
// user-visible: WPT scheduler/tentative/yield/yield-scheduling-state-cleared.)
// ---------------------------------------------------------------------------

type PostTaskScheduler = {
  postTask: (
    callback: () => unknown,
    options?: { priority?: 'user-blocking' | 'user-visible' | 'background' },
  ) => Promise<unknown>;
};

function getPostTaskScheduler(): PostTaskScheduler | undefined {
  const candidate = (globalThis as { scheduler?: { postTask?: unknown } })
    .scheduler;
  return candidate && typeof candidate.postTask === 'function'
    ? (candidate as PostTaskScheduler)
    : undefined;
}

/**
 * Runs `front` at the start of a new user-visible task and resolves with its
 * (awaited) result. Without `scheduler.postTask` there is no
 * `scheduler.yield` either (no shipping browser has one without the other),
 * so three's yieldToMain uses requestAnimationFrame, which carries no
 * priority; `front` then runs synchronously, exactly as before T6.
 *
 * NO AbortSignal is passed on purpose: a postTask signal becomes the task's
 * signal and `scheduler.yield()` inside the task inherits it, so aborting it
 * after the compile started would make three's internal yields reject and
 * the compile fail midway. Callers cancel with a flag read at task start.
 */
function runInUserVisibleTask(front: () => unknown): Promise<unknown> {
  const scheduler = getPostTaskScheduler();
  if (scheduler) {
    return scheduler.postTask(front, { priority: 'user-visible' });
  }
  try {
    return Promise.resolve(front());
  } catch (error) {
    return Promise.reject(error);
  }
}

function browserWarmQueueSchedule(callback: () => void): () => void {
  if (typeof window === 'undefined') {
    queueMicrotask(callback);
    return () => {};
  }

  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(callback, { timeout: 500 });
    return () => window.cancelIdleCallback(handle);
  }

  const handle = window.setTimeout(callback, 120);
  return () => window.clearTimeout(handle);
}

/**
 * Starts the NEXT job right after the previous one finished, in a normal
 * user-visible task instead of a second idle callback. Under the CPU 4x
 * proxy every phase-D idle callback fired only by its timeout (p50 532 ms),
 * one per member transition. The task itself is tiny (pick the next entry,
 * emit 'warming', start the job up to its first await); the job's texture
 * uploads stay in idle-callback slices and the compile yields to frames, so
 * this removes a wait, not a frame-budget guard.
 */
function browserWarmContinuationSchedule(callback: () => void): () => void {
  const scheduler = getPostTaskScheduler();
  if (scheduler) {
    let live = true;
    scheduler
      .postTask(
        () => {
          if (live) callback();
        },
        { priority: 'user-visible' },
      )
      .catch((error: unknown) => {
        console.warn('[DeferredWarm] queue continuation threw:', error);
      });
    return () => {
      live = false;
    };
  }
  if (typeof window === 'undefined') {
    queueMicrotask(callback);
    return () => {};
  }
  const handle = window.setTimeout(callback, 0);
  return () => window.clearTimeout(handle);
}

/**
 * Priority/FIFO queue used by release-deferred consumers. Exactly one `warm`
 * promise owns the renderer at a time. Lower priorities run first and ties
 * preserve subscription order, matching the decorative stagger queue.
 * `schedule` starts a job when the queue was idle; `scheduleContinuation`
 * starts the next job when the previous one finished (defaults to
 * `schedule`).
 */
export function createDeferredWarmQueue(
  schedule: DeferredWarmQueueSchedule = browserWarmQueueSchedule,
  scheduleContinuation: DeferredWarmQueueSchedule = schedule ===
  browserWarmQueueSchedule
    ? browserWarmContinuationSchedule
    : schedule,
) {
  const queue: QueueEntry[] = [];
  let sequence = 0;
  let activeEntry: QueueEntry | undefined;
  let cancelScheduled: (() => void) | undefined;

  const emit = (entry: QueueEntry, state: DeferredWarmState) => {
    try {
      entry.job.onStateChange?.(state);
    } catch (error) {
      console.warn('[DeferredWarm] state listener threw:', error);
    }
  };

  const takeNext = (): QueueEntry | undefined => {
    let best = -1;
    for (let i = 0; i < queue.length; i += 1) {
      const candidate = queue[i]!;
      if (!candidate.active) continue;
      if (best === -1) {
        best = i;
        continue;
      }
      const current = queue[best]!;
      if (
        candidate.priority < current.priority ||
        (candidate.priority === current.priority &&
          candidate.sequence < current.sequence)
      ) {
        best = i;
      }
    }
    if (best === -1) {
      queue.length = 0;
      return undefined;
    }
    return queue.splice(best, 1)[0];
  };

  const scheduleNext = (afterJob = false) => {
    if (activeEntry || cancelScheduled || queue.length === 0) return;
    cancelScheduled = (afterJob ? scheduleContinuation : schedule)(() => {
      cancelScheduled = undefined;
      const entry = takeNext();
      if (!entry) return;
      activeEntry = entry;
      emit(entry, 'warming');

      const isCancelled: DeferredWarmCancelCheck = Object.assign(
        () => !entry.active,
        { signal: entry.abort.signal },
      );
      void entry.job
        .warm(isCancelled)
        .catch((error: unknown) => {
          try {
            entry.job.onError?.(error);
          } catch (listenerError) {
            console.warn('[DeferredWarm] error listener threw:', listenerError);
          }
        })
        .finally(() => {
          if (entry.active) emit(entry, 'ready');
          activeEntry = undefined;
          scheduleNext(true);
        });
    });
  };

  const enqueue = (job: DeferredWarmJob): (() => void) => {
    const entry: QueueEntry = {
      active: true,
      abort: new AbortController(),
      job,
      priority: job.priority ?? 0,
      sequence: sequence++,
    };
    queue.push(entry);
    emit(entry, 'queued');
    scheduleNext();

    return () => {
      if (!entry.active) return;
      entry.active = false;
      entry.abort.abort();
      emit(entry, 'cancelled');
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (!activeEntry && queue.length === 0 && cancelScheduled) {
        cancelScheduled();
        cancelScheduled = undefined;
      }
    };
  };

  return { enqueue };
}

const globalDeferredWarmQueue = createDeferredWarmQueue();

export function enqueueDeferredWarm(job: DeferredWarmJob): () => void {
  return globalDeferredWarmQueue.enqueue(job);
}

export type DeferredWarmRenderer = {
  initialized?: boolean;
  init?: () => Promise<unknown>;
  initTexture?: (texture: THREE.Texture) => void;
  compileAsync?: (
    object: THREE.Object3D,
    camera: THREE.Camera,
    targetScene?: THREE.Scene,
  ) => Promise<unknown>;
  render: (scene: THREE.Object3D, camera: THREE.Camera) => void;
  getScissor?: (target: THREE.Vector4) => THREE.Vector4;
  getScissorTest?: () => boolean;
  setScissor?: (x: number, y: number, width: number, height: number) => void;
  setScissorTest?: (enabled: boolean) => void;
};

type WarmObjectOptions = {
  renderer: DeferredWarmRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  object: THREE.Object3D;
  isCancelled: DeferredWarmCancelCheck;
  label?: string;
};

const uploadedTexturesByRenderer = new WeakMap<object, WeakSet<THREE.Texture>>();

// ---------------------------------------------------------------------------
// Texture claim scheduler (slice D §4c [F12][R2-F9][R3-F2]) — renderer-keyed
// in-flight ownership so the WorldWarmup scanners and DWA warm jobs can never
// upload the same texture concurrently against an in-flight compile. Claims
// are taken at EXECUTION time only (never at enqueue — a claim held by a
// queued job in the single-active warm queue would deadlock a higher-priority
// job awaiting an owner that can never run). The `uploaded` WeakSet above
// stays the DONE record; claims are the IN-FLIGHT record.
// ---------------------------------------------------------------------------

type TextureClaimEntry = {
  token: symbol;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
};

const textureClaimsByRenderer = new WeakMap<
  object,
  Map<THREE.Texture, TextureClaimEntry>
>();

export type TextureClaimResult =
  | { owned: true; token: symbol; complete: () => void; fail: (err?: unknown) => void }
  | { owned: false; ownerPromise: Promise<void> };

export function tryClaimTexture(
  renderer: object,
  texture: THREE.Texture,
  ownToken?: symbol,
): TextureClaimResult {
  let claims = textureClaimsByRenderer.get(renderer);
  if (!claims) {
    claims = new Map();
    textureClaimsByRenderer.set(renderer, claims);
  }
  const existing = claims.get(texture);
  if (existing) {
    // Token guards self-reentrancy: an owner re-checking its own claim is
    // recognized, never self-awaited [R3-F2].
    if (ownToken !== undefined && existing.token === ownToken) {
      return makeOwnedResult(claims, texture, existing);
    }
    return { owned: false, ownerPromise: existing.promise };
  }
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Waiters observing a rejected owner RETRY their own claim; an unhandled-
  // rejection trap on the raw promise is prevented here (retriers attach
  // their own handlers).
  promise.catch(() => {});
  const entry: TextureClaimEntry = { token: Symbol('tex-claim'), promise, resolve, reject };
  claims.set(texture, entry);
  return makeOwnedResult(claims, texture, entry);
}

function makeOwnedResult(
  claims: Map<THREE.Texture, TextureClaimEntry>,
  texture: THREE.Texture,
  entry: TextureClaimEntry,
): TextureClaimResult {
  return {
    owned: true,
    token: entry.token,
    complete: () => {
      if (claims.get(texture) === entry) claims.delete(texture);
      entry.resolve();
    },
    fail: (err?: unknown) => {
      if (claims.get(texture) === entry) claims.delete(texture);
      entry.reject(err ?? new Error('texture claim failed'));
    },
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function collectDeferredObjectTextures(
  object: THREE.Object3D,
): THREE.Texture[] {
  const textures = new Set<THREE.Texture>();
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      const slots = material as THREE.Material &
        Partial<Record<(typeof TEXTURE_SLOTS)[number], THREE.Texture>>;
      for (const slot of TEXTURE_SLOTS) {
        const texture = slots[slot];
        if (texture?.isTexture) textures.add(texture);
      }
    }
  });
  return [...textures];
}

/**
 * GPU-upload textures in WorldWarmup-equivalent gentle slices: 6 ms / four
 * textures for timed-out idle callbacks, deadline-aware real idle windows,
 * at least one upload per slice, and a four-texture rAF fallback.
 */
export async function uploadDeferredObjectTextures({
  renderer,
  object,
  isCancelled,
  label = 'object',
}: Pick<WarmObjectOptions, 'renderer' | 'object' | 'isCancelled' | 'label'>): Promise<boolean> {
  if (typeof renderer.initTexture !== 'function') {
    console.warn(
      `[DeferredWarm] ${label}: renderer.initTexture() unavailable; compile/direct warm will fall through`,
    );
    return false;
  }

  let uploaded = uploadedTexturesByRenderer.get(renderer as object);
  if (!uploaded) {
    uploaded = new WeakSet<THREE.Texture>();
    uploadedTexturesByRenderer.set(renderer as object, uploaded);
  }
  const textures = collectDeferredObjectTextures(object).filter(
    (texture) => !uploaded!.has(texture),
  );
  if (textures.length === 0 || isCancelled()) return true;
  let uploadFailures = 0;

  // Textures owned by another in-flight uploader (WorldWarmup scanner or a
  // concurrent warm) are awaited AFTER the main slice loop [R3-F2].
  const ownerWaits: Array<{ texture: THREE.Texture; promise: Promise<void> }> = [];

  await new Promise<void>((resolve) => {
    let index = 0;

    const uploadOne = (texture: THREE.Texture) => {
      if (uploaded!.has(texture)) return;
      const claim = tryClaimTexture(renderer as object, texture);
      if (!claim.owned) {
        ownerWaits.push({ texture, promise: claim.ownerPromise });
        return;
      }
      try {
        renderer.initTexture!(texture);
        uploaded!.add(texture);
        claim.complete();
      } catch (error) {
        claim.fail(error);
        uploadFailures += 1;
        console.warn(`[DeferredWarm] ${label}: initTexture failed:`, error);
      }
    };

    const uploadIdle = (deadline: IdleDeadline) => {
      if (isCancelled()) {
        resolve();
        return;
      }
      const startedAt = now();
      const before = index;
      const useDeadline = !deadline.didTimeout && deadline.timeRemaining() > 0;
      while (index < textures.length) {
        if (index > before) {
          if (useDeadline) {
            if (deadline.timeRemaining() < 2) break;
          } else if (
            index - before >= DEFERRED_WARM_IDLE_MAX_TEXTURES_PER_SLICE ||
            now() - startedAt >= DEFERRED_WARM_IDLE_SLICE_BUDGET_MS
          ) {
            break;
          }
        }
        uploadOne(textures[index]!);
        index += 1;
      }
      if (index < textures.length) {
        window.requestIdleCallback(uploadIdle, { timeout: 200 });
      } else {
        resolve();
      }
    };

    const uploadRaf = () => {
      if (isCancelled()) {
        resolve();
        return;
      }
      const end = Math.min(
        index + DEFERRED_WARM_RAF_FALLBACK_BATCH,
        textures.length,
      );
      for (; index < end; index += 1) uploadOne(textures[index]!);
      if (index < textures.length) requestAnimationFrame(uploadRaf);
      else resolve();
    };

    if (
      typeof window !== 'undefined' &&
      typeof window.requestIdleCallback === 'function'
    ) {
      window.requestIdleCallback(uploadIdle, { timeout: 200 });
    } else if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(uploadRaf);
    } else {
      while (index < textures.length && !isCancelled()) {
        uploadOne(textures[index]!);
        index += 1;
      }
      resolve();
    }
  });

  // Await other owners' in-flight uploads; a REJECTED owner (failed/
  // cancelled claim) gets ONE retry claim from us [R3-F2].
  if (ownerWaits.length > 0 && !isCancelled()) {
    const results = await Promise.allSettled(ownerWaits.map((w) => w.promise));
    for (let i = 0; i < results.length; i += 1) {
      if (isCancelled()) break;
      const { texture } = ownerWaits[i]!;
      if (results[i]!.status === 'fulfilled' || uploaded.has(texture)) continue;
      // Retry rejected owners (bounded) until we own-and-upload or a live
      // owner fulfills [I2-F3] — a rejected third-party reclaim must never
      // be silently accepted as coverage.
      let covered = false;
      let attempts = 0;
      while (!covered && !isCancelled() && attempts < 6) {
        const retry = tryClaimTexture(renderer as object, texture);
        if (retry.owned) {
          try {
            renderer.initTexture!(texture);
            uploaded.add(texture);
            retry.complete();
            covered = true;
          } catch (error) {
            retry.fail(error);
            attempts += 1;
            console.warn(`[DeferredWarm] ${label}: retry initTexture failed:`, error);
          }
        } else {
          try {
            await retry.ownerPromise;
            covered = true;
          } catch {
            attempts += 1;
          }
        }
      }
      if (!covered) uploadFailures += 1;
    }
  }
  return uploadFailures === 0;
}

export async function withDeferredFrustumCullingDisabled<T>(
  object: THREE.Object3D,
  task: () => Promise<T> | T,
): Promise<T> {
  const changed: THREE.Object3D[] = [];
  object.traverse((child) => {
    if (!child.frustumCulled) return;
    child.frustumCulled = false;
    changed.push(child);
  });
  try {
    return await task();
  } finally {
    for (const child of changed) child.frustumCulled = true;
  }
}

type CompileResult =
  | { status: 'completed' }
  | { status: 'rejected'; error: unknown }
  | { status: 'timed-out' };

async function settleCompile(
  promise: Promise<unknown>,
): Promise<CompileResult> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const result = await Promise.race<CompileResult>([
    promise.then(
      (): CompileResult => ({ status: 'completed' }),
      (error: unknown): CompileResult => ({ status: 'rejected', error }),
    ),
    new Promise<CompileResult>((resolve) => {
      timeout = globalThis.setTimeout(
        () => resolve({ status: 'timed-out' }),
        DEFERRED_WARM_COMPILE_TIMEOUT_MS,
      );
    }),
  ]);
  if (timeout !== undefined) globalThis.clearTimeout(timeout);
  return result;
}

type CompileFrontHolder = {
  live: boolean;
  started: boolean;
  renderer: DeferredWarmRenderer | null;
  object: THREE.Object3D | null;
  camera: THREE.Camera | null;
  scene: THREE.Scene | null;
  isCancelled: (() => boolean) | null;
};

/** Drops the holder's references; a not-yet-run front then does nothing.
 * Harmless after the front ran (the compile already has its arguments). */
function releaseCompileFront(front: CompileFrontHolder): void {
  front.live = false;
  front.renderer = null;
  front.object = null;
  front.camera = null;
  front.scene = null;
  front.isCancelled = null;
}

/** Posts the compile front. Module-level on purpose: the posted closure
 * captures only `front`, not the caller's scope (V8 shares one context per
 * scope, so a closure built inside compileDeferredObject could keep the
 * object and renderer alive while the task waits). */
function postCompileFront(front: CompileFrontHolder): Promise<unknown> {
  return runInUserVisibleTask(() => runCompileFront(front));
}

function runCompileFront(front: CompileFrontHolder): unknown {
  const { renderer, object, camera, scene, isCancelled } = front;
  if (
    !front.live ||
    !renderer ||
    !object ||
    !camera ||
    !scene ||
    !isCancelled ||
    isCancelled()
  ) {
    return undefined;
  }
  front.started = true;
  object.updateWorldMatrix(true, true);
  const wasVisible = object.visible;
  object.visible = true;
  try {
    return renderer.compileAsync!(object, camera, scene);
  } finally {
    object.visible = wasVisible;
  }
}

async function compileDeferredObject({
  renderer,
  object,
  camera,
  scene,
  isCancelled,
  label,
}: WarmObjectOptions): Promise<boolean> {
  if (
    isCancelled() ||
    typeof renderer.compileAsync !== 'function' ||
    isRendererCompileTimedOut(renderer)
  ) {
    return false;
  }

  // r185 runs object traversal synchronously before its first cooperative
  // pipeline-build yield once initialized. Keep the hidden root renderable for
  // that synchronous capture only, then hide it again while compilation waits.
  if (renderer.initialized === false && typeof renderer.init === 'function') {
    await renderer.init();
  }
  if (isCancelled()) return false;

  // [T6] The compile front runs at the START of a fresh user-visible task,
  // never inside the idle-callback continuation that reached this point (see
  // runInUserVisibleTask). The queued task reads ONLY `front` (a per-job
  // holder). A job cancel (the queue's `isCancelled.signal`) or the 20 s
  // escape before the task ran sets `front.live = false` and drops its
  // object/renderer references, so a late task neither compiles (the FIFO
  // has released by then; a second same-renderer compile would overlap, the
  // r185 race class) nor holds anything heavy while it waits. Once the
  // compile has STARTED nothing aborts it: a cancel lets it finish, then the
  // job ends without the recovery render, as before T6.
  const front: CompileFrontHolder = {
    live: true,
    started: false,
    renderer,
    object,
    camera,
    scene,
    isCancelled,
  };
  const releaseFront = () => releaseCompileFront(front);
  const jobSignal = isCancelled.signal;
  jobSignal?.addEventListener('abort', releaseFront, { once: true });
  let result: CompileResult;
  try {
    result = await withDeferredFrustumCullingDisabled(object, () =>
      settleCompile(postCompileFront(front)),
    );
  } finally {
    jobSignal?.removeEventListener('abort', releaseFront);
    releaseCompileFront(front);
  }
  const started = front.started;

  if (!started) {
    // No compile ran on this renderer, so it is NOT poisoned: only this job
    // gives up its compile (fail-open), the next job compiles normally.
    if (result.status === 'timed-out') {
      console.warn(
        `[DeferredWarm] ${label ?? 'object'}: compile task did not start within 20s; skipping compile for this object only`,
      );
    }
    return false;
  }
  if (result.status === 'rejected') {
    console.warn(
      `[DeferredWarm] ${label ?? 'object'}: compileAsync failed; continuing to direct warm:`,
      result.error,
    );
    return false;
  }
  if (result.status === 'timed-out') {
    // compileAsync cannot be cancelled. Never start a second compile on this
    // renderer after a timeout; jobs still fail open through direct warm/attach.
    // The direct warm then renders on this renderer while the orphan compile
    // may still run: that is the normal state, the main frame loop renders on
    // the same renderer during every compileAsync.
    // Shared registry [impl-B1]: the boot whitelist sweep and stage warms
    // honor this too, so the FIFO release below cannot enable a
    // same-renderer overlap with the orphan tail.
    markRendererCompileTimedOut(renderer);
    console.warn(
      `[DeferredWarm] ${label ?? 'object'}: compileAsync exceeded 20s; bypassing it for this renderer`,
    );
    return false;
  }
  return true;
}

async function directWarmWithoutPresent({
  renderer,
  object,
  camera,
  scene,
  isCancelled,
  label,
}: WarmObjectOptions): Promise<void> {
  if (isCancelled()) return;
  if (
    typeof renderer.getScissor !== 'function' ||
    typeof renderer.getScissorTest !== 'function' ||
    typeof renderer.setScissor !== 'function' ||
    typeof renderer.setScissorTest !== 'function'
  ) {
    // Both installed r185 backends expose this surface. If a future renderer
    // does not, skip rather than flash the hidden object into the canvas.
    console.warn(
      `[DeferredWarm] ${label ?? 'object'}: renderer scissor controls unavailable; skipping direct warm`,
    );
    return;
  }

  const priorScissor = renderer.getScissor(new THREE.Vector4());
  const priorScissorTest = renderer.getScissorTest();
  try {
    // A zero-area scissor submits the real scene/object draw path (geometry,
    // bind groups, pipeline) without presenting the not-yet-attached object.
    renderer.setScissor(0, 0, 0, 0);
    renderer.setScissorTest(true);
    await withDeferredFrustumCullingDisabled(object, () => {
      const wasVisible = object.visible;
      object.visible = true;
      try {
        renderer.render(scene, camera);
      } finally {
        object.visible = wasVisible;
      }
    });
  } catch (error) {
    console.warn(
      `[DeferredWarm] ${label ?? 'object'}: direct warm failed; continuing:`,
      error,
    );
  } finally {
    renderer.setScissor(
      priorScissor.x,
      priorScissor.y,
      priorScissor.z,
      priorScissor.w,
    );
    renderer.setScissorTest(priorScissorTest);
  }
}

/**
 * Upload -> compile -> (fallback-only) zero-scissor direct warm. Every step
 * is fail-open.
 *
 * The direct warm runs ONLY when compileAsync did not complete (unavailable /
 * rejected / timed out). Unlike the stage-slot warms, these jobs execute
 * while R3F is presenting live frames — an extra renderer.render() on the
 * WebGPU backend re-acquires the SAME swapchain texture within the vsync
 * interval and its full-attachment clear IGNORES the scissor, which is the
 * exact mechanism of the historical one-frame blue-flash clobber
 * (feedback_webgpu_blue_screen_double_render_and_first_paint). After a
 * successful compileAsync the pipelines are built and the direct warm adds
 * nothing worth that risk.
 */
export type DeferredWarmResultKind = 'warmed' | 'failopen';

export async function warmDeferredObject(
  options: WarmObjectOptions,
): Promise<DeferredWarmResultKind> {
  let uploadClean = false;
  try {
    uploadClean = await uploadDeferredObjectTextures(options);
  } catch (error) {
    console.warn(
      `[DeferredWarm] ${options.label ?? 'object'}: texture upload failed; continuing:`,
      error,
    );
  }
  if (options.isCancelled()) return 'failopen';
  let compiled = false;
  try {
    // [R2-1 → BGR R2-NF1] the compile front JOINS the renderer-wide
    // boot-compile FIFO instead of snapshotting its idleness: an idle-await
    // observes only work ALREADY chained, so a deferred compile starting
    // while a successor generation had not yet chained its boot compile
    // could still overlap it (the exact r185 race slice E proved unsafe).
    // Chained, any two compiles are totally ordered no matter which
    // generation chains first — a recovery boot compile chained after a
    // building rewarm simply waits behind it (latency, never corruption).
    // compileDeferredObject self-bounds at 20s (a timeout POISONS the
    // renderer via the shared registry before the chain releases), so the
    // chain cannot wedge AND a release never enables same-renderer overlap.
    // [impl-B1] the direct-warm fallback runs INSIDE the chained task: a
    // rejected compileAsync leaves renderer front state unrestored, and the
    // healing render must complete before any queued successor's compile
    // front runs — not after the chain has already moved on.
    compiled = await chainBootCompile(async () => {
      const ok = await compileDeferredObject(options);
      if (!ok && !options.isCancelled()) {
        await directWarmWithoutPresent(options);
      }
      return ok;
    });
  } catch (error) {
    console.warn(
      `[DeferredWarm] ${options.label ?? 'object'}: compileAsync threw; continuing:`,
      error,
    );
  }
  // 'warmed' = the full success path (clean uploads + completed compile) —
  // anything else is fail-open: content still shows, may hitch once, and
  // measurement runs reject it (spec §3 [R2-F11]).
  return compiled && uploadClean ? 'warmed' : 'failopen';
}
