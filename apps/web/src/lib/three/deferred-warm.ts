import * as THREE from 'three/webgpu';

// Keep this gentle path aligned with WorldWarmup's proven post-ready uploader.
// WorldWarmup itself stays untouched: its 2026-07-14 loader/commit ordering is a
// structural reveal gate, while these jobs begin only after decorative release.
export const DEFERRED_WARM_IDLE_SLICE_BUDGET_MS = 6;
export const DEFERRED_WARM_IDLE_MAX_TEXTURES_PER_SLICE = 4;
export const DEFERRED_WARM_RAF_FALLBACK_BATCH = 4;
export const DEFERRED_WARM_COMPILE_TIMEOUT_MS = 20_000;

const TEXTURE_SLOTS = [
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

export type DeferredWarmJob = {
  priority?: number;
  warm: (isCancelled: () => boolean) => Promise<void>;
  onStateChange?: (state: DeferredWarmState) => void;
  onError?: (error: unknown) => void;
};

export type DeferredWarmQueueSchedule = (callback: () => void) => () => void;

type QueueEntry = {
  active: boolean;
  job: DeferredWarmJob;
  priority: number;
  sequence: number;
};

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
 * Priority/FIFO queue used by release-deferred consumers. Exactly one `warm`
 * promise owns the renderer at a time. Lower priorities run first and ties
 * preserve subscription order, matching the decorative stagger queue.
 */
export function createDeferredWarmQueue(
  schedule: DeferredWarmQueueSchedule = browserWarmQueueSchedule,
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

  const scheduleNext = () => {
    if (activeEntry || cancelScheduled || queue.length === 0) return;
    cancelScheduled = schedule(() => {
      cancelScheduled = undefined;
      const entry = takeNext();
      if (!entry) return;
      activeEntry = entry;
      emit(entry, 'warming');

      void entry.job
        .warm(() => !entry.active)
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
          scheduleNext();
        });
    });
  };

  const enqueue = (job: DeferredWarmJob): (() => void) => {
    const entry: QueueEntry = {
      active: true,
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
  isCancelled: () => boolean;
  label?: string;
};

const uploadedTexturesByRenderer = new WeakMap<object, WeakSet<THREE.Texture>>();
const compileTimedOutRenderers = new WeakSet<object>();

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
}: Pick<WarmObjectOptions, 'renderer' | 'object' | 'isCancelled' | 'label'>): Promise<void> {
  if (typeof renderer.initTexture !== 'function') {
    console.warn(
      `[DeferredWarm] ${label}: renderer.initTexture() unavailable; compile/direct warm will fall through`,
    );
    return;
  }

  let uploaded = uploadedTexturesByRenderer.get(renderer as object);
  if (!uploaded) {
    uploaded = new WeakSet<THREE.Texture>();
    uploadedTexturesByRenderer.set(renderer as object, uploaded);
  }
  const textures = collectDeferredObjectTextures(object).filter(
    (texture) => !uploaded!.has(texture),
  );
  if (textures.length === 0 || isCancelled()) return;

  await new Promise<void>((resolve) => {
    let index = 0;

    const uploadOne = (texture: THREE.Texture) => {
      try {
        renderer.initTexture!(texture);
        uploaded!.add(texture);
      } catch (error) {
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
    compileTimedOutRenderers.has(renderer as object)
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
  object.updateWorldMatrix(true, true);

  const result = await withDeferredFrustumCullingDisabled(object, async () => {
    const wasVisible = object.visible;
    let compilePromise: Promise<unknown>;
    object.visible = true;
    try {
      compilePromise = Promise.resolve(
        renderer.compileAsync!(object, camera, scene),
      );
    } finally {
      object.visible = wasVisible;
    }
    return settleCompile(compilePromise);
  });

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
    compileTimedOutRenderers.add(renderer as object);
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
export async function warmDeferredObject(
  options: WarmObjectOptions,
): Promise<void> {
  try {
    await uploadDeferredObjectTextures(options);
  } catch (error) {
    console.warn(
      `[DeferredWarm] ${options.label ?? 'object'}: texture upload failed; continuing:`,
      error,
    );
  }
  if (options.isCancelled()) return;
  let compiled = false;
  try {
    compiled = await compileDeferredObject(options);
  } catch (error) {
    console.warn(
      `[DeferredWarm] ${options.label ?? 'object'}: compileAsync threw; continuing to direct warm:`,
      error,
    );
  }
  if (options.isCancelled() || compiled) return;
  await directWarmWithoutPresent(options);
}
