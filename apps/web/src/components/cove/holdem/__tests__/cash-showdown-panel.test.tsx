/**
 * Cash showdown panel: the best-five row (2026-10-21, founder order
 * "everything needs to be seen on the front end during a cards game").
 *
 * Live case, staging hand 8294: board 10s Qc Js 7c Qh. Two seats both had
 * "Two pair" (Q Q J J); the Ace kicker won over the 10 kicker. Each shown row
 * must list the five cards that make the hand so the player sees WHY.
 */

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CashPokerCard, CashSettledSeatView, CashSettledView } from '@/lib/cove/cash-poker';
import { summarizeCashSettled } from '@/lib/cove/holdem-cash-feed';
import { CashShowdownPanel, cashResultFreesTray } from '../CashShowdownPanel';

const c = (rank: CashPokerCard['rank'], suit: CashPokerCard['suit']): CashPokerCard => ({ rank, suit });

const BOARD = [c('10', 'spades'), c('Q', 'clubs'), c('J', 'spades'), c('7', 'clubs'), c('Q', 'hearts')];
const BOT_FIVE = [c('Q', 'clubs'), c('Q', 'hearts'), c('J', 'diamonds'), c('J', 'spades'), c('A', 'hearts')];
const YOU_FIVE = [c('Q', 'clubs'), c('Q', 'hearts'), c('J', 'clubs'), c('J', 'spades'), c('10', 'spades')];

function seat(seatIndex: number, extra: Partial<CashSettledSeatView>): CashSettledSeatView {
  return {
    seatIndex,
    avatarId: `av-${seatIndex}`,
    startStack: '200',
    endStack: '200',
    totalCommitted: '20',
    grossWon: '0',
    rakeAttributed: '0',
    net: '0',
    stackDelta: '0',
    status: 'active',
    shown: null,
    mucked: false,
    ...extra,
  };
}

function settled(withBestFive: boolean): CashSettledView {
  const rank = (five: CashPokerCard[]) => ({
    category: 2,
    categoryName: 'two_pair',
    ...(withBestFive ? { bestFive: five } : {}),
  });
  return {
    handId: 't:8294',
    handNumber: 8294,
    tableId: 't',
    board: BOARD,
    endedAt: 'showdown',
    pots: [{ amount: '40', eligibleSeatIndices: [0, 1], awards: [{ seatIndex: 0, amount: '40' }], winningRank: { category: 2, categoryName: 'two_pair', tiebreakers: [12, 11, 14] } }],
    seats: [
      seat(0, { name: 'Felt-Bot-002', net: '20', endStack: '220', grossWon: '40', shown: [c('J', 'diamonds'), c('A', 'hearts')], handRank: rank(BOT_FIVE) }),
      seat(1, { name: 'Viewer', net: '-20', endStack: '180', shown: [c('2', 'diamonds'), c('J', 'clubs')], handRank: rank(YOU_FIVE) }),
      seat(2, { name: 'Folder', status: 'folded', mucked: true, handRank: null }),
    ],
    settledAtMs: 10_000,
    displayExpiresAtMs: 18_000,
    nextHandAtMs: 18_000,
  };
}

const namer = (s: CashSettledSeatView) => s.name ?? `Seat ${s.seatIndex + 1}`;

function render(withBestFive: boolean): string {
  const summary = summarizeCashSettled(settled(withBestFive), namer, 1, null);
  return renderToStaticMarkup(
    <CashShowdownPanel summary={summary} nextHandSeconds={8} forceCompact={false} mobile />,
  );
}

/** Count the rendered rows that carry a best-five group. */
function bestFiveRows(html: string): string[] {
  return html.match(/<span[^>]*data-testid="cash-best-five"[^>]*>/g) ?? [];
}

describe('CashShowdownPanel best-five row', () => {
  test('each shown "Two pair" row lists its five cards, kicker included', () => {
    const html = render(true);
    const rows = bestFiveRows(html);
    // Two shown seats; the folded seat has no row.
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain('Felt-Bot-002 best five cards: Q♣ Q♥ J♦ J♠ A♥');
    expect(rows[1]).toContain('You best five cards: Q♣ Q♥ J♣ J♠ 10♠');
    expect(html).toContain('Best 5');
    expect(html).not.toContain('Folder best five');
    // Both rows still show the hand name.
    expect(html.match(/Two pair/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test('old snapshots without bestFive render with no best-five row', () => {
    const html = render(false);
    expect(bestFiveRows(html).length).toBe(0);
    expect(html).not.toContain('Best 5');
    expect(html).toContain('Two pair');
  });
});

/** The markup of each seat-name block, from its testid to the block's end. */
function seatNameBlocks(html: string): string[] {
  return html.match(/<span[^>]*data-testid="cash-seat-name"[^>]*>(?:<span[^>]*>[^<]*<\/span>)+<\/span>/g) ?? [];
}

describe('CashShowdownPanel seat row: Won chip inside the name block', () => {
  test('the winner row keeps the name text and the Won chip as siblings in one name block', () => {
    const blocks = seatNameBlocks(render(true));
    // One block per seat (winner, viewer, folder).
    expect(blocks.length).toBe(3);
    // The name has its own span (it can shrink with an ellipsis), and the
    // chip follows it inside the same block, never in the cards column.
    expect(blocks[0]).toMatch(/^<span[^>]*data-testid="cash-seat-name"[^>]*><span[^>]*>Felt-Bot-002<\/span><span[^>]*>Won<\/span><\/span>$/);
    expect(blocks[1]).toContain('>You<');
    expect(blocks[1]).not.toContain('>Won<');
    expect(blocks[2]).not.toContain('>Won<');
  });
});

describe('cashResultFreesTray (short-landscape surfaceSettled gate)', () => {
  test('true only while the current result shows and the viewer is not acting', () => {
    expect(cashResultFreesTray({ hasResult: true, resultIsStale: false, isYourTurn: false })).toBe(true);
    // Never hide the tray on the viewer's turn.
    expect(cashResultFreesTray({ hasResult: true, resultIsStale: false, isYourTurn: true })).toBe(false);
    // The next hand is live: the panel is a one-line strip, the tray is back.
    expect(cashResultFreesTray({ hasResult: true, resultIsStale: true, isYourTurn: false })).toBe(false);
    expect(cashResultFreesTray({ hasResult: false, resultIsStale: false, isYourTurn: false })).toBe(false);
  });
});
