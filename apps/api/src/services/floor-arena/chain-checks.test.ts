import { describe, expect, spyOn, test } from 'bun:test';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  chainErrorCode, chainRetryJitterMs, chainVerdictDue, entryVerdictStatus, isTransientChainError, lpLockFail, mintRuleFails,
  orderDueChainChecks, pickDueChainChecks, poolReserveFail, runChainCheck, runChainCheckTick, storeChainVerdict, top10Percent,
  verdictFromCodes, web3ChainRpc, type ArenaChainVerdict, type ChainRpc, type DueRow, type ParsedAccount, type RawAccount,
} from './chain-checks';
import type { FloorArenaSnapshot } from './filters';

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
  /** Every RPC round trip by method name (Helius budget: per-check call counts). */
  log: string[] = [];
  private count(method: string) { this.calls += 1; this.log.push(method); }
  async getParsedAccount(address: string) { this.count('getParsedAccount'); return this.parsed.get(address) ?? null; }
  async getMintAndPool(mint: string, pair: string | null) {
    this.count('getMintAndPool');
    return { mint: this.parsed.get(mint) ?? null, pool: pair ? this.raw.get(pair) ?? null : undefined };
  }
  async getRawAccount(address: string) { this.count('getRawAccount'); return this.raw.get(address) ?? null; }
  async getParsedAccounts(addresses: readonly string[]) { this.count('getParsedAccounts'); return addresses.map((a) => this.parsed.get(a) ?? null); }
  async getAccountOwners(addresses: readonly string[]) { this.count('getAccountOwners'); return addresses.map((a) => this.owners.get(a) ?? null); }
  async getTokenLargestAccounts(mint: string) { this.count('getTokenLargestAccounts'); return this.largest.get(mint) ?? []; }
  async getClmmPositions() { this.count('getClmmPositions'); return []; }
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
    rpc.getMintAndPool = async () => { throw new Error('fetch failed https://mainnet.helius-rpc.com/?api-key=SECRET'); };
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

  test('D28 entry gate: a pass verdict counts under 30 min only, and only for the pair priced now', () => {
    const now = NOW.getTime();
    const pass = { pass: true, fails: [], codes: [], checkedAt: new Date(now - 29 * 60_000).toISOString(), pairAddress: 'P', top10Pct: 12 };
    expect(entryVerdictStatus(pass, now - 29 * 60_000, 'P', now)).toEqual({ verdict: 'pass', top10Pct: 12, checkedAtMs: now - 29 * 60_000 });
    expect(entryVerdictStatus(pass, now - 31 * 60_000, 'P', now)).toMatchObject({ verdict: 'stale', checkedAtMs: now - 31 * 60_000 });
    expect(entryVerdictStatus(pass, now - 30 * 60_000, 'P', now).verdict).toBe('stale');   // due for re-check = stale
    // The column wins; the verdict's own checkedAt is the fallback.
    expect(entryVerdictStatus(pass, null, 'P', now).verdict).toBe('pass');
    expect(entryVerdictStatus({ ...pass, checkedAt: 'x' }, null, 'P', now).verdict).toBe('stale');
    // Another pair, or a verdict without a pair, is pending.
    expect(entryVerdictStatus(pass, now - 60_000, 'Q', now).verdict).toBe('pending');
    expect(entryVerdictStatus({ ...pass, pairAddress: undefined }, now - 60_000, 'P', now).verdict).toBe('pending');
    // A stale FAIL is stale too (not passed either way); no verdict = pending.
    expect(entryVerdictStatus({ ...pass, pass: false }, now - 31 * 60_000, 'P', now).verdict).toBe('stale');
    expect(entryVerdictStatus({ ...pass, pass: false }, now - 60_000, 'P', now).verdict).toBe('fail');
    expect(entryVerdictStatus(null, null, 'P', now).verdict).toBe('pending');
  });

  test('D28 check order: never-checked first (newest first sight), then the OLDEST verdicts', () => {
    const rows = [
      { mint: 'checked-recent', unchecked: false, firstSeenMs: 5, checkedAtMs: 900 },
      { mint: 'new-older', unchecked: true, firstSeenMs: 10, checkedAtMs: null },
      { mint: 'checked-oldest', unchecked: false, firstSeenMs: 1, checkedAtMs: 100 },
      { mint: 'new-newest', unchecked: true, firstSeenMs: 20, checkedAtMs: null },
      { mint: 'checked-mid', unchecked: false, firstSeenMs: 50, checkedAtMs: 500 },
    ];
    expect(orderDueChainChecks(rows).map((r) => r.mint)).toEqual(['new-newest', 'new-older', 'checked-oldest', 'checked-mid', 'checked-recent']);
  });

  test('Codex r14 reserve: at least half the picks are the oldest checked rows; spare room is backfilled', () => {
    const fresh = (n: number) => Array.from({ length: n }, (_, i) => ({ mint: `new${i}`, unchecked: true, firstSeenMs: 1_000 + i, checkedAtMs: null }));
    const old = (n: number) => Array.from({ length: n }, (_, i) => ({ mint: `old${i}`, unchecked: false, firstSeenMs: 1, checkedAtMs: 100 + i }));
    const names = (rows: Array<{ mint: string }>) => rows.map((r) => r.mint);
    // A flood of new coins (30) and 15 due re-checks, limit 20: 10 + 10, newest new coins and OLDEST verdicts.
    const flood = pickDueChainChecks([...fresh(30), ...old(15)], 20);
    expect(names(flood)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `new${29 - i}`),
      ...Array.from({ length: 10 }, (_, i) => `old${i}`),
    ]);
    // Few new coins: re-checks take the spare room; few re-checks: new coins take it.
    expect(names(pickDueChainChecks([...fresh(3), ...old(30)], 20)).filter((m) => m.startsWith('old'))).toHaveLength(17);
    expect(names(pickDueChainChecks([...fresh(30), ...old(4)], 20)).filter((m) => m.startsWith('new'))).toHaveLength(16);
    // Odd limit: re-checks get the larger half; small sets are taken whole.
    expect(names(pickDueChainChecks([...fresh(10), ...old(10)], 5)).filter((m) => m.startsWith('old'))).toHaveLength(3);
    expect(pickDueChainChecks([...fresh(2), ...old(1)], 20)).toHaveLength(3);
    expect(pickDueChainChecks([...fresh(2), ...old(1)], 0)).toHaveLength(0);
  });

  test('a Token-2022 extension name that is not a plain identifier becomes t22_unknown', () => {
    const acc = mintAccount({ extensions: [{ extension: 'evil<b>‮', state: {} }] }, T22);
    expect(mintRuleFails(acc).fails).toEqual(['t22_unknown']);
  });
});

/**
 * Helius budget (2026-10-31): the mint + pair account come back in ONE round trip, and for PumpSwap / Raydium CPMM /
 * AMM v4 the LP mint + both vaults in one more. `legacyCheck` is the pre-change runChainCheck body (sequential reads,
 * no prefetch); every scenario must give the SAME verdict with fewer calls.
 */
describe('Helius budget: batched reads, identical verdicts', () => {
  async function legacyCheck(rpc: ChainRpc, mint: string, snapshot: { pairAddress: string | null; liqUsd: number; liqBase: number }, sol: number | null) {
    const checkedAt = NOW.toISOString();
    const pairAddress = snapshot.pairAddress ?? null;
    try {
      const mintRules = mintRuleFails(await rpc.getParsedAccount(mint));
      const base = {
        checkedAt, pairAddress,
        ...(mintRules.decimals === null ? {} : { decimals: mintRules.decimals }),
        ...(mintRules.tokenProgram === null ? {} : { tokenProgram: mintRules.tokenProgram }),
      };
      if (mintRules.fails.length > 0 || mintRules.supply === null || mintRules.decimals === null) {
        return verdictFromCodes(mintRules.fails.length ? mintRules.fails : ['mint_unreadable'], { top10Pct: null, ...base });
      }
      const fails: string[] = [];
      const pool = pairAddress ? await rpc.getRawAccount(pairAddress) : null;
      const lpFail = pairAddress ? await lpLockFail(rpc, pool, pairAddress) : 'lp_pool_unreadable';
      if (lpFail) fails.push(lpFail);
      const reserveFail = await poolReserveFail(rpc, pool, snapshot.liqUsd, sol);
      if (reserveFail) fails.push(reserveFail);
      const largest = (await rpc.getTokenLargestAccounts(mint)).map((row) => BigInt(row.amount));
      const poolRaw = BigInt(Math.floor(snapshot.liqBase * 10 ** mintRules.decimals));
      return verdictFromCodes(fails, { top10Pct: Math.round(top10Percent(largest, mintRules.supply, poolRaw) * 100) / 100, ...base });
    } catch (error) {
      return verdictFromCodes(['chain_check_error'], { checkedAt, pairAddress, top10Pct: null }, `chain_check_error: ${chainErrorCode(error)}`);
    }
  }

  /** One coin world; `variant` picks the scenario. Two independent fakes so each counts its own calls. */
  function world(variant: 'good' | 'lp_held_low_reserve' | 'lp_mint_missing' | 'mint_fail' | 'pool_missing' | 'curve' | 'no_pair' | 'pool_short') {
    const mint = key();
    const lp = key();
    const baseVault = key();
    const quoteVault = key();
    const holder = key();
    const pair = key();
    const build = () => {
      const rpc = new FakeRpc();
      rpc.parsed.set(mint, variant === 'mint_fail' ? mintAccount({ mintAuthority: key() }) : mintAccount());
      if (variant === 'curve') rpc.raw.set(pair, { owner: PUMP_CURVE, data: new Uint8Array(100) });
      else if (variant === 'pool_short') rpc.raw.set(pair, { owner: PUMPSWAP, data: pumpswapPool(lp, baseVault, quoteVault).data.slice(0, 150) });
      else if (variant !== 'pool_missing') rpc.raw.set(pair, pumpswapPool(lp, baseVault, quoteVault));
      if (variant !== 'lp_mint_missing') {
        rpc.parsed.set(lp, { owner: SPL, parsed: { type: 'mint', info: { supply: variant === 'lp_held_low_reserve' ? '1000' : '0', decimals: 9 } } });
      }
      rpc.largest.set(lp, [{ address: holder, amount: '1000' }]);
      rpc.parsed.set(holder, tokenAccount(key()));
      rpc.parsed.set(baseVault, tokenAccount(key(), mint, '500000'));
      rpc.parsed.set(quoteVault, tokenAccount(key(), USDC, variant === 'lp_held_low_reserve' ? '1000' : '20000'));
      rpc.largest.set(mint, [{ address: key(), amount: '500000000000' }, { address: key(), amount: '50000000000' }]);
      return rpc;
    };
    const snapshot = { pairAddress: variant === 'no_pair' ? null : pair, liqUsd: 40_000, liqBase: 500_000 };
    return { mint, snapshot, legacy: build(), next: build() };
  }

  // [variant, legacy calls, new calls]
  const CASES = [
    ['good', 5, 3],
    ['lp_held_low_reserve', 7, 5],
    ['lp_mint_missing', 3, 2],
    ['mint_fail', 1, 1],
    ['pool_missing', 3, 2],
    ['curve', 3, 2],
    ['no_pair', 2, 2],
    ['pool_short', 3, 2],
  ] as const;

  for (const [variant, legacyCalls, newCalls] of CASES) {
    test(`${variant}: same verdict, ${legacyCalls} -> ${newCalls} RPC calls`, async () => {
      const w = world(variant);
      const before = await legacyCheck(w.legacy, w.mint, w.snapshot, 200);
      const after: ArenaChainVerdict = await runChainCheck(w.next, w.mint, w.snapshot, 200, NOW);
      expect(after).toEqual(before);
      expect(w.legacy.calls).toBe(legacyCalls);
      expect(w.next.calls).toBe(newCalls);
    });
  }

  test('a truncated Raydium AMM v4 pool (addresses present, totalLp missing) fails pool_account_short with no prefetch (Codex 2026-10-31)', async () => {
    const mint = key();
    const pair = key();
    const data = new Uint8Array(500); // LP mint 464-496 and vaults 336-400 fit; totalLp at 720-727 does not
    for (const [start, address] of [[336, key()], [368, key()], [464, key()]] as const) {
      data.set(new PublicKey(address).toBytes(), start);
    }
    const make = () => {
      const rpc = new FakeRpc();
      rpc.parsed.set(mint, mintAccount());
      rpc.raw.set(pair, { owner: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', data });
      return rpc;
    };
    const snapshot = { pairAddress: pair, liqUsd: 40_000, liqBase: 500_000 };
    const legacyRpc = make();
    const nextRpc = make();
    const before = await legacyCheck(legacyRpc, mint, snapshot, 200);
    const after = await runChainCheck(nextRpc, mint, snapshot, 200, NOW);
    expect(after.error).toBe('chain_check_error: pool_account_short');
    expect(after).toEqual(before);
    expect(nextRpc.log).toEqual(['getMintAndPool']);
  });

  test('the scenarios cover pass, both fail codes in order, and the error codes', async () => {
    const verdictOf = async (variant: Parameters<typeof world>[0]) => {
      const w = world(variant);
      return runChainCheck(w.next, w.mint, w.snapshot, 200, NOW);
    };
    expect(await verdictOf('good')).toMatchObject({ pass: true, codes: [] });
    expect((await verdictOf('lp_held_low_reserve')).codes).toEqual(['lp_not_locked', 'pool_reserves_low']);
    expect((await verdictOf('lp_mint_missing')).error).toBe('chain_check_error: lp_mint_unreadable');
    expect((await verdictOf('pool_short')).error).toBe('chain_check_error: pool_account_short');
    expect((await verdictOf('pool_missing')).codes).toEqual(['lp_pool_unreadable']);
    expect((await verdictOf('no_pair')).codes).toEqual(['lp_pool_unreadable']);
  });

  test('PumpSwap good coin: exactly getMintAndPool, one getParsedAccounts (lp mint + 2 vaults), getTokenLargestAccounts', async () => {
    const w = world('good');
    await runChainCheck(w.next, w.mint, w.snapshot, 200, NOW);
    expect(w.next.log).toEqual(['getMintAndPool', 'getParsedAccounts', 'getTokenLargestAccounts']);
  });

  test('pool not read in the batch (RPC parsed it): read raw with getRawAccount, same verdict', async () => {
    const w = world('lp_held_low_reserve');
    const before = await legacyCheck(w.legacy, w.mint, w.snapshot, 200);
    const batched = w.next.getMintAndPool.bind(w.next);
    w.next.getMintAndPool = async (mint, pair) => ({ ...(await batched(mint, pair)), pool: undefined });
    const after = await runChainCheck(w.next, w.mint, w.snapshot, 200, NOW);
    expect(after).toEqual(before);
    expect(w.next.log.slice(0, 2)).toEqual(['getMintAndPool', 'getRawAccount']);
  });

  describe('web3ChainRpc.getMintAndPool', () => {
    const mint = key();
    const pair = key();
    const mintData = { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 6, supply: '1', mintAuthority: null, freezeAuthority: null } }, space: 82 };
    function fakeConnection(poolData: unknown, mintAccountData: unknown = mintData) {
      const calls: string[] = [];
      const connection = {
        async getMultipleParsedAccounts(keys: PublicKey[]) {
          calls.push(`multi:${keys.length}`);
          return { context: { slot: 1 }, value: [
            { owner: new PublicKey(SPL), data: mintAccountData, executable: false, lamports: 1 },
            poolData === null ? null : { owner: new PublicKey(PUMPSWAP), data: poolData, executable: false, lamports: 1 },
          ] };
        },
        async getParsedAccountInfo() {
          calls.push('single');
          return { context: { slot: 1 }, value: { owner: new PublicKey(SPL), data: mintAccountData, executable: false, lamports: 1 } };
        },
      };
      return { rpc: web3ChainRpc(connection as unknown as Connection), calls };
    }

    test('one round trip: parsed mint + raw Buffer pool', async () => {
      const bytes = Buffer.from([1, 2, 3]);
      const { rpc, calls } = fakeConnection(bytes);
      const out = await rpc.getMintAndPool(mint, pair);
      expect(calls).toEqual(['multi:2']);
      expect(out.mint).toEqual({ owner: SPL, parsed: mintData.parsed });
      expect(out.pool).toEqual({ owner: PUMPSWAP, data: bytes });
    });

    test('a pool the RPC parsed is NOT used as raw bytes (pool undefined -> caller reads it raw)', async () => {
      const { rpc } = fakeConnection({ program: 'x', parsed: { type: 'pool' }, space: 300 });
      expect((await rpc.getMintAndPool(mint, pair)).pool).toBeUndefined();
    });

    test('a missing pool account reads null', async () => {
      const { rpc } = fakeConnection(null);
      expect((await rpc.getMintAndPool(mint, pair)).pool).toBeNull();
    });

    test('no pair or an invalid pair: the mint is read alone (a failing mint keeps its verdict, not bad_address)', async () => {
      for (const p of [null, 'not-a-key!']) {
        const { rpc, calls } = fakeConnection(Buffer.from([1]));
        const out = await rpc.getMintAndPool(mint, p);
        expect(calls).toEqual(['single']);
        expect(out.pool).toBeUndefined();
      }
      // End to end through runChainCheck: freeze authority live + an invalid pair = the mint verdict, as before.
      const frozen = { ...mintData, parsed: { ...mintData.parsed, info: { ...mintData.parsed.info, freezeAuthority: key() } } };
      const { rpc } = fakeConnection(Buffer.from([1]), frozen);
      const verdict = await runChainCheck(rpc, mint, { pairAddress: 'not-a-key!', liqUsd: 1, liqBase: 1 }, 200, NOW);
      expect(verdict).toMatchObject({ pass: false, codes: ['freeze_authority'] });
      expect(verdict.error).toBeUndefined();
      // A passing mint with an invalid pair still fails closed on the raw read (bad_address), as before.
      const passing = fakeConnection(Buffer.from([1]));
      const err = await runChainCheck(passing.rpc, mint, { pairAddress: 'not-a-key!', liqUsd: 1, liqBase: 1 }, 200, NOW);
      expect(err.error).toBe('chain_check_error: bad_address');
    });
  });
});

/**
 * O3 (N4): the verdict write to the private table (one row per agent for the mint) must lock in the shared order
 * (mint, then agent_id COLLATE "C") before it updates, like the snapshot write, or the two can deadlock. A fake
 * database records each statement and the transaction it ran in.
 */
describe('O3: storeChainVerdict locks the private rows in order first', () => {
  const dialect = new PgDialect();
  type Logged = { tx: number; sql: string; params: unknown[] };
  function fakeDatabase(locked: Array<Record<string, unknown>>) {
    const log: Logged[] = [];
    let txCount = 0;
    const exec = (tx: number) => async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      const text = query.sql.replace(/\s+/g, ' ').trim();
      log.push({ tx, sql: text, params: query.params });
      return /FOR (NO KEY )?UPDATE/.test(text) ? locked : [];
    };
    const database = {
      execute: exec(0),
      transaction: async (run: (tx: { execute: (statement: SQL) => Promise<unknown> }) => Promise<unknown>) => {
        txCount += 1;
        return run({ execute: exec(txCount) });
      },
    };
    return { database: database as never, log };
  }
  const verdict = verdictFromCodes([], { checkedAt: NOW.toISOString() });
  const MINT = 'So11111111111111111111111111111111111111112';

  test('shared row: one keyed UPDATE; private rows: lock by agent_id COLLATE "C", then update only those agents', async () => {
    const { database, log } = fakeDatabase([{ agent_id: 'agent-1' }, { agent_id: 'agent-2' }]);
    await storeChainVerdict(MINT, verdict, NOW, database);
    expect(log.map((entry) => entry.tx)).toEqual([0, 1, 1]);
    expect(log[0]!.sql).toContain('UPDATE floor_discovery_mints SET chain_verdict');
    expect(log[1]!.sql).toContain('FROM floor_arena_private_mints AS p WHERE p.mint = $1 ORDER BY p.agent_id COLLATE "C" FOR NO KEY UPDATE OF p');
    expect(log[1]!.params).toEqual([MINT]);
    expect(log[2]!.sql).toContain('UPDATE floor_arena_private_mints AS p SET chain_verdict');
    expect(log[2]!.sql).toContain('p.agent_id IN (SELECT jsonb_array_elements_text(');
    expect(log[2]!.params).toContain(JSON.stringify(['agent-1', 'agent-2']));
  });

  test('no private row locked -> no private UPDATE', async () => {
    const { database, log } = fakeDatabase([]);
    await storeChainVerdict(MINT, verdict, NOW, database);
    expect(log.map((entry) => entry.sql.split(' ')[0])).toEqual(['UPDATE', 'SELECT']);
  });
});

/**
 * 2026-10-08 staging: the public fallback RPC refuses getTokenLargestAccounts (HTTP 429 on a single call), so no arena
 * check can complete during a primary outage. Inside the breaker window a tick checks nothing; after the window
 * (half-open) it checks 1 coin, alone; with the primary healthy, the normal batch of 20, 4 at a time.
 */
describe('chain-check tick pacing: skip inside the breaker window, probe 1 coin after it', () => {
  function tickHarness(dueCount: number) {
    const rpc = new FakeRpc();
    const rows: DueRow[] = Array.from({ length: dueCount }, (_, i) => {
      const mint = key();
      // A live freeze authority: one RPC read per coin, a full (failing) verdict.
      rpc.parsed.set(mint, mintAccount({ freezeAuthority: key() }));
      return {
        mint,
        snapshot: { pairAddress: key(), liqUsd: 10_000, liqBase: 1 } as unknown as FloorArenaSnapshot,
        unchecked: true,
        firstSeenMs: 1_000 + i,
        checkedAtMs: null,
      };
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const read = rpc.getMintAndPool.bind(rpc);
    rpc.getMintAndPool = async (mint: string, pair: string | null) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      try { return await read(mint, pair); } finally { inFlight -= 1; }
    };
    const limits: number[] = [];
    const stored: string[] = [];
    const deps = {
      rpc,
      configured: () => true,
      selectDue: async (_now: Date, limit: number) => {
        limits.push(limit);
        return pickDueChainChecks(rows, limit);
      },
      store: async (mint: string) => { stored.push(mint); },
    };
    return { rows, deps, limits, stored, maxInFlight: () => maxInFlight };
  }

  const DOWN_SINCE = new Date(NOW.getTime() - 5 * 60_000).toISOString();
  const IN_WINDOW = { primaryHealthy: false, downSince: DOWN_SINCE, downUntil: new Date(NOW.getTime() + 10 * 60_000).toISOString() };
  const AFTER_WINDOW = { primaryHealthy: false, downSince: DOWN_SINCE, downUntil: new Date(NOW.getTime() - 1).toISOString() };

  test('inside the window: no selection, no RPC, no store, skipped rpc_outage, one log for two ticks', async () => {
    const h = tickHarness(25);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const status = { ...IN_WINDOW, downSince: new Date(NOW.getTime() - 7 * 60_000).toISOString() };
      const first = await runChainCheckTick(NOW, { ...h.deps, rpcStatus: () => status });
      const second = await runChainCheckTick(new Date(NOW.getTime() + 20_000), { ...h.deps, rpcStatus: () => status });
      for (const result of [first, second]) {
        expect(result).toEqual({ checked: 0, passed: 0, errors: 0, skipped: 'rpc_outage' });
      }
      expect(h.limits).toEqual([]);
      expect(h.stored).toEqual([]);
      expect(h.deps.rpc.calls).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('getTokenLargestAccounts');
    } finally {
      warn.mockRestore();
    }
  });

  test('after the window (half-open): exactly 1 coin, concurrency 1, newest first sight first, verdict stored', async () => {
    const h = tickHarness(25);
    const result = await runChainCheckTick(NOW, { ...h.deps, rpcStatus: () => AFTER_WINDOW });
    expect(h.limits).toEqual([1]);
    expect(result).toEqual({ checked: 1, passed: 0, errors: 0, skipped: null });
    expect(h.stored).toEqual([h.rows[24]!.mint]);
    expect(h.maxInFlight()).toBe(1);
  });

  test('downUntil exactly now counts as half-open (probe), not as inside the window', async () => {
    const h = tickHarness(3);
    const result = await runChainCheckTick(NOW, { ...h.deps, rpcStatus: () => ({ ...IN_WINDOW, downUntil: NOW.toISOString() }) });
    expect(h.limits).toEqual([1]);
    expect(result.skipped).toBeNull();
  });

  test('primary healthy: the normal batch of 20 with concurrency 4', async () => {
    const h = tickHarness(25);
    const result = await runChainCheckTick(NOW, { ...h.deps, rpcStatus: () => ({ primaryHealthy: true, downUntil: null }) });
    expect(h.limits).toEqual([20]);
    expect(result.checked).toBe(20);
    expect(h.stored).toHaveLength(20);
    expect(h.maxInFlight()).toBe(4);
  });

  test('primaryHealthy seam overrides the status: true gives the normal batch even with an open window', async () => {
    const h = tickHarness(25);
    const result = await runChainCheckTick(NOW, { ...h.deps, primaryHealthy: () => true, rpcStatus: () => IN_WINDOW });
    expect(h.limits).toEqual([20]);
    expect(result.checked).toBe(20);
  });

  test('a new episode logs again after a healthy tick', async () => {
    const h = tickHarness(3);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const status = { ...IN_WINDOW, downSince: new Date(NOW.getTime() - 9 * 60_000).toISOString() };
      await runChainCheckTick(NOW, { ...h.deps, rpcStatus: () => status });
      await runChainCheckTick(NOW, { ...h.deps, rpcStatus: () => ({ primaryHealthy: true, downUntil: null }) });
      await runChainCheckTick(NOW, { ...h.deps, rpcStatus: () => status });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('fail closed in the probe tick: an RPC error is stored as a transient error, never a pass', async () => {
    const h = tickHarness(3);
    h.deps.rpc.getMintAndPool = async () => { throw new Error('429 Too Many Requests: fallback rate limited (local)'); };
    const verdicts: Array<{ pass: boolean; error?: string }> = [];
    const result = await runChainCheckTick(NOW, {
      ...h.deps,
      rpcStatus: () => AFTER_WINDOW,
      store: async (_mint, verdict) => { verdicts.push(verdict); },
    });
    expect(result).toMatchObject({ checked: 1, passed: 0, errors: 1, skipped: null });
    expect(verdicts.map((v) => [v.pass, v.error])).toEqual([[false, 'chain_check_error: rpc_rate_limited']]);
    expect(isTransientChainError(verdicts[0]!.error)).toBe(true);
  });
});
