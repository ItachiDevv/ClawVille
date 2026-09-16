import { Connection, PublicKey } from '@solana/web3.js';
import {
  ExtensionType,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  unpackMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { TRADE_MINTS } from '@clawville/shared';

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
  const endpoint = process.env.HELIUS_RPC_URL;
  if (!endpoint) throw new Error('[trading-floor] Helius mainnet RPC is not configured');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !url.hostname.toLowerCase().includes('mainnet')) throw new Error('[trading-floor] Helius RPC is not a mainnet endpoint');
  return new Connection(endpoint, 'confirmed');
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
  if (!deps.connection) cache.set(mint, read);
  return read;
}

/** Resolve and freeze the four-mint execution list for this process. */
export function loadTradingMintWhitelist(
  deps: { connection?: Connection; minContextSlot?: number } = {},
): Promise<ReadonlyMap<string, MintInfo>> {
  if (whitelistCache) return whitelistCache;
  whitelistCache = (async () => {
    const entries = await Promise.all(Object.values(TRADE_MINTS).map(async (mint) => {
      const info = await getMintInfo(mint, deps);
      if (!info || info.mintAuthority !== null) return null;
      if (info.extensions.some((extension) => VALUE_AFFECTING_EXTENSION.test(extension))) return null;
      const expectedDecimals = mint === TRADE_MINTS.WSOL ? 9 : 6;
      if (info.decimals !== expectedDecimals) return null;
      const token2022 = mint === TRADE_MINTS.ANSEM || mint === TRADE_MINTS.CLAWVILLE;
      const expectedProgram = token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      if (!info.programId.equals(expectedProgram)) return null;
      if (token2022) {
        const extensions = info.extensions.map((extension) => extension.toLowerCase()).sort();
        if (extensions.join(',') !== 'metadatapointer,tokenmetadata') return null;
      } else if (info.extensions.length !== 0) return null;
      if (mint === TRADE_MINTS.USDC) {
        if (info.freezeAuthority === null) return null;
      } else if (info.freezeAuthority !== null) return null;
      return [mint, info] as const;
    }));
    const resolved = new Map<string, MintInfo>();
    for (const entry of entries) {
      if (entry) resolved.set(entry[0], entry[1]);
    }
    return resolved;
  })();
  return whitelistCache;
}

export function deriveTradingAta(owner: PublicKey, info: MintInfo): PublicKey {
  return getAssociatedTokenAddressSync(new PublicKey(info.mint), owner, true, info.programId);
}

export function clearTradingMintInfoCacheForTests(): void {
  cache.clear();
  whitelistCache = null;
}
