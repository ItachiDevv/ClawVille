'use client';

import {
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react';
import {
  Canvas,
  _roots,
  events as createPointerEvents,
  extend,
  useFrame,
  useThree,
  type RootState,
  type ThreeToJSXElements,
} from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { detectLowEndGpuClass } from '@/lib/three/gpu-tier';
import { stampColdLoadPhaseOnce } from '@/lib/three/cold-load-stamp';
import { resetAllHeldInputs } from '@/lib/three/input-reset';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';
import {
  resolvePlayerCapabilities,
  type PlayerCapabilityMask,
} from '@/lib/three/player/player-capability-mask';
import { StageTransition } from './StageTransition';
import type { WatchdogConfig } from './stage-watchdog-machine';
import {
  StageCameraCoordinator,
  type StageCameraDefinition,
} from './stage-camera';
import { useStageStore } from './stage-store';
import {
  requestStageDeltaClamp,
  SceneCameraProvider,
  SceneIdProvider,
  SlotCapabilityProvider,
  StageFrameScheduler,
} from './use-scene-frame';
import {
  registerStageSlotRoot,
} from './resource-ledger';
import {
  reportStageRendererRecoveryFailure,
  runStageRendererInitialization,
} from './stage-renderer-status';

declare module '@react-three/fiber' {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

extend(THREE as any);

const LOW_END_GPU = detectLowEndGpuClass();
// EXACT parity with the live World3DCanvas constants (LOW_END_DPR_RANGE /
// STANDARD_DPR_RANGE at World3DCanvas.tsx:140-141). The P1a brief carried a
// stale doc value ([0.5, 0.65]); live code wins — /game must not change
// resolution on migration.
const DPR_RANGE: [number, number] = LOW_END_GPU
  ? [0.55, 0.7]
  : [0.75, 1];
const USE_MESHLET_BUILDINGS =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('meshlets') === '1';
const USE_REVERSED_DEPTH_BUFFER = !USE_MESHLET_BUILDINGS;
const IOS_SAFARI =
  typeof navigator !== 'undefined' &&
  /iP(hone|ad|od)/i.test(navigator.userAgent) &&
  /WebKit/i.test(navigator.userAgent) &&
  !/CriOS|FxiOS|OPiOS|mercury/i.test(navigator.userAgent);
const WEBGPU_ABSENT =
  typeof navigator !== 'undefined' && !('gpu' in navigator);
const WEBGPU_UNHEALTHY_KEY = 'world-stage-webgpu-unhealthy';
const LEGACY_KELP_WEBGPU_UNHEALTHY_KEY =
  'kelp-realm-webgpu-unhealthy';

function belongsToActiveStageSlot(
  object: THREE.Object3D,
  activeScene: string | null,
): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.name.startsWith('world-stage:')) {
      return current.name === `world-stage:${activeScene ?? ''}`;
    }
    current = current.parent;
  }
  return true;
}

function createStagePointerEvents(
  store: Parameters<typeof createPointerEvents>[0],
) {
  const manager = createPointerEvents(store);
  const defaultFilter = manager.filter;
  manager.filter = (items, state) => {
    const ordered = defaultFilter
      ? defaultFilter(items, state)
      : items;
    const activeScene = useStageStore.getState().activeScene;
    return ordered.filter((intersection) =>
      belongsToActiveStageSlot(intersection.object, activeScene),
    );
  };
  return manager;
}
function readWebGpuUnhealthyFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return (
      window.sessionStorage.getItem(WEBGPU_UNHEALTHY_KEY) === '1' ||
      window.sessionStorage.getItem(
        LEGACY_KELP_WEBGPU_UNHEALTHY_KEY,
      ) === '1'
    );
  } catch {
    return false;
  }
}
const FORCE_WEBGPU =
  typeof window !== 'undefined' &&
  (new URLSearchParams(window.location.search).get('webgpu') === '1' ||
    USE_MESHLET_BUILDINGS);
const FORCE_WEBGL =
  IOS_SAFARI ||
  WEBGPU_ABSENT ||
  readWebGpuUnhealthyFlag() ||
  (!FORCE_WEBGPU && LOW_END_GPU) ||
  (typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('webgl') === '1');

function getCanvasCssSize(
  canvas: HTMLCanvasElement,
): readonly [number, number] | null {
  const rect = canvas.getBoundingClientRect();
  let width = Math.round(rect.width);
  let height = Math.round(rect.height);
  if ((width <= 0 || height <= 0) && canvas.parentElement) {
    const parentRect = canvas.parentElement.getBoundingClientRect();
    width = Math.round(parentRect.width);
    height = Math.round(parentRect.height);
  }
  if ((width <= 0 || height <= 0) && typeof window !== 'undefined') {
    width = window.innerWidth;
    height = window.innerHeight;
  }
  return width > 0 && height > 0 ? [width, height] : null;
}

async function waitForCanvasSize(
  canvas: HTMLCanvasElement,
): Promise<readonly [number, number]> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const size = getCanvasCssSize(canvas);
    if (
      size &&
      (size[0] !== 300 || size[1] !== 150) &&
      size[0] >= 2 &&
      size[1] >= 2
    ) {
      return size;
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  return (
    getCanvasCssSize(canvas) ?? [
      Math.max(2, window.innerWidth),
      Math.max(2, window.innerHeight),
    ]
  );
}

function withInitTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      settled = true;
      promise.catch(() => undefined);
      reject(new Error(`renderer init did not complete within ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Never-throw cold-load ACTUAL-backend stamp — same contract as World3DCanvas's
 *  stampColdLoadBackend (duplicated locally to avoid a stage→legacy import).
 *  The stage renderer IS the /game renderer under WorldStageRoot, so the
 *  probe's actual-backend evidence must be published HERE: the legacy
 *  createWebGPURenderer stamp never runs on stage-hosted routes, which left
 *  __W3D_BACKEND stuck on the module-eval '-requested' value (probe run
 *  invalid: "backend not actual"). Reads the renderer's REAL backend, not the
 *  forceWebGL flag — Three's init can fall back WebGPU→WebGL2 silently. */
function stampStageColdLoadBackend(renderer: THREE.WebGPURenderer): void {
  if (typeof window === 'undefined') return;
  try {
    (window as unknown as { __W3D_BACKEND?: string }).__W3D_BACKEND = (
      renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }
    ).backend?.isWebGPUBackend
      ? 'webgpu'
      : 'webgl2';
  } catch {
    /* telemetry never throws */
  }
}

async function initializeStageRenderer(
  canvas: HTMLCanvasElement,
  forceWebGL: boolean,
  width: number,
  height: number,
  dpr: number,
): Promise<THREE.WebGPURenderer> {
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,
    alpha: false,
    forceWebGL,
    reversedDepthBuffer: USE_REVERSED_DEPTH_BUFFER,
  });
  renderer.setPixelRatio(dpr);
  try {
    await withInitTimeout(renderer.init(), 8_000);
  } catch (error) {
    renderer.dispose();
    throw error;
  }
  // Single choke point: initial boot AND both recovery paths re-stamp here,
  // so a recovery that lands on the other backend keeps the probe truthful.
  stampStageColdLoadBackend(renderer);
  renderer.setClearColor(0x07131d, 1);
  renderer.setClearAlpha?.(1);
  renderer.setSize(width, height, false);
  return renderer;
}

type RendererBinding = {
  install: (renderer: THREE.WebGPURenderer) => void;
  resync: () => void;
};

type DeviceWithEvents = GPUDevice & {
  addEventListener: (
    type: 'uncapturederror',
    listener: EventListener,
  ) => void;
  removeEventListener: (
    type: 'uncapturederror',
    listener: EventListener,
  ) => void;
};

class StageRendererHealth {
  private renderer: THREE.WebGPURenderer | null = null;
  private binding: RendererBinding | null = null;
  private forceWebGL = false;
  private recovering = false;
  private recreatedOnce = false;
  private generation = 0;
  private device: DeviceWithEvents | null = null;
  private uncapturedErrors = 0;
  private pendingRecoveryReason: string | null = null;
  private readonly onUncapturedError = (event: Event): void => {
    this.uncapturedErrors += 1;
    if (this.uncapturedErrors < 8) return;
    const detail = (event as { error?: { message?: string } }).error
      ?.message;
    this.requestRecovery(
      `webgpu-uncaptured-error:${detail?.slice(0, 160) ?? 'unknown'}`,
    );
  };

  constructor(private canvas: HTMLCanvasElement) {}

  adoptVisibleCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  setInitial(
    renderer: THREE.WebGPURenderer,
    forceWebGL: boolean,
  ): void {
    this.renderer = renderer;
    this.forceWebGL = forceWebGL;
    this.watchRenderer(renderer);
  }

  attach(binding: RendererBinding): () => void {
    this.binding = binding;
    if (this.renderer) this.watchRenderer(this.renderer);
    const pendingReason = this.pendingRecoveryReason;
    this.pendingRecoveryReason = null;
    if (pendingReason) {
      queueMicrotask(() => {
        if (this.binding === binding) {
          this.requestRecovery(pendingReason);
        }
      });
    }
    return () => {
      if (this.binding === binding) {
        this.binding = null;
        this.unwatchRenderer();
        this.generation += 1;
      }
    };
  }

  requestRecovery(reason: string): void {
    if (!this.binding || this.recovering) {
      this.pendingRecoveryReason = reason;
      return;
    }
    void this.recover(reason);
  }

  private watchRenderer(renderer: THREE.WebGPURenderer): void {
    this.unwatchRenderer();
    if (this.forceWebGL) return;
    const device = (
      renderer as unknown as { backend?: { device?: DeviceWithEvents } }
    ).backend?.device;
    if (!device?.addEventListener) return;
    this.device = device;
    this.uncapturedErrors = 0;
    device.addEventListener(
      'uncapturederror',
      this.onUncapturedError,
    );
    useStageStore.getState().adjustWindowListenerCount(1);
    const generation = this.generation;
    void device.lost.then((info) => {
      if (
        generation !== this.generation ||
        info.reason === 'destroyed'
      ) {
        return;
      }
      this.requestRecovery(
        `webgpu-device-lost:${info.reason}:${info.message}`.slice(
          0,
          240,
        ),
      );
    });
  }

  private unwatchRenderer(): void {
    if (!this.device) return;
    this.device.removeEventListener(
      'uncapturederror',
      this.onUncapturedError,
    );
    this.device = null;
    useStageStore.getState().adjustWindowListenerCount(-1);
  }

  private async recover(reason: string): Promise<void> {
    if (this.recovering || !this.renderer || !this.binding) return;
    const route = window.location.pathname;
    const binding = this.binding;
    this.recovering = true;
    const generation = ++this.generation;
    const isCurrent = (): boolean =>
      this.generation === generation &&
      this.binding === binding &&
      this.canvas.isConnected;
    try {
      useStageStore.getState().noteRecovery(reason);
      resetAllHeldInputs();
      requestStageDeltaClamp();
      this.unwatchRenderer();

      const current = this.renderer;
      const size = getCanvasCssSize(this.canvas) ?? [
        Math.max(2, window.innerWidth),
        Math.max(2, window.innerHeight),
      ];
      const dpr = Math.max(
        DPR_RANGE[0],
        Math.min(window.devicePixelRatio || 1, DPR_RANGE[1]),
      );
      current.dispose();

      let replacement: THREE.WebGPURenderer | null = null;
      let webGPUError: unknown = null;
      let webGLError: unknown = null;
      if (!this.recreatedOnce) {
        this.recreatedOnce = true;
        try {
          replacement = await initializeStageRenderer(
            this.canvas,
            this.forceWebGL,
            size[0],
            size[1],
            dpr,
          );
        } catch (error) {
          if (this.forceWebGL) webGLError = error;
          else webGPUError = error;
          console.warn(
            '[WorldStage] in-place renderer recreation failed:',
            error,
          );
        }
        if (!isCurrent()) {
          replacement?.dispose();
          return;
        }
      }

      if (!replacement && !this.forceWebGL) {
        this.forceWebGL = true;
        try {
          window.sessionStorage.setItem(
            WEBGPU_UNHEALTHY_KEY,
            '1',
          );
        } catch {
          // Storage can be blocked; in-place force-WebGL still works.
        }
        try {
          replacement = await initializeStageRenderer(
            this.canvas,
            true,
            size[0],
            size[1],
            dpr,
          );
        } catch (error) {
          webGLError = error;
          console.error(
            '[WorldStage] terminal force-WebGL recovery failure:',
            error,
          );
          useStageStore
            .getState()
            .noteRecovery('terminal-force-webgl-recovery-failure');
        }
        if (!isCurrent()) {
          replacement?.dispose();
          return;
        }
      }

      if (!replacement) {
        reportStageRendererRecoveryFailure({
          webGPUError,
          webGLError,
          route,
        });
        return;
      }

      if (replacement) {
        this.renderer = replacement;
        currentStageRenderer = replacement;
        currentStageBackend = this.forceWebGL ? 'webgl' : 'webgpu';
        binding.install(replacement);
        if (!isCurrent()) {
          replacement.dispose();
          return;
        }
        this.watchRenderer(replacement);
        binding.resync();
      }
    } finally {
      this.recovering = false;
      const pendingReason = this.pendingRecoveryReason;
      this.pendingRecoveryReason = null;
      if (pendingReason && this.binding) {
        queueMicrotask(() => this.requestRecovery(pendingReason));
      }
    }
  }
}

const inflightRenderers = new WeakMap<
  HTMLCanvasElement,
  Promise<THREE.WebGPURenderer>
>();
const rendererHealthByCanvas = new WeakMap<
  HTMLCanvasElement,
  StageRendererHealth
>();
let currentStageBackend: 'webgpu' | 'webgl' | 'unknown' = 'unknown';
let currentStageRenderer: THREE.WebGPURenderer | null = null;
let previousStageRenderCalls: number | null = null;
let currentStageDrawCallsFrame: number | null = null;

export function readStageBackend(): 'webgpu' | 'webgl' | 'unknown' {
  return currentStageBackend;
}

export interface StageRendererCounters {
  backend: 'webgpu' | 'webgl' | 'unknown';
  textures: number | null;
  geometries: number | null;
  texturesSizeBytes: number | null;
  memoryTotalBytes: number | null;
  renderCallsLifetime: number | null;
  drawCallsFrame: number | null;
  memoryBreakdown: Record<string, number> | null;
}

export function readStageRendererCounters(): StageRendererCounters {
  const backend = currentStageBackend;
  const info = (
    currentStageRenderer as unknown as {
      info?: {
        memory?: {
          textures?: number;
          geometries?: number;
          texturesSize?: number;
          total?: number;
          [key: string]: unknown;
        };
        render?: {
          calls?: number;
          drawCalls?: number;
        };
      };
    } | null
  )?.info;
  const memory = info?.memory;
  const render = info?.render;
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  if (backend === 'webgpu') {
    return {
      backend,
      textures: numberOrNull(memory?.textures),
      geometries: numberOrNull(memory?.geometries),
      texturesSizeBytes: numberOrNull(memory?.texturesSize),
      memoryTotalBytes: numberOrNull(memory?.total),
      renderCallsLifetime: numberOrNull(render?.calls),
      drawCallsFrame: numberOrNull(render?.drawCalls),
      memoryBreakdown: memory
        ? Object.fromEntries(
            Object.entries(memory).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === 'number' && Number.isFinite(entry[1]),
            ),
          )
        : null,
    };
  }
  if (backend === 'webgl') {
    return {
      backend,
      textures: numberOrNull(memory?.textures),
      geometries: numberOrNull(memory?.geometries),
      texturesSizeBytes: null,
      memoryTotalBytes: null,
      renderCallsLifetime: null,
      drawCallsFrame: currentStageDrawCallsFrame,
      memoryBreakdown: null,
    };
  }
  return {
    backend,
    textures: null,
    geometries: null,
    texturesSizeBytes: null,
    memoryTotalBytes: null,
    renderCallsLifetime: null,
    drawCallsFrame: null,
    memoryBreakdown: null,
  };
}

export function requestStageRendererRecovery(reason: string): boolean {
  const canvas = currentStageRenderer?.domElement;
  const health = canvas
    ? rendererHealthByCanvas.get(canvas)
    : undefined;
  if (!health) return false;
  health.requestRecovery(reason);
  return true;
}

function StageRendererCounterSampler(): null {
  const gl = useThree((state) => state.gl);
  useFrame(() => {
    if (currentStageBackend !== 'webgl') {
      previousStageRenderCalls = null;
      currentStageDrawCallsFrame = null;
      return;
    }
    queueMicrotask(() => {
      const render = (
        gl as unknown as {
          info?: { render?: { calls?: number } };
        }
      ).info?.render;
      const calls = render?.calls;
      if (typeof calls !== 'number' || !Number.isFinite(calls)) {
        previousStageRenderCalls = null;
        currentStageDrawCallsFrame = null;
        return;
      }
      currentStageDrawCallsFrame =
        previousStageRenderCalls === null || calls < previousStageRenderCalls
          ? null
          : calls - previousStageRenderCalls;
      previousStageRenderCalls = calls;
    });
  });
  return null;
}

function createStageRenderer(props: {
  canvas: HTMLCanvasElement;
}): Promise<THREE.WebGPURenderer> {
  const existing = inflightRenderers.get(props.canvas);
  if (existing) return existing;

  const creation = (async () => {
    // Rung-4 slice A head decomposition. "Once" stamps: only the FIRST
    // renderer creation (the cold boot) is evidence — recovery-lane
    // recreations must not overwrite it.
    stampColdLoadPhaseOnce('stageRendererFactoryStartAt', performance.now());
    const route = window.location.pathname;
    const canvas = props.canvas;
    const [width, height] = await waitForCanvasSize(canvas);
    stampColdLoadPhaseOnce('stageCanvasSizeReadyAt', performance.now());
    const dpr = Math.max(
      DPR_RANGE[0],
      Math.min(window.devicePixelRatio || 1, DPR_RANGE[1]),
    );
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    stampColdLoadPhaseOnce('stageRendererInitStartAt', performance.now());
    const { renderer, usedWebGL } = await runStageRendererInitialization({
      route,
      forceWebGL: FORCE_WEBGL,
      initialize: (forceWebGL) =>
        initializeStageRenderer(
          canvas,
          forceWebGL,
          width,
          height,
          dpr,
        ),
      onWebGPUFailure: (error) => {
        console.warn(
          '[WorldStage] WebGPU init failed; retrying force-WebGL on the same canvas:',
          error,
        );
      },
    });
    stampColdLoadPhaseOnce('stageRendererInitEndAt', performance.now());
    currentStageBackend = usedWebGL ? 'webgl' : 'webgpu';
    currentStageRenderer = renderer;
    previousStageRenderCalls = null;
    currentStageDrawCallsFrame = null;
    const health = new StageRendererHealth(canvas);
    health.setInitial(renderer, usedWebGL);
    rendererHealthByCanvas.set(canvas, health);
    return renderer;
  })();

  inflightRenderers.set(props.canvas, creation);
  creation.catch(() => inflightRenderers.delete(props.canvas));
  return creation;
}

export interface WorldStageScene extends StageCameraDefinition {
  content: ReactNode;
  overlayOpaque?: boolean;
  capabilities?: Partial<PlayerCapabilityMask>;
  appearance?: {
    background: THREE.ColorRepresentation;
    fog?: {
      color: THREE.ColorRepresentation;
      near: number;
      far: number;
    };
    shadows?: boolean;
  };
}

let diagnosticCameras:
  | Map<string, THREE.PerspectiveCamera>
  | null = null;

export function readStageCameraPoses(): Record<string, number[]> {
  const poses: Record<string, number[]> = {};
  if (!diagnosticCameras) return poses;
  for (const [sceneId, camera] of diagnosticCameras) {
    poses[sceneId] = [
      camera.position.x,
      camera.position.y,
      camera.position.z,
      camera.quaternion.x,
      camera.quaternion.y,
      camera.quaternion.z,
      camera.quaternion.w,
    ];
  }
  return poses;
}

interface WorldStageCanvasProps {
  scenes: readonly WorldStageScene[];
  transitionTimeoutMs?: number;
  watchdogConfig?: WatchdogConfig;
  pauseOnCreate?: boolean;
  onStageCreated?: (state: RootState) => void;
  renderTransitionOverlay?: boolean;
  onTransitionOpaque?: (request: import('./stage-store').StageRequest) => void;
}

function createPersistentCameras(
  scenes: readonly WorldStageScene[],
): Map<string, THREE.PerspectiveCamera> {
  const cameras = new Map<string, THREE.PerspectiveCamera>();
  for (const scene of scenes) {
    const { camera: config } = scene;
    const camera = new THREE.PerspectiveCamera(
      config.fov,
      1,
      config.near,
      config.far,
    );
    camera.position.set(...config.position);
    if (config.lookAt) camera.lookAt(...config.lookAt);
    camera.updateProjectionMatrix();
    cameras.set(scene.sceneId, camera);
  }
  return cameras;
}

const seenCanvasElements = new WeakSet<HTMLCanvasElement>();

function StageCanvasMountProbe(): null {
  const canvas = useThree(
    (state) =>
      (state.gl as unknown as { domElement: HTMLCanvasElement }).domElement,
  );

  useEffect(() => {
    if (seenCanvasElements.has(canvas)) return;
    seenCanvasElements.add(canvas);
    useStageStore.getState().noteCanvasMount();
  }, [canvas]);

  return null;
}

function StageRendererHealthBridge({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
}): null {
  const gl = useThree((state) => state.gl);
  const set = useThree((state) => state.set);
  const setSize = useThree((state) => state.setSize);
  const invalidate = useThree((state) => state.invalidate);
  const canvas = (
    gl as unknown as { domElement: HTMLCanvasElement }
  ).domElement;
  const wakeQueued = useRef(false);

  useEffect(() => {
    const health = rendererHealthByCanvas.get(canvas);
    if (!health) return;
    const stageCanvas =
      containerRef.current?.querySelector('canvas') ?? canvas;
    health.adoptVisibleCanvas(stageCanvas);
    rendererHealthByCanvas.set(stageCanvas, health);
    const resync = (): void => {
      const rect = stageCanvas.getBoundingClientRect();
      if (rect.width >= 2 && rect.height >= 2) {
        setSize(
          Math.round(rect.width),
          Math.round(rect.height),
          0,
          0,
        );
      }
      invalidate(1);
    };
    const detachHealth = health.attach({
      install: (renderer) => {
        currentStageBackend = (
          renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }
        ).backend?.isWebGPUBackend
          ? 'webgpu'
          : 'webgl';
        set(
          { gl: renderer } as unknown as Partial<RootState>,
        );
      },
      resync,
    });

    const tracked = <
      T extends EventTarget,
      K extends string,
    >(
      target: T,
      type: K,
      listener: EventListener,
    ): (() => void) => {
      target.addEventListener(type, listener);
      useStageStore.getState().adjustWindowListenerCount(1);
      return () => {
        target.removeEventListener(type, listener);
        useStageStore.getState().adjustWindowListenerCount(-1);
      };
    };

    let contextRestoreTimer = 0;
    const onContextLost = (event: Event): void => {
      event.preventDefault();
      resetAllHeldInputs();
      requestStageDeltaClamp();
      useStageStore.getState().noteRecovery('webgl-context-lost');
      window.clearTimeout(contextRestoreTimer);
      contextRestoreTimer = window.setTimeout(() => {
        health.requestRecovery('webgl-context-restore-timeout');
      }, 2_000);
    };
    const onContextRestored = (): void => {
      window.clearTimeout(contextRestoreTimer);
      useStageStore.getState().noteRecovery('webgl-context-restored');
      resync();
    };
    const onWake = (): void => {
      if (document.hidden || wakeQueued.current) return;
      wakeQueued.current = true;
      queueMicrotask(() => {
        wakeQueued.current = false;
        resetAllHeldInputs();
        requestStageDeltaClamp();
        resync();
      });
    };
    const onVisibility = (): void => {
      resetAllHeldInputs();
      if (!document.hidden) onWake();
    };

    const removers = [
      tracked(stageCanvas, 'webglcontextlost', onContextLost),
      tracked(stageCanvas, 'webglcontextrestored', onContextRestored),
      tracked(document, 'visibilitychange', onVisibility),
      tracked(window, 'pageshow', onWake),
    ];
    const adoptionTimer = window.setTimeout(() => {
      const visibleCanvas =
        containerRef.current?.querySelector('canvas');
      if (!visibleCanvas) {
        health.requestRecovery('visible-canvas-missing');
        return;
      }
      if (
        !canvas.isConnected ||
        visibleCanvas !== canvas
      ) {
        health.adoptVisibleCanvas(visibleCanvas);
        rendererHealthByCanvas.set(visibleCanvas, health);
        health.requestRecovery('renderer-canvas-detached');
        return;
      }
      const rect = visibleCanvas.getBoundingClientRect();
      if (
        visibleCanvas.width === 300 &&
        visibleCanvas.height === 150 &&
        rect.width > 320 &&
        rect.height > 170
      ) {
        health.requestRecovery('canvas-not-adopted');
      }
    }, 6_000);

    return () => {
      window.clearTimeout(adoptionTimer);
      window.clearTimeout(contextRestoreTimer);
      for (const remove of removers) remove();
      detachHealth();
    };
  }, [canvas, containerRef, invalidate, set, setSize]);

  return null;
}

function StageLoopController({
  rearmNativeRoot,
}: {
  rearmNativeRoot: () => void;
}): null {
  const paused = useStageStore((state) => state.renderPaused);
  const setFrameloop = useThree((state) => state.setFrameloop);

  const invalidate = useThree((state) => state.invalidate);

  useLayoutEffect(() => {
    setFrameloop(paused ? 'never' : 'always');
    if (!paused) {
      rearmNativeRoot();
      invalidate();
    }
  }, [invalidate, paused, rearmNativeRoot, setFrameloop]);

  return null;
}

function StageSceneSlot({
  sceneId,
  camera = null,
  capabilities,
  children,
}: {
  sceneId: string;
  camera?: THREE.PerspectiveCamera | null;
  capabilities?: Partial<PlayerCapabilityMask>;
  children: ReactNode;
}) {
  const resolvedCapabilities = useMemo(
    () => resolvePlayerCapabilities(capabilities),
    [capabilities],
  );
  const visible = useStageStore(
    (state) =>
      state.activeScene === sceneId ||
      (state.activeScene === null &&
        state.pendingRequest?.sceneId === sceneId),
  );
  const mounted = useStageStore((state) => {
    const status = state.scenes[sceneId]?.status;
    return status !== undefined && status !== 'unrequested' && status !== 'evicted';
  });
  return (
    <group
      ref={(root) => registerStageSlotRoot(sceneId, root)}
      name={`world-stage:${sceneId}`}
      visible={visible}
    >
      {mounted ? (
        <SceneCameraProvider camera={camera}>
          <SceneIdProvider sceneId={sceneId}>
            <SlotCapabilityProvider capabilities={resolvedCapabilities}>
              {children}
            </SlotCapabilityProvider>
          </SceneIdProvider>
        </SceneCameraProvider>
      ) : null}
    </group>
  );
}

function StageSceneAppearance({
  scene,
}: {
  scene: WorldStageScene;
}): null {
  const ownsAppearance = useStageStore(
    (state) =>
      state.activeScene === scene.sceneId ||
      (state.activeScene === null &&
        state.pendingRequest?.sceneId === scene.sceneId),
  );
  const rootScene = useThree((state) => state.scene);
  const gl = useThree((state) => state.gl);
  const background = useMemo(
    () =>
      scene.appearance
        ? new THREE.Color(scene.appearance.background)
        : null,
    [scene.appearance],
  );
  const fog = useMemo(
    () =>
      scene.appearance?.fog
        ? new THREE.Fog(
            scene.appearance.fog.color,
            scene.appearance.fog.near,
            scene.appearance.fog.far,
          )
        : null,
    [scene.appearance],
  );

  useEffect(() => {
    if (!ownsAppearance || !scene.appearance || !background) return;
    const { appearance } = scene;
    const previousBackground = rootScene.background;
    const previousFog = rootScene.fog;
    const previousShadows = gl.shadowMap.enabled;
    rootScene.background = background;
    rootScene.fog = fog;
    gl.setClearColor(background, 1);
    gl.setClearAlpha?.(1);
    gl.shadowMap.enabled = appearance.shadows ?? false;
    return () => {
      if (rootScene.background === background) {
        rootScene.background = previousBackground;
      }
      if (rootScene.fog === fog) {
        rootScene.fog = previousFog;
      }
      gl.shadowMap.enabled = previousShadows;
    };
  }, [background, fog, gl, ownsAppearance, rootScene, scene]);

  return null;
}

export function WorldStageCanvas({
  scenes,
  transitionTimeoutMs = 45_000,
  watchdogConfig,
  pauseOnCreate = false,
  onStageCreated,
  renderTransitionOverlay = true,
  onTransitionOpaque,
}: WorldStageCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cameras] = useState(() => createPersistentCameras(scenes));
  const initialCamera =
    cameras.get(scenes[0]?.sceneId ?? '') ??
    new THREE.PerspectiveCamera(50, 1, 0.1, 2_000);
  const capturedR3FRootRef = useRef<{
    canvas: HTMLCanvasElement;
    entry: NonNullable<ReturnType<typeof _roots.get>>;
  } | null>(null);
  const glFactory = useCallback(
    async (props: { canvas: HTMLCanvasElement }) => {
      const entry = _roots.get(props.canvas);
      if (entry) {
        capturedR3FRootRef.current = { canvas: props.canvas, entry };
      }
      const renderer = await createStageRenderer(props);
      return renderer;
    },
    [],
  );
  const rearmNativeRoot = useCallback(() => {
    const captured = capturedR3FRootRef.current;
    if (!captured || !captured.canvas.isConnected) return;
    if (_roots.get(captured.canvas)) return;
    _roots.set(captured.canvas, captured.entry);
  }, []);

  useEffect(() => {
    diagnosticCameras = cameras;
    useStageStore
      .getState()
      .registerScenes(scenes.map((scene) => scene.sceneId));
    return () => {
      if (diagnosticCameras === cameras) diagnosticCameras = null;
    };
  }, [cameras, scenes]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-[#07131d]"
    >
      <Canvas
        events={createStagePointerEvents}
        frameloop="always"
        dpr={DPR_RANGE}
        camera={initialCamera}
        gl={glFactory as any}
        onCreated={(state) => {
          if (pauseOnCreate) {
            useStageStore.getState().setRenderPaused(true);
            state.setFrameloop('never');
          }
          onStageCreated?.(state);
        }}
      >
        <color attach="background" args={[0x07131d]} />
        <KTX2LoaderSetup />
        <StageCanvasMountProbe />
        <StageRendererHealthBridge containerRef={containerRef} />
        <StageLoopController rearmNativeRoot={rearmNativeRoot} />
        <StageCameraCoordinator
          definitions={scenes}
          cameras={cameras}
        />
        <StageFrameScheduler />
        <StageRendererCounterSampler />
        {scenes.map((scene) => (
          <group key={scene.sceneId}>
            <StageSceneAppearance scene={scene} />
            <StageSceneSlot
              sceneId={scene.sceneId}
              camera={cameras.get(scene.sceneId) ?? null}
              capabilities={scene.capabilities}
            >
              {scene.content}
            </StageSceneSlot>
          </group>
        ))}
      </Canvas>
      {renderTransitionOverlay && (
        <StageTransition
          timeoutMs={transitionTimeoutMs}
          watchdogConfig={watchdogConfig}
          onOpaque={onTransitionOpaque}
        />
      )}
    </div>
  );
}
