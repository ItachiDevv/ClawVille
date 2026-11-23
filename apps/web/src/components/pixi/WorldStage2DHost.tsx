'use client';
import { useCallback, useEffect } from 'react';
import PixiCanvas from './PixiCanvas';
import { useStageStore } from '@/components/three/world-stage/stage-store';
import { notePixiFirstFrame } from '@/lib/world-renderer-mode';
/** Called only after the Pixi camera and world controller finish a frame. */
export function acknowledgePixiFrame(): void {
  const state = useStageStore.getState(), request = state.pendingRequest;
  if (!request || request.sceneId !== 'world') return;
  const slot = state.scenes.world;
  if (slot?.generation !== request.generation) return;
  if (slot.status === 'loading') state.setSceneWarming('world', request.generation);
  if (slot.status !== 'ready') state.ackReady('world', request.generation);
  if (state.cameraInstalled?.generation !== request.generation || state.cameraInstalled.sceneId !== 'world') state.ackCameraInstalled('world', request.generation);
  if (state.firstControlledFrame?.generation !== request.generation || state.firstControlledFrame.sceneId !== 'world') state.ackFirstControlledFrame('world', request.generation);
}
export default function WorldStage2DHost({ onFailure }: { onFailure?: () => void }) {
  useEffect(() => { useStageStore.getState().registerScenes(['world']); useStageStore.getState().setRenderPaused(false); }, []);
  const mounted = useCallback(() => useStageStore.getState().noteCanvasMount(), []);
  const frame = useCallback(() => { notePixiFirstFrame(); acknowledgePixiFrame(); }, []);
  return <PixiCanvas onFrame={frame} onMount={mounted} onFailure={onFailure} />;
}
