import { useCallback } from 'react';
import { useGameStore, avatarPositionRef, type MovementDirection } from '@/stores/game';
import { isKelpForestPortalProximate } from '@/lib/three/character-positions';
import { triggerKelpForestWalkIn } from '@/lib/three/kelp-forest-transition';
import { useKeyboard } from './use-keyboard';

const SPEED = 200; // pixels per second
const DIAGONAL_FACTOR = Math.SQRT1_2;

interface GameLoopOptions {
  mapWidth: number;
  mapHeight: number;
  buildingZones: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  isSpectator?: boolean;
}

/**
 * Game loop hook — call the returned function each frame via useTick.
 * Handles movement, zone detection, and building entry/exit.
 * In spectator mode: WASD moves camera target, no avatar physics or building interaction.
 */
export function useGameLoop({ mapWidth, mapHeight, buildingZones, isSpectator = false }: GameLoopOptions) {
  const keyboard = useKeyboard();

  const tick = useCallback(
    (delta: number) => {
      const store = useGameStore.getState();

      if (isSpectator) {
        // Spectator mode: move the avatarPosition as a "camera target" with WASD
        let vx = 0;
        let vy = 0;
        if (keyboard.isDown('w') || keyboard.isDown('arrowup')) vy = -1;
        if (keyboard.isDown('s') || keyboard.isDown('arrowdown')) vy = 1;
        if (keyboard.isDown('a') || keyboard.isDown('arrowleft')) vx = -1;
        if (keyboard.isDown('d') || keyboard.isDown('arrowright')) vx = 1;

        if (vx !== 0 && vy !== 0) {
          vx *= DIAGONAL_FACTOR;
          vy *= DIAGONAL_FACTOR;
        }

        // Merge joystick input
        const { joystickVelocity } = store;
        if (joystickVelocity.x !== 0 || joystickVelocity.y !== 0) {
          vx = joystickVelocity.x;
          vy = joystickVelocity.y;
        }

        if (vx === 0 && vy === 0) {
          store.setMovementDirection('idle');
          return;
        }

        // Set direction for camera info
        let dir: MovementDirection = 'idle';
        if (Math.abs(vx) > Math.abs(vy)) {
          dir = vx > 0 ? 'right' : 'left';
        } else {
          dir = vy > 0 ? 'down' : 'up';
        }
        store.setMovementDirection(dir);

        const dt = delta / 60;
        let newX = avatarPositionRef.x + vx * SPEED * dt;
        let newY = avatarPositionRef.y + vy * SPEED * dt;
        newX = Math.max(16, Math.min(mapWidth - 16, newX));
        newY = Math.max(16, Math.min(mapHeight - 16, newY));
        store.setAvatarPosition(newX, newY);
        return;
      }

      // ---- Normal (non-spectator) mode ----

      // Handle Escape to exit building
      if (keyboard.wasJustPressed('escape') && store.chatOpen) {
        store.exitBuilding();
        return;
      }

      // Skip movement when frozen
      if (store.movementFrozen) return;

      // Handle E to enter a building or walk-in venue.
      if (keyboard.wasJustPressed('e') && store.nearLocation) {
        if (store.nearLocation === 'kelp-forest-portal') {
          triggerKelpForestWalkIn();
        } else {
          store.enterBuilding(store.nearLocation);
        }
        return;
      }

      // Movement input (keyboard)
      let vx = 0;
      let vy = 0;
      if (keyboard.isDown('w') || keyboard.isDown('arrowup')) vy = -1;
      if (keyboard.isDown('s') || keyboard.isDown('arrowdown')) vy = 1;
      if (keyboard.isDown('a') || keyboard.isDown('arrowleft')) vx = -1;
      if (keyboard.isDown('d') || keyboard.isDown('arrowright')) vx = 1;

      // Normalize diagonal for keyboard
      if (vx !== 0 && vy !== 0) {
        vx *= DIAGONAL_FACTOR;
        vy *= DIAGONAL_FACTOR;
      }

      // Merge joystick input (overrides keyboard when active)
      const { joystickVelocity } = store;
      if (joystickVelocity.x !== 0 || joystickVelocity.y !== 0) {
        vx = joystickVelocity.x;
        vy = joystickVelocity.y;
      }

      // Determine direction for sprite animation
      let dir: MovementDirection = 'idle';
      if (vx !== 0 || vy !== 0) {
        if (Math.abs(vx) > Math.abs(vy)) {
          dir = vx > 0 ? 'right' : 'left';
        } else {
          dir = vy > 0 ? 'down' : 'up';
        }
      }
      store.setMovementDirection(dir);

      if (vx === 0 && vy === 0) return;

      // Apply velocity (delta is in frames at 60fps, so delta/60 gives seconds)
      const dt = delta / 60;
      let newX = avatarPositionRef.x + vx * SPEED * dt;
      let newY = avatarPositionRef.y + vy * SPEED * dt;

      // Clamp to map bounds (with 16px margin for avatar size)
      newX = Math.max(16, Math.min(mapWidth - 16, newX));
      newY = Math.max(16, Math.min(mapHeight - 16, newY));

      store.setAvatarPosition(newX, newY);

      // Zone overlap detection
      let nearZone: string | null = null;
      for (const zone of buildingZones) {
        if (
          newX >= zone.x &&
          newX <= zone.x + zone.width &&
          newY >= zone.y &&
          newY <= zone.y + zone.height
        ) {
          nearZone = zone.id;
          break;
        }
      }
      if (
        nearZone === null
        && isKelpForestPortalProximate(newX - mapWidth / 2, newY - mapHeight / 2)
      ) {
        nearZone = 'kelp-forest-portal';
      }
      if (nearZone !== store.nearLocation) {
        store.setNearLocation(nearZone);
      }
    },
    [keyboard, mapWidth, mapHeight, buildingZones, isSpectator]
  );

  return tick;
}
