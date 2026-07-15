import {
  pgTable,
  pgEnum,
  uuid,
  bigint,
  numeric,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * CLV BUY QUEUE (Tokenomics C3, 2026-07-07; executor columns 2026-07-07 GoLive) —
 * the shared swap-queue seam.
 *
 * Every spine that owes the market a CLV buy (checkout USDC splits, marketplace
 * fee routing, …) records INTENT here via
 * `apps/api/src/services/clv-swap-executor.ts enqueueClvBuy()` — one row per
 * owed buy, composable into the caller's settle transaction. The row is a
 * RECORD, not an action: enqueueing does NO CT-ledger write and NO on-chain
 * action.
 *
 * Lifecycle (`clv_buy_status`):
 *   - `planned`   — recorded intent (the ONLY status the dry-run path writes).
 *   - `executing` — ATOMICALLY CLAIMED by the (dark, Codex-gated) live
 *     executor (`clv-swap-live.ts`): `UPDATE … SET status='executing',
 *     claim_id, claimed_at WHERE id=$1 AND status='planned' RETURNING *` — the
 *     claim happens BEFORE any decrypt/sign/send. A row left `executing`
 *     (crash mid-clip) is NEVER auto-resumed — it is a reconciler case (its
 *     partial fills are durable in `tx_signatures`).
 *   - `executed`  — every clip confirmed; `executed_at`/`executed_price` set.
 *   - `skipped`   — reserved for an operator/live-executor decision to not buy
 *     (e.g. permanent no-liquidity, cancelled intent); `skipped_reason` says why.
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
 *     executor (numeric(6,4), e.g. 0.0100 = 1%). NULL ⇒ the env cap
 *     (`CLV_SWAP_SLIPPAGE_BPS`) applies.
 *   - `reason`      — why this buy is owed (e.g. 'checkout_clv_leg').
 *   - `source_ref`  — the originating row/tx the buy settles for (checkoutId,
 *     order id, ledger id, …) so an auditor can walk queue → source. The
 *     partial UNIQUE `(reason, source_ref) WHERE source_ref IS NOT NULL` makes
 *     enqueue IDEMPOTENT: a replayed settle upserts and gets the EXISTING
 *     queueId back (never a second owed buy for one source event).
 *   - `claim_id` / `claimed_at` — the live executor's atomic-claim token
 *     (uuid per claim) + when it was taken. NULL unless claimed.
 *   - `executed_at` / `executed_price` — set when ALL clips confirmed;
 *     `executed_price` (numeric(20,12)) is the realized average USD/CLV
 *     derived from the confirmed clip quotes.
 *   - `tx_signatures` — jsonb array of per-clip fill records
 *     `{index, amountUsdc, signature, outAmountAtomic, quotedAt}` — each entry
 *     is CAPTURED in its own committed UPDATE BEFORE the clip tx is sent
 *     (capture-before-send: an ambiguous send can never lose its signature).
 *   - `skipped_reason` — why a `skipped` row was skipped.
 *   - `metadata`    — reason-specific payload.
 *
 * Migrations: `0014_clv_swap_queue.sql` (base) +
 * `0019_clv_swap_executor.sql` (claim/exec columns + the idempotency UNIQUE +
 * `clv_swap_funding`) + `0019a_clv_buy_status_executing.sql` (the enum value,
 * ALONE per the migrate-ci ALTER TYPE rule). Apply by hand/CI — NEVER db:push.
 * This table never touches `avatars.clawTokens` or the CT ledger.
 */
// NOTE: 'executing' is listed LAST to mirror the physical Postgres enum order
// (ALTER TYPE … ADD VALUE appends; drizzle's array order must match the DB).
export const clvBuyStatusEnum = pgEnum('clv_buy_status', [
  'planned',
  'executed',
  'skipped',
  'executing',
]);

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
    /** Originating row/tx reference (checkoutId, order id, ledger id, …). */
    sourceRef: text('source_ref'),
    /** Live-executor atomic-claim token (uuid per claim); NULL unless claimed. */
    claimId: uuid('claim_id'),
    /** When the current claim was taken. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** When ALL clips confirmed (status='executed'). */
    executedAt: timestamp('executed_at', { withTimezone: true }),
    /** Realized average USD/CLV across confirmed clips. */
    executedPrice: numeric('executed_price', { precision: 20, scale: 12 }),
    /** Per-clip fill records, appended capture-before-send (see header). */
    txSignatures: jsonb('tx_signatures'),
    /** Why a `skipped` row was skipped. */
    skippedReason: text('skipped_reason'),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The dry-run worker (and the live executor) scans planned rows
    // oldest-first; the composite keeps that read an index walk.
    statusCreatedIdx: index('clv_buy_queue_status_created_idx').on(t.status, t.createdAt),
    /** Enqueue idempotency: one owed buy per (reason, source event). A settle
     *  replay upserts against this and gets the EXISTING queueId back. */
    reasonSourceRefUniq: uniqueIndex('clv_buy_queue_reason_source_ref_uniq')
      .on(t.reason, t.sourceRef)
      .where(sql`source_ref IS NOT NULL`),
  }),
);

/**
 * CLV SWAP FUNDING (Tokenomics GoLive executors, 2026-07-07) — the durable DB
 * trail for the merchant→swap-wallet USDC FUNDING SWEEP.
 *
 * Before the live executor can buy CLV, the owed USDC (sitting in the
 * x402-merchant wallet from a SETTLED checkout) must move on-chain to the
 * 'clv-swap' treasury wallet. That sweep is REAL money movement, so it gets
 * its own exactly-once ledger — one row per swept source event:
 *
 *   - `source_ref` (UNIQUE) — the same source_ref as the `clv_buy_queue` row
 *     being funded (= the settled `x402_checkouts.id` for checkout-backed
 *     buys). The UNIQUE is the double-sweep guard: a second sweep attempt
 *     upserts into the SAME row and finds it claimed/swept.
 *   - `checkout_id` — the settled checkout the amount is tied to. Sweeps are
 *     ONLY ever sized from a SETTLED checkout's usd_cents (never an operator
 *     free-hand amount — no out-of-band manual custody).
 *   - `amount_usdc` — numeric(20,6), µUSD precision; must be ≤ the checkout's
 *     settled USD.
 *   - `status` (text) — 'pending' → 'sweeping' (claimed via claim_id, the
 *     x402-checkout claim pattern) → 'swept' (confirmed). Terminal failures:
 *     'failed' (definitive on-chain failure — no money moved) and 'reconcile'
 *     (AMBIGUOUS send/confirm — money-state unknown, NEVER auto-retried;
 *     mirrors x402-checkout's settle_ambiguous discipline).
 *   - `sweep_tx_signature` — CAPTURED in its own committed UPDATE BEFORE the
 *     transfer is sent (capture-before-send) and partial-UNIQUE: one on-chain
 *     sweep binds to exactly one funding row.
 *   - `failure_reason` — machine reason for failed/reconcile rows.
 *
 * Migration: `0019_clv_swap_executor.sql`. Live writes happen ONLY behind the
 * dark `CLV_SWAP_EXECUTE` seam (`clv-swap-live.ts`). This table never touches
 * `avatars.clawTokens` or the CT ledger.
 */
export const clvSwapFunding = pgTable(
  'clv_swap_funding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The funded source event (== the clv_buy_queue source_ref). UNIQUE = double-sweep guard. */
    sourceRef: text('source_ref').notNull().unique(),
    /** The SETTLED x402_checkouts row the amount is tied to. */
    checkoutId: uuid('checkout_id'),
    /** Swept USDC amount — µUSD precision; ≤ the checkout's settled USD. */
    amountUsdc: numeric('amount_usdc', { precision: 20, scale: 6 }).notNull(),
    /** 'pending' | 'sweeping' | 'swept' | 'failed' | 'reconcile' (see header). */
    status: text('status').default('pending').notNull(),
    /** Captured BEFORE send; partial-UNIQUE (one sweep tx per funding row). */
    sweepTxSignature: text('sweep_tx_signature'),
    /** Atomic-claim token (uuid per claim); NULL unless claimed. */
    claimId: uuid('claim_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    sweptAt: timestamp('swept_at', { withTimezone: true }),
    /** Confirmation context that orders later custody reads across RPC replicas. */
    sweepConfirmedSlot: bigint('sweep_confirmed_slot', { mode: 'number' }),
    /** Machine reason for failed/reconcile rows. */
    failureReason: text('failure_reason'),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    statusCreatedIdx: index('clv_swap_funding_status_created_idx').on(t.status, t.createdAt),
    /** One on-chain sweep tx binds to exactly one funding row (capture key). */
    sweepSigUniq: uniqueIndex('clv_swap_funding_sweep_sig_uniq')
      .on(t.sweepTxSignature)
      .where(sql`sweep_tx_signature IS NOT NULL`),
  }),
);

export type ClvSwapFunding = typeof clvSwapFunding.$inferSelect;
export type NewClvSwapFunding = typeof clvSwapFunding.$inferInsert;
