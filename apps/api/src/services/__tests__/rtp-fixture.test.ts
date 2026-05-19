/**
 * Phase 6.1 — RTP fixture / smoke test (slice 4).
 *
 * Runs a small Monte Carlo (10k spins) against `classic-3x5` inside the
 * normal `bun test` suite and asserts the empirical RTP lands in a wide
 * safety band [92%, 100%]. The wide band absorbs 10k-sample stderr —
 * with the current paytable a single-seed run typically lands within
 * ±1% of the analytic 96.00%, but rare seeds can drift to ~92-97% just
 * from variance.
 *
 * Purpose: catch gross paytable drift the moment it lands in source.
 * Doubling a payout, deleting the wild, halving reel-strip length —
 * all of those bust the band on every seed. The strict CI workflow
 * (.github/workflows/rtp-gate.yml) runs 100k spins on a tighter
 * [95%, 97%] band — this test is the cheap-and-fast first line.
 *
 * This test imports `runSpin` directly from the engine module (no
 * pokie wrapper). It is deliberately seeded with a FIXED server seed
 * so failures are reproducible. CI flakes on a stochastic test would
 * be worse than the test not existing.
 */

import { describe, expect, it } from 'bun:test';

import { CLASSIC_LINES } from '@clawville/shared';

import { runSpin } from '../slot-engine';

const SERVER_SEED = 'a'.repeat(64);
const CLIENT_SEED = 'deadbeef';
const SPINS = 10_000;
const BET = 100n;
const LINE_COUNT = CLASSIC_LINES.length; // 20

describe('classic-3x5 RTP fixture', () => {
  it(
    `10k-spin Monte Carlo lands within [92%, 100%] (wide acceptance band)`,
    () => {
      let totalWagered = 0n;
      let totalPaid = 0n;
      let cursor = 0;
      let hits = 0;
      let maxWin = 0n;

      for (let i = 0; i < SPINS; i++) {
        const spin = runSpin({
          paytableId: 'classic-3x5',
          serverSeed: SERVER_SEED,
          clientSeed: CLIENT_SEED,
          nonce: i + 1,
          cursor,
          bet: BET,
        });
        cursor = spin.cursorAfter;
        totalWagered += BET;
        totalPaid += spin.winAmount;
        if (spin.winAmount > 0n) hits++;
        if (spin.winAmount > maxWin) maxWin = spin.winAmount;
      }

      const rtp = Number(totalPaid) / Number(totalWagered);
      const hitFreq = hits / SPINS;

      // Wide band — see top-of-file. The tight 1M acceptance band is
      // [95.5%, 96.5%] (enforced by the local rtp-sim run in the slice
      // ship report); CI workflow uses [95%, 97%] at 100k; this test
      // uses [92%, 100%] at 10k.
      expect(rtp).toBeGreaterThanOrEqual(0.92);
      expect(rtp).toBeLessThanOrEqual(1.0);

      // Sanity: hit frequency should be in a reasonable slot range.
      // Anything outside [50%, 95%] is a sign the wild/match logic
      // broke in a non-obvious way (e.g. wild always substitutes,
      // every line wins).
      expect(hitFreq).toBeGreaterThanOrEqual(0.5);
      expect(hitFreq).toBeLessThanOrEqual(0.95);

      // Sanity: max single-spin win must not explode past the highest
      // possible analytic payout. Top combo is 5x Seven on all 20
      // lines = 800 mult × perLineBet = 800 × (100 / 20) = 4000 per
      // line × 20 lines = 80000 max in theory (5x Seven across every
      // line). We assert maxWin <= 200000n as a comically wide ceiling
      // — the real expected max at 10k spins is well under 10000n.
      expect(maxWin).toBeLessThanOrEqual(200_000n);

      // Adversarial: a non-zero wager guarantees totalWagered === SPINS * BET.
      expect(totalWagered).toBe(BigInt(SPINS) * BET);
      // perLineBet is BET / LINE_COUNT — make sure that hasn't drifted.
      expect(BET % BigInt(LINE_COUNT)).toBe(0n);
    },
    // Default bun test timeout is 5s; 10k spins comfortably finishes
    // in <0.5s on CI hardware. The 30s ceiling here is for slow CI
    // runners (low-tier ARM, etc.).
    30_000,
  );
});
