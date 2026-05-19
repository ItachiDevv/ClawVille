/**
 * Casino Slot Types — Single Source of Truth
 *
 * This file defines the SpinResult contract shared between:
 *   - apps/api/src/services/slot-engine.ts    (Phase 6.1 — HMAC-derived RNG)
 *   - apps/web/src/lib/casino/verifier.ts     (Phase 6.1 slice 5 — browser replay)
 *   - apps/web/src/lib/casino/slot-api-client.ts (wire ↔ bigint adapter)
 *
 * Slice 5 deleted `mock-engine.ts`; the real engine ships via REST.
 * SpinResult, WinningLine, Paytable, SymbolId, MachineSlug must NOT change
 * — drift breaks the verifier's byte-identity guarantee.
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
// Machine slug — identifies which paytable to load.
// Phase 6.1.5 (Bundle B) adds 'classic-3x5-bonus' for the scatter +
// multiplier-wild + free-spin paytable.
// ---------------------------------------------------------------------------
export type MachineSlug = 'classic-3x5' | 'classic-3x5-bonus';

// ---------------------------------------------------------------------------
// Per-landed-Wild multiplier (Phase 6.1.5, Bundle B).
// Mirrors server `WildMultiplier`. Each landed WILD in the visible 5×3
// grid draws one multiplier via `sampleIntFromBytes(range=100)` in
// (reel,row) order. `multiplier` is the EFFECTIVE value emitted by the
// engine (raw table draw, doubled only when both `freeSpinMode=true`
// AND `FS_WILD_MULTIPLIER_DOUBLE=true` in the shared rules). On
// `classic-3x5` (no scatter symbol) the engine returns `[]`.
// ---------------------------------------------------------------------------
export interface WildMultiplier {
  /** 0..4 — left-to-right reel index. */
  reelIndex: number;
  /** 0..2 — top/middle/bottom row in the visible window. */
  rowIndex: number;
  /** Effective multiplier applied to lines crossing this cell. */
  multiplier: number;
}

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
  /**
   * Free spins awarded by THIS spin (Phase 6.1.5).
   *   • classic-3x5: always 0.
   *   • classic-3x5-bonus: 10 on first scatter trigger (>=3 scatters in
   *     base mode), 5 on retrigger inside free-spin mode.
   */
  freeSpinsAwarded: number;
  /** Whether this spin was executed in free-spin mode. */
  isFreeSpin: boolean;
  /**
   * Phase 6.1.5 (Bundle B) — per-landed-Wild multiplier in (reel,row)
   * order. Always `[]` on `classic-3x5` (no bonus features). On
   * `classic-3x5-bonus` the engine draws ONE multiplier per landed WILD
   * regardless of mode, but the line evaluator only multiplies line
   * wins by these in free-spin mode (per the RTP-shape decision in
   * `FREE_SPIN_RULES`).
   */
  wildMultipliers: WildMultiplier[];
  /**
   * Phase 6.1.5 (Bundle B) — scatter pay-anywhere payout (atomic units).
   * `0n` when fewer than 3 scatters land. Scatter pay is NOT doubled in
   * free-spin mode (industry standard; FS scalar applies to line wins +
   * wild multipliers only).
   */
  scatterPayout: bigint;
  /**
   * Monotonically incrementing cursor for the HMAC derivation chain.
   * In mock: simple counter starting from 0.
   * In real engine (6.1): byte offset into the HMAC stream.
   * Stored per-session to let the verifier replay all spins.
   *
   * Bonus paytable cursor delta = 20 bytes (5 reel samples × 4) +
   * 4 bytes × wildCount (one multiplier draw per landed WILD), plus
   * any rejection-sampling overhead emitted by `sampleIntFromBytes`.
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
