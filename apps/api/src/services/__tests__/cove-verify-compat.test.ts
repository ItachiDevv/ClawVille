/**
 * Regression tests for the cove /verify back-compat equality helpers
 * (economy fix 2026-05-29, fixer pass).
 *
 * These guard the BLOCKING finding: the /verify deep-equal must NOT report a
 * fair, correctly-settled PRE-FIX historical row as `verified:false` just
 * because the live serializers now emit rake fields (blackjack/hold'em) or
 * different banker-win monetary values (baccarat).
 *
 * Pure — no DB, no network. The "expected" side is the LIVE engine
 * serialization (what /verify replays); the "stored" side is a hand-rolled
 * payload simulating what each engine wrote BEFORE the fix.
 */

import { describe, expect, it } from 'bun:test';
import {
  blackjackOutcomesMatch,
  holdemOutcomesMatch,
  baccaratOutcomesMatch,
} from '../cove-verify-compat';
import {
  playHand as playBlackjack,
  serializeHandResult,
  type HandScript,
} from '../blackjack-engine';
import {
  playHand as playHoldem,
  serializeHoldemHand,
  type HoldemActionRecord,
} from '../holdem-engine';
import {
  replayShoeUpToCoup,
  serializeCoupResult,
  type BaccaratBet,
} from '../baccarat-engine';

const SERVER = 'a'.repeat(64);
const CLIENT = 'deadbeef';

/** A hex-only client seed varied by `i` (provable-rng requires hex client seeds). */
function hexClient(i: number): string {
  return CLIENT + i.toString(16).padStart(4, '0');
}

type Json = Record<string, unknown>;

/** Deep clone via JSON (the payloads are plain JSON-serializable objects). */
function clone(o: Json): Json {
  return JSON.parse(JSON.stringify(o)) as Json;
}

/** Strip listed keys from a clone (simulate a pre-fix stored row). */
function withoutKeys(o: Json, keys: string[]): Json {
  const c = clone(o);
  for (const k of keys) delete c[k];
  return c;
}

// ───────────────────────── Blackjack ─────────────────────────

describe('blackjackOutcomesMatch — new-rake-field back-compat', () => {
  // Find a blackjack hand 0 that is a NET WIN (so the rake fields differ from
  // the gross fields) by scanning client seeds — deterministic.
  function netWinSerialized(): Json {
    const script: HandScript = { hands: [['stand']], didSplit: false, tookInsurance: false };
    for (let i = 0; i < 200; i++) {
      const client = hexClient(i);
      const r = playBlackjack({
        serverSeed: SERVER,
        clientSeed: client,
        nonce: 0,
        cursor: 0,
        bet: 100n,
        script,
      });
      if (r.totalPayout > r.totalBet) {
        return serializeHandResult(r, { cursorBefore: 0, dealtBefore: 0, nonce: 0 }) as unknown as Json;
      }
    }
    throw new Error('no net-win blackjack hand found in scan');
  }

  it('a PRE-RAKE stored net-win row (no rake keys) verifies TRUE', () => {
    const expected = netWinSerialized();
    // sanity — the replay carries rake fields and an actual rake on a net win.
    expect(expected.rake).toBeDefined();
    expect(BigInt(expected.rake as string)).toBeGreaterThan(0n);
    const storedPreFix = withoutKeys(expected, ['rake', 'rakedPayout', 'rakedNet']);
    expect(blackjackOutcomesMatch(expected, storedPreFix)).toBe(true);
  });

  it('a POST-FIX stored row (all keys, identical) verifies TRUE strictly', () => {
    const expected = netWinSerialized();
    expect(blackjackOutcomesMatch(expected, clone(expected))).toBe(true);
  });

  it('a POST-FIX row with a WRONG rake value verifies FALSE', () => {
    const expected = netWinSerialized();
    const tampered = clone(expected);
    tampered.rake = (BigInt(expected.rake as string) + 1n).toString();
    expect(blackjackOutcomesMatch(expected, tampered)).toBe(false);
  });

  it('a tampered GROSS field (totalPayout) verifies FALSE even on a pre-fix row', () => {
    const expected = netWinSerialized();
    const storedPreFix = withoutKeys(expected, ['rake', 'rakedPayout', 'rakedNet']);
    storedPreFix.totalPayout = (BigInt(expected.totalPayout as string) + 1n).toString();
    expect(blackjackOutcomesMatch(expected, storedPreFix)).toBe(false);
  });

  it('cursorBefore/dealtBefore differences are ignored (persisted-only metadata)', () => {
    const expected = netWinSerialized();
    const stored = clone(expected);
    stored.cursorBefore = 999;
    stored.dealtBefore = 7;
    expect(blackjackOutcomesMatch(expected, stored)).toBe(true);
  });
});

// ───────────────────────── Hold'em ─────────────────────────

describe('holdemOutcomesMatch — new-rake-field back-compat', () => {
  // A fold-preflop hand (rake almost certainly 0) and a played hand both must
  // verify true when the stored row predates the rake fields.
  function serializedHand(actions: HoldemActionRecord[]): Json {
    const r = playHoldem({
      serverSeed: SERVER,
      clientSeed: CLIENT,
      nonce: 0,
      buttonSeat: 0,
      humanStartingStack: 100n,
      botStartingStack: 100n,
      humanActions: actions,
    });
    return serializeHoldemHand(r) as unknown as Json;
  }

  it('a PRE-RAKE stored fold row (no rake keys) verifies TRUE', () => {
    const expected = serializedHand([{ type: 'fold' }]);
    const storedPreFix = withoutKeys(expected, ['rake', 'humanRakedPayout', 'humanRakedNet']);
    expect(holdemOutcomesMatch(expected, storedPreFix)).toBe(true);
  });

  it('a PRE-RAKE stored row with a NON-ZERO rake (played hand) verifies TRUE', () => {
    // Call down to showdown so the pot is large enough to incur a rake.
    const expected = serializedHand([
      { type: 'call' },
      { type: 'check' },
      { type: 'check' },
      { type: 'check' },
    ]);
    const storedPreFix = withoutKeys(expected, ['rake', 'humanRakedPayout', 'humanRakedNet']);
    expect(holdemOutcomesMatch(expected, storedPreFix)).toBe(true);
  });

  it('a POST-FIX stored row (all keys, identical) verifies TRUE strictly', () => {
    const expected = serializedHand([{ type: 'fold' }]);
    expect(holdemOutcomesMatch(expected, clone(expected))).toBe(true);
  });

  it('a POST-FIX row with a WRONG rake value verifies FALSE', () => {
    const expected = serializedHand([{ type: 'fold' }]);
    const tampered = clone(expected);
    tampered.rake = (BigInt(expected.rake as string) + 1n).toString();
    expect(holdemOutcomesMatch(expected, tampered)).toBe(false);
  });

  it('a tampered GROSS field (humanPayout) verifies FALSE even on a pre-fix row', () => {
    const expected = serializedHand([{ type: 'fold' }]);
    const storedPreFix = withoutKeys(expected, ['rake', 'humanRakedPayout', 'humanRakedNet']);
    storedPreFix.humanPayout = (BigInt(expected.humanPayout as string) + 1n).toString();
    expect(holdemOutcomesMatch(expected, storedPreFix)).toBe(false);
  });
});

// ───────────────────────── Baccarat ─────────────────────────

describe('baccaratOutcomesMatch — banker-win changed-value back-compat', () => {
  /**
   * Replay coup 0 with a banker bet at `stake` and serialize with the LIVE
   * (new-formula) engine. We scan client seeds until coup 0 is a BANKER win so
   * the old/new payout actually diverge.
   */
  function bankerWinSerialized(stake: bigint): Json | null {
    for (let i = 0; i < 400; i++) {
      const client = hexClient(i);
      const replayed = replayShoeUpToCoup({
        serverSeed: SERVER,
        clientSeed: client,
        targetNonce: 0,
        coups: [{ bet: 'banker' as BaccaratBet, stake }],
      });
      if (replayed.winner === 'banker') {
        return serializeCoupResult(replayed, { cursorBefore: 0, dealtBefore: 0, nonce: 0 }) as unknown as Json;
      }
    }
    return null;
  }

  /** Build a PRE-FIX stored payload: clone the new serialization but overwrite
   * payout/net/commission with the OLD banker-win formula values. */
  function toPreFix(expected: Json, stake: bigint): Json {
    const oldCommission = (stake * 5n) / 100n; // floored — old undercharging rule
    const oldWinnings = stake - oldCommission;
    const oldPayout = stake + oldWinnings;
    const oldNet = oldPayout - stake;
    const c = clone(expected);
    c.payout = oldPayout.toString();
    c.net = oldNet.toString();
    c.commission = oldCommission.toString();
    return c;
  }

  // The stakes the finding flagged: old≠new at any non-multiple-of-20.
  const divergentStakes = [5n, 7n, 10n, 19n, 30n, 41n];

  for (const stake of divergentStakes) {
    it(`PRE-FIX banker win at stake ${stake} (old monetary values) verifies TRUE`, () => {
      const expected = bankerWinSerialized(stake);
      expect(expected).not.toBeNull();
      const preFix = toPreFix(expected!, stake);
      // Confirm the values actually diverge (otherwise the test is vacuous).
      expect(preFix.payout).not.toBe(expected!.payout);
      expect(baccaratOutcomesMatch(expected!, preFix)).toBe(true);
    });
  }

  it('a POST-FIX banker-win row (new values, identical) verifies TRUE strictly', () => {
    const expected = bankerWinSerialized(7n);
    expect(expected).not.toBeNull();
    expect(baccaratOutcomesMatch(expected!, clone(expected!))).toBe(true);
  });

  it('a row with the WRONG payout (neither old nor new) verifies FALSE', () => {
    const expected = bankerWinSerialized(7n);
    expect(expected).not.toBeNull();
    const tampered = clone(expected!);
    tampered.payout = (BigInt(expected!.payout as string) + 100n).toString();
    tampered.net = (BigInt(expected!.net as string) + 100n).toString();
    expect(baccaratOutcomesMatch(expected!, tampered)).toBe(false);
  });

  it('a tampered NON-monetary field (winner) verifies FALSE', () => {
    const expected = bankerWinSerialized(7n);
    expect(expected).not.toBeNull();
    const tampered = clone(expected!);
    tampered.winner = 'player';
    expect(baccaratOutcomesMatch(expected!, tampered)).toBe(false);
  });

  it('a tampered card (player.cards) verifies FALSE', () => {
    const expected = bankerWinSerialized(7n);
    expect(expected).not.toBeNull();
    const tampered = clone(expected!);
    const player = tampered.player as Json;
    player.cards = [{ suit: 'spades', rank: 'A' }];
    expect(baccaratOutcomesMatch(expected!, tampered)).toBe(false);
  });

  it('cursorBefore/dealtBefore differences are ignored', () => {
    const expected = bankerWinSerialized(7n);
    expect(expected).not.toBeNull();
    const stored = clone(expected!);
    stored.cursorBefore = 12345;
    stored.dealtBefore = 9;
    expect(baccaratOutcomesMatch(expected!, stored)).toBe(true);
  });

  it('a PLAYER bet (unchanged by the fix) verifies TRUE both pre/post (no divergence)', () => {
    // Player-win payout never changed → old==new; the helper must not reject it.
    for (let i = 0; i < 400; i++) {
      const client = hexClient(10000 + i);
      const replayed = replayShoeUpToCoup({
        serverSeed: SERVER,
        clientSeed: client,
        targetNonce: 0,
        coups: [{ bet: 'player' as BaccaratBet, stake: 7n }],
      });
      if (replayed.winner === 'player') {
        const expected = serializeCoupResult(replayed, {
          cursorBefore: 0,
          dealtBefore: 0,
          nonce: 0,
        }) as unknown as Json;
        expect(baccaratOutcomesMatch(expected, clone(expected))).toBe(true);
        return;
      }
    }
    throw new Error('no player-win coup found in scan');
  });
});
