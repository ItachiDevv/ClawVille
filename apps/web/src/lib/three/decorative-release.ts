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
 *  - Released by WHICHEVER fires first: the world warmup gate's resume
 *    (normal completion or 40s safety), the stage-ready publication, or this
 *    module's own absolute deadline — capped at the SeaLoadingScreen 45s
 *    force-dismiss so deferred content can never outwait a failed-open loader.
 *  - Subscribers added after release fire synchronously (no missed-release
 *    stranding).
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

/** Release now (idempotent). Called from the world warmup ready paths. */
export function releaseDecorative(reason: string): void {
  fire(reason);
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

/** TEST-ONLY: reset module state between unit tests. Never call from app code. */
export function __resetDecorativeReleaseForTests(): void {
  released = false;
  releasedAtMs = null;
  releaseReason = null;
  if (deadlineTimer !== null) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
  listeners.clear();
}
