import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetDecorativeReleaseForTests,
  armDecorativeDeadline,
  armDecorativeReleaseOnFirstPaint,
  decorativeReleasedAt,
  decorativeReleaseReason,
  isDecorativeReleased,
  notifyWorldFramePresented,
  onDecorativeRelease,
  onDecorativeReleaseStaggered,
  releaseDecorative,
} from './decorative-release';

/**
 * DOM scaffolding: the controller reads document.hidden, the cold-boot
 * loading overlay (.claw-loading-overlay), and the stage transition curtain
 * ([data-stage-transition] + computed opacity). Tests drive those three
 * surfaces through a minimal mutable stub.
 */
type DomState = {
  hidden: boolean;
  overlayPresent: boolean;
  transitionPhase: string | null;
  transitionOpacity: string;
};

const dom: DomState = {
  hidden: false,
  overlayPresent: false,
  transitionPhase: null,
  transitionOpacity: '0.5',
};

const originalWindow = (globalThis as any).window;
const originalDocument = (globalThis as any).document;
const pendingTimers: Array<() => void> = [];
const timerDelays: number[] = [];
function flushOneTimer(): void {
  const fn = pendingTimers.shift();
  if (fn) fn();
}

function installDom(): void {
  const transitionElement = {
    dataset: {
      get stageTransition() {
        return dom.transitionPhase ?? undefined;
      },
    },
  };
  (globalThis as any).document = {
    get hidden() {
      return dom.hidden;
    },
    querySelector(selector: string) {
      if (selector === '.claw-loading-overlay') {
        return dom.overlayPresent ? {} : null;
      }
      if (selector === '[data-stage-transition]') {
        return dom.transitionPhase === null ? null : transitionElement;
      }
      return null;
    },
  };
  (globalThis as any).window = {
    __W3D_READY: undefined,
    getComputedStyle: () => ({ opacity: dom.transitionOpacity }),
    // stagger scheduler: drain via microtask-free deterministic timer stub
    setTimeout: (fn: () => void, delayMs?: number) => {
      pendingTimers.push(fn);
      timerDelays.push(delayMs ?? 0);
      return pendingTimers.length;
    },
  };
}

function setReady(ready: boolean): void {
  (globalThis as any).window.__W3D_READY = ready;
}

beforeEach(() => {
  pendingTimers.length = 0;
  timerDelays.length = 0;
  dom.hidden = false;
  dom.overlayPresent = false;
  dom.transitionPhase = null;
  dom.transitionOpacity = '0.5';
  installDom();
  __resetDecorativeReleaseForTests();
});

afterEach(() => {
  __resetDecorativeReleaseForTests();
  (globalThis as any).window = originalWindow;
  (globalThis as any).document = originalDocument;
});

describe('decorative-release first-paint anchor', () => {
  test('does not release without an arm, however many frames present', () => {
    setReady(true);
    for (let i = 0; i < 10; i += 1) notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(false);
  });

  test('releases on the second qualifying frame with first-paint reason', () => {
    setReady(true);
    armDecorativeReleaseOnFirstPaint('warmup-complete');
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(false);
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(true);
    expect(decorativeReleaseReason()).toBe('first-paint:warmup-complete');
    expect(decorativeReleasedAt()).not.toBeNull();
  });

  test('keeps the FIRST armed reason when several milestones arm', () => {
    setReady(true);
    armDecorativeReleaseOnFirstPaint('stage-ready');
    armDecorativeReleaseOnFirstPaint('warmup-complete');
    notifyWorldFramePresented();
    notifyWorldFramePresented();
    expect(decorativeReleaseReason()).toBe('first-paint:stage-ready');
  });

  test('overlay present blocks the release and resets the qualifier run', () => {
    setReady(true);
    armDecorativeReleaseOnFirstPaint('resume');
    dom.overlayPresent = true;
    notifyWorldFramePresented();
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(false);
    dom.overlayPresent = false;
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(false); // run restarted — 1 of 2
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(true);
  });

  test('an overlay remount between qualifying frames re-gates (no cache)', () => {
    setReady(true);
    armDecorativeReleaseOnFirstPaint('resume');
    notifyWorldFramePresented(); // 1 qualifying
    dom.overlayPresent = true; // loader remounts
    notifyWorldFramePresented(); // resets run
    dom.overlayPresent = false;
    notifyWorldFramePresented(); // 1 of 2 again
    expect(isDecorativeReleased()).toBe(false);
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(true);
  });

  test('hidden document blocks and resets', () => {
    setReady(true);
    armDecorativeReleaseOnFirstPaint('resume');
    notifyWorldFramePresented();
    dom.hidden = true;
    notifyWorldFramePresented();
    dom.hidden = false;
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(false);
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(true);
  });

  test('READY false blocks regardless of frames', () => {
    setReady(false);
    armDecorativeReleaseOnFirstPaint('resume');
    for (let i = 0; i < 5; i += 1) notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(false);
  });

  test('opaque stage transition blocks; visibly-fading-in transition passes', () => {
    setReady(true);
    armDecorativeReleaseOnFirstPaint('stage-ready');
    dom.transitionPhase = 'awaiting';
    notifyWorldFramePresented();
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(false);
    dom.transitionPhase = 'fadingIn';
    dom.transitionOpacity = '1';
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(false);
    dom.transitionOpacity = '0.4';
    notifyWorldFramePresented();
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(true);
  });

  test('idle transition phase does not block', () => {
    setReady(true);
    armDecorativeReleaseOnFirstPaint('resume');
    dom.transitionPhase = 'idle';
    notifyWorldFramePresented();
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(true);
  });

  test('one-shot: further arms and frames after release are no-ops', () => {
    setReady(true);
    armDecorativeReleaseOnFirstPaint('resume');
    notifyWorldFramePresented();
    notifyWorldFramePresented();
    const at = decorativeReleasedAt();
    armDecorativeReleaseOnFirstPaint('warmup-complete');
    notifyWorldFramePresented();
    expect(decorativeReleasedAt()).toBe(at);
    expect(decorativeReleaseReason()).toBe('first-paint:resume');
  });

  test('late subscribers after release fire synchronously', () => {
    setReady(true);
    armDecorativeReleaseOnFirstPaint('resume');
    notifyWorldFramePresented();
    notifyWorldFramePresented();
    let fired = false;
    onDecorativeRelease(() => {
      fired = true;
    });
    expect(fired).toBe(true);
  });

  test('direct releaseDecorative (deadline path) still works before any arm', () => {
    let fired = false;
    onDecorativeRelease(() => {
      fired = true;
    });
    releaseDecorative('absolute-deadline');
    expect(fired).toBe(true);
    expect(isDecorativeReleased()).toBe(true);
    // frames after a deadline release stay no-ops
    setReady(true);
    notifyWorldFramePresented();
    expect(decorativeReleaseReason()).toBe('absolute-deadline');
  });

  test('deadline armed after release does not re-arm a timer', () => {
    releaseDecorative('test');
    armDecorativeDeadline(); // must be a no-op (released short-circuit)
    expect(isDecorativeReleased()).toBe(true);
  });

  test('staggered listeners drain one per tick, in subscription order', () => {
    setReady(true);
    const fired: string[] = [];
    onDecorativeReleaseStaggered(() => fired.push('a'));
    onDecorativeReleaseStaggered(() => fired.push('b'));
    armDecorativeReleaseOnFirstPaint('resume');
    notifyWorldFramePresented();
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(true);
    expect(fired).toEqual([]); // nothing synchronous on the release frame
    flushOneTimer();
    expect(fired).toEqual(['a']);
    flushOneTimer();
    expect(fired).toEqual(['a', 'b']);
  });

  test('staggered unsubscribe before delivery removes the listener', () => {
    setReady(true);
    const fired: string[] = [];
    onDecorativeReleaseStaggered(() => fired.push('a'));
    const offB = onDecorativeReleaseStaggered(() => fired.push('b'));
    onDecorativeReleaseStaggered(() => fired.push('c'));
    releaseDecorative('test');
    offB();
    flushOneTimer();
    flushOneTimer();
    flushOneTimer();
    expect(fired).toEqual(['a', 'c']);
  });

  test('unsubscribing the first (already-scheduled) staggered item cancels it', () => {
    releaseDecorative('test');
    const fired: string[] = [];
    const offA = onDecorativeReleaseStaggered(() => fired.push('a'));
    onDecorativeReleaseStaggered(() => fired.push('b'));
    offA(); // 'a' is scheduled first — unsubscribe must still cancel it
    flushOneTimer();
    flushOneTimer();
    expect(fired).toEqual(['b']);
  });

  test('stagger priority drains ascending, ties by subscription order', () => {
    releaseDecorative('test');
    const fired: string[] = [];
    onDecorativeReleaseStaggered(() => fired.push('far'), 9000);
    onDecorativeReleaseStaggered(() => fired.push('bulk'), Number.POSITIVE_INFINITY);
    onDecorativeReleaseStaggered(() => fired.push('near'), 100);
    onDecorativeReleaseStaggered(() => fired.push('near2'), 100);
    for (let i = 0; i < 4; i += 1) flushOneTimer();
    expect(fired).toEqual(['near', 'near2', 'far', 'bulk']);
  });

  test('staggered subscribe after release still delivers via the queue', () => {
    releaseDecorative('test');
    const fired: string[] = [];
    onDecorativeReleaseStaggered(() => fired.push('late'));
    expect(fired).toEqual([]);
    flushOneTimer();
    expect(fired).toEqual(['late']);
  });

  test('first stagger drain waits the quiet period; later drains use idle ticks', () => {
    releaseDecorative('test');
    const fired: string[] = [];
    onDecorativeReleaseStaggered(() => fired.push('a'));
    onDecorativeReleaseStaggered(() => fired.push('b'));
    // first drain scheduled with the 1500ms quiet period
    expect(timerDelays[0]).toBe(1500);
    flushOneTimer();
    expect(fired).toEqual(['a']);
    // second drain uses the fast fallback tick (120ms in the no-rIC stub)
    expect(timerDelays[1]).toBe(120);
    flushOneTimer();
    expect(fired).toEqual(['a', 'b']);
  });

  test('reset restores the first-drain quiet period', () => {
    releaseDecorative('test');
    onDecorativeReleaseStaggered(() => undefined);
    expect(timerDelays[0]).toBe(1500);
    flushOneTimer();
    __resetDecorativeReleaseForTests();
    timerDelays.length = 0;
    pendingTimers.length = 0;
    releaseDecorative('test-2');
    onDecorativeReleaseStaggered(() => undefined);
    expect(timerDelays[0]).toBe(1500); // quiet period restored after reset
  });

  test('REGRESSION: release between render and effect cannot strand a consumer', () => {
    // Simulates the bulk-consumer sequence: initial state read false, the
    // release fires BEFORE the effect subscribes, then the effect subscribes
    // based on LOCAL state (released=false) — the staggered subscribe must
    // still deliver via the queue (Codex final-review HIGH).
    setReady(true);
    const localReleasedAtRender = isDecorativeReleased();
    expect(localReleasedAtRender).toBe(false);
    releaseDecorative('between-render-and-effect');
    let delivered = false;
    // effect body under the FIXED pattern: local state false -> subscribe
    onDecorativeReleaseStaggered(() => {
      delivered = true;
    });
    flushOneTimer();
    expect(delivered).toBe(true);
  });

  test('test reset clears the first-paint state machine', () => {
    setReady(true);
    armDecorativeReleaseOnFirstPaint('resume');
    notifyWorldFramePresented();
    __resetDecorativeReleaseForTests();
    // after reset: not armed, one frame run must not release even when armed late
    armDecorativeReleaseOnFirstPaint('resume');
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(false);
    notifyWorldFramePresented();
    expect(isDecorativeReleased()).toBe(true);
  });
});
