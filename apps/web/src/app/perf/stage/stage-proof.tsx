'use client';

import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as THREE from 'three/webgpu';
import {
  readStageBackend,
  readStageCameraPoses,
  readStageRendererCounters,
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
import {
  readStageFrameInvocations,
  resetStageFrameDiagnostics,
  useSceneFrame,
} from '@/components/three/world-stage/use-scene-frame';
import {
  readStageResourceLedger,
  type ResourceLedgerResult,
} from '@/components/three/world-stage/resource-ledger';
import { CoveStageSpike } from './cove-stage-spike';

const EMPTY_SLOT: StageSceneSlot = {
  status: 'unrequested',
  generation: 0,
  frameInvocations: 0,
  hasEverActivated: false,
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
      <ambientLight intensity={0.65} />
      <directionalLight
        color={0xc8ffff}
        intensity={2.2}
        position={[5, 8, 4]}
      />
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
      <ambientLight intensity={0.65} />
      <directionalLight
        color={0xffd3a3}
        intensity={2.2}
        position={[-5, 8, 4]}
      />
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
  coveSpike: StageSceneSlot;
  activeScene: string | null;
  transitionPhase: StageTransitionPhase;
  canvasMountCount: number;
  windowListenerCountDelta: number;
  recoveryCount: number;
  lastRecoveryReason: string | null;
  listenerUnderflowCount: number;
  ledger: Record<string, ResourceLedgerResult>;
}

function readInstrumentation(
  windowListenerBaseline = 0,
): ProofInstrumentation {
  const state = useStageStore.getState();
  return {
    alpha: state.scenes.alpha ?? EMPTY_SLOT,
    beta: state.scenes.beta ?? EMPTY_SLOT,
    coveSpike: state.scenes['cove-spike'] ?? EMPTY_SLOT,
    activeScene: state.activeScene,
    transitionPhase: state.transition?.phase ?? 'idle',
    canvasMountCount: state.canvasMountCount,
    windowListenerCountDelta:
      state.windowListenerCount - windowListenerBaseline,
    recoveryCount: state.recovery.count,
    lastRecoveryReason: state.recovery.lastReason,
    listenerUnderflowCount: state.listenerUnderflowCount,
    ledger: readStageResourceLedger(),
  };
}

interface StageProbeSnapshot {
  activeScene: string | null;
  transitionPhase: StageTransitionPhase;
  transitionError: string | null;
  canvasMountCount: number;
  listenerCount: number;
  listenerUnderflowCount: number;
  recoveryCount: number;
  lastRecoveryReason: string | null;
  backend: ReturnType<typeof readStageBackend>;
  renderer: ReturnType<typeof readStageRendererCounters>;
  frames: Record<string, number>;
  cameras: Record<string, number[]>;
  slots: Record<
    string,
    {
      status: string;
      generation: number;
      frameInvocations: number;
    }
  >;
  transitionErrors: readonly string[];
}

declare global {
  interface Window {
    __WORLD_STAGE_LEDGER?: () => Record<
      string,
      ResourceLedgerResult
    >;
    __WORLD_STAGE_PROBE__?: {
      request: (sceneId: string) => void;
      snapshot: () => StageProbeSnapshot;
    };
  }
}

function readProbeSnapshot(): StageProbeSnapshot {
  const state = useStageStore.getState();
  return {
    activeScene: state.activeScene,
    transitionPhase: state.transition?.phase ?? 'idle',
    transitionError: state.transition?.error ?? null,
    canvasMountCount: state.canvasMountCount,
    listenerCount: state.windowListenerCount,
    listenerUnderflowCount: state.listenerUnderflowCount,
    recoveryCount: state.recovery.count,
    lastRecoveryReason: state.recovery.lastReason,
    backend: readStageBackend(),
    renderer: readStageRendererCounters(),
    frames: readStageFrameInvocations(),
    cameras: readStageCameraPoses(),
    slots: Object.fromEntries(
      Object.entries(state.scenes).map(([sceneId, slot]) => [
        sceneId,
        {
          status: slot.status,
          generation: slot.generation,
          frameInvocations: slot.frameInvocations,
        },
      ]),
    ),
    transitionErrors: [...state.transitionErrors],
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
    resetStageFrameDiagnostics();
    windowListenerBaselineRef.current =
      useStageStore.getState().windowListenerCount;
    setInstrumentation(
      readInstrumentation(windowListenerBaselineRef.current),
    );
    setStageReady(true);
    window.__WORLD_STAGE_LEDGER = readStageResourceLedger;
    window.__WORLD_STAGE_PROBE__ = {
      request: requestStageScene,
      snapshot: readProbeSnapshot,
    };
    return () => {
      delete window.__WORLD_STAGE_LEDGER;
      delete window.__WORLD_STAGE_PROBE__;
    };
  }, []);

  useEffect(() => {
    if (!stageReady) return;
    requestStageScene('alpha');
    const baselineTimer = window.setTimeout(() => {
      windowListenerBaselineRef.current =
        useStageStore.getState().windowListenerCount;
    }, 1_250);
    const instrumentationTimer = window.setInterval(() => {
      setInstrumentation(
        readInstrumentation(windowListenerBaselineRef.current),
      );
    }, 250);
    return () => {
      window.clearTimeout(baselineTimer);
      window.clearInterval(instrumentationTimer);
    };
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
      {
        sceneId: 'cove-spike',
        camera: {
          fov: 54,
          near: 0.1,
          far: 100,
          position: [0, -1.4, -2.4],
          lookAt: [0, -1.4, 0],
        },
        content: (
          <Suspense fallback={null}>
            <CoveStageSpike />
          </Suspense>
        ),
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
          <button
            type="button"
            onClick={() => requestStageScene('cove-spike')}
            className="rounded-lg bg-fuchsia-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-fuchsia-300"
          >
            Go cove
          </button>
          <span className="text-xs text-white/60">
            Rapid clicks exercise stale-request cancellation.
          </span>
        </div>

        <div className="mt-4 space-y-1 font-mono text-xs text-cyan-100/85">
          <SlotLine name="alpha" slot={instrumentation.alpha} />
          <SlotLine name="beta" slot={instrumentation.beta} />
          <SlotLine
            name="cove"
            slot={instrumentation.coveSpike}
          />
          <div>active scene: {instrumentation.activeScene ?? 'none'}</div>
          <div>transition: {instrumentation.transitionPhase}</div>
          <div>canvas remount counter: {instrumentation.canvasMountCount}</div>
          <div>
            window listener count delta:{' '}
            {instrumentation.windowListenerCountDelta} (stage-owned)
          </div>
          <div>
            listener underflows:{' '}
            {instrumentation.listenerUnderflowCount}
          </div>
          <div>
            recoveries: {instrumentation.recoveryCount} · last:{' '}
            {instrumentation.lastRecoveryReason ?? 'none'}
          </div>
          {Object.entries(instrumentation.ledger).map(
            ([sceneId, ledger]) => (
              <div key={sceneId}>
                {sceneId} ledger:{' '}
                {(ledger.total / (1024 * 1024)).toFixed(1)} MB
              </div>
            ),
          )}
        </div>
      </section>
    </main>
  );
}
