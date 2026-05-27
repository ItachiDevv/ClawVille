/**
 * Phase 6.5.0 — Cove Texas Hold'em DISPLAY-ONLY mock route.
 *
 * Mount: `app.route('/api/cove/holdem', coveHoldemRouter)` from index.ts.
 *
 * Surface:
 *   POST /play-mock-hand   — deterministic mock outcome for the 6-seat shell
 *
 * Scope rules (per `.claude/plans/cove-texas-holdem.md` §4.0):
 *   - NO real engine (pokerpocket vendoring lands in Phase 6.5.1).
 *   - NO DB writes, NO `claw-token-ledger.transferClawTokens()`.
 *   - `potWon` is a SIGNED DELTA the client applies to its local display
 *     bankroll (positive when player wins, negative otherwise).
 *   - Outcome is deterministic per-(buyIn, time): `(buyIn * 31 + secs) % 6`
 *     selects winner index. The time term lets QA cycle through outcomes
 *     by clicking NEXT HAND without changing the buy-in chip.
 *
 * Types: `HoldemCard`, `HoldemWinner`, `PlayMockHoldemHandResponse` are
 * defined in `@clawville/shared` (`types/cove-holdem.ts`) so the API
 * route, the web client primitives (`PokerCard`, `SeatPosition`,
 * `CommunityCardRow`), and the future Phase 6.5.2 connected-agent
 * SKILL.md all consume one shape.
 *
 * Auth: `sessionMiddleware` (populator, NOT `requireAuth` — 6.5.0 mock
 * allows anon per brief, mirrors `cove-blackjack.ts`). Real deal/decide
 * endpoints in 6.5.1+ will additionally require `requireAuth` since they
 * touch the ClawToken ledger.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  COVE_HOLDEM_MAX_BUYIN,
  COVE_HOLDEM_MIN_BUYIN,
  type HoldemCard,
  type HoldemWinner,
  type PlayMockHoldemHandResponse,
} from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import type { AppContext } from '../types';

export const coveHoldemRouter = new Hono<AppContext>();

// Mirrors cove-blackjack.ts:47 — sessionMiddleware on all routes so the
// session is populated for logged-in callers. Anonymous play is allowed in
// the 6.5.0 visual shell since no ledger writes occur server-side.
coveHoldemRouter.use('*', sessionMiddleware);

// ─── Schemas ──────────────────────────────────────────────────────────────

const playMockHandSchema = z
  .object({
    buyIn: z
      .number()
      .int()
      .min(COVE_HOLDEM_MIN_BUYIN)
      .max(COVE_HOLDEM_MAX_BUYIN),
  })
  .strict();

// ─── Deterministic mock hands ─────────────────────────────────────────────
//
// Six canonical snapshots (one per winner index). Each snapshot contains
// player hole cards, 5 bot hole-card pairs, and the 5 community cards.
// Cards are stable for the same winner so a screenshot test sees identical
// suits/ranks per outcome bucket. No attempt is made to model real hand
// strength — Phase 6.5.0 is visual-shell-only; 6.5.1 plugs in the real
// pokerpocket evaluator.
//
// Within each snapshot all 17 cards (2 player + 10 bot + 5 community) are
// distinct, so the showdown view never duplicates a card visually. Across
// snapshots duplicates are fine — the client only renders one snapshot
// per hand. Long-form suit names (`'clubs'|'diamonds'|'hearts'|'spades'`)
// match the `HoldemSuit` shape consumed by `PokerCard`, `SeatPosition`,
// and `CommunityCardRow` (impl-card primitives).

interface MockSnapshot {
  winner: HoldemWinner;
  playerHand: HoldemCard[];
  botHands: HoldemCard[][];
  community: HoldemCard[];
}

const MOCK_SNAPSHOTS: readonly MockSnapshot[] = [
  {
    winner: 'player',
    playerHand: [
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: 'A' },
    ],
    botHands: [
      [{ suit: 'clubs', rank: '2' }, { suit: 'diamonds', rank: '7' }],
      [{ suit: 'hearts', rank: '9' }, { suit: 'spades', rank: '4' }],
      [{ suit: 'clubs', rank: 'J' }, { suit: 'diamonds', rank: '5' }],
      [{ suit: 'spades', rank: '8' }, { suit: 'hearts', rank: '3' }],
      [{ suit: 'diamonds', rank: '10' }, { suit: 'clubs', rank: '6' }],
    ],
    community: [
      { suit: 'diamonds', rank: 'A' },
      { suit: 'clubs', rank: 'K' },
      { suit: 'hearts', rank: '7' },
      { suit: 'spades', rank: '2' },
      { suit: 'diamonds', rank: '9' },
    ],
  },
  {
    winner: 'bot-1',
    playerHand: [
      { suit: 'clubs', rank: 'K' },
      { suit: 'hearts', rank: '4' },
    ],
    botHands: [
      [{ suit: 'diamonds', rank: 'K' }, { suit: 'spades', rank: 'K' }],
      [{ suit: 'hearts', rank: '6' }, { suit: 'clubs', rank: '9' }],
      [{ suit: 'spades', rank: 'J' }, { suit: 'diamonds', rank: '3' }],
      [{ suit: 'clubs', rank: '5' }, { suit: 'hearts', rank: '8' }],
      [{ suit: 'diamonds', rank: '7' }, { suit: 'spades', rank: '2' }],
    ],
    community: [
      { suit: 'hearts', rank: 'K' },
      { suit: 'clubs', rank: '10' },
      { suit: 'diamonds', rank: '4' },
      { suit: 'spades', rank: '6' },
      { suit: 'hearts', rank: 'J' },
    ],
  },
  {
    winner: 'bot-2',
    playerHand: [
      { suit: 'spades', rank: 'Q' },
      { suit: 'diamonds', rank: '8' },
    ],
    botHands: [
      [{ suit: 'clubs', rank: '3' }, { suit: 'hearts', rank: '5' }],
      [{ suit: 'spades', rank: 'A' }, { suit: 'diamonds', rank: 'A' }],
      [{ suit: 'hearts', rank: '10' }, { suit: 'clubs', rank: '7' }],
      [{ suit: 'diamonds', rank: 'J' }, { suit: 'spades', rank: '4' }],
      [{ suit: 'hearts', rank: '2' }, { suit: 'clubs', rank: '6' }],
    ],
    community: [
      { suit: 'clubs', rank: 'A' },
      { suit: 'hearts', rank: 'A' },
      { suit: 'spades', rank: '9' },
      { suit: 'diamonds', rank: '3' },
      { suit: 'hearts', rank: 'K' },
    ],
  },
  {
    winner: 'bot-3',
    playerHand: [
      { suit: 'hearts', rank: 'J' },
      { suit: 'clubs', rank: '2' },
    ],
    botHands: [
      [{ suit: 'spades', rank: '5' }, { suit: 'diamonds', rank: '7' }],
      [{ suit: 'hearts', rank: '3' }, { suit: 'clubs', rank: 'K' }],
      [{ suit: 'spades', rank: '10' }, { suit: 'diamonds', rank: '10' }],
      [{ suit: 'clubs', rank: '4' }, { suit: 'hearts', rank: '6' }],
      [{ suit: 'spades', rank: '9' }, { suit: 'diamonds', rank: '8' }],
    ],
    community: [
      { suit: 'hearts', rank: '10' },
      { suit: 'clubs', rank: '10' },
      { suit: 'diamonds', rank: '2' },
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: '4' },
    ],
  },
  {
    winner: 'bot-4',
    playerHand: [
      { suit: 'diamonds', rank: '9' },
      { suit: 'spades', rank: '3' },
    ],
    botHands: [
      [{ suit: 'clubs', rank: 'J' }, { suit: 'hearts', rank: '5' }],
      [{ suit: 'diamonds', rank: '4' }, { suit: 'spades', rank: '6' }],
      [{ suit: 'hearts', rank: '2' }, { suit: 'clubs', rank: '8' }],
      [{ suit: 'spades', rank: '7' }, { suit: 'diamonds', rank: 'K' }],
      [{ suit: 'hearts', rank: 'Q' }, { suit: 'clubs', rank: 'A' }],
    ],
    community: [
      { suit: 'diamonds', rank: '7' },
      { suit: 'hearts', rank: '7' },
      { suit: 'spades', rank: 'A' },
      { suit: 'clubs', rank: 'Q' },
      { suit: 'diamonds', rank: '2' },
    ],
  },
  {
    winner: 'bot-5',
    playerHand: [
      { suit: 'clubs', rank: '8' },
      { suit: 'hearts', rank: '8' },
    ],
    botHands: [
      [{ suit: 'diamonds', rank: '3' }, { suit: 'spades', rank: '5' }],
      [{ suit: 'clubs', rank: '6' }, { suit: 'hearts', rank: 'J' }],
      [{ suit: 'spades', rank: '2' }, { suit: 'diamonds', rank: '9' }],
      [{ suit: 'clubs', rank: 'K' }, { suit: 'hearts', rank: '4' }],
      [{ suit: 'diamonds', rank: 'Q' }, { suit: 'spades', rank: 'Q' }],
    ],
    community: [
      { suit: 'hearts', rank: 'Q' },
      { suit: 'clubs', rank: 'Q' },
      { suit: 'diamonds', rank: '10' },
      { suit: 'spades', rank: '7' },
      { suit: 'hearts', rank: '3' },
    ],
  },
] as const;

function pickMockSnapshot(buyIn: number): MockSnapshot {
  // Plan §4.0 sketch: `seed = (buyIn * 31 + Date.now()) % 6`. We divide by
  // 1000 so two clicks within the same second don't both produce the same
  // outcome only when the buy-in is identical — gives a 1Hz reroll cadence
  // perfect for NEXT HAND clicks at QA speed.
  const seed =
    (buyIn * 31 + Math.floor(Date.now() / 1000)) % MOCK_SNAPSHOTS.length;
  return MOCK_SNAPSHOTS[seed]!;
}

// ─── POST /play-mock-hand ─────────────────────────────────────────────────

coveHoldemRouter.post('/play-mock-hand', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = playMockHandSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'invalid_input: ' + parsed.error.message,
    });
  }
  const { buyIn } = parsed.data;

  const snap = pickMockSnapshot(buyIn);
  // Display-only pot delta: player wins or loses their buy-in. Phase 6.5.1
  // will replace this with the real engine's per-side-pot settlement output.
  const potWon = snap.winner === 'player' ? buyIn : -buyIn;

  const response: PlayMockHoldemHandResponse = {
    winner: snap.winner,
    potWon,
    playerHand: snap.playerHand,
    botHands: snap.botHands,
    community: snap.community,
  };
  return c.json(response, 200);
});

export default coveHoldemRouter;
