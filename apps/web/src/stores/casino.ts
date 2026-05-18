'use client';

/**
 * Casino slot screen Zustand store — Phase 6.0
 *
 * Manages:
 *   - Which slot machine is open (machineSlug + paytableId)
 *   - In-memory ClawToken balance delta (no API calls in 6.0)
 *   - Session spin count
 *   - Session P&L (cumulative win - cumulative bet)
 *
 * Phase 6.1: replace in-memory balance with API session state.
 * The store shape is designed so 6.1 can add sessionId/sessionStatus
 * fields without touching any call-site.
 */

import { create } from 'zustand';
import type { SpinResult } from '@/lib/casino/types';
import type { MachineSlug } from '@/lib/casino/types';
import { resetMockCursor } from '@/lib/casino/mock-engine';

// ---------------------------------------------------------------------------
// Store state
// ---------------------------------------------------------------------------
export interface CasinoStore {
  // ── Modal state ──────────────────────────────────────────────────────────
  /** Whether the slot screen modal is open */
  slotScreenOpen: boolean;
  /** Which machine is open */
  machineSlug: MachineSlug | null;
  /** Which paytable is loaded */
  paytableId: MachineSlug | null;

  // ── Session tracking (in-memory only for 6.0) ────────────────────────────
  /** Starting balance at session open (snapshot of avatar.clawTokens) */
  sessionStartBalance: number;
  /** Current in-session balance (startBalance + wins - bets) */
  sessionBalance: number;
  /** Number of spins in this session */
  spinCount: number;
  /** Cumulative net P&L this session (negative = loss) */
  sessionPnl: number;

  // ── Spin animation / result state ────────────────────────────────────────
  /** Whether a spin is currently animating */
  isSpinning: boolean;
  /** Last spin result (null before first spin) */
  lastSpinResult: SpinResult | null;

  // ── Actions ──────────────────────────────────────────────────────────────
  openSlotScreen: (machineSlug: MachineSlug, paytableId: MachineSlug, startBalance: number) => void;
  closeSlotScreen: () => void;
  setIsSpinning: (spinning: boolean) => void;
  recordSpin: (result: SpinResult, bet: number) => void;
  /** Update session balance directly (for win credit, loss debit) */
  adjustBalance: (delta: number) => void;
}

export const useCasinoStore = create<CasinoStore>((set, get) => ({
  slotScreenOpen: false,
  machineSlug: null,
  paytableId: null,
  sessionStartBalance: 0,
  sessionBalance: 0,
  spinCount: 0,
  sessionPnl: 0,
  isSpinning: false,
  lastSpinResult: null,

  openSlotScreen: (machineSlug, paytableId, startBalance) => {
    resetMockCursor();
    set({
      slotScreenOpen: true,
      machineSlug,
      paytableId,
      sessionStartBalance: startBalance,
      sessionBalance: startBalance,
      spinCount: 0,
      sessionPnl: 0,
      isSpinning: false,
      lastSpinResult: null,
    });
  },

  closeSlotScreen: () => {
    set({
      slotScreenOpen: false,
      machineSlug: null,
      paytableId: null,
      isSpinning: false,
    });
  },

  setIsSpinning: (spinning) => set({ isSpinning: spinning }),

  recordSpin: (result, bet) => {
    const { sessionBalance, spinCount, sessionPnl, sessionStartBalance } = get();
    const winAmount = Number(result.winAmount); // safe: ClawTokens fit in JS number
    const newBalance = sessionBalance - bet + winAmount;
    const newPnl = newBalance - sessionStartBalance;
    set({
      lastSpinResult: result,
      sessionBalance: newBalance,
      spinCount: spinCount + 1,
      sessionPnl: newPnl,
    });
  },

  adjustBalance: (delta) => {
    const { sessionBalance } = get();
    set({ sessionBalance: sessionBalance + delta });
  },
}));
