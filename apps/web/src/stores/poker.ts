/**
 * Poker store — Phase P1.2b Texas Hold'em table state (web side).
 *
 * A lightweight zustand store that mirrors the server-authoritative poker
 * table for the active room. It is the web-side counterpart to the
 * activity store (`./activity.ts`) but scoped to the namespaced `poker.*`
 * server frames. It deliberately does NOT touch the activity store's
 * reef-race / bumper-shells state — the two are separate concerns sharing
 * the same WS hub.
 *
 * ─── Writer API (mirrors the activity store) ─────────────────────────────────
 *
 *   applyServerFrame(frame)   — single switchboard for the poker.* ServerFrame
 *                               subset. The activity store's `applyServerFrame`
 *                               delegates every `poker.*` frame here so the
 *                               exhaustiveness sentinel stays satisfied and the
 *                               poker UI (LATER phase) has a clean seam to read.
 *   reset(roomId)             — clears table state on room change / unmount.
 *   setSelfAvatarId(id)       — records which seat is "us" so private frames
 *                               (hole cards + your-turn) can be filtered.
 *   setConnectionStatus(s)    — parity with the activity store; HUD may read it.
 *
 * ─── Scope (P1.2b) ───────────────────────────────────────────────────────────
 *
 * This phase ONLY lands the type-safe seam + state container. The full felt
 * UI (`<PokerTable>`) lands in a LATER phase (P1.2c) and will read:
 *   - `table` (public snapshot — pot, board, seats, to-act)
 *   - `holeCards` (PRIVATE — our two cards, never broadcast)
 *   - `seatView` (PRIVATE — legal actions + bet bounds on our turn)
 *   - `lastShowdown` / `lastHandResult` (post-resolution reveals + seed)
 *
 * PRIVATE frames (`poker.hole_cards`, `poker.your_turn`) are delivered to a
 * single seat over `sendToAvatar` and carry hole cards. They are kept ONLY in
 * this store's `holeCards` / `seatView` fields and never merged into the public
 * `table` snapshot, preserving the hidden-state invariant on the client too.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  ServerFrame,
  PokerPublicTableSnapshot,
  PokerPrivateSeatView,
  PokerCard,
  PokerHandResult,
  PokerHandResultSeat,
  PokerStreet,
} from '@clawville/shared';
import type { ConnectionStatus } from './activity';

/**
 * The `poker.*` subset of `ServerFrame`. Extracting it by the namespaced
 * `type` prefix keeps `applyServerFrame` here narrow + makes the activity
 * store's delegation site type-safe (it passes exactly this subset).
 */
export type PokerServerFrame = Extract<ServerFrame, { type: `poker.${string}` }>;

// ─── Store interface ──────────────────────────────────────────────────────────

export interface PokerState {
  // ── Identity / connection (parity with activity store) ──────────────────
  /** Active room id this poker state belongs to (used by `reset` guard). */
  roomId: string | null;
  /** Our own avatar id — gates which seat the PRIVATE frames belong to. */
  selfAvatarId: string | null;
  connectionStatus: ConnectionStatus;

  // ── Public table state (from `poker.table_state`, keyframe-safe) ────────
  /** Latest full public table snapshot. null until the first `table_state`. */
  table: PokerPublicTableSnapshot | null;
  /**
   * Cumulative community board for the current street. Mirrors
   * `table.board` but is ALSO updated eagerly by `poker.street_dealt` so the
   * deal animation has a frame to react to before the next `table_state`.
   */
  board: PokerCard[];

  // ── Private (self-seat-only) state — NEVER from a broadcast ─────────────
  /**
   * Our two hole cards for the current hand, from `poker.hole_cards`
   * (PRIVATE, `sendToAvatar`). null between hands / before deal. This is the
   * client mirror of the hidden-state invariant: no public frame ever writes
   * here.
   */
  holeCards: [PokerCard, PokerCard] | null;
  /** Hand number the `holeCards` belong to (stale-guard across hands). */
  holeCardsHandNumber: number | null;
  /**
   * Our private seat view (legal actions + bet bounds + deadline) when it is
   * our turn, from `poker.your_turn` (PRIVATE). null when it is not our turn.
   */
  seatView: PokerPrivateSeatView | null;
  /** Hand number the `seatView` belongs to (stale-guard). */
  seatViewHandNumber: number | null;

  // ── Post-resolution reveals ─────────────────────────────────────────────
  /**
   * Last showdown reveal (`poker.showdown`) — public per-seat results +
   * final board. Folded seats muck (`holeCards: null`). null until first
   * showdown.
   */
  lastShowdown: {
    handNumber: number;
    board: PokerCard[];
    seats: PokerHandResultSeat[];
  } | null;
  /**
   * Last fully-resolved hand (`poker.hand_ended`) including
   * `serverSeedRevealed` for commit-reveal verification. null until first
   * resolved hand.
   */
  lastHandResult: PokerHandResult | null;
  /**
   * Last accepted street deal (`poker.street_dealt`) — pure UI/animation
   * signal. Replaced (not appended) on each deal. null until first flop.
   */
  lastStreetDealt: { handNumber: number; street: PokerStreet; board: PokerCard[] } | null;

  // ── Writer API (mirrors the activity store) ─────────────────────────────
  /** Single switchboard for the poker.* ServerFrame subset. */
  applyServerFrame: (frame: PokerServerFrame) => void;
  reset: (roomId: string | null) => void;
  setSelfAvatarId: (avatarId: string | null) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
}

// ─── Empty-state factory (shared by initial state + reset) ────────────────────

function emptyTableState(): Pick<
  PokerState,
  | 'table'
  | 'board'
  | 'holeCards'
  | 'holeCardsHandNumber'
  | 'seatView'
  | 'seatViewHandNumber'
  | 'lastShowdown'
  | 'lastHandResult'
  | 'lastStreetDealt'
> {
  return {
    table: null,
    board: [],
    holeCards: null,
    holeCardsHandNumber: null,
    seatView: null,
    seatViewHandNumber: null,
    lastShowdown: null,
    lastHandResult: null,
    lastStreetDealt: null,
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const usePokerStore = create<PokerState>()(
  subscribeWithSelector((set, get) => ({
    roomId: null,
    selfAvatarId: null,
    connectionStatus: 'idle',
    ...emptyTableState(),

    setSelfAvatarId: (avatarId) => set({ selfAvatarId: avatarId }),
    setConnectionStatus: (status) => set({ connectionStatus: status }),

    reset: (roomId) =>
      set({
        roomId,
        ...emptyTableState(),
      }),

    applyServerFrame: (frame) => {
      const state = get();

      switch (frame.type) {
        // ── PUBLIC: full table snapshot (keyframe-safe) ─────────────────
        case 'poker.table_state': {
          set({
            table: frame.snapshot,
            board: frame.snapshot.board,
          });
          break;
        }

        // ── PUBLIC: a new community street was dealt ────────────────────
        case 'poker.street_dealt': {
          // Eager board update so the deal animation has something to react
          // to before the next table_state lands. table_state stays the
          // source of truth for everything else.
          set({
            board: frame.board,
            lastStreetDealt: {
              handNumber: frame.handNumber,
              street: frame.street,
              board: frame.board,
            },
          });
          break;
        }

        // ── PUBLIC: one seat's action was accepted + applied ────────────
        // Pure UI/animation signal — authoritative state rides table_state.
        // No-op until the felt UI (P1.2c) wires action toasts.
        // TODO(P1.2c): surface per-seat action animation (chip slide / fold).
        case 'poker.action_applied':
          break;

        // ── PUBLIC: showdown reveal (post-resolution only) ──────────────
        case 'poker.showdown': {
          set({
            lastShowdown: {
              handNumber: frame.handNumber,
              board: frame.board,
              seats: frame.seats,
            },
            board: frame.board,
          });
          break;
        }

        // ── PUBLIC: hand fully resolved (carries serverSeedRevealed) ────
        case 'poker.hand_ended': {
          // Clear our private hand state — the hand is over. Keep the result
          // for the post-hand summary + commit-reveal verification.
          set({
            lastHandResult: frame.result,
            holeCards: null,
            holeCardsHandNumber: null,
            seatView: null,
            seatViewHandNumber: null,
          });
          break;
        }

        // ── PRIVATE: our own hole cards (sendToAvatar only) ─────────────
        case 'poker.hole_cards': {
          set({
            holeCards: frame.holeCards,
            holeCardsHandNumber: frame.handNumber,
          });
          break;
        }

        // ── PRIVATE: it is our turn — legal actions + bet bounds ────────
        case 'poker.your_turn': {
          set({
            seatView: frame.view,
            seatViewHandNumber: frame.handNumber,
            // Keep hole cards in sync — your_turn carries them in `view`.
            holeCards: frame.view.holeCards,
            holeCardsHandNumber: frame.handNumber,
          });
          break;
        }

        default: {
          // Exhaustiveness sentinel — a new poker.* ServerFrame variant
          // without a branch here fails typecheck.
          const _exhaustive: never = frame;
          void _exhaustive;
        }
      }

      void state;
    },
  })),
);
