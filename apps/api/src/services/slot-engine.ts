/**
 * Phase 6.1 — Slot Engine (slice 2; bonus mechanics added in slice 6.1.5).
 *
 * Pure, deterministic spin evaluator built on top of `provable-rng.ts`
 * (slice 1, commit 37041b8). Same `(serverSeed, clientSeed, nonce,
 * cursor, predict, freeSpinMode)` ⇒ byte-identical `SpinResult`. No I/O,
 * no time, no global state. The verifier in `apps/web/src/lib/cove/
 * verifier.ts` MUST be able to replay every spin by importing this same
 * module, or by reimplementing the algorithm with identical results.
 *
 * --- Design choices (full rationale in the slice-2 + 6.1.5 ship reports) ---
 *
 * 1) No pokie dependency. The whole engine is ~400 LOC of straight
 *    TypeScript; pokie's `VideoSlotSession` would force a wrapper that
 *    (a) translates its plain-`number` win amounts to our bigint
 *    contract, (b) shoehorns our `sampleIntFromBytes` cursor model
 *    into its `RandomNumberGenerator` interface, and (c) adds a new
 *    external dep to audit for the provably-fair audit trail.
 *
 * 2) Predict shape: `predict: bigint` = total stake per spin. Internally
 *    split across `lines.length` paylines as
 *    `perLinePredict = predict / lineCount`. Predict MUST be a positive
 *    bigint divisible by `lineCount` (20 for classic-3x5) — caller's UI
 *    is responsible for clamping predict increments to a multiple of 20.
 *    Refusing odd predicts up-front beats truncating value silently.
 *
 * 3) Reel sampling: 5 independent `sampleIntFromBytes` calls in
 *    `[0, stripLen)`, each advancing the cursor by `bytesConsumed`. The
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
 *    leading non-wild, non-scatter symbol. For each line:
 *
 *      lineSymbols = [reels[r][line.rows[r]]]  // 5 entries
 *      kind        = first non-wild, non-scatter   (Wild if all wild)
 *      matchLen    = longest contiguous prefix where sym === kind || sym === WILD
 *      multiplier  = kind.payouts[matchLen - 2]    (0 if matchLen < 2)
 *      lineWin     = perLinePredict * BigInt(multiplier)
 *
 *    All-wild line → kind = Wild (uses Wild's own payouts table). This
 *    matches the Stake/standard convention. Scatter cells BREAK the run
 *    (their payouts are all-zero anyway, but explicit "kind cannot be
 *    scatter" keeps intent obvious and prevents future-paytable footguns).
 *
 * 5) cursorAfter is the cursor AFTER ALL byte-consuming draws (5 reel
 *    samples + N wild-multiplier draws on the bonus paytable). Win
 *    evaluation is post-RNG and does not consume bytes.
 *
 * 6) Bonus paytable (`classic-3x5-bonus`, Phase 6.1.5) adds three
 *    bolt-on passes:
 *      a) Wild-multiplier draw — for each landed WILD (id 7) in the
 *         visible window, one extra `sampleIntFromBytes(range=100)` call
 *         picks a 2×/3×/5× tier from `WILD_MULTIPLIER_TABLE`. In FS mode
 *         the multiplier value is DOUBLED (2→4, 3→6, 5→10).
 *      b) Scatter pay-anywhere — if scatter count ≥ 3, pay
 *         `args.predict × SCATTER_PAY_TABLE[count]` and award free spins.
 *         Scatter pay is NOT doubled in FS — industry convention.
 *      c) Line-evaluation pass picks up wild multipliers crossing the
 *         matchLen prefix (multiplying them together) and applies the
 *         FS line-win scalar (`FREE_SPIN_RULES.FS_LINE_WIN_MULTIPLIER`).
 *
 *    On `classic-3x5` all three bonus passes are no-ops:
 *      • bundle.scatterId === null → no wild-multiplier draws, no scatter
 *      • wildMultipliers === [] → no line-multiplier amplification
 *      • freeSpinMode === false → no FS scalar applied
 *    So classic-3x5 byte-stream + cursor + line math are IDENTICAL to the
 *    pre-6.1.5 implementation.
 */

import {
  BONUS_REEL_STRIPS,
  BONUS_SYMBOLS,
  CLASSIC_LINES,
  CLASSIC_REEL_STRIPS,
  CLASSIC_SYMBOLS,
  FREE_SPIN_RULES,
  SCATTER_PAY_TABLE,
  WILD_MULTIPLIER_TABLE,
} from '@clawville/shared';
import type {
  SlotLineDef,
  SlotSymbolDef,
} from '@clawville/shared';

import { sampleIntFromBytes } from './provable-rng';

// ---------------------------------------------------------------------------
// Local mirrors of the frozen cove contract types
// ---------------------------------------------------------------------------
//
// These mirror `apps/web/src/lib/cove/types.ts` byte-for-byte
// (SymbolId, MachineSlug, WinningLine, SpinResult). They are duplicated
// here — not imported — because the apps/api tsconfig has
// `rootDir: ./src` which forbids cross-package source imports. The
// canonical source of truth remains the web types file; if a future
// refactor moves these into `@clawville/shared`, delete these locals
// and switch back to a single import.

export type SymbolId = number;
export type MachineSlug = 'classic-3x5' | 'classic-3x5-bonus';

export interface WinningLine {
  lineIndex: number;
  symbols: SymbolId[];
  winAmount: bigint;
  multiplier: number;
}

/**
 * Phase 6.1.5 — Bundle B multiplier wild. Each landed WILD (id 7) in
 * the visible 5×3 grid gets ONE multiplier draw, recorded here so the
 * frontend can pin a glowing chip on the right cell and so the verifier
 * can replay the exact line math byte-identically.
 */
export interface WildMultiplier {
  /** 0..4 — left-to-right reel index. */
  reelIndex: number;
  /** 0..2 — top/middle/bottom row in the visible window. */
  rowIndex: number;
  /**
   * Effective multiplier applied to any winning line that crosses this
   * cell. In free-spin mode this is already doubled (per
   * `FREE_SPIN_RULES.FS_WILD_MULTIPLIER_DOUBLE`) — the engine returns the
   * final number, NOT the raw table draw, so the UI shows what the
   * player actually got.
   */
  multiplier: number;
}

export interface SpinResult {
  reels: SymbolId[][];
  /**
   * Bundle B: in FREE-SPIN mode, line wins include the product of any
   * wild multipliers that crossed the matchLen prefix, then
   * ×FS_LINE_WIN_MULTIPLIER (currently 1). In BASE mode, wild
   * multipliers are still emitted in `wildMultipliers[]` for the UI
   * chip but do NOT amplify line wins — RTP-shape lock from team-lead
   * decision 2026-05-19. Pre-bundle paytables (classic-3x5) are
   * unaffected because no `WILD_MULTIPLIER_TABLE` draws occur for them
   * — `wildMultipliers` is always `[]` and the per-line `multiplier`
   * field is the raw `payouts[matchLen-2]` as before.
   */
  winningLines: WinningLine[];
  winAmount: bigint;
  /** Bundle B — number of free spins awarded by THIS spin (0 if no trigger). */
  freeSpinsAwarded: number;
  /** True iff this spin was executed in free-spin mode (no predict debit). */
  isFreeSpin: boolean;
  /** Bundle B — per-landed-Wild multiplier (empty array if no wilds in window). */
  wildMultipliers: WildMultiplier[];
  /** Bundle B — total scatter payout (× total predict) for THIS spin, 0n if scatter count < 3. */
  scatterPayout: bigint;
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
  /**
   * Bundle B — id of the scatter symbol, or `null` if the paytable has
   * no scatter (e.g. `classic-3x5`). Engine uses this to decide whether
   * to run the wild-multiplier draws, scatter pay-anywhere evaluation,
   * and free-spin trigger logic. Set ONCE in `buildBundle` from the
   * symbol-table `isScatter` flag — no runtime mutation.
   */
  readonly scatterId: SymbolId | null;
}

const PAYTABLE_BUNDLES: Readonly<Record<MachineSlug, PaytableBundle>> = {
  'classic-3x5': buildBundle('classic-3x5', CLASSIC_SYMBOLS, CLASSIC_LINES, CLASSIC_REEL_STRIPS),
  'classic-3x5-bonus': buildBundle(
    'classic-3x5-bonus',
    BONUS_SYMBOLS,
    CLASSIC_LINES,
    BONUS_REEL_STRIPS,
  ),
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
  // Bundle B — discover at-most-one scatter symbol. Engine treats
  // scatter pays anywhere (no line) and excludes it from wild
  // substitution. A paytable with no scatter (e.g. classic-3x5) sets
  // scatterId=null so the bonus-only code paths are no-ops.
  const scatters = symbols.filter((s) => s.isScatter);
  if (scatters.length > 1) {
    throw new Error(
      `slot-engine: paytable '${id}' has ${scatters.length} scatter symbols — at most one is supported.`,
    );
  }
  const scatterId: SymbolId | null = scatters[0]?.id ?? null;
  // Adversarial guard: a scatter must NOT also be a wild — wild
  // substitution + pay-anywhere would double-count payouts.
  if (scatterId !== null && symbols[scatterId]?.isWild) {
    throw new Error(
      `slot-engine: paytable '${id}' scatter id=${scatterId} is also marked isWild — cannot be both.`,
    );
  }
  return { id, symbols, lines, reelStrips, wildId: wild.id, scatterId };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Arguments to `runSpin`. */
export interface RunSpinArgs {
  /** Machine identifier. Phase 6.1.5 adds `'classic-3x5-bonus'`. */
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
   *
   * In free-spin mode (`freeSpinMode=true`) the engine treats this as
   * the predict that line wins + scatter pays are scaled against, BUT
   * the caller (`/spin` route) does NOT debit the player. The value
   * MUST still be the session's per-spin predict so payout math matches
   * what would have been won outside the bonus.
   */
  predict: bigint;
  /**
   * Phase 6.1.5 — when true, this is a FREE spin:
   *   • caller skips the predict debit (route concern, not engine);
   *   • wild multipliers APPLY to line wins crossing them (in BASE mode
   *     they are recorded for the UI but do NOT amplify line wins —
   *     this is the RTP-shape lock from team-lead decision 2026-05-19);
   *   • the FS line-win scalar is `FREE_SPIN_RULES.FS_LINE_WIN_MULTIPLIER`
   *     (currently 1 — no outer doubling; flag is preserved so a future
   *     retune can re-enable it);
   *   • wild multiplier emit values are NOT doubled (FS_WILD_MULTIPLIER_DOUBLE
   *     is false; the flag is preserved for the same reason);
   *   • scatter pays still award their base 2×/10×/50× — they do NOT
   *     double in FS mode (slot industry convention);
   *   • a scatter retrigger awards `AWARD_RETRIGGER` (default 5) free
   *     spins, capped by `CAP_REMAINING` once added to existing budget
   *     by the route layer.
   *
   * Default false (base spin). Always false on `classic-3x5`.
   */
  freeSpinMode?: boolean;
}

/**
 * Run a single deterministic spin.
 *
 * Pure. No I/O, no time, no global state. Same inputs ⇒ byte-identical
 * `SpinResult`. Throws on invalid inputs (bad paytable id, non-positive
 * predict, predict not divisible by line count, malformed seeds — the last is
 * raised inside `provable-rng`).
 */
export function runSpin(args: RunSpinArgs): SpinResult {
  const bundle = PAYTABLE_BUNDLES[args.paytableId];
  if (!bundle) {
    throw new Error(`slot-engine: unknown paytableId '${args.paytableId}'`);
  }
  if (typeof args.predict !== 'bigint') {
    throw new Error(`slot-engine: predict must be a bigint, got ${typeof args.predict}`);
  }
  if (args.predict <= 0n) {
    throw new Error(`slot-engine: predict must be > 0, got ${args.predict}`);
  }
  const lineCount = BigInt(bundle.lines.length);
  if (args.predict % lineCount !== 0n) {
    throw new Error(
      `slot-engine: predict (${args.predict}) must be divisible by lineCount (${lineCount}) for paytable '${bundle.id}'`,
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

  const isFreeSpin = args.freeSpinMode === true;

  // ---- Reel sampling (consumes bytes from the HMAC stream) ----
  // 5 sample calls — order is reel-0..reel-4, each advancing the cursor
  // by `bytesConsumed` (4 bytes typical, more if rejection sampling
  // fires). Verifier replays the same draws by re-running sampleIntFromBytes
  // with the same (serverSeed, clientSeed, nonce, cursorStart, range).
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

  // ---- Bundle B: multiplier draws for each landed WILD ---------------------
  // Walk the visible window in (reel, row) order — left-to-right, top-
  // to-bottom — so the byte stream order is fully deterministic. Each
  // landed wild consumes ONE more sampleIntFromBytes(range=100) call.
  // Verifier replays the same draws.
  //
  // On non-bonus paytables (`scatterId === null` → classic-3x5) we skip
  // this pass entirely: no wild-multiplier draws, byte stream is
  // IDENTICAL to the pre-6.1.5 engine for classic-3x5. The `isBonusPaytable`
  // guard is the single switch that keeps the classic byte-stream
  // contract intact.
  const wildMultipliers: WildMultiplier[] = [];
  const isBonusPaytable = bundle.scatterId !== null;
  if (isBonusPaytable) {
    for (let r = 0; r < 5; r++) {
      for (let row = 0; row < 3; row++) {
        if (reels[r]![row] !== bundle.wildId) continue;
        const { value: draw, bytesConsumed } = sampleIntFromBytes({
          serverSeed: args.serverSeed,
          clientSeed: args.clientSeed,
          nonce: args.nonce,
          cursorStart: cursor,
          min: 0,
          max: 100,
        });
        cursor += bytesConsumed;
        const baseMultiplier = wildMultiplierForDraw(draw);
        // In FS mode emit the DOUBLED value so the UI chip + line math
        // both see the same final number. The `wildMultipliers` array
        // is the source of truth for the line-evaluation pass below.
        const effectiveMultiplier = isFreeSpin && FREE_SPIN_RULES.FS_WILD_MULTIPLIER_DOUBLE
          ? baseMultiplier * 2
          : baseMultiplier;
        wildMultipliers.push({
          reelIndex: r,
          rowIndex: row,
          multiplier: effectiveMultiplier,
        });
      }
    }
  }

  // ---- Win evaluation (pure math on the visible window) -------------------
  // Bundle B RTP-shape lock (team-lead decision 2026-05-19): wild
  // multipliers APPLY ONLY in free-spin mode. In base mode the wilds
  // still substitute (slice-2 behaviour) and the multipliers are
  // RECORDED + emitted in `wildMultipliers[]` (UI shows them as
  // "potential" chips on the cell), but they do NOT amplify base-mode
  // line wins. This is the industry-standard "wild multipliers are a
  // free-spins feature" pattern (Starburst/Sweet Bonanza style).
  //
  // The byte stream is the same in both modes (wild-multiplier draws
  // happen regardless) so the verifier's replay equivalence is
  // preserved. RTP empirically lands at ~97.5% combined with this
  // gating; applying multipliers in base too pushes combined past
  // ~110% (verified 2026-05-19 MC).
  //
  // FS line-win scalar (`FS_LINE_WIN_MULTIPLIER`) is also gated to FS
  // mode. On classic-3x5 both effects collapse to no-ops because there
  // are no wild draws and `isFreeSpin` is always false — line math
  // reproduces slice-2 behaviour byte-for-byte.
  const { winningLines, winAmount: lineWinTotal } = evaluateReels(
    reels,
    bundle.id,
    args.predict,
    isFreeSpin
      ? {
          wildMultipliers,
          freeSpinLineMultiplier: FREE_SPIN_RULES.FS_LINE_WIN_MULTIPLIER,
        }
      : {},
  );

  // ---- Scatter pay (anywhere on the grid) ---------------------------------
  let scatterPayout = 0n;
  let freeSpinsAwarded = 0;
  if (bundle.scatterId !== null) {
    let scatterCount = 0;
    for (let r = 0; r < 5; r++) {
      for (let row = 0; row < 3; row++) {
        if (reels[r]![row] === bundle.scatterId) scatterCount++;
      }
    }
    if (scatterCount >= FREE_SPIN_RULES.TRIGGER_THRESHOLD) {
      // Pay multiplier on TOTAL PREDICT (args.predict), not perLinePredict.
      // Clamp to table length to avoid OOB on a future 6-of-kind misprint.
      const tier = SCATTER_PAY_TABLE[Math.min(scatterCount, SCATTER_PAY_TABLE.length - 1)] ?? 0;
      scatterPayout = args.predict * BigInt(tier);
      // Free-spin award. Base trigger: 10. Retrigger (already inside FS):
      // +5. Caller (route) is responsible for clamping the SESSION-level
      // `free_spins_remaining` to CAP_REMAINING — the engine just emits
      // the per-spin award.
      freeSpinsAwarded = isFreeSpin
        ? FREE_SPIN_RULES.AWARD_RETRIGGER
        : FREE_SPIN_RULES.AWARD_BASE;
    }
  }

  const winAmount = lineWinTotal + scatterPayout;

  return {
    reels,
    winningLines,
    winAmount,
    freeSpinsAwarded,
    isFreeSpin,
    wildMultipliers,
    scatterPayout,
    cursorAfter: cursor,
  };
}

/**
 * Map a sampleIntFromBytes(range=100) draw into a wild multiplier tier.
 * Buckets are CUMULATIVE — first tier whose `cum` exceeds the draw wins.
 * Exported for the verifier (must replay the same mapping).
 */
export function wildMultiplierForDraw(draw: number): number {
  if (!Number.isInteger(draw) || draw < 0 || draw >= 100) {
    throw new Error(
      `slot-engine: wildMultiplierForDraw expects 0 <= draw < 100, got ${draw}`,
    );
  }
  for (const tier of WILD_MULTIPLIER_TABLE) {
    if (draw < tier.cum) return tier.multiplier;
  }
  // Unreachable if WILD_MULTIPLIER_TABLE last entry has cum=100. Defensive:
  // a misconfigured table that doesn't cover [0,100) is a fatal bug.
  throw new Error(
    `slot-engine: WILD_MULTIPLIER_TABLE does not cover draw=${draw} — fix the table`,
  );
}

/**
 * Phase 6.1.5 Bundle B — optional options passed to `evaluateReels` so
 * the bonus paytable can apply multiplier wilds + free-spin doubling
 * WITHOUT changing the verifier's existing call site.
 *
 * Both fields default safely:
 *   • `wildMultipliers: []` — line wins use raw payouts (slice-2 behaviour).
 *   • `freeSpinLineMultiplier: 1` — line wins not scaled (slice-2 behaviour).
 *
 * That means existing callers (`evaluateReels(reels, id, predict)`) keep
 * the exact slice-2 contract; only the bonus path passes the bag.
 */
export interface EvaluateReelsOptions {
  /**
   * Per-cell wild multipliers (output of the runSpin wild-detection
   * pass). Engine multiplies a line's payout by the PRODUCT of any
   * wild multipliers that sit on the matchLen prefix of that line.
   * Lines with no participating wild multiply by 1 (no change).
   */
  wildMultipliers?: readonly WildMultiplier[];
  /**
   * Scalar applied to every line win AFTER wild-multiplier products
   * apply. 2 in free-spin mode (Bundle B), 1 otherwise.
   */
  freeSpinLineMultiplier?: number;
}

/**
 * Evaluate a pre-sampled 5×3 reel grid against the named paytable.
 *
 * Exposed separately for (a) the frontend verifier, which receives
 * reels over the wire and re-checks the math without re-running RNG,
 * and (b) unit tests that synthesize specific reel grids to cover the
 * wild-substitution / payline edge cases.
 *
 * Same `predict` rules as `runSpin` (positive bigint, divisible by line
 * count). Scatter symbols on a payline are treated as "any non-
 * matching" — they neither extend a kind nor start one — because their
 * payouts are all zero and they pay anywhere via the separate scatter
 * pass in `runSpin`.
 */
export function evaluateReels(
  reels: readonly (readonly SymbolId[])[],
  paytableId: MachineSlug,
  predict: bigint,
  options: EvaluateReelsOptions = {},
): { winningLines: WinningLine[]; winAmount: bigint } {
  const bundle = PAYTABLE_BUNDLES[paytableId];
  if (!bundle) {
    throw new Error(`slot-engine: unknown paytableId '${paytableId}'`);
  }
  if (typeof predict !== 'bigint') {
    throw new Error(`slot-engine: predict must be a bigint, got ${typeof predict}`);
  }
  if (predict <= 0n) {
    throw new Error(`slot-engine: predict must be > 0, got ${predict}`);
  }
  const lineCount = BigInt(bundle.lines.length);
  if (predict % lineCount !== 0n) {
    throw new Error(
      `slot-engine: predict (${predict}) must be divisible by lineCount (${lineCount}) for paytable '${bundle.id}'`,
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

  // Bundle B options — wild multipliers + free-spin scalar. Defaults
  // (no multipliers, scalar=1) reproduce slice-2 line math byte-for-byte
  // when invoked without `options` (existing verifier call).
  const wildMultipliers = options.wildMultipliers ?? [];
  const freeSpinLineMultiplier = options.freeSpinLineMultiplier ?? 1;
  if (!Number.isInteger(freeSpinLineMultiplier) || freeSpinLineMultiplier < 1) {
    throw new Error(
      `slot-engine: freeSpinLineMultiplier must be a positive integer, got ${freeSpinLineMultiplier}`,
    );
  }
  // Adversarial guard: validate every passed wild multiplier sits on an
  // actual WILD cell. Mismatch could let a malicious caller inflate the
  // payout via the verifier endpoint by lying about which cells were
  // wild. (The runSpin path is honest, but evaluateReels is reachable
  // via /verify too — fail closed.)
  for (const wm of wildMultipliers) {
    if (
      !Number.isInteger(wm.reelIndex) || wm.reelIndex < 0 || wm.reelIndex >= 5 ||
      !Number.isInteger(wm.rowIndex) || wm.rowIndex < 0 || wm.rowIndex >= 3
    ) {
      throw new Error(
        `slot-engine: wildMultiplier index out of range: reel=${wm.reelIndex}, row=${wm.rowIndex}`,
      );
    }
    if (reels[wm.reelIndex]![wm.rowIndex] !== bundle.wildId) {
      throw new Error(
        `slot-engine: wildMultiplier at (${wm.reelIndex},${wm.rowIndex}) does not sit on a WILD cell`,
      );
    }
    if (!Number.isInteger(wm.multiplier) || wm.multiplier <= 0) {
      throw new Error(
        `slot-engine: wildMultiplier.multiplier must be a positive integer, got ${wm.multiplier}`,
      );
    }
  }

  // Build a fast (reel,row) → multiplier lookup for the matchLen scan.
  // Map key encodes (reel * 3 + row). Empty when wildMultipliers is empty,
  // i.e. on classic-3x5 and any non-bonus future paytable.
  const wmLookup = new Map<number, number>();
  for (const wm of wildMultipliers) {
    wmLookup.set(wm.reelIndex * 3 + wm.rowIndex, wm.multiplier);
  }

  const perLinePredict = predict / lineCount;
  const winningLines: WinningLine[] = [];
  let totalWin = 0n;

  for (const line of bundle.lines) {
    const lineSymbols = new Array<SymbolId>(5);
    for (let r = 0; r < 5; r++) {
      lineSymbols[r] = reels[r]![line.rows[r]]!;
    }

    // Determine the "kind" the line is matching:
    //   - first non-wild, non-scatter symbol on the line, OR
    //   - WILD itself if every symbol is wild (then we use Wild's own
    //     payouts row, which is intentionally lower than top symbols).
    //
    // Scatter (id=10 on bonus paytable) NEVER counts as a "kind" because
    // its `payouts` are all zero — it would no-pay anyway, but
    // explicitly skipping keeps the intent obvious. Treating scatter as
    // "non-matching" also means the line BREAKS at a scatter cell.
    let kindId: SymbolId | undefined;
    for (let r = 0; r < 5; r++) {
      const sym = lineSymbols[r]!;
      if (sym !== bundle.wildId && sym !== bundle.scatterId) {
        kindId = sym;
        break;
      }
    }
    if (kindId === undefined) {
      kindId = bundle.wildId;
    }

    // Count the longest contiguous prefix where each symbol is either
    // the kind OR a wild substituting for the kind. Scatter cells in
    // the prefix BREAK the run.
    let matchLen = 0;
    for (let r = 0; r < 5; r++) {
      const sym = lineSymbols[r]!;
      if (sym === bundle.scatterId) break;
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

    // Base line win (raw payout * perLinePredict).
    let lineWin = perLinePredict * BigInt(multiplier);

    // Bundle B — multiply by the product of any wild multipliers that
    // sit on the matchLen prefix of this line. A line with 2 wilds at
    // ×3 and ×5 = ×15 line multiplier on top of the kind payout.
    // No-op when wmLookup is empty (classic-3x5).
    if (wmLookup.size > 0) {
      for (let r = 0; r < matchLen; r++) {
        const cellRow = line.rows[r]!;
        const key = r * 3 + cellRow;
        const wm = wmLookup.get(key);
        if (wm !== undefined) {
          lineWin *= BigInt(wm);
        }
      }
    }

    // Bundle B free-spin scaling — applied after wild multipliers so the
    // line-multiplier card UI shows the FS-doubled values cleanly.
    if (freeSpinLineMultiplier !== 1) {
      lineWin *= BigInt(freeSpinLineMultiplier);
    }

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
