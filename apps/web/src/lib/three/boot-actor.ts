/**
 * boot-actor.ts — the rung-4 slice-D boot-actor contract (spec §2a, FROZEN
 * rev 5, docs/perf-cold-load-rung4-sliceD-spec.md).
 *
 * Replaces the deleted global LoadingManager warmup barrier with an explicit,
 * mode-independent dependency: the ACTIVE BOOT ACTOR (the body the camera
 * will present at reveal). Design contract, hardened over 5 spec rounds and
 * the I1 implementation review:
 *
 *  - ONE coordinator (the `useBootActorCoordinator` hook, mounted in
 *    GamePage) has EXCLUSIVE authority to resolve the actor and CLOSE
 *    REGISTRATION (freeze WHICH resource is covered). Closure requires
 *    authoritative settlement: auth resolved AND the avatar query SETTLED
 *    (confirmed 401/not-found ≠ transient error [R3-F5]) AND the
 *    synchronous mode promotion applied. Pre-closure changes REPLACE the
 *    pending resolution; registration closure is one-shot per epoch.
 *  - REGISTRATION closure ≠ COVERAGE closure [I1-F1]: for body kinds the
 *    COVERAGE stays OPEN (and `requiresDeferredAttach` keeps returning
 *    false — the on-time RAW leg) until the MATCHING claim token COMMITS or
 *    the epoch deadline fires. Closing coverage at resolution time would
 *    route the still-suspended on-time body through the hidden warm path —
 *    the exact §R4-F2 cycle the frozen state table prohibits.
 *  - LOADERS CLAIM, NEVER RESOLVE [R4-F1]: actor components register
 *    `(kind, resourceKey)` claims and commit them by TOKEN, with PER-TOKEN
 *    commit timestamps [I1-F2] — a commit that lands before the coordinator
 *    adopts its tuple still carries its time, adopted when the tuple
 *    becomes current. Stale tuples are telemetry-only.
 *  - ONE epoch-owned deadline (8s, anchored to EPOCH START, surviving
 *    warmup-effect restarts [R3-F8]): at the deadline unresolved or
 *    uncommitted state closes UNCOVERED (fail-open — the reveal is never
 *    held hostage), `bootActorResolvedAt` is stamped even when unresolved
 *    [I1-F2], and dependency-progress membership FREEZES [R3-F6][I1-F3].
 *  - The five §2d progress units (3 locomotion clips + actor byte-fetch +
 *    actor commit) are ALL epoch-owned here [I1-F3]; a commit implies the
 *    byte fetch settled (covers the npc-body path, which has no separate
 *    fetch reporter).
 *
 * All state is exposed via getters; nothing here is cleared by
 * SeaLoadingScreen's legacy window-flag re-zero [R2-F7].
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
  ensureWorldBootEpoch,
  getWorldBootEpoch,
  subscribeWorldBootEpoch,
} from '@/lib/three/decorative-release';
import {
  getLocomotionClipSettledPromises,
  whenLocomotionClipsSettled,
} from '@/lib/three/vrm-character-animator';

export const BOOT_ACTOR_DEADLINE_MS = 8_000;

export type BootActorKind =
  | 'none'
  | 'player-vrm'
  | 'player-glb'
  | 'npc-body'
  | 'autonomous-remote';

/** Kinds that mount a local body whose commit gates the reveal. */
export function isBodyKind(kind: BootActorKind): boolean {
  return kind === 'player-vrm' || kind === 'player-glb' || kind === 'npc-body';
}

export type BootActorClaimToken = {
  readonly id: number;
  readonly epochId: number;
  readonly kind: BootActorKind;
  readonly resourceKey: string;
};

type Resolution = {
  kind: BootActorKind;
  resourceKey: string | null;
};

type Coverage = {
  closed: boolean;
  coveredKind: BootActorKind | null;
  coveredResourceKey: string | null;
  committed: boolean;
  timedOut: boolean;
};

type Listener = () => void;

let tokenCounter = 0;
let pendingResolution: Resolution | null = null;
let registrationClosed = false;
let coverage: Coverage = {
  closed: false,
  coveredKind: null,
  coveredResourceKey: null,
  committed: false,
  timedOut: false,
};
const claims = new Map<number, BootActorClaimToken>();
/** token id → commit timestamp (page ms) [I1-F2]. */
const commitTimes = new Map<number, number>();
const fetchSettledTokenIds = new Set<number>();
let resolvedAtMs: number | null = null;
let readyAtMs: number | null = null;
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
let deadlineFired = false;
const stateSubscribers = new Set<Listener>();
const gateWaiters = new Set<Listener>();
// §2d clip units — epoch-owned here so ONE deadline governs all five
// progress units [I1-F3]. Lazily initialized (starts the loads if needed).
let clipTrackingStarted = false;
let clipsSettled = 0;
let clipsTotal = 0;

function nowMs(): number {
  return typeof performance !== 'undefined'
    ? Math.round(performance.now())
    : Date.now();
}

function stampPhase(key: string, value: unknown): void {
  try {
    (window as any).__W3D_PHASES = (window as any).__W3D_PHASES ?? {};
    (window as any).__W3D_PHASES[key] = value;
  } catch {
    /* telemetry never throws */
  }
}

function notifySubscribers(): void {
  for (const cb of [...stateSubscribers]) {
    try {
      cb();
    } catch (err) {
      console.warn('[boot-actor] subscriber threw:', err);
    }
  }
  checkGateComplete();
}

/** The committed claim matching the current resolution, with the EARLIEST
 * commit time (adoption rule [I1-F2]), or null. */
function matchingCommittedClaim(): { token: BootActorClaimToken; at: number } | null {
  if (!pendingResolution) return null;
  let best: { token: BootActorClaimToken; at: number } | null = null;
  for (const [id, at] of commitTimes) {
    const claim = claims.get(id);
    if (
      claim &&
      claim.kind === pendingResolution.kind &&
      claim.resourceKey === pendingResolution.resourceKey &&
      (best === null || at < best.at)
    ) {
      best = { token: claim, at };
    }
  }
  return best;
}

function checkGateComplete(): void {
  if (!coverage.closed) return;
  for (const resolve of [...gateWaiters]) {
    gateWaiters.delete(resolve);
    try {
      resolve();
    } catch (err) {
      console.warn('[boot-actor] gate waiter threw:', err);
    }
  }
}

/** Close COVERAGE (the terminal event): via commit, via non-body
 * resolution, or via the deadline. Never called at bare registration
 * closure for body kinds [I1-F1]. */
function closeCoverage(timedOut: boolean): void {
  if (coverage.closed) return;
  registrationClosed = true;
  const match = matchingCommittedClaim();
  const bodyResolution =
    pendingResolution !== null && isBodyKind(pendingResolution.kind);
  const committed = !timedOut && (bodyResolution ? match !== null : pendingResolution !== null);
  coverage = {
    closed: true,
    coveredKind: pendingResolution?.kind ?? null,
    coveredResourceKey: timedOut
      ? null
      : (pendingResolution?.resourceKey ?? null),
    committed,
    timedOut,
  };
  if (committed && bodyResolution && match && readyAtMs === null) {
    readyAtMs = match.at;
    stampPhase('bootActorReadyAt', readyAtMs);
  }
  // Every closure stamps a resolution time — including an unresolved
  // timeout [I1-F2].
  if (resolvedAtMs === null) {
    resolvedAtMs = nowMs();
    stampPhase('bootActorResolvedAt', resolvedAtMs);
  }
  // [I2-F1] the epoch deadline timer is NOT cancelled here: it must still
  // fire to FREEZE the five progress units (late clip settlements may not
  // mutate DONE past the epoch deadline) even after a successful closure.
  stampPhase('bootActorKind', coverage.coveredKind ?? 'unresolved');
  stampPhase('bootActorGateTimedOut', timedOut);
  notifySubscribers();
}

/** After registration closes, coverage closes as soon as its terminal
 * condition is available (immediately for non-body kinds; on the matching
 * commit for body kinds). */
function maybeCloseCoverage(): void {
  if (coverage.closed || !registrationClosed || !pendingResolution) return;
  if (!isBodyKind(pendingResolution.kind)) {
    closeCoverage(false);
    return;
  }
  if (matchingCommittedClaim() !== null) {
    closeCoverage(false);
  }
}

/** Arm the epoch-anchored deadline the moment the epoch exists [R3-F8]. */
function armDeadlineForEpoch(): void {
  const epoch = getWorldBootEpoch();
  if (!epoch || deadlineTimer !== null || deadlineFired || coverage.closed) {
    return;
  }
  if (typeof window === 'undefined') return;
  deadlineTimer = setTimeout(() => {
    deadlineTimer = null;
    // ALWAYS freezes progress membership [I2-F1]; additionally closes
    // coverage UNCOVERED when the actor never made it [R2-F5].
    deadlineFired = true;
    if (!coverage.closed) {
      closeCoverage(true);
    }
    notifySubscribers();
  }, BOOT_ACTOR_DEADLINE_MS);
}

if (typeof window !== 'undefined') {
  subscribeWorldBootEpoch(armDeadlineForEpoch);
}

// ---------------------------------------------------------------------------
// Loader surface — claims + commits + fetch units [R4-F1]
// ---------------------------------------------------------------------------

/**
 * Register an actor resource claim (render-time legal: replayable epoch
 * state keyed by token, never consumed one-shots [R2-F2]). Returns the token
 * the loader must pass to `notifyBootActorCommitted` from its post-Suspense
 * passive effect.
 */
export function registerBootActorClaim(
  kind: BootActorKind,
  resourceKey: string,
): BootActorClaimToken {
  const epoch = ensureWorldBootEpoch();
  // Re-use an identical live claim (render replays must not grow the map).
  for (const claim of claims.values()) {
    if (
      claim.epochId === epoch.id &&
      claim.kind === kind &&
      claim.resourceKey === resourceKey
    ) {
      return claim;
    }
  }
  const token: BootActorClaimToken = {
    id: ++tokenCounter,
    epochId: epoch.id,
    kind,
    resourceKey,
  };
  claims.set(token.id, token);
  return token;
}

/** Commit a claim (post-Suspense passive effect — commit proves the resource
 * resolved). The commit TIME is stored per token [I1-F2]; whether it counts
 * is decided by the coordinator's resolution (now or on later adoption). A
 * commit also implies the byte fetch settled (npc-body has no separate
 * fetch reporter [I1-F3]). Closes body coverage when registration already
 * froze the matching tuple [I1-F1]. */
export function notifyBootActorCommitted(token: BootActorClaimToken): void {
  if (!claims.has(token.id) || commitTimes.has(token.id)) return;
  const at = nowMs();
  commitTimes.set(token.id, at);
  fetchSettledTokenIds.add(token.id);
  const matchesCurrent =
    !!pendingResolution &&
    pendingResolution.kind === token.kind &&
    pendingResolution.resourceKey === token.resourceKey;
  if (matchesCurrent && readyAtMs === null && !coverage.closed) {
    readyAtMs = at;
    stampPhase('bootActorReadyAt', readyAtMs);
  }
  if (!matchesCurrent) {
    stampPhase('bootActorStaleCommit', `${token.kind}:${token.resourceKey}`);
  }
  maybeCloseCoverage();
  notifySubscribers();
}

/** Mark the actor's byte fetch settled (progress unit; success OR failure —
 * terminal accounting, the bar never stalls on a failed dep [R3-F6]). */
export function notifyBootActorFetchSettled(token: BootActorClaimToken): void {
  if (!claims.has(token.id) || fetchSettledTokenIds.has(token.id)) return;
  fetchSettledTokenIds.add(token.id);
  notifySubscribers();
}

// ---------------------------------------------------------------------------
// Coordinator surface — EXCLUSIVE resolve/close authority [R2-F3]
// ---------------------------------------------------------------------------

/** Replace the pending resolution (pre-closure only; the coordinator is the
 * single caller). Adopting a tuple whose claim ALREADY committed picks up
 * that commit's timestamp [I1-F2]. */
export function resolveBootActor(
  kind: BootActorKind,
  resourceKey: string | null,
): void {
  if (registrationClosed) return;
  pendingResolution = { kind, resourceKey };
  if (resolvedAtMs === null) {
    resolvedAtMs = nowMs();
  }
  stampPhase('bootActorResolvedAt', resolvedAtMs);
  stampPhase('bootActorKind', kind);
  const match = matchingCommittedClaim();
  if (match && readyAtMs === null) {
    readyAtMs = match.at;
    stampPhase('bootActorReadyAt', readyAtMs);
  }
  notifySubscribers();
}

/** Close REGISTRATION (coordinator only; one-shot): freezes WHICH resource
 * the gate covers. Coverage for body kinds stays open until the matching
 * commit or the deadline [I1-F1]. */
export function closeBootActorRegistration(): void {
  if (registrationClosed) return;
  if (!pendingResolution) {
    // Coordinator settled with nothing to resolve — explicit 'none'.
    pendingResolution = { kind: 'none', resourceKey: null };
    if (resolvedAtMs === null) resolvedAtMs = nowMs();
    stampPhase('bootActorResolvedAt', resolvedAtMs);
  }
  registrationClosed = true;
  maybeCloseCoverage();
  notifySubscribers();
}

export function isBootActorRegistrationClosed(): boolean {
  return registrationClosed;
}

// ---------------------------------------------------------------------------
// Gate surface — awaited by WorldWarmup
// ---------------------------------------------------------------------------

export type BootActorGateResult = {
  kind: BootActorKind | null;
  resourceKey: string | null;
  committed: boolean;
  timedOut: boolean;
};

/**
 * Await the actor dependency: resolves when COVERAGE closes — non-body
 * registration closure, the body's matching commit, or the epoch deadline
 * (fail-open). The deadline is epoch-anchored, so a warmup-effect restart
 * re-awaits the same clock [R3-F8].
 */
export function awaitBootActorGate(): Promise<BootActorGateResult> {
  armDeadlineForEpoch();
  return new Promise((resolve) => {
    const settle = () => {
      if (coverage.closed) {
        resolve({
          kind: coverage.coveredKind,
          resourceKey: coverage.coveredResourceKey,
          committed: coverage.committed,
          timedOut: coverage.timedOut,
        });
        return;
      }
      gateWaiters.add(settle);
    };
    settle();
  });
}

// ---------------------------------------------------------------------------
// Attach routing [R3-F1][R4-F2] — the exact reviewed state table. With
// coverage now staying open until the body commits [I1-F1], the open-gate
// RAW leg genuinely covers the on-time suspended body's first render.
// ---------------------------------------------------------------------------

export function requiresDeferredAttach(
  kind: BootActorKind,
  resourceKey: string,
): boolean {
  if (!coverage.closed) return false; // on-time path: RAW mount
  return (
    !coverage.committed ||
    coverage.coveredKind !== kind ||
    coverage.coveredResourceKey !== resourceKey
  );
}

// ---------------------------------------------------------------------------
// §2d progress surface — ALL FIVE units epoch-owned here [I1-F3]; read by
// SeaLoadingScreen via getters [R2-F7].
// ---------------------------------------------------------------------------

function ensureClipTracking(): void {
  if (clipTrackingStarted || typeof window === 'undefined') return;
  clipTrackingStarted = true;
  void whenLocomotionClipsSettled(); // starts loads + populates the map
  const promises = getLocomotionClipSettledPromises();
  clipsTotal = promises.size || 3;
  for (const promise of promises.values()) {
    void promise.then(() => {
      clipsSettled += 1;
      notifySubscribers();
    });
  }
}

export type BootDepProgress = {
  /** null until registration closes — TOTAL is unexposed before closure. */
  total: number | null;
  done: number;
};

/** Combined dependency progress: 3 clips + (body kinds) fetch + commit.
 * Membership FREEZES at the epoch deadline — unresolved units terminalize
 * as timed-out (DONE reaches TOTAL; late results are telemetry-only)
 * [R3-F6][I1-F3]. */
export function getBootDepProgress(): BootDepProgress {
  ensureClipTracking();
  if (!registrationClosed) return { total: null, done: 0 };
  const body =
    pendingResolution !== null && isBodyKind(pendingResolution.kind);
  const total = clipsTotal + (body ? 2 : 0);
  if (deadlineFired) return { total, done: total };
  let done = Math.min(clipsSettled, clipsTotal);
  if (body) {
    const match = matchingCommittedClaim();
    const fetchDone =
      match !== null ||
      [...fetchSettledTokenIds].some((id) => {
        const c = claims.get(id);
        return (
          c &&
          c.kind === pendingResolution!.kind &&
          c.resourceKey === pendingResolution!.resourceKey
        );
      });
    if (fetchDone) done += 1;
    if (coverage.closed ? coverage.committed : match !== null) done += 1;
  }
  return { total, done };
}

export function getBootActorStamps(): {
  kind: BootActorKind | null;
  resolvedAt: number | null;
  readyAt: number | null;
} {
  return {
    kind: coverage.closed ? coverage.coveredKind : (pendingResolution?.kind ?? null),
    resolvedAt: resolvedAtMs,
    readyAt: readyAtMs,
  };
}

export function subscribeBootActor(cb: Listener): () => void {
  stateSubscribers.add(cb);
  return () => stateSubscribers.delete(cb);
}

// ---------------------------------------------------------------------------
// Coordinator hook — mounted ONCE in GamePage [R2-F3]
// ---------------------------------------------------------------------------

export type BootActorCoordinatorInputs = {
  /** Auth pipeline settled (loading flags cleared). */
  authSettled: boolean;
  /** Avatar query outcome: 'success' | 'absent' (confirmed 401/not-found) |
   * 'error' (transient — keeps the resolution PENDING [R3-F5]) | 'loading'. */
  avatarOutcome: 'loading' | 'success' | 'absent' | 'error';
  controlMode: 'explore' | 'npc' | 'player' | 'autonomous';
  /** The resolved actor resource for a player body (model path), when known. */
  playerResourceKey: string | null;
  playerAvatarType: 'vrm' | 'glb' | null;
  /** The possessed demo body's resource path (npc mode). */
  npcBodyResourceKey: string | null;
};

function classify(inputs: BootActorCoordinatorInputs): Resolution | null {
  if (!inputs.authSettled) return null;
  if (inputs.controlMode === 'autonomous') {
    return { kind: 'autonomous-remote', resourceKey: null };
  }
  if (inputs.controlMode === 'npc') {
    return inputs.npcBodyResourceKey
      ? { kind: 'npc-body', resourceKey: inputs.npcBodyResourceKey }
      : null;
  }
  if (inputs.controlMode === 'player') {
    if (!inputs.playerResourceKey || !inputs.playerAvatarType) return null;
    return {
      kind: inputs.playerAvatarType === 'vrm' ? 'player-vrm' : 'player-glb',
      resourceKey: inputs.playerResourceKey,
    };
  }
  // explore: 'none' — but ONLY on authoritative avatar settlement for an
  // authenticated user; a transient avatar error stays PENDING until the
  // epoch deadline [R3-F5]. (An unauthenticated guest settles immediately.)
  if (inputs.avatarOutcome === 'error') return null;
  if (inputs.avatarOutcome === 'loading') return null;
  return { kind: 'none', resourceKey: null };
}

/**
 * The single closure authority. Epoch existence is a closure PRECONDITION,
 * bridged via subscription so a coordinator mounted before the lazy world
 * exists re-runs when the epoch appears [R3-F8].
 *
 * `getInputs` is invoked LIVE inside the effect (never render-captured):
 * GamePage's mode-promotion effect writes `controlMode` SYNCHRONOUSLY in
 * the same effect flush (page.tsx promotion → zustand setState), so a
 * render-captured snapshot taken before that flush would classify a fresh
 * authenticated boot as `explore`/'none' and close the gate on the wrong
 * kind. The hook must be called AFTER the promotion effect in GamePage
 * (hook order = effect order), and `deps` lists the render-visible values
 * that should re-trigger classification.
 */
export function useBootActorCoordinator(
  getInputs: () => BootActorCoordinatorInputs,
  deps: readonly unknown[],
): void {
  const epoch = useSyncExternalStore(
    subscribeWorldBootEpoch,
    () => getWorldBootEpoch(),
    () => null,
  );
  useEffect(() => {
    if (!epoch || registrationClosed) return;
    const resolution = classify(getInputs());
    if (!resolution) return; // pending — deadline closes uncovered if never settles
    resolveBootActor(resolution.kind, resolution.resourceKey);
    closeBootActorRegistration();
    // Any dep change BEFORE closure re-classifies (replace-before-close);
    // after closure the effect is inert (registrationClosed guard).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, ...deps]);
}

/** TEST-ONLY: deterministic clip-unit state (the real per-clip promises
 * load GLBs — nondeterministic in unit scope). */
export function __setClipTrackingForTests(settled: number, total: number): void {
  clipTrackingStarted = true;
  clipsSettled = settled;
  clipsTotal = total;
}

/** TEST-ONLY: fire the epoch deadline synchronously (the real 8s timer is
 * untestable in unit scope). Mirrors the timer body exactly. */
export function __fireBootActorDeadlineForTests(): void {
  if (deadlineTimer !== null) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
  deadlineFired = true;
  if (!coverage.closed) closeCoverage(true);
  notifySubscribers();
}

/** TEST-ONLY: classification logic, exposed for coordinator unit tests. */
export function __classifyBootActorForTests(
  inputs: BootActorCoordinatorInputs,
): { kind: BootActorKind; resourceKey: string | null } | null {
  return classify(inputs);
}

/** TEST-ONLY: reset module state between unit tests. */
export function __resetBootActorForTests(): void {
  tokenCounter = 0;
  pendingResolution = null;
  registrationClosed = false;
  coverage = {
    closed: false,
    coveredKind: null,
    coveredResourceKey: null,
    committed: false,
    timedOut: false,
  };
  claims.clear();
  commitTimes.clear();
  fetchSettledTokenIds.clear();
  resolvedAtMs = null;
  readyAtMs = null;
  deadlineFired = false;
  if (deadlineTimer !== null) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
  stateSubscribers.clear();
  gateWaiters.clear();
  clipTrackingStarted = false;
  clipsSettled = 0;
  clipsTotal = 0;
}
