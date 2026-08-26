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

import { BOOT_STREAM_COHORT_IDS } from './boot-stream-cohort';

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
  // Slice D: the release is one of the two boot-stream eligibility legs
  // (hoisted function declaration — defined in the slice-D section below).
  evaluateBootStreamEligibility();
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

/**
 * Shared reveal predicate (slice D [F6]): the decorative milestone requires
 * the sea overlay GONE; the boot-core milestone omits ONLY that check (the
 * overlay dismisses BECAUSE boot-core presented) but keeps the hidden-tab
 * and stage-curtain guards — SPA frames can run behind an opaque curtain.
 */
function revealConditionHolds(requireSeaOverlayGone: boolean): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }
  // Hidden/occluded documents get throttled RAFs and present nothing — a
  // frame callback there must not count as a presented revealed frame.
  if (document.hidden) return false;
  if ((window as any).__W3D_READY !== true) return false;
  // The cold-boot loading overlay (unmounted on dismiss — no cache: a
  // remounted loader must re-gate; the query is a single class lookup).
  if (
    requireSeaOverlayGone &&
    document.querySelector('.claw-loading-overlay') !== null
  ) {
    return false;
  }
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
  if (!revealConditionHolds(true)) {
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

// ---------------------------------------------------------------------------
// Rung-4 slice D — world boot epoch, BOOT_CORE_PRESENTED milestone, and the
// boot-stream eligibility queue. Spec: docs/perf-cold-load-rung4-sliceD-spec.md
// (FROZEN rev 5). Everything below is per-boot-epoch module state exposed via
// GETTERS: SeaLoadingScreen (and any other DOM consumer) reads the getters —
// its mount-time re-zero of legacy window flags can never clear milestone
// state [R2-F7]. Window mirrors are WRITE-ONLY probe telemetry.
// ---------------------------------------------------------------------------

/** Stagger priority tiers for slice-D boot-deferred content (§1). Priority
 * passed to the queue = TIER + squared distance from the static boot camera,
 * so ALL buildings precede ALL props precede ALL land content, nearest-first
 * within each tier. NPC-tier consumers pass plain distSq. */
/** BGR guide amendment (founder 2026-08-20): Nori delivers FIRST on the
 * boot-critical stage-B lane — ahead of every building ("really the first
 * thing that loads, the center town guide"). */
export const BOOT_STREAM_TIER_GUIDE = -2e14;
export const BOOT_STREAM_TIER_BUILDINGS = -1e14;
export const BOOT_STREAM_TIER_PROPS = -1e13;
export const BOOT_STREAM_TIER_LAND = -1e12;
/** Static boot camera position (world units) for tier distance math — the
 * town-center overview the camera boots at. Never read per-frame. */
export const BOOT_CAMERA_POSITION = [0, 600, 1300] as const;

const BOOT_STREAM_FAILOPEN_VISIBLE_MS = 10_000;
const BOOT_STREAM_EVAL_POLL_MS = 250;

export type WorldBootEpoch = { readonly id: number };

let _epochCounter = 0;
let currentEpoch: WorldBootEpoch | null = null;
const epochSubscribers = new Set<Listener>();

/**
 * Render-time idempotent latch (the proven beginWorldVrmParseEpoch pattern —
 * replay-safe, so calling from a useState initializer is legal). Creates the
 * boot epoch ONCE per page load; SPA returns and warmup-effect restarts
 * ADOPT it [R2-F2]. Notifies epoch subscribers exactly once on creation so a
 * coordinator mounted before the lazy world exists re-runs [R3-F8].
 */
export function ensureWorldBootEpoch(): WorldBootEpoch {
  if (currentEpoch) return currentEpoch;
  currentEpoch = { id: ++_epochCounter };
  for (const cb of [...epochSubscribers]) {
    try {
      cb();
    } catch (err) {
      console.warn('[boot-epoch] subscriber threw:', err);
    }
  }
  // Buildings-gated reveal (BGR D1): epoch creation is one of stage A's two
  // eligibility legs (hoisted declaration, defined in the BGR section below).
  evaluateBgrStageA();
  return currentEpoch;
}

export function getWorldBootEpoch(): WorldBootEpoch | null {
  return currentEpoch;
}

/** Subscription bridge for useSyncExternalStore consumers [R3-F8]. */
export function subscribeWorldBootEpoch(cb: Listener): () => void {
  epochSubscribers.add(cb);
  return () => epochSubscribers.delete(cb);
}

// --- BOOT_CORE_PRESENTED milestone (§2c) -----------------------------------

let bootCoreArmedReason: string | null = null;
let bootCorePresented = false;
let bootCorePresentedAtMs: number | null = null;
let bootCoreQualifyingFrames = 0;

/** Armed from EVERY warmup resume path (complete, error, fallback,
 * stage-ready) — one-shot, first reason kept for telemetry. */
export function armBootCorePresented(reason: string): void {
  if (bootCorePresented) return;
  if (bootCoreArmedReason === null) bootCoreArmedReason = reason;
}

/**
 * Called from the STAGE SCENE's chained `onAfterRender` (three r185 fires the
 * scene-level callback after actual render completion — Groups never receive
 * object-level callbacks [R2-F1]). Caller pre-qualifies world-slot ownership
 * and camera; this function applies the reveal predicate (WITHOUT the sea
 * overlay check — the overlay dismisses BECAUSE of this milestone) and the
 * two-consecutive-frame discipline.
 */
export function notifyBootCoreScenePresented(): void {
  if (bootCorePresented || bootCoreArmedReason === null) return;
  if (!revealConditionHolds(false)) {
    bootCoreQualifyingFrames = 0;
    return;
  }
  bootCoreQualifyingFrames += 1;
  if (bootCoreQualifyingFrames < 2) return;
  bootCorePresented = true;
  bootCorePresentedAtMs =
    typeof performance !== 'undefined'
      ? Math.round(performance.now())
      : Date.now();
  try {
    (window as any).__W3D_BOOT_CORE_PRESENTED = true;
    (window as any).__W3D_PHASES = (window as any).__W3D_PHASES ?? {};
    (window as any).__W3D_PHASES.bootCorePresentedAt = bootCorePresentedAtMs;
    // BGR D4: generation provenance for the probe evidence validator.
    (window as any).__W3D_PHASES.bootCorePresentedGen = bootRendererGeneration;
  } catch {
    /* telemetry never throws */
  }
  evaluateBootStreamEligibility();
  // BGR D1 stage B: LATCHED on the first core presentation of the boot — a
  // later renderer-generation reset re-clears the milestone but deliberately
  // does NOT re-park stage B (compile safety is structural: every deferred
  // warm compile is chained through the boot-compile FIFO).
  markBgrStageBEligible();
}

export function isBootCorePresented(): boolean {
  return bootCorePresented;
}

export function getBootCorePresentedAt(): number | null {
  return bootCorePresentedAtMs;
}

// --- Boot-stream eligibility (§2e) -----------------------------------------
// Per-epoch queue with its OWN quiet period + visibility parking [R2-F7]:
// the legacy stagger queue's process-global firstDrainDelayDone flag can be
// consumed by legacy consumers while hidden; slice-D delivery must not
// inherit that, and must never start while the tab is hidden.

let streamEligible = false;
let streamEligibleAtMs: number | null = null;
let streamEligibleReason: string | null = null;
const streamQueue: StaggerEntry[] = [];
let streamScheduled = false;
let streamSequence = 0;
/** [I2-F2] stable member ids whose stagger tick already DELIVERED — the
 * only members allowed to skip the queue on a later visible remount. */
const deliveredStreamMembers = new Set<string>();
let streamFirstDrainDelayDone = false;
let streamEvalTimer: ReturnType<typeof setInterval> | null = null;
let streamVisibleMsSinceRelease = 0;
let streamLastEvalAt: number | null = null;
let streamVisibilityListenerInstalled = false;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function installStreamVisibilityListener(): void {
  if (
    streamVisibilityListenerInstalled ||
    typeof document === 'undefined' ||
    typeof document.addEventListener !== 'function'
  ) {
    return;
  }
  streamVisibilityListenerInstalled = true;
  document.addEventListener('visibilitychange', () => {
    // Foregrounding re-arms a parked drain and lets the evaluator re-check.
    evaluateBootStreamEligibility();
    drainStreamQueue();
    // BGR lanes park while hidden too — re-arm both on foregrounding.
    evaluateBgrStageA();
    drainBgrStageBQueue();
  });
}

function overlayAndCurtainGone(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.querySelector('.claw-loading-overlay') !== null) return false;
  const transition =
    document.querySelector<HTMLElement>('[data-stage-transition]');
  const phase = transition?.dataset.stageTransition;
  if (phase && phase !== 'idle') return false;
  return true;
}

function markStreamEligible(reason: string): void {
  if (streamEligible) return;
  streamEligible = true;
  streamEligibleAtMs = Math.round(nowMs());
  streamEligibleReason = reason;
  // [impl-B7] the post-reveal lane becoming eligible (milestone OR its own
  // 10s fail-open) implies the buildings lane must be able to stream too —
  // props/NPCs popping in over permanently-empty building spots would be
  // absurd. Idempotent.
  forceBootBuildingsStreamEligible(`post-reveal:${reason}`);
  if (streamEvalTimer !== null) {
    clearInterval(streamEvalTimer);
    streamEvalTimer = null;
  }
  try {
    (window as any).__W3D_PHASES = (window as any).__W3D_PHASES ?? {};
    (window as any).__W3D_PHASES.bootStreamEligibleAt = streamEligibleAtMs;
    (window as any).__W3D_PHASES.bootStreamEligibleReason = reason;
  } catch {
    /* telemetry never throws */
  }
  drainStreamQueue();
}

/**
 * Eligibility = decorative release fired AND boot-core presented AND the sea
 * overlay + stage curtain actually gone AND the tab visible. Fail-open: the
 * release fired but the milestone never stamps → eligible after 10s of
 * VISIBLE time post-release (a broken milestone cannot strand an empty
 * world; hidden tabs keep parking by design) [R2-F7][F8].
 */
function evaluateBootStreamEligibility(): void {
  if (streamEligible || !released) return;
  installStreamVisibilityListener();

  const t = nowMs();
  if (streamLastEvalAt !== null && typeof document !== 'undefined') {
    if (!document.hidden) {
      // [I1-F5] credit is CAPPED per tick: hidden-tab timer throttling can
      // suppress polls for 30s+, and attributing that whole interval on
      // foregrounding (document reads visible at the END of the interval)
      // would instantly trip the 10s fail-open. A visible tick can never
      // credit more than two poll periods.
      streamVisibleMsSinceRelease += Math.min(
        t - streamLastEvalAt,
        BOOT_STREAM_EVAL_POLL_MS * 2,
      );
    }
  }
  streamLastEvalAt = t;

  if (typeof document !== 'undefined' && document.hidden) return;

  if (bootCorePresented && overlayAndCurtainGone()) {
    markStreamEligible('milestone');
    return;
  }
  if (
    !bootCorePresented &&
    streamVisibleMsSinceRelease >= BOOT_STREAM_FAILOPEN_VISIBLE_MS
  ) {
    markStreamEligible('fail-open-visible');
    return;
  }
  // Keep a bounded poll alive while release-fired-but-not-eligible: it
  // accumulates visible time and watches the overlay/curtain DOM (neither
  // has an event we can subscribe to). Self-disposes on eligibility.
  if (streamEvalTimer === null && typeof window !== 'undefined') {
    streamEvalTimer = setInterval(
      evaluateBootStreamEligibility,
      BOOT_STREAM_EVAL_POLL_MS,
    );
  }
}

function takeNextStream(): StaggerEntry | undefined {
  if (streamQueue.length === 0) return undefined;
  let best = 0;
  for (let i = 1; i < streamQueue.length; i += 1) {
    const candidate = streamQueue[i]!;
    const current = streamQueue[best]!;
    if (
      candidate.priority < current.priority ||
      (candidate.priority === current.priority &&
        candidate.sequence < current.sequence)
    ) {
      best = i;
    }
  }
  return streamQueue.splice(best, 1)[0];
}

function drainStreamQueue(): void {
  if (!streamEligible || streamScheduled || streamQueue.length === 0) return;
  // Park while hidden — the visibilitychange listener re-arms this drain.
  if (typeof document !== 'undefined' && document.hidden) return;

  const run = () => {
    streamScheduled = false;
    if (typeof document !== 'undefined' && document.hidden) return;
    let next = takeNextStream();
    while (next && !next.active) next = takeNextStream();
    if (!next) return;
    try {
      next.listener();
    } catch (err) {
      console.warn('[boot-stream] staggered listener threw:', err);
    }
    drainStreamQueue();
  };

  if (typeof window === 'undefined') {
    run();
    return;
  }
  streamScheduled = true;
  const w = window as any;
  if (!streamFirstDrainDelayDone) {
    streamFirstDrainDelayDone = true;
    w.setTimeout(run, STAGGER_FIRST_DRAIN_QUIET_MS);
    return;
  }
  if (typeof w.requestIdleCallback === 'function') {
    w.requestIdleCallback(run, { timeout: 500 });
  } else {
    w.setTimeout(run, 120);
  }
}

export function isBootStreamEligible(): boolean {
  return streamEligible;
}

/** [I2-F2] true only when this member's OWN stagger tick already ran —
 * a NEW consumer (no delivery record) must always enter the epoch queue,
 * even while visible and globally eligible. */
export function isStreamMemberDelivered(memberId: string): boolean {
  return deliveredStreamMembers.has(memberId);
}

export function bootStreamEligibleReason(): string | null {
  return streamEligibleReason;
}

/**
 * Subscribe slice-D boot-deferred content. Delivery is staggered ONE per
 * idle tick through the per-epoch stream queue (own 1.5s quiet period from
 * eligibility; parks while hidden). Ascending priority — pass
 * `TIER + distSq` (see the tier constants above). Late subscribers join the
 * same queue. Returns an unsubscribe that is honored until execution.
 */
export function onBootStreamEligible(
  listener: Listener,
  priority = 0,
  memberId?: string,
): () => void {
  const entry: StaggerEntry = {
    listener: memberId
      ? () => {
          deliveredStreamMembers.add(memberId);
          listener();
        }
      : listener,
    active: true,
    priority,
    sequence: streamSequence++,
  };
  streamQueue.push(entry);
  if (streamEligible) {
    drainStreamQueue();
  } else {
    evaluateBootStreamEligibility();
  }
  return () => {
    entry.active = false;
    const index = streamQueue.indexOf(entry);
    if (index >= 0) streamQueue.splice(index, 1);
  };
}

// ---------------------------------------------------------------------------
// Buildings-gated reveal (BGR, 2026-08-20 founder ruling — proxies dead).
// Spec: docs/perf-cold-load-buildings-gated-reveal-spec.md (rev 3 FROZEN).
// The overlay holds until boot-core AND the 11 real streamed buildings are
// presented. Buildings stream through two dedicated lanes that depend on
// NEITHER the decorative release NOR the overlay (the old single lane
// required overlay-gone at two levels — a structural deadlock once the
// overlay waits for buildings):
//   Stage A — byte-fetch only (network warm), eligible on epoch + visible +
//             mode 'glb'. Zero React/renderer/GPU work [R2-NF1].
//   Stage B — mount/parse/warm, latched eligible on the FIRST boot-core
//             presentation. Compile safety is structural (deferred-warm
//             compiles are chained through the boot-compile FIFO), so a
//             renderer-generation bump does not re-park this lane.
// ---------------------------------------------------------------------------

/** The 11 required building cohort ids (derived from the cohort's frozen
 * static set — single source of truth, no drift). */
const BGR_BUILDING_IDS: readonly string[] = BOOT_STREAM_COHORT_IDS.filter(
  (id) => id.startsWith('building:'),
);

/** Founder amendment 2026-08-20 ("I need Nori to also be in the first
 * loading batch — the center town guide"): Nori joins the reveal-required
 * set WHEN DECLARED (her mount is gated on the NPC perf flag, so a
 * hard-coded requirement would strand an NPC-less dev boot on a token that
 * can never come — the declaration comes from the canvas, which knows). */
export const BGR_GUIDE_COHORT_ID = 'npc:town-guide';
const BGR_IDS_WITH_GUIDE: readonly string[] = [
  ...BGR_BUILDING_IDS,
  BGR_GUIDE_COHORT_ID,
];

let bgrGuideRequired = false;
let bgrGuideRequiredOwner: symbol | null = null;

/** OWNER-KEYED like the mode declaration [impl-B6]: latest declaration wins;
 * a non-owner reset is a no-op (SPA canvas-overlap safe).
 *
 * [nori-NF2] GROWING the required set RESETS the one-shot presented
 * milestone: a milestone stamped against the 11-building set before this
 * declaration flushed would otherwise let the overlay dismiss without Nori
 * (the loader's two-tick guard only samples the sticky boolean). Shrinking
 * (required → false) keeps a stamped milestone — a 12-token proof covers
 * the 11-token requirement. NOTE: buildings mode 'absent' (meshlet / edit /
 * buildingDetail=false — dev surfaces) bypasses the ENTIRE reveal leg by
 * design, Nori included; the product boot path is always 'glb'. */
export function declareBootGuideRevealRequired(
  required: boolean,
  owner: symbol,
): void {
  bgrGuideRequiredOwner = owner;
  const grew = required && !bgrGuideRequired;
  bgrGuideRequired = required;
  stampPhase('bootGuideRevealRequired', required ? 1 : 0);
  if (grew && bgrBuildingsPresented) {
    bgrBuildingsPresented = false;
    bgrBuildingsQualifyingFrames = 0;
  } else if (grew) {
    bgrBuildingsQualifyingFrames = 0;
  }
}

export function resetBootGuideRevealRequired(owner: symbol): void {
  if (bgrGuideRequiredOwner !== owner) return;
  bgrGuideRequiredOwner = null;
  bgrGuideRequired = false;
}

/** The CURRENT reveal-required cohort subset. */
export function getBootRevealRequiredIds(): readonly string[] {
  return bgrGuideRequired ? BGR_IDS_WITH_GUIDE : BGR_BUILDING_IDS;
}

function stampPhase(key: string, value: number | string): void {
  try {
    (window as any).__W3D_PHASES = (window as any).__W3D_PHASES ?? {};
    (window as any).__W3D_PHASES[key] = value;
  } catch {
    /* telemetry never throws */
  }
}

// --- Renderer-generation authority (D4 [R2-NF2]) ---------------------------
// Identity-latched single choke point. Called from the scene-onAfterRender
// notifier chain with the renderer that ACTUALLY executed the frame — this
// observes every real replacement (watchdog recovery, StageRendererHealth
// bridge swap) with exactly one caller, so no double-bump is possible.

let observedBootRenderer: object | null = null;
let bootRendererGeneration = 1;
const generationListeners = new Set<Listener>();

export function observeBootRenderer(renderer: unknown): void {
  if (!renderer || typeof renderer !== 'object') return;
  if (observedBootRenderer === renderer) return;
  const first = observedBootRenderer === null;
  observedBootRenderer = renderer as object;
  if (first) return; // first observation latches identity — no bump
  bootRendererGeneration += 1;
  // A replacement renderer has no built pipelines: BOTH presentation
  // milestones are stale [R2-NF3][R2-NF4]. Reset them (+ frame counters);
  // warm-leg acks need no clearing — they are IDENTITY-KEYED to the warmed
  // renderer [impl-B4], so a stale leg simply stops matching the observed
  // renderer. Sticky RESOURCE outcomes (cohort terminals, settled stamp) are
  // measurement records and stay. Stamps are forward-only — the *At values
  // keep their last value until a re-stamp overwrites them.
  bootCorePresented = false;
  bootCoreQualifyingFrames = 0;
  bgrBuildingsPresented = false;
  bgrBuildingsQualifyingFrames = 0;
  stampPhase('bootRendererGeneration', bootRendererGeneration);
  for (const cb of [...generationListeners]) {
    try {
      cb();
    } catch (err) {
      console.warn('[bgr] generation listener threw:', err);
    }
  }
}

export function getBootRendererGeneration(): number {
  return bootRendererGeneration;
}

/** Subscription bridge (useSyncExternalStore in FailedBuildingAckProbe). */
export function subscribeBootRendererGeneration(cb: Listener): () => void {
  generationListeners.add(cb);
  return () => generationListeners.delete(cb);
}

// --- Buildings mode (D6 [R2-NF5]) ------------------------------------------
// Per-canvas, latest-wins, 'pending' on unmount. The overlay predicate
// evaluates the CURRENT declaration live — an 'absent'-era trivial pass can
// never leak into a later 'glb' declaration.

export type BootBuildingsMode = 'pending' | 'glb' | 'absent';
let bgrBuildingsMode: BootBuildingsMode = 'pending';
let bgrBuildingsModeOwner: symbol | null = null;

/** OWNER-KEYED [impl-B6]: the declaring canvas passes its own owner symbol;
 * the latest declaration wins AND takes ownership. */
export function declareBootBuildingsMode(
  mode: 'glb' | 'absent',
  owner: symbol,
): void {
  bgrBuildingsModeOwner = owner;
  if (bgrBuildingsMode === mode) return;
  bgrBuildingsMode = mode;
  stampPhase('bootBuildingsMode', mode);
  if (mode === 'glb') evaluateBgrStageA();
}

/** Canvas-unmount cleanup: back to 'pending' ONLY when the caller still OWNS
 * the declaration [impl-B6] — during an SPA canvas overlap React runs the
 * outgoing canvas's cleanup AFTER the incoming canvas's effect, and an
 * unconditional reset would clobber the fresh declaration to 'pending'
 * (stranding the leg until the fuses). A non-owner reset is a no-op. */
export function resetBootBuildingsMode(owner: symbol): void {
  if (bgrBuildingsModeOwner !== owner) return;
  bgrBuildingsModeOwner = null;
  bgrBuildingsMode = 'pending';
}

export function getBootBuildingsMode(): BootBuildingsMode {
  return bgrBuildingsMode;
}

// --- Stage A: byte-fetch-only lane (D1) ------------------------------------

const bgrStageAQueue: Array<{ listener: Listener; priority: number }> = [];
let bgrStageAFiredAt: number | null = null;

/** [nori-A4] `priority` orders NETWORK ADMISSION within the one-shot batch
 * (ascending — the guide registers below 0 so her bytes enqueue before any
 * building's; everything still fires in the same tick, HTTP/2 multiplexed). */
export function onBootBuildingsFetch(listener: Listener, priority = 0): void {
  bgrStageAQueue.push({ listener, priority });
  evaluateBgrStageA();
}

function evaluateBgrStageA(): void {
  if (bgrStageAQueue.length === 0) return;
  if (bgrBuildingsMode !== 'glb') return;
  if (!currentEpoch) return;
  installStreamVisibilityListener();
  if (typeof document !== 'undefined' && document.hidden) return;
  if (bgrStageAFiredAt === null) {
    bgrStageAFiredAt = Math.round(nowMs());
    stampPhase('bootBuildingsFetchKickAt', bgrStageAFiredAt);
  }
  // One batch — pure fetch warms; parallel downloads ARE the point.
  const entries = bgrStageAQueue.splice(0, bgrStageAQueue.length);
  entries.sort((a, b) => a.priority - b.priority);
  for (const { listener } of entries) {
    try {
      listener();
    } catch (err) {
      console.warn('[bgr] stage-A fetch listener threw:', err);
    }
  }
}

// --- Stage B: mount/parse/warm lane (D1) -----------------------------------
// Own queue: staggered one per idle tick, NO quiet period (no reveal boundary
// to protect — the overlay covers everything), parks hidden. Shares the
// delivered-member remount contract with the post-reveal lane.

let bgrStageBEligible = false;
const bgrStageBQueue: StaggerEntry[] = [];
let bgrStageBScheduled = false;
let bgrStageBSequence = 0;

function markBgrStageBEligible(): void {
  if (bgrStageBEligible) return;
  bgrStageBEligible = true;
  stampPhase('bootBuildingsStreamEligibleAt', Math.round(nowMs()));
  drainBgrStageBQueue();
}

/**
 * Fail-open stage-B admission [impl-B7]: a boot where BOOT_CORE_PRESENTED
 * never stamps (notifier/camera regression) dismisses the overlay via the
 * 10s/45s fuses — the buildings must then STREAM IN RAW (pop-in), not stay
 * `null` forever. Called from every fuse dismissal path and from the
 * post-reveal lane's own eligibility (if legacy streaming is eligible, the
 * buildings certainly must be).
 */
export function forceBootBuildingsStreamEligible(reason: string): void {
  if (bgrStageBEligible) return;
  stampPhase('bootBuildingsStreamForcedReason', reason);
  markBgrStageBEligible();
}

function drainBgrStageBQueue(): void {
  if (!bgrStageBEligible || bgrStageBScheduled || bgrStageBQueue.length === 0) {
    return;
  }
  if (typeof document !== 'undefined' && document.hidden) return;

  const takeNextBgr = (): StaggerEntry | undefined => {
    if (bgrStageBQueue.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < bgrStageBQueue.length; i += 1) {
      const candidate = bgrStageBQueue[i]!;
      const current = bgrStageBQueue[best]!;
      if (
        candidate.priority < current.priority ||
        (candidate.priority === current.priority &&
          candidate.sequence < current.sequence)
      ) {
        best = i;
      }
    }
    return bgrStageBQueue.splice(best, 1)[0];
  };

  const run = () => {
    bgrStageBScheduled = false;
    if (typeof document !== 'undefined' && document.hidden) return;
    let next = takeNextBgr();
    while (next && !next.active) next = takeNextBgr();
    if (!next) return;
    try {
      next.listener();
    } catch (err) {
      console.warn('[bgr] stage-B listener threw:', err);
    }
    drainBgrStageBQueue();
  };

  if (typeof window === 'undefined') {
    run();
    return;
  }
  bgrStageBScheduled = true;
  const w = window as any;
  if (typeof w.requestIdleCallback === 'function') {
    w.requestIdleCallback(run, { timeout: 500 });
  } else {
    w.setTimeout(run, 120);
  }
}

export function isBootBuildingsStreamEligible(): boolean {
  return bgrStageBEligible;
}

/** Subscribe a building member to stage B. Same contract as
 * onBootStreamEligible (priority order, one per idle tick, hidden parking,
 * delivered-member record shared with the post-reveal lane). */
export function onBootBuildingsStream(
  listener: Listener,
  priority = 0,
  memberId?: string,
): () => void {
  installStreamVisibilityListener();
  const entry: StaggerEntry = {
    listener: memberId
      ? () => {
          deliveredStreamMembers.add(memberId);
          listener();
        }
      : listener,
    active: true,
    priority,
    sequence: bgrStageBSequence++,
  };
  bgrStageBQueue.push(entry);
  drainBgrStageBQueue();
  return () => {
    entry.active = false;
    const index = bgrStageBQueue.indexOf(entry);
    if (index >= 0) bgrStageBQueue.splice(index, 1);
  };
}

// --- Ack protocol + BOOT_BUILDINGS_PRESENTED milestone (D2 [R2-NF3],
// impl-review B4/B5 + fix-round NF2/NF3) -------------------------------------
// Ack state is keyed by (cohortId, INSTANCE OWNER) — one owner symbol per
// mounted StreamedGLBBuilding, shared by ALL of its legs [fix-NF3]: an
// outgoing canvas A's committed-but-stale legs can never be combined with an
// incoming canvas B's warm to prove a building B hasn't committed yet, and
// A's unmount revokes only A's OWN instance record [impl-B5]. Per instance:
//   commit leg — its visible tree COMMITTED (effect on the DWA ready flip).
//   warm legs — the SET of renderer identities this instance's warms
//               completed against (a WeakSet — ADDITIVE [fix-NF2]: a
//               delayed renderer-A completion can never overwrite a valid
//               renderer-B ack; the token check asks "does the set CONTAIN
//               the currently-observed renderer" [impl-B4], so an early
//               completion validates the moment its renderer is observed).
//   failed — DURABLE (a boundary never retries for the life of its tree, so
//            the marker survives renderer swaps until the probe unmounts).
// Token live = some instance has failed, OR has commit AND a warm for the
// observed renderer.

type BuildingInstanceAck = {
  commit: boolean;
  failed: boolean;
  warmRenderers: WeakSet<object>;
};

const bgrInstanceAcks = new Map<string, Map<symbol, BuildingInstanceAck>>();

function instanceAck(id: string, owner: symbol): BuildingInstanceAck {
  let byOwner = bgrInstanceAcks.get(id);
  if (!byOwner) {
    byOwner = new Map<symbol, BuildingInstanceAck>();
    bgrInstanceAcks.set(id, byOwner);
  }
  let entry = byOwner.get(owner);
  if (!entry) {
    entry = { commit: false, failed: false, warmRenderers: new WeakSet() };
    byOwner.set(owner, entry);
  }
  return entry;
}

export function ackBuildingCommit(cohortId: string, owner: symbol): void {
  instanceAck(cohortId, owner).commit = true;
}

export function revokeBuildingCommit(cohortId: string, owner: symbol): void {
  const entry = bgrInstanceAcks.get(cohortId)?.get(owner);
  if (entry) entry.commit = false;
}

/** Record a completed warm AGAINST THE RENDERER IT RAN ON, for THIS
 * building instance [impl-B4][fix-NF2/NF3]. Additive — never overwrites. */
export function ackBuildingWarm(
  cohortId: string,
  owner: symbol,
  renderer: unknown,
): void {
  if (!renderer || typeof renderer !== 'object') return;
  instanceAck(cohortId, owner).warmRenderers.add(renderer as object);
}

export function ackBuildingFailed(cohortId: string, owner: symbol): void {
  instanceAck(cohortId, owner).failed = true;
}

/** Drop an instance's ENTIRE ack record (unmount cleanup — all legs at
 * once; other instances' records are untouched). */
export function revokeBuildingInstance(cohortId: string, owner: symbol): void {
  const byOwner = bgrInstanceAcks.get(cohortId);
  if (!byOwner) return;
  byOwner.delete(owner);
  if (byOwner.size === 0) bgrInstanceAcks.delete(cohortId);
}

function isBuildingTokenLive(id: string): boolean {
  const byOwner = bgrInstanceAcks.get(id);
  if (!byOwner) return false;
  for (const entry of byOwner.values()) {
    if (entry.failed) return true;
    if (
      entry.commit &&
      observedBootRenderer !== null &&
      entry.warmRenderers.has(observedBootRenderer)
    ) {
      return true;
    }
  }
  return false;
}

/** [nori-NF3] true when the id's ONLY live path is a durable FAILED marker
 * (no instance has a visible commit + current-renderer warm) — ship
 * evidence must show ZERO of these at presentation. */
function isTokenFailedOnly(id: string): boolean {
  const byOwner = bgrInstanceAcks.get(id);
  if (!byOwner) return false;
  let failed = false;
  for (const entry of byOwner.values()) {
    if (entry.failed) failed = true;
    if (
      entry.commit &&
      observedBootRenderer !== null &&
      entry.warmRenderers.has(observedBootRenderer)
    ) {
      return false;
    }
  }
  return failed;
}

/** Currently-observed-renderer reveal-token count over the CURRENT required
 * set (11 buildings + Nori when declared) — the loading bar's buildings band
 * reads this; renderer-current, never sticky [R2-NF8]. */
export function getBootBuildingsAckProgress(): { acked: number; total: number } {
  const required = getBootRevealRequiredIds();
  let acked = 0;
  for (const id of required) {
    if (isBuildingTokenLive(id)) acked += 1;
  }
  return { acked, total: required.length };
}

let bgrBuildingsPresented = false;
let bgrBuildingsPresentedAtMs: number | null = null;
let bgrBuildingsQualifyingFrames = 0;

/**
 * Called from the SAME scene-onAfterRender chain as
 * notifyBootCoreScenePresented (caller pre-qualifies slot/camera/epoch).
 * Requires 11 LIVE current-generation tokens CONTINUOUSLY across two
 * consecutive qualifying frames — a revoked token or generation bump resets
 * the run [R2-NF3].
 */
export function notifyBootBuildingsScenePresented(): void {
  if (bgrBuildingsPresented) return;
  if (bgrBuildingsMode !== 'glb') return;
  const { acked, total } = getBootBuildingsAckProgress();
  if (acked < total || !revealConditionHolds(false)) {
    bgrBuildingsQualifyingFrames = 0;
    return;
  }
  bgrBuildingsQualifyingFrames += 1;
  if (bgrBuildingsQualifyingFrames < 2) return;
  bgrBuildingsPresented = true;
  bgrBuildingsPresentedAtMs = Math.round(nowMs());
  stampPhase('bootBuildingsPresentedAt', bgrBuildingsPresentedAtMs);
  stampPhase('bootBuildingsPresentedGen', bootRendererGeneration);
  // [nori-NF3] presentation-shape provenance: the required-set SIZE this
  // milestone stamped against, and how many required tokens were live only
  // via a FAILED marker (a 404'd member doesn't hold the overlay, but it is
  // NEVER valid ship evidence — the validator requires zero).
  const requiredIds = getBootRevealRequiredIds();
  let failedTokens = 0;
  for (const id of requiredIds) {
    if (isTokenFailedOnly(id)) failedTokens += 1;
  }
  stampPhase('bootRevealPresentedRequired', requiredIds.length);
  stampPhase('bootRevealPresentedFailed', failedTokens);
}

export function isBootBuildingsPresented(): boolean {
  return bgrBuildingsPresented;
}

/** The overlay's buildings leg: 'absent' satisfies trivially, 'glb' requires
 * the presented milestone, 'pending' is unsatisfiable (fuses cap). */
export function isBootBuildingsRevealLegSatisfied(): boolean {
  if (bgrBuildingsMode === 'absent') return true;
  return bgrBuildingsPresented;
}

// --- Loading-screen dismissal stamp (D3 [R2-NF6]) --------------------------
// FIRST-WRITER-WINS at module level: a composite that becomes satisfiable
// during a fuse's 420ms fade can never launder the recorded reason.

export type LoadingDismissReason =
  | 'composite'
  | 'milestone-fallback'
  | 'visibility-fuse'
  | 'force-ready';

let loadingDismissReason: LoadingDismissReason | null = null;

/** Returns true when THIS call stamped (the caller may run its one-time
 * dismissal side effects); false when a prior reason already won. */
export function stampLoadingDismiss(reason: LoadingDismissReason): boolean {
  if (loadingDismissReason !== null) return false;
  loadingDismissReason = reason;
  stampPhase('loadingDismissReason', reason);
  stampPhase('loadingDismissedAt', Math.round(nowMs()));
  stampPhase('loadingDismissGen', bootRendererGeneration);
  return true;
}

export function getLoadingDismissReason(): LoadingDismissReason | null {
  return loadingDismissReason;
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
  // Slice-D state
  currentEpoch = null;
  epochSubscribers.clear();
  bootCoreArmedReason = null;
  bootCorePresented = false;
  bootCorePresentedAtMs = null;
  bootCoreQualifyingFrames = 0;
  streamEligible = false;
  streamEligibleAtMs = null;
  streamEligibleReason = null;
  streamQueue.length = 0;
  streamScheduled = false;
  streamSequence = 0;
  streamFirstDrainDelayDone = false;
  streamVisibleMsSinceRelease = 0;
  streamLastEvalAt = null;
  deliveredStreamMembers.clear();
  if (streamEvalTimer !== null) {
    clearInterval(streamEvalTimer);
    streamEvalTimer = null;
  }
  // BGR state
  observedBootRenderer = null;
  bootRendererGeneration = 1;
  generationListeners.clear();
  bgrBuildingsMode = 'pending';
  bgrBuildingsModeOwner = null;
  bgrGuideRequired = false;
  bgrGuideRequiredOwner = null;
  bgrStageAQueue.length = 0;
  bgrStageAFiredAt = null;
  bgrStageBEligible = false;
  bgrStageBQueue.length = 0;
  bgrStageBScheduled = false;
  bgrStageBSequence = 0;
  bgrInstanceAcks.clear();
  bgrBuildingsPresented = false;
  bgrBuildingsPresentedAtMs = null;
  bgrBuildingsQualifyingFrames = 0;
  loadingDismissReason = null;
}
