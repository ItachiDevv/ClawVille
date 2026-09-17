import { Connection, PublicKey } from '@solana/web3.js';
import {
  ExtensionType,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  unpackMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { TRADE_MINTS, TRADE_USDC_AUTHORITIES } from '@clawville/shared';
import { alertError, type AlertErrorParams } from './alert-error';
import { shouldAlertTradingLoop, tradingConnection } from './trading-rpc';

export interface MintInfo {
  mint: string;
  decimals: number;
  programId: PublicKey;
  extensions: readonly string[];
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

const cache = new Map<string, Promise<MintInfo | null>>();
let whitelistCache: Promise<ReadonlyMap<string, MintInfo>> | null = null;
const VALUE_AFFECTING_EXTENSION = /TransferFee|TransferHook|PermanentDelegate|ConfidentialTransfer|DefaultAccountState/i;

function defaultConnection(): Connection {
  return tradingConnection();
}

export function getMintInfo(
  mint: string,
  deps: { connection?: Connection; minContextSlot?: number } = {},
): Promise<MintInfo | null> {
  const prior = cache.get(mint);
  if (prior && !deps.connection) return prior;
  const read = (async () => {
    try {
      const connection = deps.connection ?? defaultConnection();
      const key = new PublicKey(mint);
      const account = await connection.getAccountInfo(key, {
        commitment: 'confirmed',
        ...(deps.minContextSlot === undefined ? {} : { minContextSlot: deps.minContextSlot }),
      });
      if (!account) return null;
      if (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
      const parsed = unpackMint(key, account, account.owner);
      const extensionValues = account.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? getExtensionTypes(parsed.tlvData)
        : [];
      return {
        mint,
        decimals: parsed.decimals,
        programId: account.owner,
        extensions: extensionValues.map((value) => ExtensionType[value] ?? String(value)),
        mintAuthority: parsed.mintAuthority?.toBase58() ?? null,
        freezeAuthority: parsed.freezeAuthority?.toBase58() ?? null,
      } satisfies MintInfo;
    } catch {
      return null;
    }
  })();
  if (!deps.connection) {
    cache.set(mint, read);
    // Defensive: production callers pass a connection and bypass this cache. For
    // the no-connection path, a null is a failed or missing read (RPC timeout,
    // wrong commitment slot), not a fact about the mint; never pin it.
    const evict = () => {
      if (cache.get(mint) === read) cache.delete(mint);
    };
    void read.then((info) => {
      if (info === null) evict();
    }, evict);
  }
  return read;
}

interface MintShape {
  decimals: number;
  programId: PublicKey;
  /** Lower-cased, sorted, comma-joined Token-2022 extension names; '' for legacy SPL. */
  extensions: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

/**
 * The frozen on-chain shape of each whitelisted mint (read from mainnet
 * 2026-09-17). USDC is the only mint whose authorities are live (Circle mints
 * and can freeze), so it must match the pinned keys exactly; every other mint
 * must carry no authority of either kind. A mint absent from this table is
 * never admissible, whatever its shape.
 */
const MINT_SHAPES: Readonly<Record<string, MintShape>> = {
  [TRADE_MINTS.USDC]: {
    decimals: 6,
    programId: TOKEN_PROGRAM_ID,
    extensions: '',
    mintAuthority: TRADE_USDC_AUTHORITIES.mint,
    freezeAuthority: TRADE_USDC_AUTHORITIES.freeze,
  },
  [TRADE_MINTS.WSOL]: { decimals: 9, programId: TOKEN_PROGRAM_ID, extensions: '', mintAuthority: null, freezeAuthority: null },
  [TRADE_MINTS.ANSEM]: {
    decimals: 6,
    programId: TOKEN_2022_PROGRAM_ID,
    extensions: 'metadatapointer,tokenmetadata',
    mintAuthority: null,
    freezeAuthority: null,
  },
  [TRADE_MINTS.CLAWVILLE]: {
    decimals: 6,
    programId: TOKEN_2022_PROGRAM_ID,
    extensions: 'metadatapointer,tokenmetadata',
    mintAuthority: null,
    freezeAuthority: null,
  },
};

export function tradingMintAdmissible(mint: string, info: MintInfo): boolean {
  const shape = Object.hasOwn(MINT_SHAPES, mint) ? MINT_SHAPES[mint]! : null;
  if (!shape || info.mint !== mint) return false;
  if (info.extensions.some((extension) => VALUE_AFFECTING_EXTENSION.test(extension))) return false;
  if (info.decimals !== shape.decimals) return false;
  if (!info.programId.equals(shape.programId)) return false;
  const extensions = info.extensions.map((extension) => extension.toLowerCase()).sort().join(',');
  if (extensions !== shape.extensions) return false;
  return info.mintAuthority === shape.mintAuthority && info.freezeAuthority === shape.freezeAuthority;
}

const WHITELIST_SIZE = Object.keys(TRADE_MINTS).length;

/**
 * Resolve the four-mint execution list. A complete list is frozen for the
 * process; an incomplete one (any read failed or any mint changed shape) is
 * returned once, alerted once per missing set (then hourly), and retried on the
 * next call, so one RPC hiccup at boot cannot refuse every trade until a
 * restart, and a real shape change (an authority rotation) pages instead of
 * hiding behind `decimals_unresolved` refusal rows.
 */
export function loadTradingMintWhitelist(
  deps: { connection?: Connection; minContextSlot?: number; alert?: (params: AlertErrorParams) => Promise<void> } = {},
): Promise<ReadonlyMap<string, MintInfo>> {
  if (whitelistCache) return whitelistCache;
  const load = (async () => {
    const entries = await Promise.all(Object.values(TRADE_MINTS).map(async (mint) => {
      const info = await getMintInfo(mint, deps);
      if (!info) return { mint, info: null, cause: 'unreadable' as const };
      if (!tradingMintAdmissible(mint, info)) return { mint, info: null, cause: 'shape_changed' as const };
      return { mint, info, cause: null };
    }));
    const resolved = new Map<string, MintInfo>();
    for (const entry of entries) {
      if (entry.info) resolved.set(entry.mint, entry.info);
    }
    if (resolved.size !== WHITELIST_SIZE) {
      const missing = entries.filter((entry) => entry.cause).map((entry) => `${entry.mint}:${entry.cause}`).sort();
      if (shouldAlertTradingLoop(`mint-whitelist:${missing.join(',')}`)) {
        void (deps.alert ?? alertError)({
          severity: 'critical',
          source: 'trading-mint-whitelist',
          message: 'A whitelisted trading mint could not be admitted; every fleet trade refuses until it resolves.',
          context: { missing },
        });
      }
    }
    return resolved;
  })();
  whitelistCache = load;
  const release = () => {
    if (whitelistCache === load) whitelistCache = null;
  };
  void load.then((resolved) => {
    if (resolved.size !== WHITELIST_SIZE) release();
  }, release);
  return load;
}

export function deriveTradingAta(owner: PublicKey, info: MintInfo): PublicKey {
  return getAssociatedTokenAddressSync(new PublicKey(info.mint), owner, true, info.programId);
}

export function clearTradingMintInfoCacheForTests(): void {
  cache.clear();
  whitelistCache = null;
}
