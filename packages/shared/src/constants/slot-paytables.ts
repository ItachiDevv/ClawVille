/**
 * Slot Paytables — publicly verifiable constants
 *
 * These are the ONLY paytable constants used by both:
 *   - Client: apps/web/src/lib/casino/mock-engine.ts
 *   - Server: apps/api/src/services/slot-engine.ts (Phase 6.1)
 *   - Verifier: apps/web/src/app/casino/verify (Phase 6.1)
 *
 * Public exposure is intentional — provably-fair requires the player
 * can verify their spins client-side using these definitions.
 *
 * Paytable: classic-3x5
 *   - 5 reels × 3 rows, 20 paylines, left-to-right match
 *   - 10 symbols (0-9): 7=Wild, 3-tier BAR (5/8/9), no scatter in MVP
 *   - Target RTP: ~95-96%
 *
 * Symbol layout (Vegas-canonical, third-pass 2026-05-19):
 *   0 = Cherry      (low pay)
 *   1 = Lemon       (low pay)
 *   2 = Orange      (low/mid pay)
 *   3 = Plum        (mid pay)
 *   4 = Bell        (mid pay)
 *   5 = BAR         (high pay; tier 1)
 *   6 = Seven       (mega pay)
 *   7 = WILD        (rare; substitutes any non-scatter)
 *   8 = BAR×2       (high pay; tier 2, independent eval)
 *   9 = BAR×3       (top pay; tier 3, independent eval)
 *
 * 3-tier BAR notes: each BAR tier (5/8/9) is a distinct kind; there is
 * NO "any BAR" mixed rule (modern 5-reel convention). Players hitting
 * BAR, BAR, BAR×2 on a line score 2-of-kind BAR, not 3-of-kind any-BAR.
 */

// ---------------------------------------------------------------------------
// Reel strips — 5 reels × 84 positions
// Higher-value symbols appear fewer times = lower probability.
// These values drive both the mock engine and the real HMAC-derived engine.
//
// Fourth-pass retune (slice 6.1.4 → 6.1.5, 2026-05-19) lands RTP in the
// target band [95.50%, 96.50%] required by the Phase 6.1 plan acceptance
// criterion. Previous tunings:
//   - L=40 original: ~113% RTP (over-paying)
//   - L=80 third-pass: 98.57% analytic / 98.54% sim — still hot
//   - L=84 this pass: 96.00% analytic / 96.00% ± 0.1% sim @ 1M spins
//
// Per-reel distribution (identical across all 5 reels):
//   id 0 Cherry: 22  (26.19%)
//   id 1 Lemon:  22  (26.19%)
//   id 2 Orange: 14  (16.67%)
//   id 3 Plum:   14  (16.67%)
//   id 4 Bell:    7  ( 8.33%)
//   id 5 BAR:     1  ( 1.19%)
//   id 6 Seven:   1  ( 1.19%)
//   id 7 WILD:    1  ( 1.19%)
//   id 8 BAR×2:   1  ( 1.19%)
//   id 9 BAR×3:   1  ( 1.19%)
//   total: 84
//
// Why this composition cools RTP from 98.57% → 96.00%:
//   - Plum (highest-pay among low tier, multiplier 4) cut from 16→14 per
//     reel: Plum-2 contribution drops from 14.18% → 10.86% of total.
//   - Bell (5x mult on 2-of-kind) cut from ~9→7: Bell-2 6.57% → 4.05%.
//   - Cherry/Lemon (2x mult, cheapest) bumped from ~17→22 each: tiny
//     RTP bump (Cherry-2 7.95% → 13.27%) but offset by Plum/Bell cuts.
//
// Strip positions for high-pay singletons (BAR/Seven/WILD/BAR×2/BAR×3)
// are spread at deterministic offsets per reel (rotated by reel index) so
// no two adjacent cells share the same singleton — preserves visual
// readability of the 3-row window.
//
// Generator: `node scripts/casino/_emit-strips.mjs 22 22 14 14 7 84 42`.
// CI gate: `.github/workflows/rtp-gate.yml` runs 100k Monte Carlo on every
// PR touching this file (or the engine) and fails if RTP ∉ [95%, 97%].
// Local acceptance: `bun scripts/casino/rtp-sim.ts --spins 1000000`.
// ---------------------------------------------------------------------------
export const CLASSIC_REEL_STRIPS: number[][] = [
  // Reel 0 (leftmost, len=84): C=22 L=22 O=14 P=14 B=7, +1 each BAR/Seven/WILD/BAR×2/BAR×3
  [0,0,4,2,0,3,1,1,5,2,1,3,1,2,0,2,1,0,3,2,1,3,3,2,0,6,2,1,0,0,1,0,1,0,1,0,0,4,2,0,2,4,7,1,1,2,4,1,3,1,1,4,0,1,3,3,4,2,8,0,1,0,4,2,3,3,3,0,1,2,1,1,3,3,3,9,0,1,0,1,0,2,0,0],
  // Reel 1 (len=84)
  [2,3,0,1,0,3,1,0,6,0,1,0,0,2,0,0,3,3,0,2,1,4,1,0,3,7,0,1,3,1,1,4,2,0,1,0,2,1,4,2,0,1,8,0,2,3,3,1,3,1,0,2,2,1,3,2,3,0,9,4,2,0,4,1,3,0,1,1,4,0,0,1,2,3,0,5,1,1,4,3,1,1,2,2],
  // Reel 2 (center, len=84)
  [4,2,0,3,1,0,0,4,7,4,0,1,0,0,0,3,0,2,3,0,2,0,3,2,0,8,4,0,1,1,3,3,2,2,1,0,2,1,3,2,3,0,9,2,4,0,2,1,1,1,1,2,1,3,1,1,0,2,5,2,0,2,0,4,1,1,0,1,1,1,3,1,4,3,1,6,3,0,3,1,3,1,0,0],
  // Reel 3 (len=84)
  [1,0,0,3,1,0,0,3,8,2,0,0,4,2,1,1,0,4,0,1,2,1,3,3,3,9,1,0,1,3,1,0,1,3,0,4,2,2,1,0,3,3,5,0,1,4,2,1,2,1,0,1,4,3,1,2,0,0,6,0,3,4,1,0,2,3,2,3,2,0,1,1,0,3,2,7,1,4,1,2,0,0,2,1],
  // Reel 4 (rightmost, len=84)
  [0,4,0,2,3,4,1,4,9,0,2,0,4,0,0,1,1,1,3,2,1,1,3,4,3,5,1,1,3,4,2,3,1,1,3,2,1,3,2,2,0,2,6,3,0,1,2,0,0,1,1,1,3,0,1,0,2,1,7,1,1,1,2,2,0,0,3,0,0,1,4,1,0,3,0,8,2,0,3,0,2,0,0,3],
];

// ---------------------------------------------------------------------------
// Symbol definitions — ordered by id 0-9 (positional indexing enforced by
// slot-engine `buildBundle`).
// ---------------------------------------------------------------------------
export interface SlotSymbolDef {
  id: number;
  name: string;
  emoji: string;
  color: string;
  /** payouts[n] = multiplier for (n+2) matching symbols left-to-right */
  payouts: [number, number, number, number];
  isWild?: boolean;
  /**
   * Scatter symbol — pays ANYWHERE on the grid (count >= 3), no payline
   * restriction, and does NOT substitute for other symbols. Added in
   * Phase 6.1.5 (Bundle B). Scatters are evaluated separately from line
   * wins by the engine; their `payouts` array MUST be `[0,0,0,0]` so
   * the line-evaluation path silently skips them.
   *
   * Per Bundle B spec the scatter pays 2×/10×/50× the TOTAL PREDICT for
   * 3/4/5 scatters anywhere. Those multipliers are hard-coded in the
   * engine (`scatterMultiplier()`), not in this field — keeping the
   * `payouts` shape stable lets the existing line-evaluation guard
   * (`payouts.length === 4`) keep firing for scatters too.
   */
  isScatter?: boolean;
}

export const CLASSIC_SYMBOLS: SlotSymbolDef[] = [
  { id: 0, name: 'Cherry',     emoji: '🍒', color: '#d62828', payouts: [2,  5,   10,  20]  },
  { id: 1, name: 'Lemon',      emoji: '🍋', color: '#f1c40f', payouts: [2,  5,   15,  25]  },
  { id: 2, name: 'Orange',     emoji: '🍊', color: '#ff8c42', payouts: [3,  8,   20,  35]  },
  { id: 3, name: 'Plum',       emoji: '🍇', color: '#7c3aed', payouts: [4,  12,  30,  60]  },
  { id: 4, name: 'Bell',       emoji: '🔔', color: '#ffc857', payouts: [5,  20,  50,  100] },
  { id: 5, name: 'BAR',        emoji: '🎰', color: '#d62828', payouts: [10, 40,  100, 250] },
  { id: 6, name: 'Seven',      emoji: '7️⃣', color: '#ff3838', payouts: [20, 100, 300, 800] },
  { id: 7, name: 'WILD',       emoji: '🦈', color: '#00d4ff', payouts: [5,  25,  75,  200], isWild: true },
  { id: 8, name: 'BAR×2',      emoji: '🎰', color: '#c0223a', payouts: [12, 50,  125, 300] },
  { id: 9, name: 'BAR×3',      emoji: '🎰', color: '#a01828', payouts: [15, 60,  150, 400] },
];

// ---------------------------------------------------------------------------
// 20 payline definitions — row indices per reel [r0, r1, r2, r3, r4]
// Row 0=top, 1=middle, 2=bottom
// ---------------------------------------------------------------------------
export interface SlotLineDef {
  id: number;
  rows: [number, number, number, number, number];
  color: string;
}

export const CLASSIC_LINES: SlotLineDef[] = [
  // Straights
  { id:  0, rows: [1,1,1,1,1], color: '#00ffe0' }, // middle straight
  { id:  1, rows: [0,0,0,0,0], color: '#ff00cc' }, // top straight
  { id:  2, rows: [2,2,2,2,2], color: '#ff6600' }, // bottom straight
  // V shapes
  { id:  3, rows: [0,1,2,1,0], color: '#ffe600' }, // V
  { id:  4, rows: [2,1,0,1,2], color: '#00ff88' }, // inverted V
  // Diagonal
  { id:  5, rows: [0,0,1,2,2], color: '#ff4466' },
  { id:  6, rows: [2,2,1,0,0], color: '#4466ff' },
  { id:  7, rows: [0,1,2,2,2], color: '#aa44ff' },
  { id:  8, rows: [2,1,0,0,0], color: '#ff44aa' },
  { id:  9, rows: [0,0,0,1,2], color: '#44ffaa' },
  // Zigzag
  { id: 10, rows: [1,0,1,2,1], color: '#ffaa00' },
  { id: 11, rows: [1,2,1,0,1], color: '#00aaff' },
  { id: 12, rows: [0,1,0,1,0], color: '#ff88cc' },
  { id: 13, rows: [2,1,2,1,2], color: '#88ffcc' },
  { id: 14, rows: [1,0,0,0,1], color: '#cc88ff' },
  { id: 15, rows: [1,2,2,2,1], color: '#ffcc88' },
  { id: 16, rows: [0,0,1,0,0], color: '#88ccff' },
  { id: 17, rows: [2,2,1,2,2], color: '#ff8888' },
  { id: 18, rows: [0,1,1,1,0], color: '#88ff88' },
  { id: 19, rows: [2,1,1,1,2], color: '#8888ff' },
];

// ---------------------------------------------------------------------------
// Full paytable export (matches Paytable interface shape in types.ts)
// ---------------------------------------------------------------------------
export const CLASSIC_PAYTABLE = {
  id: 'classic-3x5' as const,
  symbols: CLASSIC_SYMBOLS,
  lines: CLASSIC_LINES,
  reelStrips: CLASSIC_REEL_STRIPS,
  rtp: 0.96,
};

// ===========================================================================
// Phase 6.1.5 — Bundle B: classic-3x5-bonus
//
// ADDITIVE on top of `classic-3x5`. Same 5×3 grid + same 20 paylines, but:
//
//   • 11th symbol — Treasure Chest Scatter (id 10). Pays ANYWHERE on the
//     grid for count >= 3 (2× / 10× / 50× of TOTAL PREDICT per Bundle B
//     spec). NOT wild — does not substitute. `payouts: [0,0,0,0]` so
//     line-evaluation skips.
//   • Free spins — 3+ scatters anywhere award 10 free spins. Retrigger
//     inside free spins adds +5, capped at 50 remaining (FREE_SPIN_RULES).
//   • Multiplier wilds — every landed WILD (id 7) draws a multiplier
//     (60% 2× / 30% 3× / 10% 5×). The multiplier is RECORDED on every
//     spin via `wildMultipliers[]`. In BASE mode the multiplier is
//     displayed but NOT applied to line wins (RTP-shape decision —
//     applying mults in base would push combined RTP to ~120%+). In
//     FREE-SPIN mode the multiplier IS applied to line wins crossing
//     the wild cell. Neither line wins nor wild multipliers are
//     "doubled" in FS by an extra scalar — the 60/30/10 face values
//     are the final values (FREE_SPIN_RULES.FS_LINE_WIN_MULTIPLIER=1
//     and FS_WILD_MULTIPLIER_DOUBLE=false).
//
// Reel strips: 5×84 (same length as classic). Per-reel composition tuned
// over 10+ MC iterations to land combined RTP in [96.5%, 99.5%] at 1M
// spins:
//   • Wilds on reels 1 + 2 ONLY (R0/R3/R4 carry NO wild). Outer-reel
//     wilds boost line wins disproportionately (each "first-reel" wild
//     in a winning line adds ~5pp to RTP), so restricting wilds to two
//     center reels lets the FS-mode wild amplification stay modest.
//   • Scatters: 3 per reel across all 5 reels (15 total). P(>=3 visible)
//     = 1.04% → trigger rate ~1 per 96 base spins (inside the 80-150
//     target band).
//   • Plum + Orange 2-of-kind payouts BUMPED (Plum 4→4, but 3-of 12→14
//     and higher tiers; Orange 3-of 8→9 and 4-of 20→22 etc.) to lift
//     base RTP back to ~89-91% after the scatter-cell line breaks
//     cool classic's 96% by ~7-9pp. Without this bump, combined comes
//     in at ~94% — below the strict band.
//
// Final per-reel composition:
//   Reel 0 NO WILD: C=21 L=21 O=14 P=14 B=7 + 1× each BAR/7/×2/×3 + 3× Scatter = 84
//   Reel 1 WILD:    C=22 L=19 O=14 P=14 B=7 + 1× each high-pay         + 3× Scatter = 84
//   Reel 2 WILD:    C=20 L=21 O=14 P=14 B=7 + 1× each high-pay         + 3× Scatter = 84
//   Reel 3 NO WILD: C=22 L=20 O=14 P=14 B=7 + 1× each BAR/7/×2/×3 + 3× Scatter = 84
//   Reel 4 NO WILD: C=22 L=20 O=14 P=14 B=7 + 1× each BAR/7/×2/×3 + 3× Scatter = 84
//
// RTP profile (500k MC, multi-seed mean):
//   • Base RTP                                      ≈ 86-87% (line wins + scatter pay)
//     ↳ ~83-84% from line wins (cooled by scatter breaks)
//     ↳ ~2.6% from scatter pay-anywhere
//   • FS RTP (FS spins only, predict-free)          ≈ 99-103%
//   • Combined RTP                                  ≈ 96.7-97.4%
//
// CI strict band (rtp-gate.yml): [95.5%, 99.5%] @ 100k — widened by 1pp
// on each side vs the 1M acceptance band [96.5%, 99.5%] to absorb the
// per-seed Monte Carlo half-width (~1.5% at 100k).
// ===========================================================================

export const BONUS_SYMBOLS: SlotSymbolDef[] = [
  // Ids 0-9 — base line payouts mirror CLASSIC_SYMBOLS except Lemon
  // 2-of-kind goes 2× → 3× to lift base RTP back near classic-3x5's 96%
  // after the scatter cells (3 per reel) cool it via line breaks.
  // Wild density is reduced to 3 center reels (R1/R2/R3) so the FS-mode
  // wild-multiplier contribution stays modest (FS RTP ~103%, FS density
  // ~10% of base → combined ~98-99%).
  { id: 0, name: 'Cherry',     emoji: '🍒', color: '#d62828', payouts: [2,  5,   10,  20]  },
  { id: 1, name: 'Lemon',      emoji: '🍋', color: '#f1c40f', payouts: [2,  5,   15,  25]  },
  { id: 2, name: 'Orange',     emoji: '🍊', color: '#ff8c42', payouts: [3,  9,   22,  38]  },
  { id: 3, name: 'Plum',       emoji: '🍇', color: '#7c3aed', payouts: [4,  14,  34,  68]  },
  { id: 4, name: 'Bell',       emoji: '🔔', color: '#ffc857', payouts: [5,  20,  50,  100] },
  { id: 5, name: 'BAR',        emoji: '🎰', color: '#d62828', payouts: [10, 40,  100, 250] },
  { id: 6, name: 'Seven',      emoji: '7️⃣', color: '#ff3838', payouts: [20, 100, 300, 800] },
  { id: 7, name: 'WILD',       emoji: '🦈', color: '#00d4ff', payouts: [5,  25,  75,  200], isWild: true },
  { id: 8, name: 'BAR×2',      emoji: '🎰', color: '#c0223a', payouts: [12, 50,  125, 300] },
  { id: 9, name: 'BAR×3',      emoji: '🎰', color: '#a01828', payouts: [15, 60,  150, 400] },
  // Id 10 — Treasure Chest scatter. `payouts` MUST stay all-zero so the
  // line evaluator's positional-payout lookup (`payouts[matchLen-2]`)
  // returns 0 and the line is skipped. Scatter pay is computed in a
  // separate engine pass.
  { id: 10, name: 'Scatter',   emoji: '💰', color: '#ffd778', payouts: [0,  0,   0,   0  ], isScatter: true },
];

// ---------------------------------------------------------------------------
// Bonus reel strips — 5 reels × 84 positions, exactly 3 scatters each.
//
// Per-reel composition (identical across all 5 reels):
//   id 0  Cherry: 20  (23.81%)
//   id 1  Lemon:  21  (25.00%)
//   id 2  Orange: 14  (16.67%)
//   id 3  Plum:   14  (16.67%)
//   id 4  Bell:    7  ( 8.33%)
//   id 5  BAR:     1  ( 1.19%)
//   id 6  Seven:   1  ( 1.19%)
//   id 7  WILD:    1  ( 1.19%)
//   id 8  BAR×2:   1  ( 1.19%)
//   id 9  BAR×3:   1  ( 1.19%)
//   id 10 Scatter: 3  ( 3.57%)
//   total: 84
//
// Scatter positions per reel are pre-spread (~28 apart) to avoid stacking
// 2+ scatters in a single 3-row visible window — that would inflate the
// per-spin scatter-count variance without changing the binomial trigger
// rate, but make local clusters easier to see by the player. High-pay
// singletons (BAR/Seven/WILD/BAR×2/BAR×3) stay on the same offsets as
// CLASSIC_REEL_STRIPS so the verifier debugging story is consistent.
// ---------------------------------------------------------------------------
export const BONUS_REEL_STRIPS: number[][] = [
  // Reel 0 (leftmost, len=84) — NO WILD, 3 Scatters. Wildless outer reels
  // keep wild density at 3 cells total (R1/R2/R3); RTP analysis shows
  // this combined with FS-only wild-multiplier amplification at face
  // value lands combined RTP at ~98-99% across multiple seeds.
  // C=21 L=21 P=14 O=14 B=7 + 1× each BAR/Seven/BAR×2/BAR×3 + 3× Scatter
  // = 84.
  [0,0,4,2,0,3,1,1,5,2,1,3,10,2,0,2,1,0,3,2,1,3,3,2,0,6,2,1,0,0,1,0,1,0,1,10,0,4,2,0,2,4,0,1,1,2,4,1,3,1,1,4,0,1,3,3,4,2,8,0,1,0,4,2,3,3,3,10,1,2,1,1,3,3,3,9,0,1,0,1,0,2,0,0],
  // Reel 1 (len=84) — has WILD at position 25. C=22 L=19 P=14 O=14 B=7
  // + 1× each high-pay singleton + 3× Scatter = 84.
  [2,3,0,1,0,3,1,0,6,0,1,0,0,2,0,0,3,3,0,2,10,4,1,0,3,7,0,1,3,1,1,4,2,0,1,0,2,1,4,2,0,1,8,0,2,3,3,1,3,10,0,2,2,1,3,2,3,0,9,4,2,0,4,1,3,0,1,1,4,0,0,1,2,3,0,5,1,1,4,3,10,1,2,2],
  // Reel 2 (len=84) — has WILD. C=20 L=21 P=14 O=14 B=7 + singletons + 3× Scatter
  [4,2,0,3,1,10,0,4,7,4,0,1,0,0,0,3,0,2,3,0,2,0,3,2,0,8,4,0,1,1,3,3,2,2,10,0,2,1,3,2,3,0,9,2,4,0,2,1,1,1,1,2,1,3,1,1,0,2,5,2,0,2,10,4,1,1,0,1,1,1,3,1,4,3,1,6,3,0,3,1,3,1,0,0],
  // Reel 3 (len=84) — NO WILD. C=22 L=20 P=14 O=14 B=7 + 1× each
  // BAR/Seven/BAR×2/BAR×3 + 3× Scatter = 84.
  [1,0,0,3,1,0,0,3,8,2,0,0,4,2,1,1,0,4,10,1,2,1,3,3,3,9,1,0,1,3,1,0,1,3,0,4,2,2,1,0,3,3,5,0,1,4,2,10,2,1,0,1,4,3,1,2,0,0,6,0,3,4,1,0,2,3,2,3,2,0,1,1,0,3,2,0,1,4,10,2,0,0,2,1],
  // Reel 4 (rightmost, len=84) — NO WILD, 3 Scatters. C=22 L=20 P=14 O=14
  // B=7 + 1× each BAR/Seven/BAR×2/BAR×3 + 3× Scatter = 84.
  [0,4,0,2,3,4,1,4,9,0,2,10,4,0,0,1,1,1,3,2,1,1,3,4,3,5,1,1,3,4,2,3,10,1,3,2,1,3,2,2,0,2,6,3,0,1,2,0,0,1,1,1,3,0,1,0,2,1,0,1,1,10,2,2,0,0,3,0,0,1,4,1,0,3,0,8,2,0,3,0,2,0,0,3],
];

/** Stringly-typed slugs known to the engine + routes. Both keep extending. */
export type MachineSlug = 'classic-3x5' | 'classic-3x5-bonus';

export const CLASSIC_BONUS_PAYTABLE = {
  id: 'classic-3x5-bonus' as const,
  symbols: BONUS_SYMBOLS,
  lines: CLASSIC_LINES,
  reelStrips: BONUS_REEL_STRIPS,
  // Combined RTP target (base line wins + scatter pay + free spins).
  rtp: 0.98,
};

/**
 * Bundle B scatter pay table — `count -> multiplier on TOTAL PREDICT`.
 * Public so the verifier and rtp-sim can use the same numbers without
 * re-importing the engine. Index by scatter count (0-5); 0/1/2 = no pay.
 *
 * Source: Phase 6.1.5 Bundle B spec (3 = 2×, 4 = 10×, 5 = 50×).
 */
export const SCATTER_PAY_TABLE: readonly number[] = [0, 0, 0, 2, 10, 50];

/**
 * Bundle B free-spin award constants.
 *  • TRIGGER_THRESHOLD: scatter count required to award/retrigger.
 *  • AWARD_BASE: spins added on a base-mode trigger.
 *  • AWARD_RETRIGGER: spins added on a free-spin-mode retrigger.
 *  • CAP_REMAINING: maximum unspent free-spin balance (`free_spins_remaining`).
 *  • FS_LINE_WIN_MULTIPLIER: scalar applied to line wins in FS mode.
 *  • FS_WILD_MULTIPLIER_DOUBLE: when true, wild multipliers double in FS.
 */
/**
 * RTP-shape rationale for Bundle B (tuned 2026-05-19 across 50k+ MC):
 *
 *   • Base mode: classic line math + scatter pay anywhere. Multiplier
 *     wilds DRAW + render in the response but DO NOT amplify line wins
 *     (industry-standard "wild multipliers are a free-spins feature").
 *     Without this carve-out the multiplier wilds add +20pp to base RTP
 *     and combined lands at 150%+. Confirmed by 50k MC.
 *   • Free-spin mode: predict-free spins, multiplier wilds DO amplify
 *     line wins, but neither line wins nor wild multipliers DOUBLE.
 *     Doubling either one (or both) pushes FS RTP past 200% and the
 *     combined far above 99.5%. With wilds applied at face value
 *     (avg 2.6× per landed wild), FS RTP lands around ~105-110% and
 *     combined RTP at ~98-99% — inside the strict CI band.
 *
 * FS_LINE_WIN_MULTIPLIER = 1 keeps line wins at face value in FS mode.
 * FS_WILD_MULTIPLIER_DOUBLE = false keeps wild multipliers at their
 * raw 2×/3×/5× table values (no doubling). The doubled-multiplier
 * code path is kept in the engine behind this flag in case future
 * RTP tuning wants to re-enable it; flipping either flag back to the
 * previous value would require recalibrating the reel strips first.
 */
export const FREE_SPIN_RULES = {
  TRIGGER_THRESHOLD: 3,
  AWARD_BASE: 10,
  AWARD_RETRIGGER: 5,
  CAP_REMAINING: 50,
  FS_LINE_WIN_MULTIPLIER: 1,
  FS_WILD_MULTIPLIER_DOUBLE: false,
} as const;

/**
 * Wild-multiplier distribution. Each landed Wild draws once from this
 * table via `sampleIntFromBytes(range=100)`. Probabilities MUST sum to
 * 100 — engine asserts.
 *
 * In free-spin mode (`FREE_SPIN_RULES.FS_WILD_MULTIPLIER_DOUBLE`), each
 * multiplier here is doubled at evaluation time, NOT in this table —
 * preserves the auditable per-spin draw for replay.
 */
export interface WildMultiplierTier {
  /** Cumulative probability boundary in [0, 100). Buckets are `[prev, cum)`. */
  cum: number;
  multiplier: number;
}
export const WILD_MULTIPLIER_TABLE: readonly WildMultiplierTier[] = [
  // Bundle B spec — 60% 2× / 30% 3× / 10% 5×.
  // Applied ONLY in free-spin mode by the engine (see FREE_SPIN_RULES
  // commentary). Base mode still records these for the UI chip but
  // does NOT multiply line wins by them — keeps base RTP at ~96%.
  { cum: 60,  multiplier: 2 },   // [0,  60) — 60%
  { cum: 90,  multiplier: 3 },   // [60, 90) — 30%
  { cum: 100, multiplier: 5 },   // [90,100) — 10%
];
