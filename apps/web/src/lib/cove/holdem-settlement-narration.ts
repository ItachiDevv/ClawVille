import type {
  HoldemSettledResponse,
  SerializedHoldemHand,
} from '@clawville/shared';

const BOT_NAMES: Readonly<Record<number, string>> = {
  1: 'Tess',
  2: 'Vex',
  3: 'Pip',
  4: 'Cal',
  5: 'Nita',
};

export function holdemSeatName(seat: number): string {
  return seat === 0 ? 'YOU' : (BOT_NAMES[seat] ?? `BOT ${seat}`);
}

export interface HoldemSettlementNarration {
  headline: string;
  detail: string;
}

/**
 * Describe the authoritative settled outcome. A non-showdown `endedAt` is the
 * server's fold-win signal; pot winner indices remain authoritative even when
 * a mapped/live snapshot omits or defaults per-seat `isWinner` flags.
 */
export function settlementNarration(
  settled: HoldemSettledResponse,
): HoldemSettlementNarration {
  const outcome: SerializedHoldemHand = settled.outcome;
  const potWinnerSeats = new Set(outcome.pots.flatMap((pot) => pot.winners));
  const winners = outcome.seats.filter(
    (seat) => seat.isWinner || potWinnerSeats.has(seat.seat),
  );
  const humanWinner = winners.find((seat) => seat.isHuman);
  const endedByFold = outcome.endedAt !== 'showdown';
  const net = BigInt(settled.net);
  const netText = `${net >= 0n ? '+' : ''}${net.toString()} vCLAW`;

  if (endedByFold && humanWinner) {
    return {
      headline: `Everyone folded. You take the pot: +${settled.payout} vCLAW`,
      detail: `Your net: ${netText}`,
    };
  }
  if (endedByFold && winners[0]) {
    return {
      headline: `Everyone else folded. ${holdemSeatName(winners[0].seat)} takes ${winners[0].won} vCLAW`,
      detail: `Your net: ${netText}`,
    };
  }

  const winnerText = winners.map((winner) => {
    const category = winner.handCategoryName ? ` with ${winner.handCategoryName}` : '';
    const verb = winner.isHuman ? 'win' : 'wins';
    return `${holdemSeatName(winner.seat)} ${verb} ${winner.won} vCLAW${category}`;
  }).join(' · ');
  const splitDetail = outcome.pots.length > 1 || outcome.pots.some((pot) => pot.winners.length > 1)
    ? outcome.pots.map((pot, index) => {
        const names = pot.winners.map(holdemSeatName).join(' + ');
        return `${outcome.pots.length > 1 ? `Pot ${index + 1}` : 'Split pot'}: ${names} (${pot.amount} vCLAW)`;
      }).join(' · ')
    : '';
  return {
    headline: `Showdown: ${winnerText || 'pot awarded'}`,
    detail: [splitDetail, `Your net: ${netText}`].filter(Boolean).join(' · '),
  };
}
