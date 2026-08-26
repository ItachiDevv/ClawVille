'use client';

import {
  createContext,
  createElement,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  useFrame,
  useStore,
  type RenderCallback,
} from '@react-three/fiber';
import type { Camera } from 'three';
import {
  DEFAULT_PLAYER_CAPABILITIES,
  type PlayerCapabilityMask,
} from '@/lib/three/player/player-capability-mask';
import { CURRENT_WORLD_DEVICE_PROFILE } from '@/lib/three/device-class';
import { useStageStore } from './stage-store';

type CallbackRef = { current: RenderCallback };
type SceneRegistration = { ref: CallbackRef; priority: number };

const SceneIdContext = createContext<string | null>(null);
// The slot's PERSISTENT camera. The R3F default camera is a stage-swapped
// resource (StageCameraCoordinator reassigns it on every activation), so any
// controller that must bind "this scene's camera" reads THIS context instead
// of the default camera — otherwise it can rebind to another slot's camera
// during the swap window (the 2026-08-08 kelp OrbitControls fight).
const SceneCameraContext = createContext<Camera | null>(null);
const SlotCapabilityContext = createContext<PlayerCapabilityMask>(
  DEFAULT_PLAYER_CAPABILITIES,
);
const callbacksByScene = new Map<string, Map<symbol, SceneRegistration>>();
// Dispatch iterates a priority-sorted snapshot (ascending, matching R3F's
// subscriber ordering so a legacy `useFrame(cb, -100)` owner keeps running
// before priority-0 owners after the sweep). Rebuilt lazily on registration
// change — never per frame.
const sortedByScene = new Map<string, SceneRegistration[]>();

function invalidateSceneOrder(sceneId: string): void {
  sortedByScene.delete(sceneId);
}

function getSceneDispatchOrder(
  sceneId: string,
): SceneRegistration[] | undefined {
  const cached = sortedByScene.get(sceneId);
  if (cached) return cached;
  const registrations = callbacksByScene.get(sceneId);
  if (!registrations) return undefined;
  const sorted = [...registrations.values()].sort(
    (a, b) => a.priority - b.priority,
  );
  sortedByScene.set(sceneId, sorted);
  return sorted;
}
const frameInvocationsByScene = new Map<string, number>();
let lastFrameSampleAt = 0;
let clampNextFrameDelta = false;

function readFpsCap(): number | null {
  if (typeof window !== 'undefined') {
    const override = new URLSearchParams(window.location.search).get('fpscap');
    if (override === '0') return null;
    if (override === '60') return 60;
  }
  return CURRENT_WORLD_DEVICE_PROFILE.fpsCap;
}

const STAGE_FPS_CAP = readFpsCap();
const STAGE_FRAME_INTERVAL_MS =
  STAGE_FPS_CAP === null ? 0 : 1_000 / STAGE_FPS_CAP;
// Native 30/60 Hz presentation deltas commonly land just below their nominal
// interval. This keeps a 33.0 ms phone cadence from alternating into 15 FPS.
const STAGE_FRAME_TOLERANCE_MS = 1;

export function requestStageDeltaClamp(): void {
  clampNextFrameDelta = true;
}

export function resetStageFrameDiagnostics(): void {
  frameInvocationsByScene.clear();
  lastFrameSampleAt = 0;
  clampNextFrameDelta = false;
}

export function readStageFrameInvocations(): Record<string, number> {
  return Object.fromEntries(frameInvocationsByScene);
}

export function SceneIdProvider({
  sceneId,
  children,
}: {
  sceneId: string;
  children: ReactNode;
}) {
  return createElement(
    SceneIdContext.Provider,
    { value: sceneId },
    children,
  );
}

export function useSceneId(): string | null {
  return useContext(SceneIdContext);
}

export function SceneCameraProvider({
  camera,
  children,
}: {
  camera: Camera | null;
  children: ReactNode;
}): ReactElement {
  return createElement(
    SceneCameraContext.Provider,
    { value: camera },
    children,
  );
}

/** The slot's persistent camera; null outside a stage slot (legacy canvases). */
export function useSceneCamera(): Camera | null {
  return useContext(SceneCameraContext);
}

export function SlotCapabilityProvider({
  capabilities,
  children,
}: {
  capabilities: PlayerCapabilityMask;
  children: ReactNode;
}): ReactElement {
  return createElement(
    SlotCapabilityContext.Provider,
    { value: capabilities },
    children,
  );
}

export function useSlotCapabilities(): PlayerCapabilityMask {
  return useContext(SlotCapabilityContext);
}

export function useSceneActive(): boolean {
  const sceneId = useSceneId();
  const active = useStageStore(
    (state) =>
      sceneId === null ||
      state.activeScene === sceneId ||
      (state.activeScene === null &&
        state.pendingRequest?.sceneId === sceneId),
  );
  return sceneId === null || active;
}

export function useSceneFrame(
  callback: RenderCallback,
  priority?: number,
): void;
export function useSceneFrame(
  sceneId: string,
  callback: RenderCallback,
  priority?: number,
): void;
export function useSceneFrame(
  sceneIdOrCallback: string | RenderCallback,
  callbackOrPriority?: RenderCallback | number,
  maybePriority?: number,
): void {
  const contextSceneId = useSceneId();
  const explicitSceneId =
    typeof sceneIdOrCallback === 'string' ? sceneIdOrCallback : null;
  const sceneId = explicitSceneId ?? contextSceneId;
  const callback =
    typeof sceneIdOrCallback === 'string'
      ? (callbackOrPriority as RenderCallback | undefined)
      : sceneIdOrCallback;
  const priority =
    typeof sceneIdOrCallback === 'string'
      ? maybePriority ?? 0
      : typeof callbackOrPriority === 'number'
        ? callbackOrPriority
        : 0;
  const callbackRef = useRef<RenderCallback>(() => undefined);
  callbackRef.current = callback ?? (() => undefined);
  const legacyStore = useStore();
  const subscribeLegacy =
    legacyStore.getState().internal.subscribe;

  // Outside a stage slot there is no central scheduler. Keep the legacy
  // Canvas contract through R3F's native subscriber list (including the
  // caller's render priority — controllers rely on negative priority to run
  // before the follow camera). Stage-hosted owners never enter that list at
  // all; only StageFrameScheduler is subscribed, so a hidden resident slot
  // has zero native callback dispatch overhead.
  useLayoutEffect(() => {
    if (sceneId !== null) return;
    return subscribeLegacy(callbackRef, priority, legacyStore);
  }, [legacyStore, priority, sceneId, subscribeLegacy]);

  useLayoutEffect(() => {
    if (sceneId === null) return;
    const registrationId = Symbol(sceneId);
    let sceneCallbacks = callbacksByScene.get(sceneId);
    if (!sceneCallbacks) {
      sceneCallbacks = new Map();
      callbacksByScene.set(sceneId, sceneCallbacks);
    }
    sceneCallbacks.set(registrationId, { ref: callbackRef, priority });
    invalidateSceneOrder(sceneId);

    return () => {
      const registeredCallbacks = callbacksByScene.get(sceneId);
      registeredCallbacks?.delete(registrationId);
      if (registeredCallbacks?.size === 0) {
        callbacksByScene.delete(sceneId);
      }
      invalidateSceneOrder(sceneId);
    };
  }, [priority, sceneId]);
}

export function StageFrameScheduler(): null {
  const queuedAckRef = useRef<string | null>(null);
  const accumulatedFrameMsRef = useRef(0);

  useFrame((state, delta, frame) => {
    let scheduledDelta = delta;
    if (STAGE_FPS_CAP !== null) {
      if (clampNextFrameDelta) {
        // Admit one recovery frame without carrying a background-tab backlog
        // into the following simulation ticks.
        accumulatedFrameMsRef.current = STAGE_FRAME_INTERVAL_MS;
      } else {
        accumulatedFrameMsRef.current = Math.min(
          accumulatedFrameMsRef.current + delta * 1_000,
          STAGE_FRAME_INTERVAL_MS * 2,
        );
      }
      if (
        accumulatedFrameMsRef.current + STAGE_FRAME_TOLERANCE_MS <
        STAGE_FRAME_INTERVAL_MS
      ) {
        return;
      }
      scheduledDelta = accumulatedFrameMsRef.current / 1_000;
      accumulatedFrameMsRef.current = Math.max(
        0,
        accumulatedFrameMsRef.current - STAGE_FRAME_INTERVAL_MS,
      );
    }

    const controlledDelta = clampNextFrameDelta
      ? Math.min(scheduledDelta, 1 / 60)
      : scheduledDelta;
    clampNextFrameDelta = false;
    const snapshot = useStageStore.getState();
    const sceneId = snapshot.activeScene;
    if (!sceneId) {
      // During a pending transition StageSceneSlot deliberately exposes the
      // requested slot while activeScene is null. The old native R3F loop still
      // presented that state, so the scheduler-owned loop must do the same.
      state.gl.render(state.scene, state.camera);
      return;
    }

    const dispatchOrder = getSceneDispatchOrder(sceneId);
    let scheduledRenderOwner = false;
    if (dispatchOrder) {
      for (const registration of dispatchOrder) {
        if (registration.priority > 0) scheduledRenderOwner = true;
        registration.ref.current(state, controlledDelta, frame);
        frameInvocationsByScene.set(
          sceneId,
          (frameInvocationsByScene.get(sceneId) ?? 0) + 1,
        );
      }
    }

    // Positive priority makes this scheduler R3F's render owner. The same
    // timestamp admission therefore gates both scene JS and presentation. A
    // positive-priority scene registration (the opt-in meshlet renderer) owns
    // its own draw, matching R3F's ordinary render-priority contract.
    if (!scheduledRenderOwner) {
      state.gl.render(state.scene, state.camera);
    }

    const now = performance.now();
    if (now - lastFrameSampleAt >= 250) {
      lastFrameSampleAt = now;
      useStageStore
        .getState()
        .sampleFrameInvocations({
          [sceneId]: frameInvocationsByScene.get(sceneId) ?? 0,
        });
    }

    const currentState = useStageStore.getState();
    const request = currentState.pendingRequest;
    const cameraInstalled = currentState.cameraInstalled;
    const firstFrame = currentState.firstControlledFrame;
    if (
      !request ||
      request.sceneId !== sceneId ||
      cameraInstalled?.sceneId !== sceneId ||
      cameraInstalled.generation !== request.generation ||
      (firstFrame?.sceneId === sceneId &&
        firstFrame.generation === request.generation)
    ) {
      return;
    }

    const ackKey = `${request.requestId}:${sceneId}:${request.generation}`;
    if (queuedAckRef.current === ackKey) return;
    queuedAckRef.current = ackKey;

    // R3F renders immediately after the frame-subscriber pass. Deferring the
    // acknowledgement to the microtask queue proves that one controlled frame
    // completed instead of merely proving that its callback began.
    queueMicrotask(() => {
      const current = useStageStore.getState().pendingRequest;
      if (
        current?.requestId === request.requestId &&
        current.sceneId === sceneId &&
        current.generation === request.generation
      ) {
        useStageStore
          .getState()
          .ackFirstControlledFrame(sceneId, request.generation);
      }
      if (queuedAckRef.current === ackKey) {
        queuedAckRef.current = null;
      }
    });
  }, 1);

  return null;
}
