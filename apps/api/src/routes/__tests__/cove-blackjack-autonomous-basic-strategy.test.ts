import { describe, expect, it } from 'bun:test';
import { buildBlackjackBasicStrategyHand } from '../cove-blackjack';

const TERMINAL_ACTIONS = new Set(['stand', 'double', 'surrender']);

describe('autonomous cove blackjack basic-strategy hand builder', () => {
  it('resolves deterministic hands with bounded exposure and valid terminal scripts', () => {
    let sawSplit = false;
    let sawDouble = false;

    for (let nonce = 0; nonce < 512; nonce++) {
      const played = buildBlackjackBasicStrategyHand({
        serverSeed: nonce.toString(16).padStart(64, '0'),
        clientSeed: nonce.toString(16).padStart(32, '0'),
        nonce: 0,
        cursor: 0,
        bet: 10n,
        dealtBefore: 0,
      });

      expect(played.script.tookInsurance).toBe(false);
      expect(played.result.insurance).toBeNull();
      expect(played.result.totalBet).toBeLessThanOrEqual(40n);
      expect(played.script.hands).toHaveLength(played.script.didSplit ? 2 : 1);
      expect(played.result.playerHands).toHaveLength(played.script.didSplit ? 2 : 1);

      sawSplit ||= played.script.didSplit;
      for (let slot = 0; slot < played.script.hands.length; slot++) {
        const actions = played.script.hands[slot]!;
        const result = played.result.playerHands[slot]!;
        const splitAce = played.script.didSplit && result.cards[0]?.rank === 'A';
        if (splitAce) {
          expect(actions).toEqual([]);
          expect(result.cards).toHaveLength(2);
          continue;
        }

        sawDouble ||= actions.includes('double');
        const last = actions.at(-1);
        const terminalByOpeningNatural = !played.script.didSplit && result.isBlackjack;
        expect(
          result.isBust ||
            terminalByOpeningNatural ||
            (last !== undefined && TERMINAL_ACTIONS.has(last)),
        ).toBe(true);
      }
    }

    expect(sawSplit).toBe(true);
    expect(sawDouble).toBe(true);
  });
});
