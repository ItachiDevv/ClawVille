import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { TRADE_MINTS } from '@clawville/shared';
import { fetchJupiterPrices } from './trade-price';
import { deriveTradingAta, getMintInfo } from './trading-mint-info';

export interface TradingPosition {
  symbol: string;
  mint: string;
  amountAtomic: bigint;
  decimals: number;
  valueUsdMicros: bigint;
}

export interface TradingWalletEquity {
  slot: number;
  equityUsdMicros: bigint;
  nativeLamports: bigint;
  positions: TradingPosition[];
}

function defaultConnection(): Connection {
  const endpoint = process.env.HELIUS_RPC_URL;
  if (!endpoint) throw new Error('[trading-floor] Helius mainnet RPC is not configured');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !url.hostname.toLowerCase().includes('mainnet')) throw new Error('[trading-floor] Helius RPC is not a mainnet endpoint');
  return new Connection(endpoint, 'confirmed');
}

function micros(amount: bigint, decimals: number, usd: number): bigint {
  const scaled = Number(amount) / 10 ** decimals * usd * 1_000_000;
  if (!Number.isFinite(scaled) || scaled < 0) throw new Error('equity_conversion_failed');
  return BigInt(Math.floor(scaled));
}

export async function readTradingWalletEquity(input: {
  walletPubkey: string;
  connection?: Connection;
  fetchImpl?: typeof fetch;
}): Promise<TradingWalletEquity | null> {
  try {
    const connection = input.connection ?? defaultConnection();
    const owner = new PublicKey(input.walletPubkey);
    const slot = await connection.getSlot('confirmed');
    const nativeLamports = BigInt(await connection.getBalance(owner, { commitment: 'confirmed', minContextSlot: slot }));
    const mints = Object.entries(TRADE_MINTS);
    const infos = await Promise.all(mints.map(([, mint]) => getMintInfo(mint, { connection, minContextSlot: slot })));
    if (infos.some((info) => info === null)) return null;
    const prices = await fetchJupiterPrices(
      [TRADE_MINTS.WSOL, TRADE_MINTS.ANSEM, TRADE_MINTS.CLAWVILLE],
      { fetchImpl: input.fetchImpl, maxAgeMs: Number(process.env.TRADING_PRICE_MAX_AGE_MS ?? 2_000) },
    );
    prices.set(TRADE_MINTS.USDC, {
      mint: TRADE_MINTS.USDC, usdPrice: 1, blockId: slot, decimals: 6,
      liquidity: null, priceChange24h: null, createdAt: null, launchpad: null, fetchedAt: Date.now(),
    });
    if (!prices.has(TRADE_MINTS.WSOL)) return null;

    const positions: TradingPosition[] = [];
    positions.push({
      symbol: 'SOL', mint: TRADE_MINTS.WSOL, amountAtomic: nativeLamports, decimals: 9,
      valueUsdMicros: micros(nativeLamports, 9, prices.get(TRADE_MINTS.WSOL)!.usdPrice),
    });
    for (let i = 0; i < mints.length; i++) {
      const [symbol, mint] = mints[i]!;
      if (mint === TRADE_MINTS.WSOL) continue;
      const info = infos[i]!;
      let amount = 0n;
      try {
        const account = await connection.getAccountInfoAndContext(deriveTradingAta(owner, info), {
          commitment: 'confirmed',
          minContextSlot: slot,
        });
        if (account.context.slot < slot) return null;
        const value = account.value;
        if (value) {
          if (!value.owner.equals(info.programId) || value.data.length < 165 || !value.data.subarray(0, 32).equals(new PublicKey(mint).toBuffer())) return null;
          amount = value.data.readBigUInt64LE(64);
        }
      } catch {
        return null;
      }
      if (amount === 0n) continue;
      const price = prices.get(mint);
      if (!price) return null;
      positions.push({ symbol, mint, amountAtomic: amount, decimals: info.decimals, valueUsdMicros: micros(amount, info.decimals, price.usdPrice) });
    }
    return {
      slot,
      nativeLamports,
      positions,
      equityUsdMicros: positions.reduce((sum, position) => sum + position.valueUsdMicros, 0n),
    };
  } catch {
    return null;
  }
}

export async function hasUnknownPositiveTradingBalance(input: {
  walletPubkey: string;
  connection?: Connection;
  minContextSlot?: number;
}): Promise<boolean | null> {
  try {
    const conn = input.connection ?? defaultConnection();
    const owner = new PublicKey(input.walletPubkey);
    const allowed = new Set(Object.values(TRADE_MINTS));
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const rpc = conn as unknown as {
        _rpcRequest(method: string, args: unknown[]): Promise<{
          error?: unknown;
          result?: { context?: { slot?: number }; value?: Array<{ account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } } } }> };
        }>;
      };
      const response = await rpc._rpcRequest('getTokenAccountsByOwner', [
        owner.toBase58(),
        { programId: programId.toBase58() },
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          ...(input.minContextSlot === undefined ? {} : { minContextSlot: input.minContextSlot }),
        },
      ]);
      if (response.error || !response.result?.value) return null;
      if (input.minContextSlot !== undefined && Number(response.result.context?.slot ?? -1) < input.minContextSlot) return null;
      for (const account of response.result.value) {
        const parsed = account.account?.data?.parsed as { info?: { mint?: string; tokenAmount?: { amount?: string } } } | undefined;
        const mint = parsed?.info?.mint;
        const amount = parsed?.info?.tokenAmount?.amount;
        if (!mint || !amount || !/^\d+$/.test(amount)) return null;
        if (BigInt(amount) > 0n && !allowed.has(mint as never)) return true;
      }
    }
    return false;
  } catch {
    return null;
  }
}
