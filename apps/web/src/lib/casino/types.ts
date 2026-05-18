/**
 * Casino Slot Types — Single Source of Truth
 *
 * This file defines the SpinResult contract shared between:
 *   - apps/web/src/lib/casino/mock-engine.ts  (Phase 6.0 — Math.random() mock)
 *   - apps/api/src/services/slot-engine.ts    (Phase 6.1 — HMAC-derived RNG + pokie)
 *
 * SWAP CONTRACT: Phase 6.1 swap-in is implementation-only.
 * SpinResult, WinningLine, Paytable, SymbolId, MachineSlug must NOT change.
 *
 * Key invariants:
 *   - reels is ALWAYS [5][3] — 5 reels × 3 visible rows.
 *   - winAmount is bigint in atomic units (1 = 1 ClawToken, or 1 lamport / 1 µUSDC in 6.2).
 *   - cursorAfter increments monotonically per session (mock: counter; real: HMAC byte cursor).
 *   - freeSpinsAwarded / isFreeSpin are always 0 / false in 6.0 MVP.
 */

// ---------------------------------------------------------------------------
// Symbol identifier — index into a paytable's symbolDefs array
// ---------------------------------------------------------------------------
export type SymbolId = number;

// ---------------------------------------------------------------------------
// Machine slug — identifies which paytable to load
// ---------------------------------------------------------------------------
export type MachineSlug = 'classic-3x5';

// ---------------------------------------------------------------------------
// A single winning payline result
// ---------------------------------------------------------------------------
export interface WinningLine {
  /** 0-indexed payline number in a 20-payline grid */
  lineIndex: number;
  /** Symbol indices on this line (one per reel — length=5) */
  symbols: SymbolId[];
  /** Payout in atomic units (bigint for Phase 6.2 lamport precision) */
  winAmount: bigint;
  /** Multiplier from the paytable (e.g. 5 for a 5× win) */
  multiplier: number;
}

// ---------------------------------------------------------------------------
// Full spin result — identical shape between mock and real engine
// ---------------------------------------------------------------------------
export interface SpinResult {
  /**
   * 5 reels × 3 visible rows of symbol indices.
   * reels[0] = leftmost reel, reels[4] = rightmost reel.
   * reels[r][0] = top row, reels[r][1] = middle row, reels[r][2] = bottom row.
   */
  reels: SymbolId[][];
  /** All winning paylines. Empty array on a loss. */
  winningLines: WinningLine[];
  /** Total win across all lines + scatter (bigint, atomic units). 0n on loss. */
  winAmount: bigint;
  /** Free spins awarded (always 0 in 6.0 MVP). */
  freeSpinsAwarded: number;
  /** Whether this spin is itself a free spin (always false in 6.0 MVP). */
  isFreeSpin: boolean;
  /**
   * Monotonically incrementing cursor for the HMAC derivation chain.
   * In mock: simple counter starting from 0.
   * In real engine (6.1): byte offset into the HMAC stream.
   * Stored per-session to let the verifier replay all spins.
   */
  cursorAfter: number;
}

// ---------------------------------------------------------------------------
// Symbol definition for a paytable
// ---------------------------------------------------------------------------
export interface SymbolDef {
  /** Unique id within this paytable */
  id: SymbolId;
  /** Display name */
  name: string;
  /**
   * Unicode emoji or short text used in CSS sprite fallback.
   * Real sprite atlas references the same id.
   */
  emoji: string;
  /** CSS background color for the symbol tile */
  color: string;
  /**
   * Payout multipliers indexed by match count minus 2.
   * payouts[0] = 2-of-a-kind (left to right), payouts[1] = 3-of-a-kind, etc.
   * payouts[3] = 5-of-a-kind.
   * 0 means no payout for that count.
   */
  payouts: [number, number, number, number];
  /** Whether this symbol is a wild (substitutes any non-scatter) */
  isWild?: boolean;
  /** Whether this symbol is a scatter (pays anywhere) */
  isScatter?: boolean;
}

// ---------------------------------------------------------------------------
// Line definition — which cells make up a payline
// ---------------------------------------------------------------------------
export interface LineDef {
  /** 0-indexed payline id */
  id: number;
  /**
   * Row indices per reel — rowIndex[r] is the row (0=top,1=mid,2=bot)
   * to check for reel r.
   */
  rows: [number, number, number, number, number];
  /** Display color for this line in the win overlay */
  color: string;
}

// ---------------------------------------------------------------------------
// Full paytable definition
// ---------------------------------------------------------------------------
export interface Paytable {
  id: MachineSlug;
  symbols: SymbolDef[];
  lines: LineDef[];
  /** Reel strips — 5 arrays of symbol indices (length 30-40 each) */
  reelStrips: SymbolId[][];
  /** Theoretical RTP target (e.g. 0.96 = 96%) */
  rtp: number;
}

// ---------------------------------------------------------------------------
// Slot screen open payload — wired through the casino Zustand store
// ---------------------------------------------------------------------------
export interface OpenSlotScreenPayload {
  machineSlug: MachineSlug;
  paytableId: MachineSlug;
}
