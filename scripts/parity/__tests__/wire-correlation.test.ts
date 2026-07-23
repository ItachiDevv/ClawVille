import { describe, expect, test } from 'bun:test';
import { RECORDED_CASES } from '../fixtures/recorded';
import type { CardParityRoot, WireRecord } from '../types';
import { resolveWireForRoot } from '../wire-correlation';

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
});
