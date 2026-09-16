import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TRADE_MINTS } from '@clawville/shared';
import { toTradingBaselineEvidence, type TradingWalletEquity } from '../trading-fleet-equity';

describe('Trading Floor arm baseline evidence', () => {
  test('serializes a complete JSON-safe snapshot including zero positions', () => {
    const equity: TradingWalletEquity = {
      slot: 123,
      equityUsdMicros: 42_000_000n,
      nativeLamports: 2_000_000n,
      positions: Object.entries(TRADE_MINTS).map(([symbol, mint], index) => ({
        symbol: symbol === 'WSOL' ? 'SOL' : symbol,
        mint,
        amountAtomic: index === 0 ? 2_000_000n : 0n,
        decimals: index === 0 ? 9 : 6,
        valueUsdMicros: index === 0 ? 42_000_000n : 0n,
        priceUsdMicros: index === 0 ? 21_000_000_000n : 1_000_000n,
        priceTimestampMs: 1_789_000_000_000,
      })),
    };
    const evidence = toTradingBaselineEvidence(equity);
    expect(evidence).toEqual({
      slot: 123,
      equityUsdMicros: '42000000',
      nativeLamports: '2000000',
      positions: equity.positions.map((position) => ({
        symbol: position.symbol,
        mint: position.mint,
        amountAtomic: position.amountAtomic.toString(),
        decimals: position.decimals,
        valueUsdMicros: position.valueUsdMicros.toString(),
        priceUsdMicros: position.priceUsdMicros.toString(),
        priceTimestampMs: position.priceTimestampMs,
      })),
    });
    expect(evidence.positions).toHaveLength(4);
    expect(evidence.positions.filter((position) => position.amountAtomic === '0')).toHaveLength(3);
    expect(() => JSON.stringify(evidence)).not.toThrow();
  });

  test('writes baseline evidence in the same write-once arm update', () => {
    const services = resolve(import.meta.dir, '..');
    const links = readFileSync(resolve(services, 'trading-links.ts'), 'utf8');
    const route = readFileSync(resolve(services, '../routes/admin-trading.ts'), 'utf8');
    const updateStart = links.indexOf('tx.update(clawpumpAgentLinks).set({');
    const updateEnd = links.indexOf('}).where(', updateStart);
    const armUpdate = links.slice(updateStart, updateEnd);
    expect(armUpdate).toContain('baselineEvidence: input.baselineEvidence');
    expect(links.slice(updateEnd, links.indexOf('.returning()', updateEnd))).toContain('eq(clawpumpAgentLinks.armed, false)');
    expect(route).toContain('baselineEvidence: toTradingBaselineEvidence(equity)');
  });

  test('drawdown uses only the armed cohort and its stored evidence', () => {
    const guardrails = readFileSync(resolve(import.meta.dir, '../trading-guardrails.ts'), 'utf8');
    const start = guardrails.indexOf('export async function evaluateFleetDrawdown');
    const end = guardrails.indexOf('\nexport function startTradingDrawdownPoller', start);
    const source = guardrails.slice(start, end);
    expect(source).toContain('eq(clawpumpAgentLinks.operatedByClawville, true)');
    expect(source).toContain('eq(clawpumpAgentLinks.armed, true)');
    expect(source).toContain('baseline.equityUsdMicros');
    expect(source).not.toContain('link.floatStartUsdMicros');
  });
});
