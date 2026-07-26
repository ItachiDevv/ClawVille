import { describe, expect, test } from 'bun:test';
import { RECORDED_CASES } from '../fixtures/recorded';
import type { CardParityRoot, WireRecord } from '../types';
import {
  resolveWireForCheckpoint,
  resolveWireForRoot,
} from '../wire-correlation';

function baseRecord(overrides: Partial<WireRecord>): WireRecord {
  return {
    seq: 1,
    method: 'GET',
    url: '',
    urlSuffix: '',
    status: 200,
    requestBody: null,
    responseBody: null,
    handId: null,
    handNumber: null,
    coupId: null,
    shoeId: null,
    idempotencyKey: null,
    ...overrides,
  };
}

describe('immutable application correlation', () => {
  test('W-D nested lastCoup.coupId resolves without generic id ambiguity', () => {
    const root = structuredClone(RECORDED_CASES[2]!.root);
    root.correlation.hand = 'last-coup';
    const record = baseRecord({
      urlSuffix: 'baccarat/session/current',
      responseBody: {
        shoe: { id: 'shoe-id-must-not-win' },
        lastCoup: { coupId: 'last-coup', outcome: {} },
      },
    });
    expect(resolveWireForRoot(root, [record])).toBe(record);
  });

  test('cash key requires exact table and hand number', () => {
    const root = {
      ...RECORDED_CASES[3]!.root,
      surface: 'holdem-tray-3d',
      correlation: { hand: 'table-a:14', handNumber: 14 },
    } as CardParityRoot;
    const wrong = baseRecord({
      seq: 1,
      urlSuffix: 'poker/cash/tables/table-b/state',
      handNumber: 14,
      responseBody: { handNumber: 14 },
    });
    const right = baseRecord({
      seq: 2,
      urlSuffix: 'poker/cash/tables/table-a/state',
      handNumber: 14,
      responseBody: { handNumber: 14 },
    });
    expect(resolveWireForRoot(root, [wrong])).toBeNull();
    expect(resolveWireForRoot(root, [wrong, right])).toBe(right);
  });

  test('cash nonterminal checkpoint prefers private live view over later settlement', () => {
    const root = {
      ...RECORDED_CASES[3]!.root,
      surface: 'holdem-tray-3d',
      dealStep: 'hole',
      correlation: { hand: 'table-a:14', handNumber: 14 },
    } as CardParityRoot;
    const live = baseRecord({
      seq: 10,
      urlSuffix: 'poker/cash/tables/table-a/state-for-agent',
      handNumber: 14,
      responseBody: {
        view: {
          handNumber: 14,
          table: { tableId: 'cash:table-a', handNumber: 14, pot: 30 },
          holeCards: [],
        },
      },
    });
    const settled = baseRecord({
      seq: 20,
      urlSuffix: 'poker/cash/tables/table-a/last-settled',
      handNumber: 14,
      responseBody: {
        snapshot: { tableId: 'table-a', handNumber: 14, pot: 30 },
      },
    });
    expect(resolveWireForRoot(root, [live, settled])).toBe(live);
    expect(resolveWireForRoot(root, [settled])).toBeNull();
  });

  test('practice does not match a different hand with the same index', () => {
    const root = RECORDED_CASES[3]!.root;
    const wrong = baseRecord({
      handId: 'other-hand',
      handNumber: root.correlation.handNumber,
      responseBody: {
        handId: 'other-hand',
        handIndex: root.correlation.handNumber,
      },
    });
    expect(resolveWireForRoot(root, [wrong])).toBeNull();
  });

  test('attributes two consecutive coups to each current checkpoint', () => {
    const firstRoot = structuredClone(RECORDED_CASES[2]!.root);
    firstRoot.correlation.hand = 'coup-1';
    const secondRoot = structuredClone(firstRoot);
    secondRoot.renderRevision += 10;
    secondRoot.correlation.hand = 'coup-2';
    const first = baseRecord({
      seq: 10,
      urlSuffix: 'baccarat/session/current',
      coupId: 'stale-capture-summary',
      responseBody: {
        lastCoup: { coupId: 'coup-1', outcome: { bet: 'player' } },
      },
    });
    const second = baseRecord({
      seq: 20,
      urlSuffix: 'baccarat/session/current',
      coupId: 'stale-capture-summary',
      responseBody: {
        lastCoup: { coupId: 'coup-2', outcome: { bet: 'banker' } },
      },
    });

    expect(resolveWireForCheckpoint(firstRoot, [first, second], null)).toBe(first);
    expect(resolveWireForCheckpoint(firstRoot, [first, second], 'coup-1')).toBeNull();
    expect(resolveWireForCheckpoint(secondRoot, [first, second], 'coup-1')).toBe(second);
  });
});
