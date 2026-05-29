/**
 * Phase 6 economy-fix sizing — Baccarat house-edge Monte Carlo (sims only).
 *
 * Drives the AS-BUILT `playCoupWithState` + `settleBet` from
 * `apps/api/src/services/baccarat-engine.ts` for the three legal bets
 * (PLAYER, BANKER, TIE) at multiple flat stakes and reports the REAL house
 * edge per (bet, stake):
 *
 *     house edge = (total staked − total returned) / total staked
 *
 * where "returned" is the engine's gross `payout` (stake back + winnings on a
 * win, stake back on a P/B push at a tie, 0 on a loss). A POSITIVE house edge
 * means the house profits; a NEGATIVE house edge means the bet is
 * player-favorable (the house bleeds CT) — that is the leak we are hunting.
 *
 * ── The leak (commission floor) and its FIX (2026-05-29) ─────────────────────
 *
 * BEFORE the fix, `settleBet` computed the banker commission as
 *     commission = (stake * 5n) / 100n   // floored the COMMISSION
 * which floored to 0 for any stake < 20 → a BANKER win paid the FULL 1:1 with
 * NO commission → banker was PLAYER-favorable on small stakes (a faucet).
 *
 * AFTER the fix, the engine floors the PLAYER's WINNINGS instead:
 *     winnings   = floor(stake * 95 / 100)   // 0.95:1, rounded DOWN
 *     commission = stake - winnings          // the kept fraction, ≥ 1 always
 * so the house keeps the fraction at EVERY stake. This sim (which imports the
 * live engine) now shows BANKER house edge POSITIVE at every stake — ~+1.06%+
 * at stake 100, and a slightly HIGHER edge at small stakes (the floored chip is
 * a larger % of a small win). NEGATIVE banker edge would mean the fix regressed.
 *
 * ── Reference house edges (8-deck, standard rules) ──────────────────────────
 *   PLAYER : +1.24%   (1:1, no commission)
 *   BANKER : +1.06%   (0.95:1, full 5% commission — i.e. stake ≥ 20 here)
 *   TIE 8:1: +14.36%  (this engine pays 8:1, the high-edge variant)
 * These are the targets the stake-100 column should converge toward.
 *
 * ── Seeding (per CLAUDE.md sims rule) ────────────────────────────────────────
 * A FRESH 32-byte serverSeed (crypto.randomBytes via `createServerSeed()`) is
 * rolled for every shoe so the Monte-Carlo samples independent shoes. Engine
 * card draws still come ONLY from the HMAC stream — the random seed is the
 * commit, never injected into the draw. Coups within a shoe are threaded with
 * `playCoupWithState` (no-replacement) until the 75% penetration gate fires,
 * then a fresh shoe (fresh seed) opens — mirroring a real session.
 *
 * Does NOT modify any engine or route. Sims only.
 *
 * CLI:
 *   bun scripts/casino/edge-sim-baccarat.ts [--coups 200000] [--client-seed deadbeef]
 */

import { performance } from 'node:perf_hooks';

import {
  playCoupWithState,
  RESHUFFLE_CARD_THRESHOLD,
  type BaccaratBet,
  type Card,
} from '../../apps/api/src/services/baccarat-engine';
import { createServerSeed } from '../../apps/api/src/services/provable-rng';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Cli {
  coups: number;
  clientSeed: string;
}

function parseCli(argv: readonly string[]): Cli {
  const cli: Cli = { coups: 200_000, clientSeed: 'deadbeef' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--coups') {
      const v = argv[++i];
      if (!v) throw new Error('--coups requires a value');
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--coups must be a positive integer, got ${v}`);
      cli.coups = n;
    } else if (a === '--client-seed') {
      const v = argv[++i];
      if (!v) throw new Error('--client-seed requires a value');
      cli.clientSeed = v;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: bun scripts/casino/edge-sim-baccarat.ts [--coups 200000] [--client-seed deadbeef]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return cli;
}

// ---------------------------------------------------------------------------
// Per-(bet, stake) accumulator
// ---------------------------------------------------------------------------

interface Cell {
  bet: BaccaratBet;
  stake: bigint;
  coups: number;
  staked: bigint;
  returned: bigint; // sum of engine gross payout
  wins: number;
  pushes: number;
  losses: number;
  commission: bigint;
}

const BETS: BaccaratBet[] = ['player', 'banker', 'tie'];
const STAKES: bigint[] = [10n, 30n, 100n];

function newCell(bet: BaccaratBet, stake: bigint): Cell {
  return {
    bet,
    stake,
    coups: 0,
    staked: 0n,
    returned: 0n,
    wins: 0,
    pushes: 0,
    losses: 0,
    commission: 0n,
  };
}

/**
 * Run `coups` coups for ONE (bet, stake) cell. Each cell gets its own fresh
 * shoe sequence so the no-replacement shoe state is honest per bet/stake. We
 * roll a new serverSeed every shoe and reshuffle at the 75% gate.
 */
function runCell(bet: BaccaratBet, stake: bigint, totalCoups: number, clientSeed: string): Cell {
  const cell = newCell(bet, stake);

  let serverSeed = createServerSeed().serverSeed; // fresh shoe seed
  let remaining: Card[] | undefined = undefined;
  let cursor = 0;
  let dealt = 0;
  let nonce = 0; // per-shoe coup index

  for (let i = 0; i < totalCoups; i++) {
    // Open a fresh shoe (fresh seed) when we cross the 75% penetration gate,
    // exactly like the route does at coup boundaries.
    if (dealt >= RESHUFFLE_CARD_THRESHOLD) {
      serverSeed = createServerSeed().serverSeed;
      remaining = undefined;
      cursor = 0;
      dealt = 0;
      nonce = 0;
    }

    const stepped = playCoupWithState({
      serverSeed,
      clientSeed,
      nonce,
      cursor,
      bet,
      stake,
      dealtBefore: dealt,
      remainingShoe: dealt === 0 ? undefined : remaining,
    });

    const r = stepped.result;
    cell.coups++;
    cell.staked += stake;
    cell.returned += r.payout;
    cell.commission += r.commission;
    if (r.net > 0n) cell.wins++;
    else if (r.net === 0n) cell.pushes++;
    else cell.losses++;

    remaining = stepped.remainingAfter;
    cursor = stepped.cursorAfter;
    dealt = stepped.dealtAfter;
    nonce++;
  }

  return cell;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return (n * 100).toFixed(4) + '%';
}

function formatReport(cells: Cell[], cli: Cli, wallMs: number): string {
  const lines: string[] = [];
  lines.push('═'.repeat(96));
  lines.push('Baccarat house-edge Monte Carlo — FIXED engine (8-deck, banker winnings floored at 0.95:1 every stake, tie 8:1)');
  lines.push('═'.repeat(96));
  lines.push('');
  lines.push(`Coups per (bet, stake): ${cli.coups.toLocaleString()}`);
  lines.push(`Client seed:            ${cli.clientSeed}`);
  lines.push(`Fresh serverSeed per shoe (crypto.randomBytes); reshuffle gate = ${RESHUFFLE_CARD_THRESHOLD} cards`);
  lines.push(`Wall clock:             ${(wallMs / 1000).toFixed(2)}s`);
  lines.push('');
  lines.push('House edge = (total staked − total returned) / total staked.  NEGATIVE = player-favorable (leak).');
  lines.push('');
  lines.push(
    [
      'bet'.padEnd(8),
      'stake'.padStart(6),
      'house edge'.padStart(12),
      'win%'.padStart(8),
      'push%'.padStart(8),
      'loss%'.padStart(8),
      'avg comm'.padStart(10),
      'net CT (house)'.padStart(16),
    ].join('  '),
  );
  lines.push('-'.repeat(96));

  for (const c of cells) {
    const edge = Number(c.staked - c.returned) / Number(c.staked);
    const houseNet = c.staked - c.returned; // positive = house profit
    const avgComm = c.coups > 0 ? Number(c.commission) / c.coups : 0;
    const flag =
      c.bet === 'banker' && edge < 0 ? '  <<< NEGATIVE EDGE — REGRESSION (banker should be house-positive post-fix)' : '';
    lines.push(
      [
        c.bet.padEnd(8),
        c.stake.toString().padStart(6),
        pct(edge).padStart(12),
        pct(c.wins / c.coups).padStart(8),
        pct(c.pushes / c.coups).padStart(8),
        pct(c.losses / c.coups).padStart(8),
        avgComm.toFixed(4).padStart(10),
        houseNet.toString().padStart(16),
      ].join('  ') + flag,
    );
  }

  lines.push('-'.repeat(96));
  lines.push('');
  lines.push('Reference (textbook, 8-deck): PLAYER +1.24% · BANKER +1.06% (full commission) · TIE 8:1 +14.36%');
  lines.push('FIX: banker winnings = floor(stake*95/100) → commission ≥ 1 at every stake; banker edge house-POSITIVE everywhere.');

  // Explicit FIX verdict (post-2026-05-29): banker must be house-positive at every stake.
  const banker10 = cells.find((c) => c.bet === 'banker' && c.stake === 10n)!;
  const banker100 = cells.find((c) => c.bet === 'banker' && c.stake === 100n)!;
  const edge10 = Number(banker10.staked - banker10.returned) / Number(banker10.staked);
  const edge100 = Number(banker100.staked - banker100.returned) / Number(banker100.staked);
  lines.push('');
  lines.push(
    `FIX VERDICT: banker@10 edge=${pct(edge10)} (${edge10 > 0 ? 'POSITIVE — fix holds' : 'NEGATIVE — REGRESSION'}), ` +
      `banker@100 edge=${pct(edge100)} (${edge100 > 0.008 && edge100 < 0.013 ? '~+1.06% as expected' : 'check'})`,
  );
  lines.push('═'.repeat(96));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  process.stderr.write(
    `Baccarat edge sim: ${cli.coups.toLocaleString()} coups × ${BETS.length} bets × ${STAKES.length} stakes ` +
      `= ${(cli.coups * BETS.length * STAKES.length).toLocaleString()} total coups\n\n`,
  );

  const t0 = performance.now();
  const cells: Cell[] = [];
  for (const bet of BETS) {
    for (const stake of STAKES) {
      process.stderr.write(`  running ${bet} @ ${stake} …\n`);
      cells.push(runCell(bet, stake, cli.coups, cli.clientSeed));
    }
  }
  const wallMs = performance.now() - t0;

  process.stdout.write(formatReport(cells, cli, wallMs) + '\n');
}

main();
