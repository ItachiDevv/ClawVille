/**
 * Poker MTT (P5) — SIM-level tests for the socket-less agent read surface
 * (`getSeatViewForAgent` + `getActionAdvice`). Pure: NO DB, NO ledger, NO HTTP —
 * a `PokerTableSim` with a fake clock, one started hand, driven directly. These
 * lock the invariants the agent REST/tool surface depends on:
 *
 *   - HIDDEN STATE: an agent's poll view carries ONLY its OWN hole cards; no other
 *     seat's cards are reachable through the view (the public `table` block carries
 *     none — a leak there is a compile error — and the private block is the
 *     requesting seat's own cards).
 *   - ON/OFF TURN: `isYourTurn` is true ONLY for the to-act seat; off-turn the
 *     view returns `legalActions: []` (no off-turn action is legal).
 *   - ADVISOR = NON-STAKING: `getActionAdvice` NEVER mutates table state (no chip
 *     moves, no street advance) — calling it 100× leaves the snapshot byte-identical
 *     — and returns a recommendation that is in the seat's legal-action set on-turn,
 *     `null` off-turn.
 *
 * Determinism: fixed seeds + a no-auto-fire fake clock, so the dealt hands + the
 * to-act pointer are fully reproducible.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { PokerTableSim } from '../poker-table-sim';
import type { SimClock, BroadcastFn, SendToSeatFn, StartHandArgs } from '../poker-table-types';

class FakeClock implements SimClock {
  private t = 1_000_000;
  now(): number {
    return this.t;
  }
  setTimer(): unknown {
    return null; // turns are driven explicitly; never auto-fire
  }
  clearTimer(): void {
    /* no-op */
  }
}

const TABLE_ID = 'mtt:test';

/** Start a fresh 3-handed hand with deterministic seeds. */
function startHand(sim: PokerTableSim): void {
  const args: StartHandArgs = {
    tableId: TABLE_ID,
    handNumber: 1,
    seatAssignments: [
      { seatIndex: 0, avatarId: 'av-0', name: 'Zero', subjectType: 'agent', agentId: 'agent-0', chipStack: 1000 },
      { seatIndex: 1, avatarId: 'av-1', name: 'One', subjectType: 'human', chipStack: 1000 },
      { seatIndex: 2, avatarId: 'av-2', name: 'Two', subjectType: 'human', chipStack: 1000 },
    ],
    blinds: { sb: 10, bb: 20, ante: 0 },
    buttonSeatIndex: 0,
    serverSeed: 'a'.repeat(64),
    clientSeed: 'deadbeef',
    turnClockMs: 25_000,
    agentTurnGraceMs: 5_000,
    blindLevel: 1,
  };
  sim.startHand(args);
}

describe('PokerTableSim — agent poll view + advisor (P5, pure)', () => {
  let sim: PokerTableSim;

  beforeEach(() => {
    sim = new PokerTableSim(new FakeClock());
    // Swallow WS callbacks — we read state directly.
    const broadcast: BroadcastFn = () => {};
    const sendToSeat: SendToSeatFn = () => {};
    sim.setBroadcastFn(broadcast);
    sim.setSendToSeatFn(sendToSeat);
    startHand(sim);
  });

  it('getSeatViewForAgent returns the seat OWN hole cards + public table (no other cards)', () => {
    const view = sim.getSeatViewForAgent(TABLE_ID, 'av-0');
    expect(view).not.toBeNull();
    expect(view!.seatIndex).toBe(0);
    // Own two hole cards present.
    expect(view!.holeCards.length).toBe(2);
    // The public `table` block carries NO holeCards on any seat (type guarantee;
    // assert structurally too — no seat object should expose a `hole*` field).
    for (const seat of view!.table.seats) {
      expect(Object.keys(seat).some((k) => k.toLowerCase().includes('hole') || k.toLowerCase().includes('card'))).toBe(false);
    }
    expect(view!.handNumber).toBe(1);
  });

  it('NEVER leaks another seat\'s hole cards through any seat\'s view', () => {
    const v0 = sim.getSeatViewForAgent(TABLE_ID, 'av-0')!;
    const v1 = sim.getSeatViewForAgent(TABLE_ID, 'av-1')!;
    const v2 = sim.getSeatViewForAgent(TABLE_ID, 'av-2')!;
    // Each view's hole cards differ from the others (distinct deals) AND the
    // serialized public table NEVER contains any seat's hole-card encoding.
    const allHole = [v0.holeCards, v1.holeCards, v2.holeCards];
    // Serialize each view's PUBLIC table and assert no OTHER seat's hole card
    // string appears in it (the only place a card legitimately appears is the
    // private `holeCards` field, which we exclude from this check).
    for (const v of [v0, v1, v2]) {
      const publicJson = JSON.stringify(v.table);
      for (const hole of allHole) {
        for (const card of hole) {
          // A hole card is {rank,suit}; its JSON fragment must not be in the
          // public table snapshot (the board cards are separate objects — a hole
          // card landing on the board would be a dealing bug, not a leak, and the
          // deterministic deck never duplicates).
          const frag = JSON.stringify(card);
          expect(publicJson.includes(frag)).toBe(false);
        }
      }
    }
  });

  it('isYourTurn is true ONLY for the to-act seat; off-turn legalActions is empty', () => {
    const snap = sim.getPublicSnapshot(TABLE_ID)!;
    const toAct = snap.toActSeatIndex;
    expect(toAct).not.toBeNull();
    const toActAvatar = snap.seats.find((s) => s.seatIndex === toAct)!.avatarId;

    for (const av of ['av-0', 'av-1', 'av-2']) {
      const v = sim.getSeatViewForAgent(TABLE_ID, av)!;
      if (av === toActAvatar) {
        expect(v.isYourTurn).toBe(true);
        expect(v.legalActions.length).toBeGreaterThan(0);
        expect(v.deadlineMs).not.toBeNull();
      } else {
        expect(v.isYourTurn).toBe(false);
        expect(v.legalActions).toEqual([]);
        expect(v.deadlineMs).toBeNull();
      }
    }
  });

  it('returns null for an avatar not seated / a missing table', () => {
    expect(sim.getSeatViewForAgent(TABLE_ID, 'av-nope')).toBeNull();
    expect(sim.getSeatViewForAgent('mtt:missing', 'av-0')).toBeNull();
    expect(sim.getActionAdvice(TABLE_ID, 'av-nope')).toBeNull();
    expect(sim.getActionAdvice('mtt:missing', 'av-0')).toBeNull();
  });

  it('getActionAdvice is NON-STAKING — it never mutates table state', () => {
    const before = JSON.stringify(sim.getPublicSnapshot(TABLE_ID));
    for (let i = 0; i < 100; i++) {
      for (const av of ['av-0', 'av-1', 'av-2']) sim.getActionAdvice(TABLE_ID, av);
    }
    const after = JSON.stringify(sim.getPublicSnapshot(TABLE_ID));
    expect(after).toBe(before); // byte-identical — no chip moved, no street advanced
  });

  it('advisor recommends a LEGAL action on-turn, null off-turn', () => {
    const snap = sim.getPublicSnapshot(TABLE_ID)!;
    const toActAvatar = snap.seats.find((s) => s.seatIndex === snap.toActSeatIndex)!.avatarId;

    const onTurn = sim.getActionAdvice(TABLE_ID, toActAvatar)!;
    expect(onTurn.recommended).not.toBeNull();
    expect(onTurn.strength).toBeGreaterThanOrEqual(0);
    expect(onTurn.strength).toBeLessThanOrEqual(1);
    // The recommended action kind is in the legal set the view reports.
    const legal = sim.getSeatViewForAgent(TABLE_ID, toActAvatar)!.legalActions;
    expect(legal).toContain(onTurn.recommended!.kind);
    // A bet/raise amount is clamped into the legal band.
    if (onTurn.recommended!.kind === 'bet' || onTurn.recommended!.kind === 'raise') {
      const view = sim.getSeatViewForAgent(TABLE_ID, toActAvatar)!;
      expect(onTurn.recommended!.amount).toBeGreaterThanOrEqual(view.minRaiseTo);
      expect(onTurn.recommended!.amount).toBeLessThanOrEqual(view.maxRaiseTo);
    }

    // An off-turn seat gets a recommendation of null (still a strength estimate).
    const offTurnAvatar = ['av-0', 'av-1', 'av-2'].find((a) => a !== toActAvatar)!;
    const offTurn = sim.getActionAdvice(TABLE_ID, offTurnAvatar)!;
    expect(offTurn.recommended).toBeNull();
  });
});
