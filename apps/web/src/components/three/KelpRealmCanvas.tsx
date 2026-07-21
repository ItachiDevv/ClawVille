'use client';

import { Suspense, useEffect } from 'react';
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
    const timer = window.setTimeout(
      () => reject(new Error(`renderer init did not complete within ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error: unknown) => { window.clearTimeout(timer); reject(error); },
    );
  });
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
    try {
      window.sessionStorage?.setItem(WEBGPU_UNHEALTHY_KEY, '1');
      window.location.reload();
    } catch {
      // sessionStorage unavailable — nothing more we can do silently.
    }
  });
}

/**
 * Mirrors the proven World3DCanvas factory: ONE renderer bound to the R3F
 * canvas, no canvas swapping. R3F can double-invoke this async factory; both
 * renderers then bind the SAME DOM canvas so whichever wins, the visible
 * canvas renders (the canvas-swap approach we shipped first left the DOM
 * canvas orphaned at 300x150 while two renderers drew to detached clones —
 * the reproduced prod "silent void"). three r185's init() already falls back
 * from WebGPU to WebGL2 internally, so no second lane is needed; the timeout
 * catches the adapter-hang class where init() never settles at all.
 */
async function createRealmRenderer(props: { canvas: HTMLCanvasElement }): Promise<THREE.WebGPURenderer> {
  const canvas = props.canvas;
  const [width, height] = await waitForCanvasSize(canvas);
  const dpr = Math.max(DPR_RANGE[0], Math.min(window.devicePixelRatio || 1, DPR_RANGE[1]));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL: FORCE_WEBGL });
  renderer.setPixelRatio(dpr);
  try {
    await withInitTimeout(renderer.init(), 8000);
  } catch (error) {
    renderer.dispose();
    console.error('[KelpRealm] renderer init failed:', { forceWebGL: FORCE_WEBGL, error });
    reportKelpRealmRendererFailure(FORCE_WEBGL ? null : error, FORCE_WEBGL ? error : null);
    throw error;
  }
  renderer.setSize(width, height, false);
  clearKelpRealmRendererFailure();
  if (!FORCE_WEBGL) watchWebGPUHealth(renderer);
  try {
    const device = (renderer as unknown as { backend?: { device?: GPUDevice } }).backend?.device;
    device?.lost?.then((info) => {
      console.error('[KelpRealm] GPU device lost:', info.reason, info.message);
      if (info.reason !== 'destroyed') {
        window.sessionStorage?.setItem(WEBGPU_UNHEALTHY_KEY, '1');
        window.location.reload();
      }
    });
  } catch {
    // WebGL backend has no device-loss promise — nothing to watch.
  }
  return renderer;
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

export default function KelpRealmCanvas() {
  return (
    <Canvas
      key="kelp-realm"
      frameloop="always"
      dpr={DPR_RANGE}
      camera={{ fov: 60, near: 1, far: 10000, position: [0, 610, 1460] }}
      gl={createRealmRenderer as any}
    >
      <KTX2LoaderSetup />
      <PrecompileRealm />
      <Suspense fallback={null}><KelpRealmScene forceWebGL={FORCE_WEBGL} /></Suspense>
    </Canvas>
  );
}
