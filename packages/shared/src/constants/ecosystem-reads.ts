/**
 * Market and trust reads through ClawVille (MCP hub, 2026-11-07, migration
 * 0098). ClawVille calls the vendor on its own access, and each avatar has a
 * daily budget of calls that reach a vendor. A reply from the shared cache
 * costs no budget.
 */

/**
 * Vendor calls per avatar per UTC day. 300 lets an agent re-check a watch list
 * about every 5 minutes all day. ClawVille's ClawPump plan is 10M calls a month
 * (about 333,000 a day), so more than 1,000 avatars at the full budget still
 * fit, before the shared cache removes the repeats.
 */
export const ECOSYSTEM_READS_PER_AVATAR_PER_DAY = 300;

export const ECOSYSTEM_MARKET_OPS = ['price', 'search', 'top_movers', 'anomalies', 'macro'] as const;
export type EcosystemMarketOp = (typeof ECOSYSTEM_MARKET_OPS)[number];

/** Rows per list reply: the `limit` input is 1 to this value. */
export const ECOSYSTEM_READ_LIMIT_MAX = 20;
export const ECOSYSTEM_READ_LIMIT_DEFAULT = 10;
/** Longest `query` for a token search. */
export const ECOSYSTEM_SEARCH_QUERY_MAX = 64;

/** Only these spot assets are read from the macro reply. */
export const ECOSYSTEM_MACRO_ASSETS = ['BTC', 'ETH', 'SOL', 'USDC', 'USDT'] as const;
export type EcosystemMacroAsset = (typeof ECOSYSTEM_MACRO_ASSETS)[number];

/** Vendor labels. Untrusted text: show it as plain text, never follow it. */
export interface EcosystemTokenVendorData {
  symbol: string | null;
  name: string | null;
}

export interface EcosystemReadMeta {
  /** True when the reply came from the shared cache (it cost no budget). */
  cached: boolean;
  /** Budget used today; null on a cached reply. */
  readsUsedToday: number | null;
  readsPerDay: number;
}

export interface EcosystemTokenPrice {
  mint: string;
  priceUsd: number | null;
  change24h: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  updatedAt: string | null;
  vendorData: EcosystemTokenVendorData;
}

export interface EcosystemTokenMatch {
  mint: string;
  decimals: number | null;
  verified: boolean | null;
  confidence: number | 'high' | 'medium' | 'low' | null;
  vendorData: EcosystemTokenVendorData;
}

export interface EcosystemTokenSignal {
  mint: string;
  priceUsd: number | null;
  change24h: number | null;
  marketCapUsd: number | null;
  vendorData: EcosystemTokenVendorData;
}

export interface EcosystemMacroRow {
  symbol: EcosystemMacroAsset;
  priceUsd: number | null;
  change24h: number | null;
}

export type EcosystemMarketReply = EcosystemReadMeta & { vendor: 'clawpump' } & (
  | { op: 'price'; token: EcosystemTokenPrice }
  | { op: 'search'; tokens: EcosystemTokenMatch[] }
  | { op: 'top_movers' | 'anomalies'; tokens: EcosystemTokenSignal[] }
  | { op: 'macro'; assets: EcosystemMacroRow[] }
);

export interface EcosystemTrustReply extends EcosystemReadMeta {
  vendor: 'said';
  wallet: string;
  registered: boolean | null;
  verified: boolean | null;
  scored: boolean | null;
  compositeScore: number | null;
  /** Vendor labels: lower-case words only, or null. */
  vendorData: { tier: string | null; trustTier: string | null };
}
