/**
 * decorative-release.ts — the one-shot release controller for post-reveal
 * decorative content (cold-load diet rung 1; seam design from the round's
 * adversarial review, docs/perf-cold-load-diet-2026-07-31.md §3A.1).
 *
 * Contract:
 *  - ONE-SHOT and MONOTONIC: once released, never resets — stage transitions,
 *    SPA returns, and canvas remounts must never re-gate or re-hide content
 *    that already released (timing-only deferral; conditional omission is a
 *    product defect).
 *  - ANCHORED TO FIRST PAINT (rung 3, founder-approved 2026-08-08): the
 *    warmup milestones (resume / stage-ready / warmup-complete / fallback)
 *    no longer release directly — they ARM eligibility, and the release
 *    fires on the SECOND world frame presented while the reveal condition
 *    holds (`__W3D_READY` true and the loading overlay gone), so one full
 *    world frame is on screen before any deferred download/GPU work starts.
 *    Rung-1 audit finding 2: the milestone anchors fired 0.4–17.7s BEFORE
 *    the world was visible, so "deferred" bytes competed with reveal-
 *    critical bytes inside the critical window.
 *  - The absolute deadline still fires the RELEASE unconditionally — capped
 *    at the SeaLoadingScreen 45s force-dismiss so the release can never
 *    outwait a failed-open loader, a crashed frameloop, or a background tab
 *    whose RAF never ticks. Content DELIVERY may trail the release: the
 *    staggered queue adds the first-drain quiet period (>=1.5s) plus one
 *    idle tick per heavy consumer, and hidden-tab timer throttling can
 *    stretch it further (invisible content, acceptable).
 *  - Plain onDecorativeRelease subscribers added after release fire
 *    synchronously (no missed-release stranding); STAGGERED subscribers are
 *    always asynchronous via the queue.
 *
 * Consumers gate RENDERING only (parent stops before any child that calls
 * useGLTF/useVRMInstance); data/roster state is never gated.
 */

const ABSOLUTE_DEADLINE_MS = 45_000;

type Listener = () => void;

let released = false;
let releasedAtMs: number | null = null;
let releaseReason: string | null = null;
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function fire(reason: string): void {
  if (released) return;
  released = true;
  releasedAtMs = typeof performance !== 'undefined' ? Math.round(performance.now()) : Date.now();
  releaseReason = reason;
  if (deadlineTimer !== null) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
  // Probe-readable stamp (cold-load instrumentation; never read by app code).
  try {
    (window as any).__W3D_DECORATIVE_RELEASED_AT = releasedAtMs;
    (window as any).__W3D_DECORATIVE_RELEASE_REASON = reason;
  } catch {
    /* telemetry never throws */
  }
  for (const l of [...listeners]) {
    try {
      l();
    } catch (err) {
      console.warn('[decorative-release] listener threw:', err);
    }
  }
  listeners.clear();
}

/** Release now (idempotent). Deadline/test escape hatch — app warmup paths
 * use armDecorativeReleaseOnFirstPaint instead (first-paint anchor). */
export function releaseDecorative(reason: string): void {
  fire(reason);
}

let firstPaintArmedReason: string | null = null;
let qualifyingFramesSeen = 0;

/**
 * Arm the first-paint release (idempotent; the FIRST milestone's reason is
 * kept for telemetry). Called from the warmup ready paths that previously
 * released directly. The actual release fires from
 * notifyWorldFramePresented once the world is genuinely on screen.
 */
export function armDecorativeReleaseOnFirstPaint(reason: string): void {
  if (released) return;
  if (firstPaintArmedReason === null) firstPaintArmedReason = reason;
}

function revealConditionHolds(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }
  // Hidden/occluded documents get throttled RAFs and present nothing — a
  // frame callback there must not count as a presented revealed frame.
  if (document.hidden) return false;
  if ((window as any).__W3D_READY !== true) return false;
  // The cold-boot loading overlay (unmounted on dismiss — no cache: a
  // remounted loader must re-gate; the query is a single class lookup).
  if (document.querySelector('.claw-loading-overlay') !== null) return false;
  // The stage transition curtain: a fast SPA return can run world frames
  // while the curtain is still opaque (Codex Lever-1 review finding 2 —
  // ~170ms window where hasEverActivated skips the sea loader). Only count
  // frames once the curtain is idle or visibly mid-fade-in (<1 opacity).
  const transition =
    document.querySelector<HTMLElement>('[data-stage-transition]');
  const phase = transition?.dataset.stageTransition;
  if (phase && phase !== 'idle') {
    if (phase !== 'fadingIn') return false;
    const opacity = Number.parseFloat(
      window.getComputedStyle(transition).opacity,
    );
    if (!Number.isFinite(opacity) || opacity >= 1) return false;
  }
  return true;
}

/**
 * Per-frame hook, called from the world scene's frame loop (frames only run
 * when the world is active and the frameloop is live). Fires the release on
 * the SECOND CONSECUTIVE qualifying frame so a full revealed world frame has
 * presented before any deferred work begins; any non-qualifying frame resets
 * the run.
 */
export function notifyWorldFramePresented(): void {
  if (released || firstPaintArmedReason === null) return;
  if (!revealConditionHolds()) {
    qualifyingFramesSeen = 0;
    return;
  }
  qualifyingFramesSeen += 1;
  if (qualifyingFramesSeen >= 2) {
    fire(`first-paint:${firstPaintArmedReason}`);
  }
}

/**
 * Arm the absolute deadline (idempotent; first caller wins). Called when the
 * world boot starts so a gate/lifecycle failure can never strand deferred
 * content forever — the exact failure mode the round's review flagged.
 */
export function armDecorativeDeadline(): void {
  if (released || deadlineTimer !== null) return;
  if (typeof window === 'undefined') return;
  deadlineTimer = setTimeout(() => fire('absolute-deadline'), ABSOLUTE_DEADLINE_MS);
}

export function isDecorativeReleased(): boolean {
  return released;
}

export function decorativeReleasedAt(): number | null {
  return releasedAtMs;
}

export function decorativeReleaseReason(): string | null {
  return releaseReason;
}

/**
 * Subscribe to the release. Fires synchronously if already released.
 * Returns an unsubscribe function (no-op after release).
 */
export function onDecorativeRelease(listener: Listener): () => void {
  if (released) {
    listener();
    return () => {};
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Staggered consumption (rung 3, Lever 3): heavy consumers (deferred NPC
// slots, decoration bundles) must NOT all mount on the same frame the release
// fires — the combined decode/upload burst lands as one longtask at the
// reveal boundary (measured: the 12-pair Lever-1 gate failed ONLY
// preRevealLongtaskMs because the synchronous burst delayed the reveal stamp
// behind it). This queue drains ONE consumer per idle tick instead.
// ---------------------------------------------------------------------------

type StaggerEntry = {
  listener: Listener;
  active: boolean;
  priority: number;
  sequence: number;
};

const staggerQueue: StaggerEntry[] = [];
let staggerScheduled = false;
let staggerSequence = 0;
/**
 * Quiet period before the FIRST post-release drain (rung-3 gate evidence:
 * the first warm consumers landed within ~0.5s of the release — right at the
 * reveal boundary — inflating reveal-adjacent longtask accounting and
 * competing with the first playable frames). All deferred work now starts
 * clearly after the reveal settles; subsequent consumers drain per idle tick
 * as before.
 */
export const STAGGER_FIRST_DRAIN_QUIET_MS = 1_500;
let firstDrainDelayDone = false;

function takeNextStaggered(): StaggerEntry | undefined {
  if (staggerQueue.length === 0) return undefined;
  let best = 0;
  for (let i = 1; i < staggerQueue.length; i += 1) {
    const candidate = staggerQueue[i]!;
    const current = staggerQueue[best]!;
    if (
      candidate.priority < current.priority ||
      (candidate.priority === current.priority &&
        candidate.sequence < current.sequence)
    ) {
      best = i;
    }
  }
  return staggerQueue.splice(best, 1)[0];
}

function drainStaggerQueue(): void {
  if (staggerScheduled || staggerQueue.length === 0) return;

  const run = () => {
    staggerScheduled = false;
    let next = takeNextStaggered();
    while (next && !next.active) next = takeNextStaggered();
    if (!next) return;
    try {
      next.listener();
    } catch (err) {
      console.warn('[decorative-release] staggered listener threw:', err);
    }
    drainStaggerQueue();
  };

  if (typeof window === 'undefined') {
    run();
    return;
  }
  staggerScheduled = true;
  const w = window as any;
  if (!firstDrainDelayDone) {
    firstDrainDelayDone = true;
    w.setTimeout(run, STAGGER_FIRST_DRAIN_QUIET_MS);
    return;
  }
  if (typeof w.requestIdleCallback === 'function') {
    w.requestIdleCallback(run, { timeout: 500 });
  } else {
    w.setTimeout(run, 120);
  }
}

/**
 * Subscribe with staggered delivery: after the release fires, queued
 * listeners run ONE PER IDLE TICK (bounded by a 500ms timeout each) instead
 * of synchronously, so deferred mounts cannot form a single burst at the
 * reveal boundary. Delivery order: ascending `priority` (ties by
 * subscription order) — pass the squared camera distance so near content
 * populates first, and Number.POSITIVE_INFINITY for bulk background sets.
 * Entries stay cancellable until the moment they execute (an unsubscribed
 * entry is skipped even if already scheduled). Late subscribers
 * (post-release) join the same queue.
 */
export function onDecorativeReleaseStaggered(
  listener: Listener,
  priority = 0,
): () => void {
  const entry: StaggerEntry = {
    listener,
    active: true,
    priority,
    sequence: staggerSequence++,
  };

  const enqueue = () => {
    if (!entry.active) return;
    staggerQueue.push(entry);
    drainStaggerQueue();
  };

  const offRelease = released
    ? (enqueue(), () => {})
    : onDecorativeRelease(enqueue);

  return () => {
    entry.active = false;
    offRelease();
    const index = staggerQueue.indexOf(entry);
    if (index >= 0) staggerQueue.splice(index, 1);
  };
}

/** TEST-ONLY: reset module state between unit tests. Never call from app code. */
export function __resetDecorativeReleaseForTests(): void {
  released = false;
  releasedAtMs = null;
  releaseReason = null;
  firstPaintArmedReason = null;
  qualifyingFramesSeen = 0;
  staggerQueue.length = 0;
  staggerScheduled = false;
  staggerSequence = 0;
  firstDrainDelayDone = false;
  if (deadlineTimer !== null) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
  listeners.clear();
}
