import { useRef, useCallback } from 'react';
import { useGameStore } from '@/stores/game';

const LERP_FACTOR = 0.1;

interface CameraState {
  x: number;
  y: number;
}

/**
 * Camera hook that smoothly follows the avatar position.
 * Returns a function to call each frame that returns the camera offset.
 * Scale-aware: adjusts viewport bounds based on world scale.
 */
export function useCamera(mapWidth: number, mapHeight: number, viewWidth: number, viewHeight: number) {
  const cameraRef = useRef<CameraState>({ x: 0, y: 0 });

  const update = useCallback(() => {
    const { avatarPosition } = useGameStore.getState();
    const cam = cameraRef.current;

    // Account for viewport scaling
    const scale = Math.max(viewWidth / mapWidth, viewHeight / mapHeight);
    const effectiveViewWidth = viewWidth / scale;
    const effectiveViewHeight = viewHeight / scale;

    // Target: center the avatar in viewport
    const targetX = avatarPosition.x - effectiveViewWidth / 2;
    const targetY = avatarPosition.y - effectiveViewHeight / 2;

    // Smooth lerp
    cam.x += (targetX - cam.x) * LERP_FACTOR;
    cam.y += (targetY - cam.y) * LERP_FACTOR;

    // Clamp to map bounds (using effective viewport size)
    const maxX = Math.max(0, mapWidth - effectiveViewWidth);
    const maxY = Math.max(0, mapHeight - effectiveViewHeight);
    cam.x = Math.max(0, Math.min(maxX, cam.x));
    cam.y = Math.max(0, Math.min(maxY, cam.y));

    return { x: -cam.x, y: -cam.y };
  }, [mapWidth, mapHeight, viewWidth, viewHeight]);

  return update;
}
