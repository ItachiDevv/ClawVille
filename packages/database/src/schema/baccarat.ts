/**
 * Phase 6.6.1 — baccarat shoe + coup schema (cove baccarat / Punto Banco).
 *
 * Mirrors the cove-blackjack two-table commit-reveal pattern
 * (blackjack_shoes / blackjack_hands):
 *   - baccarat_shoes: one row per commit-reveal SHOE. Holds the secret
 *     serverSeed (revealed at shoe close), the public serverSeedHash
 *     (committed at open), the per-shoe clientSeed, and the monotonic
 *     coupCounter + cursorCounter + dealtCount that drive the deterministic
 *     no-replacement card stream. Reshuffle at ~75% penetration = a NEW shoe
 *     row with a fresh seed pair (the engine never reshuffles mid-coup —
 *     that would break replay determinism).
 *   - baccarat_coups: one row per COUP. Punto Banco has NO player decisions,
 *     so unlike blackjack there is no in-progress decision machine — a coup is
 *     dealt + resolved atomically in a single /coup request and the row is
 *     created already-settled under the shoe FOR UPDATE row lock. The row still
 *     carries status + idempotencyKey + bet + stake + the terminal settlement so
 *     the verifier can reconstruct the shoe by replaying every coup's bet/stake
 *     in coupIndex order. (shoeId, coupIndex) and (shoeId, idempotencyKey) are
 *     both unique.
 *
 * Money columns are TEXT-stringified bigints — see cove-events.ts for the
 * rationale (lamport/µUSDC precision survives without a schema migration; the
 * SOL/USDC tier reuses these columns by swapping the route's currency seam, not
 * the schema).
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { coveTestFixtureRuns } from './cove-test-fixture';

export const baccaratShoes = pgTable(
  'baccarat_shoes',
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
    /** Per-shoe client seed (server-generated today; player-supplied future). */
    clientSeed: text('client_seed').notNull(),
    /** Monotonic coup index within the shoe (RNG nonce). Pre-increment. */
    coupCounter: integer('coup_counter').notNull().default(0),
    /** Byte offset into the HMAC stream where the NEXT coup starts. */
    cursorCounter: integer('cursor_counter').notNull().default(0),
    /** Cards dealt so far this shoe. Crosses 312 (75% of 416) ⇒ shoe rolls. */
    dealtCount: integer('dealt_count').notNull().default(0),
    fixtureInitialDealtCount: integer('fixture_initial_dealt_count').notNull().default(0),
    /** For authed users: snapshot of avatar.clawTokens at open (UI display). Guest: demo wallet. */
    startingBalance: text('starting_balance').notNull(),
    /** Net shoe P&L (signed, stringified bigint). */
    currentBalance: text('current_balance').notNull().default('0'),
    /** Sum of all stakes risked this shoe. */
    totalBet: text('total_bet').notNull().default('0'),
    /** Sum of all gross payouts this shoe. */
    totalPayout: text('total_payout').notNull().default('0'),
    /** 'open' | 'closed'. Closed reveals serverSeed on every cove_game_events row. */
    status: text('status').notNull().default('open'),
    coupsPlayed: integer('coups_played').notNull().default(0),
    engineVersion: text('engine_version').notNull().default('bac-v1'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastCoupAt: timestamp('last_coup_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => ({
    userOpenUnique: uniqueIndex('baccarat_shoes_user_open_unique')
      .on(table.userId)
      .where(sql`status = 'open' AND user_id IS NOT NULL`),
    guestOpenUnique: uniqueIndex('baccarat_shoes_guest_open_unique')
      .on(table.guestFpHash)
      .where(sql`status = 'open' AND guest_fp_hash IS NOT NULL`),
    subjectCheck: check(
      'baccarat_shoes_subject_check',
      sql`(user_id IS NOT NULL) <> (guest_fp_hash IS NOT NULL)`,
    ),
  }),
);

export const baccaratCoups = pgTable(
  'baccarat_coups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shoeId: uuid('shoe_id')
      .notNull()
      .references(() => baccaratShoes.id, { onDelete: 'cascade' }),
    /** Coup index within the shoe (RNG nonce). */
    coupIndex: integer('coup_index').notNull(),
    /** Byte cursor at coup start (for cheap reconstruction). */
    cursorBefore: integer('cursor_before').notNull(),
    /** Byte cursor after settlement. */
    cursorAfter: integer('cursor_after'),
    /** Cards dealt count at coup start (for the 75% gate + replay). */
    dealtBefore: integer('dealt_before').notNull(),
    /** Cards dealt count after settlement. */
    dealtAfter: integer('dealt_after'),
    /** The bet placed this coup: 'player' | 'banker' | 'tie'. */
    bet: text('bet').notNull(),
    /** Stake risked (atomic CT, stringified bigint). */
    stake: text('stake').notNull(),
    /** 'in_progress' | 'settled'. Terminal transition under FOR UPDATE = idempotency. */
    status: text('status').notNull().default('in_progress'),
    /** Final settled outcome payload (serializeCoupResult shape). Null until settled. */
    outcomeJson: jsonb('outcome_json'),
    /** Gross payout returned to player at settle (stringified bigint). Null until settled. */
    payout: text('payout'),
    /** Net P&L at settle (signed, stringified bigint). Null until settled. */
    net: text('net'),
    /** Idempotency key (per coup). (shoeId, idempotencyKey) unique. */
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => ({
    shoeCoupUnique: uniqueIndex('baccarat_coups_shoe_coup_unique').on(
      table.shoeId,
      table.coupIndex,
    ),
    shoeIdempotencyUnique: uniqueIndex('baccarat_coups_shoe_idempotency_unique')
      .on(table.shoeId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    shoeIdx: index('baccarat_coups_shoe_idx').on(table.shoeId),
  }),
);

export type BaccaratShoe = typeof baccaratShoes.$inferSelect;
export type NewBaccaratShoe = typeof baccaratShoes.$inferInsert;
export type BaccaratCoup = typeof baccaratCoups.$inferSelect;
export type NewBaccaratCoup = typeof baccaratCoups.$inferInsert;
