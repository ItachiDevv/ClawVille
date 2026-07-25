'use client';

import {
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  Canvas,
  extend,
  useThree,
  type ThreeToJSXElements,
} from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { StageTransition } from './StageTransition';
import {
  StageCameraCoordinator,
  type StageCameraDefinition,
} from './stage-camera';
import { useStageStore } from './stage-store';
import { StageFrameScheduler } from './use-scene-frame';

declare module '@react-three/fiber' {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

extend(THREE as any);

const LOW_END_PATTERNS = [
  /\bintel\b/i,
  /\biris\b/i,
  /\buhd graphics\b/i,
  /\bhd graphics\b/i,
  /\bgma\b/i,
  /adreno/i,
  /mali/i,
  /powervr/i,
  /apple gpu/i,
];

function detectStageLowEndGpu(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const probeCanvas = document.createElement('canvas');
    const context = (probeCanvas.getContext('webgl2') ??
      probeCanvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!context) return true;
    const extension = context.getExtension('WEBGL_debug_renderer_info');
    const renderer = extension
      ? String(
          context.getParameter(extension.UNMASKED_RENDERER_WEBGL) ?? '',
        )
      : '';
    const coarsePointer =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return (
      coarsePointer ||
      LOW_END_PATTERNS.some((pattern) => pattern.test(renderer))
    );
  } catch {
    return false;
  }
}

const LOW_END_GPU = detectStageLowEndGpu();
const DPR_RANGE: [number, number] = LOW_END_GPU
  ? [0.55, 0.7]
  : [0.75, 1];
const IOS_SAFARI =
  typeof navigator !== 'undefined' &&
  /iP(hone|ad|od)/i.test(navigator.userAgent) &&
  /WebKit/i.test(navigator.userAgent) &&
  !/CriOS|FxiOS|OPiOS|mercury/i.test(navigator.userAgent);
const WEBGPU_ABSENT =
  typeof navigator !== 'undefined' && !('gpu' in navigator);
const FORCE_WEBGPU =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('webgpu') === '1';
const FORCE_WEBGL =
  IOS_SAFARI ||
  WEBGPU_ABSENT ||
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
  });
  renderer.setPixelRatio(dpr);
  try {
    await withInitTimeout(renderer.init(), 8_000);
  } catch (error) {
    renderer.dispose();
    throw error;
  }
  renderer.setClearColor(0x07131d, 1);
  renderer.setSize(width, height, false);
  return renderer;
}

const inflightRenderers = new WeakMap<
  HTMLCanvasElement,
  Promise<THREE.WebGPURenderer>
>();

function createStageRenderer(props: {
  canvas: HTMLCanvasElement;
}): Promise<THREE.WebGPURenderer> {
  const existing = inflightRenderers.get(props.canvas);
  if (existing) return existing;

  const creation = (async () => {
    const canvas = props.canvas;
    const [width, height] = await waitForCanvasSize(canvas);
    const dpr = Math.max(
      DPR_RANGE[0],
      Math.min(window.devicePixelRatio || 1, DPR_RANGE[1]),
    );
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    try {
      return await initializeStageRenderer(
        canvas,
        FORCE_WEBGL,
        width,
        height,
        dpr,
      );
    } catch (webGpuError) {
      if (FORCE_WEBGL) throw webGpuError;
      console.warn(
        '[WorldStage] WebGPU init failed; retrying force-WebGL on the same canvas:',
        webGpuError,
      );
      return initializeStageRenderer(canvas, true, width, height, dpr);
    }
  })();

  inflightRenderers.set(props.canvas, creation);
  creation.catch(() => inflightRenderers.delete(props.canvas));
  return creation;
}

export interface WorldStageScene extends StageCameraDefinition {
  content: ReactNode;
}

interface WorldStageCanvasProps {
  scenes: readonly WorldStageScene[];
  transitionTimeoutMs?: number;
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

function StageLoopController(): null {
  const paused = useStageStore((state) => state.renderPaused);
  const setFrameloop = useThree((state) => state.setFrameloop);

  useEffect(() => {
    setFrameloop(paused ? 'never' : 'always');
  }, [paused, setFrameloop]);

  return null;
}

function StageSceneSlot({
  sceneId,
  children,
}: {
  sceneId: string;
  children: ReactNode;
}) {
  const active = useStageStore(
    (state) => state.activeScene === sceneId,
  );
  return (
    <group name={`world-stage:${sceneId}`} visible={active}>
      {children}
    </group>
  );
}

export function WorldStageCanvas({
  scenes,
  transitionTimeoutMs = 20_000,
}: WorldStageCanvasProps) {
  const [cameras] = useState(() => createPersistentCameras(scenes));
  const initialCamera =
    cameras.get(scenes[0]?.sceneId ?? '') ??
    new THREE.PerspectiveCamera(50, 1, 0.1, 2_000);

  useEffect(() => {
    useStageStore
      .getState()
      .registerScenes(scenes.map((scene) => scene.sceneId));
  }, [scenes]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#07131d]">
      <Canvas
        frameloop="always"
        dpr={DPR_RANGE}
        camera={initialCamera}
        gl={createStageRenderer as any}
      >
        <color attach="background" args={[0x07131d]} />
        <ambientLight intensity={0.65} />
        <directionalLight
          color={0xc8ffff}
          intensity={2.2}
          position={[5, 8, 4]}
        />
        <StageCanvasMountProbe />
        <StageLoopController />
        <StageCameraCoordinator
          definitions={scenes}
          cameras={cameras}
        />
        <StageFrameScheduler />
        {scenes.map((scene) => (
          <StageSceneSlot key={scene.sceneId} sceneId={scene.sceneId}>
            {scene.content}
          </StageSceneSlot>
        ))}
      </Canvas>
      <StageTransition timeoutMs={transitionTimeoutMs} />
    </div>
  );
}
