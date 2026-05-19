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
