/**
 * Phase 6.1 — Monte Carlo RTP simulator (slice 4).
 *
 * Drives `runSpin()` from the apps/api slot engine + `CLASSIC_PAYTABLE`
 * from @clawville/shared for N spins and reports:
 *
 *   - RTP (paid / wagered) with 95% CI half-width
 *   - Hit frequency (% spins with any win)
 *   - Max single-spin win in stake units
 *   - Win histogram: loss / 0-1x / 1-5x / 5-25x / 25-100x / 100x+
 *   - Per-symbol reel-position hit rate (sanity vs strip density)
 *   - Wall-clock time
 *
 * Determinism contract — same `--spins` + `--seed` (and same engine
 * code + paytable) ⇒ byte-identical report. We deliberately generate
 * the serverSeed via `createServerSeed()` ONCE at startup unless the
 * caller pins one with `--seed`, so a fresh invocation without flags
 * still gives a reproducible run within this process.
 *
 * Used by:
 *   - `.github/workflows/rtp-gate.yml` — 100k-spin CI gate, enforces
 *     RTP ∈ [0.95, 0.97] via `--strict-rtp` + `--exit-on-fail`.
 *   - Local 1M-spin tuning runs while iterating reel strip density.
 *   - One-shot acceptance check in the slice-4 ship report.
 *
 * CLI:
 *   bun scripts/casino/rtp-sim.ts \
 *     [--spins 1000000] [--bet 100] [--seed <64hex>] \
 *     [--strict-rtp <low>,<high>] [--exit-on-fail] [--client-seed <hex>]
 *
 * Notes:
 *   - `bet=100n` is the default to match the engine test fixture (must
 *     stay divisible by lineCount=20). The CLI clamps non-divisible bets
 *     up to the nearest multiple.
 *   - The clientSeed is fixed at `'deadbeef'` by default (must be hex
 *     per `normalizeClientSeed` in provable-rng); pass `--client-seed`
 *     for sensitivity analysis.
 *   - nonce starts at 1 and increments per spin. cursor accumulates from
 *     `cursorAfter` so the HMAC stream is consumed contiguously (mirrors
 *     a real session's bookkeeping).
 *   - The histogram uses `winRatio = win/bet` so a 3.5x payout on bet=100
 *     lands in the 1-5x bucket regardless of bet size.
 */

import { performance } from 'node:perf_hooks';

import { runSpin, type MachineSlug } from '../../apps/api/src/services/slot-engine';
import { createServerSeed } from '../../apps/api/src/services/provable-rng';
import {
  BONUS_REEL_STRIPS,
  BONUS_SYMBOLS,
  CLASSIC_LINES,
  CLASSIC_REEL_STRIPS,
  CLASSIC_SYMBOLS,
  FREE_SPIN_RULES,
} from '@clawville/shared';

import type { SlotSymbolDef } from '@clawville/shared';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  spins: number;
  bet: bigint;
  seed: string | null;
  clientSeed: string;
  strictRtpLow: number | null;
  strictRtpHigh: number | null;
  exitOnFail: boolean;
  paytable: MachineSlug;
}

function parseCli(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    spins: 1_000_000,
    bet: 100n,
    seed: null,
    clientSeed: 'deadbeef',
    strictRtpLow: null,
    strictRtpHigh: null,
    exitOnFail: false,
    paytable: 'classic-3x5',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--spins': {
        const v = argv[++i];
        if (!v) throw new Error('--spins requires a value');
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`--spins must be a positive integer, got ${v}`);
        }
        opts.spins = n;
        break;
      }
      case '--bet': {
        const v = argv[++i];
        if (!v) throw new Error('--bet requires a value');
        const n = BigInt(v);
        if (n <= 0n) throw new Error(`--bet must be > 0, got ${v}`);
        opts.bet = n;
        break;
      }
      case '--seed': {
        const v = argv[++i];
        if (!v) throw new Error('--seed requires a value');
        if (!/^[0-9a-fA-F]{64}$/.test(v)) {
          throw new Error(`--seed must be 64 hex chars, got ${v.length}`);
        }
        opts.seed = v.toLowerCase();
        break;
      }
      case '--client-seed': {
        const v = argv[++i];
        if (!v) throw new Error('--client-seed requires a value');
        opts.clientSeed = v;
        break;
      }
      case '--strict-rtp': {
        const v = argv[++i];
        if (!v) throw new Error('--strict-rtp requires <low>,<high>');
        const parts = v.split(',');
        if (parts.length !== 2) {
          throw new Error(`--strict-rtp must be <low>,<high>, got ${v}`);
        }
        const low = Number(parts[0]);
        const high = Number(parts[1]);
        if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) {
          throw new Error(`--strict-rtp bounds invalid: low=${low} high=${high}`);
        }
        opts.strictRtpLow = low;
        opts.strictRtpHigh = high;
        break;
      }
      case '--exit-on-fail':
        opts.exitOnFail = true;
        break;
      case '--paytable': {
        const v = argv[++i];
        if (!v) throw new Error('--paytable requires a value');
        if (v !== 'classic-3x5' && v !== 'classic-3x5-bonus') {
          throw new Error(
            `--paytable must be 'classic-3x5' or 'classic-3x5-bonus', got '${v}'`,
          );
        }
        opts.paytable = v as MachineSlug;
        break;
      }
      case '--help':
      case '-h':
        printHelpAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelpAndExit(): never {
  console.log(`Monte Carlo RTP simulator for classic-3x5 paytable.

Usage:
  bun scripts/casino/rtp-sim.ts [options]

Options:
  --paytable <id>         'classic-3x5' (default) or 'classic-3x5-bonus'.
                          Bonus paytable engages multiplier wilds + scatter
                          + free-spin state machine; report separates base /
                          free-spin / combined RTP.
  --spins <n>             Number of BASE spins to simulate (default 1000000;
                          free spins triggered inside base spins count
                          separately and do NOT decrement this counter)
  --bet <n>               Stake per spin in atomic units (default 100, must
                          be divisible by line count = 20)
  --seed <64hex>          Pin server seed for reproducibility (default:
                          freshly generated each run)
  --client-seed <hex>     Client seed (default 'deadbeef')
  --strict-rtp <lo>,<hi>  Assert COMBINED RTP ∈ [lo, hi] (e.g. 0.95,0.97 or
                          0.965,0.995 for the bonus paytable)
  --exit-on-fail          Exit non-zero if --strict-rtp violated
                          (without this flag, violation just prints a
                          warning — useful for local exploration)
  -h, --help              Show this help
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

interface SimResult {
  spins: number;
  totalWagered: bigint;
  totalPaid: bigint;
  hitCount: number;
  maxWinStake: number; // win / bet (float, ratio)
  maxWinRaw: bigint;
  histogram: Record<string, number>;
  /** symbolHits[symbolId] = number of times this symbol appeared at the MIDDLE
   *  row across all spins/reels (3 visible rows per reel * 5 reels = 15 slots
   *  per spin; we only count the middle stop here because it's the sampled
   *  position — top/bottom are derivatives via ±1 mod stripLen). */
  symbolMiddleHits: number[];
  /** Cumulative tally of every visible cell (top/mid/bot across 5 reels). */
  symbolVisibleHits: number[];
  wallClockMs: number;

  // Phase 6.1.5 Bundle B — separate FS-mode accounting. On classic-3x5
  // these stay at zero (no FS path). On classic-3x5-bonus, freeSpinPaid
  // tracks payout earned WHILE in FS mode; freeSpinWagered tracks the
  // PSEUDO-wager (predict × free spins played) so we can derive an FS
  // RTP independent of base. `triggerCount` = base spins that awarded FS.
  freeSpinCount: number;
  freeSpinPaid: bigint;
  freeSpinPseudoWagered: bigint;
  triggerCount: number;
  retriggerCount: number;
}

const BUCKETS = [
  { name: 'loss', test: (r: number) => r === 0 },
  { name: 'micro (0-1x)', test: (r: number) => r > 0 && r < 1 },
  { name: 'small (1-5x)', test: (r: number) => r >= 1 && r < 5 },
  { name: 'medium (5-25x)', test: (r: number) => r >= 5 && r < 25 },
  { name: 'big (25-100x)', test: (r: number) => r >= 25 && r < 100 },
  { name: 'mega (100x+)', test: (r: number) => r >= 100 },
] as const;

function runSimulation(opts: CliOptions, serverSeed: string): SimResult {
  const lineCount = CLASSIC_LINES.length;
  if (opts.bet % BigInt(lineCount) !== 0n) {
    throw new Error(
      `--bet (${opts.bet}) must be divisible by line count (${lineCount})`,
    );
  }

  // Paytable-aware symbol catalogue. Bonus paytable has 11 symbols
  // (10 + Scatter); per-symbol histograms must size accordingly.
  const symbolTable: SlotSymbolDef[] =
    opts.paytable === 'classic-3x5-bonus' ? BONUS_SYMBOLS : CLASSIC_SYMBOLS;
  const symbolCount = symbolTable.length;

  const result: SimResult = {
    spins: opts.spins,
    totalWagered: 0n,
    totalPaid: 0n,
    hitCount: 0,
    maxWinStake: 0,
    maxWinRaw: 0n,
    histogram: Object.fromEntries(BUCKETS.map((b) => [b.name, 0])),
    symbolMiddleHits: new Array<number>(symbolCount).fill(0),
    symbolVisibleHits: new Array<number>(symbolCount).fill(0),
    wallClockMs: 0,
    freeSpinCount: 0,
    freeSpinPaid: 0n,
    freeSpinPseudoWagered: 0n,
    triggerCount: 0,
    retriggerCount: 0,
  };

  const betFloat = Number(opts.bet);
  const t0 = performance.now();
  let cursor = 0;
  let nonce = 1;
  let freeSpinsRemaining = 0;

  // Progress dots — emit at ~5% intervals for long runs, suppress for
  // short CI runs where the chatter would clutter logs.
  const progressStride =
    opts.spins >= 100_000 ? Math.floor(opts.spins / 20) : 0;

  for (let i = 0; i < opts.spins; i++) {
    // ---- BASE SPIN ------------------------------------------------------
    const spin = runSpin({
      paytableId: opts.paytable,
      serverSeed,
      clientSeed: opts.clientSeed,
      nonce: nonce++,
      cursor,
      bet: opts.bet,
      freeSpinMode: false,
    });

    cursor = spin.cursorAfter;
    result.totalWagered += opts.bet;
    result.totalPaid += spin.winAmount;
    accumulateSpin(spin, opts.bet, betFloat, result);

    // Track free-spin trigger from a BASE spin.
    if (spin.freeSpinsAwarded > 0) {
      result.triggerCount++;
      freeSpinsRemaining = Math.min(
        FREE_SPIN_RULES.CAP_REMAINING,
        freeSpinsRemaining + spin.freeSpinsAwarded,
      );
    }

    // ---- FREE SPINS (drain the budget) ----------------------------------
    while (freeSpinsRemaining > 0) {
      const fs = runSpin({
        paytableId: opts.paytable,
        serverSeed,
        clientSeed: opts.clientSeed,
        nonce: nonce++,
        cursor,
        bet: opts.bet,
        freeSpinMode: true,
      });
      cursor = fs.cursorAfter;
      result.freeSpinCount++;
      result.freeSpinPaid += fs.winAmount;
      result.freeSpinPseudoWagered += opts.bet;
      result.totalPaid += fs.winAmount;
      // NOTE: totalWagered does NOT include FS predicts (FS is free) —
      // that's why combined RTP can exceed 100% in principle.
      accumulateSpin(fs, opts.bet, betFloat, result);
      freeSpinsRemaining--;
      if (fs.freeSpinsAwarded > 0) {
        result.retriggerCount++;
        freeSpinsRemaining = Math.min(
          FREE_SPIN_RULES.CAP_REMAINING,
          freeSpinsRemaining + fs.freeSpinsAwarded,
        );
      }
    }

    if (progressStride > 0 && i > 0 && i % progressStride === 0) {
      const pct = ((i / opts.spins) * 100).toFixed(0);
      const rtpSoFar = (
        (Number(result.totalPaid) / Number(result.totalWagered)) *
        100
      ).toFixed(2);
      process.stderr.write(
        `  ${pct}% (RTP so far: ${rtpSoFar}%${result.freeSpinCount > 0 ? `, FS played: ${result.freeSpinCount}` : ''})\n`,
      );
    }
  }

  result.wallClockMs = performance.now() - t0;
  return result;
}

/** Accumulate single-spin tallies into the running SimResult. */
function accumulateSpin(
  spin: { winAmount: bigint; reels: number[][] },
  bet: bigint,
  betFloat: number,
  result: SimResult,
): void {
  if (spin.winAmount > 0n) {
    result.hitCount++;
    const winFloat = Number(spin.winAmount);
    const ratio = winFloat / betFloat;
    if (ratio > result.maxWinStake) {
      result.maxWinStake = ratio;
      result.maxWinRaw = spin.winAmount;
    }
    for (const b of BUCKETS) {
      if (b.test(ratio)) {
        result.histogram[b.name]!++;
        break;
      }
    }
  } else {
    result.histogram.loss!++;
  }
  for (let r = 0; r < 5; r++) {
    const reel = spin.reels[r]!;
    if (reel[1]! < result.symbolMiddleHits.length) {
      result.symbolMiddleHits[reel[1]!]!++;
    }
    for (let row = 0; row < 3; row++) {
      const id = reel[row]!;
      if (id < result.symbolVisibleHits.length) {
        result.symbolVisibleHits[id]++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatReport(opts: CliOptions, serverSeed: string, r: SimResult): string {
  // Combined RTP (base spins + free spins, divided by base wagering).
  const rtp = Number(r.totalPaid) / Number(r.totalWagered);
  // Base-only RTP: paid on BASE spins (totalPaid - freeSpinPaid) / base wager.
  const basePaid = r.totalPaid - r.freeSpinPaid;
  const baseRtp = Number(basePaid) / Number(r.totalWagered);
  // Free-spin RTP: paid in FS / pseudo-wagered (predict × FS plays).
  const fsRtp = r.freeSpinPseudoWagered > 0n
    ? Number(r.freeSpinPaid) / Number(r.freeSpinPseudoWagered)
    : 0;
  // Combined denominator includes BASE spins only; total spins (base + FS)
  // for hit-freq denominator.
  const totalActualSpins = r.spins + r.freeSpinCount;
  const hitFreq = r.hitCount / totalActualSpins;
  const triggerRate = r.spins > 0 ? r.triggerCount / r.spins : 0;

  // 95% CI half-width for a Bernoulli-ish per-spin payout ratio. We use a
  // simple normal approximation: stderr = sqrt(p*(1-p)/n) IS WRONG for
  // payout ratios because the variance is dominated by mega wins. Instead,
  // compute the empirical std of (paid/bet) per spin lazily.
  // For a quick CI bound, use:
  //   approx 95% CI half-width = 1.96 * stddev_per_spin / sqrt(n)
  // We don't have per-spin variance tallied here, so fall back to a
  // rule-of-thumb based on hit freq and bucket distribution — good enough
  // for sanity, not a load-bearing number.
  const ciHalfWidth = approximateRtpCi(r);

  const lines: string[] = [];
  lines.push('═'.repeat(72));
  lines.push(`Monte Carlo RTP simulation — paytable: ${opts.paytable}`);
  lines.push('═'.repeat(72));
  lines.push('');
  lines.push(`Base spins:      ${r.spins.toLocaleString()}`);
  lines.push(`Free spins:      ${r.freeSpinCount.toLocaleString()}  (avg ${r.spins > 0 ? (r.freeSpinCount / r.spins).toFixed(3) : '0.000'} per base spin)`);
  lines.push(`Triggers:        ${r.triggerCount.toLocaleString()}  (rate ${(triggerRate * 100).toFixed(3)}%, 1 per ${triggerRate > 0 ? Math.round(1 / triggerRate) : '∞'} base spins)`);
  lines.push(`Retriggers:      ${r.retriggerCount.toLocaleString()}`);
  lines.push(`Bet/spin:        ${opts.bet} (${Number(opts.bet)})`);
  lines.push(`Server seed:     ${serverSeed}`);
  lines.push(`Client seed:     ${opts.clientSeed}`);
  lines.push(`Wall clock:      ${(r.wallClockMs / 1000).toFixed(2)}s`);
  lines.push(`Spins/sec:       ${((r.spins + r.freeSpinCount) / (r.wallClockMs / 1000)).toFixed(0)}`);
  lines.push('');
  lines.push(`Total wagered:   ${r.totalWagered}  (BASE spins only; FS is free)`);
  lines.push(`Total paid:      ${r.totalPaid}`);
  lines.push(`  base paid:     ${basePaid}`);
  lines.push(`  FS paid:       ${r.freeSpinPaid}`);
  lines.push(`Base RTP:        ${(baseRtp * 100).toFixed(4)}%  (paid-from-base-spins / base-wager)`);
  lines.push(`FS RTP:          ${(fsRtp * 100).toFixed(4)}%  (paid-from-FS-spins / pseudo-FS-wager)`);
  lines.push(`Combined RTP:    ${(rtp * 100).toFixed(4)}%  (±${(ciHalfWidth * 100).toFixed(3)}% approx 95% CI)`);
  lines.push(`Hit frequency:   ${(hitFreq * 100).toFixed(3)}%  (${r.hitCount.toLocaleString()} winning spins / ${totalActualSpins.toLocaleString()} total spins)`);
  lines.push(`Max win:         ${r.maxWinStake.toFixed(2)}x stake  (raw: ${r.maxWinRaw})`);
  lines.push('');
  lines.push('Win-ratio histogram (% of all spins):');
  for (const b of BUCKETS) {
    const count = r.histogram[b.name]!;
    const pct = (count / r.spins) * 100;
    const bar = '█'.repeat(Math.max(0, Math.round(pct / 2)));
    lines.push(
      `  ${b.name.padEnd(16)} ${pct.toFixed(2).padStart(6)}%  (${count.toLocaleString().padStart(10)})  ${bar}`,
    );
  }
  lines.push('');
  lines.push('Per-symbol middle-row hit rate (sanity vs reel density):');
  lines.push('  id  name           middle-hits  visible-hits  middle%  expected%');
  const symbolTable: SlotSymbolDef[] =
    opts.paytable === 'classic-3x5-bonus' ? BONUS_SYMBOLS : CLASSIC_SYMBOLS;
  const reelStrips =
    opts.paytable === 'classic-3x5-bonus' ? BONUS_REEL_STRIPS : CLASSIC_REEL_STRIPS;
  const totalActualSpinsCount = r.spins + r.freeSpinCount;
  const totalMiddle = totalActualSpinsCount * 5;
  const totalVisible = totalActualSpinsCount * 15;
  for (let id = 0; id < symbolTable.length; id++) {
    const sym = symbolTable[id]!;
    const middle = r.symbolMiddleHits[id]!;
    const visible = r.symbolVisibleHits[id]!;
    const middlePct = (middle / totalMiddle) * 100;
    const visiblePct = (visible / totalVisible) * 100;
    const expected = expectedSymbolPercent(id, reelStrips);
    void visiblePct;
    lines.push(
      `  ${String(id).padEnd(3)} ${sym.name.padEnd(14)} ${middle.toLocaleString().padStart(10)}  ${visible.toLocaleString().padStart(12)}  ${middlePct.toFixed(3).padStart(7)}%  ${expected.toFixed(3).padStart(7)}%`,
    );
  }
  lines.push('');
  // Adversarial sanity: warn if ANY symbol is <0.1% or >50% in middle hits.
  const middleAlerts: string[] = [];
  for (let id = 0; id < symbolTable.length; id++) {
    const middlePct = (r.symbolMiddleHits[id]! / totalMiddle) * 100;
    if (middlePct < 0.1) {
      middleAlerts.push(`  WARN: symbol ${id} (${symbolTable[id]!.name}) middle hit rate ${middlePct.toFixed(3)}% < 0.1% — starved`);
    } else if (middlePct > 50) {
      middleAlerts.push(`  WARN: symbol ${id} (${symbolTable[id]!.name}) middle hit rate ${middlePct.toFixed(3)}% > 50% — overrepresented`);
    }
  }
  if (middleAlerts.length > 0) {
    lines.push('Distribution alerts:');
    lines.push(...middleAlerts);
    lines.push('');
  }
  lines.push('═'.repeat(72));
  return lines.join('\n');
}

/**
 * Average expected % a given symbol id occupies across the 5 reels (based
 * on strip density). This is purely from the reel strips — independent
 * of any RNG draw.
 */
function expectedSymbolPercent(symbolId: number, reelStrips: readonly (readonly number[])[]): number {
  let total = 0;
  let hits = 0;
  for (const strip of reelStrips) {
    total += strip.length;
    for (const s of strip) if (s === symbolId) hits++;
  }
  return total === 0 ? 0 : (hits / total) * 100;
}

/**
 * Approximate 95% CI half-width on the RTP estimate. Quick formula
 * derived empirically: weight mega-wins disproportionately because they
 * dominate variance.
 *
 *   sigma_per_spin ≈ sqrt( sum_buckets( freq_b * (mid_payout_b)^2 ) ) * bet
 *   ci_half = 1.96 * sigma_per_spin / (sqrt(n) * bet)
 *
 * For classic-3x5 at ~96% RTP the expected ci_half at 100k spins is
 * roughly 0.3% and at 1M is ~0.1%; this rough number lets a reviewer
 * sanity-check whether a 0.5% deviation is real or noise.
 */
function approximateRtpCi(r: SimResult): number {
  const bucketMidpoints: Record<string, number> = {
    'loss': 0,
    'micro (0-1x)': 0.5,
    'small (1-5x)': 3,
    'medium (5-25x)': 15,
    'big (25-100x)': 62.5,
    'mega (100x+)': 200, // pessimistic — could be larger
  };
  let variance = 0;
  for (const b of BUCKETS) {
    const freq = r.histogram[b.name]! / r.spins;
    const mid = bucketMidpoints[b.name]!;
    variance += freq * mid * mid;
  }
  const sigma = Math.sqrt(variance);
  return (1.96 * sigma) / Math.sqrt(r.spins);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const opts = parseCli(process.argv.slice(2));
  const serverSeed = opts.seed ?? createServerSeed().serverSeed;

  const strips = opts.paytable === 'classic-3x5-bonus' ? BONUS_REEL_STRIPS : CLASSIC_REEL_STRIPS;
  process.stderr.write(
    `Starting Monte Carlo: ${opts.spins.toLocaleString()} BASE spins, bet=${opts.bet}, paytable=${opts.paytable}\n`,
  );
  process.stderr.write(`Reel strip lengths: [${strips.map((s) => s.length).join(', ')}]\n\n`);

  const result = runSimulation(opts, serverSeed);
  const report = formatReport(opts, serverSeed, result);
  process.stdout.write(report + '\n');

  // Strict-RTP gate (used by CI).
  if (opts.strictRtpLow !== null && opts.strictRtpHigh !== null) {
    const rtp = Number(result.totalPaid) / Number(result.totalWagered);
    const pass = rtp >= opts.strictRtpLow && rtp <= opts.strictRtpHigh;
    const verdict = pass ? 'PASS' : 'FAIL';
    process.stdout.write(
      `\nSTRICT-RTP ${verdict}: RTP=${(rtp * 100).toFixed(4)}%, ` +
      `band=[${(opts.strictRtpLow * 100).toFixed(2)}%, ${(opts.strictRtpHigh * 100).toFixed(2)}%]\n`,
    );
    if (!pass && opts.exitOnFail) {
      process.exit(1);
    }
  }
}

main();
