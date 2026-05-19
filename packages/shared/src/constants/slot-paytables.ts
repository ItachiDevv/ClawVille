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
// Reel strips — 5 reels × 80 positions
// Higher-value symbols appear fewer times = lower probability.
// These values drive both the mock engine and the real HMAC-derived engine.
//
// Length retuned UP from 40→80 (third-pass 2026-05-19) to land RTP in the
// [0.90, 1.02] band: the original 40-position strips delivered ~113% RTP
// (verified empirically); diluting low-pay symbol density at the same
// payout multipliers is the only knob available with payouts locked. Each
// reel keeps 1× each of BAR (5), Seven (6), WILD (7), BAR×2 (8), BAR×3 (9)
// — the new tiers are spaced ≥3 cells away from single BAR for visual
// readability on the 3-row visible window.
//
// Distribution per reel (approx): 14× Cherry, 14× Lemon, 14× Orange,
// 12× Plum, 8× Bell, 1× each of 5 high-pay singletons = ~80.
// ---------------------------------------------------------------------------
export const CLASSIC_REEL_STRIPS: number[][] = [
  // Reel 0 (leftmost): 14 Cherry, 14 Lemon, 14 Orange, 13 Plum, 8 Bell, 5 singletons = 68? rebuilt to 80
  [0,1,2,3,4,0,1,2,3,0,1,2,3,4,0,1,2,3,8,0,1,2,3,4,0,1,2,3,0,1,2,5,3,4,0,1,2,3,0,1,2,3,4,9,0,1,2,3,0,1,2,3,4,0,1,2,6,3,0,1,2,3,4,0,1,2,3,4,0,1,2,3,7,4,0,1,2,3,0,1],
  // Reel 1
  [1,0,2,3,4,1,0,2,3,1,0,2,8,3,4,1,0,2,3,1,0,2,3,4,1,0,2,5,3,1,0,2,3,4,1,0,2,3,9,1,0,2,3,4,1,0,2,3,1,0,2,3,4,6,1,0,2,3,1,0,2,3,4,1,0,2,3,4,1,0,2,3,7,4,1,0,2,3,1,0],
  // Reel 2 (center)
  [2,1,0,3,4,2,1,8,0,3,2,1,0,3,4,2,1,0,3,2,1,5,0,3,4,2,1,0,3,2,1,0,9,3,4,2,1,0,3,2,1,0,3,4,2,1,0,6,3,2,1,0,3,4,2,1,0,3,4,2,1,0,3,4,7,2,1,0,3,4,2,1,0,3,4,2,1,0,3,4],
  // Reel 3
  [3,0,1,2,4,3,0,1,2,3,8,0,1,2,4,3,0,1,2,3,0,1,5,2,4,3,0,1,2,3,0,1,2,9,4,3,0,1,2,3,0,1,2,4,3,0,1,6,2,3,0,1,2,4,3,0,1,2,4,3,0,1,2,4,3,0,7,1,2,4,3,0,1,2,4,3,0,1,2,4],
  // Reel 4 (rightmost)
  [4,1,0,2,3,4,8,1,0,2,3,4,1,0,2,3,4,1,0,5,2,3,4,1,0,2,3,4,1,0,2,9,3,4,1,0,2,3,4,1,0,2,3,4,6,1,0,2,3,4,1,0,2,3,4,1,0,2,3,4,1,0,7,2,3,4,1,0,2,3,4,1,0,2,3,4,1,0,2,3],
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
