import { describe, expect, test } from 'bun:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  chainErrorCode, chainRetryJitterMs, chainVerdictDue, isTransientChainError, lpLockFail, mintRuleFails, poolReserveFail, runChainCheck, top10Percent, verdictFromCodes,
  type ChainRpc, type ParsedAccount, type RawAccount,
} from './chain-checks';

const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMP_CURVE = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RAYDIUM_LOCK_CP_AUTHORITY = '3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const NOW = new Date(Date.UTC(2026, 8, 30, 12, 0, 0));

const key = () => Keypair.generate().publicKey.toBase58();

function mintAccount(over: Record<string, unknown> = {}, owner = SPL): ParsedAccount {
  return { owner, parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000000', mintAuthority: null, freezeAuthority: null, ...over } } };
}

/** PumpSwap pool: lp_mint at 107..139, vaults at 139..171 / 171..203. */
function pumpswapPool(lpMint: string, baseVault: string, quoteVault: string): RawAccount {
  const data = new Uint8Array(300);
  data.set(new PublicKey(lpMint).toBytes(), 107);
  data.set(new PublicKey(baseVault).toBytes(), 139);
  data.set(new PublicKey(quoteVault).toBytes(), 171);
  return { owner: PUMPSWAP, data };
}

class FakeRpc implements ChainRpc {
  parsed = new Map<string, ParsedAccount>();
  raw = new Map<string, RawAccount>();
  largest = new Map<string, Array<{ address: string; amount: string }>>();
  owners = new Map<string, string>();
  calls = 0;
  async getParsedAccount(address: string) { this.calls += 1; return this.parsed.get(address) ?? null; }
  async getRawAccount(address: string) { this.calls += 1; return this.raw.get(address) ?? null; }
  async getParsedAccounts(addresses: readonly string[]) { this.calls += 1; return addresses.map((a) => this.parsed.get(a) ?? null); }
  async getAccountOwners(addresses: readonly string[]) { this.calls += 1; return addresses.map((a) => this.owners.get(a) ?? null); }
  async getTokenLargestAccounts(mint: string) { this.calls += 1; return this.largest.get(mint) ?? []; }
  async getClmmPositions() { this.calls += 1; return []; }
}

function tokenAccount(owner: string, mint = key(), uiAmountString = '0'): ParsedAccount {
  return { owner: SPL, parsed: { type: 'account', info: { owner, mint, tokenAmount: { uiAmountString } } } };
}

describe('mint rules (authorities, Token-2022 allow-list)', () => {
  test('authorities revoked on a plain SPL mint pass', () => {
    expect(mintRuleFails(mintAccount())).toMatchObject({ fails: [], decimals: 6, tokenProgram: 'spl' });
  });

  test('live mint or freeze authority fails', () => {
    expect(mintRuleFails(mintAccount({ mintAuthority: key(), freezeAuthority: key() })).fails).toEqual(['mint_authority', 'freeze_authority']);
  });

  test('Token-2022: a zero fee passes, any fee in either slot fails, unreadable fee fails', () => {
    const fee = (newer: unknown, older: unknown) => mintAccount({ extensions: [{ extension: 'transferFeeConfig', state: {
      newerTransferFee: { transferFeeBasisPoints: newer }, olderTransferFee: { transferFeeBasisPoints: older },
    } }] }, T22);
    expect(mintRuleFails(fee(0, 0)).fails).toEqual([]);
    expect(mintRuleFails(fee(0, 100)).fails).toEqual(['t22_transfer_fee']);
    expect(mintRuleFails(fee('x', 0)).fails).toEqual(['t22_transfer_fee']);
  });

  test('Token-2022: extensions outside the allow-list fail; frozen default state fails', () => {
    const acc = mintAccount({ extensions: [
      { extension: 'metadataPointer', state: {} },
      { extension: 'permanentDelegate', state: {} },
      { extension: 'defaultAccountState', state: { accountState: 'frozen' } },
    ] }, T22);
    expect(mintRuleFails(acc).fails).toEqual(['t22_permanentDelegate', 't22_default_frozen']);
  });

  test('unreadable or non-token accounts fail closed', () => {
    expect(mintRuleFails(null).fails).toEqual(['mint_unreadable']);
    expect(mintRuleFails({ owner: key(), parsed: null }).fails).toEqual(['mint_not_token']);
  });
});

describe('LP lock and pool reserves', () => {
  test('a launch-curve pool is OK (the program holds the reserves)', async () => {
    expect(await lpLockFail(new FakeRpc(), { owner: PUMP_CURVE, data: new Uint8Array(10) }, 'x')).toBeNull();
  });

  test('an unknown pool program fails as unverifiable; a missing pool fails', async () => {
    expect(await lpLockFail(new FakeRpc(), { owner: key(), data: new Uint8Array(10) }, 'x')).toBe('lp_unverifiable_dex');
    expect(await lpLockFail(new FakeRpc(), null, 'x')).toBe('lp_pool_unreadable');
  });

  test('PumpSwap: burned LP (supply 0) passes; LP held by a wallet fails; LP in the Raydium lock passes', async () => {
    const rpc = new FakeRpc();
    const lp = key();
    const pool = pumpswapPool(lp, key(), key());
    rpc.parsed.set(lp, { owner: SPL, parsed: { type: 'mint', info: { supply: '0', decimals: 9 } } });
    expect(await lpLockFail(rpc, pool, 'pool')).toBeNull();

    const holder = key();
    rpc.parsed.set(lp, { owner: SPL, parsed: { type: 'mint', info: { supply: '1000', decimals: 9 } } });
    rpc.largest.set(lp, [{ address: holder, amount: '1000' }]);
    rpc.parsed.set(holder, tokenAccount(key()));
    expect(await lpLockFail(rpc, pool, 'pool')).toBe('lp_not_locked');

    rpc.parsed.set(holder, tokenAccount(RAYDIUM_LOCK_CP_AUTHORITY));
    expect(await lpLockFail(rpc, pool, 'pool')).toBeNull();

    // 94 % locked is not enough (95 % rule).
    const other = key();
    rpc.largest.set(lp, [{ address: holder, amount: '940' }, { address: other, amount: '60' }]);
    rpc.parsed.set(other, tokenAccount(key()));
    expect(await lpLockFail(rpc, pool, 'pool')).toBe('lp_not_locked');
  });

  test('pulled pool: the SOL or USDC side must hold max($5k, a quarter of the claimed side)', async () => {
    const rpc = new FakeRpc();
    const baseVault = key();
    const quoteVault = key();
    const pool = pumpswapPool(key(), baseVault, quoteVault);
    rpc.parsed.set(baseVault, tokenAccount(key(), key(), '1000000'));
    rpc.parsed.set(quoteVault, tokenAccount(key(), WSOL, '10'));
    // 10 SOL x $200 = $2,000 < $5,000
    expect(await poolReserveFail(rpc, pool, 30_000, 200)).toBe('pool_reserves_low');
    rpc.parsed.set(quoteVault, tokenAccount(key(), WSOL, '100'));
    expect(await poolReserveFail(rpc, pool, 30_000, 200)).toBeNull();
    // DexScreener claims $400k liquidity: side must hold >= $50k.
    expect(await poolReserveFail(rpc, pool, 400_000, 200)).toBe('pool_reserves_low');
    // No SOL price: fail closed.
    expect(await poolReserveFail(rpc, pool, 30_000, null)).toBe('pool_reserves_unpriced');
    rpc.parsed.set(quoteVault, tokenAccount(key(), USDC, '6000'));
    expect(await poolReserveFail(rpc, pool, 30_000, null)).toBeNull();
  });
});

describe('top-10 share and the full verdict', () => {
  test('the pool account (closest to DexScreener liq.base, within 15%) is removed', () => {
    const supply = 1_000_000n;
    // Pool holds 500k (liq.base 510k): removed; the rest of the top 10 sum to 200k = 20%.
    expect(top10Percent([500_000n, 100_000n, 60_000n, 40_000n], supply, 510_000n)).toBeCloseTo(20, 6);
    // No account near liq.base: nothing removed.
    expect(top10Percent([500_000n, 100_000n], supply, 900_000n)).toBeCloseTo(60, 6);
    expect(top10Percent([1n], 0n, 0n)).toBe(100);
  });

  test('verdict maps granular codes to hard-rule ids and keeps the codes', () => {
    const base = { checkedAt: NOW.toISOString(), pairAddress: 'p', top10Pct: 10 };
    expect(verdictFromCodes([], base)).toMatchObject({ pass: true, fails: [], codes: [] });
    expect(verdictFromCodes(['mint_authority', 'lp_not_locked', 't22_permanentDelegate', 't22_transfer_fee'], base))
      .toMatchObject({ pass: false, fails: ['mint-authority', 'lp-locked', 't22-fee'] });
    expect(verdictFromCodes(['mint_unreadable'], base)).toMatchObject({ pass: false, fails: [], error: 'mint_unreadable' });
  });

  test('a good PumpSwap coin passes with decimals and top-10 recorded; mint fails skip the pool reads', async () => {
    const rpc = new FakeRpc();
    const mint = key();
    const lp = key();
    const baseVault = key();
    const quoteVault = key();
    const pair = key();
    rpc.parsed.set(mint, mintAccount());
    rpc.raw.set(pair, pumpswapPool(lp, baseVault, quoteVault));
    rpc.parsed.set(lp, { owner: SPL, parsed: { type: 'mint', info: { supply: '0', decimals: 9 } } });
    rpc.parsed.set(baseVault, tokenAccount(key(), mint, '500000'));
    rpc.parsed.set(quoteVault, tokenAccount(key(), USDC, '20000'));
    rpc.largest.set(mint, [{ address: key(), amount: '500000000000' }, { address: key(), amount: '50000000000' }]);
    const verdict = await runChainCheck(rpc, mint, { pairAddress: pair, liqUsd: 40_000, liqBase: 500_000 }, 200, NOW);
    expect(verdict).toMatchObject({ pass: true, fails: [], codes: [], decimals: 6, pairAddress: pair, tokenProgram: 'spl' });
    expect(verdict.top10Pct).toBeCloseTo(5, 6);

    const bad = new FakeRpc();
    bad.parsed.set(mint, mintAccount({ freezeAuthority: key() }));
    const failed = await runChainCheck(bad, mint, { pairAddress: pair, liqUsd: 40_000, liqBase: 1 }, 200, NOW);
    expect(failed).toMatchObject({ pass: false, fails: ['freeze-authority'], codes: ['freeze_authority'] });
    expect(bad.calls).toBe(1);
  });

  test('an RPC error fails closed as "not verified" and never stores a URL', async () => {
    const rpc = new FakeRpc();
    rpc.getParsedAccount = async () => { throw new Error('fetch failed https://mainnet.helius-rpc.com/?api-key=SECRET'); };
    const verdict = await runChainCheck(rpc, key(), { pairAddress: 'p', liqUsd: 1, liqBase: 1 }, 200, NOW);
    expect(verdict.pass).toBe(false);
    expect(verdict.fails).toEqual([]);
    expect(verdict.error).toBe('chain_check_error: rpc_error');
    expect(verdict.error).not.toContain('SECRET');
  });

  test('verdict errors are codes only, never RPC or vendor text (Codex r2 #7)', () => {
    expect(chainErrorCode(new Error('429 Too Many Requests: {"jsonrpc":"2.0"} <script>'))).toBe('rpc_rate_limited');
    expect(chainErrorCode(new Error('chain check exceeded 25000ms'))).toBe('deadline');
    expect(chainErrorCode(new Error('request timed out'))).toBe('rpc_timeout');
    expect(chainErrorCode(new Error('Invalid public key input'))).toBe('bad_address');
    expect(chainErrorCode('anything else')).toBe('rpc_error');
  });

  test('re-check timing: transient errors after 2 min + per-mint jitter; pass / fail / other errors after 30 min', () => {
    const mint = key();
    const jitter = chainRetryJitterMs(mint);
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThan(60_000);
    expect(chainRetryJitterMs(mint)).toBe(jitter);
    const at = NOW.getTime();
    const row = (error: string | null) => ({ mint, checkedAtMs: at, error, pairChanged: false });
    for (const code of ['rpc_rate_limited', 'rpc_timeout', 'rpc_error', 'deadline']) {
      expect(isTransientChainError(`chain_check_error: ${code}`)).toBe(true);
      expect(chainVerdictDue(row(`chain_check_error: ${code}`), at + 120_000 + jitter - 1)).toBe(false);
      expect(chainVerdictDue(row(`chain_check_error: ${code}`), at + 120_000 + jitter)).toBe(true);
    }
    // A pass / fail verdict and a non-transient error keep the 30-min TTL.
    for (const error of [null, 'mint_unreadable', 'chain_check_error: pool_account_short']) {
      expect(chainVerdictDue(row(error), at + 29 * 60_000)).toBe(false);
      expect(chainVerdictDue(row(error), at + 30 * 60_000)).toBe(true);
    }
    // Never checked, or checked for another pair: due now.
    expect(chainVerdictDue({ mint, checkedAtMs: null, error: null, pairChanged: false }, at)).toBe(true);
    expect(chainVerdictDue({ mint, checkedAtMs: at, error: null, pairChanged: true }, at)).toBe(true);
  });

  test('retry jitter spreads a burst of mints over the minute', () => {
    const buckets = new Set(Array.from({ length: 200 }, () => Math.floor(chainRetryJitterMs(key()) / 10_000)));
    expect(buckets.size).toBe(6);
  });

  test('a Token-2022 extension name that is not a plain identifier becomes t22_unknown', () => {
    const acc = mintAccount({ extensions: [{ extension: 'evil<b>‮', state: {} }] }, T22);
    expect(mintRuleFails(acc).fails).toEqual(['t22_unknown']);
  });
});
