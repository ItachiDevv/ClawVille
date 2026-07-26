'use client';

import {
  createContext,
  createElement,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react';
import {
  useFrame,
  useStore,
  type RenderCallback,
} from '@react-three/fiber';
import { useStageStore } from './stage-store';

type CallbackRef = { current: RenderCallback };

const SceneIdContext = createContext<string | null>(null);
const callbacksByScene = new Map<string, Map<symbol, CallbackRef>>();
const frameInvocationsByScene = new Map<string, number>();
let lastFrameSampleAt = 0;
let clampNextFrameDelta = false;

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

export function useSceneFrame(callback: RenderCallback): void;
export function useSceneFrame(
  sceneId: string,
  callback: RenderCallback,
): void;
export function useSceneFrame(
  sceneIdOrCallback: string | RenderCallback,
  maybeCallback?: RenderCallback,
): void {
  const contextSceneId = useSceneId();
  const sceneId =
    typeof sceneIdOrCallback === 'string'
      ? sceneIdOrCallback
      : contextSceneId;
  const callback =
    typeof sceneIdOrCallback === 'string'
      ? maybeCallback
      : sceneIdOrCallback;
  const callbackRef = useRef<RenderCallback>(() => undefined);
  callbackRef.current = callback ?? (() => undefined);
  const legacyStore = useStore();
  const subscribeLegacy =
    legacyStore.getState().internal.subscribe;

  // Outside a stage slot there is no central scheduler. Keep the legacy
  // Canvas contract through R3F's native subscriber list. Stage-hosted owners
  // never enter that list at all; only StageFrameScheduler is subscribed, so
  // a hidden resident slot has zero native callback dispatch overhead.
  useLayoutEffect(() => {
    if (sceneId !== null) return;
    return subscribeLegacy(callbackRef, 0, legacyStore);
  }, [legacyStore, sceneId, subscribeLegacy]);

  useLayoutEffect(() => {
    if (sceneId === null) return;
    const registrationId = Symbol(sceneId);
    let sceneCallbacks = callbacksByScene.get(sceneId);
    if (!sceneCallbacks) {
      sceneCallbacks = new Map();
      callbacksByScene.set(sceneId, sceneCallbacks);
    }
    sceneCallbacks.set(registrationId, callbackRef);

    return () => {
      const registeredCallbacks = callbacksByScene.get(sceneId);
      registeredCallbacks?.delete(registrationId);
      if (registeredCallbacks?.size === 0) {
        callbacksByScene.delete(sceneId);
      }
    };
  }, [sceneId]);
}

export function StageFrameScheduler(): null {
  const queuedAckRef = useRef<string | null>(null);

  useFrame((state, delta, frame) => {
    const controlledDelta = clampNextFrameDelta
      ? Math.min(delta, 1 / 60)
      : delta;
    clampNextFrameDelta = false;
    const snapshot = useStageStore.getState();
    const sceneId = snapshot.activeScene;
    if (!sceneId) return;

    const callbacks = callbacksByScene.get(sceneId);
    if (callbacks) {
      for (const callbackRef of callbacks.values()) {
        callbackRef.current(state, controlledDelta, frame);
        frameInvocationsByScene.set(
          sceneId,
          (frameInvocationsByScene.get(sceneId) ?? 0) + 1,
        );
      }
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
  });

  return null;
}
