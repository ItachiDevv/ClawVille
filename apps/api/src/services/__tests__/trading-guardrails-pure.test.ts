import { describe, expect, test } from 'bun:test';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { TRADE_MINTS } from '@clawville/shared';
import { alertPriceDecimalsMismatch, findPriceDecimalsMismatch, readTradingUsdcBalanceRpc, TRADING_BALANCE_RPC_TIMEOUT_MS } from '../trading-guardrails';

function price(mint: string, decimals: number) {
  return {
    mint,
    usdPrice: 1,
    blockId: 1,
    decimals,
    liquidity: null,
    priceChange24h: null,
    createdAt: null,
    launchpad: null,
    fetchedAt: 1,
  };
}

describe('Trading Floor guardrail pure checks', () => {
  test('detects Jupiter and on-chain decimal mismatches for either requested mint', () => {
    const infos = [TRADE_MINTS.USDC, TRADE_MINTS.WSOL].map((mint, index) => ({
      mint,
      decimals: index === 0 ? 6 : 9,
      programId: TOKEN_PROGRAM_ID,
      extensions: [],
      mintAuthority: null,
      freezeAuthority: null,
    }));
    const matching = new Map([
      [TRADE_MINTS.USDC, price(TRADE_MINTS.USDC, 6)],
      [TRADE_MINTS.WSOL, price(TRADE_MINTS.WSOL, 9)],
    ]);
    expect(findPriceDecimalsMismatch(matching, infos)).toBeNull();
    const inputMismatch = new Map(matching);
    inputMismatch.set(TRADE_MINTS.USDC, price(TRADE_MINTS.USDC, 9));
    expect(findPriceDecimalsMismatch(inputMismatch, infos)).toEqual({ mint: TRADE_MINTS.USDC, onChain: 6, jupiter: 9 });
    const outputMismatch = new Map(matching);
    outputMismatch.set(TRADE_MINTS.WSOL, price(TRADE_MINTS.WSOL, 6));
    expect(findPriceDecimalsMismatch(outputMismatch, infos)).toEqual({ mint: TRADE_MINTS.WSOL, onChain: 9, jupiter: 6 });
  });

  test('pages critical before the decimals_mismatch refusal path', async () => {
    const info = {
      mint: TRADE_MINTS.USDC,
      decimals: 6,
      programId: TOKEN_PROGRAM_ID,
      extensions: [],
      mintAuthority: null,
      freezeAuthority: null,
    };
    const alerts: Array<{ severity: string }> = [];
    const mismatch = await alertPriceDecimalsMismatch(
      new Map([[TRADE_MINTS.USDC, price(TRADE_MINTS.USDC, 9)]]),
      [info],
      async (input) => { alerts.push(input); },
    );
    expect(mismatch).toEqual({ mint: TRADE_MINTS.USDC, onChain: 6, jupiter: 9 });
    expect(alerts).toEqual([expect.objectContaining({ severity: 'critical' })]);
    const source = await Bun.file(new URL('../trading-guardrails.ts', import.meta.url)).text();
    expect(source).toContain("recordRefusal(intent, 'decimals_mismatch'");
  });

  test('wires the admission AbortSignal into the raw balance transport', async () => {
    expect(TRADING_BALANCE_RPC_TIMEOUT_MS).toBe(4_000);
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null = null;
    const amount = await readTradingUsdcBalanceRpc({
      rpcEndpoint: 'https://mainnet.invalid',
      ata: 'ata',
      signal: controller.signal,
      fetchImpl: (async (_url, init) => {
        receivedSignal = init?.signal as AbortSignal;
        return Response.json({ result: { value: { amount: '1234567' } } });
      }) as typeof fetch,
    });
    expect(receivedSignal === controller.signal).toBe(true);
    expect(amount).toBe(1_234_567n);
  });
});
