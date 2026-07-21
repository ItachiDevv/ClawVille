'use client';

import { Suspense, useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { detectLowEndGpuClass } from '@/lib/three/gpu-tier';
import KelpRealmScene from '@/lib/three/kelp-realm-scene';
import {
  clearKelpRealmRendererFailure,
  reportKelpRealmRendererFailure,
} from '@/lib/three/kelp-realm-renderer-status';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';

const LOW_END_GPU = detectLowEndGpuClass();
const WEBGPU_UNHEALTHY_KEY = 'kelp-realm-webgpu-unhealthy';

function readWebGPUUnhealthyFlag(): boolean {
  try {
    return window.sessionStorage?.getItem(WEBGPU_UNHEALTHY_KEY) === '1';
  } catch {
    return false;
  }
}

const FORCE_WEBGL = typeof window !== 'undefined' && (
  LOW_END_GPU
  || new URLSearchParams(window.location.search).get('webgl') === '1'
  || readWebGPUUnhealthyFlag()
);

const DPR_RANGE: [number, number] = LOW_END_GPU ? [0.55, 0.7] : [0.75, 1];

function getCanvasCssSize(canvas: HTMLCanvasElement): readonly [number, number] | null {
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

async function waitForCanvasSize(canvas: HTMLCanvasElement): Promise<readonly [number, number]> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const size = getCanvasCssSize(canvas);
    if (size && (size[0] !== 300 || size[1] !== 150) && size[0] >= 2 && size[1] >= 2) return size;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return getCanvasCssSize(canvas) ?? [Math.max(2, window.innerWidth), Math.max(2, window.innerHeight)];
}

function withInitTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      settled = true;
      // The abandoned init may still settle later; swallow it so a late
      // rejection never surfaces as an unhandled promise rejection.
      promise.catch(() => undefined);
      reject(new Error(`renderer init did not complete within ${ms}ms`));
    }, ms);
    promise.then(
      (value) => { if (!settled) { window.clearTimeout(timer); resolve(value); } },
      (error: unknown) => { if (!settled) { window.clearTimeout(timer); reject(error); } },
    );
  });
}

function markWebGPUUnhealthyAndReload(): void {
  try {
    window.sessionStorage?.setItem(WEBGPU_UNHEALTHY_KEY, '1');
  } catch {
    // Storage blocked (privacy mode) — still reload; the WebGPU retry next
    // load is better than staying on a dead canvas.
  }
  window.location.reload();
}

/**
 * A WebGPU device can initialize fine and then fail EVERY frame submit with
 * validation errors (observed live on prod: "Buffer used in submit while
 * destroyed" on SwiftShader-class adapters) — the canvas stays a silent void
 * while the HUD works. No exception ever surfaces, so watch the device's
 * uncaptured-error stream; on sustained errors flag the session and reload
 * into the proven force-WebGL lane.
 */
function watchWebGPUHealth(renderer: THREE.WebGPURenderer): void {
  const device = (renderer as unknown as { backend?: { device?: GPUDevice } }).backend?.device;
  if (!device?.addEventListener) return;
  let errorCount = 0;
  let tripped = false;
  device.addEventListener('uncapturederror', (event: Event) => {
    errorCount += 1;
    if (tripped || errorCount < 8) return;
    tripped = true;
    console.error(
      '[KelpRealm] WebGPU device is erroring every frame; falling back to WebGL:',
      (event as { error?: { message?: string } }).error?.message,
    );
    markWebGPUUnhealthyAndReload();
  });
}

async function initializeRealmRenderer(
  canvas: HTMLCanvasElement,
  forceWebGL: boolean,
  width: number,
  height: number,
  dpr: number,
): Promise<THREE.WebGPURenderer> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL });
  renderer.setPixelRatio(dpr);
  try {
    await withInitTimeout(renderer.init(), 8000);
  } catch (error) {
    renderer.dispose();
    throw error;
  }
  renderer.setSize(width, height, false);
  return renderer;
}

/**
 * Mirrors the proven World3DCanvas factory: renderers bind ONLY the R3F
 * canvas, never a clone (the canvas-swap approach we shipped first left the
 * DOM canvas orphaned at 300x150 while renderers drew to detached clones —
 * the reproduced prod "silent void"). R3F can double-invoke this async
 * factory, so creation is serialized through a per-canvas in-flight promise:
 * both invocations receive the same renderer, and only that single winner
 * touches the shared failure store. On the WebGPU lane an init failure or
 * hang gets ONE explicit force-WebGL second attempt on the same canvas (a
 * failed adapter/device negotiation does not claim the canvas context).
 */
const inflightRenderers = new WeakMap<HTMLCanvasElement, Promise<THREE.WebGPURenderer>>();

function createRealmRenderer(props: { canvas: HTMLCanvasElement }): Promise<THREE.WebGPURenderer> {
  const existing = inflightRenderers.get(props.canvas);
  if (existing) return existing;
  const creation = (async () => {
    const canvas = props.canvas;
    const [width, height] = await waitForCanvasSize(canvas);
    const dpr = Math.max(DPR_RANGE[0], Math.min(window.devicePixelRatio || 1, DPR_RANGE[1]));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    let renderer: THREE.WebGPURenderer;
    let usedWebGL = FORCE_WEBGL;
    try {
      renderer = await initializeRealmRenderer(canvas, FORCE_WEBGL, width, height, dpr);
    } catch (firstError) {
      if (FORCE_WEBGL) {
        console.error('[KelpRealm] renderer init failed:', { webGPUError: null, webGLError: firstError });
        reportKelpRealmRendererFailure(null, firstError);
        throw firstError;
      }
      console.warn('[KelpRealm] WebGPU init failed; retrying force-WebGL on the same canvas:', firstError);
      try {
        renderer = await initializeRealmRenderer(canvas, true, width, height, dpr);
        usedWebGL = true;
      } catch (webGLError) {
        console.error('[KelpRealm] renderer init failed:', { webGPUError: firstError, webGLError });
        reportKelpRealmRendererFailure(firstError, webGLError);
        throw webGLError;
      }
    }

    clearKelpRealmRendererFailure();
    if (!usedWebGL) watchWebGPUHealth(renderer);
    try {
      const device = (renderer as unknown as { backend?: { device?: GPUDevice } }).backend?.device;
      device?.lost?.then((info) => {
        console.error('[KelpRealm] GPU device lost:', info.reason, info.message);
        if (info.reason !== 'destroyed') markWebGPUUnhealthyAndReload();
      });
    } catch {
      // WebGL backend has no device-loss promise — nothing to watch.
    }
    return renderer;
  })();
  inflightRenderers.set(props.canvas, creation);
  creation.catch(() => inflightRenderers.delete(props.canvas));
  return creation;
}

function PrecompileRealm() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const renderer = gl as unknown as { compileAsync?: (scene: THREE.Scene, camera: THREE.Camera) => Promise<unknown> };
      void renderer.compileAsync?.(scene, camera).catch((error: unknown) => console.warn('[KelpRealm] compileAsync failed:', error));
    });
    return () => cancelAnimationFrame(frame);
  }, [camera, gl, scene]);
  return null;
}

/**
 * Canvas-adoption watchdog. When the async WebGPU factory is slow (SwiftShader
 * ~500ms adapter negotiation, struggling drivers), R3F can recreate its canvas
 * while the factory is in flight — every renderer then drives a detached
 * canvas and the DOM canvas keeps its default 300x150 attributes forever: an
 * eternal silent void with ZERO errors (reproduced against the prod bundle;
 * also affects /game in the same environments). The signature is precise
 * (default-attrs canvas with a large layout box after grace), and the WebGL
 * lane inits fast enough to never lose this race — so detect once and reload
 * into it. FORCE_WEBGL sessions skip the check entirely, so no reload loop.
 */
function useCanvasAdoptionWatchdog(containerRef: { current: HTMLDivElement | null }): void {
  useEffect(() => {
    if (FORCE_WEBGL) return;
    const timer = window.setTimeout(() => {
      const canvas = containerRef.current?.querySelector('canvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (canvas.width === 300 && canvas.height === 150 && rect.width > 320 && rect.height > 170) {
        console.error('[KelpRealm] renderer never adopted the visible canvas; reloading into WebGL');
        markWebGPUUnhealthyAndReload();
      }
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [containerRef]);
}

export default function KelpRealmCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useCanvasAdoptionWatchdog(containerRef);
  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
      <Canvas
        key="kelp-realm"
        frameloop="always"
        dpr={DPR_RANGE}
        camera={{ fov: 60, near: 1, far: 10000, position: [0, 470, 1460] }}
        gl={createRealmRenderer as any}
      >
        <KTX2LoaderSetup />
        <PrecompileRealm />
        <Suspense fallback={null}><KelpRealmScene forceWebGL={FORCE_WEBGL} /></Suspense>
      </Canvas>
    </div>
  );
}
