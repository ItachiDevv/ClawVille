import { describe, expect, test } from 'bun:test';
import { assertMoneyFromWire } from '../money';
import type { WireRecord } from '../types';

function wire(
  seq: number,
  urlSuffix: string,
  responseBody: unknown,
): WireRecord {
  return {
    seq,
    method: seq === 1 ? 'POST' : 'GET',
    url: `/api/cove/${urlSuffix}`,
    urlSuffix,
    status: 200,
    requestBody: null,
    responseBody,
    handId: 'money-hand',
    handNumber: null,
    coupId: null,
    shoeId: 'money-shoe',
    idempotencyKey: null,
  };
}

describe('wire money equations', () => {
  test('blackjack starts from session/open, never the post-stake deal balance', () => {
    const records = [
      wire(1, 'blackjack/session/open', { walletBalance: 1_000 }),
      wire(2, 'blackjack/hand/deal', { balance: 975, walletBalance: 975 }),
      wire(3, 'blackjack/hand/stand', {
        balance: 1_025,
        outcome: {
          totalBet: '25',
          rakedPayout: '50',
          rakedNet: '25',
        },
      }),
    ];
    expect(assertMoneyFromWire(
      'blackjack',
      records[2]!,
      records,
    )).toMatchObject({
      pass: true,
      values: { initial: '1000', final: '1025' },
    });
  });

  test('baccarat enforces banker commission integer rounding', () => {
    const records = [
      wire(1, 'baccarat/session/open', { walletBalance: 100 }),
      wire(2, 'baccarat/coup', {
        balance: 101,
        outcome: {
          bet: 'banker',
          winner: 'banker',
          stake: '1',
          payout: '2',
          net: '1',
          commission: '1',
        },
      }),
    ];
    expect(assertMoneyFromWire('baccarat', records[1]!, records).pass).toBe(true);
    const lied = structuredClone(records);
    (lied[1]!.responseBody as {
      outcome: { commission: string };
    }).outcome.commission = '0';
    expect(assertMoneyFromWire('baccarat', lied[1]!, lied).pass).toBe(false);
  });

  test('baccarat player/banker tie is a zero-net push with zero commission', () => {
    const records = [
      wire(1, 'baccarat/session/open', { walletBalance: 100 }),
      wire(2, 'baccarat/coup', {
        balance: 100,
        outcome: {
          bet: 'player',
          winner: 'tie',
          stake: '25',
          payout: '25',
          net: '0',
          commission: '0',
        },
      }),
    ];
    expect(assertMoneyFromWire('baccarat', records[1]!, records)).toMatchObject({
      pass: true,
      values: {
        commission: '0',
        expectedCommission: '0',
        net: '0',
      },
    });
  });
});
