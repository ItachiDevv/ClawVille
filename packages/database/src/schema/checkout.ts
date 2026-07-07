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

/**
 * Checkout settlement state — a DURABLE, cross-process, resumable machine (the
 * ct-topup lifecycle plus `settling` + `reconcile`, hardened after the Codex
 * money-path review). Transitions:
 *   pending   → settling   [DB-backed CLAIM: one process wins `WHERE status='pending'`
 *                           before the facilitator is ever called — cross-process
 *                           exclusion the in-process mutex cannot give]
 *   settling  → settling+sig [CAPTURE: the facilitator settled; tx_signature is
 *                           persisted in its OWN committed UPDATE IMMEDIATELY, so a
 *                           later fulfillment failure can NEVER lose the signature
 *                           and re-settle real USDC]
 *   settling+sig → settled [FULFILL: the fulfiller runs + the flip commit together;
 *                           a failure here leaves the row settling+sig ⇒ a retry
 *                           RESUMES fulfillment and NEVER re-calls the facilitator]
 *   settling  → pending    [transient facilitator failure, no money moved: release
 *                           the claim so a retry can re-claim]
 *   settling  → failed     [definitive facilitator rejection, no money moved]
 *   settling+sig → failed  [fulfillment refused post-capture: terminal, CARRYING the
 *                           signature (manual-refund trail)]
 *   settling  → reconcile  [stale claim with NO signature: money-state UNKNOWN — we
 *                           do NOT re-call the facilitator; a chain-check reconciler
 *                           resolves it] OR [signature-conflict: the settled tx sig is
 *                           already owned by a DIFFERENT checkout]
 * INVARIANT (DB CHECK `x402_checkouts_settled_has_signature`): a `settled` row
 * ALWAYS carries a tx_signature.
 */
export const checkoutStatusEnum = pgEnum('checkout_status', [
  'pending', // 402 quote issued, awaiting signed payment
  'settling', // CLAIMED for settlement; facilitator call in-flight (tx_signature NULL) or CAPTURED awaiting/​resuming fulfillment (tx_signature set)
  'settled', // facilitator settled the tx AND the fulfiller ran; tx_signature ALWAYS present (CHECK)
  'failed', // verify/settle definitively rejected (no money) OR fulfillment refused post-settle (money moved — tx_signature carried; see metadata.failureReason)
  'reconcile', // money-state UNKNOWN (stale settling w/o signature) OR a settled-signature owned by another checkout — needs chain reconciliation, NEVER auto-retried
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
    /**
     * The CLAIM token of the process that flipped this row pending→settling
     * (a fresh uuid per claim). Only the holder may CAPTURE/release it — a stale
     * claim is reconciled, never stolen. NULL unless status='settling'.
     */
    settlingId: uuid('settling_id'),
    /** When the current settling claim started — drives stale-claim detection. */
    settlingStartedAt: timestamp('settling_started_at', { withTimezone: true }),
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
    /**
     * A `settled` row ALWAYS carries the tx signature (Codex review, finding 5):
     * the money proof can never be absent on a fulfilled checkout, so a settled
     * row can never be replayed as ok without a signature.
     */
    settledHasSignature: check(
      'x402_checkouts_settled_has_signature',
      sql`${t.status} <> 'settled' OR ${t.txSignature} IS NOT NULL`,
    ),
  }),
);

export type X402Checkout = typeof x402Checkouts.$inferSelect;
export type NewX402Checkout = typeof x402Checkouts.$inferInsert;
