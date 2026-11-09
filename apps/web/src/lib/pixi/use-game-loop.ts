import { useCallback, useRef } from 'react';
import { useGameStore, avatarPositionRef, type MovementDirection } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import { clampMovement2D, ENTITY_HALF_CHIBI, ENTITY_HALF_HUMANOID } from '../three/collision/world-colliders';
import { createNavigationStep, stepNavigationPath } from '../three/navigation-path-step';
import { isWorldInputBlocked, isWorldFrameBlocked } from '../three/world-input-guard';
import { didCrossKelpForestPortal } from '../three/character-positions';
import { triggerKelpForestWalkIn } from '../three/kelp-forest-transition';
import { dispatchWorldInteraction, updateWorldProximity } from '../world-frame-interaction';
import { useStageStore } from '@/components/three/world-stage/stage-store';
import { sceneIdForPathname } from '@/components/three/world-stage/stage-scene-id';
import { useKeyboard } from './use-keyboard';
export const exploreCameraTarget = { x: 11264, y: 11264 };
export function directionForVector(x: number, y: number): MovementDirection {
  return x === 0 && y === 0 ? 'idle' : Math.abs(x) > Math.abs(y) ? x > 0 ? 'right' : 'left' : y > 0 ? 'down' : 'up';
}
export function bodyControlForMode(mode: string): 'player' | 'npc' | 'camera' | 'none' {
  return mode === 'player' ? 'player' : mode === 'npc' ? 'npc' : mode === 'explore' ? 'camera' : 'none';
}
interface GameLoopOptions { mapWidth: number; mapHeight: number; }
export function useGameLoop({ mapWidth, mapHeight }: GameLoopOptions) {
  const keyboard = useKeyboard();
  const step = useRef(createNavigationStep());
  const point = useRef({ x: 0, y: 0 });
  const previousMode = useRef('');
  return useCallback((delta: number) => {
    const store = useGameStore.getState();
    const mode = bodyControlForMode(store.controlMode);
    // Consume edges even on a blocked frame. They must not fire on panel close.
    const escape = keyboard.wasJustPressed('escape'), interact = keyboard.wasJustPressed('e');
    if (previousMode.current !== store.controlMode) {
      if (mode === 'camera') { exploreCameraTarget.x = avatarPositionRef.x; exploreCameraTarget.y = avatarPositionRef.y; }
      if (mode === 'camera' || mode === 'none') { store.setNearLocation(null); store.setNearCharacter(null); store.setNearGuide(false); }
      previousMode.current = store.controlMode;
    }
    if (mode === 'none') {
      const body = useNpcStore.getState().npcs.find((n) => n.id === store.autonomousBodyId);
      if (body && Math.hypot(body.x - avatarPositionRef.x, body.y - avatarPositionRef.y) > 2) store.setAvatarPosition(body.x, body.y);
      store.setMovementDirection('idle'); return;
    }
    const stage = useStageStore.getState();
    if ((typeof window !== 'undefined' && sceneIdForPathname(window.location.pathname) !== 'world') || isWorldFrameBlocked() || stage.renderPaused || (stage.transition && stage.transition.phase !== 'idle')) { store.setMovementDirection('idle'); return; }
    const npc = mode === 'npc' ? useNpcStore.getState().npcs.find((n) => n.id === store.possessedNpcId) : undefined;
    if (mode === 'npc' && !npc) return;
    const position = mode === 'camera' ? exploreCameraTarget : npc ?? avatarPositionRef;
    if (mode !== 'camera') updateWorldProximity(position.x - mapWidth / 2, position.y - mapHeight / 2, mode === 'npc');
    if (escape) { if (store.chatOpen) store.exitBuilding(); else if (store.guideChatOpen) store.closeGuideChat(); }
    if (store.movementFrozen) { store.setMovementDirection('idle'); return; }
    if (interact && !isWorldInputBlocked() && mode !== 'camera' && dispatchWorldInteraction()) return;
    let vx = Number(keyboard.isDown('d') || keyboard.isDown('arrowright')) - Number(keyboard.isDown('a') || keyboard.isDown('arrowleft'));
    let vy = Number(keyboard.isDown('s') || keyboard.isDown('arrowdown')) - Number(keyboard.isDown('w') || keyboard.isDown('arrowup'));
    if (vx && vy) { vx *= Math.SQRT1_2; vy *= Math.SQRT1_2; }
    const joystick = store.joystickVelocity;
    if (joystick.x || joystick.y) { vx = joystick.x; vy = joystick.y; }
    if (isWorldInputBlocked()) { vx = 0; vy = 0; }
    const running = keyboard.isDown('shift') || Math.hypot(joystick.x, joystick.y) > 0.7;
    const budget = 550 * (running ? 2.025 : 1) * Math.min(delta / 60, 0.1);
    const move = (x: number, y: number, tx: number, ty: number) => {
      tx = Math.max(16, Math.min(mapWidth - 16, tx)); ty = Math.max(16, Math.min(mapHeight - 16, ty));
      const clamped = clampMovement2D(x - mapWidth / 2, y - mapHeight / 2, tx - mapWidth / 2, ty - mapHeight / 2, mode === 'npc' ? ENTITY_HALF_HUMANOID : ENTITY_HALF_CHIBI);
      point.current.x = clamped.x + mapWidth / 2; point.current.y = clamped.z + mapHeight / 2;
      return point.current;
    };
    const x = position.x, y = position.y;
    let nx = x, ny = y, complete = false;
    const target = store.clickPathTarget;
    if ((vx || vy) && store.clickPath) store.clearClickPath();
    if (mode !== 'camera' && !vx && !vy && store.clickPath?.length) {
      const result = stepNavigationPath(store.clickPath, store.clickPathIndex, x, y, budget, move, step.current, 6);
      nx = result.x; ny = result.y; complete = result.complete;
      if (result.index !== store.clickPathIndex) useGameStore.setState({ clickPathIndex: result.index });
    } else if (mode === 'camera') {
      nx = Math.max(16, Math.min(mapWidth - 16, x + vx * budget)); ny = Math.max(16, Math.min(mapHeight - 16, y + vy * budget));
    } else { const result = move(x, y, x + vx * budget, y + vy * budget); nx = result.x; ny = result.y; }
    const direction = directionForVector(nx - x, ny - y);
    store.setMovementDirection(direction);
    if (mode === 'camera') { exploreCameraTarget.x = nx; exploreCameraTarget.y = ny; return; }
    if (npc) useNpcStore.getState().moveNpc(npc.id, nx, ny, direction, null, running);
    store.setAvatarPosition(nx, ny);
    updateWorldProximity(nx - mapWidth / 2, ny - mapHeight / 2, mode === 'npc');
    if (complete) { store.clearClickPath(); dispatchWorldInteraction(target); }
    if (didCrossKelpForestPortal(x - mapWidth / 2, y - mapHeight / 2, nx - mapWidth / 2, ny - mapHeight / 2)) triggerKelpForestWalkIn();
  }, [keyboard, mapWidth, mapHeight]);
}
