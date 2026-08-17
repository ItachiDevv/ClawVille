/**
 * boot-actor.ts — the rung-4 slice-D boot-actor contract (spec §2a, FROZEN
 * rev 5, docs/perf-cold-load-rung4-sliceD-spec.md).
 *
 * Replaces the deleted global LoadingManager warmup barrier with an explicit,
 * mode-independent dependency: the ACTIVE BOOT ACTOR (the body the camera
 * will present at reveal). Design contract, hardened over 5 Codex rounds:
 *
 *  - ONE coordinator (the `useBootActorCoordinator` hook, mounted in
 *    GamePage) has EXCLUSIVE authority to resolve the actor and CLOSE
 *    registration. It closes only on authoritative settlement: auth resolved
 *    AND the avatar query SETTLED (confirmed 401/not-found ≠ transient error
 *    [R3-F5]) AND the synchronous mode promotion applied. Pre-closure
 *    changes REPLACE the pending resolution; closure is one-shot per epoch.
 *  - LOADERS CLAIM, NEVER RESOLVE [R4-F1]: the actor components register
 *    `(kind, resourceKey)` claims and commit them by TOKEN. Only the token
 *    matching the coordinator's CURRENT resolution can close the gate,
 *    stamp readiness, or credit a progress unit — a stale same-kind
 *    resource swap (VRM path-A → path-B before closure) is telemetry-only.
 *  - GATE COVERAGE + requiresDeferredAttach [R3-F1][R4-F2]: an OPEN gate
 *    means RAW mount (the on-time actor must mount visible and commit so
 *    the gate CAN close). After closure, any actor resource that did not
 *    participate in the closed gate attaches through the deferred-warm
 *    path — never raw.
 *  - ONE epoch-owned deadline (8s, anchored to EPOCH START, surviving
 *    warmup-effect restarts [R3-F8]): at the deadline unresolved state
 *    closes UNCOVERED (fail-open — the reveal is never held hostage) and
 *    progress membership FREEZES [R3-F6].
 *
 * All state is per-boot-epoch module state exposed via getters; nothing
 * here is cleared by SeaLoadingScreen's legacy window-flag re-zero [R2-F7].
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
  ensureWorldBootEpoch,
  getWorldBootEpoch,
  subscribeWorldBootEpoch,
} from '@/lib/three/decorative-release';

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
const committedTokenIds = new Set<number>();
const fetchSettledTokenIds = new Set<number>();
let resolvedAtMs: number | null = null;
let readyAtMs: number | null = null;
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
let deadlineFired = false;
const stateSubscribers = new Set<Listener>();
const gateWaiters = new Set<Listener>();

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

/** Is the coordinator's current resolution satisfied by a committed claim? */
function currentResolutionCommitted(): boolean {
  if (!pendingResolution) return false;
  if (!isBodyKind(pendingResolution.kind)) return true;
  for (const id of committedTokenIds) {
    const claim = claims.get(id);
    if (
      claim &&
      claim.kind === pendingResolution.kind &&
      claim.resourceKey === pendingResolution.resourceKey
    ) {
      return true;
    }
  }
  return false;
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

function closeGate(timedOut: boolean): void {
  if (coverage.closed) return;
  registrationClosed = true;
  const committed = currentResolutionCommitted();
  coverage = {
    closed: true,
    coveredKind: pendingResolution?.kind ?? null,
    coveredResourceKey: timedOut
      ? null
      : (pendingResolution?.resourceKey ?? null),
    committed: committed && !timedOut,
    timedOut,
  };
  if (deadlineTimer !== null) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
  stampPhase('bootActorKind', coverage.coveredKind ?? 'unresolved');
  stampPhase('bootActorGateTimedOut', timedOut);
  notifySubscribers();
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
    deadlineFired = true;
    if (!coverage.closed) {
      // Unresolved or uncommitted at the deadline: close UNCOVERED —
      // the late actor routes through requiresDeferredAttach [R2-F5].
      closeGate(true);
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
 * resolved). Only the token matching the CURRENT resolution stamps readiness
 * or closes the gate; stale tokens are telemetry-only [R4-F1]. */
export function notifyBootActorCommitted(token: BootActorClaimToken): void {
  if (!claims.has(token.id) || committedTokenIds.has(token.id)) return;
  committedTokenIds.add(token.id);
  const matchesCurrent =
    !!pendingResolution &&
    pendingResolution.kind === token.kind &&
    pendingResolution.resourceKey === token.resourceKey;
  if (matchesCurrent && readyAtMs === null) {
    readyAtMs = nowMs();
    stampPhase('bootActorReadyAt', readyAtMs);
  }
  if (!matchesCurrent) {
    stampPhase('bootActorStaleCommit', `${token.kind}:${token.resourceKey}`);
  }
  // Late-commit upgrade: the gate may CLOSE covering a body resource whose
  // commit lands moments later — that commit COMPLETES the coverage (the
  // resource participated in the closed gate; it mounted raw and stays
  // raw). A timeout closure (coveredResourceKey null) never upgrades.
  if (
    coverage.closed &&
    !coverage.committed &&
    !coverage.timedOut &&
    coverage.coveredKind === token.kind &&
    coverage.coveredResourceKey === token.resourceKey
  ) {
    coverage = { ...coverage, committed: true };
    if (readyAtMs === null) {
      readyAtMs = nowMs();
      stampPhase('bootActorReadyAt', readyAtMs);
    }
  }
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
 * single caller). */
export function resolveBootActor(
  kind: BootActorKind,
  resourceKey: string | null,
): void {
  if (coverage.closed) return;
  pendingResolution = { kind, resourceKey };
  if (resolvedAtMs === null) {
    resolvedAtMs = nowMs();
  }
  stampPhase('bootActorResolvedAt', resolvedAtMs);
  stampPhase('bootActorKind', kind);
  notifySubscribers();
}

/** Close registration (coordinator only; one-shot). For body kinds the gate
 * still awaits the matching commit — closure freezes WHICH resource is
 * covered, commit-completion is observed by the gate await below. */
export function closeBootActorRegistration(): void {
  if (coverage.closed) return;
  if (!pendingResolution) {
    // Coordinator settled with nothing to resolve — explicit 'none'.
    pendingResolution = { kind: 'none', resourceKey: null };
    if (resolvedAtMs === null) resolvedAtMs = nowMs();
    stampPhase('bootActorResolvedAt', resolvedAtMs);
  }
  closeGate(false);
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
 * Await the actor dependency: resolves when the gate is CLOSED and — for
 * body kinds — the covered resource committed, or immediately at the epoch
 * deadline (fail-open). The deadline is epoch-anchored, so a warmup-effect
 * restart re-awaits the same clock [R3-F8].
 */
export function awaitBootActorGate(): Promise<BootActorGateResult> {
  armDeadlineForEpoch();
  return new Promise((resolve) => {
    const settle = () => {
      const bodyPending =
        !deadlineFired &&
        coverage.closed &&
        !coverage.timedOut &&
        coverage.coveredKind !== null &&
        isBodyKind(coverage.coveredKind) &&
        !coverage.committed &&
        !currentResolutionCommitted();
      if (coverage.closed && !bodyPending) {
        // Late-commit upgrade: a body commit that landed after closure but
        // before this await settles still counts as covered.
        if (
          coverage.closed &&
          !coverage.committed &&
          currentResolutionCommitted()
        ) {
          coverage = { ...coverage, committed: true };
        }
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
// Attach routing [R3-F1][R4-F2] — the exact reviewed state table
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
// Progress + stamps surface (read by SeaLoadingScreen via getters [R2-F7])
// ---------------------------------------------------------------------------

export type BootActorProgress = {
  /** null until registration closes — TOTAL is unexposed before closure. */
  total: number | null;
  done: number;
};

export function getBootActorProgress(): BootActorProgress {
  if (!coverage.closed) return { total: null, done: 0 };
  const body =
    coverage.coveredKind !== null && isBodyKind(coverage.coveredKind);
  if (!body) return { total: 0, done: 0 };
  // Two actor units: byte-fetch settled + commit. Membership froze at
  // closure; late results update telemetry, never TOTAL [R3-F6]. The
  // deadline terminalizes unresolved units (counted done as timed-out).
  let done = 0;
  const fetchDone =
    deadlineFired ||
    [...fetchSettledTokenIds].some((id) => {
      const c = claims.get(id);
      return (
        c &&
        c.kind === coverage.coveredKind &&
        c.resourceKey === coverage.coveredResourceKey
      );
    });
  if (fetchDone) done += 1;
  if (coverage.committed || deadlineFired) done += 1;
  return { total: 2, done };
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

/** TEST-ONLY: fire the epoch deadline synchronously (the real 8s timer is
 * untestable in unit scope). Mirrors the timer body exactly. */
export function __fireBootActorDeadlineForTests(): void {
  if (deadlineTimer !== null) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
  deadlineFired = true;
  if (!coverage.closed) closeGate(true);
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
  committedTokenIds.clear();
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
}
