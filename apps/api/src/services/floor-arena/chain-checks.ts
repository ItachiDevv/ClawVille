import { Connection, PublicKey, type ParsedAccountData } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { db, sql } from '@clawville/database';
import { tradingConnection, tradingRpcConfigured } from '../trading-rpc';
import { FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES, type FloorArenaHardRuleId } from '@clawville/shared';
import type { FloorArenaSnapshot } from './filters';
import { currentSolPriceUsd, USDC_MINT, WSOL_MINT } from './pricing';

/**
 * D5 hard rules, checked on chain (port of the paper runner's `chain_checks`, `lp_lock_fail`,
 * `pool_reserve_fail`, runner_v42p1.py). Not editable by any template or user:
 *   - mint authority and freeze authority revoked;
 *   - Token-2022: only the allow-listed extensions, and a transfer fee of zero (both fee slots);
 *   - >= 95 % of the pool's liquidity burned or locked (launch-curve programs hold the reserves: OK);
 *   - the pool's SOL / USDC side holds >= max($5k, 1/4 of DexScreener's claimed side) (a pulled pool fails);
 *   - the top-10 holder share (pool account removed) is MEASURED here; the template's top10_max_pct judges it.
 * Any read error fails closed (`chain_check_error`). D26: there is no platform liquidity floor any more; a pump.fun
 * curve coin (DexScreener liquidity 0) passes the LP rule as a launch curve and has no pool reserves to check.
 */

const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const RAYDIUM_LOCK_CP_AUTHORITY = '3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH';
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const RAYDIUM_AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const RAYDIUM_LOCK_CLMM_AUTHORITY = 'kN1kEznaF5Xbd8LYuqtEFcxzWSBk5Fv6ygX6SqEGJVy';
const METEORA_DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const METEORA_DAMM_V1_PROGRAM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';
/** pump.fun, Meteora DBC, Raydium LaunchLab: the program holds the reserves, there is no LP to pull. */
export const BONDING_CURVE_PROGRAMS: ReadonlySet<string> = new Set([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
]);
/** 95 %: Meteora launchpad migrations lock 97-99 %; at 95 % a wallet can pull at most 5 % of the pool. */
export const LP_LOCKED_MIN_FRAC = 0.95;
/** Token-2022 ALLOW-list; any other extension fails (permanent delegate, transfer hook, pausable, ...). */
export const OK_2022_EXTENSIONS: ReadonlySet<string> = new Set([
  'metadataPointer', 'tokenMetadata', 'transferFeeConfig', 'mintCloseAuthority', 'groupPointer',
  'groupMemberPointer', 'tokenGroup', 'tokenGroupMember', 'defaultAccountState',
]);
/** (vault A, vault B) byte ranges inside the pool account. */
const POOL_VAULTS: Readonly<Record<string, readonly [readonly [number, number], readonly [number, number]]>> = {
  [PUMPSWAP_PROGRAM]: [[139, 171], [171, 203]],
  [RAYDIUM_CPMM_PROGRAM]: [[72, 104], [104, 136]],
  [RAYDIUM_AMM_V4_PROGRAM]: [[336, 368], [368, 400]],
  [METEORA_DAMM_V2_PROGRAM]: [[232, 264], [264, 296]],
};
const CLMM_MAX_NFT_LOOKUPS = 60;
export const CHAIN_VERDICT_TTL_MS = 30 * 60_000;
const CHECK_DEADLINE_MS = 25_000;
const CHECKS_PER_TICK = 20;
const CHECK_CONCURRENCY = 4;
/**
 * Coarse universe: only these coins are worth an RPC budget. D26: no liquidity bound (pump.fun curve coins show
 * DexScreener liquidity 0 and must still get a verdict); a positive price and mcap 1k-100M.
 */
export const CHAIN_UNIVERSE = { mcapMin: 1_000, mcapMax: 100_000_000 } as const;

/**
 * `chain_verdict` jsonb. `fails` holds ONLY hard-rule ids (FLOOR_ARENA_HARD_RULES, the UI labels them);
 * `codes` holds the granular runner codes. A read error gives pass:false, fails:[], error set ("not verified").
 */
export interface ArenaChainVerdict {
  pass: boolean;
  fails: FloorArenaHardRuleId[];
  codes: string[];
  checkedAt: string;
  error?: string;
  decimals?: number;
  top10Pct?: number | null;
  pairAddress?: string | null;
  tokenProgram?: 'spl' | 'token2022';
}

const ERROR_CODES: ReadonlySet<string> = new Set(['chain_check_error', 'mint_unreadable', 'mint_not_token']);

/** Granular runner code -> hard-rule id; null for "could not verify" codes. */
export function hardRuleIdFor(code: string): FloorArenaHardRuleId | null {
  if (code === 'mint_authority') return 'mint-authority';
  if (code === 'freeze_authority') return 'freeze-authority';
  if (code.startsWith('t22_')) return 't22-fee';
  if (code.startsWith('lp_')) return 'lp-locked';
  if (code.startsWith('pool_reserves')) return 'pool-reserves';
  return null;
}

export function verdictFromCodes(
  codes: readonly string[],
  base: Omit<ArenaChainVerdict, 'pass' | 'fails' | 'codes' | 'error'>,
  error?: string,
): ArenaChainVerdict {
  const fails = [...new Set(codes.map(hardRuleIdFor).filter((id): id is FloorArenaHardRuleId => id !== null))];
  const unverified = codes.find((code) => ERROR_CODES.has(code));
  const err = error ?? unverified;
  return {
    pass: codes.length === 0 && !err,
    fails,
    codes: [...codes],
    ...base,
    ...(err ? { error: err } : {}),
  };
}

// ---------------------------------------------------------------- RPC seam

export interface ParsedAccount { owner: string; parsed: Record<string, unknown> | null }
export interface RawAccount { owner: string; data: Uint8Array }

export interface ChainRpc {
  getParsedAccount(address: string): Promise<ParsedAccount | null>;
  getRawAccount(address: string): Promise<RawAccount | null>;
  getParsedAccounts(addresses: readonly string[]): Promise<Array<ParsedAccount | null>>;
  getAccountOwners(addresses: readonly string[]): Promise<Array<string | null>>;
  getTokenLargestAccounts(mint: string): Promise<Array<{ address: string; amount: string }>>;
  getClmmPositions(pool: string): Promise<Uint8Array[]>;
}

function parsedOf(data: unknown): Record<string, unknown> | null {
  const parsed = (data as ParsedAccountData | null)?.parsed;
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
}

export function web3ChainRpc(connection: Connection): ChainRpc {
  const commitment = 'confirmed' as const;
  return {
    async getParsedAccount(address) {
      const { value } = await connection.getParsedAccountInfo(new PublicKey(address), commitment);
      if (!value) return null;
      return { owner: value.owner.toBase58(), parsed: parsedOf(value.data) };
    },
    async getRawAccount(address) {
      const value = await connection.getAccountInfo(new PublicKey(address), commitment);
      if (!value) return null;
      return { owner: value.owner.toBase58(), data: value.data };
    },
    async getParsedAccounts(addresses) {
      const out: Array<ParsedAccount | null> = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const keys = addresses.slice(i, i + 100).map((a) => new PublicKey(a));
        const { value } = await connection.getMultipleParsedAccounts(keys, { commitment });
        for (const account of value) out.push(account ? { owner: account.owner.toBase58(), parsed: parsedOf(account.data) } : null);
      }
      return out;
    },
    async getAccountOwners(addresses) {
      const out: Array<string | null> = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const keys = addresses.slice(i, i + 100).map((a) => new PublicKey(a));
        const infos = await connection.getMultipleAccountsInfo(keys, { commitment, dataSlice: { offset: 0, length: 0 } });
        for (const info of infos) out.push(info ? info.owner.toBase58() : null);
      }
      return out;
    },
    async getTokenLargestAccounts(mint) {
      const { value } = await connection.getTokenLargestAccounts(new PublicKey(mint), commitment);
      return value.map((row) => ({ address: row.address.toBase58(), amount: row.amount }));
    },
    async getClmmPositions(pool) {
      const rows = await connection.getProgramAccounts(new PublicKey(RAYDIUM_CLMM_PROGRAM), {
        commitment,
        filters: [{ dataSize: 281 }, { memcmp: { offset: 41, bytes: pool } }],
      });
      return rows.map((row) => row.account.data);
    },
  };
}

// ---------------------------------------------------------------- byte helpers

function keyAt(data: Uint8Array, start: number, end: number): string {
  if (data.length < end) throw new Error('pool account too short');
  return new PublicKey(data.slice(start, end)).toBase58();
}

function uintLE(data: Uint8Array, start: number, length: number): bigint {
  if (data.length < start + length) throw new Error('pool account too short');
  let value = 0n;
  for (let i = length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(data[start + i]!);
  return value;
}

function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  // Scale to keep precision for u64/u128 values beyond 2^53.
  return Number((numerator * 1_000_000n) / denominator) / 1_000_000;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function infoOf(account: ParsedAccount | null): Record<string, unknown> {
  const info = account?.parsed?.info;
  return info && typeof info === 'object' ? info as Record<string, unknown> : {};
}

// ---------------------------------------------------------------- the checks

/** Fraction of an LP-token pool's liquidity that some wallet can still withdraw. */
export async function lpMintUnlocked(rpc: ChainRpc, lpMint: string, totalLp: bigint | null = null, escrowProgram: string | null = null): Promise<number> {
  const supplyRaw = str(infoOf(await rpc.getParsedAccount(lpMint)).supply);
  if (supplyRaw === null) throw new Error('lp mint unreadable');
  const supply = BigInt(supplyRaw);
  if (supply === 0n) return 0;
  const holders = await rpc.getTokenLargestAccounts(lpMint);
  const owners = (await rpc.getParsedAccounts(holders.map((h) => h.address))).map((a) => str(infoOf(a).owner));
  const escrow = new Set<string>();
  if (escrowProgram) {
    const valid = owners.filter((o): o is string => o !== null);
    const programOwners = await rpc.getAccountOwners(valid);
    valid.forEach((owner, i) => { if (programOwners[i] === escrowProgram) escrow.add(owner); });
  }
  let locked = 0n;
  holders.forEach((holder, i) => {
    const owner = owners[i];
    if (owner && (owner === RAYDIUM_LOCK_CP_AUTHORITY || owner === INCINERATOR || escrow.has(owner))) locked += BigInt(holder.amount);
  });
  const unlocked = supply - locked;
  const base = [totalLp && totalLp > 0n ? totalLp : supply, unlocked, 1n].reduce((a, b) => (a > b ? a : b));
  return ratio(unlocked > 0n ? unlocked : 0n, base);
}

/** Raydium CLMM: a position is locked when its NFT sits with the Raydium lock authority. Largest first, <= 60 lookups. */
export async function clmmUnlocked(rpc: ChainRpc, pool: string): Promise<number> {
  const rows: Array<{ liq: bigint; nft: string }> = [];
  for (const data of await rpc.getClmmPositions(pool)) {
    const liq = uintLE(data, 81, 16);
    if (liq > 0n) rows.push({ liq, nft: keyAt(data, 9, 41) });
  }
  const total = rows.reduce((sum, r) => sum + r.liq, 0n);
  if (total === 0n) return 1;
  rows.sort((a, b) => (a.liq === b.liq ? 0 : a.liq > b.liq ? -1 : 1));
  let locked = 0n;
  let unlocked = 0n;
  const limit = (total * BigInt(Math.round((1 - LP_LOCKED_MIN_FRAC) * 1_000_000))) / 1_000_000n;
  for (const row of rows.slice(0, CLMM_MAX_NFT_LOOKUPS)) {
    const held = (await rpc.getTokenLargestAccounts(row.nft)).find((h) => BigInt(h.amount) > 0n);
    const owner = held ? str(infoOf((await rpc.getParsedAccounts([held.address]))[0] ?? null).owner) : null;
    if (owner === RAYDIUM_LOCK_CLMM_AUTHORITY) locked += row.liq;
    else unlocked += row.liq;
    if (unlocked > limit) break;
  }
  return ratio(total - locked, total);
}

/** null when the pool cannot be drained by any wallet, else a fail code. `pool` is the pair account. */
export async function lpLockFail(rpc: ChainRpc, pool: RawAccount | null, pairAddress: string): Promise<string | null> {
  if (!pool) return 'lp_pool_unreadable';
  const { owner, data } = pool;
  if (BONDING_CURVE_PROGRAMS.has(owner)) return null;
  let unlocked: number;
  if (owner === PUMPSWAP_PROGRAM) {
    unlocked = await lpMintUnlocked(rpc, keyAt(data, 8 + 3 + 32 * 3, 8 + 3 + 32 * 4));
  } else if (owner === RAYDIUM_CPMM_PROGRAM) {
    unlocked = await lpMintUnlocked(rpc, keyAt(data, 8 + 32 * 4, 8 + 32 * 5));
  } else if (owner === RAYDIUM_AMM_V4_PROGRAM) {
    unlocked = await lpMintUnlocked(rpc, keyAt(data, 464, 496), uintLE(data, 720, 8));
  } else if (owner === METEORA_DAMM_V2_PROGRAM) {
    const liq = uintLE(data, 360, 16);
    const permanent = uintLE(data, 552, 16);
    unlocked = liq > 0n ? ratio(liq > permanent ? liq - permanent : 0n, liq) : 1;
  } else if (owner === METEORA_DAMM_V1_PROGRAM) {
    unlocked = await lpMintUnlocked(rpc, keyAt(data, 8, 40), null, METEORA_DAMM_V1_PROGRAM);
  } else if (owner === RAYDIUM_CLMM_PROGRAM) {
    unlocked = await clmmUnlocked(rpc, pairAddress);
  } else {
    return 'lp_unverifiable_dex';
  }
  return unlocked > 1 - LP_LOCKED_MIN_FRAC ? 'lp_not_locked' : null;
}

/**
 * A pulled pool ends with LP supply 0 (reads as burned) while DexScreener still shows its old liquidity
 * (FEELSGOOD / TIGRINO 2026-09-19). The pool's SOL or USDC side must hold >= max($5k, 1/4 of the claimed side).
 * Pools with neither side SOL/USDC and launch curves are not checked here (the LP check covers them).
 */
export async function poolReserveFail(
  rpc: ChainRpc,
  pool: RawAccount | null,
  liqUsd: number | null,
  solPriceUsd: number | null,
): Promise<string | null> {
  if (!pool) return null;
  const ranges = POOL_VAULTS[pool.owner];
  if (!ranges) return null;
  const vaults = ranges.map(([a, b]) => keyAt(pool.data, a, b));
  let quoteUsd: number | null = null;
  let unpriced = false;
  for (const account of await rpc.getParsedAccounts(vaults)) {
    const info = infoOf(account);
    const amount = Number((info.tokenAmount as { uiAmountString?: string; uiAmount?: number } | undefined)?.uiAmountString
      ?? (info.tokenAmount as { uiAmount?: number } | undefined)?.uiAmount ?? 0);
    if (info.mint === WSOL_MINT) {
      if (solPriceUsd !== null && solPriceUsd > 0) quoteUsd = amount * solPriceUsd;
      else unpriced = true;
    } else if (info.mint === USDC_MINT) {
      quoteUsd = amount;
    }
  }
  if (quoteUsd === null) return unpriced ? 'pool_reserves_unpriced' : null;
  if (!Number.isFinite(quoteUsd) || quoteUsd < Math.max(5_000, 0.25 * (liqUsd ?? 0) / 2)) return 'pool_reserves_low';
  return null;
}

/** Top-10 holder share in percent, with the pool's own account (closest to DexScreener liq.base, within 15 %) removed. */
export function top10Percent(largest: readonly bigint[], supply: bigint, poolRaw: bigint): number {
  if (supply <= 0n) return 100;
  const list = [...largest];
  if (poolRaw > 0n && list.length > 0) {
    let best = 0;
    const dist = (v: bigint) => (v > poolRaw ? v - poolRaw : poolRaw - v);
    for (let k = 1; k < list.length; k += 1) if (dist(list[k]!) < dist(list[best]!)) best = k;
    if (ratio(dist(list[best]!), poolRaw) < 0.15) list.splice(best, 1);
  }
  const top = list.slice(0, 10).reduce((sum, v) => sum + v, 0n);
  return 100 * ratio(top, supply);
}

/** Mint-level rules (authorities, Token-2022). Returns the fails plus the parsed facts. */
export function mintRuleFails(account: ParsedAccount | null): { fails: string[]; decimals: number | null; supply: bigint | null; tokenProgram: 'spl' | 'token2022' | null } {
  if (!account) return { fails: ['mint_unreadable'], decimals: null, supply: null, tokenProgram: null };
  const isSpl = account.owner === TOKEN_PROGRAM_ID.toBase58();
  const is2022 = account.owner === TOKEN_2022_PROGRAM_ID.toBase58();
  if (!isSpl && !is2022) return { fails: ['mint_not_token'], decimals: null, supply: null, tokenProgram: null };
  if (account.parsed?.type !== 'mint') return { fails: ['mint_unreadable'], decimals: null, supply: null, tokenProgram: null };
  const info = infoOf(account);
  const decimals = typeof info.decimals === 'number' ? info.decimals : null;
  const supplyRaw = str(info.supply);
  if (decimals === null || supplyRaw === null) return { fails: ['mint_unreadable'], decimals: null, supply: null, tokenProgram: null };
  const fails: string[] = [];
  if (info.mintAuthority) fails.push('mint_authority');
  if (info.freezeAuthority) fails.push('freeze_authority');
  if (is2022) {
    const extensions = Array.isArray(info.extensions) ? info.extensions as Array<Record<string, unknown>> : [];
    for (const ext of extensions) {
      // The name reaches the public verdict `codes`: keep only a plain identifier.
      const rawName = String(ext.extension ?? 'unknown');
      const name = /^[A-Za-z0-9]{1,40}$/.test(rawName) ? rawName : 'unknown';
      if (!OK_2022_EXTENSIONS.has(name)) fails.push(`t22_${name}`);
      const state = (ext.state ?? {}) as Record<string, unknown>;
      if (name === 'transferFeeConfig') {
        const bps = ['newerTransferFee', 'olderTransferFee'].map((k) => Number((state[k] as { transferFeeBasisPoints?: unknown } | undefined)?.transferFeeBasisPoints ?? 0));
        // Fail closed: an unreadable fee (NaN) counts as a fee.
        if (bps.some((v) => !Number.isFinite(v) || v > 0)) fails.push('t22_transfer_fee');
      }
      if (name === 'defaultAccountState' && state.accountState === 'frozen') fails.push('t22_default_frozen');
    }
  }
  return { fails, decimals, supply: BigInt(supplyRaw), tokenProgram: is2022 ? 'token2022' : 'spl' };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`chain check exceeded ${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * A short code, never the RPC message: it can carry the Helius URL (key) or vendor body text, and the verdict is
 * public through the discovery feed (Codex r2 #7).
 */
export function chainErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/429|too many requests/i.test(message)) return 'rpc_rate_limited';
  if (/chain check exceeded/i.test(message)) return 'deadline';
  if (/timed? ?out|timeout/i.test(message)) return 'rpc_timeout';
  if (/pool account too short/i.test(message)) return 'pool_account_short';
  if (/lp mint unreadable/i.test(message)) return 'lp_mint_unreadable';
  if (/invalid public key|non-base58/i.test(message)) return 'bad_address';
  return 'rpc_error';
}

/** One full hard-rule verdict. Mint-level fails short-circuit the pool reads (saves RPC). */
export async function runChainCheck(
  rpc: ChainRpc,
  mint: string,
  snapshot: Pick<FloorArenaSnapshot, 'pairAddress' | 'liqUsd' | 'liqBase'>,
  solPriceUsd: number | null,
  now: Date = new Date(),
): Promise<ArenaChainVerdict> {
  const checkedAt = now.toISOString();
  const pairAddress = snapshot.pairAddress ?? null;
  try {
    return await withDeadline((async (): Promise<ArenaChainVerdict> => {
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
      const reserveFail = await poolReserveFail(rpc, pool, snapshot.liqUsd ?? null, solPriceUsd);
      if (reserveFail) fails.push(reserveFail);
      const largest = (await rpc.getTokenLargestAccounts(mint)).map((row) => BigInt(row.amount));
      const liqBase = typeof snapshot.liqBase === 'number' && Number.isFinite(snapshot.liqBase) && snapshot.liqBase > 0 ? snapshot.liqBase : 0;
      const poolRaw = BigInt(Math.floor(liqBase * 10 ** mintRules.decimals));
      const top10Pct = Math.round(top10Percent(largest, mintRules.supply, poolRaw) * 100) / 100;
      return verdictFromCodes(fails, { top10Pct, ...base });
    })(), CHECK_DEADLINE_MS);
  } catch (error) {
    return verdictFromCodes(['chain_check_error'], { checkedAt, pairAddress, top10Pct: null }, `chain_check_error: ${chainErrorCode(error)}`);
  }
}

// ---------------------------------------------------------------- the 20 s tick

interface DueRow { mint: string; snapshot: FloorArenaSnapshot | null; unchecked: boolean; firstSeenMs: number; checkedAtMs: number | null }

/**
 * D28: the check order. Never-checked rows first (newest first sight first), then the OLDEST verdicts first, so no
 * tradeable coin's verdict starves past the 30-min TTL while newer coins keep arriving.
 */
export function orderDueChainChecks<T extends { unchecked: boolean; firstSeenMs: number; checkedAtMs: number | null }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Number(b.unchecked) - Number(a.unchecked)
    || (a.unchecked ? 0 : (a.checkedAtMs ?? 0) - (b.checkedAtMs ?? 0))
    || b.firstSeenMs - a.firstSeenMs);
}

/**
 * Codex r14: reserved capacity. At least half of each tick's checks (rounded up) go to already-checked due rows
 * (oldest verdict first), the rest to never-checked rows (newest first sight first); a half with spare room is
 * backfilled by the other. Without it a steady flow of new coins fills every slot, and older tradeable coins are
 * never re-checked, go stale and become unbuyable (D28). The result keeps the orderDueChainChecks order.
 */
export function pickDueChainChecks<T extends { unchecked: boolean; firstSeenMs: number; checkedAtMs: number | null }>(
  rows: readonly T[],
  limit: number,
): T[] {
  const ordered = orderDueChainChecks(rows);
  const fresh = ordered.filter((r) => r.unchecked);
  const recheck = ordered.filter((r) => !r.unchecked);
  const recheckTake = Math.min(recheck.length, Math.max(Math.ceil(limit / 2), limit - fresh.length));
  const freshTake = Math.min(fresh.length, Math.max(limit - recheckTake, 0));
  return [...fresh.slice(0, freshTake), ...recheck.slice(0, recheckTake)];
}

/** A verdict as the entry gate sees it (D28). */
export type EntryVerdict = 'pass' | 'fail' | 'pending' | 'stale';

/**
 * D28: the entry gate. A verdict counts only for the pair priced now (a missing or different pairAddress = pending),
 * and only while it is younger than CHAIN_VERDICT_TTL_MS at the entry decision (older = 'stale', not passed: a pulled
 * LP after the check would not be seen). `checkedAtMs` is the row's chain_checked_at (fallback: verdict.checkedAt).
 */
export function entryVerdictStatus(
  raw: unknown,
  checkedAtMs: number | null,
  snapshotPairAddress: string | null,
  nowMs: number,
): { verdict: EntryVerdict; top10Pct: number | null; checkedAtMs: number | null } {
  const v = raw as Partial<ArenaChainVerdict> | null;
  if (!v || typeof v.pass !== 'boolean') return { verdict: 'pending', top10Pct: null, checkedAtMs: null };
  if ((v.pairAddress ?? null) !== snapshotPairAddress) return { verdict: 'pending', top10Pct: null, checkedAtMs: null };
  const fromVerdict = typeof v.checkedAt === 'string' ? Date.parse(v.checkedAt) : Number.NaN;
  const at = checkedAtMs ?? (Number.isFinite(fromVerdict) ? fromVerdict : null);
  if (at === null || nowMs - at >= CHAIN_VERDICT_TTL_MS) return { verdict: 'stale', top10Pct: null, checkedAtMs: at };
  return { verdict: v.pass ? 'pass' : 'fail', top10Pct: typeof v.top10Pct === 'number' ? v.top10Pct : null, checkedAtMs: at };
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result as Array<Record<string, unknown>> : ((result as { rows?: Array<Record<string, unknown>> })?.rows ?? []);
}

/** Mints in the coarse universe whose verdict is missing, older than 30 min, or for another pair. Unchecked first, newest first. */
/**
 * A verdict that failed on a transient read (one RPC 429 held a good coin out for 30 min in the Python runner,
 * 2026-09-30) is re-checked after 2 min plus a per-mint jitter of 0-59 s; pass / fail verdicts keep 30 min.
 */
export const CHAIN_TRANSIENT_ERRORS: readonly string[] = ['rpc_rate_limited', 'rpc_timeout', 'rpc_error', 'deadline'];
export const CHAIN_ERROR_RETRY_MS = 2 * 60_000;
const CHAIN_ERROR_JITTER_MS = 60_000;

/** Deterministic 0..59 s per mint (FNV-1a), so retries of one burst spread out instead of re-colliding. */
export function chainRetryJitterMs(mint: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < mint.length; i += 1) {
    hash ^= mint.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % CHAIN_ERROR_JITTER_MS;
}

export function isTransientChainError(error: string | null | undefined): boolean {
  if (!error) return false;
  const code = error.startsWith('chain_check_error: ') ? error.slice('chain_check_error: '.length) : error;
  return CHAIN_TRANSIENT_ERRORS.includes(code);
}

/** The exact due rule (the SQL in selectDueChainChecks is a superset filter; this decides). */
export function chainVerdictDue(
  row: { mint: string; checkedAtMs: number | null; error: string | null; pairChanged: boolean },
  nowMs: number,
): boolean {
  if (row.checkedAtMs === null || row.pairChanged) return true;
  const age = nowMs - row.checkedAtMs;
  if (isTransientChainError(row.error)) return age >= CHAIN_ERROR_RETRY_MS + chainRetryJitterMs(row.mint);
  return age >= CHAIN_VERDICT_TTL_MS;
}

export async function selectDueChainChecks(now: Date, limit = CHECKS_PER_TICK): Promise<DueRow[]> {
  const fresh = new Date(now.getTime() - 5 * 60_000).toISOString();
  const stale = new Date(now.getTime() - CHAIN_VERDICT_TTL_MS).toISOString();
  const retryFloor = new Date(now.getTime() - CHAIN_ERROR_RETRY_MS).toISOString();
  const transient = JSON.stringify(CHAIN_TRANSIENT_ERRORS.map((code) => `chain_check_error: ${code}`));
  const tradeablePrefixes = JSON.stringify(FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES);
  const nowIso = now.toISOString();
  const universe = (table: 'floor_discovery_mints' | 'floor_arena_private_mints') => sql`
    snapshot IS NOT NULL
    AND snapshot_at >= ${fresh}::timestamptz
    AND (snapshot->>'priceUsd')::double precision > 0
    AND (snapshot->>'mcap')::double precision BETWEEN ${CHAIN_UNIVERSE.mcapMin} AND ${CHAIN_UNIVERSE.mcapMax}
    AND (chain_checked_at IS NULL OR chain_checked_at <= ${stale}::timestamptz
         OR chain_verdict->>'pairAddress' IS DISTINCT FROM snapshot->>'pairAddress'
         OR (chain_verdict->>'error' IN (SELECT jsonb_array_elements_text(${transient}::jsonb))
             AND chain_checked_at <= ${retryFloor}::timestamptz))
    ${table === 'floor_discovery_mints' ? sql`
      AND expires_at > ${nowIso}::timestamptz
      -- D28: only coins with a TRADEABLE source (same rule as isFloorArenaTradeableSource); a GeckoTerminal-only coin
      -- is never bought (D25), so it gets no RPC budget. Private add-on mints are all eligible.
      AND EXISTS (
        SELECT 1 FROM unnest(sources) AS src(s), jsonb_array_elements_text(${tradeablePrefixes}::jsonb) AS p(prefix)
        WHERE starts_with(src.s, p.prefix)
      )` : sql``}
  `;
  // Twice the limit: the per-mint jitter below may drop some errored rows this tick. Never-checked and checked rows
  // are read with separate limits, so a flood of new coins cannot hide the checked rows (Codex r14 reserve).
  const sharedColumns = sql`
    SELECT mint, snapshot, chain_checked_at IS NULL AS unchecked, first_seen_at, chain_checked_at,
      chain_verdict->>'error' AS verdict_error,
      (chain_verdict->>'pairAddress' IS DISTINCT FROM snapshot->>'pairAddress') AS pair_changed
    FROM floor_discovery_mints`;
  const shared = rowsOf(await db.execute(sql`
    (${sharedColumns}
      WHERE ${universe('floor_discovery_mints')} AND chain_checked_at IS NULL
      ORDER BY first_seen_at DESC
      LIMIT ${limit * 2})
    UNION ALL
    (${sharedColumns}
      WHERE ${universe('floor_discovery_mints')} AND chain_checked_at IS NOT NULL
      ORDER BY chain_checked_at ASC, first_seen_at DESC
      LIMIT ${limit * 2})
  `));
  const privateRows = rowsOf(await db.execute(sql`
    WITH due AS (
      SELECT DISTINCT ON (mint) mint, snapshot, chain_checked_at, first_seen_at,
        chain_verdict->>'error' AS verdict_error,
        (chain_verdict->>'pairAddress' IS DISTINCT FROM snapshot->>'pairAddress') AS pair_changed
      FROM floor_arena_private_mints
      WHERE ${universe('floor_arena_private_mints')}
      ORDER BY mint, chain_checked_at ASC NULLS FIRST, first_seen_at DESC
    )
    (SELECT mint, snapshot, true AS unchecked, first_seen_at, chain_checked_at, verdict_error, pair_changed FROM due
      WHERE chain_checked_at IS NULL ORDER BY first_seen_at DESC LIMIT ${limit * 2})
    UNION ALL
    (SELECT mint, snapshot, false AS unchecked, first_seen_at, chain_checked_at, verdict_error, pair_changed FROM due
      WHERE chain_checked_at IS NOT NULL ORDER BY chain_checked_at ASC, first_seen_at DESC LIMIT ${limit * 2})
  `));
  const nowMs = now.getTime();
  const byMint = new Map<string, DueRow>();
  for (const row of [...privateRows, ...shared]) {
    const mint = String(row.mint);
    if (byMint.has(mint)) continue;
    const checkedAt = row.chain_checked_at === null || row.chain_checked_at === undefined
      ? null : new Date(row.chain_checked_at instanceof Date ? row.chain_checked_at.getTime() : String(row.chain_checked_at)).getTime();
    const due = chainVerdictDue({
      mint,
      checkedAtMs: checkedAt !== null && Number.isFinite(checkedAt) ? checkedAt : null,
      error: typeof row.verdict_error === 'string' ? row.verdict_error : null,
      pairChanged: row.pair_changed === true || row.pair_changed === 't',
    }, nowMs);
    if (!due) continue;
    byMint.set(mint, {
      mint,
      snapshot: (row.snapshot ?? null) as FloorArenaSnapshot | null,
      unchecked: row.unchecked === true || row.unchecked === 't',
      firstSeenMs: new Date(row.first_seen_at instanceof Date ? row.first_seen_at.getTime() : String(row.first_seen_at)).getTime(),
      checkedAtMs: checkedAt !== null && Number.isFinite(checkedAt) ? checkedAt : null,
    });
  }
  return pickDueChainChecks([...byMint.values()], limit);
}

type ArenaDatabase = Pick<typeof db, 'execute' | 'transaction'>;

/**
 * O3 lock order (discovery-hub.ts byMint: mint COLLATE "C", then agent_id). The shared row is ONE row (mint is its
 * key). The private table has one row per agent for the mint, and a bare `UPDATE ... WHERE mint = X` locks them in
 * scan order, which can wait in a cycle with the snapshot write (storeSnapshots locks mint, then agent_id). So a
 * short transaction locks them first in that order (agent_id COLLATE "C", FOR NO KEY UPDATE = the UPDATE's own
 * strength), then updates ONLY the rows it locked; a row that appears between the two statements stays unchecked and
 * is checked on a later tick.
 */
export async function storeChainVerdict(
  mint: string,
  verdict: ArenaChainVerdict,
  now: Date,
  database: ArenaDatabase = db,
): Promise<void> {
  const payload = JSON.stringify(verdict);
  const at = now.toISOString();
  await database.execute(sql`UPDATE floor_discovery_mints SET chain_verdict = ${payload}::jsonb, chain_checked_at = ${at}::timestamptz WHERE mint = ${mint}`);
  await database.transaction(async (tx) => {
    const locked = rowsOf(await tx.execute(sql`
      SELECT p.agent_id FROM floor_arena_private_mints AS p
      WHERE p.mint = ${mint}
      ORDER BY p.agent_id COLLATE "C"
      FOR NO KEY UPDATE OF p
    `));
    if (locked.length === 0) return;
    const agentIds = JSON.stringify(locked.map((row) => String(row.agent_id)));
    await tx.execute(sql`
      UPDATE floor_arena_private_mints AS p
      SET chain_verdict = ${payload}::jsonb, chain_checked_at = ${at}::timestamptz
      WHERE p.mint = ${mint} AND p.agent_id IN (SELECT jsonb_array_elements_text(${agentIds}::jsonb))
    `);
  });
}

export interface ChainTickResult { checked: number; passed: number; errors: number; skipped: 'rpc_not_configured' | null }

export async function runChainCheckTick(
  now: Date = new Date(),
  deps: { rpc?: ChainRpc; configured?: () => boolean } = {},
): Promise<ChainTickResult> {
  if (!(deps.configured ?? tradingRpcConfigured)()) {
    // No verdicts are written: coins stay chain_pending (no entries) and are checked as soon as RPC is configured.
    return { checked: 0, passed: 0, errors: 0, skipped: 'rpc_not_configured' };
  }
  const rpc = deps.rpc ?? web3ChainRpc(tradingConnection());
  const due = await selectDueChainChecks(now);
  const solPrice = currentSolPriceUsd(now.getTime());
  let passed = 0;
  let errors = 0;
  for (let i = 0; i < due.length; i += CHECK_CONCURRENCY) {
    await Promise.all(due.slice(i, i + CHECK_CONCURRENCY).map(async (row) => {
      // The DB snapshot is the only snapshot source (Codex r9).
      const snapshot = row.snapshot;
      if (!snapshot) return;
      const verdict = await runChainCheck(rpc, row.mint, snapshot, solPrice, now);
      if (verdict.pass) passed += 1;
      if (verdict.error) errors += 1;
      await storeChainVerdict(row.mint, verdict, now);
    }));
  }
  return { checked: due.length, passed, errors, skipped: null };
}
