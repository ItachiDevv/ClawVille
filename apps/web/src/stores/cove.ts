'use client';

/**
 * Cove slot screen Zustand store — Phase 6.1 (slice 5: real API wired)
 *
 * Holds UI-only state for the slot machine modal. The authoritative balance,
 * counters, and seed material live in the API (slot_sessions + slot_spins).
 * This store tracks:
 *
 *   - Which slot machine is open
 *   - Server-issued session id + seed material (mirrored from open response)
 *   - Latest balance + session totals (snapshot, refreshed per spin)
 *   - Spin animation state (transient)
 *
 * Reset on close. NEVER persisted to localStorage — auth/cookie + server
 * state are the durable record. Local mock state has been removed; the
 * `mockSpin` engine was deleted in slice 5.
 */

import { create } from 'zustand';
import type { MachineSlug, SpinResult } from '@/lib/cove/types';
import { COVE_HOLDEM_DEFAULT_BUYIN } from '@clawville/shared';

// ---------------------------------------------------------------------------
// Store state
// ---------------------------------------------------------------------------
export interface CoveStore {
  // ── Modal state ──────────────────────────────────────────────────────────
  /** Whether the slot screen modal is open */
  slotScreenOpen: boolean;
  /** Which machine is open */
  machineSlug: MachineSlug | null;
  /** Which paytable is loaded */
  paytableId: MachineSlug | null;

  // ── Server session metadata (populated after openSlotSession succeeds) ───
  /** Server-issued session UUID. null until /session/open returns. */
  sessionId: string | null;
  /** Public commit hash — safe to display in HUD/fairness tooltip. */
  serverSeedHash: string | null;
  /** Server-issued client seed (8 random hex bytes today). */
  clientSeed: string | null;
  /** Revealed server seed after close (null while open). */
  revealedServerSeed: string | null;

  // ── Live balance + session totals (snapshot, refreshed per spin) ─────────
  /** Authoritative ClawToken balance after the last spin. */
  sessionBalance: number;
  /** Snapshot of the balance at open-time, used to derive sessionPnl in the HUD. */
  sessionStartBalance: number;
  /** Number of spins recorded in this session (server count). */
  spinCount: number;
  /** Cumulative net P&L this session (sessionBalance - sessionStartBalance). */
  sessionPnl: number;

  // ── Spin animation / result state ────────────────────────────────────────
  /** Whether a spin is currently animating (reels spinning). */
  isSpinning: boolean;
  /** Last spin result (null before first spin). */
  lastSpinResult: SpinResult | null;

  // ── Actions ──────────────────────────────────────────────────────────────
  openSlotScreen: (machineSlug: MachineSlug, paytableId: MachineSlug, startBalance: number) => void;
  /** Populate server-issued session metadata after /session/open succeeds. */
  setSessionMeta: (meta: {
    sessionId: string;
    serverSeedHash: string;
    clientSeed: string;
    walletBalance: number;
  }) => void;
  /** Reset session metadata to null (called on closeSlotScreen). */
  clearSessionMeta: () => void;
  /** Reveal the server seed after /session/close. */
  setRevealedServerSeed: (seed: string) => void;
  closeSlotScreen: () => void;
  setIsSpinning: (spinning: boolean) => void;
  /**
   * Record a fully resolved spin (from the server response). Updates
   * lastSpinResult + spinCount + sessionBalance + sessionPnl.
   *
   * Note: `balance` is the authoritative post-spin balance from the server,
   * NOT a delta. We deliberately do NOT recompute balance locally to avoid
   * drift if the server credits an out-of-band ClawToken delta between
   * /spin responses (e.g. login bonus interleaving).
   */
  recordSpin: (result: SpinResult, balance: number, spinCount: number) => void;
  /** Update session balance directly (for win credit, loss debit). */
  adjustBalance: (delta: number) => void;

  // ── Hold'em modal state (Phase 6.5.0 visual shell) ───────────────────────
  // The modal state machine + bot opponents + bankroll display are owned
  // entirely inside `HoldemModal` (impl-modal). The store only tracks
  // open/closed + the initial buy-in so the 3D hotspot can launch the
  // modal with a sensible default (capped to current bankroll). Real
  // ledger integration arrives in Phase 6.5.1.
  holdemModalOpen: boolean;
  /** Buy-in offered when the modal opens, in display ClawTokens. */
  holdemBuyIn: number;
  /**
   * Open the Hold'em table modal.
   *
   * @param balance — current display bankroll (avatar.clawTokens). Used to
   *   cap the offered buy-in at `min(balance, COVE_HOLDEM_DEFAULT_BUYIN)`
   *   so a low-balance player isn't auto-bet over their stack.
   */
  openHoldemTable: (balance: number) => void;
  closeHoldemTable: () => void;

  // ── Blackjack modal state (Phase 6.4.1 — real authoritative engine) ──────
  // The store only owns modal open/close + the selected bet. All gameplay
  // state (shoe, hand, cards, outcome, balance) is server-authoritative and
  // lives inside BlackjackModal, mirrored from the /api/cove/blackjack
  // responses — never recomputed locally. `displayBalance` passed to
  // openBlackjackTable seeds the header until the first server response.
  blackjackOpen: boolean;
  blackjackBet: number;
  /** Snapshot of avatar.clawTokens at open-time (header seed only). */
  blackjackDisplayBalance: number;
  openBlackjackTable: (displayBalance: number) => void;
  closeBlackjackTable: () => void;
  setBlackjackBet: (bet: number) => void;
}

export const useCoveStore = create<CoveStore>((set, get) => ({
  slotScreenOpen: false,
  machineSlug: null,
  paytableId: null,
  sessionId: null,
  serverSeedHash: null,
  clientSeed: null,
  revealedServerSeed: null,
  sessionStartBalance: 0,
  sessionBalance: 0,
  spinCount: 0,
  sessionPnl: 0,
  isSpinning: false,
  lastSpinResult: null,

  openSlotScreen: (machineSlug, paytableId, startBalance) => {
    set({
      slotScreenOpen: true,
      machineSlug,
      paytableId,
      sessionId: null,
      serverSeedHash: null,
      clientSeed: null,
      revealedServerSeed: null,
      sessionStartBalance: startBalance,
      sessionBalance: startBalance,
      spinCount: 0,
      sessionPnl: 0,
      isSpinning: false,
      lastSpinResult: null,
    });
  },

  setSessionMeta: ({ sessionId, serverSeedHash, clientSeed, walletBalance }) => {
    // walletBalance is the AUTHORITATIVE balance from the server, snapshot
    // both as the PnL baseline AND the displayed balance. Replaces the
    // stale-cache `avatar?.clawTokens ?? 60` heuristic from openSlotScreen.
    set({
      sessionId,
      serverSeedHash,
      clientSeed,
      revealedServerSeed: null,
      sessionStartBalance: walletBalance,
      sessionBalance: walletBalance,
      sessionPnl: 0,
    });
  },

  clearSessionMeta: () => {
    set({
      sessionId: null,
      serverSeedHash: null,
      clientSeed: null,
      revealedServerSeed: null,
    });
  },

  setRevealedServerSeed: (seed) => {
    set({ revealedServerSeed: seed });
  },

  closeSlotScreen: () => {
    set({
      slotScreenOpen: false,
      machineSlug: null,
      paytableId: null,
      sessionId: null,
      serverSeedHash: null,
      clientSeed: null,
      revealedServerSeed: null,
      isSpinning: false,
    });
  },

  setIsSpinning: (spinning) => set({ isSpinning: spinning }),

  recordSpin: (result, balance, spinCount) => {
    const { sessionStartBalance } = get();
    set({
      lastSpinResult: result,
      sessionBalance: balance,
      spinCount,
      sessionPnl: balance - sessionStartBalance,
    });
  },

  adjustBalance: (delta) => {
    const { sessionBalance } = get();
    set({ sessionBalance: sessionBalance + delta });
  },

  // Hold'em state (Phase 6.5.0 visual shell)
  holdemModalOpen: false,
  holdemBuyIn: COVE_HOLDEM_DEFAULT_BUYIN,

  openHoldemTable: (balance) => {
    // Cap suggested buy-in at the caller's bankroll so low-balance players
    // don't get auto-bet over their stack. Floor at 0 so a negative value
    // (shouldn't happen but defensive) doesn't pass through to the modal.
    const buyIn = Math.max(0, Math.min(balance, COVE_HOLDEM_DEFAULT_BUYIN));
    set({ holdemModalOpen: true, holdemBuyIn: buyIn });
  },

  closeHoldemTable: () => {
    set({ holdemModalOpen: false });
  },

  // Blackjack state (Phase 6.4.1 — real authoritative engine).
  // Bet default 50 is a valid 5–500 chip. Modal owns the rest.
  blackjackOpen: false,
  blackjackBet: 50,
  blackjackDisplayBalance: 0,

  openBlackjackTable: (displayBalance) => {
    set({
      blackjackOpen: true,
      blackjackBet: 50,
      blackjackDisplayBalance: displayBalance,
    });
  },

  closeBlackjackTable: () => {
    set({ blackjackOpen: false });
  },

  setBlackjackBet: (bet) => set({ blackjackBet: bet }),
}));
