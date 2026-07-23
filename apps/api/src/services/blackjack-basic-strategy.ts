import {
  cardBaseValue,
  handTotal,
  type BlackjackActionType,
  type Card,
} from './blackjack-engine';

export interface BlackjackBasicStrategyOptions {
  canDouble: boolean;
  canSplit: boolean;
  canSurrender: boolean;
}

/**
 * Textbook six-deck S17/DAS late-surrender policy.
 *
 * This function is deliberately pure: it receives only the visible player
 * cards, dealer upcard, and current legal-action capabilities. The engine and
 * route remain authoritative for dealing, legality, and settlement.
 */
export function chooseBlackjackBasicStrategyAction(
  playerCards: readonly Card[],
  dealerUpcard: Card,
  options: BlackjackBasicStrategyOptions,
): BlackjackActionType {
  if (playerCards.length < 2) throw new Error('basic_strategy_requires_two_player_cards');

  const dealer = cardBaseValue(dealerUpcard.rank);
  const { total, isSoft } = handTotal(playerCards);

  if (options.canSplit && playerCards.length === 2) {
    const first = cardBaseValue(playerCards[0]!.rank);
    const second = cardBaseValue(playerCards[1]!.rank);
    if (first === second) {
      if (first === 1 || first === 8) return 'split';
      if (first === 10) return 'stand';
      if (first === 9) return [2, 3, 4, 5, 6, 8, 9].includes(dealer) ? 'split' : 'stand';
      if (first === 7) return dealer >= 2 && dealer <= 7 ? 'split' : 'hit';
      if (first === 6) return dealer >= 2 && dealer <= 6 ? 'split' : 'hit';
      if (first === 4) return dealer === 5 || dealer === 6 ? 'split' : 'hit';
      if (first === 2 || first === 3) return dealer >= 2 && dealer <= 7 ? 'split' : 'hit';
      // Pair of fives follows hard 10 below; never split it.
    }
  }

  if (options.canSurrender && playerCards.length === 2 && !isSoft) {
    if (total === 16 && (dealer === 1 || dealer === 9 || dealer === 10)) return 'surrender';
    if (total === 15 && dealer === 10) return 'surrender';
  }

  if (isSoft) {
    if (total >= 20) return 'stand';
    // S17: soft 19 always stands. (A,8 vs 6 doubles only on common H17 charts.)
    if (total === 19) return 'stand';
    if (total === 18) {
      if (options.canDouble && dealer >= 3 && dealer <= 6) return 'double';
      // A,7 is double-or-stand on 3–6: if doubling is unavailable, stand.
      return dealer >= 2 && dealer <= 8 ? 'stand' : 'hit';
    }
    if (total === 17) return options.canDouble && dealer >= 3 && dealer <= 6 ? 'double' : 'hit';
    if (total === 15 || total === 16) {
      return options.canDouble && dealer >= 4 && dealer <= 6 ? 'double' : 'hit';
    }
    if (total === 13 || total === 14) {
      return options.canDouble && (dealer === 5 || dealer === 6) ? 'double' : 'hit';
    }
    // Soft 12 (A,A when splitting is unavailable) always hits; never fall
    // through into the hard-12 stand-vs-4–6 rule.
    return 'hit';
  }

  if (total >= 17) return 'stand';
  if (total >= 13) return dealer >= 2 && dealer <= 6 ? 'stand' : 'hit';
  if (total === 12) return dealer >= 4 && dealer <= 6 ? 'stand' : 'hit';
  if (total === 11) return options.canDouble && dealer !== 1 ? 'double' : 'hit';
  if (total === 10) return options.canDouble && dealer >= 2 && dealer <= 9 ? 'double' : 'hit';
  if (total === 9) return options.canDouble && dealer >= 3 && dealer <= 6 ? 'double' : 'hit';
  return 'hit';
}
