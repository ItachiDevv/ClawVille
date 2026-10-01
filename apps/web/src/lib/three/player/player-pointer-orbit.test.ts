import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useStageStore } from '@/components/three/world-stage/stage-store';
import { resetAllHeldInputs } from '@/lib/three/input-reset';
import { DEFAULT_PLAYER_CAPABILITIES, resolvePlayerCapabilities } from './player-capability-mask';
import {
  attachPlayerPointerOrbit,
  createPlayerPointerOrbitState,
  pointerOrbitRadians,
  pointerOrbitClickAllowed,
  POINTER_ORBIT_SLOP_PX,
  POINTER_ORBIT_DESKTOP_SPEED,
  POINTER_ORBIT_TOUCH_SPEED,
  POINTER_ORBIT_TOUCH_SLOP_PX,
} from './player-pointer-orbit';

class FakeTarget extends EventTarget {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    super.addEventListener(type, listener, options);
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    super.removeEventListener(type, listener, options);
    if (listener) this.listeners.get(type)?.delete(listener);
  }
  get listenerCount() {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}

class FakeElement extends FakeTarget {
  style = { touchAction: 'pan-y' };
  clientHeight = 600;
  captured: number | null = null;
  captureCalls = 0;
  setPointerCapture(id: number) { this.captured = id; this.captureCalls++; }
  hasPointerCapture(id: number) { return this.captured === id; }
  releasePointerCapture(_id: number) { this.captured = null; }
}

function pointer(type: string, x: number, y = 0, pointerId = 1, pointerType = 'mouse', button = 0, buttons = 1) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, pointerId, pointerType, button, buttons });
  return event;
}

const detachments: Array<() => void> = [];
afterEach(() => { while (detachments.length) detachments.pop()!(); });

function attach() {
  const element = new FakeElement();
  const windowTarget = new FakeTarget();
  const state = createPlayerPointerOrbitState();
  let blocked = false;
  const controller = attachPlayerPointerOrbit(element as unknown as HTMLElement, state, {
    isBlocked: () => blocked,
    windowTarget,
  });
  detachments.push(controller.detach);
  return { element, windowTarget, state, controller, block: () => { blocked = true; } };
}

describe('pointer orbit mapping', () => {
  test('uses OrbitControls height scale and touch speed', () => {
    expect(pointerOrbitRadians(600, 600, POINTER_ORBIT_DESKTOP_SPEED)).toBeCloseTo(2 * Math.PI);
    expect(pointerOrbitRadians(600, 600, POINTER_ORBIT_TOUCH_SPEED)).toBeCloseTo(0.8 * Math.PI);
    expect(pointerOrbitRadians(-10, 600, 1)).toBeCloseTo(-Math.PI / 30);
    expect(pointerOrbitRadians(10, 0, 1)).toBe(0);
  });

  test('right drag turns the room forward vector toward positive X', () => {
    const yaw = pointerOrbitRadians(60, 600, 1);
    // At yaw=0 the room looks down -Z and camera-right is +X.
    const forwardX = Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    expect(yaw).toBeGreaterThan(0);
    expect(forwardX).toBeGreaterThan(0);
    expect(forwardZ).toBeLessThan(0);
    expect(Math.atan2(forwardX, -forwardZ)).toBeCloseTo(yaw);
    expect(pointerOrbitRadians(60, 600, 1)).toBeGreaterThan(0); // down raises pitch/height
  });
});

describe('pointer orbit lifecycle', () => {
  test('3 px remains a click, 4 px stays within slop, 5 px captures and rotates', () => {
    const { element, windowTarget, state } = attach();
    const down = pointer('pointerdown', 0);
    element.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    windowTarget.dispatchEvent(pointer('pointermove', 3));
    expect(state.dragging).toBe(false);
    expect(state.yawRad).toBe(0);
    windowTarget.dispatchEvent(pointer('pointermove', POINTER_ORBIT_SLOP_PX));
    expect(element.captureCalls).toBe(0);
    windowTarget.dispatchEvent(pointer('pointermove', 5));
    expect(state.dragging).toBe(true);
    expect(element.captured).toBe(1);
    expect(state.yawRad).toBeCloseTo(pointerOrbitRadians(5, 600, 1));
    state.yawRad = state.pitchRad = 0; // Camera drains once per frame.
    windowTarget.dispatchEvent(pointer('pointermove', 8, 7));
    expect(state.yawRad).toBeCloseTo(pointerOrbitRadians(3, 600, 1));
    expect(state.pitchRad).toBeCloseTo(pointerOrbitRadians(7, 600, 1));
    windowTarget.dispatchEvent(pointer('pointerup', 8, 7));
    expect(state.pointerId).toBeNull();
    expect(state.dragging).toBe(false);
    expect(element.captured).toBeNull();
    expect(state.yawRad).not.toBe(0); // Do not lose a drag between camera frames.
  });

  test('slop uses distance on both axes', () => {
    const { element, windowTarget, state } = attach();
    element.dispatchEvent(pointer('pointerdown', 0));
    windowTarget.dispatchEvent(pointer('pointermove', 3, 3));
    expect(state.dragging).toBe(true);
  });

  test('a return-to-start drag suppresses the click after pointerup until the next pointerdown', () => {
    const { element, windowTarget, state } = attach();
    element.dispatchEvent(pointer('pointerdown', 0));
    windowTarget.dispatchEvent(pointer('pointermove', 4));
    expect(pointerOrbitClickAllowed(state.clickSuppressed)).toBe(true);
    windowTarget.dispatchEvent(pointer('pointermove', 4.1));
    expect(state.dragging).toBe(true);
    windowTarget.dispatchEvent(pointer('pointermove', 0));
    windowTarget.dispatchEvent(pointer('pointerup', 0));
    expect(state.dragging).toBe(false);
    expect(pointerOrbitClickAllowed(state.clickSuppressed)).toBe(false);
    element.dispatchEvent(pointer('pointerdown', 0));
    windowTarget.dispatchEvent(pointer('pointermove', 3));
    windowTarget.dispatchEvent(pointer('pointerup', 3));
    expect(pointerOrbitClickAllowed(state.clickSuppressed)).toBe(true);
  });

  for (const pointerType of ['touch', 'pen']) {
    test(`${pointerType} uses 10 px slop and retains implicit capture`, () => {
      const { element, windowTarget, state } = attach();
      element.dispatchEvent(pointer('pointerdown', 0, 0, 1, pointerType));
      windowTarget.dispatchEvent(pointer('pointermove', POINTER_ORBIT_TOUCH_SLOP_PX, 0, 1, pointerType));
      expect(state.dragging).toBe(false);
      expect(state.clickSuppressed).toBe(false);
      windowTarget.dispatchEvent(pointer('pointermove', 11, 0, 1, pointerType));
      expect(state.dragging).toBe(true);
      expect(state.clickSuppressed).toBe(true);
      expect(element.captureCalls).toBe(0);
      const lostCapture = [...element.listeners.get('lostpointercapture')!][0] as EventListener;
      lostCapture({ pointerId: 1, target: new FakeElement() } as unknown as PointerEvent);
      expect(state.dragging).toBe(true);
      windowTarget.dispatchEvent(pointer('pointermove', 160, 0, 1, pointerType));
      expect(state.yawRad).toBeCloseTo(pointerOrbitRadians(160, 600, pointerType === 'touch' ? 0.4 : 1));
      lostCapture({ pointerId: 2, target: element } as unknown as PointerEvent);
      expect(state.dragging).toBe(true);
      lostCapture({ pointerId: 1, target: element } as unknown as PointerEvent);
      expect(state).toEqual(createPlayerPointerOrbitState());
    });

    for (const type of ['pointerup', 'pointercancel']) {
      test(`${pointerType} ${type} ends only the active pointer`, () => {
        const { element, windowTarget, state } = attach();
        element.dispatchEvent(pointer('pointerdown', 0, 0, 1, pointerType));
        windowTarget.dispatchEvent(pointer('pointermove', 20, 0, 1, pointerType));
        windowTarget.dispatchEvent(pointer(type, 20, 0, 2, pointerType));
        expect(state.dragging).toBe(true);
        windowTarget.dispatchEvent(pointer(type, 20, 0, 1, pointerType));
        expect(state.dragging).toBe(false);
        expect(state.pointerId).toBeNull();
        expect(state.yawRad === 0).toBe(type === 'pointercancel');
      });
    }
  }

  test('mouse movement without the left button ends a stuck drag without losing pending yaw', () => {
    const { element, windowTarget, state } = attach();
    element.dispatchEvent(pointer('pointerdown', 0));
    windowTarget.dispatchEvent(pointer('pointermove', 10));
    const yaw = state.yawRad;
    windowTarget.dispatchEvent(pointer('pointermove', 20, 0, 1, 'mouse', 0, 0));
    expect(state.pointerId).toBeNull();
    expect(state.dragging).toBe(false);
    expect(state.yawRad).toBe(yaw);
    expect(state.clickSuppressed).toBe(true);
    expect(element.captured).toBeNull();
  });

  test('ignores blocked pointerdown and clears an active drag when blocked', () => {
    const first = attach();
    first.block();
    first.element.dispatchEvent(pointer('pointerdown', 0));
    first.windowTarget.dispatchEvent(pointer('pointermove', 20));
    expect(first.state.pointerId).toBeNull();
    expect(first.state.yawRad).toBe(0);
    const second = attach();
    second.element.dispatchEvent(pointer('pointerdown', 0));
    second.windowTarget.dispatchEvent(pointer('pointermove', 20));
    expect(second.state.yawRad).toBeGreaterThan(0);
    second.block();
    second.windowTarget.dispatchEvent(pointer('pointermove', 30));
    expect(second.state.yawRad).toBe(0);
    expect(second.state.pitchRad).toBe(0);
    expect(second.state.dragging).toBe(false);
    expect(second.element.captured).toBeNull();
  });

  test('touch uses 0.4 speed and only the first canvas pointer', () => {
    const { element, windowTarget, state } = attach();
    element.dispatchEvent(pointer('pointerdown', 0, 0, 1, 'touch'));
    element.dispatchEvent(pointer('pointerdown', 100, 100, 2, 'touch'));
    windowTarget.dispatchEvent(pointer('pointermove', 120, 120, 2, 'touch'));
    windowTarget.dispatchEvent(pointer('pointerup', 120, 120, 2, 'touch'));
    expect(state.pointerId).toBe(1);
    expect(state.yawRad).toBe(0);
    windowTarget.dispatchEvent(pointer('pointermove', 10, 20, 1, 'touch'));
    expect(state.yawRad).toBeCloseTo(pointerOrbitRadians(10, 600, 0.4));
    expect(state.pitchRad).toBeCloseTo(pointerOrbitRadians(20, 600, 0.4));
  });

  test('other controls cannot start a canvas gesture; right button cannot rotate', () => {
    const { element, windowTarget, state } = attach();
    windowTarget.dispatchEvent(pointer('pointerdown', 0, 0, 1, 'touch'));
    windowTarget.dispatchEvent(pointer('pointermove', 20, 0, 1, 'touch'));
    element.dispatchEvent(pointer('pointerdown', 0, 0, 1, 'mouse', 2));
    windowTarget.dispatchEvent(pointer('pointermove', 20));
    expect(state.pointerId).toBeNull();
    expect(state.yawRad).toBe(0);
  });

  for (const type of ['pointercancel', 'lostpointercapture', 'blur', 'input-reset']) {
    test(`${type} resets capture and pending movement`, () => {
      const { element, windowTarget, state } = attach();
      element.dispatchEvent(pointer('pointerdown', 0));
      windowTarget.dispatchEvent(pointer('pointermove', 10, 10));
      if (type === 'input-reset') resetAllHeldInputs();
      else (type === 'lostpointercapture' ? element : windowTarget).dispatchEvent(pointer(type, 10));
      expect(state).toEqual(createPlayerPointerOrbitState());
      expect(element.captured).toBeNull();
    });
  }

  test('detach restores touch-action, removes all listeners and unregisters reset', () => {
    const baseline = useStageStore.getState().windowListenerCount;
    const { element, windowTarget, state, controller } = attach();
    expect(element.style.touchAction).toBe('none');
    expect(element.listenerCount).toBe(2);
    expect(windowTarget.listenerCount).toBe(4);
    expect(useStageStore.getState().windowListenerCount).toBe(baseline + 6);
    element.dispatchEvent(pointer('pointerdown', 0));
    windowTarget.dispatchEvent(pointer('pointermove', 10));
    controller.detach();
    expect(element.style.touchAction).toBe('pan-y');
    expect(element.listenerCount + windowTarget.listenerCount).toBe(0);
    expect(useStageStore.getState().windowListenerCount).toBe(baseline);
    expect(element.captured).toBeNull();
    element.dispatchEvent(pointer('pointerdown', 0));
    windowTarget.dispatchEvent(pointer('pointermove', 10));
    expect(state).toEqual(createPlayerPointerOrbitState());
    state.yawRad = 1;
    resetAllHeldInputs();
    expect(state.yawRad).toBe(1); // Detached reset callback cannot touch this state.
  });
});

test('cameraOrbitDrag defaults false and only the Trading Floor slot enables it', () => {
  expect(DEFAULT_PLAYER_CAPABILITIES.cameraOrbitDrag).toBe(false);
  expect(resolvePlayerCapabilities().cameraOrbitDrag).toBe(false);
  expect(resolvePlayerCapabilities({ cameraOrbitDrag: true }).cameraOrbitDrag).toBe(true);
  const source = readFileSync(join(import.meta.dir, '../../../components/three/world-stage/WorldStageRoot.tsx'), 'utf8');
  const enables = [...source.matchAll(/cameraOrbitDrag:\s*true/g)];
  expect(enables).toHaveLength(1);
  const prefix = source.slice(0, enables[0]!.index);
  expect(prefix.slice(prefix.lastIndexOf('sceneId:')).split('\n')[0]).toBe('sceneId: TRADING_FLOOR_SCENE_ID,');
});
