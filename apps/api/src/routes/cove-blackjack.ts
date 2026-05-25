/**
 * Phase 6.4.0 — Cove blackjack DISPLAY-ONLY mock route.
 *
 * Mount: `app.route('/api/cove/blackjack', coveBlackjackRouter)` from index.ts.
 *
 * Surface:
 *   POST /play-mock-hand   — deterministic mock outcome for the visual shell
 *
 * Scope rules (per `.claude/plans/cove-blackjack.md` §4.0):
 *   - NO real engine, NO DB writes, NO `claw-token-ledger.transferClawTokens()`.
 *   - `payout` is a SIGNED DELTA the client applies to its local display
 *     bankroll (positive = win credit, zero = push, negative = loss debit).
 *     The real engine + ledger writes ship in Phase 6.4.1.
 *   - Outcome is deterministic per-bet: `betAmount % 4` selects one of
 *     {blackjack, win, push, loss}. Reproducible from the request alone so
 *     a screenshot test can rely on a fixed shape, and so flipping bet
 *     chips lets QA see every outcome state without reloading.
 *
 * Types: `BlackjackCard`, `BlackjackOutcome`, `PlayMockHandResponse` are
 * defined in `@clawville/shared` (`types/cove-blackjack.ts`) so the API
 * route, the web client, and the future Phase 6.4.2 connected-agent
 * SKILL.md all consume one shape.
 *
 * Auth: `sessionMiddleware` on all routes (mirrors cove-slots pattern) — blocks
 * unauthenticated hammering even though there are no ledger writes in 6.4.0.
 * The real deal/hit/stand endpoints in 6.4.1 will additionally require
 * `requireAuth` since they touch the ClawToken ledger.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  COVE_BLACKJACK_MAX_BET,
  COVE_BLACKJACK_MIN_BET,
  type BlackjackCard,
  type BlackjackOutcome,
  type PlayMockHandResponse,
} from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import type { AppContext } from '../types';

export const coveBlackjackRouter = new Hono<AppContext>();

// Mirrors cove-slots.ts:130 — sessionMiddleware on all routes so unauthenticated
// callers are blocked at the router boundary even in the display-shell phase.
coveBlackjackRouter.use('*', sessionMiddleware);

// ─── Schemas ──────────────────────────────────────────────────────────────

const playMockHandSchema = z
  .object({
    betAmount: z
      .number()
      .int()
      .min(COVE_BLACKJACK_MIN_BET)
      .max(COVE_BLACKJACK_MAX_BET),
  })
  .strict();

// ─── Deterministic mock data ──────────────────────────────────────────────
//
// Four canonical hands, one per outcome. Cards are stable across requests
// for a given outcome bucket, so a screenshot test always renders the same
// suits/ranks for the same `betAmount % 4`.

interface MockHand {
  outcome: BlackjackOutcome;
  outcomeLabel: string;
  playerHand: BlackjackCard[];
  dealerHand: BlackjackCard[];
  /**
   * Payout MULTIPLIER applied to the bet amount.
   *   blackjack →  1.5  (3:2 payout, floor()'d for house-friendly rounding)
   *   win       →  1.0  (even money)
   *   push      →  0.0
   *   loss      → -1.0  (full bet lost)
   */
  payoutMultiplier: number;
}

const MOCK_HANDS: readonly MockHand[] = [
  {
    outcome: 'blackjack',
    outcomeLabel: 'Blackjack! You win 3:2.',
    playerHand: [
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: 'K' },
    ],
    dealerHand: [
      { suit: 'diamonds', rank: '9' },
      { suit: 'clubs', rank: '7' },
    ],
    payoutMultiplier: 1.5,
  },
  {
    outcome: 'win',
    outcomeLabel: "You win! 19 beats dealer's 16.",
    playerHand: [
      { suit: 'hearts', rank: '10' },
      { suit: 'spades', rank: '9' },
    ],
    dealerHand: [
      { suit: 'clubs', rank: '10' },
      { suit: 'diamonds', rank: '6' },
    ],
    payoutMultiplier: 1,
  },
  {
    outcome: 'push',
    outcomeLabel: 'Push — both 18. Bet returned.',
    playerHand: [
      { suit: 'diamonds', rank: '10' },
      { suit: 'clubs', rank: '8' },
    ],
    dealerHand: [
      { suit: 'spades', rank: 'J' },
      { suit: 'hearts', rank: '8' },
    ],
    payoutMultiplier: 0,
  },
  {
    outcome: 'loss',
    outcomeLabel: 'Bust! 24 — dealer wins.',
    playerHand: [
      { suit: 'clubs', rank: '10' },
      { suit: 'hearts', rank: '5' },
      { suit: 'spades', rank: '9' }, // bust: 24
    ],
    dealerHand: [
      { suit: 'hearts', rank: '7' },
      { suit: 'diamonds', rank: '10' },
    ],
    payoutMultiplier: -1,
  },
] as const;

function pickMockHand(betAmount: number): MockHand {
  // Bet-seeded determinism: same betAmount → same outcome. Flipping bet
  // chips cycles all four outcomes so QA / screenshot tests can exercise
  // every modal state without needing to mock anything.
  const idx = betAmount % MOCK_HANDS.length;
  return MOCK_HANDS[idx]!;
}

function buildPayout(bet: number, multiplier: number): number {
  // House-friendly rounding: floor() the absolute magnitude, then re-apply
  // sign. A 3:2 blackjack on an odd bet rounds DOWN regardless of sign.
  const magnitude = Math.floor(Math.abs(bet * multiplier));
  return multiplier < 0 ? -magnitude : magnitude;
}

// ─── POST /play-mock-hand ─────────────────────────────────────────────────

coveBlackjackRouter.post('/play-mock-hand', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = playMockHandSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'invalid_input: ' + parsed.error.message,
    });
  }
  const { betAmount } = parsed.data;

  const hand = pickMockHand(betAmount);
  const payout = buildPayout(betAmount, hand.payoutMultiplier);

  const response: PlayMockHandResponse = {
    outcome: hand.outcome,
    payout,
    playerHand: hand.playerHand,
    dealerHand: hand.dealerHand,
    outcomeLabel: hand.outcomeLabel,
  };
  return c.json(response, 200);
});

export default coveBlackjackRouter;
