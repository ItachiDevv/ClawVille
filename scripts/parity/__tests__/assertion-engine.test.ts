import { describe, expect, test } from 'bun:test';
import { assertParityCheckpoint, assertOrderedDealSteps } from '../assertion-engine';
import { diffParity } from '../diff';
import { expectedFromWire } from '../expected-from-wire';
import { RECORDED_CASES } from '../fixtures/recorded';
import type { CardParityRoot, WireRecord } from '../types';

describe('recorded-wire parity assertions', () => {
  for (const recorded of RECORDED_CASES) {
    test(`${recorded.id} matches exact recorded wire`, () => {
      const result = assertParityCheckpoint({
        game: recorded.game,
        checkpoint: {
          label: recorded.id,
          surface: recorded.root.surface,
          expectRevisionAdvance: true,
          expectDealStep: recorded.expectedDealStep,
          expectCorrelationHand: recorded.root.correlation.hand,
          final: recorded.final,
        },
        root: recorded.root,
        records: recorded.records,
      });
      expect(result.mismatches).toEqual([]);
      expect(result.pass).toBe(true);
    });
  }

  test('cash private view supplies tray cards and pot metadata', () => {
    const wire: WireRecord = {
      seq: 50,
      method: 'GET',
      url: '',
      urlSuffix: 'poker/cash/tables/table-a/state-for-agent',
      status: 200,
      requestBody: null,
      responseBody: {
        ok: true,
        view: {
          handNumber: 14,
          holeCards: [
            { suit: 'spades', rank: 'A' },
            { suit: 'diamonds', rank: '10' },
          ],
          table: {
            tableId: 'table-a',
            handNumber: 14,
            board: [],
            pot: 30,
            seats: [],
          },
        },
      },
      handId: null,
      handNumber: 14,
      coupId: null,
      shoeId: null,
      idempotencyKey: null,
    };
    const root = {
      surface: 'holdem-tray-3d',
      correlation: { hand: 'table-a:14', handNumber: 14 },
      dealStep: 'hole',
    } as CardParityRoot;
    expect(expectedFromWire(
      'holdem',
      root.surface,
      wire,
      undefined,
      { root, records: [wire] },
    )).toMatchObject({
      slots: {
        'hole-1': { card: 'As', facing: 'up' },
        'hole-2': { card: 'Td', facing: 'up' },
      },
      meta: { pot: '30' },
    });
  });

  test('cash public live hand supplies pot metadata', () => {
    const wire: WireRecord = {
      seq: 51,
      method: 'GET',
      url: '',
      urlSuffix: 'poker/cash/tables/table-a/state-for-agent',
      status: 200,
      requestBody: null,
      responseBody: {
        ok: true,
        table: { id: 'table-a' },
        seats: [],
        live: {
          tableId: 'table-a',
          handNumber: 15,
          board: [],
          pot: 30,
          seats: [],
        },
      },
      handId: null,
      handNumber: 15,
      coupId: null,
      shoeId: null,
      idempotencyKey: null,
    };
    const root = {
      surface: 'holdem-tray-3d',
      correlation: { hand: 'table-a:15', handNumber: 15 },
      dealStep: 'hole',
    } as CardParityRoot;
    expect(expectedFromWire(
      'holdem',
      root.surface,
      wire,
      undefined,
      { root, records: [wire] },
    ).meta).toEqual({ pot: '30' });
  });

  test('blackjack settled net uses raked outcome rather than gross top-level net', () => {
    const wire: WireRecord = {
      seq: 52,
      method: 'POST',
      url: '/api/cove/blackjack/hand/settle',
      urlSuffix: 'blackjack/hand/settle',
      status: 200,
      requestBody: null,
      responseBody: {
        net: '50',
        outcome: {
          rakedNet: '47',
          playerHands: [{
            cards: [
              { suit: 'spades', rank: 'A' },
              { suit: 'hearts', rank: 'K' },
            ],
            total: 21,
            outcome: 'blackjack',
          }],
          dealer: {
            cards: [
              { suit: 'clubs', rank: '10' },
              { suit: 'diamonds', rank: '9' },
            ],
            total: 19,
          },
        },
      },
      handId: 'blackjack-raked-net',
      handNumber: null,
      coupId: null,
      shoeId: 'shoe-raked-net',
      idempotencyKey: 'settle-raked-net',
    };
    const expected = expectedFromWire(
      'blackjack',
      'blackjack-3d',
      wire,
      undefined,
      {
        root: {
          surface: 'blackjack-3d',
          version: 2,
          instanceId: 'blackjack-raked-net',
          renderRevision: 1,
          correlation: { hand: 'blackjack-raked-net', handNumber: null },
          dealStep: 'settled',
          phase: 'settled',
          transition: 'idle',
          slots: [],
          meta: {},
        },
        records: [wire],
      },
    );
    expect(expected.meta.net).toBe('47');
    expect(expected.meta.net).not.toBe('50');
  });

  test('wrong, missing, extra, duplicate, and facing lies fail set equality', () => {
    const root = structuredClone(RECORDED_CASES[0]!.root);
    const expected = {
      slots: Object.fromEntries(root.slots.map((slot) => [
        slot.slot,
        {
          card: slot.card,
          facing: slot.facing,
          ...(slot.status ? { status: slot.status } : {}),
        },
      ])),
      meta: { ...root.meta },
    };
    const lied = structuredClone(root);
    const first = lied.slots[0]!;
    first.card = 'As' as typeof first.card;
    first.facing = 'down';
    lied.slots.splice(1, 1);
    lied.slots.push(
      { slot: 'extra-slot', facing: 'empty', card: '' },
      structuredClone(lied.slots[0]!),
    );
    const result = diffParity(expected, lied);
    expect(result.pass).toBe(false);
    expect(result.mismatches.some((item) => item.actual === '<duplicate>')).toBe(true);
    expect(result.mismatches.some((item) => item.actual === '<absent>')).toBe(true);
    expect(result.mismatches.some((item) => item.expected === '<absent>')).toBe(true);
    expect(result.mismatches.some((item) => item.field === 'facing')).toBe(true);
  });

  test('ordered checkpoint selector tolerates repeated semantic revisions', () => {
    const base = RECORDED_CASES[2]!.root;
    const roots = [
      { ...base, renderRevision: 1, dealStep: 'hole', transition: 'idle' },
      { ...base, renderRevision: 2, dealStep: 'flop', transition: 'revealing' },
      { ...base, renderRevision: 3, dealStep: 'flop', transition: 'revealing' },
      { ...base, renderRevision: 4, dealStep: 'turn', transition: 'revealing' },
      { ...base, renderRevision: 5, dealStep: 'river', transition: 'revealing' },
      { ...base, renderRevision: 6, dealStep: 'showdown', transition: 'revealing' },
      { ...base, renderRevision: 7, dealStep: 'showdown', transition: 'idle' },
    ] as CardParityRoot[];
    expect(assertOrderedDealSteps(
      roots,
      ['hole', 'flop', 'turn', 'river', 'showdown'],
    )).toMatchObject({ pass: true });
  });

  test('felt opponent universe and on-felt gate come from wire, not mirror slots', () => {
    const record: WireRecord = {
      seq: 41,
      method: 'GET',
      url: '/api/cove/holdem/session/current',
      urlSuffix: 'holdem/session/current',
      status: 200,
      requestBody: null,
      responseBody: {
        handId: 'practice-independent-slots',
        humanHole: [
          { suit: 'hearts', rank: 'A' },
          { suit: 'clubs', rank: 'K' },
        ],
        seats: Array.from({ length: 6 }, (_, seat) => ({
          seat,
          status: 'active',
        })),
        board: [],
      },
      handId: 'practice-independent-slots',
      handNumber: 1,
      coupId: null,
      shoeId: null,
      idempotencyKey: null,
    };
    const shell: CardParityRoot = {
      surface: 'holdem-felt-practice',
      version: 2,
      instanceId: 'recorded-felt',
      renderRevision: 5,
      correlation: { hand: 'practice-independent-slots', handNumber: 1 },
      dealStep: 'hole',
      phase: 'preflop',
      transition: 'idle',
      slots: [],
      meta: { 'on-felt': 'true' },
    };
    const expected = expectedFromWire(
      'holdem',
      shell.surface,
      record,
      undefined,
      { root: shell, records: [record] },
    );
    const complete: CardParityRoot = {
      ...shell,
      slots: Object.entries(expected.slots).map(([slot, value]) => ({
        slot,
        ...value,
      })),
    };
    const pass = assertParityCheckpoint({
      game: 'holdem',
      checkpoint: {
        label: 'felt-complete',
        surface: complete.surface,
        expectRevisionAdvance: true,
        expectDealStep: 'hole',
      },
      root: complete,
      records: [record],
    });
    expect(pass.pass).toBe(true);
    const missingOpponent = structuredClone(complete);
    missingOpponent.slots = missingOpponent.slots.filter(
      (slot) => slot.slot !== 'opp-5-2',
    );
    const fail = assertParityCheckpoint({
      game: 'holdem',
      checkpoint: {
        label: 'felt-missing-opponent',
        surface: missingOpponent.surface,
        expectRevisionAdvance: true,
        expectDealStep: 'hole',
      },
      root: missingOpponent,
      records: [record],
    });
    expect(fail.pass).toBe(false);
    expect(fail.mismatches).toContainEqual({
      slot: 'opp-5-2',
      field: 'card',
      expected: '',
      actual: '<absent>',
    });
    const offFelt = structuredClone(complete);
    offFelt.meta['on-felt'] = 'false';
    expect(assertParityCheckpoint({
      game: 'holdem',
      checkpoint: {
        label: 'felt-off-felt',
        surface: offFelt.surface,
        expectRevisionAdvance: true,
        expectDealStep: 'hole',
      },
      root: offFelt,
      records: [record],
    }).pass).toBe(false);
  });

  test('felt practice initialization explicitly certifies no wire without allowing a leak', () => {
    const root: CardParityRoot = {
      surface: 'holdem-felt-practice',
      version: 2,
      instanceId: 'felt-initialization',
      renderRevision: 2,
      correlation: { hand: '', handNumber: null },
      dealStep: 'hole',
      phase: 'idle',
      transition: 'idle',
      slots: [
        { slot: 'opp-1-1', facing: 'down', card: '', status: 'active' },
        { slot: 'opp-1-2', facing: 'down', card: '', status: 'active' },
      ],
      meta: { 'on-felt': 'true' },
    };
    const checkpoint = {
      label: 'every-step-1',
      surface: root.surface,
      expectRevisionAdvance: true,
      expectCorrelationHand: '',
      expectResolvedWire: '<none>',
    } as const;
    const result = assertParityCheckpoint({
      game: 'holdem',
      checkpoint,
      root,
      records: [],
    });
    expect(result).toMatchObject({
      pass: true,
      mismatches: [],
      resolvedWireSeq: null,
      expectedResolvedWire: '<none>',
    });

    const leaked = structuredClone(root);
    leaked.slots[0] = {
      slot: 'opp-1-1',
      facing: 'up',
      card: 'As' as CardParityRoot['slots'][number]['card'],
      status: 'active',
    };
    expect(assertParityCheckpoint({
      game: 'holdem',
      checkpoint,
      root: leaked,
      records: [],
    })).toMatchObject({
      pass: false,
      mismatches: [{
        slot: 'opp-1-1',
        field: 'facing',
        expected: 'down|empty',
        actual: 'up',
      }],
    });
  });

  test('cash felt uses fixed POV opponent slots and empties non-card seats', () => {
    const wire: WireRecord = {
      seq: 42,
      method: 'GET',
      url: '',
      urlSuffix: 'poker/cash/tables/table-a/state-for-agent',
      status: 200,
      requestBody: null,
      responseBody: {
        ok: true,
        view: {
          handNumber: 16,
          seatIndex: 3,
          holeCards: [],
          table: {
            tableId: 'cash:table-a',
            handNumber: 16,
            board: [],
            seats: [
              { seatIndex: 0, status: 'folded' },
              { seatIndex: 1, status: 'active' },
              { seatIndex: 3, status: 'active' },
              { seatIndex: 5, status: 'allin' },
            ],
          },
        },
      },
      handId: null,
      handNumber: 16,
      coupId: null,
      shoeId: null,
      idempotencyKey: null,
    };
    const root = {
      surface: 'holdem-felt-3d',
      correlation: { hand: 'table-a:16', handNumber: 16 },
      dealStep: 'hole',
    } as CardParityRoot;
    const expected = expectedFromWire(
      'holdem',
      root.surface,
      wire,
      undefined,
      { root, records: [wire] },
    );
    expect(expected.slots).toMatchObject({
      'opp-0-1': { facing: 'empty', status: 'folded' },
      'opp-1-1': { facing: 'down', status: 'active' },
      'opp-2-1': { facing: 'empty', status: 'active' },
      'opp-4-1': { facing: 'empty', status: 'active' },
      'opp-5-1': { facing: 'down', status: 'allin' },
    });
    expect(Object.keys(expected.slots).filter((slot) => slot.startsWith('opp-')))
      .toHaveLength(10);
    expect(expected.slots['opp-3-1']).toBeUndefined();
  });

  test('cash settled felt oracle reveals entitled shown cards and conceals folded seats', () => {
    const snapshot = {
      handId: 'table-a:17',
      tableId: 'table-a',
      handNumber: 17,
      board: [
        { suit: 'hearts', rank: 'A' },
        { suit: 'clubs', rank: 'K' },
        { suit: 'diamonds', rank: 'Q' },
        { suit: 'spades', rank: 'J' },
        { suit: 'hearts', rank: '10' },
      ],
      endedAt: 'showdown',
      pots: [{
        amount: '30',
        eligibleSeatIndices: [0, 2],
        awards: [{ seatIndex: 2, amount: '30' }],
        winningRank: { category: 4, categoryName: 'straight', tiebreakers: [14] },
      }],
      seats: [
        {
          seatIndex: 0,
          status: 'active',
          shown: [
            { suit: 'clubs', rank: '2' },
            { suit: 'diamonds', rank: '3' },
          ],
          net: '-10',
        },
        {
          seatIndex: 2,
          status: 'active',
          shown: [
            { suit: 'spades', rank: 'A' },
            { suit: 'spades', rank: 'K' },
          ],
          net: '20',
        },
        {
          seatIndex: 4,
          status: 'folded',
          shown: null,
          net: '-20',
        },
      ],
    };
    const settledWire: WireRecord = {
      seq: 43,
      method: 'GET',
      url: '',
      urlSuffix: 'poker/cash/tables/table-a/last-settled',
      status: 200,
      requestBody: null,
      responseBody: snapshot,
      handId: null,
      handNumber: 17,
      coupId: null,
      shoeId: null,
      idempotencyKey: null,
    };
    const privateWire: WireRecord = {
      ...settledWire,
      seq: 42,
      urlSuffix: 'poker/cash/tables/table-a/state-for-agent',
      responseBody: {
        ok: true,
        view: {
          handNumber: 17,
          seatIndex: 0,
          holeCards: [
            { suit: 'clubs', rank: '2' },
            { suit: 'diamonds', rank: '3' },
          ],
          table: { tableId: 'table-a', handNumber: 17, seats: [] },
        },
      },
    };
    const root = {
      surface: 'holdem-felt-3d',
      correlation: { hand: 'table-a:17', handNumber: 17 },
      dealStep: 'showdown',
    } as CardParityRoot;
    const expected = expectedFromWire(
      'holdem',
      root.surface,
      settledWire,
      snapshot,
      { root, records: [privateWire, settledWire] },
    );

    expect(expected.slots).toMatchObject({
      'opp-2-1': { facing: 'up', card: 'As', status: 'active' },
      'opp-2-2': { facing: 'up', card: 'Ks', status: 'active' },
      'opp-4-1': { facing: 'empty', card: '', status: 'folded' },
      'opp-4-2': { facing: 'empty', card: '', status: 'folded' },
    });
    expect(expected.slots['opp-0-1']).toBeUndefined();
    expect(expected.meta).toEqual({
      outcome: 'showdown',
      winners: '2',
      net: '-10',
      pot: '30',
      'banner-text': 'Showdown',
      'on-felt': 'true',
    });
  });

  test('a later negative-row revision leak fails even when the first is clean', () => {
    const recorded = RECORDED_CASES[0]!;
    const first = structuredClone(recorded.root);
    const laterLeak = structuredClone(recorded.root);
    laterLeak.renderRevision += 1;
    const hidden = laterLeak.slots.find((slot) => slot.facing === 'down');
    if (!hidden) throw new Error('recorded blackjack fixture lacks dealer hole');
    hidden.facing = 'up';
    hidden.card = 'As';
    const results = [first, laterLeak].map((root, index) =>
      assertParityCheckpoint({
        game: 'blackjack',
        checkpoint: {
          label: `negative-read-${index + 1}`,
          surface: root.surface,
          expectRevisionAdvance: true,
          expectDealStep: recorded.expectedDealStep,
        },
        root,
        records: recorded.records,
        previousRevision: index === 0 ? 0 : first.renderRevision,
      }));
    expect(results[0]?.pass).toBe(true);
    expect(results[1]?.pass).toBe(false);
    expect(results.every((result) => result.pass)).toBe(false);
    expect(results[1]?.mismatches).toContainEqual({
      slot: hidden.slot,
      field: 'card',
      expected: '',
      actual: 'As',
    });
  });

  test('practice settlement tray takes own hole cards from the terminal human seat', () => {
    const record: WireRecord = {
      seq: 42,
      method: 'POST',
      url: '/api/cove/holdem/action',
      urlSuffix: 'holdem/action',
      status: 200,
      requestBody: { action: 'check' },
      responseBody: {
        handId: 'practice-settled',
        status: 'settled',
        outcome: {
          endedAt: 'showdown',
          board: [],
          pots: [],
          seats: [
            {
              seat: 0,
              isHuman: true,
              holeCards: [
                { suit: 'diamonds', rank: '8' },
                { suit: 'spades', rank: '4' },
              ],
              status: 'active',
              net: '0',
            },
          ],
        },
      },
      handId: 'practice-settled',
      handNumber: 1,
      coupId: null,
      shoeId: null,
      idempotencyKey: null,
    };
    const expected = expectedFromWire(
      'holdem',
      'holdem-tray-practice',
      record,
      undefined,
      {
        root: {
          surface: 'holdem-tray-practice',
          version: 2,
          instanceId: 'practice-settled',
          renderRevision: 9,
          correlation: { hand: 'practice-settled', handNumber: 1 },
          dealStep: 'showdown',
          phase: 'showdown',
          transition: 'idle',
          slots: [],
          meta: {},
        },
        records: [record],
      },
    );
    expect(expected.slots['hole-1']).toEqual({
      card: '8d',
      facing: 'up',
    });
    expect(expected.slots['hole-2']).toEqual({
      card: '4s',
      facing: 'up',
    });
  });

  test('journal timestamps pin a root to its nearest same-endpoint wire', () => {
    const recorded = RECORDED_CASES[0]!;
    const root = {
      ...structuredClone(recorded.root),
      observedAt: 200,
    };
    const before = {
      ...structuredClone(recorded.records[0]!),
      seq: 10,
      capturedAt: 180,
    };
    const after = {
      ...structuredClone(recorded.records[0]!),
      seq: 11,
      capturedAt: 300,
      responseBody: { unrelated: 'later same-correlation state' },
    };
    const result = assertParityCheckpoint({
      game: 'blackjack',
      checkpoint: {
        label: 'negative-read-timestamped',
        surface: root.surface,
        expectRevisionAdvance: true,
      },
      root,
      records: [before, after],
    });
    expect(result.pass).toBe(true);
    expect(result.resolvedWireSeq).toBe(10);
  });
});
