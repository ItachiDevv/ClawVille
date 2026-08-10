/**
 * Phase 6.4.1 — blackjack shoe + hand schema (cove blackjack).
 *
 * Mirrors the cove-slots two-table pattern (slot_sessions / slot_spins):
 *   - blackjack_shoes: one row per commit-reveal SHOE. Holds the secret
 *     serverSeed (revealed at shoe close), the public serverSeedHash
 *     (committed at open), the per-shoe clientSeed, and the monotonic
 *     handCounter + cursorCounter + dealtCount that drive the deterministic
 *     no-replacement card stream. Reshuffle at 75% penetration = a NEW shoe
 *     row with a fresh seed pair (the engine never reshuffles mid-shoe —
 *     that would break replay determinism).
 *   - blackjack_hands: one row per HAND. Carries the in-progress state
 *     machine (dealt cards, accumulated player decision script, status) and
 *     the terminal settlement. status flips open→settled exactly once under
 *     a FOR UPDATE row lock — the idempotency backstop for /settle.
 *     (shoeId, handIndex) and (shoeId, idempotencyKey) are both unique.
 *
 * Money columns are TEXT-stringified bigints — see cove-events.ts for the
 * rationale (lamport/µUSDC precision survives without a schema migration;
 * the SOL/USDC tier reuses these columns by swapping the route's currency
 * seam, not the schema).
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { coveTestFixtureRuns } from './cove-test-fixture';

export const blackjackShoes = pgTable(
  'blackjack_shoes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fixtureRunId: uuid('fixture_run_id').references(() => coveTestFixtureRuns.runId, {
      onDelete: 'restrict',
    }),
    /** Exactly one of (userId, guestFpHash) is set (XOR check below). */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    guestFpHash: text('guest_fp_hash'),
    /** 'clawtoken' today; seam for 'sol' | 'usdc' (SOL/USDC tier, not yet wired). */
    currency: text('currency').notNull().default('clawtoken'),
    /** Secret until shoe close. 64-char hex. */
    serverSeed: text('server_seed').notNull(),
    /** Public at shoe open. sha256(serverSeed) hex. */
    serverSeedHash: text('server_seed_hash').notNull(),
    /** Per-shoe client seed (server-generated today; player-supplied in a future phase). */
    clientSeed: text('client_seed').notNull(),
    /** Monotonic hand index within the shoe (RNG nonce). Pre-increment. */
    handCounter: integer('hand_counter').notNull().default(0),
    /** Byte offset into the HMAC stream where the NEXT hand starts. */
    cursorCounter: integer('cursor_counter').notNull().default(0),
    /** Cards dealt so far this shoe. Crosses 234 (75% of 312) ⇒ shoe rolls. */
    dealtCount: integer('dealt_count').notNull().default(0),
    /** For authed users: snapshot of avatar.clawTokens at open (UI display). Guest: demo wallet. */
    startingBalance: text('starting_balance').notNull(),
    /** Net shoe P&L (signed, stringified bigint). */
    currentBalance: text('current_balance').notNull().default('0'),
    /** Sum of all bets risked this shoe. */
    totalBet: text('total_bet').notNull().default('0'),
    /** Sum of all gross payouts this shoe. */
    totalPayout: text('total_payout').notNull().default('0'),
    /** 'open' | 'closed'. Closed reveals serverSeed on every cove_game_events row. */
    status: text('status').notNull().default('open'),
    handsPlayed: integer('hands_played').notNull().default(0),
    engineVersion: text('engine_version').notNull().default('bj-v1'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastHandAt: timestamp('last_hand_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => ({
    userOpenUnique: uniqueIndex('blackjack_shoes_user_open_unique')
      .on(table.userId)
      .where(sql`status = 'open' AND user_id IS NOT NULL`),
    guestOpenUnique: uniqueIndex('blackjack_shoes_guest_open_unique')
      .on(table.guestFpHash)
      .where(sql`status = 'open' AND guest_fp_hash IS NOT NULL`),
    subjectCheck: check(
      'blackjack_shoes_subject_check',
      sql`(user_id IS NOT NULL) <> (guest_fp_hash IS NOT NULL)`,
    ),
  }),
);

export const blackjackHands = pgTable(
  'blackjack_hands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shoeId: uuid('shoe_id')
      .notNull()
      .references(() => blackjackShoes.id, { onDelete: 'cascade' }),
    /** Hand index within the shoe (RNG nonce). */
    handIndex: integer('hand_index').notNull(),
    /** Byte cursor at hand start (for single-hand cheap replay). */
    cursorBefore: integer('cursor_before').notNull(),
    /** Byte cursor after settlement (mirrors slot_spins.cursor_after). */
    cursorAfter: integer('cursor_after'),
    /** Cards dealt count at hand start (for the 75% gate + replay). */
    dealtBefore: integer('dealt_before').notNull(),
    /** Cards dealt count after settlement. */
    dealtAfter: integer('dealt_after'),
    /** Base stake on the opening hand (atomic CT, stringified bigint). */
    bet: text('bet').notNull(),
    /**
     * Cumulative stake ALREADY irrevocably committed for this hand (atomic CT,
     * stringified bigint). The base bet (+ any deal-time insurance) is debited
     * at /hand/deal time and recorded here; a post-deal /action insure adds its
     * stake here too. At settle the engine's total bet minus this value is the
     * remaining double/split delta to debit (the rest is already gone). This is
     * what makes an abandoned in-progress hand cost its stake — the free
     * hand-peek exploit fix (Phase 6.4.1 audit finding #3).
     */
    stakedAmount: text('staked_amount').notNull().default('0'),
    /** Accumulated player decision script (HandScript). Updated per /action. */
    script: jsonb('script').notNull(),
    /** Whether the player took insurance (only honored on dealer-Ace upcard). */
    tookInsurance: boolean('took_insurance').notNull().default(false),
    /** 'in_progress' | 'settled'. Terminal transition under FOR UPDATE = idempotency. */
    status: text('status').notNull().default('in_progress'),
    /** Final settled outcome payload (serializeHandResult shape). Null until settled. */
    outcomeJson: jsonb('outcome_json'),
    /** Gross payout returned to player at settle (stringified bigint). Null until settled. */
    payout: text('payout'),
    /** Net P&L at settle (signed, stringified bigint). Null until settled. */
    net: text('net'),
    /** Idempotency key (per settle attempt). (shoeId, idempotencyKey) unique. */
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => ({
    shoeHandUnique: uniqueIndex('blackjack_hands_shoe_hand_unique').on(
      table.shoeId,
      table.handIndex,
    ),
    shoeIdempotencyUnique: uniqueIndex('blackjack_hands_shoe_idempotency_unique')
      .on(table.shoeId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    shoeIdx: index('blackjack_hands_shoe_idx').on(table.shoeId),
  }),
);

export type BlackjackShoe = typeof blackjackShoes.$inferSelect;
export type NewBlackjackShoe = typeof blackjackShoes.$inferInsert;
export type BlackjackHand = typeof blackjackHands.$inferSelect;
export type NewBlackjackHand = typeof blackjackHands.$inferInsert;
