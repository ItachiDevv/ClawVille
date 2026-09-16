import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { TRADE_MINTS } from '@clawville/shared';
import type { TradingBaselineEvidence } from '@clawville/database';
import { fetchJupiterPrices } from './trade-price';
import { deriveTradingAta, getMintInfo } from './trading-mint-info';
import { tradingConnection } from './trading-rpc';

export interface TradingPosition {
  symbol: string;
  mint: string;
  amountAtomic: bigint;
  decimals: number;
  valueUsdMicros: bigint;
  priceUsdMicros: bigint;
  priceTimestampMs: number;
}

export interface TradingWalletEquity {
  slot: number;
  equityUsdMicros: bigint;
  nativeLamports: bigint;
  positions: TradingPosition[];
}

function defaultConnection(): Connection {
  return tradingConnection();
}

function priceMicros(usd: number): bigint {
  const scaled = usd * 1_000_000;
  if (!Number.isFinite(scaled) || scaled < 0) throw new Error('equity_price_conversion_failed');
  return BigInt(Math.floor(scaled));
}

function positionValueMicros(amount: bigint, decimals: number, usdMicros: bigint): bigint {
  if (amount < 0n || decimals < 0 || usdMicros < 0n) throw new Error('equity_conversion_failed');
  return amount * usdMicros / (10n ** BigInt(decimals));
}

export function toTradingBaselineEvidence(equity: TradingWalletEquity): TradingBaselineEvidence {
  return {
    slot: equity.slot,
    equityUsdMicros: equity.equityUsdMicros.toString(),
    nativeLamports: equity.nativeLamports.toString(),
    positions: equity.positions.map((position) => ({
      symbol: position.symbol,
      mint: position.mint,
      amountAtomic: position.amountAtomic.toString(),
      decimals: position.decimals,
      valueUsdMicros: position.valueUsdMicros.toString(),
      priceUsdMicros: position.priceUsdMicros.toString(),
      priceTimestampMs: position.priceTimestampMs,
    })),
  };
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
    const priceTimestampMs = Date.now();
    const prices = await fetchJupiterPrices(
      [TRADE_MINTS.WSOL, TRADE_MINTS.ANSEM, TRADE_MINTS.CLAWVILLE],
      { fetchImpl: input.fetchImpl, nowMs: priceTimestampMs, maxAgeMs: Number(process.env.TRADING_PRICE_MAX_AGE_MS ?? 2_000) },
    );
    prices.set(TRADE_MINTS.USDC, {
      mint: TRADE_MINTS.USDC, usdPrice: 1, blockId: slot, decimals: 6,
      liquidity: null, priceChange24h: null, createdAt: null, launchpad: null, fetchedAt: priceTimestampMs,
    });
    if (mints.some(([, mint], index) => !prices.has(mint) || prices.get(mint)!.decimals !== infos[index]!.decimals)) return null;

    const positions: TradingPosition[] = [];
    const solPrice = prices.get(TRADE_MINTS.WSOL)!;
    const solPriceMicros = priceMicros(solPrice.usdPrice);
    positions.push({
      symbol: 'SOL', mint: TRADE_MINTS.WSOL, amountAtomic: nativeLamports, decimals: 9,
      valueUsdMicros: positionValueMicros(nativeLamports, 9, solPriceMicros),
      priceUsdMicros: solPriceMicros,
      priceTimestampMs: solPrice.fetchedAt,
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
      const price = prices.get(mint);
      if (!price) return null;
      const usdMicros = priceMicros(price.usdPrice);
      positions.push({
        symbol,
        mint,
        amountAtomic: amount,
        decimals: info.decimals,
        valueUsdMicros: positionValueMicros(amount, info.decimals, usdMicros),
        priceUsdMicros: usdMicros,
        priceTimestampMs: price.fetchedAt,
      });
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
