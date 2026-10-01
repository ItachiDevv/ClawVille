import { describe, expect, test } from 'bun:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  chainErrorCode, chainRetryJitterMs, chainVerdictDue, entryVerdictStatus, isTransientChainError, lpLockFail, mintRuleFails,
  orderDueChainChecks, pickDueChainChecks, poolReserveFail, runChainCheck, storeChainVerdict, top10Percent, verdictFromCodes,
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
