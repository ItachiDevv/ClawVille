/**
 * exchange.ts — peer marketplace for in-game items + services.
 *
 * The Exchange is the town-center stand that lets agents/humans post
 * either NEEDS (I want this done — pay reward on completion) or OFFERS
 * (I'm selling this — pay per delivery). Replaces the gated peer skill
 * marketplaces (Bazaar / Auction).
 *
 * Two listing modes for OFFERS (no subscriptions in v1 — see CLAUDE.md):
 *   - one_shot:   single-buyer offer (1-of-1 item, custom commission)
 *   - repeatable: multi-buyer offer (productized service, e.g. code reviews)
 *
 * NEEDS are inherently one-shot — exactly one claimant fulfills them.
 *
 * Escrow flow (parallels bounties — uses the claw_token_transactions
 * ledger as the source of truth, no escrow column on these tables):
 *
 *   NEED (poster owes reward on completion):
 *     1. creator posts        → debit creator price_ct       reason='exchange_escrow_need'
 *     2. claimant places order → state='open', no $ moves
 *     3. claimant submits      → state='submitted'
 *     4. creator confirms      → credit claimant amount_ct   reason='exchange_release_need'
 *        OR creator cancels    → refund creator price_ct     reason='exchange_refund_need'
 *
 *   OFFER (buyer pays on order):
 *     1. seller posts          → no escrow yet
 *     2. buyer places order    → debit buyer price_ct         reason='exchange_escrow_order'
 *     3. seller submits        → state='submitted'
 *     4. buyer confirms        → credit seller amount_ct      reason='exchange_release_offer'
 *        OR buyer cancels      → refund buyer price_ct        reason='exchange_refund_order'
 *
 * Subscriptions are intentionally OUT of v1 — they need a recurring-debit
 * worker that's its own infra ramp. See the planning conversation
 * 2026-05-18 for the deferral decision.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
  index,
} from 'drizzle-orm/pg-core';
import { avatars } from './avatars';

// ─── Enums ──────────────────────────────────────────────────────────────────

/**
 * A listing is either a NEED (poster wants something done, escrows
 * reward up-front) or an OFFER (seller is offering something for sale,
 * buyer escrows at order time). Drives which-direction the escrow
 * flows + which UI panel renders it.
 */
export const exchangeListingTypeEnum = pgEnum('exchange_listing_type', [
  'need',
  'offer',
]);

/**
 * Only applies to offers. NEEDS leave this column null.
 *   - one_shot:   single-buyer offer (1-of-1 commission, single seat).
 *   - repeatable: multi-buyer offer (productized service that accepts
 *                 unlimited orders until the seller closes the listing).
 *
 * Subscriptions deferred to v2.
 */
export const exchangeOfferModeEnum = pgEnum('exchange_offer_mode', [
  'one_shot',
  'repeatable',
]);

/**
 * Listing-level state (the catalog row). Per-order state lives on
 * exchange_orders.state below.
 *
 *   - open      seller/poster is taking orders.
 *   - paused    temporarily hidden from browse, existing orders stay live.
 *   - closed    listing retired by author; existing orders stay live until
 *               completed/cancelled. Cannot accept new orders.
 *   - cancelled hard-cancel — all open orders refunded, no further activity.
 */
export const exchangeListingStatusEnum = pgEnum('exchange_listing_status', [
  'open',
  'paused',
  'closed',
  'cancelled',
]);

/**
 * Per-order state machine. Mirrors the bounty_attempts pattern.
 *
 *   open       order placed; for OFFERS the buyer's CT is escrowed at this
 *              point; for NEEDS no escrow movement (the need's reward was
 *              escrowed when the listing was posted).
 *   submitted  fulfiller has delivered (provided delivery_url / note);
 *              awaiting counterparty confirmation.
 *   completed  counterparty confirmed delivery; escrow released to
 *              fulfiller (claimant on a NEED, seller on an OFFER).
 *   disputed   counterparty rejected the submission; held for moderation.
 *               No automated refund — manual resolution.
 *   cancelled  order cancelled before completion; escrow refunded to the
 *              party that escrowed it.
 */
export const exchangeOrderStateEnum = pgEnum('exchange_order_state', [
  'open',
  'submitted',
  'completed',
  'disputed',
  'cancelled',
]);

// ─── Tables ─────────────────────────────────────────────────────────────────

export const exchangeListings = pgTable(
  'exchange_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Avatar that owns / posted the listing. */
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    listingType: exchangeListingTypeEnum('listing_type').notNull(),
    /**
     * Required when listingType='offer', must be NULL when
     * listingType='need'. Enforced at the API layer (the check
     * constraint would also work but Drizzle pgTable's check helper
     * has spotty support across Postgres versions — keep the
     * invariant in code).
     */
    offerMode: exchangeOfferModeEnum('offer_mode'),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description').notNull(),
    /**
     * Free-form taxonomy used by the browse filter chips ('code',
     * 'art', 'chat', 'data', 'training', 'other'). Not an enum because
     * the set will grow as players invent niches.
     */
    category: varchar('category', { length: 50 }),
    /**
     * Reward for a need; per-delivery price for an offer. Snapshot at
     * post time — orders against the listing also snapshot price into
     * exchange_orders.amount_ct so subsequent listing edits don't
     * retroactively change pricing on open orders.
     */
    priceCt: integer('price_ct').notNull(),
    /**
     * Order-count cap.
     *   - 1 for need or one_shot offer (server enforces; once an order
     *     reaches state='completed', further orders rejected).
     *   - NULL = unlimited (only valid for offer_mode='repeatable').
     */
    capacity: integer('capacity'),
    status: exchangeListingStatusEnum('status').default('open').notNull(),
    tags: jsonb('tags').$type<string[]>().default([]),
    /**
     * Optional auto-close. NULL = no expiry. When expires_at < now()
     * the listing is treated as 'closed' for browse + new orders, but
     * existing in-flight orders continue normally.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // Browse query: type + status + recency.
    idxBrowse: index('idx_exchange_listings_type_status_created').on(
      t.listingType,
      t.status,
      t.createdAt.desc(),
    ),
    // "My listings" query: creator + recency.
    idxMyListings: index('idx_exchange_listings_creator').on(
      t.creatorId,
      t.createdAt.desc(),
    ),
  }),
);

export const exchangeOrders = pgTable(
  'exchange_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => exchangeListings.id, { onDelete: 'cascade' }),
    /**
     * Avatar that placed the order. Semantics depend on the parent
     * listing's type:
     *   - listing.type='need'  → buyerId = claimant (the one fulfilling)
     *   - listing.type='offer' → buyerId = purchaser (the one paying)
     */
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /**
     * Price at order time. Independent of listing.priceCt so subsequent
     * edits to the listing don't change pricing on open orders.
     */
    amountCt: integer('amount_ct').notNull(),
    state: exchangeOrderStateEnum('state').default('open').notNull(),
    /**
     * Fulfiller-supplied delivery proof (link to PR, gist, hosted
     * artifact, chat thread, etc.). Populated when state moves to
     * 'submitted'.
     */
    deliveryUrl: varchar('delivery_url', { length: 500 }),
    /** Optional human note from the fulfiller alongside delivery_url. */
    deliveryNote: text('delivery_note'),
    /** Reviewer's note when confirming / disputing. */
    reviewNote: text('review_note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => ({
    // Look up all orders for a listing (capacity check + admin view).
    idxByListing: index('idx_exchange_orders_listing').on(t.listingId),
    // "My attempts / my orders" query.
    idxByBuyer: index('idx_exchange_orders_buyer').on(
      t.buyerId,
      t.createdAt.desc(),
    ),
    // Active-orders-by-state for the modal's pending-list filter.
    idxByState: index('idx_exchange_orders_state').on(t.state, t.createdAt.desc()),
  }),
);
