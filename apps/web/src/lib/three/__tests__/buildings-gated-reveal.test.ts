/**
 * Buildings-gated reveal (BGR) unit tests — stage-A/B lanes, the
 * instance/identity-keyed ack protocol, BOOT_BUILDINGS_PRESENTED milestone,
 * renderer-generation authority, owner-keyed mode declaration, dismissal
 * stamp, cohort buildings-subset settle, fail-open stage-B admission.
 * Spec: docs/perf-cold-load-buildings-gated-reveal-spec.md (rev 3 FROZEN)
 * + the Codex impl-review fixes (B1-B9).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetDecorativeReleaseForTests,
  ackBuildingCommit,
  ackBuildingFailed,
  ackBuildingWarm,
  armBootCorePresented,
  BGR_GUIDE_COHORT_ID,
  BOOT_STREAM_TIER_BUILDINGS,
  BOOT_STREAM_TIER_GUIDE,
  declareBootBuildingsMode,
  declareBootGuideRevealRequired,
  ensureWorldBootEpoch,
  forceBootBuildingsStreamEligible,
  getBootBuildingsAckProgress,
  getBootBuildingsMode,
  getBootRendererGeneration,
  getBootRevealRequiredIds,
  getLoadingDismissReason,
  isBootBuildingsPresented,
  isBootBuildingsRevealLegSatisfied,
  isBootBuildingsStreamEligible,
  isBootCorePresented,
  notifyBootBuildingsScenePresented,
  notifyBootCoreScenePresented,
  observeBootRenderer,
  onBootBuildingsFetch,
  onBootBuildingsStream,
  resetBootBuildingsMode,
  resetBootGuideRevealRequired,
  revokeBuildingCommit,
  revokeBuildingInstance,
  stampLoadingDismiss,
} from '../decorative-release';
import {
  BOOT_STREAM_COHORT_IDS,
  __resetBootStreamCohortForTests,
  areBootBuildingsSettled,
  getBootBuildingsSettledAt,
  getStreamSettledAt,
  reportCohortState,
} from '../boot-stream-cohort';

const BUILDING_IDS = BOOT_STREAM_COHORT_IDS.filter((id) =>
  id.startsWith('building:'),
);

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

function flushTimers(): void {
  while (pendingTimers.length > 0) {
    const fn = pendingTimers.shift();
    fn?.();
  }
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
    setTimeout: (fn: () => void) => {
      pendingTimers.push(fn);
      return pendingTimers.length;
    },
  };
}

function setReady(ready: boolean): void {
  (globalThis as any).window.__W3D_READY = ready;
}

/** A stable renderer identity for the boot under test. */
const RENDERER_A = { id: 'renderer-a' };
const RENDERER_B = { id: 'renderer-b' };

/** Drive BOOT_CORE_PRESENTED to stamped (arm + two qualifying frames; the
 * overlay may be PRESENT — the core milestone deliberately ignores it).
 * Observes the given renderer first, like the real onAfterRender chain. */
function presentBootCore(renderer: object = RENDERER_A): void {
  setReady(true);
  armBootCorePresented('test');
  observeBootRenderer(renderer);
  notifyBootCoreScenePresented();
  notifyBootCoreScenePresented();
}

const owners = new Map<string, symbol>();
function ownerOf(id: string): symbol {
  let o = owners.get(id);
  if (!o) {
    o = Symbol(id);
    owners.set(id, o);
  }
  return o;
}

function ackAllBuildings(renderer: object = RENDERER_A): void {
  for (const id of BUILDING_IDS) {
    ackBuildingCommit(id, ownerOf(id));
    ackBuildingWarm(id, ownerOf(id), renderer);
  }
}

beforeEach(() => {
  pendingTimers.length = 0;
  owners.clear();
  dom.hidden = false;
  dom.overlayPresent = true; // BGR default: the overlay is UP while buildings stream
  dom.transitionPhase = null;
  installDom();
  __resetDecorativeReleaseForTests();
  __resetBootStreamCohortForTests();
});

afterEach(() => {
  (globalThis as any).window = originalWindow;
  (globalThis as any).document = originalDocument;
});

describe('stage A — byte-fetch lane', () => {
  test('fires only when epoch exists AND mode is glb (either order)', () => {
    let fired = 0;
    onBootBuildingsFetch(() => {
      fired += 1;
    });
    expect(fired).toBe(0);
    declareBootBuildingsMode('glb', Symbol('c'));
    expect(fired).toBe(0); // no epoch yet
    ensureWorldBootEpoch();
    expect(fired).toBe(1);
  });

  test("mode 'absent' suppresses the byte-warm entirely", () => {
    let fired = 0;
    onBootBuildingsFetch(() => {
      fired += 1;
    });
    ensureWorldBootEpoch();
    declareBootBuildingsMode('absent', Symbol('c'));
    expect(fired).toBe(0);
  });

  test('parks while the tab is hidden', () => {
    let fired = 0;
    dom.hidden = true;
    onBootBuildingsFetch(() => {
      fired += 1;
    });
    declareBootBuildingsMode('glb', Symbol('c'));
    ensureWorldBootEpoch();
    expect(fired).toBe(0);
    dom.hidden = false;
    // A new subscriber re-evaluates (the visibilitychange listener does the
    // same on a real document) — BOTH queued listeners deliver.
    let fired2 = 0;
    onBootBuildingsFetch(() => {
      fired2 += 1;
    });
    expect(fired).toBe(1);
    expect(fired2).toBe(1);
  });
});

describe('stage B — mount/warm lane', () => {
  test('eligible at first core presentation, NOT at overlay dismissal', () => {
    ensureWorldBootEpoch();
    expect(isBootBuildingsStreamEligible()).toBe(false);
    presentBootCore(); // overlay PRESENT — must not matter
    expect(isBootCorePresented()).toBe(true);
    expect(isBootBuildingsStreamEligible()).toBe(true);
  });

  test('queued members deliver in priority order, one per tick', () => {
    const order: string[] = [];
    onBootBuildingsStream(() => order.push('far'), 100, 'building:far');
    onBootBuildingsStream(() => order.push('near'), 1, 'building:near');
    expect(order).toEqual([]);
    presentBootCore();
    flushTimers();
    expect(order).toEqual(['near', 'far']);
  });

  test('a renderer-generation bump does NOT re-park stage B', () => {
    presentBootCore(RENDERER_A);
    expect(isBootBuildingsStreamEligible()).toBe(true);
    observeBootRenderer(RENDERER_B); // bump
    expect(isBootBuildingsStreamEligible()).toBe(true);
  });

  test('fail-open admission [impl-B7]: a fuse dismissal streams buildings even when core never presents', () => {
    const delivered: string[] = [];
    onBootBuildingsStream(() => delivered.push('x'), 0, 'building:x');
    expect(isBootBuildingsStreamEligible()).toBe(false);
    // Core NEVER presents (notifier regression). The loading fuse fires:
    forceBootBuildingsStreamEligible('loading-visibility-fuse');
    expect(isBootBuildingsStreamEligible()).toBe(true);
    flushTimers();
    expect(delivered).toEqual(['x']);
  });
});

describe('ack protocol + BOOT_BUILDINGS_PRESENTED', () => {
  test('milestone needs 11 live tokens + two qualifying frames', () => {
    declareBootBuildingsMode('glb', Symbol('c'));
    presentBootCore(RENDERER_A);
    for (const id of BUILDING_IDS.slice(0, 10)) {
      ackBuildingCommit(id, ownerOf(id));
      ackBuildingWarm(id, ownerOf(id), RENDERER_A);
    }
    notifyBootBuildingsScenePresented();
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsPresented()).toBe(false); // 10 of 11
    ackBuildingCommit(BUILDING_IDS[10]!, ownerOf(BUILDING_IDS[10]!));
    ackBuildingWarm(BUILDING_IDS[10]!, ownerOf(BUILDING_IDS[10]!), RENDERER_A);
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsPresented()).toBe(false); // one frame only
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsPresented()).toBe(true);
  });

  test('a token revoked mid-run resets the frame counter', () => {
    declareBootBuildingsMode('glb', Symbol('c'));
    presentBootCore(RENDERER_A);
    ackAllBuildings(RENDERER_A);
    notifyBootBuildingsScenePresented(); // frame 1
    revokeBuildingCommit(BUILDING_IDS[0]!, ownerOf(BUILDING_IDS[0]!));
    notifyBootBuildingsScenePresented(); // token missing → reset
    ackBuildingCommit(BUILDING_IDS[0]!, ownerOf(BUILDING_IDS[0]!));
    notifyBootBuildingsScenePresented(); // frame 1 again
    expect(isBootBuildingsPresented()).toBe(false);
    notifyBootBuildingsScenePresented(); // frame 2
    expect(isBootBuildingsPresented()).toBe(true);
  });

  test('instance-record revocation [impl-B5]: an old instance unmount cannot delete a new instance token', () => {
    declareBootBuildingsMode('glb', Symbol('c'));
    presentBootCore(RENDERER_A);
    const id = BUILDING_IDS[0]!;
    const oldOwner = Symbol('old');
    const newOwner = Symbol('new');
    ackBuildingCommit(id, oldOwner);
    ackBuildingWarm(id, oldOwner, RENDERER_A);
    ackBuildingCommit(id, newOwner);
    ackBuildingWarm(id, newOwner, RENDERER_A);
    expect(getBootBuildingsAckProgress().acked).toBe(1);
    revokeBuildingInstance(id, oldOwner); // outgoing canvas unmount
    expect(getBootBuildingsAckProgress().acked).toBe(1); // new instance survives
    revokeBuildingInstance(id, newOwner);
    expect(getBootBuildingsAckProgress().acked).toBe(0);
  });

  test('legs cannot be spliced across instances [fix-NF3]', () => {
    declareBootBuildingsMode('glb', Symbol('c'));
    presentBootCore(RENDERER_A);
    const id = BUILDING_IDS[0]!;
    const instanceA = Symbol('canvas-a');
    const instanceB = Symbol('canvas-b');
    // Outgoing A committed (stale); incoming B warmed but NOT committed yet.
    ackBuildingCommit(id, instanceA);
    ackBuildingWarm(id, instanceB, RENDERER_A);
    expect(getBootBuildingsAckProgress().acked).toBe(0); // never combined
    ackBuildingCommit(id, instanceB); // B's own commit lands
    expect(getBootBuildingsAckProgress().acked).toBe(1);
  });

  test('identity-keyed warm legs [impl-B4/fix-NF2]: additive, validate on observation, never overwritten by stale completions', () => {
    declareBootBuildingsMode('glb', Symbol('c'));
    presentBootCore(RENDERER_A);
    // Warms complete against renderer B BEFORE B is ever observed.
    for (const id of BUILDING_IDS) {
      ackBuildingCommit(id, ownerOf(id));
      ackBuildingWarm(id, ownerOf(id), RENDERER_B);
    }
    expect(getBootBuildingsAckProgress().acked).toBe(0); // observed is A
    observeBootRenderer(RENDERER_B); // B's first frame — bump + observe
    // Tokens become live WITHOUT any re-warm event:
    expect(getBootBuildingsAckProgress().acked).toBe(11);
    // [fix-NF2] a DELAYED renderer-A completion is ADDITIVE — it can never
    // overwrite the valid renderer-B ack and drop progress permanently.
    ackBuildingWarm(BUILDING_IDS[0]!, ownerOf(BUILDING_IDS[0]!), RENDERER_A);
    expect(getBootBuildingsAckProgress().acked).toBe(11);
  });

  test('generation bump resets BOTH presented milestones; failed markers are durable', () => {
    declareBootBuildingsMode('glb', Symbol('c'));
    presentBootCore(RENDERER_A);
    ackAllBuildings(RENDERER_A);
    notifyBootBuildingsScenePresented();
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsPresented()).toBe(true);
    expect(getBootRendererGeneration()).toBe(1);
    observeBootRenderer(RENDERER_B); // replacement → bump
    expect(getBootRendererGeneration()).toBe(2);
    expect(isBootBuildingsPresented()).toBe(false);
    expect(isBootCorePresented()).toBe(false);
    expect(getBootBuildingsAckProgress().acked).toBe(0); // A-warms don't match B
    // A failed boundary is durable — no re-ack dance needed:
    ackBuildingFailed(BUILDING_IDS[0]!, ownerOf(BUILDING_IDS[0]!));
    for (const id of BUILDING_IDS.slice(1)) {
      ackBuildingWarm(id, ownerOf(id), RENDERER_B); // commit legs still live
    }
    expect(getBootBuildingsAckProgress().acked).toBe(11);
    presentBootCore(RENDERER_B);
    notifyBootBuildingsScenePresented();
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsPresented()).toBe(true);
  });

  test('milestone never stamps outside glb mode', () => {
    presentBootCore(RENDERER_A);
    ackAllBuildings(RENDERER_A);
    notifyBootBuildingsScenePresented();
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsPresented()).toBe(false); // 'pending'
    declareBootBuildingsMode('absent', Symbol('c'));
    notifyBootBuildingsScenePresented();
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsPresented()).toBe(false);
  });
});

describe('guide reveal requirement (founder amendment 2026-08-20)', () => {
  test('undeclared → required set is the 11 buildings (legacy behavior)', () => {
    expect(getBootRevealRequiredIds()).toHaveLength(11);
    expect(getBootBuildingsAckProgress().total).toBe(11);
  });

  test('declared required → Nori joins the set and GATES the milestone', () => {
    declareBootBuildingsMode('glb', Symbol('c'));
    declareBootGuideRevealRequired(true, Symbol('canvas'));
    expect(getBootRevealRequiredIds()).toHaveLength(12);
    presentBootCore(RENDERER_A);
    ackAllBuildings(RENDERER_A); // 11 buildings acked — Nori missing
    notifyBootBuildingsScenePresented();
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsPresented()).toBe(false); // 11 of 12
    const guideOwner = Symbol('nori');
    ackBuildingCommit(BGR_GUIDE_COHORT_ID, guideOwner);
    ackBuildingWarm(BGR_GUIDE_COHORT_ID, guideOwner, RENDERER_A);
    expect(getBootBuildingsAckProgress().acked).toBe(12);
    notifyBootBuildingsScenePresented();
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsPresented()).toBe(true);
  });

  test('[nori-NF2] a LATE requirement declaration RESETS an 11-token milestone', () => {
    declareBootBuildingsMode('glb', Symbol('c'));
    presentBootCore(RENDERER_A);
    ackAllBuildings(RENDERER_A);
    notifyBootBuildingsScenePresented();
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsPresented()).toBe(true); // stamped against 11
    declareBootGuideRevealRequired(true, Symbol('canvas')); // set GROWS
    expect(isBootBuildingsPresented()).toBe(false); // milestone reset
    expect(isBootBuildingsRevealLegSatisfied()).toBe(false);
    const guideOwner = Symbol('nori');
    ackBuildingCommit(BGR_GUIDE_COHORT_ID, guideOwner);
    ackBuildingWarm(BGR_GUIDE_COHORT_ID, guideOwner, RENDERER_A);
    notifyBootBuildingsScenePresented();
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsPresented()).toBe(true); // re-proven with 12
    const phases = (globalThis as any).window.__W3D_PHASES;
    expect(phases.bootRevealPresentedRequired).toBe(12);
    expect(phases.bootRevealPresentedFailed).toBe(0);
  });

  test('declared NOT required (NPC-less boot) → 11 tokens suffice', () => {
    declareBootBuildingsMode('glb', Symbol('c'));
    declareBootGuideRevealRequired(false, Symbol('canvas'));
    presentBootCore(RENDERER_A);
    ackAllBuildings(RENDERER_A);
    notifyBootBuildingsScenePresented();
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsPresented()).toBe(true);
  });

  test('owner-keyed reset: a non-owner cannot clear the requirement', () => {
    const canvasA = Symbol('a');
    const canvasB = Symbol('b');
    declareBootGuideRevealRequired(true, canvasA);
    declareBootGuideRevealRequired(true, canvasB); // B takes ownership
    resetBootGuideRevealRequired(canvasA); // A's late cleanup — no-op
    expect(getBootRevealRequiredIds()).toHaveLength(12);
    resetBootGuideRevealRequired(canvasB);
    expect(getBootRevealRequiredIds()).toHaveLength(11);
  });

  test('guide tier delivers FIRST on stage B, ahead of every building', () => {
    const order: string[] = [];
    onBootBuildingsStream(
      () => order.push('building'),
      BOOT_STREAM_TIER_BUILDINGS, // nearest possible building
      'building:x',
    );
    onBootBuildingsStream(
      () => order.push('nori'),
      BOOT_STREAM_TIER_GUIDE + 500 * 500, // guide tier + a real distance
      BGR_GUIDE_COHORT_ID,
    );
    presentBootCore(RENDERER_A);
    flushTimers();
    expect(order).toEqual(['nori', 'building']);
  });
});

describe('mode declaration + reveal leg', () => {
  test("leg: 'absent' trivially satisfied, 'pending' unsatisfiable, 'glb' needs the milestone", () => {
    expect(getBootBuildingsMode()).toBe('pending');
    expect(isBootBuildingsRevealLegSatisfied()).toBe(false);
    declareBootBuildingsMode('absent', Symbol('c'));
    expect(isBootBuildingsRevealLegSatisfied()).toBe(true);
    declareBootBuildingsMode('glb', Symbol('c2'));
    expect(isBootBuildingsRevealLegSatisfied()).toBe(false);
    presentBootCore(RENDERER_A);
    ackAllBuildings(RENDERER_A);
    notifyBootBuildingsScenePresented();
    notifyBootBuildingsScenePresented();
    expect(isBootBuildingsRevealLegSatisfied()).toBe(true);
  });

  test('owner-keyed reset [impl-B6]: an outgoing canvas cannot clobber the incoming declaration', () => {
    const canvasA = Symbol('canvas-a');
    const canvasB = Symbol('canvas-b');
    declareBootBuildingsMode('absent', canvasA);
    // Incoming canvas B declares BEFORE A's cleanup runs (React SPA overlap):
    declareBootBuildingsMode('glb', canvasB);
    expect(getBootBuildingsMode()).toBe('glb');
    resetBootBuildingsMode(canvasA); // A's late cleanup — must be a no-op
    expect(getBootBuildingsMode()).toBe('glb');
    resetBootBuildingsMode(canvasB); // the real owner unmounts
    expect(getBootBuildingsMode()).toBe('pending');
  });
});

describe('dismissal stamp', () => {
  test('first-writer-wins — a later composite cannot launder a fuse reason', () => {
    expect(stampLoadingDismiss('milestone-fallback')).toBe(true);
    expect(stampLoadingDismiss('composite')).toBe(false);
    expect(getLoadingDismissReason()).toBe('milestone-fallback');
    const phases = (globalThis as any).window.__W3D_PHASES;
    expect(phases.loadingDismissReason).toBe('milestone-fallback');
    expect(typeof phases.loadingDismissedAt).toBe('number');
    expect(typeof phases.loadingDismissGen).toBe('number');
  });
});

describe('cohort buildings-subset settle', () => {
  test('stamps when all 11 buildings are terminal (failed counts), before the full cohort', () => {
    declareBootBuildingsMode('glb', Symbol('c'));
    expect(areBootBuildingsSettled()).toBe(false);
    for (const id of BUILDING_IDS.slice(0, 10)) {
      reportCohortState(id, 'ready-warmed');
    }
    expect(areBootBuildingsSettled()).toBe(false);
    reportCohortState(BUILDING_IDS[10]!, 'failed');
    expect(areBootBuildingsSettled()).toBe(true);
    const stampedAt = getBootBuildingsSettledAt();
    expect(stampedAt).not.toBeNull();
    // Provenance copy-stamps [impl-B8]:
    const phases = (globalThis as any).window.__W3D_PHASES;
    expect(phases.bootBuildingsSettledMode).toBe('glb');
    expect(typeof phases.bootBuildingsSettledGen).toBe('number');
    // Full cohort (props + NPCs pending) is NOT settled.
    expect(getStreamSettledAt()).toBeNull();
    // Stamp is once-only.
    reportCohortState('prop:bazaar-stall', 'ready-warmed');
    expect(getBootBuildingsSettledAt()).toBe(stampedAt);
  });
});
