import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ParityMirror } from '@/components/cove/CardParityMirror';
import {
  buildHoldemFeltParity,
  clearFeltParity,
  publishFeltParity,
  type CardParityPayload,
  type CardParitySlot,
} from '../card-parity-mirror';

const OWNER = 'parity-no-leak-owner';

afterEach(() => {
  clearFeltParity(OWNER);
});

describe('whole-mirror no-leak boundary', () => {
  test('omits known folded and peek card codes from the entire rendered mirror DOM', () => {
    const knownHiddenCodes = ['Qh', 'Jd', 'Ks', 'Kc'];
    const payload = buildHoldemFeltParity({
      kind: 'practice',
      board: [],
      opponents: [
        {
          seatIndex: 1,
          status: 'folded',
          cards: [
            { suit: 'hearts', rank: 'Q' },
            { suit: 'diamonds', rank: 'J' },
          ],
          count: 2,
          peek: false,
        },
        {
          seatIndex: 3,
          status: 'active',
          cards: [
            { suit: 'spades', rank: 'K' },
            { suit: 'clubs', rank: 'K' },
          ],
          count: 2,
          peek: true,
        },
      ],
      correlation: { hand: 'settled-practice-hand', handNumber: 3 },
      dealStep: 'showdown',
      phase: 'settled',
      transition: 'idle',
      settled: null,
    });
    publishFeltParity(OWNER, payload);

    const mirrorDom = renderToStaticMarkup(
      <ParityMirror surface="holdem-felt-practice" instanceId={OWNER} />,
    );

    expect(mirrorDom).toContain('data-cv-parity="holdem-felt-practice"');
    for (const hiddenCode of knownHiddenCodes) {
      expect(mirrorDom).not.toContain(hiddenCode);
    }
    expect(mirrorDom.match(/data-facing="down"/g)?.length).toBe(4);
    expect(mirrorDom.match(/data-card=""/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test('independently re-blanks a malicious runtime non-up slot', () => {
    const maliciousSlot = {
      slot: 'dealer-card-2',
      facing: 'down',
      card: 'As',
    } as unknown as CardParitySlot;
    const maliciousPayload: CardParityPayload = {
      surface: 'blackjack-2d',
      version: 2,
      correlation: { hand: 'malicious-runtime-payload', handNumber: null },
      dealStep: 'player-turn',
      phase: 'player-turn',
      transition: 'idle',
      slots: [maliciousSlot],
      meta: {},
    };
    publishFeltParity(OWNER, maliciousPayload);

    const mirrorDom = renderToStaticMarkup(
      <ParityMirror surface="blackjack-2d" instanceId={OWNER} />,
    );

    expect(mirrorDom).toContain('data-facing="down"');
    expect(mirrorDom).toContain('data-card=""');
    expect(mirrorDom).not.toContain('As');
  });

  test('reveals only non-folded cash shown cards and keeps folded seats concealed', () => {
    const payload = buildHoldemFeltParity({
      kind: 'cash',
      board: [
        { suit: 'spades', rank: 'A' },
        { suit: 'clubs', rank: 'K' },
      ],
      opponents: [
        {
          seatIndex: 2,
          status: 'active',
          count: 2,
          peek: false,
        },
        {
          seatIndex: 4,
          status: 'folded',
          count: 0,
          peek: false,
        },
      ],
      settled: {
        handId: 'cash-table:44',
        handNumber: 44,
        tableId: 'cash-table',
        board: [],
        endedAt: 'showdown',
        pots: [],
        seats: [
          {
            seatIndex: 0,
            avatarId: 'own-avatar',
            startStack: '100',
            endStack: '95',
            totalCommitted: '5',
            grossWon: '0',
            rakeAttributed: '0',
            net: '-5',
            stackDelta: '-5',
            status: 'active',
            shown: [
              { suit: 'clubs', rank: '2' },
              { suit: 'diamonds', rank: '3' },
            ],
            mucked: false,
          },
          {
            seatIndex: 2,
            avatarId: 'opponent-avatar',
            startStack: '100',
            endStack: '110',
            totalCommitted: '10',
            grossWon: '20',
            rakeAttributed: '0',
            net: '10',
            stackDelta: '10',
            status: 'active',
            shown: [
              { suit: 'hearts', rank: 'Q' },
              { suit: 'diamonds', rank: 'J' },
            ],
            mucked: false,
          },
          {
            seatIndex: 4,
            avatarId: 'folded-avatar',
            startStack: '100',
            endStack: '95',
            totalCommitted: '5',
            grossWon: '0',
            rakeAttributed: '0',
            net: '-5',
            stackDelta: '-5',
            status: 'folded',
            shown: null,
            mucked: true,
          },
        ],
        settledAtMs: 1,
        displayExpiresAtMs: 2,
      },
      correlation: { hand: 'cash-table:44', handNumber: 44 },
      dealStep: 'showdown',
      phase: 'settled',
      transition: 'idle',
      ownSeatIndex: 0,
      bannerText: 'Showdown',
    });
    publishFeltParity(OWNER, payload);

    const mirrorDom = renderToStaticMarkup(
      <ParityMirror surface="holdem-felt-3d" instanceId={OWNER} />,
    );

    expect(mirrorDom).toContain('data-slot="opp-2-1" data-card="Qh" data-facing="up"');
    expect(mirrorDom).toContain('data-slot="opp-2-2" data-card="Jd" data-facing="up"');
    expect(mirrorDom).toContain('data-slot="opp-4-1" data-card="" data-facing="empty"');
    expect(mirrorDom).toContain('data-slot="opp-4-2" data-card="" data-facing="empty"');
    expect(mirrorDom).not.toContain('data-slot="opp-4-1" data-facing="up"');
    expect(mirrorDom).toContain('data-outcome="showdown"');
    expect(mirrorDom).toContain('data-net="-5"');
    expect(mirrorDom).toContain('data-banner-text="Showdown"');
  });
});
