'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import {
  WorldStageCanvas,
  type WorldStageScene,
} from '@/components/three/world-stage/WorldStageCanvas';
import {
  requestStageScene,
  resetStageStore,
  useStageStore,
  type StageSceneSlot,
  type StageTransitionPhase,
} from '@/components/three/world-stage/stage-store';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';

const EMPTY_SLOT: StageSceneSlot = {
  status: 'unrequested',
  generation: 0,
  frameInvocations: 0,
};

function useSyntheticWarmup(sceneId: string): void {
  const active = useStageStore(
    (state) => state.activeScene === sceneId,
  );
  const generation = useStageStore(
    (state) => state.scenes[sceneId]?.generation ?? 0,
  );
  const requested = useStageStore(
    (state) => state.pendingRequest?.sceneId === sceneId,
  );
  const warmedOnceRef = useRef(false);

  useEffect(() => {
    if (!active || !requested || generation <= 0) return;
    const state = useStageStore.getState();
    const slot = state.scenes[sceneId];
    if (!slot || slot.generation !== generation) return;

    state.setSceneWarming(sceneId, generation);
    const delayMs = warmedOnceRef.current ? 0 : 1_000;
    const warmingTimer = window.setTimeout(() => {
      const current = useStageStore.getState().scenes[sceneId];
      if (!current || current.generation !== generation) return;
      warmedOnceRef.current = true;
      useStageStore.getState().ackReady(sceneId, generation);
    }, delayMs);

    return () => window.clearTimeout(warmingTimer);
  }, [active, generation, requested, sceneId]);
}

function AlphaScene() {
  const groupRef = useRef<THREE.Group>(null);
  useSyntheticWarmup('alpha');
  useSceneFrame('alpha', (_state, delta) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y += delta * 0.65;
    groupRef.current.rotation.x =
      Math.sin(groupRef.current.rotation.y * 0.7) * 0.12;
  });

  return (
    <group ref={groupRef}>
      <mesh position={[-1.5, 0, 0]}>
        <boxGeometry args={[1.4, 1.4, 1.4]} />
        <meshStandardMaterial color={0x20d9c2} roughness={0.28} />
      </mesh>
      <mesh position={[0, 0.75, 0]}>
        <boxGeometry args={[1.4, 1.4, 1.4]} />
        <meshStandardMaterial color={0x65fff0} roughness={0.28} />
      </mesh>
      <mesh position={[1.5, 0, 0]}>
        <boxGeometry args={[1.4, 1.4, 1.4]} />
        <meshStandardMaterial color={0x109c98} roughness={0.28} />
      </mesh>
    </group>
  );
}

function BetaScene() {
  const groupRef = useRef<THREE.Group>(null);
  useSyntheticWarmup('beta');
  useSceneFrame('beta', (_state, delta) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y -= delta * 0.8;
    groupRef.current.position.y =
      Math.sin(groupRef.current.rotation.y) * 0.35;
  });

  return (
    <group ref={groupRef}>
      <mesh position={[-1.65, 0, 0]}>
        <sphereGeometry args={[0.9, 24, 16]} />
        <meshStandardMaterial color={0xff8a3d} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.8, 0]}>
        <sphereGeometry args={[1.05, 24, 16]} />
        <meshStandardMaterial color={0xffc168} roughness={0.35} />
      </mesh>
      <mesh position={[1.65, 0, 0]}>
        <sphereGeometry args={[0.9, 24, 16]} />
        <meshStandardMaterial color={0xe95a2c} roughness={0.35} />
      </mesh>
    </group>
  );
}

interface ProofInstrumentation {
  alpha: StageSceneSlot;
  beta: StageSceneSlot;
  activeScene: string | null;
  transitionPhase: StageTransitionPhase;
  canvasMountCount: number;
  windowListenerCountDelta: number;
}

function readInstrumentation(
  windowListenerBaseline = 0,
): ProofInstrumentation {
  const state = useStageStore.getState();
  return {
    alpha: state.scenes.alpha ?? EMPTY_SLOT,
    beta: state.scenes.beta ?? EMPTY_SLOT,
    activeScene: state.activeScene,
    transitionPhase: state.transition?.phase ?? 'idle',
    canvasMountCount: state.canvasMountCount,
    windowListenerCountDelta:
      state.windowListenerCount - windowListenerBaseline,
  };
}

function SlotLine({
  name,
  slot,
}: {
  name: string;
  slot: StageSceneSlot;
}) {
  return (
    <div className="grid grid-cols-[4rem_1fr] gap-2">
      <span className="font-semibold text-white">{name}</span>
      <span>
        {slot.status} · gen {slot.generation} · frames{' '}
        {slot.frameInvocations.toLocaleString()}
      </span>
    </div>
  );
}

export default function StageProof() {
  const [stageReady, setStageReady] = useState(false);
  const windowListenerBaselineRef = useRef(0);
  const [instrumentation, setInstrumentation] = useState(
    readInstrumentation,
  );

  useEffect(() => {
    resetStageStore();
    windowListenerBaselineRef.current =
      useStageStore.getState().windowListenerCount;
    setInstrumentation(
      readInstrumentation(windowListenerBaselineRef.current),
    );
    setStageReady(true);
  }, []);

  useEffect(() => {
    if (!stageReady) return;
    requestStageScene('alpha');
    const instrumentationTimer = window.setInterval(() => {
      setInstrumentation(
        readInstrumentation(windowListenerBaselineRef.current),
      );
    }, 200);
    return () => window.clearInterval(instrumentationTimer);
  }, [stageReady]);

  const scenes = useMemo<readonly WorldStageScene[]>(
    () => [
      {
        sceneId: 'alpha',
        camera: {
          fov: 48,
          near: 0.1,
          far: 200,
          position: [0, 3.5, 8],
          lookAt: [0, 0, 0],
        },
        content: <AlphaScene />,
      },
      {
        sceneId: 'beta',
        camera: {
          fov: 58,
          near: 0.1,
          far: 200,
          position: [7, 4.5, 3],
          lookAt: [0, 0, 0],
        },
        content: <BetaScene />,
      },
    ],
    [],
  );

  if (!stageReady) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#07131d] text-sm text-cyan-100">
        Preparing stage proof…
      </main>
    );
  }

  return (
    <main className="relative h-screen min-h-[520px] overflow-hidden bg-[#07131d] text-white">
      <WorldStageCanvas scenes={scenes} />

      <section className="pointer-events-auto absolute left-4 top-4 z-30 w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-cyan-300/30 bg-slate-950/85 p-4 shadow-2xl backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => requestStageScene('alpha')}
            className="rounded-lg bg-teal-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-300"
          >
            Go alpha
          </button>
          <button
            type="button"
            onClick={() => requestStageScene('beta')}
            className="rounded-lg bg-orange-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-orange-300"
          >
            Go beta
          </button>
          <span className="text-xs text-white/60">
            Rapid clicks exercise stale-request cancellation.
          </span>
        </div>

        <div className="mt-4 space-y-1 font-mono text-xs text-cyan-100/85">
          <SlotLine name="alpha" slot={instrumentation.alpha} />
          <SlotLine name="beta" slot={instrumentation.beta} />
          <div>active scene: {instrumentation.activeScene ?? 'none'}</div>
          <div>transition: {instrumentation.transitionPhase}</div>
          <div>canvas remount counter: {instrumentation.canvasMountCount}</div>
          <div>
            window listener count delta:{' '}
            {instrumentation.windowListenerCountDelta} (stage-owned)
          </div>
        </div>
      </section>
    </main>
  );
}
