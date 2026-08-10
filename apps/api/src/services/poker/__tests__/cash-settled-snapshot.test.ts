import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  awardPots,
  buildSidePots,
  HandCategory,
  type Card,
  type PlaySeat,
  type PotResult,
  type SeatResult,
} from '../../holdem-engine';
import {
  assertCashSettledHandEntitlement,
  buildCashSettledHandSnapshot,
  CashTableError,
  CashTableManager,
} from '../cash-table-manager';
import { PokerTableSim, serializeSettledPots } from '../poker-table-sim';
import { pokerCashHands, pokerCashTables } from '@clawville/database';
import { createLastSettledHandler } from '../../../routes/cove-cash-last-settled-handler';
import type { AppContext } from '../../../types';

const CARD: Card = { rank: 'A', suit: 'spades' };
const PERSISTED_SEATS = [
  {
    seatIndex: 0,
    avatarId: 'winner',
    startStack: '100',
    endStack: '130',
    totalCommitted: '20',
    grossWon: '50',
    rakeAttributed: '0',
    net: '30',
    stackDelta: '30',
    status: 'active' as const,
    mucked: false,
  },
  {
    seatIndex: 1,
    avatarId: 'loser',
    startStack: '100',
    endStack: '80',
    totalCommitted: '20',
    grossWon: '0',
    rakeAttributed: '0',
    net: '-20',
    stackDelta: '-20',
    status: 'active' as const,
    mucked: false,
  },
  {
    seatIndex: 2,
    avatarId: 'folder',
    startStack: '100',
    endStack: '90',
    totalCommitted: '10',
    grossWon: '0',
    rakeAttributed: '0',
    net: '-10',
    stackDelta: '-10',
    status: 'folded' as const,
    mucked: true,
  },
];

function seatResult(
  seat: number,
  won: bigint,
  category: HandCategory | null = HandCategory.Flush,
): SeatResult {
  return {
    seat,
    isHuman: true,
    personality: null,
    holeCards: [CARD, CARD],
    committed: 0n,
    won,
    net: won,
    status: 'active',
    handRank: category === null
      ? null
      : { category, tiebreakers: [14, 11, 8, 5, 2], bestFive: [CARD, CARD, CARD, CARD, CARD] },
    isWinner: won > 0n,
  };
}

describe('BA-1 settled pot truth', () => {
  it('derives layered all-in main/side pots and an odd-chip tie from engine truth', () => {
    const board: Card[] = [
      { rank: '2', suit: 'clubs' },
      { rank: '3', suit: 'diamonds' },
      { rank: '4', suit: 'hearts' },
      { rank: '5', suit: 'spades' },
      { rank: '9', suit: 'clubs' },
    ];
    const seats: PlaySeat[] = [
      {
        seat: 0,
        isHuman: true,
        personality: null,
        hole: [{ rank: 'A', suit: 'spades' }, { rank: 'K', suit: 'clubs' }],
        stack: 0n,
        committedTotal: 5n,
        streetCommitted: 0n,
        status: 'allin',
        hasActed: true,
      },
      {
        seat: 1,
        isHuman: true,
        personality: null,
        hole: [{ rank: '9', suit: 'diamonds' }, { rank: '9', suit: 'hearts' }],
        stack: 0n,
        committedTotal: 10n,
        streetCommitted: 0n,
        status: 'allin',
        hasActed: true,
      },
      {
        seat: 2,
        isHuman: true,
        personality: null,
        hole: [{ rank: 'A', suit: 'diamonds' }, { rank: 'Q', suit: 'clubs' }],
        stack: 0n,
        committedTotal: 10n,
        streetCommitted: 0n,
        status: 'allin',
        hasActed: true,
      },
    ];
    const pots = buildSidePots(seats);
    const results = awardPots(seats, pots, board, 'showdown');
    const serialized = serializeSettledPots(pots, results, 'showdown');

    expect(serialized.map((pot) => pot.amount)).toEqual(['15', '10']);
    expect(serialized[0]!.awards).toEqual([
      { seatIndex: 0, amount: '8' },
      { seatIndex: 2, amount: '7' },
    ]);
    expect(serialized[1]!.awards).toEqual([{ seatIndex: 2, amount: '10' }]);
    expect(serialized[0]!.winningRank?.categoryName).toBe('straight');
    for (const pot of serialized) {
      expect(pot.awards.reduce((sum, award) => sum + BigInt(award.amount), 0n))
        .toBe(BigInt(pot.amount));
    }
  });

  it('preserves main+side/all-in layers, tied awards, and odd-chip order', () => {
    const pots: PotResult[] = [
      {
        amount: 15n,
        eligibleSeats: [0, 1, 2],
        winners: [2, 0],
        perWinner: 7n,
      },
      {
        amount: 20n,
        eligibleSeats: [1, 2],
        winners: [1],
        perWinner: 20n,
      },
      {
        amount: 7n,
        eligibleSeats: [2],
        winners: [2],
        perWinner: 7n,
      },
    ];
    const serialized = serializeSettledPots(
      pots,
      [seatResult(0, 8n), seatResult(1, 20n), seatResult(2, 14n)],
      'showdown',
    );

    expect(serialized.map((pot) => pot.amount)).toEqual(['15', '20', '7']);
    expect(serialized[0]!.awards).toEqual([
      { seatIndex: 0, amount: '8' },
      { seatIndex: 2, amount: '7' },
    ]);
    expect(serialized[0]!.winningRank).toEqual({
      category: HandCategory.Flush,
      categoryName: 'flush',
      tiebreakers: [14, 11, 8, 5, 2],
    });
    expect(
      serialized.reduce(
        (sum, pot) =>
          sum + pot.awards.reduce((potSum, award) => potSum + BigInt(award.amount), 0n),
        0n,
      ),
    ).toBe(serialized.reduce((sum, pot) => sum + BigInt(pot.amount), 0n));
    for (const pot of serialized) {
      expect(pot.awards.reduce((sum, award) => sum + BigInt(award.amount), 0n))
        .toBe(BigInt(pot.amount));
    }
  });

  it('forces winningRank null on a fold-win, including a river fold', () => {
    const [pot] = serializeSettledPots(
      [{ amount: 9n, eligibleSeats: [1], winners: [1], perWinner: 9n }],
      [seatResult(1, 9n)],
      'river',
    );
    expect(pot!.winningRank).toBeNull();
  });
});

describe('BA-1 snapshot entitlement and serialization', () => {
  const seats = PERSISTED_SEATS;

  it('shows non-folded showdown hands, hides folded owner, and rejects unrelated requesters', () => {
    const snapshot = buildCashSettledHandSnapshot({
      tableId: 'table-1',
      handNumber: 7,
      board: [],
      endedAt: 'showdown',
      pots: [],
      seats,
      serverSeed: 'a'.repeat(64),
      clientSeed: 'deadbeef',
      settledAt: new Date(1_700_000_000_000),
    });

    expect(() => assertCashSettledHandEntitlement(seats, 'winner')).not.toThrow();
    expect(() => assertCashSettledHandEntitlement(seats, 'loser')).not.toThrow();
    expect(() => assertCashSettledHandEntitlement(seats, 'folder')).not.toThrow();
    expect(() => assertCashSettledHandEntitlement(seats, 'unrelated')).toThrow(CashTableError);
    try {
      assertCashSettledHandEntitlement(seats, 'unrelated');
    } catch (error) {
      expect((error as CashTableError).httpStatus).toBe(403);
    }

    expect(snapshot.handId).toBe('table-1:7');
    expect(snapshot.seats.find((seat) => seat.avatarId === 'winner')!.shown).not.toBeNull();
    expect(snapshot.seats.find((seat) => seat.avatarId === 'loser')!.shown).not.toBeNull();
    expect(snapshot.seats.find((seat) => seat.avatarId === 'folder')!.shown).toBeNull();
    expect(snapshot.displayExpiresAtMs - snapshot.settledAtMs).toBe(8_000);
  });

  it('round-trips the frozen snapshot JSON without numeric or entitlement drift', () => {
    const snapshot = buildCashSettledHandSnapshot({
      tableId: 'table-roundtrip',
      handNumber: 12,
      board: [CARD],
      endedAt: 'flop',
      pots: [{
        amount: '60',
        eligibleSeatIndices: [0, 1],
        awards: [{ seatIndex: 0, amount: '60' }],
        winningRank: null,
      }],
      seats,
      serverSeed: 'b'.repeat(64),
      clientSeed: 'deadbeef',
      settledAt: new Date(1_700_000_123_000),
    });
    const roundTripped = JSON.parse(JSON.stringify(snapshot));
    expect(roundTripped).toEqual(snapshot);
    expect(roundTripped.seats.every((seat: { shown: unknown }) => seat.shown === null)).toBe(true);
  });
});

describe('BA-1 last-settled transport service semantics', () => {
  function managerWith(hand: Record<string, unknown> | null, tableExists = true) {
    const fakeDb = {
      select() {
        return {
          from(table: unknown) {
            const rows = table === pokerCashTables
              ? (tableExists ? [{ id: 'table-1' }] : [])
              : table === pokerCashHands && hand
                ? [hand]
                : [];
            const builder = {
              where() { return builder; },
              orderBy() { return builder; },
              async limit() { return rows; },
            };
            return builder;
          },
        };
      },
    };
    return new CashTableManager({
      db: fakeDb as never,
      sim: new PokerTableSim(),
      ledger: {
        debitClawTokens: async () => ({ balanceAfter: 0, ledgerId: null }),
        creditClawTokens: async () => ({ balanceAfter: 0, ledgerId: null }),
      } as never,
    });
  }

  function persistedHand() {
    return {
      id: 'db-hand-id',
      tableId: 'table-1',
      handNumber: 4,
      serverSeedCommit: 'commit',
      serverSeedReveal: 'c'.repeat(64),
      clientSeed: 'deadbeef',
      boardJson: [],
      potTotalCt: '40',
      rakeTakenCt: '0',
      potResultJson: [{
        amount: '40',
        eligibleSeatIndices: [0, 1],
        awards: [{ seatIndex: 0, amount: '40' }],
        winningRank: null,
      }],
      seatResultJson: PERSISTED_SEATS,
      endedAt: 'showdown',
      settledAt: new Date(1_700_000_000_000),
      createdAt: new Date(1_700_000_000_000),
    };
  }

  it('returns 404 for an unknown table and null/204 semantics when no newer row exists', async () => {
    await expect(
      managerWith(null, false).getLastSettledHand('table-1', 'winner', 0),
    ).rejects.toMatchObject({ httpStatus: 404, code: 'no_such_table' });
    expect(await managerWith(null).getLastSettledHand('table-1', 'winner', 4)).toBeNull();
  });

  it('returns the latest persisted snapshot to historical requesters and 403 to unrelated ones', async () => {
    const manager = managerWith(persistedHand());
    const winner = await manager.getLastSettledHand('table-1', 'winner', 3);
    const loser = await manager.getLastSettledHand('table-1', 'loser', 3);
    const folder = await manager.getLastSettledHand('table-1', 'folder', 3);
    expect(winner?.handNumber).toBe(4);
    expect(winner?.handId).toBe('table-1:4');
    expect(loser?.seats.find((seat) => seat.avatarId === 'loser')?.shown).not.toBeNull();
    expect(folder?.seats.find((seat) => seat.avatarId === 'folder')?.shown).toBeNull();
    await expect(
      manager.getLastSettledHand('table-1', 'unrelated', 3),
    ).rejects.toMatchObject({ httpStatus: 403, code: 'not_historical_participant' });
  });

  function routeApp(options: {
    authError?: number;
    result?: ReturnType<typeof buildCashSettledHandSnapshot> | null;
    managerError?: CashTableError;
    capture?: number[];
  } = {}) {
    const app = new Hono<AppContext>();
    app.get(
      '/tables/:id/last-settled',
      createLastSettledHandler({
        resolveRequestSubject: async () => {
          if (options.authError) {
            throw new HTTPException(options.authError as 401, { message: 'auth_required' });
          }
          return {
            kind: 'user',
            userId: 'user-1',
            avatarId: 'winner',
            agentId: null,
          };
        },
        getLastSettledHand: async (_tableId, _avatarId, afterHandNumber) => {
          options.capture?.push(afterHandNumber);
          if (options.managerError) throw options.managerError;
          return options.result ?? null;
        },
      }),
    );
    return app;
  }

  it('executes auth and required/nonnegative afterHandNumber validation', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect((await routeApp({ authError: 401 }).request(
      `/tables/${id}/last-settled?afterHandNumber=0`,
    )).status).toBe(401);
    expect((await routeApp().request(`/tables/${id}/last-settled`)).status).toBe(400);
    expect((await routeApp().request(
      `/tables/${id}/last-settled?afterHandNumber=-1`,
    )).status).toBe(400);
    expect((await routeApp().request(
      `/tables/${id}/last-settled?afterHandNumber=NaN`,
    )).status).toBe(400);
  });

  it('executes exact 200/204/403/404 response semantics', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const url = `/tables/${id}/last-settled?afterHandNumber=3`;
    const capture: number[] = [];
    const snapshot = buildCashSettledHandSnapshot({
      tableId: id,
      handNumber: 4,
      board: [],
      endedAt: 'showdown',
      pots: [],
      seats: PERSISTED_SEATS,
      serverSeed: 'd'.repeat(64),
      clientSeed: 'deadbeef',
      settledAt: new Date(1_700_000_000_000),
    });

    const ok = await routeApp({ result: snapshot, capture }).request(url);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ snapshot });
    expect(capture).toEqual([3]);

    const empty = await routeApp({ result: null }).request(url);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');

    const forbidden = await routeApp({
      managerError: new CashTableError('not_historical_participant', 'forbidden', 403),
    }).request(url);
    expect(forbidden.status).toBe(403);

    const missing = await routeApp({
      managerError: new CashTableError('no_such_table', 'missing', 404),
    }).request(url);
    expect(missing.status).toBe(404);
  });
});
