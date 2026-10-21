'use client';

/**
 * Cash table result panel (2026-10-21). Shown while the authoritative
 * settled snapshot is on screen: who won each pot, how much, with which hand;
 * every seat's shown cards, hand name and net; "Folded" for folded seats;
 * the next-hand countdown. Anchored to the top of the screen so it never
 * covers the bottom action HUD. Pure DOM, Iris Xe safe.
 */

import { useEffect, useState } from 'react';
import type { CashSettledSummary } from '@/lib/cove/holdem-cash-feed';
import { formatChips, formatNet } from '@/lib/cove/holdem-cash-feed';
import PokerCard from './PokerCard';
import styles from './SeatedHoldemHud.module.css';

export function CashShowdownPanel({
  summary,
  nextHandSeconds,
  forceCompact,
  mobile,
}: {
  summary: CashSettledSummary;
  /** Null when the server did not send `nextHandAtMs` (older rows). */
  nextHandSeconds: number | null;
  /** The next hand is already live: show a one-line strip only. */
  forceCompact: boolean;
  mobile: boolean;
}) {
  const [hiddenHand, setHiddenHand] = useState<number | null>(null);
  useEffect(() => {
    setHiddenHand(null);
  }, [summary.handNumber]);
  const compact = forceCompact || hiddenHand === summary.handNumber;
  const you = summary.seats.find((seat) => seat.isYou) ?? null;

  return (
    <section
      className={styles.result
        + (mobile ? ' ' + styles.resultMobile : '')
        + (compact ? ' ' + styles.resultCompact : '')}
      data-testid="holdem-settlement-narration"
      data-banner-text={summary.headline}
      aria-label={`Hand ${summary.handNumber} result`}
    >
      <div className={styles.resultHeader}>
        <div className={styles.resultTitle}>
          <span className={styles.settlementHeadline}>{summary.headline}</span>
          <span className={styles.resultMeta}>
            Hand {summary.handNumber}
            {' · '}
            <span data-testid="holdem-pot-amount">Pot {formatChips(summary.totalPot)} vCLAW</span>
            {nextHandSeconds != null && !forceCompact && (
              <span data-testid="cash-next-hand-countdown">{` · Next hand in ${nextHandSeconds}s`}</span>
            )}
          </span>
        </div>
        {!forceCompact && (
          <button
            type="button"
            className={styles.resultToggle}
            onClick={() => setHiddenHand(compact ? null : summary.handNumber)}
            aria-expanded={!compact}
          >
            {compact ? 'Details' : 'Hide'}
          </button>
        )}
      </div>

      <p className={styles.resultSummary} data-testid="cash-result-summary">{summary.summaryText}</p>

      {you && (
        <p className={styles.resultYou}>
          <span data-testid="holdem-self-stack">Stack {formatChips(you.endStack)} vCLAW</span>
          {' · '}
          <span className={you.net > 0 ? styles.netUp : you.net < 0 ? styles.netDown : undefined}>
            {formatNet(you.net)} vCLAW net
          </span>
        </p>
      )}

      {!compact && (
        <ul className={styles.resultSeats} aria-label="Seats at showdown">
          {summary.seats.map((seat) => (
            <li
              key={seat.seatIndex}
              className={styles.resultSeat
                + (seat.isYou ? ' ' + styles.resultSeatYou : '')
                + (seat.isWinner ? ' ' + styles.resultSeatWinner : '')
                + (seat.folded ? ' ' + styles.resultSeatFolded : '')}
            >
              <span className={styles.resultSeatName}>
                {seat.name}
                {seat.isWinner && <span className={styles.winnerChip}>Won</span>}
              </span>
              <span className={styles.resultSeatCards}>
                {seat.folded && !seat.isYou && <span className={styles.resultFolded}>Folded</span>}
                {seat.folded && seat.isYou && <span className={styles.resultFolded}>You folded</span>}
                {!seat.folded && seat.cards && seat.cards.map((card, index) => (
                  <PokerCard key={`${card.suit}-${card.rank}-${index}`} card={card} compact />
                ))}
                {!seat.folded && !seat.cards && <span className={styles.resultFolded}>Cards not shown</span>}
              </span>
              <span className={styles.resultSeatRank}>{seat.rankLabel ?? ''}</span>
              <span className={styles.resultSeatNet + ' ' + (seat.net > 0 ? styles.netUp : seat.net < 0 ? styles.netDown : '')}>
                {formatNet(seat.net)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
