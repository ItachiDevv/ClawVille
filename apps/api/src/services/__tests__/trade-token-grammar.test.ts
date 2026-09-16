import { describe, expect, test } from 'bun:test';
import { TRADE_MINTS } from '@clawville/shared';
import { parseTradeTokenActionTag } from '../npc-simulation';

describe('trade_token strict grammar', () => {
  test('parses symbols and USD micros without floating point', () => {
    expect(parseTradeTokenActionTag(
      '[ACTION: trade_token(input_mint=USDC, output_mint=ANSEM, amount_usd=12.34, reason=momentum confirmed)]',
    )).toEqual({
      inputMint: TRADE_MINTS.USDC,
      outputMint: TRADE_MINTS.ANSEM,
      amountUsdMicros: 12_340_000n,
      reason: 'momentum confirmed',
    });
  });

  for (const amount of ['NaN', 'Infinity', '1e3', '+5', '.5', '5.', '1.234']) {
    test(`rejects amount ${amount}`, () => {
      expect(parseTradeTokenActionTag(
        `[ACTION: trade_token(input_mint=USDC, output_mint=SOL, amount_usd=${amount}, reason=test)]`,
      )).toBeNull();
    });
  }

  test('rejects reordered, duplicate, forbidden, non-ASCII, and oversized input', () => {
    const invalid = [
      '[ACTION: trade_token(output_mint=SOL, input_mint=USDC, amount_usd=1, reason=test)]',
      '[ACTION: trade_token(input_mint=USDC, input_mint=SOL, output_mint=SOL, amount_usd=1, reason=test)]',
      '[ACTION: trade_token(input_mint=USDC, output_mint=SOL, amount_usd=1, reason=has,comma)]',
      '[ACTION: trade_token(input_mint=USDC, output_mint=SOL, amount_usd=1, reason=has=equals)]',
      '[ACTION: trade_token(input_mint=USDC, output_mint=SOL, amount_usd=1, reason=emoji 🚀)]',
      `[ACTION: trade_token(input_mint=USDC, output_mint=SOL, amount_usd=1, reason=${'x'.repeat(241)})]`,
      '[ACTION: trade_token(input_mint=USDC, output_mint=SOL, amount_usd=1, reason=ok, amount_usd=999)]',
      '[ACTION: trade_token(input_mint=USDC, output_mint=SOL, amount_usd=1, reason=ok,input_mint=ANSEM)]',
      '[ACTION: trade_token(input_mint=USDC, output_mint=SOL, amount_usd=1, reason=close early) tail)]',
    ];
    for (const tag of invalid) expect(parseTradeTokenActionTag(tag)).toBeNull();
  });

  test('rejects bounded printable delimiter mutations', () => {
    const forbidden = [',', '=', '(', ')', '[', ']'];
    for (const char of forbidden) {
      expect(parseTradeTokenActionTag(
        `[ACTION: trade_token(input_mint=USDC, output_mint=SOL, amount_usd=1.00, reason=left${char}right)]`,
      )).toBeNull();
    }
  });
});
