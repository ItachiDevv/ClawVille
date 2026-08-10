/**
 * Tokenomics Phase A / Slice A1 (2026-07-07) — linked-wallet CLV balance service.
 *
 * Reads the CLV ($CLAWVILLE) balance of a user's LINKED self-custody wallet
 * (`users.linked_wallet_pubkey`, proven via routes/wallet-link.ts). This is the
 * SHARED primitive the later hold-tier gate (M4 seller license), land
 * hold-to-keep (M3), and any "must hold N CLV" check read — built as a service,
 * NOT inlined, so all of them consult one cached reader.
 *
 * ── CLV is MAINNET ───────────────────────────────────────────────────────────
 * CLV is a real Token-2022 mint on mainnet (the same `CLV_MINT` the price oracle
 * reads), NOT on the devnet the wager program / special-events RPC default to. So
 * this service builds its OWN mainnet connection: Helius mainnet RPC when
 * `HELIUS_API_KEY` is set (the oracle's endpoint), else the public mainnet-beta
 * RPC as a rate-limited fallback. The CLV never leaves the wallet — we only READ.
 *
 * ── Caching + fail-soft ──────────────────────────────────────────────────────
 * 5-minute in-memory cache PER wallet pubkey (a hold-tier check must not hammer
 * the RPC on every request; thin-LP tokens don't move balances minute-to-minute).
 * A read failure returns `{ available: false }` and NEVER throws — a hold-tier
 * check degrades to "cannot confirm the hold right now" rather than crashing the
 * caller. `invalidateClvBalanceCache` drops a wallet's entry after a (re)link so
 * the next read is fresh.
 */

import { db, users, eq } from '@clawville/database';
import type { Connection } from '@solana/web3.js';
import { CLV_MINT } from './clv-price-oracle';
import { readSplTokenBalance, type SplTokenBalance } from './solana-token-balance';

export const CLV_BALANCE_CACHE_TTL_MS = 5 * 60 * 1000;
export const CLV_BALANCE_HARD_STALE_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 2_048;

interface CachedBalance {
  balance: SplTokenBalance;
  fetchedAt: number;
}

const balanceCache = new Map<string, CachedBalance>();

export interface ClvBalanceReadOptions {
  /** Maximum age accepted without an RPC read. Zero forces a fresh read. */
  maxAgeMs?: number;
  /** Maximum stale age accepted after RPC failure. Zero is fail-closed. */
  maxStaleAgeMs?: number;
}

/** Lazily-built mainnet connection (CLV lives on mainnet — see file header). */
let conn: Connection | null = null;
function getMainnetConnection(): Connection {
  if (!conn) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const web3 = require('@solana/web3.js') as typeof import('@solana/web3.js');
    const key = process.env.HELIUS_API_KEY?.trim();
    const url = key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : 'https://api.mainnet-beta.solana.com';
    conn = new web3.Connection(url, 'confirmed');
  }
  return conn;
}

export interface ClvBalanceResult {
  /** false when the on-chain read failed (RPC down / transport error). */
  available: boolean;
  /** Atomic CLV balance (base units) as a string, or null when unavailable. */
  amountAtomic: string | null;
  /** Mint decimals (from the on-chain account), or null when unavailable. */
  decimals: number | null;
  /** Human CLV amount (`amountAtomic / 10^decimals`), or null when unavailable. */
  uiAmount: number | null;
  /** Whether this read came from the 5-min cache. */
  cached: boolean;
  /** ISO timestamp the underlying balance was fetched. */
  fetchedAt: string | null;
}

const UNAVAILABLE: ClvBalanceResult = {
  available: false,
  amountAtomic: null,
  decimals: null,
  uiAmount: null,
  cached: false,
  fetchedAt: null,
};

/**
 * CLV balance of an ARBITRARY wallet pubkey (cached 5 min). The lower-level
 * primitive the hold-tier / land / seller-license checks call once they have a
 * pubkey. Fail-soft: never throws; returns `{ available: false }` on any error.
 */
export async function getWalletClvBalance(
  walletPubkey: string,
  options: ClvBalanceReadOptions = {},
): Promise<ClvBalanceResult> {
  const now = Date.now();
  const hit = balanceCache.get(walletPubkey);
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? CLV_BALANCE_CACHE_TTL_MS);
  const maxStaleAgeMs = Math.max(0, options.maxStaleAgeMs ?? CLV_BALANCE_HARD_STALE_MS);
  if (hit && maxAgeMs > 0 && now - hit.fetchedAt <= maxAgeMs) {
    return toResult(hit.balance, hit.fetchedAt, true);
  }

  try {
    const balance = await readSplTokenBalance(getMainnetConnection(), CLV_MINT, walletPubkey);
    const fetchedAt = Date.now();
    if (!balanceCache.has(walletPubkey) && balanceCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = balanceCache.keys().next().value as string | undefined;
      if (oldestKey) balanceCache.delete(oldestKey);
    }
    balanceCache.delete(walletPubkey);
    balanceCache.set(walletPubkey, { balance, fetchedAt });
    return toResult(balance, fetchedAt, false);
  } catch (err) {
    console.warn(`[clv-balance] read failed for ${walletPubkey.slice(0, 8)}… (non-fatal):`, (err as Error).message);
    // Serve a STALE cache entry (if any) rather than nothing — a hold check on a
    // transient RPC blip prefers a slightly old balance to a hard "unavailable".
    const failedAt = Date.now();
    if (hit && maxStaleAgeMs > 0 && failedAt - hit.fetchedAt <= maxStaleAgeMs) {
      return toResult(hit.balance, hit.fetchedAt, true);
    }
    return UNAVAILABLE;
  }
}

/**
 * CLV balance of a USER's linked wallet. Returns `{ linked: false }` when the
 * user has not linked a wallet yet; otherwise the wallet pubkey + its cached CLV
 * balance.
 */
export async function getLinkedWalletClvBalance(
  userId: string,
  options: ClvBalanceReadOptions = {},
): Promise<{
  linked: boolean;
  walletPubkey: string | null;
  clv: ClvBalanceResult;
}> {
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { linkedWalletPubkey: true },
  });
  const walletPubkey = row?.linkedWalletPubkey ?? null;
  if (!walletPubkey) {
    return { linked: false, walletPubkey: null, clv: UNAVAILABLE };
  }
  const clv = await getWalletClvBalance(walletPubkey, options);
  return { linked: true, walletPubkey, clv };
}

/** Drop a wallet's cached balance (call after a (re)link so the next read is fresh). */
export function invalidateClvBalanceCache(walletPubkey: string): void {
  balanceCache.delete(walletPubkey);
}

/** Test-only — clear the whole cache. */
export function _resetClvBalanceCacheForTest(): void {
  balanceCache.clear();
}

function toResult(balance: SplTokenBalance, fetchedAtMs: number, cached: boolean): ClvBalanceResult {
  return {
    available: true,
    amountAtomic: balance.amountAtomic.toString(),
    decimals: balance.decimals,
    uiAmount: balance.uiAmount,
    cached,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
  };
}
