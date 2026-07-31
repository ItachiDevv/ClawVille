'use client';

import { create } from 'zustand';

export type StageSceneStatus =
  | 'unrequested'
  | 'loading'
  | 'warming'
  | 'ready'
  | 'resident'
  | 'evicted'
  | 'error';

export type StageTransitionPhase =
  | 'idle'
  | 'fadingOut'
  | 'awaiting'
  | 'fadingIn'
  | 'error';

export interface StageSceneSlot {
  status: StageSceneStatus;
  generation: number;
  frameInvocations: number;
  hasEverActivated: boolean;
}

export interface StageRecoverySnapshot {
  count: number;
  lastReason: string | null;
}

export interface StageRequest {
  sceneId: string;
  generation: number;
  requestId: number;
  retryOfRequestId?: number;
}

interface StageGenerationAck {
  sceneId: string;
  generation: number;
}

interface StageTransitionSnapshot extends StageRequest {
  phase: StageTransitionPhase;
  error: string | null;
}

interface StageStore {
  scenes: Record<string, StageSceneSlot>;
  activeScene: string | null;
  stageEpoch: number;
  requestSequence: number;
  pendingRequest: StageRequest | null;
  transition: StageTransitionSnapshot | null;
  cameraInstalled: StageGenerationAck | null;
  firstControlledFrame: StageGenerationAck | null;
  canvasMountCount: number;
  windowListenerCount: number;
  listenerUnderflowCount: number;
  transitionErrors: readonly string[];
  recovery: StageRecoverySnapshot;
  renderPaused: boolean;
  outgoingOverlay: {
    pathname: string;
    href: string;
    requestId: number;
    status: 'holding' | 'timed-out';
  } | null;
  activityTarget: { roomKey: string } | null;
  registerScenes: (sceneIds: readonly string[]) => void;
  requestScene: (sceneId: string) => void;
  retryStageScene: (previous: StageRequest) => boolean;
  setSceneWarming: (sceneId: string, generation: number) => void;
  ackReady: (sceneId: string, generation: number) => void;
  activateScene: (request: StageRequest) => void;
  ackCameraInstalled: (sceneId: string, generation: number) => void;
  ackFirstControlledFrame: (sceneId: string, generation: number) => void;
  setTransitionPhase: (
    requestId: number,
    phase: StageTransitionPhase,
  ) => void;
  completeTransition: (request: StageRequest) => void;
  failTransition: (request: StageRequest, message: string) => void;
  sampleFrameInvocations: (
    samples: Readonly<Record<string, number>>,
  ) => void;
  noteCanvasMount: () => void;
  adjustWindowListenerCount: (delta: number) => void;
  noteRecovery: (reason: string) => void;
  setRenderPaused: (paused: boolean) => void;
  setOutgoingOverlay: (entry: {
    pathname: string;
    href: string;
    requestId: number;
  }) => void;
  markOutgoingOverlayTimedOut: (requestId: number) => void;
  clearOutgoingOverlay: (requestId: number) => void;
  setActivityTarget: (target: { roomKey: string }) => void;
  clearActivityTarget: () => void;
  resetStage: () => void;
}

const createSceneSlot = (): StageSceneSlot => ({
  status: 'unrequested',
  generation: 0,
  frameInvocations: 0,
  hasEverActivated: false,
});

const createInitialState = (stageEpoch = 0) => ({
  scenes: {} as Record<string, StageSceneSlot>,
  activeScene: null as string | null,
  stageEpoch,
  requestSequence: 0,
  pendingRequest: null as StageRequest | null,
  transition: null as StageTransitionSnapshot | null,
  cameraInstalled: null as StageGenerationAck | null,
  firstControlledFrame: null as StageGenerationAck | null,
  canvasMountCount: 0,
  windowListenerCount: 0,
  listenerUnderflowCount: 0,
  transitionErrors: [] as readonly string[],
  recovery: {
    count: 0,
    lastReason: null,
  } as StageRecoverySnapshot,
  renderPaused: false,
  outgoingOverlay: null as StageStore['outgoingOverlay'],
  activityTarget: null as StageStore['activityTarget'],
});

function isCurrentRequest(
  pendingRequest: StageRequest | null,
  request: StageRequest,
): boolean {
  return (
    pendingRequest?.requestId === request.requestId &&
    pendingRequest.sceneId === request.sceneId &&
    pendingRequest.generation === request.generation
  );
}

export const useStageStore = create<StageStore>((set, get) => ({
  ...createInitialState(),

  registerScenes: (sceneIds) => {
    set((state) => {
      let changed = false;
      const scenes = { ...state.scenes };
      for (const sceneId of sceneIds) {
        if (scenes[sceneId]) continue;
        scenes[sceneId] = createSceneSlot();
        changed = true;
      }
      return changed ? { scenes } : state;
    });
  },

  requestScene: (sceneId) => {
    set((state) => {
      const scenes = { ...state.scenes };
      const abandonedRequest = state.pendingRequest;
      if (
        abandonedRequest &&
        abandonedRequest.sceneId !== sceneId
      ) {
        const abandonedSlot = scenes[abandonedRequest.sceneId];
        if (
          abandonedSlot &&
          abandonedSlot.generation === abandonedRequest.generation
        ) {
          scenes[abandonedRequest.sceneId] = {
            ...abandonedSlot,
            status:
              state.activeScene === abandonedRequest.sceneId
                ? 'resident'
                : 'unrequested',
            generation: abandonedSlot.generation + 1,
          };
        }
      }

      const previous = scenes[sceneId] ?? createSceneSlot();
      const generation = previous.generation + 1;
      const requestId = state.requestSequence + 1;
      const request = { sceneId, generation, requestId };

      return {
        scenes: {
          ...scenes,
          [sceneId]: {
            ...previous,
            status: 'loading',
            generation,
          },
        },
        pendingRequest: request,
        requestSequence: requestId,
        transition: {
          ...request,
          phase: 'fadingOut',
          error: null,
        },
        cameraInstalled: null,
        firstControlledFrame: null,
        renderPaused: false,
      };
    });
  },

  retryStageScene: (previous) => {
    let retried = false;
    set((state) => {
      if (!isCurrentRequest(state.pendingRequest, previous)) return state;
      const slot = state.scenes[previous.sceneId];
      if (!slot || slot.generation !== previous.generation) return state;

      const generation = slot.generation + 1;
      const requestId = state.requestSequence + 1;
      const request: StageRequest = {
        sceneId: previous.sceneId,
        generation,
        requestId,
        retryOfRequestId: previous.requestId,
      };
      retried = true;
      return {
        scenes: {
          ...state.scenes,
          [previous.sceneId]: {
            ...slot,
            status: 'loading',
            generation,
          },
        },
        pendingRequest: request,
        requestSequence: requestId,
        transition: {
          ...request,
          phase: 'fadingOut',
          error: null,
        },
        cameraInstalled: null,
        firstControlledFrame: null,
        renderPaused: false,
      };
    });
    return retried;
  },

  setSceneWarming: (sceneId, generation) => {
    set((state) => {
      const slot = state.scenes[sceneId];
      const request = state.pendingRequest;
      if (
        !slot ||
        slot.generation !== generation ||
        request?.sceneId !== sceneId ||
        request.generation !== generation
      ) {
        return state;
      }
      return {
        scenes: {
          ...state.scenes,
          [sceneId]: {
            ...slot,
            status: 'warming',
          },
        },
      };
    });
  },

  ackReady: (sceneId, generation) => {
    set((state) => {
      const slot = state.scenes[sceneId];
      const request = state.pendingRequest;
      if (
        !slot ||
        slot.generation !== generation ||
        request?.sceneId !== sceneId ||
        request.generation !== generation
      ) {
        return state;
      }
      return {
        scenes: {
          ...state.scenes,
          [sceneId]: {
            ...slot,
            status: 'ready',
          },
        },
      };
    });
  },

  activateScene: (request) => {
    set((state) => {
      if (!isCurrentRequest(state.pendingRequest, request)) return state;

      const scenes = { ...state.scenes };
      const previousActive = state.activeScene;
      if (previousActive && previousActive !== request.sceneId) {
        const previousSlot = scenes[previousActive];
        if (previousSlot && previousSlot.status !== 'evicted') {
          scenes[previousActive] = {
            ...previousSlot,
            status: 'resident',
          };
        }
      }

      return {
        scenes,
        activeScene: request.sceneId,
        activityTarget:
          request.sceneId === 'activity' ? state.activityTarget : null,
      };
    });
  },

  ackCameraInstalled: (sceneId, generation) => {
    set((state) => {
      const request = state.pendingRequest;
      if (
        request?.sceneId !== sceneId ||
        request.generation !== generation
      ) {
        return state;
      }
      return { cameraInstalled: { sceneId, generation } };
    });
  },

  ackFirstControlledFrame: (sceneId, generation) => {
    set((state) => {
      const request = state.pendingRequest;
      if (
        request?.sceneId !== sceneId ||
        request.generation !== generation ||
        state.cameraInstalled?.sceneId !== sceneId ||
        state.cameraInstalled.generation !== generation
      ) {
        return state;
      }
      return { firstControlledFrame: { sceneId, generation } };
    });
  },

  setTransitionPhase: (requestId, phase) => {
    set((state) => {
      if (!state.transition || state.transition.requestId !== requestId) {
        return state;
      }
      return {
        transition: {
          ...state.transition,
          phase,
        },
      };
    });
  },

  completeTransition: (request) => {
    set((state) => {
      if (!isCurrentRequest(state.pendingRequest, request)) return state;
      if (!state.transition || state.transition.requestId !== request.requestId) {
        return state;
      }
      const slot = state.scenes[request.sceneId];
      if (!slot || slot.generation !== request.generation) return state;
      return {
        scenes: {
          ...state.scenes,
          [request.sceneId]: {
            ...slot,
            status: 'resident',
            hasEverActivated: true,
          },
        },
        pendingRequest: null,
        transition: {
          ...state.transition,
          phase: 'idle',
          error: null,
        },
      };
    });
  },

  failTransition: (request, message) => {
    set((state) => {
      if (!isCurrentRequest(state.pendingRequest, request)) return state;
      const slot = state.scenes[request.sceneId];
      if (!slot || slot.generation !== request.generation) return state;

      return {
        scenes: {
          ...state.scenes,
          [request.sceneId]: {
            ...slot,
            status: 'error',
          },
        },
        transition: {
          ...request,
          phase: 'error',
          error: message,
        },
        transitionErrors: [
          ...state.transitionErrors,
          `${request.sceneId}@${request.generation}#${request.requestId}: ${message}`,
        ],
      };
    });
  },

  sampleFrameInvocations: (samples) => {
    set((state) => {
      let changed = false;
      const scenes = { ...state.scenes };
      for (const [sceneId, frameInvocations] of Object.entries(samples)) {
        const slot = scenes[sceneId];
        if (!slot || slot.frameInvocations === frameInvocations) continue;
        scenes[sceneId] = {
          ...slot,
          frameInvocations,
        };
        changed = true;
      }
      if (!changed) return state;
      return {
        scenes,
      };
    });
  },

  noteCanvasMount: () => {
    set((state) => ({ canvasMountCount: state.canvasMountCount + 1 }));
  },

  adjustWindowListenerCount: (delta) => {
    if (delta === 0) return;
    set((state) => {
      const windowListenerCount =
        state.windowListenerCount + delta;
      return {
        windowListenerCount,
        listenerUnderflowCount:
          state.listenerUnderflowCount +
          (windowListenerCount < 0 ? 1 : 0),
      };
    });
  },

  noteRecovery: (reason) => {
    set((state) => ({
      recovery: {
        count: state.recovery.count + 1,
        lastReason: reason,
      },
    }));
  },

  setRenderPaused: (paused) => {
    if (get().renderPaused === paused) return;
    set({ renderPaused: paused });
  },

  setOutgoingOverlay: (entry) => {
    set({
      outgoingOverlay: {
        ...entry,
        status: 'holding',
      },
    });
  },

  markOutgoingOverlayTimedOut: (requestId) => {
    set((state) =>
      state.outgoingOverlay?.requestId === requestId
        ? {
            outgoingOverlay: {
              ...state.outgoingOverlay,
              status: 'timed-out',
            },
          }
        : state,
    );
  },

  clearOutgoingOverlay: (requestId) => {
    set((state) =>
      state.outgoingOverlay?.requestId === requestId
        ? { outgoingOverlay: null }
        : state,
    );
  },

  setActivityTarget: (target) => {
    set({ activityTarget: target });
  },

  clearActivityTarget: () => {
    set({ activityTarget: null });
  },

  resetStage: () => {
    set((state) => createInitialState(state.stageEpoch + 1));
  },
}));

export function requestStageScene(sceneId: string): void {
  useStageStore.getState().requestScene(sceneId);
}

export function retryStageScene(previous: StageRequest): boolean {
  return useStageStore.getState().retryStageScene(previous);
}

export function resetStageStore(): void {
  useStageStore.getState().resetStage();
}

export function addStageWindowListener<K extends keyof WindowEventMap>(
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): () => void {
  return addStageEventListener(
    window,
    type,
    listener as EventListener,
    options,
  );
}

export function addStageEventListener(
  target: EventTarget,
  type: string,
  listener: EventListener,
  options?: boolean | AddEventListenerOptions,
): () => void {
  target.addEventListener(type, listener, options);
  useStageStore.getState().adjustWindowListenerCount(1);
  let attached = true;

  return () => {
    if (!attached) return;
    attached = false;
    target.removeEventListener(type, listener, options);
    useStageStore.getState().adjustWindowListenerCount(-1);
  };
}
