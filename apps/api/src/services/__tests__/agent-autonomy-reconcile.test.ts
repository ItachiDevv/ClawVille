/**
 * §B.1 durable-autonomy RECONCILE — DB-free coverage of the server-side
 * re-enrollment decision logic (the reconcile that makes a deploy invisible to a
 * browser-closed persisting agent). The DB flag query + the real activation are
 * injected seams; here we lock the DECISIONS:
 *   - re-enrolls flagged+live owners that aren't already driving,
 *   - SKIPS already-enrolled owners (idempotent across passes),
 *   - SKIPS owners the human is currently driving (no double-body / no fight),
 *   - over-cap STAYS flagged + retries (never silently cleared),
 *   - terminally-ineligible left flagged (self-heals at TTL),
 *   - the overlap guard prevents a slow pass from stacking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { npcSimulation } from '../npc-simulation';
import { agentAutonomyDriver } from '../agent-autonomy-driver';
import {
  reconcileSeams,
  reconcileDurableAutonomy,
  _resetReconcileGuard,
} from '../agent-autonomy-reconcile';
import type { ActivateAutonomyResult } from '../agent-autonomy-activation';

const U1 = '11111111-1111-4111-8111-111111111111';
const A1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const A2 = 'bbbbbbbb-2222-4222-8222-222222222222';

const originalList = reconcileSeams.listFlaggedLiveOwners;
const originalActivate = reconcileSeams.activate;

/** Record activate() calls; return a configurable result per userId. */
let activateCalls: string[] = [];
let activateResult: (userId: string) => ActivateAutonomyResult = () => ({
  ok: true,
  reused: false,
  bodyId: 'ocb-x',
});

function clearDriver() {
  for (const id of agentAutonomyDriver.getUserAgentIds()) {
    agentAutonomyDriver.unregisterUserAgent(id);
  }
  for (const id of agentAutonomyDriver.getHouseAgentIds()) {
    agentAutonomyDriver.unregisterHouseAgent(id);
  }
}

beforeEach(() => {
  _resetReconcileGuard();
  clearDriver();
  (npcSimulation as unknown as {
    humanControlledOpenClawUntil: Map<string, number>;
    humanControlledOpenClawLaunchesByUser: Map<string, Set<string>>;
  }).humanControlledOpenClawUntil.clear();
  (npcSimulation as unknown as {
    humanControlledOpenClawLaunchesByUser: Map<string, Set<string>>;
  }).humanControlledOpenClawLaunchesByUser.clear();
  activateCalls = [];
  activateResult = () => ({ ok: true, reused: false, bodyId: 'ocb-x' });
  reconcileSeams.activate = async (userId: string) => {
    activateCalls.push(userId);
    return activateResult(userId);
  };
});

afterEach(() => {
  reconcileSeams.listFlaggedLiveOwners = originalList;
  reconcileSeams.activate = originalActivate;
  _resetReconcileGuard();
  clearDriver();
});

describe('reconcileDurableAutonomy', () => {
  it('re-enrolls every flagged+live owner not already driving', async () => {
    reconcileSeams.listFlaggedLiveOwners = async () => [
      { agentId: A1, userId: U1 },
      { agentId: A2, userId: U2 },
    ];
    const r = await reconcileDurableAutonomy();
    expect(r.candidates).toBe(2);
    expect(r.enrolled).toBe(2);
    expect(activateCalls.sort()).toEqual([U1, U2].sort());
  });

  it('SKIPS an owner already enrolled in this process (idempotent across restarts/passes)', async () => {
    // Simulate the owner already driving (a prior activate / a live process).
    agentAutonomyDriver.registerUserAgent({
      agentId: A1,
      bodyId: 'ocb-a1',
      platformAgentId: A1,
      systemUserId: U1,
      houseUserId: U1,
      avatarId: 'av-1',
    });
    reconcileSeams.listFlaggedLiveOwners = async () => [{ agentId: A1, userId: U1 }];
    const r = await reconcileDurableAutonomy();
    expect(r.skipped).toBe(1);
    expect(r.enrolled).toBe(0);
    expect(activateCalls).toEqual([]); // never re-activated an already-enrolled owner
  });

  it('SKIPS an owner the human is currently driving (suppression window live)', async () => {
    npcSimulation.bindHumanControlledOpenClawLaunch(U2, A2);
    npcSimulation.markHumanControlledOpenClaw(A2, 15_000);
    expect(npcSimulation.isAgentHumanControlled(A2)).toBe(true);
    reconcileSeams.listFlaggedLiveOwners = async () => [{ agentId: A2, userId: U2 }];
    const r = await reconcileDurableAutonomy();
    expect(r.skipped).toBe(1);
    expect(activateCalls).toEqual([]);
  });

  it('over-cap STAYS flagged + is tallied as capacity (never cleared, retries next pass)', async () => {
    activateResult = () => ({ ok: false, code: 'autonomy_capacity' });
    reconcileSeams.listFlaggedLiveOwners = async () => [{ agentId: A1, userId: U1 }];
    const r = await reconcileDurableAutonomy();
    expect(r.capacity).toBe(1);
    expect(r.enrolled).toBe(0);
    // Reconcile has NO flag-clear path (only teardowns clear), so the row stays
    // flagged for the next pass — a second reconcile re-attempts it.
    const r2 = await reconcileDurableAutonomy();
    expect(r2.candidates).toBe(1);
    expect(r2.capacity).toBe(1);
  });

  it('terminally-ineligible (e.g. no_agent) is left flagged (self-heals at TTL), tallied ineligible', async () => {
    activateResult = () => ({ ok: false, code: 'no_agent' });
    reconcileSeams.listFlaggedLiveOwners = async () => [{ agentId: A1, userId: U1 }];
    const r = await reconcileDurableAutonomy();
    expect(r.ineligible).toBe(1);
    expect(r.enrolled).toBe(0);
  });

  it('idempotent: a repeat pass after a successful enroll skips (no duplicate enroll)', async () => {
    // First pass: the injected activate actually enrolls (mirror the real effect).
    reconcileSeams.activate = async (userId: string) => {
      activateCalls.push(userId);
      agentAutonomyDriver.registerUserAgent({
        agentId: A1,
        bodyId: 'ocb-a1',
        platformAgentId: A1,
        systemUserId: userId,
        houseUserId: userId,
        avatarId: 'av-1',
      });
      return { ok: true, reused: false, bodyId: 'ocb-a1' };
    };
    reconcileSeams.listFlaggedLiveOwners = async () => [{ agentId: A1, userId: U1 }];
    const first = await reconcileDurableAutonomy();
    expect(first.enrolled).toBe(1);
    const second = await reconcileDurableAutonomy();
    expect(second.enrolled).toBe(0);
    expect(second.skipped).toBe(1); // already enrolled → skipped
    expect(activateCalls).toEqual([U1]); // enrolled exactly once
  });

  it('house registry is never touched (reconcile only lists non-house rows)', async () => {
    agentAutonomyDriver.registerHouseAgent({
      agentId: 'house-r',
      bodyId: 'ocb-house-r',
      platformAgentId: 'house-p',
      systemUserId: 'sys',
      houseUserId: 'hu',
      avatarId: 'ha',
    });
    // The production query filters is_house=false; the injected list is empty.
    reconcileSeams.listFlaggedLiveOwners = async () => [];
    await reconcileDurableAutonomy();
    expect(agentAutonomyDriver.hasHouseAgent('house-r')).toBe(true);
  });

  it('overlap guard: a second pass while one is in flight returns early (no stacking)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    reconcileSeams.listFlaggedLiveOwners = async () => {
      await gate; // hold the first pass open
      return [{ agentId: A1, userId: U1 }];
    };
    const p1 = reconcileDurableAutonomy();
    // Second call while p1 is awaiting the gate → guard returns an empty tally.
    const r2 = await reconcileDurableAutonomy();
    expect(r2.candidates).toBe(0);
    expect(r2.enrolled).toBe(0);
    release();
    const r1 = await p1;
    expect(r1.candidates).toBe(1);
    expect(r1.enrolled).toBe(1);
  });
});
