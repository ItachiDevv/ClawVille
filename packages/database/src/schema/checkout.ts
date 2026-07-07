import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  integer,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';
import { users } from './users';

/**
 * X402 CHECKOUTS (Tokenomics C — checkout stage, 2026-07-07) — the generic
 * "pay a vCLAW-priced thing with USDC" settlement ledger.
 *
 * ONE row per checkout attempt. The row is created PENDING at quote time
 * (`POST /api/x402/checkout/quote` → 402 challenge) and flipped to SETTLED in
 * the SAME transaction that runs the item's fulfiller
 * (`apps/api/src/services/x402-checkout.ts settleCheckout`). Structure copied
 * from `ct_topups` — the proven money path — because the invariants are
 * identical:
 *
 *   - `x402_checkouts_txsig_unique` (partial UNIQUE on tx_signature WHERE NOT
 *     NULL): a settled on-chain payment fulfills EXACTLY ONCE. The settle
 *     UPDATE claiming the signature + ALL fulfiller writes run in ONE
 *     transaction; a duplicate settle of the same signature trips 23505, the
 *     whole tx (fulfillment included) rolls back, and the route replays the
 *     already-fulfilled row. DB-enforced, never SELECT-then-act.
 *   - `x402_checkouts_idem_unique` (partial UNIQUE on (avatar_id,
 *     idempotency_key)): a retried settle with the same Idempotency-Key
 *     replays the cached fulfillment.
 *
 * MONEY MODEL (USDC-settles-underneath): the buyer pays REAL USDC to the
 * merchant wallet through the x402/PayAI facilitator; `price_vclaw` is the
 * QUOTE unit only (¢-peg: 1 vCLAW = $0.01, so `usd_cents == price_vclaw`
 * exactly — both stored so the peg at purchase time survives a future rate
 * change). The buyer's internal vCLAW is NEVER debited on this path, and no
 * fulfiller may mint unbacked vCLAW — every internal-vCLAW effect a fulfiller
 * produces must carry a `usd_basis` tracing to the settled tx (see the
 * fulfiller-contract doc in `x402-checkout.ts`).
 *
 * Migration: `packages/database/migrations/0016_x402_checkouts.sql`
 * (idempotent CREATE TABLE IF NOT EXISTS; apply by hand/CI — NEVER db:push).
 * This table itself never touches `avatars.clawTokens`; only fulfillers make
 * item-domain writes, inside the settle tx.
 */

/** What kind of vCLAW-priced thing this checkout pays for. `marketplace_purchase`
 *  + `tournament_entry` are RESERVED for the marketplace stage (it registers
 *  fulfillers against these values — adding them later would be a migration). */
export const checkoutItemKindEnum = pgEnum('checkout_item_kind', [
  'rent_payment',
  'cosmetic_purchase',
  'marketplace_purchase',
  'tournament_entry',
]);

/** Checkout settlement state — same lifecycle as `ct_topup_status`. */
export const checkoutStatusEnum = pgEnum('checkout_status', [
  'pending', // 402 quote issued, awaiting signed payment
  'settled', // facilitator settled the tx; fulfiller ran in the same DB tx
  'failed', // verify/settle definitively rejected (or fulfillment refused post-settle — see metadata.failureReason)
]);

export const x402Checkouts = pgTable(
  'x402_checkouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The buyer — human's or agent's OWN avatar (middleware-resolved, never body-supplied). */
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    itemKind: checkoutItemKindEnum('item_kind').notNull(),
    /** Kind-scoped item reference (skuId for cosmetics, parcelId for rent, …). */
    itemRef: varchar('item_ref', { length: 128 }).notNull(),
    /** The vCLAW quote price (positive integer). QUOTE UNIT ONLY — never debited. */
    priceVclaw: integer('price_vclaw').notNull(),
    /** The USD cents the buyer pays. ¢-peg: equals price_vclaw at quote time. */
    usdCents: integer('usd_cents').notNull(),
    /**
     * Settled Solana tx signature from the facilitator. UNIQUE (partial) — the
     * double-fulfillment guard. Nullable while status='pending'.
     */
    txSignature: text('tx_signature'),
    /** USD basis stamped at settle for accounting (numeric, nullable until settle). */
    usdBasisAtReceipt: numeric('usd_basis_at_receipt'),
    status: checkoutStatusEnum('status').notNull().default('pending'),
    /** Client-supplied idempotency on the settle call (per-avatar). */
    idempotencyKey: varchar('idempotency_key', { length: 64 }),
    /** network/subject-kind at quote; settle payer/network + `fulfillment` detail after settle. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    avatarIdx: index('x402_checkouts_avatar_idx').on(t.avatarId, t.createdAt),
    /** Double-fulfillment guard — a settled tx sig fulfills exactly once. Partial: ignores pending NULLs. */
    txSigUnique: uniqueIndex('x402_checkouts_txsig_unique')
      .on(t.txSignature)
      .where(sql`tx_signature IS NOT NULL`),
    /** Per-avatar settle idempotency. */
    idemUnique: uniqueIndex('x402_checkouts_idem_unique')
      .on(t.avatarId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    /** Amount discipline backstops — a zero/negative quote can never persist. */
    priceVclawPositive: check('x402_checkouts_price_vclaw_positive', sql`${t.priceVclaw} > 0`),
    usdCentsPositive: check('x402_checkouts_usd_cents_positive', sql`${t.usdCents} > 0`),
  }),
);

export type X402Checkout = typeof x402Checkouts.$inferSelect;
export type NewX402Checkout = typeof x402Checkouts.$inferInsert;
