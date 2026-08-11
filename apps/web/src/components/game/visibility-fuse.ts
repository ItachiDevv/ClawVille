/**
 * Visibility-gated one-shot fuse (rung-4 task 6, founder decision (a),
 * 2026-08-10): a countdown that consumes only VISIBLE time.
 *
 * Used by SeaLoadingScreen's force-dismiss ceiling: a boot opened in a
 * background tab PARKS on its first rAF await (by design — browsers throttle
 * hidden tabs), and a wall-clock fuse would expire while parked, so
 * foregrounding showed raw world assembly with no loading UI. This fuse
 * pauses while `document` is hidden and resumes with the banked remainder.
 *
 * Contract (Codex R19 decisions-review finding 1 — the fuse is TERMINAL):
 * - `onFire` is invoked at most ONCE; firing disposes the fuse.
 * - `dispose()` is idempotent, removes the visibility listener, cancels any
 *   pending timer, and permanently prevents re-arming — callers invoke it
 *   from EVERY other dismissal path so no background timers survive.
 * - If constructed while hidden, nothing runs until the first `visible`
 *   transition, which arms with the FULL budget.
 *
 * Injectable clock/timers/document for deterministic tests.
 */

export interface VisibilityFuseDeps {
  readonly now: () => number;
  readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn: (handle: unknown) => void;
  readonly doc: Pick<
    Document,
    'visibilityState' | 'addEventListener' | 'removeEventListener'
  >;
}

export interface VisibilityFuse {
  /** Idempotent terminal teardown. Safe from any dismissal path. */
  dispose(): void;
  /** Visible-time remaining (ms) — for tests/diagnostics. */
  remainingMs(): number;
  /** True once fired or disposed. */
  done(): boolean;
}

export function createVisibilityFuse(
  budgetMs: number,
  onFire: () => void,
  deps?: Partial<VisibilityFuseDeps>,
): VisibilityFuse {
  const now = deps?.now ?? (() => performance.now());
  const setTimeoutFn = deps?.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn =
    deps?.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const doc = deps?.doc ?? document;

  let remaining = budgetMs;
  let timer: unknown = null;
  let armedAt = 0;
  let finished = false;

  const onVisibility = () => {
    if (finished) return;
    if (doc.visibilityState === 'hidden') pause();
    else arm();
  };

  const arm = () => {
    if (finished || timer !== null) return;
    armedAt = now();
    timer = setTimeoutFn(fire, remaining);
  };

  const pause = () => {
    if (finished || timer === null) return;
    clearTimeoutFn(timer);
    timer = null;
    remaining = Math.max(0, remaining - (now() - armedAt));
  };

  const dispose = () => {
    if (finished) return;
    finished = true;
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    doc.removeEventListener('visibilitychange', onVisibility);
  };

  const fire = () => {
    if (finished) return;
    timer = null;
    remaining = 0;
    dispose();
    onFire();
  };

  doc.addEventListener('visibilitychange', onVisibility);
  if (doc.visibilityState !== 'hidden') arm();

  return {
    dispose,
    remainingMs: () => {
      if (timer !== null) return Math.max(0, remaining - (now() - armedAt));
      return remaining;
    },
    done: () => finished,
  };
}
