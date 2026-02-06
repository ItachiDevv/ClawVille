import { useRef, useCallback } from 'react';
import { useGameStore } from '@/stores/game';

const LERP_FACTOR = 0.1;

interface CameraState {
  x: number;
  y: number;
}

/**
 * Camera hook that smoothly follows the pet position.
 * Returns a function to call each frame that returns the camera offset.
 */
export function useCamera(mapWidth: number, mapHeight: number, viewWidth: number, viewHeight: number) {
  const cameraRef = useRef<CameraState>({ x: 0, y: 0 });

  const update = useCallback(() => {
    const { petPosition } = useGameStore.getState();
    const cam = cameraRef.current;

    // Target: center the pet in viewport
    const targetX = petPosition.x - viewWidth / 2;
    const targetY = petPosition.y - viewHeight / 2;

    // Smooth lerp
    cam.x += (targetX - cam.x) * LERP_FACTOR;
    cam.y += (targetY - cam.y) * LERP_FACTOR;

    // Clamp to map bounds
    const maxX = Math.max(0, mapWidth - viewWidth);
    const maxY = Math.max(0, mapHeight - viewHeight);
    cam.x = Math.max(0, Math.min(maxX, cam.x));
    cam.y = Math.max(0, Math.min(maxY, cam.y));

    return { x: -cam.x, y: -cam.y };
  }, [mapWidth, mapHeight, viewWidth, viewHeight]);

  return update;
}
