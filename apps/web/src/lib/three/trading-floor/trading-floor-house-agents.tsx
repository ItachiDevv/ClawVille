'use client';

/**
 * trading-floor-house-agents.tsx
 *
 * The five house agents standing under the Trading Floor big screen, one under
 * each board column (P15 task T4; ops/house-traders/arena-review/
 * P15_PLAN_2026-10-02.md §2 "Mount (T4)", §3 "Detection (T4)"). Founder order
 * 2026-10-01: all five visible, paper or live, at the big screen; walk up to
 * one and a pop-up beside it offers "Choose this trading style".
 *
 * What is here:
 *   - The baked static GLB (task T3): five mesh nodes `HouseAgent_<templateId>`,
 *     ONE shared opaque material, no skin. Node i stands at
 *     TRADING_FLOOR_HOUSE_AGENT_SPOTS[i]. Cost: +5 draw calls.
 *   - Idle: transform only, breathing scale.y 1 +/- 0.006 and yaw +/- 0.03 rad,
 *     seeded per agent. Five matrix updates per frame (every node has
 *     matrixAutoUpdate off; the frame calls updateMatrix once per node).
 *   - Per-figure hide rule (`tradingFloorHouseAgentHidden`): the mesh hides when
 *     the camera is inside it or the camera-to-body sightline crosses it. The
 *     label and the walk-up stay on. `visible` is written only on a change; the
 *     shared material is never touched.
 *   - Five DOM name labels (WorldLabelsOverlay, not canvas text). Phone (touch
 *     and canvas < 600 px): only the walk-up agent, else the nearest within 900.
 *   - Walk-up detection into `stores/house-agent-walkup.ts`: one store write
 *     per TRANSITION, plus the chest-point anchor in CSS px every frame while an
 *     agent is in reach.
 *
 * Late mount, NOT in the room's ready gate: the GLB is requested only after the
 * stage reports this slot `ready` or `resident`. The figures stay hidden, compile
 * through `chainPostBootCompile`, then reveal (5 s fallback), the same shape as
 * the late avatar in `trading-floor-interior.tsx`.
 *
 * Iris Xe: DOM labels only (no drei text helpers), no instancing, no custom
 * shader material, and no allocation in the frame callback (module scratch).
 */

import {
  Component,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import * as THREE from 'three/webgpu';
import { useThree } from '@react-three/fiber';
import { FLOOR_ARENA_HOUSE_AGENTS, FLOOR_ARENA_TEMPLATES } from '@clawville/shared';
import { useStageStore } from '@/components/three/world-stage/stage-store';
import { TRADING_FLOOR_SCENE_ID } from '@/components/three/world-stage/stage-scene-id';
import { withStageSlotFrustumCullingDisabledSync } from '@/components/three/world-stage/resource-ledger';
import { useSceneCamera, useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import { chainPostBootCompile } from '@/lib/three/boot-core-compile';
import { useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { useWorldLabel, WorldLabel } from '@/lib/three/world-labels-overlay';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useGameStore } from '@/stores/game';
import { houseAgentWalkupAnchor, setHouseAgentWalkup } from '@/stores/house-agent-walkup';
import {
  TRADING_FLOOR_HOUSE_AGENT_LABEL_Y,
  TRADING_FLOOR_HOUSE_AGENT_SPOTS,
} from './trading-floor-room';
import {
  applyHouseAgentHidden,
  createHouseAgentWalkupTracker,
  HOUSE_AGENT_ALL_LABELS,
  HOUSE_AGENT_CHEST_Y,
  HOUSE_AGENTS_GLB,
  houseAgentIdle,
  houseAgentLabelTarget,
  houseAgentLabelVisible,
  houseAgentNodeName,
  houseAgentPhoneLabels,
  stepHouseAgentWalkup,
  writeHouseAgentAnchor,
  type HouseAgentPlayerRead,
} from './trading-floor-house-agents-logic';

export interface TradingFloorHouseAgentsProps {
  /** True while the Trading Floor slot owns the canvas. */
  active: boolean;
  /** The room's ONE player record (`readTradingFloorPlayer`); same object every call. */
  readPlayer: () => HouseAgentPlayerRead;
}

// ---------------------------------------------------------------------------
// Module scratch (no allocation in the frame callback)
// ---------------------------------------------------------------------------

const _chest = new THREE.Vector3();
const _view = new THREE.Vector3();
const _pose = { scaleY: 1, yaw: 0 };

function makeAnchor(x: number, y: number, z: number): RefObject<THREE.Object3D | null> {
  const anchor = new THREE.Object3D();
  anchor.position.set(x, y, z);
  anchor.matrixAutoUpdate = false;
  anchor.updateMatrix();
  anchor.updateWorldMatrix(false, false);
  return { current: anchor } as RefObject<THREE.Object3D | null>;
}

/** One fixed label anchor per agent, above its head, at the spot. */
const _labelAnchors: readonly RefObject<THREE.Object3D | null>[] = TRADING_FLOOR_HOUSE_AGENT_SPOTS.map(
  (spot) => makeAnchor(spot.x, TRADING_FLOOR_HOUSE_AGENT_LABEL_Y, spot.z),
);

type StageSnapshot = ReturnType<typeof useStageStore.getState>;

/** The slot is on screen and its warm has finished (same predicate as the late avatar). */
function houseAgentStageReady(state: StageSnapshot): boolean {
  const status = state.scenes[TRADING_FLOOR_SCENE_ID]?.status;
  return state.activeScene === TRADING_FLOOR_SCENE_ID &&
    (status === 'ready' || status === 'resident');
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** The room's capsule style (`promptCapsule` in the interior), name only. */
function nameCapsule(name: string): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        transform: 'translateY(-50%)',
      }}
    >
      <div
        style={{
          fontFamily:
            'var(--font-fraunces, "Cormorant Garamond", "Spectral", Georgia, serif)',
          fontWeight: 520,
          fontSize: 15,
          color: '#bff4ff',
          padding: '7px 15px 9px',
          borderRadius: 999,
          background: 'rgba(6, 18, 30, 0.86)',
          border: '1px solid rgba(90, 226, 255, 0.55)',
          boxShadow:
            '0 0 22px rgba(90,226,255,0.45), 0 0 60px -10px rgba(90,226,255,0.4)',
          whiteSpace: 'nowrap',
          letterSpacing: '0.02em',
          lineHeight: 1,
          userSelect: 'none',
        }}
      >
        {name}
      </div>
    </div>
  );
}

function HouseAgentLabel({ index, visible }: { index: number; visible: boolean }) {
  const { divRef, setVisible } = useWorldLabel({
    id: `trading-floor-house-agent-${index}`,
    anchorRef: _labelAnchors[index]!,
    initialVisible: false,
    occlude: false,
  });
  useEffect(() => {
    setVisible(visible);
  }, [setVisible, visible]);
  const name = FLOOR_ARENA_HOUSE_AGENTS[index]?.name ?? FLOOR_ARENA_TEMPLATES[index]?.displayName ?? '';
  return <WorldLabel divRef={divRef}>{nameCapsule(name)}</WorldLabel>;
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

function TradingFloorHouseAgentFigures({ active, readPlayer }: TradingFloorHouseAgentsProps) {
  const { scene } = useGLTFWithKTX2(HOUSE_AGENTS_GLB);
  const get = useThree((state) => state.get);
  // The slot's persistent camera, as the interior's chase camera uses.
  const slotCamera = useSceneCamera();
  const isMobile = useIsMobile();
  const canvasWidth = useThree((state) => state.size.width);

  const wrapperRef = useRef<THREE.Group | null>(null);
  const revealedRef = useRef(false);
  const [revealed, setRevealed] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const phoneRef = useRef(false);
  phoneRef.current = houseAgentPhoneLabels(isMobile, canvasWidth);
  const tracker = useMemo(() => createHouseAgentWalkupTracker(), []);
  const timeRef = useRef(0);
  const labelTargetRef = useRef(HOUSE_AGENT_ALL_LABELS);
  const [labelTarget, setLabelTarget] = useState(HOUSE_AGENT_ALL_LABELS);

  // Clone (shares geometry, material and texture with the useGLTF cache) and
  // place each node at its spot. Every matrix is then hand-driven.
  const { root, nodes } = useMemo(() => {
    const next = scene.clone(true);
    makeObject3DWebGPUSafe(next);
    next.position.set(0, 0, 0);
    next.rotation.set(0, 0, 0);
    next.scale.set(1, 1, 1);
    const found = FLOOR_ARENA_TEMPLATES.map((template, i) => {
      const node = next.getObjectByName(houseAgentNodeName(template.id)) ?? null;
      const spot = TRADING_FLOOR_HOUSE_AGENT_SPOTS[i];
      if (node && spot) {
        node.position.set(spot.x, 0, spot.z);
        node.rotation.set(0, spot.facing, 0);
        node.scale.set(1, 1, 1);
        node.visible = true;
      } else if (!node) {
        console.warn(`[TradingFloor] house-agent GLB has no node ${houseAgentNodeName(template.id)}`);
      }
      return node;
    });
    next.updateMatrixWorld(true);
    // Freeze AFTER the world update (memory gotchas/matrixautoupdate-false-before-r3f-scale-prop).
    next.traverse((object) => {
      object.matrixAutoUpdate = false;
      object.updateMatrix();
    });
    return { root: next, nodes: found };
  }, [scene]);

  // Hidden mount, compile, reveal. Mirrors `useTradingFloorAvatarWarm`.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // Keep the wrapper hidden, but compile the visible model root. An
    // invisible compile root produces an empty Three.js render list.
    wrapper.visible = false;
    revealedRef.current = false;
    let cancelled = false;
    let started = false;
    let unsubscribe: (() => void) | undefined;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      if (revealTimer !== undefined) clearTimeout(revealTimer);
      revealTimer = undefined;
      if (cancelled || revealedRef.current) return;
      wrapper.visible = true;
      revealedRef.current = true;
      setRevealed(true);
    };
    const startCompile = () => {
      if (cancelled || started) return;
      started = true;
      unsubscribe?.();
      unsubscribe = undefined;
      const { gl, camera, scene: stageScene } = get();
      if (typeof (gl as { compileAsync?: unknown }).compileAsync !== 'function') {
        reveal();
        return;
      }
      revealTimer = setTimeout(reveal, 5000);
      void chainPostBootCompile({
        gl,
        label: 'trading-floor-house-agents',
        timeoutMs: 5000,
        isCancelled: () => cancelled,
        compile: () =>
          withStageSlotFrustumCullingDisabledSync(TRADING_FLOOR_SCENE_ID, () =>
            (
              gl as unknown as {
                compileAsync: (
                  root: THREE.Object3D,
                  camera: THREE.Camera,
                  scene: THREE.Scene,
                ) => Promise<void>;
              }
            ).compileAsync(root, camera, stageScene),
          ),
      }).then(reveal, reveal);
    };
    if (houseAgentStageReady(useStageStore.getState())) startCompile();
    else {
      unsubscribe = useStageStore.subscribe((state) => {
        if (houseAgentStageReady(state)) startCompile();
      });
      if (houseAgentStageReady(useStageStore.getState())) startCompile();
    }
    return () => {
      cancelled = true;
      unsubscribe?.();
      if (revealTimer !== undefined) clearTimeout(revealTimer);
      revealTimer = undefined;
    };
  }, [get, root]);

  // Leaving the room stops this slot's frame callbacks, so close the walk-up
  // here; unmount closes it too.
  useEffect(() => {
    if (active) return;
    stepHouseAgentWalkup(tracker, readPlayer(), false, false, setHouseAgentWalkup);
    houseAgentWalkupAnchor.onScreen = false;
  }, [active, readPlayer, tracker]);
  useEffect(
    () => () => {
      // Through the tracker, so the store sees a write only on a transition.
      stepHouseAgentWalkup(tracker, readPlayer(), false, false, setHouseAgentWalkup);
      houseAgentWalkupAnchor.onScreen = false;
    },
    [readPlayer, tracker],
  );

  // Default priority: after the controller (-100), the VRM pose (-50) and the
  // body + chase camera (-40), like `TradingFloorLabels`.
  useSceneFrame((state, delta) => {
    const player = readPlayer();
    const live = activeRef.current && revealedRef.current;
    const walkup = stepHouseAgentWalkup(
      tracker,
      player,
      useGameStore.getState().exchangeOpen,
      live,
      setHouseAgentWalkup,
    );

    const camera = slotCamera;
    if (camera && revealedRef.current) {
      applyHouseAgentHidden(
        nodes,
        camera.position.x,
        camera.position.y,
        camera.position.z,
        player.x,
        player.z,
      );
    }
    if (camera && walkup >= 0) {
      const spot = TRADING_FLOOR_HOUSE_AGENT_SPOTS[walkup];
      if (spot) {
        // The chase camera moved this frame (priority -40); refresh its
        // inverse before projecting, as the label overlay does.
        camera.updateMatrixWorld();
        _chest.set(spot.x, HOUSE_AGENT_CHEST_Y, spot.z);
        _view.copy(_chest).applyMatrix4(camera.matrixWorldInverse);
        _chest.project(camera);
        const size = state.size;
        writeHouseAgentAnchor(
          houseAgentWalkupAnchor,
          _view.z,
          _view.x,
          _chest.x,
          _chest.y,
          size.width,
          size.height,
          size.left,
          size.top,
        );
      }
    }

    if (revealedRef.current) {
      timeRef.current += delta;
      const t = timeRef.current;
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const spot = TRADING_FLOOR_HOUSE_AGENT_SPOTS[i];
        if (!node || !spot) continue;
        houseAgentIdle(i, t, _pose);
        node.scale.y = _pose.scaleY;
        node.rotation.y = spot.facing + _pose.yaw;
        node.updateMatrix();
      }
    }

    const target = houseAgentLabelTarget(phoneRef.current, walkup, player.x, player.z);
    if (target !== labelTargetRef.current) {
      labelTargetRef.current = target;
      setLabelTarget(target);
    }
  });

  return (
    <>
      <group ref={wrapperRef} name="TradingFloorHouseAgents">
        <primitive object={root} />
      </group>
      {TRADING_FLOOR_HOUSE_AGENT_SPOTS.map((spot) => (
        <HouseAgentLabel
          key={spot.index}
          index={spot.index}
          visible={active && revealed && houseAgentLabelVisible(spot.index, labelTarget)}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Safe wrapper: a failed or slow load never breaks or delays the room
// ---------------------------------------------------------------------------

class TradingFloorHouseAgentsErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn('[TradingFloor] house agents failed to load; continuing without them', error);
    setHouseAgentWalkup(-1, false);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Mount point for the interior (request W2). Requests the GLB only once the
 * slot is ready or resident, then keeps it mounted for the rest of the visit
 * and while the slot stays resident.
 */
export function TradingFloorHouseAgentsSafe({ active, readPlayer }: TradingFloorHouseAgentsProps) {
  const stageReady = useStageStore(houseAgentStageReady);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (stageReady) setArmed(true);
  }, [stageReady]);
  if (!armed) return null;
  return (
    <Suspense fallback={null}>
      <TradingFloorHouseAgentsErrorBoundary>
        <TradingFloorHouseAgentFigures active={active} readPlayer={readPlayer} />
      </TradingFloorHouseAgentsErrorBoundary>
    </Suspense>
  );
}
