/**
 * Phase 6.6.1 — baccarat-engine unit tests.
 * Deterministic: same (serverSeed, clientSeed, nonce, cursor) ⇒ identical
 * cards + outcome. No DB, no network. Mirrors blackjack-engine.test.ts style.
 */

import { describe, expect, it } from 'bun:test';
import {
  buildShoe,
  cardValue,
  handTotal,
  bankerDraws,
  settleBet,
  playCoup,
  replayCoup,
  playCoupWithState,
  replayShoeUpToCoup,
  serializeCoupResult,
  SHOE_DECKS,
  CARDS_PER_SHOE,
  RESHUFFLE_CARD_THRESHOLD,
  BANKER_COMMISSION_PERCENT,
  TIE_PAYOUT_NUM,
  BACCARAT_ENGINE_VERSION,
  RANKS,
  SUITS,
  type Card,
  type Rank,
  type CoupWinner,
  type PlayCoupArgs,
} from '../baccarat-engine';

const SERVER = 'a'.repeat(64);
const CLIENT = 'deadbeef';

function card(rank: Rank, suit: Card['suit'] = 'clubs'): Card {
  return { rank, suit };
}

// ───────────────────────── Shoe integrity ─────────────────────────

describe('baccarat-engine — shoe integrity', () => {
  it('8-deck shoe has 416 cards', () => {
    const shoe = buildShoe();
    expect(SHOE_DECKS).toBe(8);
    expect(CARDS_PER_SHOE).toBe(416);
    expect(shoe.length).toBe(416);
  });

  it('shoe holds exactly 8 of each (suit, rank)', () => {
    const shoe = buildShoe();
    const counts = new Map<string, number>();
    for (const c of shoe) {
      const k = `${c.suit}:${c.rank}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.size).toBe(52); // 4 suits × 13 ranks
    for (const v of counts.values()) expect(v).toBe(8);
  });

  it('shoe holds exactly 8 of each rank (32 total per rank: 8 decks × 4 suits)', () => {
    const shoe = buildShoe();
    const byRank = new Map<Rank, number>();
    for (const c of shoe) byRank.set(c.rank, (byRank.get(c.rank) ?? 0) + 1);
    for (const r of RANKS) expect(byRank.get(r)).toBe(SHOE_DECKS * 4); // 32
  });

  it('reshuffle threshold is 75% of 416 = 312', () => {
    expect(RESHUFFLE_CARD_THRESHOLD).toBe(312);
  });

  it('canonical order is deck-major → suit-major → rank-major', () => {
    const shoe = buildShoe();
    // First 13 cards are deck 0, clubs, ranks 2..A.
    for (let i = 0; i < RANKS.length; i++) {
      expect(shoe[i]).toEqual({ suit: 'clubs', rank: RANKS[i]! });
    }
    // Card 13 starts the next suit (diamonds, rank 2).
    expect(shoe[RANKS.length]).toEqual({ suit: SUITS[1]!, rank: RANKS[0]! });
  });
});

// ───────────────────────── Card value mapping ─────────────────────────

describe('baccarat-engine — card values', () => {
  it('A = 1', () => {
    expect(cardValue('A')).toBe(1);
  });
  it('2..9 = face value', () => {
    expect(cardValue('2')).toBe(2);
    expect(cardValue('5')).toBe(5);
    expect(cardValue('9')).toBe(9);
  });
  it('10/J/Q/K = 0', () => {
    expect(cardValue('10')).toBe(0);
    expect(cardValue('J')).toBe(0);
    expect(cardValue('Q')).toBe(0);
    expect(cardValue('K')).toBe(0);
  });
});

// ───────────────────────── Mod-10 hand totals ─────────────────────────

describe('baccarat-engine — handTotal (mod 10)', () => {
  it('7 + 8 = 15 → 5', () => {
    expect(handTotal([card('7'), card('8')])).toBe(5);
  });
  it('9 + 9 = 18 → 8', () => {
    expect(handTotal([card('9'), card('9')])).toBe(8);
  });
  it('K + Q = 0 + 0 = 0', () => {
    expect(handTotal([card('K'), card('Q')])).toBe(0);
  });
  it('A + 10 + 9 = 1 + 0 + 9 = 10 → 0', () => {
    expect(handTotal([card('A'), card('10'), card('9')])).toBe(0);
  });
  it('5 + 6 + 7 = 18 → 8', () => {
    expect(handTotal([card('5'), card('6'), card('7')])).toBe(8);
  });
});

// ───────────────────────── Banker tableau (every cell) ─────────────────────────

describe('baccarat-engine — bankerDraws tableau', () => {
  it('banker 7 always stands (player drew or not)', () => {
    for (let p = 0; p <= 9; p++) expect(bankerDraws(7, p)).toBe(false);
    expect(bankerDraws(7, null)).toBe(false);
  });

  describe('player did NOT draw → banker draws on 0-5, stands on 6-7', () => {
    for (let b = 0; b <= 5; b++) {
      it(`banker ${b} draws`, () => expect(bankerDraws(b, null)).toBe(true));
    }
    for (const b of [6, 7]) {
      it(`banker ${b} stands`, () => expect(bankerDraws(b, null)).toBe(false));
    }
  });

  describe('player DID draw → standard banker tableau', () => {
    it('banker 0-2 always draws (every player 3rd card 0-9)', () => {
      for (const b of [0, 1, 2]) {
        for (let p = 0; p <= 9; p++) {
          expect(bankerDraws(b, p)).toBe(true);
        }
      }
    });

    it('banker 3 draws unless player 3rd is 8', () => {
      for (let p = 0; p <= 9; p++) {
        expect(bankerDraws(3, p)).toBe(p !== 8);
      }
    });

    it('banker 4 draws if player 3rd in 2-7', () => {
      for (let p = 0; p <= 9; p++) {
        expect(bankerDraws(4, p)).toBe(p >= 2 && p <= 7);
      }
    });

    it('banker 5 draws if player 3rd in 4-7', () => {
      for (let p = 0; p <= 9; p++) {
        expect(bankerDraws(5, p)).toBe(p >= 4 && p <= 7);
      }
    });

    it('banker 6 draws if player 3rd in 6-7', () => {
      for (let p = 0; p <= 9; p++) {
        expect(bankerDraws(6, p)).toBe(p >= 6 && p <= 7);
      }
    });
  });

  // Exhaustive cross-check against an independently written reference table.
  it('matches an independent reference for every (bankerTotal 0-6, player 3rd 0-9)', () => {
    // reference[bankerTotal] = set of player-3rd values on which banker DRAWS.
    const refDraw: Record<number, (p: number) => boolean> = {
      0: () => true,
      1: () => true,
      2: () => true,
      3: (p) => p !== 8,
      4: (p) => p >= 2 && p <= 7,
      5: (p) => p >= 4 && p <= 7,
      6: (p) => p >= 6 && p <= 7,
    };
    for (let b = 0; b <= 6; b++) {
      for (let p = 0; p <= 9; p++) {
        expect(bankerDraws(b, p)).toBe(refDraw[b]!(p));
      }
    }
  });
});

// ───────────────────────── Payout / commission math ─────────────────────────

describe('baccarat-engine — settleBet payouts', () => {
  it('PLAYER bet, player wins → 1:1 (gross = stake*2)', () => {
    expect(settleBet('player', 100n, 'player')).toEqual({ payout: 200n, commission: 0n });
  });
  it('PLAYER bet, banker wins → loss (gross 0)', () => {
    expect(settleBet('player', 100n, 'banker')).toEqual({ payout: 0n, commission: 0n });
  });
  it('PLAYER bet, tie → PUSH (gross = stake)', () => {
    expect(settleBet('player', 100n, 'tie')).toEqual({ payout: 100n, commission: 0n });
  });

  it('BANKER bet, banker wins → 0.95:1 with floored 5% commission', () => {
    // stake 100: commission = floor(100*5/100) = 5; winnings = 95; gross = 195.
    expect(settleBet('banker', 100n, 'banker')).toEqual({ payout: 195n, commission: 5n });
  });
  it('BANKER bet, banker wins → commission FLOORS for non-multiple-of-20 stakes', () => {
    // stake 5: floor(5*5/100) = floor(0.25) = 0; winnings = 5; gross = 10.
    expect(settleBet('banker', 5n, 'banker')).toEqual({ payout: 10n, commission: 0n });
    // stake 7: floor(35/100) = 0; gross = 14.
    expect(settleBet('banker', 7n, 'banker')).toEqual({ payout: 14n, commission: 0n });
    // stake 19: floor(95/100) = 0; gross = 38.
    expect(settleBet('banker', 19n, 'banker')).toEqual({ payout: 38n, commission: 0n });
    // stake 20: floor(100/100) = 1; winnings = 19; gross = 39.
    expect(settleBet('banker', 20n, 'banker')).toEqual({ payout: 39n, commission: 1n });
    // stake 41: floor(205/100) = 2; winnings = 39; gross = 80.
    expect(settleBet('banker', 41n, 'banker')).toEqual({ payout: 80n, commission: 2n });
    // stake 500: floor(2500/100) = 25; winnings = 475; gross = 975.
    expect(settleBet('banker', 500n, 'banker')).toEqual({ payout: 975n, commission: 25n });
  });
  it('BANKER bet, player wins → loss (gross 0)', () => {
    expect(settleBet('banker', 100n, 'player')).toEqual({ payout: 0n, commission: 0n });
  });
  it('BANKER bet, tie → PUSH (gross = stake)', () => {
    expect(settleBet('banker', 100n, 'tie')).toEqual({ payout: 100n, commission: 0n });
  });

  it('TIE bet, tie → 8:1 (gross = stake*9)', () => {
    expect(settleBet('tie', 100n, 'tie')).toEqual({ payout: 900n, commission: 0n });
    expect(TIE_PAYOUT_NUM).toBe(8n);
  });
  it('TIE bet, player wins → loss', () => {
    expect(settleBet('tie', 100n, 'player')).toEqual({ payout: 0n, commission: 0n });
  });
  it('TIE bet, banker wins → loss', () => {
    expect(settleBet('tie', 100n, 'banker')).toEqual({ payout: 0n, commission: 0n });
  });

  it('commission percent constant is 5', () => {
    expect(BANKER_COMMISSION_PERCENT).toBe(5n);
  });
});

// ───────────────────────── Determinism + replay ─────────────────────────

function baseArgs(over: Partial<PlayCoupArgs> = {}): PlayCoupArgs {
  return {
    serverSeed: SERVER,
    clientSeed: CLIENT,
    nonce: 0,
    cursor: 0,
    bet: 'player',
    stake: 100n,
    ...over,
  };
}

describe('baccarat-engine — determinism', () => {
  it('same inputs ⇒ byte-identical CoupResult', () => {
    const a = playCoup(baseArgs());
    const b = playCoup(baseArgs());
    expect(JSON.stringify(a, bigintReplacer)).toBe(JSON.stringify(b, bigintReplacer));
  });

  it('replayCoup === playCoup', () => {
    const live = playCoup(baseArgs({ nonce: 3 }));
    const replay = replayCoup(baseArgs({ nonce: 3 }));
    expect(JSON.stringify(live, bigintReplacer)).toBe(JSON.stringify(replay, bigintReplacer));
  });

  it('different nonces yield (generally) different first cards', () => {
    const a = playCoup(baseArgs({ nonce: 0 }));
    const b = playCoup(baseArgs({ nonce: 1 }));
    // Not a hard guarantee for ALL seeds, but extremely likely for distinct nonces.
    const aKey = a.player.cards[0]!.suit + a.player.cards[0]!.rank + a.banker.cards[0]!.rank;
    const bKey = b.player.cards[0]!.suit + b.player.cards[0]!.rank + b.banker.cards[0]!.rank;
    expect(aKey === bKey && a.winner === b.winner).toBe(false);
  });

  it('deals at least 4 and at most 6 cards', () => {
    for (let n = 0; n < 50; n++) {
      const r = playCoup(baseArgs({ nonce: n }));
      const total = r.player.cards.length + r.banker.cards.length;
      expect(total).toBeGreaterThanOrEqual(4);
      expect(total).toBeLessThanOrEqual(6);
      // Each side has 2 or 3 cards.
      expect([2, 3]).toContain(r.player.cards.length);
      expect([2, 3]).toContain(r.banker.cards.length);
    }
  });

  it('on a natural (8/9 two-card) NEITHER side draws a third card', () => {
    let testedNatural = false;
    for (let n = 0; n < 400; n++) {
      const r = playCoup(baseArgs({ nonce: n }));
      const pNat = r.player.cards.length === 2 && (r.player.total === 8 || r.player.total === 9);
      const bNat = r.banker.cards.length === 2 && (r.banker.total === 8 || r.banker.total === 9);
      if (pNat || bNat) {
        testedNatural = true;
        // No third cards anywhere when a natural was present at deal time.
        // (We re-derive natural from the FIRST two cards.)
        const pFirst2 = handTotal(r.player.cards.slice(0, 2));
        const bFirst2 = handTotal(r.banker.cards.slice(0, 2));
        if (pFirst2 === 8 || pFirst2 === 9 || bFirst2 === 8 || bFirst2 === 9) {
          expect(r.player.cards.length).toBe(2);
          expect(r.banker.cards.length).toBe(2);
        }
      }
    }
    expect(testedNatural).toBe(true);
  });

  it('player stands on 6-7 (two-card, no natural on either side)', () => {
    let tested = false;
    for (let n = 0; n < 600; n++) {
      const r = playCoup(baseArgs({ nonce: n }));
      const pFirst2 = handTotal(r.player.cards.slice(0, 2));
      const bFirst2 = handTotal(r.banker.cards.slice(0, 2));
      const anyNatural = [pFirst2, bFirst2].some((t) => t === 8 || t === 9);
      if (!anyNatural && (pFirst2 === 6 || pFirst2 === 7)) {
        tested = true;
        // Player stood — exactly 2 cards.
        expect(r.player.cards.length).toBe(2);
      }
    }
    expect(tested).toBe(true);
  });

  it('winner matches the higher total; equal totals = tie', () => {
    for (let n = 0; n < 100; n++) {
      const r = playCoup(baseArgs({ nonce: n }));
      let expected: CoupWinner;
      if (r.player.total > r.banker.total) expected = 'player';
      else if (r.banker.total > r.player.total) expected = 'banker';
      else expected = 'tie';
      expect(r.winner).toBe(expected);
    }
  });
});

// ───────────────────────── Shared-shoe threading ─────────────────────────

describe('baccarat-engine — shared shoe threading', () => {
  it('playCoupWithState threads remaining/cursor/dealt across coups', () => {
    let remaining: Card[] | undefined = undefined;
    let cursor = 0;
    let dealt = 0;
    for (let n = 0; n < 5; n++) {
      const stepped = playCoupWithState({
        serverSeed: SERVER,
        clientSeed: CLIENT,
        nonce: n,
        cursor,
        bet: 'banker',
        stake: 100n,
        dealtBefore: dealt,
        remainingShoe: dealt === 0 ? undefined : remaining,
      });
      // cursor monotonic; dealt grows by the cards used this coup.
      expect(stepped.cursorAfter).toBeGreaterThan(cursor);
      expect(stepped.dealtAfter).toBeGreaterThan(dealt);
      expect(stepped.remainingAfter.length).toBe(CARDS_PER_SHOE - stepped.dealtAfter);
      remaining = stepped.remainingAfter;
      cursor = stepped.cursorAfter;
      dealt = stepped.dealtAfter;
    }
  });

  it('replayShoeUpToCoup reproduces the threaded result for nonce > 0', () => {
    const coups: Array<{ bet: 'player' | 'banker' | 'tie'; stake: bigint }> = [
      { bet: 'player', stake: 50n },
      { bet: 'banker', stake: 100n },
      { bet: 'tie', stake: 25n },
      { bet: 'banker', stake: 200n },
    ];

    // Live threading via playCoupWithState.
    let remaining: Card[] | undefined = undefined;
    let cursor = 0;
    let dealt = 0;
    let liveTarget = null as ReturnType<typeof playCoupWithState>['result'] | null;
    for (let n = 0; n < coups.length; n++) {
      const stepped = playCoupWithState({
        serverSeed: SERVER,
        clientSeed: CLIENT,
        nonce: n,
        cursor,
        bet: coups[n]!.bet,
        stake: coups[n]!.stake,
        dealtBefore: dealt,
        remainingShoe: dealt === 0 ? undefined : remaining,
      });
      remaining = stepped.remainingAfter;
      cursor = stepped.cursorAfter;
      dealt = stepped.dealtAfter;
      if (n === coups.length - 1) liveTarget = stepped.result;
    }

    const replayed = replayShoeUpToCoup({
      serverSeed: SERVER,
      clientSeed: CLIENT,
      targetNonce: coups.length - 1,
      coups,
    });

    expect(JSON.stringify(replayed, bigintReplacer)).toBe(
      JSON.stringify(liveTarget, bigintReplacer),
    );
  });

  it('replayShoeUpToCoup throws on a wrong coups-length', () => {
    expect(() =>
      replayShoeUpToCoup({
        serverSeed: SERVER,
        clientSeed: CLIENT,
        targetNonce: 2,
        coups: [{ bet: 'player', stake: 10n }],
      }),
    ).toThrow();
  });
});

// ───────────────────────── Validation ─────────────────────────

describe('baccarat-engine — validation', () => {
  it('rejects non-positive stake', () => {
    expect(() => playCoup(baseArgs({ stake: 0n }))).toThrow();
    expect(() => playCoup(baseArgs({ stake: -5n }))).toThrow();
  });
  it('rejects an illegal bet', () => {
    // @ts-expect-error — exercising the runtime guard.
    expect(() => playCoup(baseArgs({ bet: 'side' }))).toThrow();
  });
  it('rejects a negative nonce / cursor', () => {
    expect(() => playCoup(baseArgs({ nonce: -1 }))).toThrow();
    expect(() => playCoup(baseArgs({ cursor: -1 }))).toThrow();
  });
  it('rejects a remainingShoe of the wrong length', () => {
    expect(() =>
      playCoup(baseArgs({ nonce: 1, dealtBefore: 4, remainingShoe: buildShoe().slice(0, 10) })),
    ).toThrow();
  });
  it('requires remainingShoe when dealtBefore > 0', () => {
    expect(() => playCoup(baseArgs({ nonce: 1, dealtBefore: 4 }))).toThrow();
  });
});

// ───────────────────────── Serialization ─────────────────────────

describe('baccarat-engine — serializeCoupResult', () => {
  it('stringifies bigints + pins the engine version + kind discriminator', () => {
    const r = playCoup(baseArgs({ nonce: 7, bet: 'banker', stake: 100n }));
    const s = serializeCoupResult(r, { cursorBefore: 0, dealtBefore: 0, nonce: 7 });
    expect(s.kind).toBe('baccarat');
    expect(s.engineVersion).toBe(BACCARAT_ENGINE_VERSION);
    expect(typeof s.stake).toBe('string');
    expect(typeof s.payout).toBe('string');
    expect(typeof s.net).toBe('string');
    expect(typeof s.commission).toBe('string');
    expect(s.stake).toBe('100');
    expect(s.nonce).toBe(7);
    expect(s.cursorAfter).toBe(r.cursorAfter);
    expect(s.dealtAfter).toBe(r.dealtAfter);
    // net = payout - stake.
    expect(BigInt(s.net)).toBe(BigInt(s.payout) - BigInt(s.stake));
  });
});

// ───────────────────────── helpers ─────────────────────────

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}
