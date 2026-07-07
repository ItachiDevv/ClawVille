import { pgTable, pgEnum, uuid, numeric, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * CLV BUY QUEUE (Tokenomics C3, 2026-07-07) — the shared swap-queue seam.
 *
 * Every spine that owes the market a CLV buy (checkout USDC splits, marketplace
 * fee routing, …) records INTENT here via
 * `apps/api/src/services/clv-swap-executor.ts enqueueClvBuy()` — one row per
 * owed buy, composable into the caller's settle transaction. The row is a
 * RECORD, not an action: enqueueing does NO CT-ledger write and NO on-chain
 * action.
 *
 * Lifecycle (`clv_buy_status`):
 *   - `planned`  — recorded intent (the ONLY status v1 ever writes).
 *   - `executed` — reserved for the LIVE executor (Codex-review-gated; the
 *     dry-run worker NEVER writes this).
 *   - `skipped`  — reserved for an operator/live-executor decision to not buy
 *     (e.g. no liquidity, cancelled intent). Never written in v1.
 *
 * Columns:
 *   - `amount_usdc`  — the owed buy size, USD decimal `numeric(20,6)` (µUSD
 *     precision, mirrors `claw_token_transactions.usd_basis`). NEVER a
 *     ClawToken amount.
 *   - `quoted_price` — the oracle's house-favorable CLV quote (`getClvPrice()
 *     .quoteUsd`, numeric(20,12)) stamped at enqueue time; NULL when the
 *     oracle had no usable quote. Observability + later slippage accounting —
 *     not a promise to fill at this price.
 *   - `max_slippage` — reserved per-row slippage override for the LIVE
 *     executor (numeric(6,4), e.g. 0.0100 = 1%). v1 leaves it NULL; the
 *     dry-run planner uses the env cap (`CLV_SWAP_MAX_IMPACT_BPS`).
 *   - `reason`      — why this buy is owed (e.g. 'checkout_clv_leg').
 *   - `source_ref`  — the originating row/tx the buy settles for (topupId,
 *     order id, ledger id, …) so an auditor can walk queue → source.
 *   - `metadata`    — reason-specific payload.
 *
 * Migration: `packages/database/migrations/0014_clv_swap_queue.sql`
 * (idempotent CREATE TYPE/TABLE/INDEX IF NOT EXISTS; apply by hand/CI — NEVER
 * db:push). This table never touches `avatars.clawTokens` or the CT ledger.
 */
export const clvBuyStatusEnum = pgEnum('clv_buy_status', ['planned', 'executed', 'skipped']);

export const clvBuyQueue = pgTable(
  'clv_buy_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Owed buy size in USD (USDC) — decimal string at µUSD precision. */
    amountUsdc: numeric('amount_usdc', { precision: 20, scale: 6 }).notNull(),
    /** Oracle quote (USD per CLV) stamped at enqueue; NULL when unavailable. */
    quotedPrice: numeric('quoted_price', { precision: 20, scale: 12 }),
    /** Reserved per-row slippage cap for the LIVE executor (fraction, 4 dp). */
    maxSlippage: numeric('max_slippage', { precision: 6, scale: 4 }),
    status: clvBuyStatusEnum('status').default('planned').notNull(),
    /** Why this buy is owed — e.g. 'checkout_clv_leg'. */
    reason: text('reason').notNull(),
    /** Originating row/tx reference (topupId, order id, ledger id, …). */
    sourceRef: text('source_ref'),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The dry-run worker (and the future live executor) scans planned rows
    // oldest-first; the composite keeps that read an index walk.
    statusCreatedIdx: index('clv_buy_queue_status_created_idx').on(t.status, t.createdAt),
  }),
);
