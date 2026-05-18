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
 *   - 8 symbols (0-7): 7=Wild, no scatter in MVP
 *   - Target RTP: ~96%
 */

// ---------------------------------------------------------------------------
// Symbol IDs for classic-3x5
// ---------------------------------------------------------------------------
// 0 = Cherry    (common, low pay)
// 1 = Lemon     (common, low pay)
// 2 = Orange    (common, low pay)
// 3 = Plum      (medium, medium pay)
// 4 = Bell      (medium, medium pay)
// 5 = Bar       (rare, high pay)
// 6 = Seven     (very rare, mega pay)
// 7 = Wild      (replaces non-scatter; rare)

// ---------------------------------------------------------------------------
// Reel strips — 5 reels × 40 positions
// Higher-value symbols appear fewer times = lower probability
// These values drive both the mock engine and the real HMAC-derived engine.
// ---------------------------------------------------------------------------
export const CLASSIC_REEL_STRIPS: number[][] = [
  // Reel 0 (leftmost)
  [0,1,2,0,3,1,0,2,4,0,1,3,0,2,1,5,0,1,2,0,3,4,0,1,2,0,3,1,6,0,2,1,0,4,1,2,7,0,1,3],
  // Reel 1
  [0,2,1,3,0,1,2,0,4,1,0,3,2,0,1,2,5,0,1,3,0,2,1,0,4,3,0,1,2,0,6,1,0,3,2,1,7,0,2,4],
  // Reel 2 (center)
  [1,0,2,1,3,0,2,4,0,1,2,0,3,1,5,0,2,1,0,3,4,0,1,2,0,3,1,2,0,4,1,6,0,2,3,0,1,7,2,0],
  // Reel 3
  [0,1,2,3,0,1,4,0,2,1,0,3,2,1,0,2,5,0,1,3,0,4,1,2,0,3,1,0,2,4,0,1,6,2,0,3,1,7,0,2],
  // Reel 4 (rightmost)
  [2,0,1,0,3,2,0,1,4,0,2,1,3,0,1,2,0,5,1,0,3,2,0,4,1,0,3,2,1,0,4,1,6,0,2,1,0,3,7,1],
];

// ---------------------------------------------------------------------------
// Symbol definitions — ordered by id 0-7
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
  { id: 0, name: 'Cherry',  emoji: '🍒', color: '#c0392b', payouts: [2,  5,  10, 20]  },
  { id: 1, name: 'Lemon',   emoji: '🍋', color: '#f1c40f', payouts: [2,  5,  15, 25]  },
  { id: 2, name: 'Orange',  emoji: '🍊', color: '#e67e22', payouts: [3,  8,  20, 35]  },
  { id: 3, name: 'Plum',    emoji: '🍇', color: '#8e44ad', payouts: [4,  12, 30, 60]  },
  { id: 4, name: 'Bell',    emoji: '🔔', color: '#f39c12', payouts: [5,  20, 50, 100] },
  { id: 5, name: 'Bar',     emoji: '🎰', color: '#2c3e50', payouts: [10, 40, 100,250] },
  { id: 6, name: 'Seven',   emoji: '7️⃣', color: '#e74c3c', payouts: [20, 100,300,800] },
  { id: 7, name: 'Wild',    emoji: '⭐', color: '#00ffe0', payouts: [5,  25, 75, 200],  isWild: true },
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
