import { addStageEventListener } from '@/components/three/world-stage/stage-store';
import { registerInputReset } from '@/lib/three/input-reset';

export const POINTER_ORBIT_SLOP_PX = 4;
export const POINTER_ORBIT_DESKTOP_SPEED = 1;
export const POINTER_ORBIT_TOUCH_SPEED = 0.4;

/** OrbitControls uses element height for BOTH axes. Positive yaw looks right. */
export function pointerOrbitRadians(pixels: number, clientHeight: number, rotateSpeed: number): number {
  return clientHeight > 0 ? 2 * Math.PI * pixels * rotateSpeed / clientHeight : 0;
}

export function pointerOrbitClickAllowed(delta: number): boolean {
  return delta <= POINTER_ORBIT_SLOP_PX;
}

/** Also protect the last movement drained after pointerup, before the next frame. */
export function pointerOrbitYawEaseAllowed(keyYaw: number, dragging: boolean, yawRad: number): boolean {
  return Math.abs(keyYaw) < 1e-3 && !dragging && yawRad === 0;
}

export interface PlayerPointerOrbitState {
  pointerId: number | null;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragging: boolean;
  yawRad: number;
  pitchRad: number;
}

export function createPlayerPointerOrbitState(): PlayerPointerOrbitState {
  return {
    pointerId: null, startX: 0, startY: 0, lastX: 0, lastY: 0,
    dragging: false, yawRad: 0, pitchRad: 0,
  };
}

export function attachPlayerPointerOrbit(
  element: HTMLElement,
  state: PlayerPointerOrbitState,
  config: {
    isBlocked: () => boolean;
    rotateSpeed?: number;
    windowTarget?: EventTarget;
  },
): { reset: () => void; detach: () => void } {
  const target = config.windowTarget ?? window;
  const previousTouchAction = element.style.touchAction;
  element.style.touchAction = 'none';
  let rotateSpeed = config.rotateSpeed ?? POINTER_ORBIT_DESKTOP_SPEED;

  const endGesture = () => {
    const pointerId = state.pointerId;
    state.pointerId = null;
    state.startX = state.startY = state.lastX = state.lastY = 0;
    state.dragging = false;
    if (pointerId !== null && element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  };
  const reset = () => {
    endGesture();
    state.yawRad = state.pitchRad = 0;
  };
  const onDown = (event: PointerEvent) => {
    if (config.isBlocked() || state.pointerId !== null ||
        (event.pointerType !== 'touch' && event.button !== 0)) return;
    state.pointerId = event.pointerId;
    state.startX = state.lastX = event.clientX;
    state.startY = state.lastY = event.clientY;
    rotateSpeed = event.pointerType === 'touch'
      ? POINTER_ORBIT_TOUCH_SPEED
      : config.rotateSpeed ?? POINTER_ORBIT_DESKTOP_SPEED;
    // Do not preventDefault: R3F still needs pointerdown for plain clicks.
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== state.pointerId) return;
    if (config.isBlocked()) { reset(); return; }
    if (!state.dragging) {
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (dx * dx + dy * dy <= POINTER_ORBIT_SLOP_PX * POINTER_ORBIT_SLOP_PX) return;
      state.dragging = true;
      element.setPointerCapture(event.pointerId);
    }
    state.yawRad += pointerOrbitRadians(event.clientX - state.lastX, element.clientHeight, rotateSpeed);
    state.pitchRad += pointerOrbitRadians(event.clientY - state.lastY, element.clientHeight, rotateSpeed);
    state.lastX = event.clientX;
    state.lastY = event.clientY;
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== state.pointerId) return;
    if (config.isBlocked()) reset();
    else endGesture(); // Keep undrained movement until the next camera frame.
  };
  const onCancel = (event: PointerEvent) => {
    if (event.pointerId === state.pointerId) reset();
  };
  reset();
  const removers = [
    addStageEventListener(element, 'pointerdown', onDown as EventListener),
    addStageEventListener(target, 'pointermove', onMove as EventListener, { capture: true }),
    addStageEventListener(target, 'pointerup', onUp as EventListener),
    addStageEventListener(target, 'pointercancel', onCancel as EventListener),
    addStageEventListener(element, 'lostpointercapture', onCancel as EventListener),
    addStageEventListener(target, 'blur', reset),
    registerInputReset(reset),
  ];
  return {
    reset,
    detach: () => {
      for (const remove of removers) remove();
      reset();
      element.style.touchAction = previousTouchAction;
    },
  };
}
