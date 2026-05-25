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
import type { BlackjackOutcome, BlackjackCard } from '@/lib/cove/blackjack-types';

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

  // ── Blackjack modal state (Phase 6.4.0 display shell) ────────────────────
  blackjackOpen: boolean;
  blackjackBet: number;
  blackjackOutcome: BlackjackOutcome | null;
  blackjackPayout: number;
  blackjackPlayerHand: BlackjackCard[];
  blackjackDealerHand: BlackjackCard[];
  blackjackOutcomeLabel: string | null;
  blackjackIsDealing: boolean;
  /** Stub balance shown in modal — not from ledger in 6.4.0. */
  blackjackDisplayBalance: number;
  openBlackjackTable: (displayBalance: number) => void;
  closeBlackjackTable: () => void;
  setBlackjackBet: (bet: number) => void;
  setBlackjackResult: (
    outcome: BlackjackOutcome,
    payout: number,
    playerHand: BlackjackCard[],
    dealerHand: BlackjackCard[],
    outcomeLabel: string,
  ) => void;
  setBlackjackIsDealing: (dealing: boolean) => void;
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

  // Blackjack state (Phase 6.4.0)
  blackjackOpen: false,
  blackjackBet: 50,
  blackjackOutcome: null,
  blackjackPayout: 0,
  blackjackPlayerHand: [],
  blackjackDealerHand: [],
  blackjackOutcomeLabel: null,
  blackjackIsDealing: false,
  blackjackDisplayBalance: 0,

  openBlackjackTable: (displayBalance) => {
    set({
      blackjackOpen: true,
      blackjackBet: 50,
      blackjackOutcome: null,
      blackjackPayout: 0,
      blackjackPlayerHand: [],
      blackjackDealerHand: [],
      blackjackOutcomeLabel: null,
      blackjackIsDealing: false,
      blackjackDisplayBalance: displayBalance,
    });
  },

  closeBlackjackTable: () => {
    set({
      blackjackOpen: false,
      blackjackOutcome: null,
      blackjackPayout: 0,
      blackjackPlayerHand: [],
      blackjackDealerHand: [],
      blackjackOutcomeLabel: null,
      blackjackIsDealing: false,
    });
  },

  setBlackjackBet: (bet) => set({ blackjackBet: bet }),

  setBlackjackResult: (outcome, payout, playerHand, dealerHand, outcomeLabel) => {
    set({ blackjackOutcome: outcome, blackjackPayout: payout, blackjackPlayerHand: playerHand, blackjackDealerHand: dealerHand, blackjackOutcomeLabel: outcomeLabel });
  },

  setBlackjackIsDealing: (dealing) => set({ blackjackIsDealing: dealing }),
}));
