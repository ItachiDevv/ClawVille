import { afterEach, describe, expect, test } from 'bun:test';
import { assertTradingLimitsWithinCode } from '@clawville/shared';

const names = [
  'TRADING_MAX_TRADE_USD',
  'TRADING_MIN_SOL_RESERVE_LAMPORTS',
  'TRADING_MIN_USDC_RESERVE_MICROS',
  'TRADING_MIN_TRADE_USD',
  'TRADING_COOLDOWN_S',
  'TRADING_MAX_PRIORITY_FEE_LAMPORTS',
] as const;
const original = new Map(names.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of names) {
    const value = original.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe.serial('Trading Floor environment directions', () => {
  test('risk environments may lower a ceiling but cannot raise it', () => {
    process.env.TRADING_MAX_TRADE_USD = '24';
    expect(assertTradingLimitsWithinCode().maxTradeUsd).toBe(24);
    process.env.TRADING_MAX_TRADE_USD = '26';
    expect(() => assertTradingLimitsWithinCode()).toThrow('exceeds compiled ceiling');
  });

  test('reserve environments may raise a floor but cannot lower it', () => {
    process.env.TRADING_MIN_SOL_RESERVE_LAMPORTS = '20000001';
    process.env.TRADING_MIN_USDC_RESERVE_MICROS = '2000001';
    expect(assertTradingLimitsWithinCode().minSolReserveLamports).toBe(20_000_001n);
    process.env.TRADING_MIN_SOL_RESERVE_LAMPORTS = '19999999';
    expect(() => assertTradingLimitsWithinCode()).toThrow('below the compiled reserve floor');
  });

  test('the cooldown has a compiled floor and the priority-fee cap a compiled ceiling', () => {
    process.env.TRADING_COOLDOWN_S = '61';
    expect(assertTradingLimitsWithinCode().cooldownSeconds).toBe(61);
    process.env.TRADING_COOLDOWN_S = '0';
    expect(() => assertTradingLimitsWithinCode()).toThrow('below the compiled cooldown floor');
    delete process.env.TRADING_COOLDOWN_S;
    process.env.TRADING_MAX_PRIORITY_FEE_LAMPORTS = '999999';
    expect(assertTradingLimitsWithinCode().maxPriorityFeeLamports).toBe(999_999n);
    process.env.TRADING_MAX_PRIORITY_FEE_LAMPORTS = '1000001';
    expect(() => assertTradingLimitsWithinCode()).toThrow('exceeds compiled ceiling');
  });

  test('the trade minimum cannot undercut the core scoring minimum', () => {
    process.env.TRADING_MIN_TRADE_USD = '0.49';
    expect(() => assertTradingLimitsWithinCode()).toThrow('below the scoring minimum');
  });
});
