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
   * Bundle B: line wins now include any wild multiplier products that
   * crossed the matchLen prefix. Pre-bundle paytables (classic-3x5)
   * are unaffected because no `WILD_MULTIPLIER_TABLE` draws occur for
   * them — `wildMultipliers` is always `[]` and the per-line multiplier
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
   * Total stake (a.k.a. "predict") for this spin in atomic units. MUST
   * be > 0n and divisible by the paytable's line count. For classic-3x5
   * (20 lines): 20n, 40n, 60n, ... 2000n etc.
   *
   * In free-spin mode (`freeSpinMode=true`) the engine treats this as
   * the predict that line wins + scatter pays are scaled against, BUT
   * the caller (`/spin` route) does NOT debit the player. The value
   * MUST still be the session's per-spin predict so payout math matches
   * what would have been won outside the bonus.
   *
   * Field name kept as `bet` for backwards compatibility with the
   * in-flight rename refactor; new external callers should think of it
   * as `predict`. The rename agent will swap this field across the
   * codebase in a separate slice.
   */
  bet: bigint;
  /**
   * Phase 6.1.5 — when true, this is a FREE spin:
   *   • caller skips the predict debit (route concern, not engine);
   *   • all wild multipliers double (`FS_WILD_MULTIPLIER_DOUBLE`);
   *   • all line wins double (`FS_LINE_WIN_MULTIPLIER`);
   *   • scatter pays still award their base 2×/10×/50× — they do NOT
   *     double in FS mode (slot industry convention; spec is explicit
   *     that the FS scalar applies to LINE wins + WILD multipliers).
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
  // On non-bonus paytables (`scatterId === null` → classic-3x5) we still
  // run the wild detection so the audit guard below stays load-bearing,
  // but we DO NOT draw multipliers: there's no bonus story and the
  // classic RTP was tuned without them. `wildMultipliers` returns `[]`
  // and `cursorAfter` matches slice-2 behaviour byte-for-byte.
  //
  // RTP-shape decision (Bundle B): multiplier wilds APPLY ONLY in free-
  // spin mode. In base mode the wild still substitutes (slice-2
  // behaviour) but its multiplier is RECORDED and emitted in the
  // `wildMultipliers` array — the UI shows a "potential" chip — but
  // does NOT apply to base-mode line wins. This matches the industry-
  // standard "wild multipliers are a free-spins feature" pattern
  // (Starburst/Sweet Bonanza style) and lets the bonus paytable's base
  // RTP land in the ~95-97% band while the FS pass takes it up to the
  // combined-RTP target of 97-99%. Skipping base-mode multiplier
  // application avoids a 20pp RTP overrun.
  //
  // The draw still happens deterministically per landed wild so the
  // verifier can replay the byte stream byte-for-byte; the multiplier
  // is just "show, don't apply" in base.
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
        // In FS mode emit the DOUBLED value so the UI chip shows the
        // user-facing number directly; in base emit the raw draw value
        // (informational — line wins don't multiply by it).
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
  // Bundle B: pass wildMultipliers + line-win scalar ONLY in free-spin
  // mode (per the RTP-shape decision above). In base mode the empty
  // array + 1× scalar reproduce slice-2 line math byte-for-byte.
  const { winningLines, winAmount: lineWinTotal } = evaluateReels(
    reels,
    bundle.id,
    args.bet,
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
    if (scatterCount >= 3) {
      // Pay multiplier on TOTAL PREDICT (args.bet), not perLineBet.
      // Clamp to table length to avoid OOB on a future 6-of-kind misprint.
      const tier = SCATTER_PAY_TABLE[Math.min(scatterCount, SCATTER_PAY_TABLE.length - 1)] ?? 0;
      scatterPayout = args.bet * BigInt(tier);
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
 * That means existing callers (`evaluateReels(reels, id, bet)`) keep
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
 * Same `bet` rules as `runSpin` (positive bigint, divisible by line
 * count). Scatter symbols on a payline are treated as "any non-
 * matching" — they neither extend a kind nor start one — because their
 * payouts are all zero and they pay anywhere via the separate scatter
 * pass in `runSpin`.
 */
export function evaluateReels(
  reels: readonly (readonly SymbolId[])[],
  paytableId: MachineSlug,
  bet: bigint,
  options: EvaluateReelsOptions = {},
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

  const perLineBet = bet / lineCount;
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
    // "non-matching" also means the line BREAKS at a scatter cell: a
    // run "Cherry,Cherry,Scatter,Cherry,Cherry" pays 2-of-kind Cherry,
    // not 5-of-kind (with the scatter as "any non-wild").
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

    // Base line win (raw payout * perLineBet).
    let lineWin = perLineBet * BigInt(multiplier);

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
