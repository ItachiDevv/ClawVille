/**
 * Phase 6.1 — Slot Engine (slice 2)
 *
 * Pure, deterministic spin evaluator built on top of `provable-rng.ts`
 * (slice 1, commit 37041b8). Same `(serverSeed, clientSeed, nonce,
 * cursor, bet)` ⇒ byte-identical `SpinResult`. No I/O, no time, no
 * global state. The verifier in `apps/web/src/lib/casino/verifier.ts`
 * (slice 3) MUST be able to replay every spin by importing this same
 * module, or by reimplementing the algorithm with identical results.
 *
 * --- Design choices (full rationale in the slice-2 ship report) ---
 *
 * 1) No pokie dependency. The whole engine is ~250 LOC of straight
 *    TypeScript; pokie's `VideoSlotSession` would force a wrapper that
 *    (a) translates its plain-`number` win amounts to our bigint
 *    contract, (b) shoehorns our `sampleIntFromBytes` cursor model
 *    into its `RandomNumberGenerator` interface, and (c) adds a new
 *    external dep to audit for the provably-fair audit trail. A
 *    direct implementation is easier to read, lock down, and unit
 *    test — the value of the "wraps pokie" hint in the plan was the
 *    *math conventions* (LTR matching, wild-as-leader, payouts indexed
 *    by matchLen-2), not the package itself.
 *
 * 2) Bet shape: `bet: bigint` = total stake per spin. Internally split
 *    across `lines.length` paylines as `perLineBet = bet / lineCount`.
 *    Bet MUST be a positive bigint divisible by `lineCount` (20 for
 *    classic-3x5) — caller's UI is responsible for clamping bet
 *    increments to a multiple of 20. Refusing odd bets up-front beats
 *    truncating value silently.
 *
 * 3) Reel sampling: 5 independent `sampleIntFromBytes` calls in
 *    `[0, stripLen)`, each advancing the cursor by `bytesConsumed`
 *    (typically 4 bytes, more if rejection sampling fires). The
 *    sampled stop is the MIDDLE row, mirroring `mock-engine`:
 *
 *      reels[r] = [strip[(stop-1+L) % L], strip[stop], strip[(stop+1) % L]]
 *
 *    Verifier replay matches because (a) the byte stream is HMAC-
 *    deterministic and (b) `sampleIntFromBytes.bytesConsumed` is
 *    deterministic given (serverSeed, clientSeed, nonce, cursorStart,
 *    range).
 *
 * 4) Win evaluation: classic left-to-right scan, Wild substitutes the
 *    leading non-wild symbol. For each line:
 *
 *      lineSymbols = [reels[r][line.rows[r]]]  // 5 entries
 *      kind        = first non-wild in lineSymbols  (Wild itself if all wild)
 *      matchLen    = longest contiguous prefix where sym === kind || sym === WILD
 *      multiplier  = kind.payouts[matchLen - 2]    (0 if matchLen < 2)
 *      lineWin     = perLineBet * BigInt(multiplier)
 *
 *    All-wild line → kind = Wild (uses Wild's own payouts table). This
 *    matches the Stake/standard convention. We do NOT do dual-evaluation
 *    (compare "treat-leading-wilds-as-wild" vs "as-substituted") in 6.1
 *    because the paytable was tuned for the single-evaluation rule
 *    (mirrors mock-engine RTP target).
 *
 * 5) cursorAfter is the cursor AFTER the 5th reel's bytes are
 *    consumed. Win evaluation is post-RNG and does not consume bytes.
 */

import {
  CLASSIC_LINES,
  CLASSIC_REEL_STRIPS,
  CLASSIC_SYMBOLS,
} from '@clawville/shared';
import type {
  SlotLineDef,
  SlotSymbolDef,
} from '@clawville/shared';

import { sampleIntFromBytes } from './provable-rng';

// ---------------------------------------------------------------------------
// Local mirrors of the frozen casino contract types
// ---------------------------------------------------------------------------
//
// These mirror `apps/web/src/lib/casino/types.ts` byte-for-byte
// (SymbolId, MachineSlug, WinningLine, SpinResult). They are duplicated
// here — not imported — because the apps/api tsconfig has
// `rootDir: ./src` which forbids cross-package source imports. The
// canonical source of truth remains the web types file; if a future
// refactor moves these into `@clawville/shared`, delete these locals
// and switch back to a single import.
//
// TypeScript is structural — values returned by `runSpin` are
// assignable to the web `SpinResult` interface as long as field names
// and shapes match. The CI typecheck on the web side will fail
// loudly if these drift.

export type SymbolId = number;
export type MachineSlug = 'classic-3x5';

export interface WinningLine {
  lineIndex: number;
  symbols: SymbolId[];
  winAmount: bigint;
  multiplier: number;
}

export interface SpinResult {
  reels: SymbolId[][];
  winningLines: WinningLine[];
  winAmount: bigint;
  freeSpinsAwarded: number;
  isFreeSpin: boolean;
  cursorAfter: number;
}

// ---------------------------------------------------------------------------
// Paytable lookup
// ---------------------------------------------------------------------------

/**
 * Bundle of static constants needed to run a spin for a given machine.
 * Keeping the lookup table inside this module means callers identify a
 * paytable by `MachineSlug` and never pass raw arrays — that prevents
 * accidental drift between the symbol table the engine uses and the
 * one the verifier uses.
 */
interface PaytableBundle {
  readonly id: MachineSlug;
  readonly symbols: readonly SlotSymbolDef[];
  readonly lines: readonly SlotLineDef[];
  readonly reelStrips: readonly (readonly SymbolId[])[];
  readonly wildId: SymbolId;
}

const PAYTABLE_BUNDLES: Readonly<Record<MachineSlug, PaytableBundle>> = {
  'classic-3x5': buildBundle('classic-3x5', CLASSIC_SYMBOLS, CLASSIC_LINES, CLASSIC_REEL_STRIPS),
};

/**
 * Construct a `PaytableBundle` from raw shared constants, running
 * structural invariants up-front so that win-evaluation code can lean
 * on positional indexing without runtime branches.
 *
 * @internal Exported only so the unit-test suite can verify the
 *           invariant guards by handing in deliberately-malformed
 *           synthetic paytables. Production code should always go
 *           through `getPaytableBundle(MachineSlug)`.
 */
export function buildBundle(
  id: MachineSlug,
  symbols: readonly SlotSymbolDef[],
  lines: readonly SlotLineDef[],
  reelStrips: readonly (readonly SymbolId[])[],
): PaytableBundle {
  const wild = symbols.find((s) => s.isWild);
  if (!wild) {
    throw new Error(`slot-engine: paytable '${id}' has no wild symbol`);
  }
  if (reelStrips.length !== 5) {
    throw new Error(`slot-engine: paytable '${id}' must have exactly 5 reel strips`);
  }
  for (let r = 0; r < reelStrips.length; r++) {
    if (reelStrips[r]!.length === 0) {
      throw new Error(`slot-engine: paytable '${id}' reel ${r} is empty`);
    }
  }
  // Adversarial guard: win evaluation reads `bundle.symbols[kindId]`
  // assuming `symbols[i].id === i`. If a future paytable rev ships
  // symbols out-of-order, the wrong row would be picked OR the lookup
  // would return undefined and the line would silently no-pay —
  // player gets short-changed and the verifier replay agrees because
  // it has the same bug. Refuse to build the bundle instead.
  if (!symbols.every((s, i) => s.id === i)) {
    throw new Error(
      `slot-engine: paytable '${id}' has symbols[i].id !== i — ` +
      `engine assumes positional indexing. Fix the paytable constant or refactor lookup.`,
    );
  }
  // Adversarial guard: line.rows[r] is indexed directly into the 3-row
  // window. A typo'd paytable (e.g. rows = [3, 1, 1, 1, 1]) would
  // silently no-pay because `reels[r][3]` is undefined and the
  // optional-chain returns nothing.
  for (const line of lines) {
    if (!line.rows.every((r) => Number.isInteger(r) && r >= 0 && r <= 2)) {
      throw new Error(
        `slot-engine: paytable '${id}' line id=${line.id} has rows ${JSON.stringify(line.rows)} — ` +
        `every row index must be 0, 1, or 2 (top/mid/bot).`,
      );
    }
  }
  // Adversarial guard: payouts is indexed `payouts[matchLen - 2]` for
  // matchLen ∈ [2,5]. A future symbol with a shorter payouts array
  // would silently no-pay the missing tier via `?? 0`.
  for (const s of symbols) {
    if (s.payouts.length !== 4) {
      throw new Error(
        `slot-engine: paytable '${id}' symbol id=${s.id} has payouts.length=${s.payouts.length} — ` +
        `must be exactly 4 entries [2-of-kind .. 5-of-kind].`,
      );
    }
  }
  return { id, symbols, lines, reelStrips, wildId: wild.id };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Arguments to `runSpin`. */
export interface RunSpinArgs {
  /** Machine identifier. Only 'classic-3x5' in Phase 6.1 MVP. */
  paytableId: MachineSlug;
  /** 64-char lowercase hex server seed (held secret until session close). */
  serverSeed: string;
  /** Non-empty hex client seed (player-provided). */
  clientSeed: string;
  /** Monotonically increasing per-spin nonce within a session. */
  nonce: number;
  /** Byte offset into the HMAC stream where this spin starts. */
  cursor: number;
  /**
   * Total stake for this spin in atomic units (e.g. ClawTokens or
   * lamports). MUST be > 0n and divisible by the paytable's line
   * count. For classic-3x5 (20 lines): 20n, 40n, 60n, ... 2000n etc.
   */
  bet: bigint;
}

/**
 * Run a single deterministic spin.
 *
 * Pure. No I/O, no time, no global state. Same inputs ⇒ byte-identical
 * `SpinResult`. Throws on invalid inputs (bad paytable id, non-positive
 * bet, bet not divisible by line count, malformed seeds — the last is
 * raised inside `provable-rng`).
 */
export function runSpin(args: RunSpinArgs): SpinResult {
  const bundle = PAYTABLE_BUNDLES[args.paytableId];
  if (!bundle) {
    throw new Error(`slot-engine: unknown paytableId '${args.paytableId}'`);
  }
  if (typeof args.bet !== 'bigint') {
    throw new Error(`slot-engine: bet must be a bigint, got ${typeof args.bet}`);
  }
  if (args.bet <= 0n) {
    throw new Error(`slot-engine: bet must be > 0, got ${args.bet}`);
  }
  const lineCount = BigInt(bundle.lines.length);
  if (args.bet % lineCount !== 0n) {
    throw new Error(
      `slot-engine: bet (${args.bet}) must be divisible by lineCount (${lineCount}) for paytable '${bundle.id}'`,
    );
  }
  if (!Number.isInteger(args.cursor) || args.cursor < 0) {
    throw new Error(`slot-engine: cursor must be a non-negative integer, got ${args.cursor}`);
  }
  // Note: we deliberately do NOT cap `cursor` at `MAX_SAFE_INTEGER - 32`
  // here — `provable-rng.deriveBytes` already enforces
  // `cursor > MAX_SAFE_INTEGER - byteCount` and throws with a usable
  // error message. Duplicating the guard would just add a second
  // failure mode for the same overflow class. The RNG layer is the
  // single source of truth for cursor-overflow rejection.

  // ---- Reel sampling (consumes bytes from the HMAC stream) ----
  const reels: SymbolId[][] = new Array<SymbolId[]>(5);
  let cursor = args.cursor;
  for (let r = 0; r < 5; r++) {
    const strip = bundle.reelStrips[r]!;
    const stripLen = strip.length;
    const { value: stop, bytesConsumed } = sampleIntFromBytes({
      serverSeed: args.serverSeed,
      clientSeed: args.clientSeed,
      nonce: args.nonce,
      cursorStart: cursor,
      min: 0,
      max: stripLen,
    });
    cursor += bytesConsumed;
    // Build the 3-row visible window: top = stop-1, middle = stop, bottom = stop+1.
    // Index with modulo so reel strips wrap cleanly at the boundary.
    const top = strip[(stop - 1 + stripLen) % stripLen]!;
    const middle = strip[stop]!;
    const bottom = strip[(stop + 1) % stripLen]!;
    reels[r] = [top, middle, bottom];
  }

  // ---- Win evaluation (pure math on the visible window) ----
  const { winningLines, winAmount } = evaluateReels(reels, bundle.id, args.bet);

  return {
    reels,
    winningLines,
    winAmount,
    freeSpinsAwarded: 0,
    isFreeSpin: false,
    cursorAfter: cursor,
  };
}

/**
 * Evaluate a pre-sampled 5×3 reel grid against the named paytable.
 *
 * Exposed separately for (a) the frontend verifier, which receives
 * reels over the wire and re-checks the math without re-running RNG,
 * and (b) unit tests that synthesize specific reel grids to cover the
 * wild-substitution / payline edge cases.
 *
 * Same `bet` rules as `runSpin` (positive bigint, divisible by line
 * count).
 */
export function evaluateReels(
  reels: readonly (readonly SymbolId[])[],
  paytableId: MachineSlug,
  bet: bigint,
): { winningLines: WinningLine[]; winAmount: bigint } {
  const bundle = PAYTABLE_BUNDLES[paytableId];
  if (!bundle) {
    throw new Error(`slot-engine: unknown paytableId '${paytableId}'`);
  }
  if (typeof bet !== 'bigint') {
    throw new Error(`slot-engine: bet must be a bigint, got ${typeof bet}`);
  }
  if (bet <= 0n) {
    throw new Error(`slot-engine: bet must be > 0, got ${bet}`);
  }
  const lineCount = BigInt(bundle.lines.length);
  if (bet % lineCount !== 0n) {
    throw new Error(
      `slot-engine: bet (${bet}) must be divisible by lineCount (${lineCount}) for paytable '${bundle.id}'`,
    );
  }
  if (reels.length !== 5) {
    throw new Error(`slot-engine: reels must have 5 entries, got ${reels.length}`);
  }
  for (let r = 0; r < 5; r++) {
    const reel = reels[r]!;
    if (reel.length !== 3) {
      throw new Error(`slot-engine: reels[${r}] must have 3 rows, got ${reel.length}`);
    }
    // Adversarial guard: the slice-3 verifier accepts caller-supplied
    // reels over the wire. Reject symbol ids outside the bundle's
    // symbol table so the downstream `bundle.symbols[kindId]` lookup
    // can never index undefined.
    for (let c = 0; c < 3; c++) {
      const sym = reel[c];
      if (!Number.isInteger(sym) || (sym as number) < 0 || (sym as number) >= bundle.symbols.length) {
        throw new Error(
          `slot-engine: reels[${r}][${c}]=${sym} out of range [0, ${bundle.symbols.length})`,
        );
      }
    }
  }

  const perLineBet = bet / lineCount;
  const winningLines: WinningLine[] = [];
  let totalWin = 0n;

  for (const line of bundle.lines) {
    const lineSymbols = new Array<SymbolId>(5);
    for (let r = 0; r < 5; r++) {
      lineSymbols[r] = reels[r]![line.rows[r]]!;
    }

    // Determine the "kind" the line is matching:
    //   - first non-wild symbol on the line, OR
    //   - WILD itself if every symbol is wild (then we use Wild's own
    //     payouts row, which is intentionally lower than top symbols).
    let kindId: SymbolId | undefined;
    for (let r = 0; r < 5; r++) {
      if (lineSymbols[r] !== bundle.wildId) {
        kindId = lineSymbols[r];
        break;
      }
    }
    if (kindId === undefined) {
      kindId = bundle.wildId;
    }

    // Count the longest contiguous prefix where each symbol is either
    // the kind OR a wild substituting for the kind.
    let matchLen = 0;
    for (let r = 0; r < 5; r++) {
      const sym = lineSymbols[r]!;
      if (sym === kindId || sym === bundle.wildId) {
        matchLen++;
      } else {
        break;
      }
    }
    if (matchLen < 2) continue;

    const symDef = bundle.symbols[kindId!];
    if (!symDef) continue;
    const multiplier = symDef.payouts[matchLen - 2] ?? 0;
    if (multiplier <= 0) continue;

    const lineWin = perLineBet * BigInt(multiplier);
    winningLines.push({
      lineIndex: line.id,
      symbols: lineSymbols,
      winAmount: lineWin,
      multiplier,
    });
    totalWin += lineWin;
  }

  return { winningLines, winAmount: totalWin };
}

// ---------------------------------------------------------------------------
// Test helpers (exported for the verifier slice + unit tests; not in the
// public API surface but cheap to expose since paytables are public).
// ---------------------------------------------------------------------------

/**
 * Return the (frozen) paytable bundle for a given machine slug.
 * Intended for tests + the verifier; do NOT use to mutate paytable
 * constants (the bundle holds references to the shared constants).
 */
export function getPaytableBundle(paytableId: MachineSlug): PaytableBundle {
  const bundle = PAYTABLE_BUNDLES[paytableId];
  if (!bundle) {
    throw new Error(`slot-engine: unknown paytableId '${paytableId}'`);
  }
  return bundle;
}
