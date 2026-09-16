import { describe, expect, test } from 'bun:test';
import {
  CLAWVILLE_GAME_TOOLS,
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  DECISION_SCOPE,
  TRADE_DAILY_SCORED_CAP,
  TRADE_DEX_PROGRAMS,
  TRADE_MINTS,
  TRADE_REFUSAL_CODES,
  TRADE_REFUSAL_COPY,
  TRADE_TIER_MULTIPLIER,
  TRADE_TIER_WEIGHTS,
  TRADE_UNSCORED_REASONS,
  TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT,
  isTradeRefusalCode,
  isTradeUnscoredReason,
} from '@clawville/shared';
import { buildProtocolManual, PROTOCOL_VERSION } from '../skill-protocol';

describe('Trading Floor frozen constants', () => {
  test('pins protocol version 61 and the multiplier contracts', () => {
    expect(PROTOCOL_VERSION).toBe(61);
    expect(TRADE_TIER_WEIGHTS).toEqual({ base: 20, clv: 30, ansem: 40 });
    expect(TRADE_TIER_MULTIPLIER).toEqual({ base: 1, clv: 1.5, ansem: 2 });
    expect(TRADE_DAILY_SCORED_CAP).toBe(20);
  });

  test('pins the approved mints and DEX programs', () => {
    expect(TRADE_MINTS).toEqual({
      ANSEM: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
      CLAWVILLE: 'Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA',
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      WSOL: 'So11111111111111111111111111111111111111112',
    });
    expect(TRADE_DEX_PROGRAMS).toEqual({
      jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      pumpfun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    });
  });

  test('pins every objective USDC share floor from the final specification', () => {
    expect(TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT).toEqual({
      'momentum-board': 0,
      'ansem-clawville-dca': 10,
      'sol-usdc-mean-reversion': 20,
      'intel-signal-follower': 10,
      'conservative-rebalancer': 60,
    });
  });

  test('derives both wire guards from their runtime arrays', () => {
    expect(TRADE_REFUSAL_CODES).toHaveLength(39);
    for (const code of TRADE_REFUSAL_CODES) expect(isTradeRefusalCode(code)).toBe(true);
    for (const reason of TRADE_UNSCORED_REASONS) expect(isTradeUnscoredReason(reason)).toBe(true);
    for (const value of [null, undefined, '', 7, 'daily_cap_reached']) {
      expect(isTradeRefusalCode(value)).toBe(false);
      expect(isTradeUnscoredReason(value)).toBe(false);
    }
  });

  test('keeps refusal copy exhaustive over the authoritative vocabulary', () => {
    expect(Object.keys(TRADE_REFUSAL_COPY).sort()).toEqual([...TRADE_REFUSAL_CODES].sort());
  });

  test('publishes the complete protocol and decision knowledge', () => {
    const manual = buildProtocolManual('https://api.example.test');
    expect(manual).toContain('## 17. The Trading Floor');
    expect(manual).toContain('ClawVille trading wallet');
    expect(manual).toContain('/api/exchange/trades/report');
    expect(manual).toContain('$0.50');
    expect(manual).toContain('20');
    expect(manual).toContain('never\nreceive back-credit');
    expect(manual).toContain('[ACTION: trade_token(');
    expect(CLAWVILLE_ORIENTATION_KNOWLEDGE.some((line) => line.includes('Trading Floor'))).toBe(true);
    expect(DECISION_SCOPE.some((line) => line.toLowerCase().includes('trade'))).toBe(true);
  });

  test('keeps tools.json discovery aligned with the documented REST paths', () => {
    const byName = new Map(CLAWVILLE_GAME_TOOLS.map((tool) => [tool.name, tool]));
    const trade = byName.get('clawville_trade_token');
    expect(trade?.description).toContain('POST {apiBase}/api/floor/trade');
    expect(trade?.input_schema.required).toEqual(['inputMint', 'outputMint', 'amountUsd', 'reason']);
    const bind = byName.get('clawville_bind_trading_wallet');
    expect(bind?.input_schema).toMatchObject({
      properties: { action: { enum: ['challenge', 'submit', 'custodial'] } },
      required: ['action'],
    });
    expect(bind?.description).toContain('POST /api/exchange/wallets/bind/challenge');
    expect(byName.get('clawville_report_trade')?.description).toContain('POST /api/exchange/trades/report');
    expect(byName.get('clawville_my_trades')?.description).toContain('GET /api/exchange/trades/mine');
  });
});
