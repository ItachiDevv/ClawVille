import { pgTable, uuid, numeric, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * CLV PRICE SNAPSHOTS (Tokenomics T0, 2026-07-07) — the durable price history
 * behind the READ-ONLY CLV price oracle (`apps/api/src/services/clv-price-oracle.ts`).
 *
 * The oracle polls the on-chain price of the ClawVille token
 * (mint `Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA`, Token-2022, 6 decimals,
 * ~$0.00007 today on a thin ~$22k LP) roughly every 60s — Helius DAS `getAsset`
 * price primary, DexScreener (keyless) fallback — and writes one row per
 * SUCCESSFUL fetch. The rows seed the in-memory 30-minute TWAP window across
 * process restarts and back the admin read route `GET /api/oracle/clv?history=N`.
 *
 *   - `priceUsd` — spot price in USD, `numeric(20,12)` so a sub-cent token keeps
 *     full precision (12 fractional digits; integer part << 8 digits, never
 *     overflows). Stored full-precision; the JS spot/TWAP quote derived from it
 *     is display-grade. This is a USD DECIMAL — NEVER a ClawToken amount.
 *   - `source` — which feed produced the row: `'helius'` | `'dexscreener'`.
 *     (`'last_known'` is a QUOTE-level label the oracle returns when it is
 *     serving a cached value because the latest live poll failed; it is never
 *     written as a stored row source — stored rows are always a real fetch.)
 *   - `created_at` — snapshot time; indexed for the 30-min TWAP window + the
 *     `history` read ordering.
 *
 * READ-ONLY price feed: this table and the oracle NEVER touch
 * `avatars.clawTokens` or the ClawToken ledger. Additive migration
 * `packages/database/migrations/0008_clv_price_snapshots.sql`
 * (idempotent `CREATE TABLE IF NOT EXISTS`; apply by hand/CI — NEVER db:push).
 */
export const clvPriceSnapshots = pgTable(
  'clv_price_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Spot CLV price in USD. numeric(20,12) — full precision for a sub-cent token. */
    priceUsd: numeric('price_usd', { precision: 20, scale: 12 }).notNull(),
    /** Feed that produced this row: 'helius' | 'dexscreener'. */
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    createdAtIdx: index('clv_price_snapshots_created_at_idx').on(t.createdAt),
  }),
);
