import { pgTable, uuid, numeric, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * MOONPAY EVENTS (Tokenomics C2, 2026-07-07) — webhook idempotency ledger for
 * the TEST-MODE MoonPay card→USDC rail.
 *
 * ONE row per MoonPay TRANSACTION (not per webhook delivery):
 * `external_tx_id` = MoonPay's own transaction id (`data.id` in the webhook
 * body) and is UNIQUE — the DB index, not application SELECT-then-act, is what
 * makes a replayed webhook harmless. The webhook route
 * (`apps/api/src/routes/moonpay.ts`) INSERTs `ON CONFLICT DO NOTHING`; on
 * conflict it applies a GUARDED progression update (`WHERE processed_at IS
 * NULL`) so a status progression (pending → completed) lands exactly once and
 * a replay of a terminal event changes nothing (200 cached).
 *
 * Columns:
 *   - `external_tx_id` — MoonPay's transaction id. UNIQUE (the idempotency
 *     anchor). NOT our reference — see `client_ref`.
 *   - `client_ref`     — OUR opaque reference embedded in the signed widget
 *     URL as MoonPay's `externalTransactionId` param. The CHECKOUT-stage seam:
 *     a pending checkout joins on this to learn "the USDC for ref X arrived".
 *   - `status`         — MoonPay transaction status (pending / waitingPayment /
 *     completed / failed / …). Stored verbatim (text, not enum — MoonPay owns
 *     the vocabulary).
 *   - `wallet_address` — destination custodial wallet MoonPay reported.
 *   - `base_currency_amount` / `quote_currency_amount` — fiat paid / USDC
 *     delivered, USD decimals `numeric(20,6)`. NEVER ClawToken amounts.
 *   - `payload`        — the full verified webhook body (audit trail).
 *   - `processed_at`   — the at-most-once "checkout ready" marker: stamped
 *     when a TERMINAL status (completed/failed) is recorded, claimable exactly
 *     once via the conditional update. The v1 side effect is THIS MARKER ONLY —
 *     no custodial auto-sign, no CT movement (Codex-gated seam in the route).
 *
 * Migration: `packages/database/migrations/0015_moonpay_events.sql`
 * (idempotent CREATE TABLE IF NOT EXISTS; apply by hand/CI — NEVER db:push).
 * This table never touches `avatars.clawTokens` or the CT ledger.
 */
export const moonpayEvents = pgTable(
  'moonpay_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** MoonPay's transaction id (`data.id`) — the UNIQUE idempotency anchor. */
    externalTxId: text('external_tx_id').notNull().unique(),
    /** Webhook event type, e.g. 'transaction_updated'. */
    eventType: text('event_type').notNull(),
    /** MoonPay transaction status, stored verbatim. */
    status: text('status'),
    /** OUR reference (MoonPay's `externalTransactionId` param) — checkout seam. */
    clientRef: text('client_ref'),
    /** Destination custodial wallet (base58) MoonPay reported. */
    walletAddress: text('wallet_address'),
    /** Fiat paid (USD decimal). */
    baseCurrencyAmount: numeric('base_currency_amount', { precision: 20, scale: 6 }),
    /** Crypto delivered (USDC decimal). */
    quoteCurrencyAmount: numeric('quote_currency_amount', { precision: 20, scale: 6 }),
    /** Delivered currency code, e.g. 'usdc_sol'. */
    currencyCode: text('currency_code'),
    /** Full verified webhook body — audit trail. */
    payload: jsonb('payload').default({}).notNull(),
    /** At-most-once terminal-processing marker (the "checkout ready" signal). */
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The checkout stage polls "did the USDC for ref X arrive" by client_ref.
    clientRefIdx: index('moonpay_events_client_ref_idx').on(t.clientRef),
  }),
);
