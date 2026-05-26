/**
 * Phase 6.1 — slice 3 wire types.
 *
 * The slot engine returns `SpinResult` with bigint fields (`winAmount`,
 * `winningLines[i].winAmount`). Bigints don't survive `JSON.stringify`
 * — Hono's `c.json` throws. We define a "serialized" mirror here that
 * stringifies every bigint, plus the helper that converts.
 *
 * Both server routes (apps/api) and the future frontend slice (apps/web)
 * import these types so the wire contract is one source-of-truth. The
 * monkey-patch `BigInt.prototype.toJSON` route was rejected because it's
 * a global side-effect that breaks other code (event-logger sanitization,
 * tests, third-party deps).
 */

import type {
  SpinResult,
  WinningLine,
  WildMultiplier,
  SymbolId,
  MachineSlug,
} from '../services/slot-engine';

export type SerializedWinningLine = {
  lineIndex: number;
  symbols: SymbolId[];
  winAmount: string;
  multiplier: number;
};

/**
 * Phase 6.1.5 — serialized mirror of `WildMultiplier`. No bigint fields,
 * so structurally identical to the engine type; defined explicitly here
 * so the web type-graph doesn't have to reach across to apps/api.
 */
export type SerializedWildMultiplier = {
  reelIndex: number;
  rowIndex: number;
  multiplier: number;
};

export interface SerializedSpinResult {
  reels: SymbolId[][];
  winningLines: SerializedWinningLine[];
  winAmount: string;
  freeSpinsAwarded: number;
  isFreeSpin: boolean;
  /** Phase 6.1.5 — per-landed-Wild multiplier (empty array on `classic-3x5`). */
  wildMultipliers: SerializedWildMultiplier[];
  /** Phase 6.1.5 — total scatter pay × total predict, stringified bigint. '0' on `classic-3x5`. */
  scatterPayout: string;
  cursorAfter: number;
}

export function serializeSpinResult(result: SpinResult): SerializedSpinResult {
  return {
    reels: result.reels,
    winningLines: result.winningLines.map(serializeWinningLine),
    winAmount: result.winAmount.toString(),
    freeSpinsAwarded: result.freeSpinsAwarded,
    isFreeSpin: result.isFreeSpin,
    wildMultipliers: result.wildMultipliers.map(serializeWildMultiplier),
    scatterPayout: result.scatterPayout.toString(),
    cursorAfter: result.cursorAfter,
  };
}

export function serializeWildMultiplier(wm: WildMultiplier): SerializedWildMultiplier {
  return {
    reelIndex: wm.reelIndex,
    rowIndex: wm.rowIndex,
    multiplier: wm.multiplier,
  };
}

export function serializeWinningLine(line: WinningLine): SerializedWinningLine {
  return {
    lineIndex: line.lineIndex,
    symbols: line.symbols,
    winAmount: line.winAmount.toString(),
    multiplier: line.multiplier,
  };
}

export interface OpenSessionResponse {
  sessionId: string;
  paytableId: MachineSlug;
  currency: 'clawtokens';
  serverSeedHash: string;
  clientSeed: string;
  /** Informational snapshot of the user's chosen per-spin bet at open time. */
  startingBalance: string;
  /**
   * Reserved for Phase 6.2 SOL/USDC buy-in model. On the ClawTokens path
   * this is always '0' — no reservation, no refund. Each spin direct-debits
   * + credits independently via /spin.
   */
  escrowAmount: string;
  bet: string;
  createdAt: string;
}

export interface SpinResponse extends SerializedSpinResult {
  spinId: string;
  bet: string;
  /** Authoritative balance after this spin (avatar ClawTokens). */
  balance: number;
  /** Remaining escrow (Phase 6.2 SOL/USDC only; always '0' on ClawTokens path). */
  escrowRemaining: string;
  /** Session-level cumulative stake + win after this spin (stringified bigints). */
  totalStaked: string;
  totalWon: string;
  spinCount: number;
  /**
   * Phase 6.1.5 — session-level bonus mode AFTER this spin.
   *   • 'base'      — predict-debiting spins.
   *   • 'free-spin' — predict-free spins, frontend should display banner.
   */
  mode: 'base' | 'free-spin';
  /** Phase 6.1.5 — unspent free-spin balance AFTER this spin. */
  freeSpinsRemaining: number;
  idempotencyReplay: boolean;
}

export interface CloseSessionResponse {
  sessionId: string;
  status: 'closed';
  /** REVEALED — only present in the close response. */
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  totalStaked: string;
  totalWon: string;
  spinCount: number;
  /** Final ClawToken balance — equals live avatar balance; ClawTokens path has no refund. */
  finalBalance: number;
  closedAt: string;
}

export interface PaytableResponse {
  paytableId: MachineSlug;
  symbols: ReadonlyArray<{
    id: number;
    name: string;
    emoji: string;
    color: string;
    payouts: readonly [number, number, number, number];
    isWild?: boolean;
  }>;
  lines: ReadonlyArray<{
    id: number;
    rows: readonly [number, number, number, number, number];
    color: string;
  }>;
  reelStrips: ReadonlyArray<ReadonlyArray<number>>;
  rtp: number;
}
