import { useRef, useCallback } from 'react';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import { exploreCameraTarget } from './use-game-loop';
import { pixiWorldScale } from './pixi-world-scale';
export function useCamera(mapWidth: number, mapHeight: number, viewWidth: number, viewHeight: number) {
  const camera = useRef({ x: 0, y: 0, initialized: false });
  const viewport = useRef({ viewWidth, viewHeight }); viewport.current = { viewWidth, viewHeight };
  return useCallback(() => {
    const state = useGameStore.getState(), cam = camera.current;
    const focus = state.consumeCameraFocus();
    const npc = state.controlMode === 'autonomous' ? useNpcStore.getState().npcs.find((n) => n.id === state.autonomousBodyId)
      : state.controlMode === 'npc' ? useNpcStore.getState().npcs.find((n) => n.id === state.possessedNpcId) : undefined;
    if (focus && state.controlMode === 'explore') { exploreCameraTarget.x = focus.x; exploreCameraTarget.y = focus.y; }
    const target = focus ?? (state.controlMode === 'explore' ? exploreCameraTarget : npc ?? avatarPositionRef);
    const { viewWidth: w, viewHeight: h } = viewport.current, scale = pixiWorldScale(w, h);
    const tx = Math.max(0, Math.min(mapWidth - w / scale, target.x - w / scale / 2));
    const ty = Math.max(0, Math.min(mapHeight - h / scale, target.y - h / scale / 2));
    const blend = focus || !cam.initialized ? 1 : 0.16;
    cam.x += (tx - cam.x) * blend; cam.y += (ty - cam.y) * blend; cam.initialized = true;
    return { x: -cam.x, y: -cam.y };
  }, [mapWidth, mapHeight]);
}
