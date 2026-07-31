/**
 * Poker MTT (P3.5) — the LIVE WS bridge that makes tournament tables PLAYABLE
 * over WebSocket (humans + agents acting in tournament hands).
 *
 * ── WHAT THIS WIRES (and why it lives in ONE module) ─────────────────────────
 *
 * The `TournamentManager` drives the DEDICATED `pokerMttSim` directly (one
 * `mtt:<tournamentId>` table, multi-hand loop). P3 had NO live transport — hands
 * were driven by a scripted auto-actor in tests. This bridge adds the real WS
 * transport WITHOUT coupling the TM (which stays import-free of the room manager
 * + hub so its unit tests mock only db + ledger) to the WS layer:
 *
 *   1. `onSeatFn`  — at seating, create ONE LONG-LIVED `texas-holdem-mtt` activity
 *      room with the seated entrants as participants and flip it straight to
 *      `live` (no countdown wait; the TM owns hand-starting). The room goes live
 *      ONCE and the TM's multi-hand loop runs hand after hand WITHIN it — the room
 *      FSM does NOT cycle per hand. Returns `{ roomId, shortCode }` to the TM.
 *   2. `onTournamentEndFn` — at completion, transition that room → `results`.
 *   3. `pokerMttSim.setBroadcastFn`  → `activityWsHub.broadcastEvent(poker.table_state)`
 *      (NEVER `broadcastSnapshot` — a dropped turn-state frame desyncs betting).
 *   4. `pokerMttSim.setSendToSeatFn` → `activityWsHub.sendToAvatar(poker.hole_cards
 *      + poker.your_turn)` (PRIVATE per-seat — carries hole cards, never broadcast).
 *   5. AUGMENT the TM's hand-complete handler: the TM already owns `setHandCompleteFn`
 *      on the MTT sim (its multi-hand loop). We CANNOT overwrite it (that single-field
 *      setter would clobber the loop — the exact P3 isolation bug). Instead we register
 *      a SHOWDOWN BROADCAST callback on the SIM (a NEW append-style hook) so the public
 *      `poker.showdown` (only on a real showdown) + `poker.hand_ended` frames fan out
 *      to the room WITHOUT touching the TM's hand-complete handler.
 *
 * ── ISOLATION FROM THE DEMO PATH ─────────────────────────────────────────────
 *
 * The hub's `handlePokerAction` dispatches by `room.activityId`:
 *   - `texas-holdem`     → the DEMO `pokerTableSim` (tableId === roomId).
 *   - `texas-holdem-mtt` → the MTT `pokerMttSim` (tableId === `mtt:<id>`,
 *     translated from roomId via `tournamentManager.resolveRoomToTable`).
 * The two sims + activityIds never share state, so neither path can affect the
 * other (verified by the integration test's dispatch-isolation assertion).
 */

import { activityWsHub } from '../activity/activity-ws-hub';
import { activityRoomManager } from '../activity/activity-room-manager';
import { getActivityDefinition } from '@clawville/shared';
import type { PokerTableSim } from './poker-table-sim';
import type { TournamentManager, MttSeatPlan } from './tournament-manager';
import type { Street } from './poker-table-types';

/** The activityId tournament tables run under — isolated from the demo `texas-holdem`. */
export const MTT_ACTIVITY_ID = 'texas-holdem-mtt';
const MTT_OWNER_LEASE = 'poker-mtt-tournament-manager';
const MTT_OWNER_LEASE_WINDOW_MS = 15 * 60_000;

/**
 * Wire the MTT sim + TournamentManager to the activity WS hub.
 *
 * Pure side-effect setup (registers callbacks). Idempotent in practice —
 * re-calling re-registers the same single-field setters with equivalent fns
 * (used by the test's `beforeEach` re-wire after `__resetForTest`).
 *
 * @param sim the MTT sim instance (production: `pokerMttSim`; test: a fake-clock sim)
 * @param tm  the TournamentManager bound to that sim (so `resolveRoomToTable` works)
 */
export function wirePokerMttToHub(sim: PokerTableSim, tm: TournamentManager): void {
  // ── (0) Register the hub's tournament-table dispatch seam ───────────────────
  // The hub routes an inbound `poker.action` on a `texas-holdem-mtt` room to THIS
  // sim, addressing the sim table via `resolveRoomToTable`. Both production + the
  // integration test register through this same path so dispatch always hits the
  // sim+TM that seated the room.
  activityWsHub.setMttDispatch({
    sim,
    resolveRoomToTable: (roomId) => tm.resolveRoomToTable(roomId),
  });

  // ── (3) Public table state → broadcast (keyframe-safe path) ─────────────────
  // tableId here is the sim's `mtt:<id>`; translate to the WS roomId so the hub
  // can fan it to the room's connections.
  sim.setBroadcastFn((tableId, snapshot) => {
    const roomId = tm.resolveTableToRoom(tableId);
    if (!roomId) return; // no live WS room for this table (shouldn't happen post-seat)
    activityRoomManager.renewLiveOwnerLease(
      roomId,
      MTT_OWNER_LEASE,
      Date.now() + MTT_OWNER_LEASE_WINDOW_MS,
    );
    activityWsHub.broadcastEvent(roomId, {
      type: 'poker.table_state',
      snapshot,
    });
  });

  // ── (4) Private per-seat view → the ONE seat (hole cards + your-turn) ────────
  sim.setSendToSeatFn((tableId, avatarId, view) => {
    const roomId = tm.resolveTableToRoom(tableId);
    if (!roomId) return;
    activityWsHub.sendToAvatar(roomId, avatarId, {
      type: 'poker.hole_cards',
      handNumber: view.handNumber,
      seatIndex: view.seatIndex,
      holeCards: view.holeCards,
    });
    activityWsHub.sendToAvatar(roomId, avatarId, {
      type: 'poker.your_turn',
      handNumber: view.handNumber,
      view,
    });
  });

  // ── (5) Showdown / hand-ended public fan-out — ADDITIVE to the TM's loop ─────
  // The TM owns `setHandCompleteFn` (its multi-hand loop). This separate hook
  // fires on the SAME resolveHand boundary but only BROADCASTS — it never advances
  // the loop, so it cannot clobber (nor be clobbered by) the TM's handler.
  sim.setShowdownBroadcastFn((tableId, result) => {
    const roomId = tm.resolveTableToRoom(tableId);
    if (!roomId) return;
    activityRoomManager.renewLiveOwnerLease(
      roomId,
      MTT_OWNER_LEASE,
      Date.now() + MTT_OWNER_LEASE_WINDOW_MS,
    );
    // Public showdown reveal — ONLY on a genuine showdown. On a fold-around
    // (endedAt !== 'showdown') nobody shows, so we skip it; the hand_ended payload
    // below still carries the resolution. The sim already nulls every folded
    // seat's holeCards, and on a fold-around nulls ALL of them.
    if (result.endedAt === ('showdown' satisfies Street)) {
      activityWsHub.broadcastEvent(roomId, {
        type: 'poker.showdown',
        handNumber: result.handNumber,
        board: result.board,
        seats: result.perSeat,
      });
    }
    activityWsHub.broadcastEvent(roomId, {
      type: 'poker.hand_ended',
      result,
    });
  });

  // ── (6) Abort-notify: an mtt room aborting → recover the tournament escrow ───
  // A poker table holds a bounded owner lease, renewed at every hand boundary.
  // If that owner dies and the lease expires, this callback resolves the owning
  // tournament and cancels/refunds escrow idempotently so CT is never stranded.
  activityRoomManager.setAbortNotifyFn((roomId, activityId) => {
    if (activityId !== MTT_ACTIVITY_ID) return;
    void tm.onRoomAborted(roomId);
  });

  // ── (1) Seat seam: create ONE long-lived MTT room PER TABLE + go live ───────
  tm.setSeatHandlers({
    onSeatFn: async ({ seats }) => {
      const def = getActivityDefinition(MTT_ACTIVITY_ID);
      // The room manager enforces participants.length <= maxPlayers; fall back to
      // the seat count if the registry entry is somehow missing (defensive).
      const maxPlayers = def?.maxPlayers ?? Math.max(seats.length, 9);
      const room = await activityRoomManager.createRoom(
        MTT_ACTIVITY_ID,
        seats.map((s: MttSeatPlan) => ({
          avatarId: s.avatarId,
          userId: null,
          agentId: s.agentId,
          subjectType: s.subjectType,
          partyId: null,
        })),
        { minPlayers: 2, maxPlayers, preferredPlayers: seats.length },
      );
      // createRoom auto-transitions pending → countdown (with a 5s auto-live
      // timer). The TM owns hand-starting, so we flip to LIVE IMMEDIATELY — this
      // cancels the pending countdown timer (transitionRoom clears it on any exit
      // from countdown) and fires `liveTransitionFn`, whose `texas-holdem-mtt`
      // branch is a deliberate NO-OP (the TM, not the dispatcher, starts hand 1).
      await activityRoomManager.transitionRoom(room.id, 'live');
      activityRoomManager.acquireLiveOwnerLease(
        room.id,
        MTT_OWNER_LEASE,
        Date.now() + MTT_OWNER_LEASE_WINDOW_MS,
      );
      return { roomId: room.id, shortCode: room.shortCode, activityId: MTT_ACTIVITY_ID };
    },
    onTournamentEndFn: async ({ roomId }) => {
      const room = activityRoomManager.getRoom(roomId);
      // Only a LIVE room can go → results (FSM guard). A room already swept /
      // GC'd (or never created) is a silent no-op.
      if (room && room.state === 'live') {
        await activityRoomManager.transitionRoom(roomId, 'results');
      }
    },
    // ── (7) Rebalance move: tell the moved player its NEW room/seat + notify ──
    // both tables. The moved player's client re-opens its WS to the destination
    // room (later phase); for now we deliver `poker.moved` on the OLD room's
    // connection (the player is still authed there until it reconnects) and
    // `poker.table_rebalanced` to both tables so spectators/clients refresh.
    onMoveFn: ({
      avatarId,
      fromRoomId,
      toRoomId,
      toShortCode,
      toSeatIndex,
      chipStack,
      reason,
    }) => {
      // poker.moved → the moved player (PRIVATE). Sent on the OLD room while it
      // still holds the player's authed connection (the client re-opens to the
      // new room on receipt). If the old room is gone, this is a silent no-op.
      if (fromRoomId) {
        activityWsHub.sendToAvatar(fromRoomId, avatarId, {
          type: 'poker.moved',
          toRoomId: toRoomId ?? '',
          toShortCode: toShortCode ?? '',
          seatIndex: toSeatIndex,
          chipStack,
          reason,
        });
      }
      // poker.table_rebalanced → both affected tables (PUBLIC) so connected
      // clients refresh their seat list.
      if (fromRoomId) {
        activityWsHub.broadcastEvent(fromRoomId, {
          type: 'poker.table_rebalanced',
          avatarId,
          direction: 'left',
          reason,
        });
      }
      if (toRoomId) {
        activityWsHub.broadcastEvent(toRoomId, {
          type: 'poker.table_rebalanced',
          avatarId,
          direction: 'joined',
          reason,
        });
      }
    },
  });
}
