'use client';

import { Suspense, useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { detectLowEndGpuClass } from '@/lib/three/gpu-tier';
import KelpRealmScene from '@/lib/three/kelp-realm-scene';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';

const LOW_END_GPU = detectLowEndGpuClass();
const FORCE_WEBGL = typeof window !== 'undefined' && (
  LOW_END_GPU || new URLSearchParams(window.location.search).get('webgl') === '1'
);

const DPR_RANGE: [number, number] = LOW_END_GPU ? [0.55, 0.7] : [0.75, 1];

async function waitForCanvasSize(canvas: HTMLCanvasElement): Promise<readonly [number, number]> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width >= 2 && rect.height >= 2) return [rect.width, rect.height];
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return [Math.max(2, window.innerWidth), Math.max(2, window.innerHeight)];
}

async function initializeRenderer(canvas: HTMLCanvasElement, forceWebGL: boolean): Promise<THREE.WebGPURenderer> {
  const [width, height] = await waitForCanvasSize(canvas);
  const dpr = Math.max(DPR_RANGE[0], Math.min(window.devicePixelRatio || 1, DPR_RANGE[1]));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL });
  try {
    renderer.setPixelRatio(dpr);
    await renderer.init();
    renderer.setSize(width, height, false);
    return renderer;
  } catch (error) {
    renderer.dispose();
    throw error;
  }
}

async function createRealmRenderer(props: { canvas: HTMLCanvasElement }): Promise<THREE.WebGPURenderer> {
  if (FORCE_WEBGL) return initializeRenderer(props.canvas, true);
  try {
    return await initializeRenderer(props.canvas, false);
  } catch (error) {
    console.warn('[KelpRealm] WebGPU init failed; retrying force-WebGL on a fresh canvas:', error);
    const fallbackCanvas = props.canvas.cloneNode(false) as HTMLCanvasElement;
    fallbackCanvas.className = props.canvas.className;
    fallbackCanvas.style.cssText = props.canvas.style.cssText;
    props.canvas.parentNode?.replaceChild(fallbackCanvas, props.canvas);
    try {
      return await initializeRenderer(fallbackCanvas, true);
    } catch (fallbackError) {
      fallbackCanvas.remove();
      throw fallbackError;
    }
  }
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
      camera={{ fov: 60, near: 1, far: 8000, position: [0, 245, 1460] }}
      gl={createRealmRenderer as any}
    >
      <KTX2LoaderSetup />
      <PrecompileRealm />
      <Suspense fallback={null}><KelpRealmScene forceWebGL={FORCE_WEBGL} /></Suspense>
    </Canvas>
  );
}
