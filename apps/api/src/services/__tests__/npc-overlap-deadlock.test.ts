/**
 * Regression test for NPC entity-push deadlock (2026-05-31).
 *
 * Symptom on prod: two NPCs walking toward each other freeze at exactly
 * `combinedHalf` distance because the half-push in resolveNpcNpcOverlaps
 * cancels each path step. `stuckTicks` doesn't trip because the
 * perpendicular push counts as `moved >= 2`. The client renders the walk
 * cycle in place ("moonwalk") because the server reports a non-idle
 * direction continuously.
 *
 * Fix: track `overlapTicks` per NPC and have the lex-lower id of an
 * overlapping pair yield (abandon path, drop to idle, replan after a
 * cooldown) once it accumulates >= 3 consecutive overlap ticks.
 *
 * These tests poke the singleton via the `as any` cast escape hatch —
 * the deadlock-break logic lives inside the private resolveNpcNpcOverlaps
 * method, and the trade-off of exposing it publicly just for testing
 * isn't worth the API surface bloat.
 */

import { describe, expect, it, beforeEach } from 'bun:test';

import { npcSimulation } from '../npc-simulation';

type Sim = {
  npcs: Map<string, any>;
  resolveNpcNpcOverlaps: () => void;
  initNpcs: () => void;
};

function asSim(): Sim {
  return npcSimulation as unknown as Sim;
}

beforeEach(() => {
  // Re-seed the NPC roster. initNpcs() clears the existing map and re-spawns
  // every entry from NPC_DEFINITIONS at its homeX/homeY. Tests then mutate
  // selected NPCs into the deadlock scenario.
  asSim().initNpcs();
});

/**
 * Drive a deadlock by placing two chibi-class NPCs 40 wu apart on the same
 * y-axis, each with an active path that crosses through the other. Chibi
 * halfOf = 25, so combinedHalf = 50 — 40 wu separation triggers overlap.
 * After enough ticks of resolveNpcNpcOverlaps, the lex-lower id should
 * yield. The yield logic itself doesn't depend on which species class.
 */
function setupDeadlock(loId: string, hiId: string, sharedY: number) {
  const sim = asSim();
  const lo = sim.npcs.get(loId);
  const hi = sim.npcs.get(hiId);
  if (!lo) throw new Error(`Missing NPC ${loId}`);
  if (!hi) throw new Error(`Missing NPC ${hiId}`);

  // Confirm the test fixtures are actually lex-ordered the way we expect —
  // production behavior assumes a.id < b.id picks the yielder.
  expect(loId < hiId).toBe(true);

  lo.x = 5000;
  lo.y = sharedY;
  lo.path = [{ x: 5100, y: sharedY }, { x: 5200, y: sharedY }];
  lo.pathIndex = 0;
  lo.activity = 'walking';
  lo.direction = 'right';
  lo.behaviorCooldown = 0;
  lo.overlapTicks = 0;

  hi.x = 5040; // 40 wu apart — inside combinedHalf=50 for chibi pair
  hi.y = sharedY;
  hi.path = [{ x: 4940, y: sharedY }, { x: 4840, y: sharedY }];
  hi.pathIndex = 0;
  hi.activity = 'walking';
  hi.direction = 'left';
  hi.behaviorCooldown = 0;
  hi.overlapTicks = 0;
}

/**
 * The push-out in resolveNpcNpcOverlaps SEPARATES the pair by half-overlap
 * each. In production, the next tick's `moveNpcs` advances each NPC toward
 * its waypoint, putting them right back inside `combinedHalf`. To repro
 * the deadlock in isolation, we reset their positions to overlap before
 * each call — modelling the path-step ratchet without dragging the full
 * tick() into the unit test.
 */
function tickWithRatchet(loId: string, hiId: string, sharedY: number): void {
  const sim = asSim();
  const lo = sim.npcs.get(loId);
  const hi = sim.npcs.get(hiId);
  // Skip the ratchet once a NPC has yielded (path empty) — in production the
  // higher-id NPC would have walked past by now, but we model the simpler
  // case where the yielder stays put and we stop forcing the overlap.
  if (lo.path.length > 0 && hi.path.length > 0) {
    lo.x = 5000;
    lo.y = sharedY;
    hi.x = 5040;
    hi.y = sharedY;
  }
  sim.resolveNpcNpcOverlaps();
}

describe('resolveNpcNpcOverlaps — deadlock-yield', () => {
  it('lex-lower NPC yields after 3 consecutive overlap ticks', () => {
    setupDeadlock('chibi-eliza', 'chibi-milady', 6000);
    const sim = asSim();
    const lo = sim.npcs.get('chibi-eliza');
    const hi = sim.npcs.get('chibi-milady');

    // Tick 1 — both should record overlap=1, neither yields yet
    tickWithRatchet('chibi-eliza', 'chibi-milady', 6000);
    expect(lo.overlapTicks).toBe(1);
    expect(hi.overlapTicks).toBe(1);
    expect(lo.path.length).toBeGreaterThan(0); // not yielded
    expect(hi.path.length).toBeGreaterThan(0);

    // Tick 2 — overlap=2, still no yield
    tickWithRatchet('chibi-eliza', 'chibi-milady', 6000);
    expect(lo.overlapTicks).toBe(2);
    expect(hi.overlapTicks).toBe(2);
    expect(lo.path.length).toBeGreaterThan(0);

    // Tick 3 — lex-lower hits threshold, yields
    tickWithRatchet('chibi-eliza', 'chibi-milady', 6000);
    expect(lo.path.length).toBe(0); // path abandoned
    expect(lo.activity).toBe('idle');
    expect(lo.direction).toBe('idle');
    expect(lo.intentDescription).toBe('Stepping aside');
    expect(lo.behaviorCooldown).toBeGreaterThanOrEqual(8);
    expect(lo.behaviorCooldown).toBeLessThanOrEqual(15);
    expect(lo.overlapTicks).toBe(0); // reset on yield

    // hi keeps its path — the world stays in motion
    expect(hi.path.length).toBeGreaterThan(0);
    expect(hi.activity).toBe('walking');
  });

  it('non-overlapping pair never yields, overlapTicks stays at 0', () => {
    const sim = asSim();
    const a = sim.npcs.get('chibi-eliza');
    const b = sim.npcs.get('chibi-milady');
    a.x = 5000;
    a.y = 5000;
    b.x = 6000; // 1000 wu apart, far outside any combinedHalf
    b.y = 5000;
    a.path = [{ x: 5050, y: 5000 }];
    b.path = [{ x: 6050, y: 5000 }];
    a.activity = b.activity = 'walking';

    for (let i = 0; i < 5; i++) sim.resolveNpcNpcOverlaps();

    expect(a.overlapTicks).toBe(0);
    expect(b.overlapTicks).toBe(0);
    expect(a.path.length).toBe(1);
    expect(b.path.length).toBe(1);
  });

  it('overlap that resolves before threshold does not yield', () => {
    setupDeadlock('chibi-eliza', 'chibi-milady', 6000);
    const sim = asSim();
    const lo = sim.npcs.get('chibi-eliza');
    const hi = sim.npcs.get('chibi-milady');

    sim.resolveNpcNpcOverlaps(); // overlap tick 1
    sim.resolveNpcNpcOverlaps(); // overlap tick 2

    // Simulate the pair stepping past each other this frame (no overlap)
    lo.x = 5500;
    hi.x = 4500;

    sim.resolveNpcNpcOverlaps();
    // No overlap this tick — counters reset
    expect(lo.overlapTicks).toBe(0);
    expect(hi.overlapTicks).toBe(0);
    expect(lo.path.length).toBeGreaterThan(0); // still walking
    expect(lo.activity).toBe('walking');
  });

  it('does not yield NPCs that are in conversation', () => {
    setupDeadlock('chibi-eliza', 'chibi-milady', 6000);
    const sim = asSim();
    const lo = sim.npcs.get('chibi-eliza');

    // Mark the lex-lower NPC as in-conversation. resolveNpcNpcOverlaps
    // should skip them entirely (the overlap loop filters on
    // !inConversation), so they never accumulate overlap ticks AND never
    // get force-yielded.
    lo.inConversation = true;

    for (let i = 0; i < 5; i++) sim.resolveNpcNpcOverlaps();

    expect(lo.overlapTicks).toBe(0);
    expect(lo.path.length).toBeGreaterThan(0);
  });

  it('asymmetric yield: hi-id NPC is never the yielder', () => {
    setupDeadlock('chibi-eliza', 'chibi-milady', 6000);
    const sim = asSim();
    const lo = sim.npcs.get('chibi-eliza');
    const hi = sim.npcs.get('chibi-milady');

    // Run 10 ticks of overlap with the path-step ratchet
    for (let i = 0; i < 10; i++) tickWithRatchet('chibi-eliza', 'chibi-milady', 6000);

    // lo yielded on tick 3
    expect(lo.activity).toBe('idle');
    // hi never yielded — its path remains intact
    expect(hi.path.length).toBeGreaterThan(0);
    expect(hi.activity).toBe('walking');
  });
});
