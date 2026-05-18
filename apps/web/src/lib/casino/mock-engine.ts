/**
 * Mock Spin Engine — Phase 6.0 only
 *
 * Uses Math.random() for reel stop selection.
 * Phase 6.1 SWAP: replace this file with the real HMAC-derived engine.
 * The function signature, return type, and SpinResult shape are IDENTICAL
 * between this mock and the real slot-engine.ts — swap is purely implementation.
 *
 * Win distribution (approximate, governed by reel strip weights):
 *   Loss:       ~60%
 *   Small win:  ~25% (2–5× bet)
 *   Medium win: ~10% (5–50× bet)
 *   Big win:     ~4% (50–500× bet)
 *   Mega win:    ~1% (500×+ bet)
 *
 * These buckets are enforced via outcome forcing (the mock selects a target
 * outcome tier first, then picks reel stops that produce it). This lets
 * the designer preview all win tiers during development without relying on
 * statistical luck.
 */

import { CLASSIC_REEL_STRIPS, CLASSIC_LINES, CLASSIC_SYMBOLS } from '@clawville/shared';
import type { SpinResult, WinningLine } from './types';

// ---------------------------------------------------------------------------
// Module-scope cursor counter (per session in real engine; per page-load in mock)
// ---------------------------------------------------------------------------
let _mockCursor = 0;

// ---------------------------------------------------------------------------
// Spin parameters
// ---------------------------------------------------------------------------
export interface MockSpinParams {
  /** Bet size in ClawTokens (1-100) */
  bet: number;
  /** Which paytable to use (only 'classic-3x5' in MVP) */
  paytableId: 'classic-3x5';
  /** Optional client seed (ignored in mock; present for signature parity with real engine) */
  clientSeed?: string;
  /** Optional nonce (ignored in mock; present for signature parity with real engine) */
  nonce?: number;
}

// ---------------------------------------------------------------------------
// Outcome tier probabilities
// ---------------------------------------------------------------------------
type OutcomeTier = 'loss' | 'small' | 'medium' | 'big' | 'mega';

function pickOutcomeTier(): OutcomeTier {
  const r = Math.random();
  if (r < 0.60) return 'loss';
  if (r < 0.85) return 'small';   // 25%
  if (r < 0.95) return 'medium';  // 10%
  if (r < 0.99) return 'big';     // 4%
  return 'mega';                   // 1%
}

// ---------------------------------------------------------------------------
// Pick a random reel stop for each reel from the strip
// ---------------------------------------------------------------------------
function randomReelStops(): number[] {
  return CLASSIC_REEL_STRIPS.map(strip => Math.floor(Math.random() * strip.length));
}

// ---------------------------------------------------------------------------
// Extract 3-visible-row window from a reel strip at a given stop
// reels[r][row]: row 0=top, 1=middle, 2=bottom
// ---------------------------------------------------------------------------
function extractWindow(strip: number[], stop: number): number[] {
  const len = strip.length;
  return [
    strip[(stop + len - 1) % len], // top row (one before stop)
    strip[stop],                    // middle row (stop position)
    strip[(stop + 1) % len],        // bottom row (one after stop)
  ];
}

// ---------------------------------------------------------------------------
// Evaluate paylines against the visible window
// ---------------------------------------------------------------------------
function evaluateLines(
  window: number[][],  // window[reel][row]
  bet: number,
): WinningLine[] {
  const wins: WinningLine[] = [];

  for (const line of CLASSIC_LINES) {
    // Collect symbol on each reel for this payline
    const lineSymbols = line.rows.map((row, reel) => window[reel][row]);

    // Resolve wilds — find the first non-wild to determine match symbol
    const wildId = CLASSIC_SYMBOLS.findIndex(s => s.isWild);
    const firstNonWild = lineSymbols.find(s => s !== wildId) ?? lineSymbols[0];

    // Count consecutive left-to-right matches (wilds substitute)
    let matchCount = 0;
    for (const sym of lineSymbols) {
      if (sym === firstNonWild || sym === wildId) {
        matchCount++;
      } else {
        break;
      }
    }

    // Need at least 2 of a kind for a payout
    if (matchCount < 2) continue;

    const symDef = CLASSIC_SYMBOLS[firstNonWild];
    if (!symDef) continue;

    // payouts[0]=2-of-a-kind, payouts[1]=3-of-a-kind, etc.
    const multiplier = symDef.payouts[matchCount - 2] ?? 0;
    if (multiplier === 0) continue;

    const winAmount = BigInt(Math.round(bet * multiplier));

    wins.push({
      lineIndex: line.id,
      symbols: lineSymbols,
      winAmount,
      multiplier,
    });
  }

  return wins;
}

// ---------------------------------------------------------------------------
// Force reel stops toward a target outcome tier
// ---------------------------------------------------------------------------
function forceOutcome(tier: OutcomeTier, bet: number): number[][] {
  const REEL_COUNT = 5;
  const MAX_ATTEMPTS = 200;

  // For loss: just pick random stops and verify no wins
  if (tier === 'loss') {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const stops = randomReelStops();
      const window = CLASSIC_REEL_STRIPS.map((strip, r) => extractWindow(strip, stops[r]));
      const wins = evaluateLines(window, bet);
      if (wins.length === 0) return window;
    }
    // Fallback: just return a random window (rare edge-case)
    const stops = randomReelStops();
    return CLASSIC_REEL_STRIPS.map((strip, r) => extractWindow(strip, stops[r]));
  }

  // For win tiers: define multiplier ranges
  const tierRanges: Record<Exclude<OutcomeTier, 'loss'>, [number, number]> = {
    small:  [2,   5],
    medium: [5,   50],
    big:    [50,  500],
    mega:   [500, 99999],
  };
  const [minMult, maxMult] = tierRanges[tier as Exclude<OutcomeTier, 'loss'>];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const stops = randomReelStops();
    const window = CLASSIC_REEL_STRIPS.map((strip, r) => extractWindow(strip, stops[r]));
    const wins = evaluateLines(window, bet);
    if (wins.length > 0) {
      const totalMult = wins.reduce((sum, w) => sum + w.multiplier, 0);
      if (totalMult >= minMult && totalMult < maxMult) return window;
    }
  }

  // Fallback: if forced win not found in attempts, construct a guaranteed win
  // by forcing the middle payline to match 3-of-kind on a symbol with the
  // right payout range.
  return constructGuaranteedWin(tier, bet, REEL_COUNT);
}

/**
 * Construct a reel window that guarantees a win in the given tier.
 * Uses the middle payline (line 0: rows [1,1,1,1,1]) for simplicity.
 */
function constructGuaranteedWin(tier: OutcomeTier, bet: number, reelCount: number): number[][] {
  // Pick a symbol whose 3-of-kind payout fits the tier
  const tierMinMult: Record<OutcomeTier, number> = {
    loss: 0, small: 2, medium: 5, big: 50, mega: 500,
  };
  const targetMult = tierMinMult[tier];

  let chosenSymId = 0;
  for (const sym of CLASSIC_SYMBOLS) {
    if (sym.isWild) continue;
    if (sym.payouts[1] >= targetMult) { // 3-of-kind
      chosenSymId = sym.id;
      break;
    }
  }

  // Build a window: middle row (row 1) = chosen symbol on all 5 reels
  // top/bottom rows get random symbols
  return Array.from({ length: reelCount }, (_, r) => {
    const strip = CLASSIC_REEL_STRIPS[r];
    const topBot = Math.floor(Math.random() * CLASSIC_SYMBOLS.length - 1);
    return [topBot, chosenSymId, topBot]; // [top, mid, bottom]
  });
}

// ---------------------------------------------------------------------------
// Main mock spin function — Phase 6.0 entry point
// ---------------------------------------------------------------------------
export function mockSpin(params: MockSpinParams): SpinResult {
  const { bet } = params;
  const tier = pickOutcomeTier();
  const window = forceOutcome(tier, bet);

  const winningLines = evaluateLines(window, bet);
  const totalWin = winningLines.reduce((sum, w) => sum + w.winAmount, 0n);

  // Increment cursor (real engine: byte offset in HMAC stream)
  const cursorBefore = _mockCursor;
  _mockCursor += 1;

  return {
    reels: window,
    winningLines,
    winAmount: totalWin,
    freeSpinsAwarded: 0,
    isFreeSpin: false,
    cursorAfter: _mockCursor,
  };
}

/**
 * Reset the mock cursor — call at session open in 6.0.
 * Real engine: cursor is stored server-side per session.
 */
export function resetMockCursor(): void {
  _mockCursor = 0;
}
