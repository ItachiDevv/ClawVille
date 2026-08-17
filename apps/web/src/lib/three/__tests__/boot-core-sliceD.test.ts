/**
 * Rung-4 slice D unit tests — boot epoch, BOOT_CORE_PRESENTED milestone,
 * boot-stream eligibility, boot-actor contract, stream cohort.
 * Spec: docs/perf-cold-load-rung4-sliceD-spec.md (FROZEN rev 5).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetDecorativeReleaseForTests,
  armBootCorePresented,
  armDecorativeReleaseOnFirstPaint,
  ensureWorldBootEpoch,
  getBootCorePresentedAt,
  getWorldBootEpoch,
  isBootCorePresented,
  isBootStreamEligible,
  notifyBootCoreScenePresented,
  notifyWorldFramePresented,
  onBootStreamEligible,
  releaseDecorative,
  subscribeWorldBootEpoch,
} from '../decorative-release';
import {
  __classifyBootActorForTests,
  __fireBootActorDeadlineForTests,
  __resetBootActorForTests,
  awaitBootActorGate,
  closeBootActorRegistration,
  getBootActorProgress,
  getBootActorStamps,
  isBodyKind,
  notifyBootActorCommitted,
  notifyBootActorFetchSettled,
  registerBootActorClaim,
  requiresDeferredAttach,
  resolveBootActor,
} from '../boot-actor';
import {
  BOOT_STREAM_COHORT_IDS,
  __resetBootStreamCohortForTests,
  getCohortCounts,
  getStreamSettledAt,
  reportCohortState,
} from '../boot-stream-cohort';

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
  timerDelays.shift();
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
    addEventListener() {},
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
  __resetBootActorForTests();
  __resetBootStreamCohortForTests();
});

afterEach(() => {
  __resetDecorativeReleaseForTests();
  __resetBootActorForTests();
  __resetBootStreamCohortForTests();
  (globalThis as any).window = originalWindow;
  (globalThis as any).document = originalDocument;
});

describe('world boot epoch', () => {
  test('idempotent latch — one epoch per page load', () => {
    const a = ensureWorldBootEpoch();
    const b = ensureWorldBootEpoch();
    expect(a).toBe(b);
    expect(getWorldBootEpoch()).toBe(a);
  });

  test('subscription fires exactly once on creation', () => {
    let calls = 0;
    subscribeWorldBootEpoch(() => {
      calls += 1;
    });
    ensureWorldBootEpoch();
    ensureWorldBootEpoch();
    expect(calls).toBe(1);
  });
});

describe('BOOT_CORE_PRESENTED milestone', () => {
  test('fires on the second qualifying post-render frame WITH the sea overlay still up', () => {
    // The overlay dismisses BECAUSE of this milestone — its presence must
    // not block qualification (unlike the decorative release predicate).
    setReady(true);
    dom.overlayPresent = true;
    armBootCorePresented('warmup-complete');
    notifyBootCoreScenePresented();
    expect(isBootCorePresented()).toBe(false);
    notifyBootCoreScenePresented();
    expect(isBootCorePresented()).toBe(true);
    expect(getBootCorePresentedAt()).not.toBeNull();
  });

  test('never fires without an arm', () => {
    setReady(true);
    for (let i = 0; i < 5; i += 1) notifyBootCoreScenePresented();
    expect(isBootCorePresented()).toBe(false);
  });

  test('hidden document blocks and resets the qualifier run', () => {
    setReady(true);
    armBootCorePresented('resume');
    notifyBootCoreScenePresented();
    dom.hidden = true;
    notifyBootCoreScenePresented();
    dom.hidden = false;
    notifyBootCoreScenePresented();
    expect(isBootCorePresented()).toBe(false); // run restarted — 1 of 2
    notifyBootCoreScenePresented();
    expect(isBootCorePresented()).toBe(true);
  });

  test('opaque stage curtain blocks qualification (retained guard)', () => {
    setReady(true);
    armBootCorePresented('resume');
    dom.transitionPhase = 'fadingOut';
    notifyBootCoreScenePresented();
    notifyBootCoreScenePresented();
    expect(isBootCorePresented()).toBe(false);
    dom.transitionPhase = null;
    notifyBootCoreScenePresented();
    notifyBootCoreScenePresented();
    expect(isBootCorePresented()).toBe(true);
  });

  test('__W3D_READY false blocks qualification', () => {
    setReady(false);
    armBootCorePresented('resume');
    notifyBootCoreScenePresented();
    notifyBootCoreScenePresented();
    expect(isBootCorePresented()).toBe(false);
  });
});

function stampMilestone(): void {
  setReady(true);
  armBootCorePresented('test');
  notifyBootCoreScenePresented();
  notifyBootCoreScenePresented();
}

function fireRelease(): void {
  armDecorativeReleaseOnFirstPaint('test');
  releaseDecorative('test');
}

describe('boot-stream eligibility', () => {
  test('requires BOTH release and milestone (plus overlay/curtain gone, visible)', () => {
    fireRelease();
    expect(isBootStreamEligible()).toBe(false);
    stampMilestone();
    expect(isBootStreamEligible()).toBe(true);
  });

  test('milestone alone is not eligible', () => {
    stampMilestone();
    expect(isBootStreamEligible()).toBe(false);
  });

  test('overlay still present defers eligibility to the poll', () => {
    stampMilestone();
    dom.overlayPresent = true;
    fireRelease();
    expect(isBootStreamEligible()).toBe(false);
  });

  test('delivery is staggered with a first-drain quiet period, priority-ordered, one per tick', () => {
    const order: string[] = [];
    onBootStreamEligible(() => order.push('far'), 100);
    onBootStreamEligible(() => order.push('near'), 1);
    stampMilestone();
    fireRelease();
    expect(order).toEqual([]); // quiet period pending
    expect(timerDelays[0]).toBe(1_500);
    flushOneTimer(); // quiet period elapses → first entry
    expect(order).toEqual(['near']);
    flushOneTimer(); // next tick (setTimeout fallback path in stub)
    expect(order).toEqual(['near', 'far']);
  });

  test('parks while hidden — no delivery until visible again', () => {
    const delivered: string[] = [];
    onBootStreamEligible(() => delivered.push('x'), 0);
    stampMilestone();
    fireRelease();
    dom.hidden = true;
    flushOneTimer(); // quiet timer fires while hidden → run() bails
    expect(delivered).toEqual([]);
  });

  test('unsubscribe before execution is honored', () => {
    const delivered: string[] = [];
    const off = onBootStreamEligible(() => delivered.push('x'), 0);
    stampMilestone();
    fireRelease();
    off();
    flushOneTimer();
    expect(delivered).toEqual([]);
  });
});

describe('boot-actor contract', () => {
  test('on-time body: open gate mounts RAW, commit closes covered', async () => {
    ensureWorldBootEpoch();
    // Open gate → RAW (the reviewed state table [R4-F2])
    expect(requiresDeferredAttach('player-vrm', '/avatars/a.vrm')).toBe(false);
    resolveBootActor('player-vrm', '/avatars/a.vrm');
    const token = registerBootActorClaim('player-vrm', '/avatars/a.vrm');
    notifyBootActorCommitted(token);
    closeBootActorRegistration();
    const result = await awaitBootActorGate();
    expect(result.kind).toBe('player-vrm');
    expect(result.committed).toBe(true);
    expect(result.timedOut).toBe(false);
    // Covered resource stays raw-eligible; any other resource defers.
    expect(requiresDeferredAttach('player-vrm', '/avatars/a.vrm')).toBe(false);
    expect(requiresDeferredAttach('player-vrm', '/avatars/b.vrm')).toBe(true);
    expect(requiresDeferredAttach('player-glb', '/models/x.glb')).toBe(true);
  });

  test('stale same-kind swap: A commit cannot close coverage for B [R4-F1]', () => {
    ensureWorldBootEpoch();
    const tokenA = registerBootActorClaim('player-vrm', '/avatars/a.vrm');
    notifyBootActorCommitted(tokenA);
    // Coordinator replaces the resolution to B before closure.
    resolveBootActor('player-vrm', '/avatars/b.vrm');
    closeBootActorRegistration();
    // B never committed — coverage must NOT be committed off A's commit.
    expect(requiresDeferredAttach('player-vrm', '/avatars/b.vrm')).toBe(true);
    expect(requiresDeferredAttach('player-vrm', '/avatars/a.vrm')).toBe(true);
  });

  test('readiness stamp binds to the CURRENT resolution only', () => {
    ensureWorldBootEpoch();
    resolveBootActor('player-vrm', '/avatars/b.vrm');
    const tokenA = registerBootActorClaim('player-vrm', '/avatars/a.vrm');
    notifyBootActorCommitted(tokenA); // stale — no readyAt stamp
    expect(getBootActorStamps().readyAt).toBeNull();
    const tokenB = registerBootActorClaim('player-vrm', '/avatars/b.vrm');
    notifyBootActorCommitted(tokenB);
    expect(getBootActorStamps().readyAt).not.toBeNull();
  });

  test('none-closure: any later body defers', async () => {
    ensureWorldBootEpoch();
    resolveBootActor('none', null);
    closeBootActorRegistration();
    const result = await awaitBootActorGate();
    expect(result.kind).toBe('none');
    expect(result.committed).toBe(true); // non-body kinds are committed-by-definition
    expect(requiresDeferredAttach('player-vrm', '/avatars/a.vrm')).toBe(true);
  });

  test('deadline: unresolved closes UNCOVERED and later bodies defer', async () => {
    ensureWorldBootEpoch();
    __fireBootActorDeadlineForTests();
    const result = await awaitBootActorGate();
    expect(result.timedOut).toBe(true);
    expect(result.committed).toBe(false);
    expect(requiresDeferredAttach('player-vrm', '/avatars/a.vrm')).toBe(true);
  });

  test('progress: TOTAL unexposed before closure; body units terminalize', () => {
    ensureWorldBootEpoch();
    expect(getBootActorProgress().total).toBeNull();
    resolveBootActor('player-glb', '/models/lobster.glb');
    const token = registerBootActorClaim('player-glb', '/models/lobster.glb');
    closeBootActorRegistration();
    expect(getBootActorProgress()).toEqual({ total: 2, done: 0 });
    notifyBootActorFetchSettled(token);
    expect(getBootActorProgress()).toEqual({ total: 2, done: 1 });
    notifyBootActorCommitted(token);
    expect(getBootActorProgress()).toEqual({ total: 2, done: 2 });
  });

  test('progress: none-kind exposes zero units at closure', () => {
    ensureWorldBootEpoch();
    resolveBootActor('none', null);
    closeBootActorRegistration();
    expect(getBootActorProgress()).toEqual({ total: 0, done: 0 });
  });

  test('classify: transient avatar error stays pending; confirmed absent closes none [R3-F5]', () => {
    const base = {
      authSettled: true,
      controlMode: 'explore' as const,
      playerResourceKey: null,
      playerAvatarType: null,
      npcBodyResourceKey: null,
    };
    expect(
      __classifyBootActorForTests({ ...base, avatarOutcome: 'error' }),
    ).toBeNull();
    expect(
      __classifyBootActorForTests({ ...base, avatarOutcome: 'loading' }),
    ).toBeNull();
    expect(
      __classifyBootActorForTests({ ...base, avatarOutcome: 'absent' }),
    ).toEqual({ kind: 'none', resourceKey: null });
  });

  test('classify: autonomous is gate-equivalent to none; player maps avatar type', () => {
    const base = {
      authSettled: true,
      avatarOutcome: 'success' as const,
      playerResourceKey: '/avatars/ansem-w30k.vrm',
      playerAvatarType: 'vrm' as const,
      npcBodyResourceKey: null,
    };
    expect(
      __classifyBootActorForTests({ ...base, controlMode: 'autonomous' }),
    ).toEqual({ kind: 'autonomous-remote', resourceKey: null });
    expect(
      __classifyBootActorForTests({ ...base, controlMode: 'player' }),
    ).toEqual({ kind: 'player-vrm', resourceKey: '/avatars/ansem-w30k.vrm' });
  });

  test('isBodyKind covers exactly the three local-body kinds', () => {
    expect(isBodyKind('player-vrm')).toBe(true);
    expect(isBodyKind('player-glb')).toBe(true);
    expect(isBodyKind('npc-body')).toBe(true);
    expect(isBodyKind('none')).toBe(false);
    expect(isBodyKind('autonomous-remote')).toBe(false);
  });
});

describe('boot-stream cohort', () => {
  test('seeds exactly 16 members and never settles with one missing', () => {
    expect(BOOT_STREAM_COHORT_IDS.length).toBe(16);
    const [first, ...rest] = BOOT_STREAM_COHORT_IDS;
    for (const id of rest) reportCohortState(id, 'ready-warmed');
    expect(getStreamSettledAt()).toBeNull();
    expect(getCohortCounts().nonterminal).toEqual([first!]);
    reportCohortState(first!, 'ready-warmed');
    expect(getStreamSettledAt()).not.toBeNull();
    expect(getCohortCounts().terminal).toBe(16);
  });

  test('failure kinds are counted distinctly', () => {
    reportCohortState('building:cove', 'failed');
    reportCohortState('prop:bazaar-stall', 'ready-failopen');
    const counts = getCohortCounts();
    expect(counts.failed).toBe(1);
    expect(counts.failopen).toBe(1);
  });

  test('terminal states are sticky across remounts', () => {
    reportCohortState('npc:town-guide', 'failed');
    reportCohortState('npc:town-guide', 'mounted');
    expect(getCohortCounts().failed).toBe(1);
  });

  test('unknown ids are ignored', () => {
    reportCohortState('building:not-a-thing', 'ready-warmed');
    expect(getCohortCounts().terminal).toBe(0);
  });
});
