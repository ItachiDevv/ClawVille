/**
 * P2P MARKETPLACE v1 (Tokenomics C — marketplace stage / C4, 2026-07-07).
 *
 * Peer sellers list a thing they own; buyers settle through the GENERIC x402
 * USDC checkout (`x402_checkouts` + the `marketplace_purchase` fulfiller in
 * `apps/api/src/services/checkout-fulfillers/marketplace-purchase.ts`).
 * SETTLEMENT IS FLAG-GATED OFF (`MARKETPLACE_SETTLE_ENABLED`, default off) and
 * every on-chain CLV movement (seller payout + treasury rake + deed transfer)
 * is a QUEUED, Codex-review-gated INTENT — nothing here ever signs or sends.
 *
 * ── THE MONEY MODEL (USDC-settles-underneath, LEDGER-ONLY) ───────────────────
 * `price_vclaw` is the QUOTE UNIT only (¢-peg: 1 vCLAW = $0.01). The buyer pays
 * REAL USDC through the checkout; NOTHING in this domain mints or debits
 * internal vCLAW (`avatars.clawTokens` is never touched — no table here even
 * references a balance). Of the settled dollars:
 *   - 100% is owed to the market as a CLV buy → `clv_buy_queue` row
 *     (`enqueueClvBuy`, same settle tx, C3 seam);
 *   - 4.44% (444 bps) of the USD basis is the treasury's CLV RAKE — recorded as
 *     an INTENT (`market_settlements.rake_usd`), executed only behind Codex
 *     review;
 *   - 95.56% (9556 bps) is the seller's CLV payout — recorded as a QUEUED
 *     `payout_status='pending_review'` intent (`seller_payout_usd`), NEVER an
 *     internal-vCLAW credit, NEVER a live send.
 * ¢-peg arithmetic note: usd_cents × 444 and usd_cents × 9556 are EXACT integer
 * µUSD values (10_000 µUSD per cent), so rake + payout == usd_basis with ZERO
 * rounding — enforced by the `market_settlements_conservation` CHECK.
 *
 * ── LISTING STATE MACHINE (market_listing_status) ────────────────────────────
 *
 *   (create) ──────────────► active
 *   active ────────────────► pending_settlement   [marketplace_purchase
 *        fulfiller, INSIDE the checkout settle tx: claims the listing for one
 *        checkout — buyer_avatar_id + settlement_checkout_id bound under the
 *        row lock, `WHERE status='active'`]
 *   pending_settlement ────► settled              [same fulfiller, SAME tx,
 *        after the settlement-intent rows are recorded — the intermediate
 *        state is never observable outside the transaction in v1]
 *   active ────────────────► cancelled            [POST /listings/:id/cancel,
 *        seller-only; the ONLY seller-driven exit]
 *   active ────────────────► expired              [the LISTING-EXPIRY SWEEPER
 *        (`services/market-listing-expiry-sweeper.ts`, boot-wired, hourly, task
 *        D 2026-07-08) flips an `active` listing whose expires_at <= now() to
 *        the terminal `expired` state AND releases its `market_deed_locks` row —
 *        so an abandoned expired listing can't hold its deed lock forever and
 *        park land's rent-lapse eviction (the squatting hole once the land
 *        deed-lock guard shipped). Expiry is ALSO still a PREDICATE at
 *        read/quote/preflight/fulfiller (browse hides + settle refuses an
 *        expired-but-not-yet-swept row), so nothing settles against it in the
 *        window before the sweeper runs; while still `active` it also stays
 *        seller-CANCELLABLE (which releases the lock immediately). The sweeper
 *        locks in the fulfiller order (listing FOR UPDATE → advisory(seller) →
 *        parcel FOR UPDATE) and touches ONLY `active` rows — never
 *        pending_settlement/settled, whose locks the deed-transfer executor owns.]
 *
 *   settled / cancelled / expired are terminal. There is NO transition out of
 *   settled — a sold listing is never re-activated (relist = a NEW row).
 *
 * ── DEED ESCROW LOCK (market_deed_locks — MARKET-OWNED, land untouched) ──────
 * Listing a `land_deed` ESCROW-LOCKS the parcel's transferability in a
 * market-owned table (chosen over an ALTER on `land_parcels` so `land.ts` /
 * `schema/land.ts` stay untouched per the C4 constraint, AND so a `db:push`
 * from a branch without this migration can never silently drop a column off
 * the live land table — the lock lives in OUR schema file).
 *
 *   lock  (INSERT, PK parcel_id)  — taken in the SAME tx that creates the
 *          listing; the PK is the DB-enforced double-list guard (one live lock
 *          per parcel), backed up by `market_listings_live_item_unique`.
 *   release (DELETE)              — on cancel (and by the future expire sweep).
 *   HELD THROUGH 'settled'        — after settlement the deed still belongs to
 *          the seller until the (now-existing but DARK, flag-gated)
 *          deed-transfer executor (`market-deed-transfer-executor.ts`,
 *          `MARKET_DEED_TRANSFER_ENABLED` default OFF) flips
 *          `land_parcels.owner_avatar_id` and DELETEs this lock row in the
 *          SAME tx. The fulfiller itself NEVER flips land ownership. A
 *          terminal deed conflict (seller lost the parcel post-settle) keeps
 *          the lock HELD pending operator resolution — house-favorable freeze,
 *          never a silent release.
 *
 * SCOPE HONESTY — what the lock does and does not guarantee: land.ts is NOT
 * modified (C4 constraint), so land-side paths (voluntary release, tenure
 * lapse/eviction) do not consult this table and can still return a listed
 * parcel to the pool. Those races are caught by the checkout PREFLIGHT and the
 * fulfiller's authoritative under-lock re-check (`owner_avatar_id` must still
 * equal the listing's seller), which REFUSE the settlement cleanly — money
 * never settles against a parcel the seller no longer owns. Wiring land's
 * release/evict paths to consult `market_deed_locks` is a documented follow-up
 * seam owned by the land domain.
 *
 * ── EXACTLY-ONCE ─────────────────────────────────────────────────────────────
 * Settlement rides the checkout's `x402_checkouts_txsig_unique` partial-UNIQUE
 * (the fulfiller runs once per settled signature — engine-enforced), PLUS
 * `market_settlements.checkout_id` UNIQUE here: one settled checkout ⇒ exactly
 * one settlement row; the fulfiller's own idempotency read makes a replay a
 * no-op that never double-queues the buy or double-records the payout intent.
 *
 * v1 LIMITS: `earned_bundle` listings are REFUSED (`earned_not_available`) —
 * EARNED provenance does not exist yet; only `land_deed` may list. The ONLY
 * deed-able tenure is 'owned' (narrowed from 'owned'+'hold' 2026-07-08, Codex
 * re-review): 'hold' refuses the typed `hold_transfer_not_supported` because
 * the deed-flip normalizes tenure='owned' + NULLs the hold cols, which would
 * strip the CLV-hold obligation — buyer-inherits-obligation transfer is the
 * gated follow-up (FEATURE_GATE `market_hold_deed_transfer`,
 * apps/api services/market-listings.ts); 'rented'/'deposit'/'starter' refuse
 * `not_transferable_tenure` (a renter/depositor does not own the deed).
 *
 * Migrations: `packages/database/migrations/0017_market_p2p.sql` (base) +
 * `0020_market_payout_deed_executors.sql` (GoLive executor trail columns +
 * capture-signature partial-UNIQUEs + deed-pending scan index) +
 * `0020a`/`0020b` (the 'sending'/'reconcile' payout_status values, each ALONE
 * per the migrate-ci ALTER TYPE rule). Idempotent; apply by hand/CI — NEVER
 * db:push.
 *
 * GoLive executors (2026-07-07, BOTH DARK — default-OFF flags, nothing wired
 * into index.ts): the deed-transfer executor
 * (`market-deed-transfer-executor.ts`, `MARKET_DEED_TRANSFER_ENABLED`) flips
 * `land_parcels.owner_avatar_id` seller→buyer for SETTLED land_deed
 * settlements (one tx: re-verify seller still owns under the land lock order,
 * flip, transfer structures, stamp `deed_transferred_at`, release the deed
 * lock); the payout executor (`market-payout-executor.ts`,
 * `MARKET_PAYOUT_EXECUTE`) then delivers the seller's CLV + the treasury rake
 * CLV on-chain, reading `deed_transferred_at` as its precondition — DEED
 * FIRST, PAYOUT SECOND (funds were secured at settle; the deed must flip
 * before the seller is ever paid).
 */

import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
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
import { landParcels } from './land';
import { x402Checkouts } from './checkout';
import { clvBuyQueue } from './swap';

// ─────────────────────────────────────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────────────────────────────────────

/** What a listing sells. `earned_bundle` is RESERVED (refused in v1 —
 *  `earned_not_available` — until EARNED-provenance vCLAW exists). */
export const marketItemKindEnum = pgEnum('market_item_kind', ['land_deed', 'earned_bundle']);

/** Listing lifecycle — full machine in the file header. */
export const marketListingStatusEnum = pgEnum('market_listing_status', [
  'active',
  'pending_settlement',
  'settled',
  'cancelled',
  'expired',
]);

/**
 * Seller-payout intent lifecycle. v1 ONLY EVER WRITES 'pending_review' — the
 * fulfiller records the intent and stops. The GoLive PAYOUT EXECUTOR
 * (`apps/api/src/services/market-payout-executor.ts`, DARK behind
 * `MARKET_PAYOUT_EXECUTE`) drives the machine:
 *
 *   pending_review → sending    [ATOMIC CLAIM (payout_claim_id) BEFORE any
 *                                decrypt/sign/send; requires
 *                                deed_transferred_at IS NOT NULL — the deed
 *                                flips FIRST, payout second]
 *   sending → paid              [seller CLV send + treasury rake CLV send both
 *                                confirmed; each signature CAPTURED in its own
 *                                committed UPDATE BEFORE the wire was touched]
 *   sending → pending_review    [pre-capture definitive failure only (custody/
 *                                RPC/balance) — nothing signed-and-captured,
 *                                nothing sent: clean re-claim]
 *   sending → reconcile         [TERMINAL, operator-resolution, NEVER
 *                                auto-retried. payout_failure_reason says
 *                                whether money moved: ambiguous sends
 *                                (money-state UNKNOWN, captured signature =
 *                                the chain-poll anchor) AND definitive
 *                                refusals (conservation_violated,
 *                                destination mismatch, guest seller, on-chain
 *                                tx failure) both land here]
 *
 *   'approved'/'rejected' stay RESERVED for a human review flow layered on top
 *   (the executor consumes 'pending_review' directly; the default-OFF flag is
 *   the v1 review gate).
 *
 * NOTE: 'sending' and 'reconcile' are listed LAST to mirror the physical
 * Postgres enum order (ALTER TYPE … ADD VALUE appends — migrations 0020a +
 * 0020b; drizzle's array order must match the DB, same rule as
 * `clv_buy_status`'s 'executing').
 */
export const marketPayoutStatusEnum = pgEnum('market_payout_status', [
  'pending_review', // recorded intent (the ONLY fulfiller write)
  'approved', // RESERVED — a future human-review flow
  'rejected', // RESERVED — a future human-review flow (manual resolution trail)
  'paid', // the (gated) executor completed BOTH on-chain CLV sends
  'sending', // ATOMICALLY CLAIMED by the (dark) payout executor (0020a)
  'reconcile', // TERMINAL operator-resolution — see the machine above (0020b)
]);

// ─────────────────────────────────────────────────────────────────────────────
// market_listings
// ─────────────────────────────────────────────────────────────────────────────

export const marketListings = pgTable(
  'market_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The seller — human's or agent's OWN avatar (middleware-resolved, E5). */
    sellerAvatarId: uuid('seller_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    sellerUserId: uuid('seller_user_id').references(() => users.id, { onDelete: 'set null' }),
    itemKind: marketItemKindEnum('item_kind').notNull(),
    /** Kind-scoped reference: `land_parcels.id` for 'land_deed'. */
    itemRef: varchar('item_ref', { length: 128 }).notNull(),
    /** Ask price — vCLAW QUOTE UNIT (¢-peg). Positive int; never debited. */
    priceVclaw: integer('price_vclaw').notNull(),
    status: marketListingStatusEnum('status').notNull().default('active'),
    /**
     * Escrow-lock marker: 'deed_locked' while a `market_deed_locks` row is held
     * for this listing (land_deed), NULL once released. Stays 'deed_locked'
     * through 'settled' until the Codex-gated transfer completes (see header).
     */
    escrowState: varchar('escrow_state', { length: 32 }),
    /**
     * The wallet whose CLV balance passed the seller-license gate at listing
     * time (human → `users.linked_wallet_pubkey`; agent → its custodial
     * `avatars.wallet_address`). Doubles as the DEFAULT payout destination
     * stamped onto the settlement intent — the payout REVIEW step re-validates
     * it before any (gated) send.
     */
    sellerWalletPubkey: varchar('seller_wallet_pubkey', { length: 64 }).notNull(),
    /** Set at settlement (fulfiller, under the row lock). NULL until then. */
    buyerAvatarId: uuid('buyer_avatar_id').references(() => avatars.id, { onDelete: 'set null' }),
    /** The x402 checkout that settled this listing. NULL until settlement. */
    settlementCheckoutId: uuid('settlement_checkout_id').references(() => x402Checkouts.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** Optional listing expiry — v1 treats it as a predicate (see header). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** Public browse hot path: live listings, newest first. */
    statusCreatedIdx: index('market_listings_status_created_idx').on(t.status, t.createdAt),
    /** GET /listings/mine. */
    sellerIdx: index('market_listings_seller_idx').on(t.sellerAvatarId, t.createdAt),
    /**
     * DOUBLE-LIST GUARD (trap 7): one LIVE listing per item. Partial — settled/
     * cancelled/expired rows don't block a relist. Backs up the
     * `market_deed_locks` PK for the land_deed case and covers every future
     * kind that has no dedicated lock table.
     */
    liveItemUnique: uniqueIndex('market_listings_live_item_unique')
      .on(t.itemKind, t.itemRef)
      .where(sql`status IN ('active', 'pending_settlement')`),
    /** Amount discipline backstop — a zero/negative ask can never persist. */
    pricePositive: check('market_listings_price_vclaw_positive', sql`${t.priceVclaw} > 0`),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// market_deed_locks — the market-owned parcel transferability lock
// ─────────────────────────────────────────────────────────────────────────────

export const marketDeedLocks = pgTable(
  'market_deed_locks',
  {
    /** PK = one live lock per parcel — THE DB double-list guard for deeds. */
    parcelId: uuid('parcel_id')
      .primaryKey()
      .references(() => landParcels.id, { onDelete: 'cascade' }),
    /** The listing holding the lock. Cascade: a deleted listing frees the lock. */
    listingId: uuid('listing_id')
      .notNull()
      .references(() => marketListings.id, { onDelete: 'cascade' }),
    lockedAt: timestamp('locked_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    listingIdx: index('market_deed_locks_listing_idx').on(t.listingId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// market_settlements — one row per settled checkout (the intent ledger)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Written EXACTLY ONCE per settled marketplace checkout, INSIDE the checkout
 * settle tx, by the `marketplace_purchase` fulfiller. Records:
 *   - the settled buyer USDC (checkout_id + tx_signature + usd basis),
 *   - the C3 swap-queue row that owes the market the CLV buy (clv_buy_queue_id),
 *   - the 4.44% treasury CLV-rake INTENT (rake_bps/rake_usd),
 *   - the seller's 95.56% CLV payout as a QUEUED 'pending_review' intent
 *     (seller_payout_usd + payout_status) — NEVER an on-chain send here,
 *   - the deed-transfer seam: `deed_transferred_at` is stamped ONLY by the
 *     (dark, flag-gated) deed-transfer executor; the fulfiller never writes
 *     it. The deed transfer completes ONLY when that executor runs; until
 *     then the parcel stays with the seller under the held
 *     `market_deed_locks` row.
 * `checkout_id` UNIQUE = one settled checkout ⇒ one settlement (idempotency,
 * on top of the engine's per-signature exactly-once).
 */
export const marketSettlements = pgTable(
  'market_settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => marketListings.id, { onDelete: 'cascade' }),
    /** THE exactly-once key — one settled checkout ⇒ one settlement row. */
    checkoutId: uuid('checkout_id')
      .notNull()
      .references(() => x402Checkouts.id, { onDelete: 'cascade' }),
    /** The settled Solana tx signature (copied from the checkout for audit). */
    txSignature: text('tx_signature').notNull(),
    buyerAvatarId: uuid('buyer_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    sellerAvatarId: uuid('seller_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    priceVclaw: integer('price_vclaw').notNull(),
    usdCents: integer('usd_cents').notNull(),
    /** The settled dollars — the basis every intent below splits. */
    usdBasis: numeric('usd_basis', { precision: 20, scale: 6 }).notNull(),
    /** The C3 planned CLV buy this settlement funded (same-tx enqueue). */
    clvBuyQueueId: uuid('clv_buy_queue_id')
      .notNull()
      .references(() => clvBuyQueue.id),
    /** Treasury rake in bps of the USD basis — 444 (4.44%) in v1. */
    rakeBps: integer('rake_bps').notNull(),
    /** The rake INTENT in USD (exact µUSD — see the ¢-peg note in the header). */
    rakeUsd: numeric('rake_usd', { precision: 20, scale: 6 }).notNull(),
    /** The seller-payout INTENT in USD (usd_basis − rake_usd, exact). */
    sellerPayoutUsd: numeric('seller_payout_usd', { precision: 20, scale: 6 }).notNull(),
    /** v1 writes ONLY 'pending_review' — the Codex-gated executor owns the rest. */
    payoutStatus: marketPayoutStatusEnum('payout_status').notNull().default('pending_review'),
    /** Default payout destination (stamped from the listing; review re-validates). */
    sellerPayoutPubkey: varchar('seller_payout_pubkey', { length: 64 }),
    /** Stamped by the (dark, flag-gated) deed-transfer executor when the
     *  parcel ownership flip COMMITS. The payout executor reads this as its
     *  precondition — deed first, payout second. */
    deedTransferredAt: timestamp('deed_transferred_at', { withTimezone: true }),

    // ── GoLive executors trail (migration 0020, 2026-07-07 — both DARK) ──────
    /** Deed executor per-row claim AUDIT (uuid per attempt). The cross-process
     *  mutex is `FOR UPDATE SKIP LOCKED` + the `deed_transferred_at IS NULL`
     *  predicate inside ONE tx — this column records WHO performed the flip. */
    deedTransferClaimId: uuid('deed_transfer_claim_id'),
    deedTransferStartedAt: timestamp('deed_transfer_started_at', { withTimezone: true }),
    /** TERMINAL deed failure ('deed_transfer_conflict' family — seller no
     *  longer owns the parcel / live escrow present / parcel missing). Set ⇒
     *  the executor never retries; ops resolves (refund trail on the checkout). */
    deedTransferFailureReason: text('deed_transfer_failure_reason'),
    /** Payout executor atomic-claim token (uuid per claim) + when taken.
     *  Retained after 'paid' as the audit of the executing claim. */
    payoutClaimId: uuid('payout_claim_id'),
    payoutClaimedAt: timestamp('payout_claimed_at', { withTimezone: true }),
    /** Seller-leg CLV send signature — CAPTURED in its own committed UPDATE
     *  BEFORE the send (partial-UNIQUE: one on-chain send ⇒ one settlement). */
    payoutSellerTxSignature: text('payout_seller_tx_signature'),
    /** Rake-leg CLV send signature — same capture-before-send discipline. */
    payoutRakeTxSignature: text('payout_rake_tx_signature'),
    /** The SELLER's CLV payout in atomic units (6-dp mint), derived from
     *  seller_payout_usd at payout_executed_rate, EXACT-INTEGER floor
     *  (house-favorable). Stamped at seller-leg capture. */
    payoutClvAtomic: numeric('payout_clv_atomic'),
    /** The EXECUTED C3 buy rate (clv_buy_queue.executed_price, USD/CLV) the
     *  CLV amounts derive from — stamped at seller-leg capture so a resume
     *  reuses THE SAME rate. */
    payoutExecutedRate: numeric('payout_executed_rate', { precision: 20, scale: 12 }),
    /** When payout_status flipped to 'paid' (both legs confirmed). */
    payoutExecutedAt: timestamp('payout_executed_at', { withTimezone: true }),
    /** Machine reason for 'reconcile' rows (ambiguous vs definitive — see the
     *  payout_status machine doc above). */
    payoutFailureReason: text('payout_failure_reason'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** One settled checkout ⇒ one settlement — the replay no-op key. */
    checkoutUnique: uniqueIndex('market_settlements_checkout_unique').on(t.checkoutId),
    listingIdx: index('market_settlements_listing_idx').on(t.listingId),
    /** The (future, gated) payout-review queue scan. */
    payoutReviewIdx: index('market_settlements_payout_review_idx').on(
      t.payoutStatus,
      t.createdAt,
    ),
    /** One on-chain CLV send binds to exactly one settlement (capture keys —
     *  mirror of clv_swap_funding_sweep_sig_uniq; migration 0020). */
    payoutSellerSigUniq: uniqueIndex('market_settlements_payout_seller_sig_uniq')
      .on(t.payoutSellerTxSignature)
      .where(sql`payout_seller_tx_signature IS NOT NULL`),
    payoutRakeSigUniq: uniqueIndex('market_settlements_payout_rake_sig_uniq')
      .on(t.payoutRakeTxSignature)
      .where(sql`payout_rake_tx_signature IS NOT NULL`),
    /** Deed-executor scan hot path (pending deeds only; migration 0020). */
    deedPendingIdx: index('market_settlements_deed_pending_idx')
      .on(t.createdAt)
      .where(sql`deed_transferred_at IS NULL AND deed_transfer_failure_reason IS NULL`),
    pricePositive: check('market_settlements_price_vclaw_positive', sql`${t.priceVclaw} > 0`),
    usdCentsPositive: check('market_settlements_usd_cents_positive', sql`${t.usdCents} > 0`),
    rakeBpsRange: check(
      'market_settlements_rake_bps_range',
      sql`${t.rakeBps} >= 0 AND ${t.rakeBps} <= 10000`,
    ),
    /**
     * CONSERVATION BACKSTOP: the two intents must split the settled dollars
     * EXACTLY — no µUSD can appear or vanish between rake and payout.
     */
    conservation: check(
      'market_settlements_conservation',
      sql`${t.rakeUsd} + ${t.sellerPayoutUsd} = ${t.usdBasis}`,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Inferred types
// ─────────────────────────────────────────────────────────────────────────────

export type MarketListing = typeof marketListings.$inferSelect;
export type NewMarketListing = typeof marketListings.$inferInsert;
export type MarketDeedLock = typeof marketDeedLocks.$inferSelect;
export type NewMarketDeedLock = typeof marketDeedLocks.$inferInsert;
export type MarketSettlement = typeof marketSettlements.$inferSelect;
export type NewMarketSettlement = typeof marketSettlements.$inferInsert;
