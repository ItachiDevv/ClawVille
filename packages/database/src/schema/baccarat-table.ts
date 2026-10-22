/**
 * Shared-table (multiplayer) baccarat: table / seat / per-round-bet schema.
 *
 * Migration: `packages/database/migrations/0087_baccarat_shared_tables.sql`
 * (column for column; the SQL is the authority, this file mirrors it). Spec:
 * `baccarat-shared-table-port-2026-10-22.md` section 4. Never `db:push`: the
 * schema reaches staging and prod only through the CI migration gate.
 *
 * The solo shoe + coup tables in `baccarat.ts` are REUSED: a table-owned shoe is
 * a `baccarat_shoes` row with `table_id` set (user_id and guest_fp_hash NULL,
 * num_nonnulls subject check). ONE coup deals per round; each seat settles
 * against the shared winner with the engine's `settleBet`.
 *
 * Money model: no buy-in and no stack. A bet row moves no vCLAW when it is
 * placed. At the round settle the stake is debited and the gross payout
 * credited in ONE transaction through `claw-token-ledger.ts`. A bet row goes
 * `pending -> settled | void | cancelled` exactly once (every UPDATE filters
 * `status = 'pending'`).
 *
 * Round state lives on the table row (`round_seq`, `round_phase`,
 * `phase_ends_at`, `settle_attempts`), so a restart or a two-process deploy
 * overlap loses nothing and the deal is a CAS claim on the row.
 *
 * Money columns on `baccarat_table_bets` are TEXT-stringified bigints (same
 * convention as `baccarat.ts` / `poker-cash.ts`). Table bet bounds are integer
 * vCLAW.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';
import { baccaratShoes, baccaratCoups } from './baccarat';

export const baccaratTables = pgTable(
  'baccarat_tables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'house' (v1 only) | 'player-public' | 'private' (reserved; the manager refuses them). */
    source: text('source').notNull(),
    /** 'public' | 'private' (reserved). */
    visibility: text('visibility').notNull(),
    /** 'low' | 'mid' | 'high' for house tables. Display only; the bounds below are authoritative. */
    tierKey: text('tier_key'),
    /** Minimum per-seat stake per round (integer vCLAW). */
    minBetCt: integer('min_bet_ct').notNull(),
    /** Maximum per-seat stake per round (integer vCLAW). */
    maxBetCt: integer('max_bet_ct').notNull(),
    /** Seats at the table (2..8; house tables use 6). */
    maxSeats: integer('max_seats').notNull(),
    /** Visual-only seeded bots per table (they never bet). */
    seededAgentSlots: integer('seeded_agent_slots').notNull().default(0),
    /** The table's open shoe (NULL until the first deal opens one). */
    activeShoeId: uuid('active_shoe_id').references(() => baccaratShoes.id, {
      onDelete: 'set null',
    }),
    /** The last closed shoe (its server seed is public). */
    previousShoeId: uuid('previous_shoe_id').references(() => baccaratShoes.id, {
      onDelete: 'set null',
    }),
    /** Monotonic WINDOW counter: +1 at every exit from 'dealing'. Bets carry it. */
    roundSeq: bigint('round_seq', { mode: 'number' }).notNull().default(0),
    /** 'idle' | 'betting' | 'dealing' | 'reveal'. */
    roundPhase: text('round_phase').notNull().default('idle'),
    /** End of the betting window / reveal pause, or the settle retry time while 'dealing'. */
    phaseEndsAt: timestamp('phase_ends_at', { withTimezone: true }),
    /** Failed settle attempts for the current 'dealing' round (5th failure voids the round). */
    settleAttempts: integer('settle_attempts').notNull().default(0),
    /** The last committed coup (drives `lastRound` on the wire). */
    lastCoupId: uuid('last_coup_id').references(() => baccaratCoups.id, {
      onDelete: 'set null',
    }),
    /** The round_seq of `last_coup_id`. */
    lastRoundSeq: bigint('last_round_seq', { mode: 'number' }),
    /** Audit: the avatar that created the table (NULL for house tables is allowed). */
    createdBy: uuid('created_by').references(() => avatars.id, { onDelete: 'set null' }),
    /** 'open' | 'closed'. */
    status: text('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    discoveryIdx: index('baccarat_tables_discovery_idx').on(table.visibility, table.status),
    tierIdx: index('baccarat_tables_tier_idx').on(table.source, table.tierKey, table.status),
    sourceCheck: check(
      'baccarat_tables_source_check',
      sql`source IN ('house', 'player-public', 'private')`,
    ),
    visibilityCheck: check(
      'baccarat_tables_visibility_check',
      sql`visibility IN ('public', 'private')`,
    ),
    statusCheck: check('baccarat_tables_status_check', sql`status IN ('open', 'closed')`),
    phaseCheck: check(
      'baccarat_tables_phase_check',
      sql`round_phase IN ('idle', 'betting', 'dealing', 'reveal')`,
    ),
    betBoundsCheck: check(
      'baccarat_tables_bet_bounds_check',
      sql`min_bet_ct > 0 AND max_bet_ct >= min_bet_ct`,
    ),
    seatBoundsCheck: check(
      'baccarat_tables_seat_bounds_check',
      sql`max_seats BETWEEN 2 AND 8 AND seeded_agent_slots BETWEEN 0 AND max_seats`,
    ),
  }),
);

export const baccaratTableSeats = pgTable(
  'baccarat_table_seats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: uuid('table_id')
      .notNull()
      .references(() => baccaratTables.id, { onDelete: 'cascade' }),
    /** The seated avatar (a human's avatar, an agent's bound avatar, or a seeded bot). */
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** Agent string id when an agent sits; NULL for a human. */
    agentId: text('agent_id'),
    /** 'human' | 'agent' (seeded bots are 'agent' + is_seeded). */
    subjectType: text('subject_type').notNull(),
    /** True for a visual-only house bot. A seeded seat can never bet. */
    isSeeded: boolean('is_seeded').notNull().default(false),
    /** 0..7 (house tables use 0..5). */
    seatIndex: integer('seat_index').notNull(),
    /** 'seated' | 'left' (terminal; the row stays as history). */
    status: text('status').notNull().default('seated'),
    seatedAt: timestamp('seated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Updated on sit and on each bet; the idle-seat sweep frees seats older than 10 min. */
    lastActionAt: timestamp('last_action_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tableIdx: index('baccarat_table_seats_table_idx')
      .on(table.tableId)
      .where(sql`status = 'seated'`),
    activeIndexUnique: uniqueIndex('baccarat_table_seats_active_index_unique')
      .on(table.tableId, table.seatIndex)
      .where(sql`status = 'seated'`),
    // One shared-baccarat seat per avatar across ALL tables (also stops one bot at two tables).
    activeAvatarUnique: uniqueIndex('baccarat_table_seats_active_avatar_unique')
      .on(table.avatarId)
      .where(sql`status = 'seated'`),
    subjectTypeCheck: check(
      'baccarat_table_seats_subject_type_check',
      sql`subject_type IN ('human', 'agent')`,
    ),
    statusCheck: check('baccarat_table_seats_status_check', sql`status IN ('seated', 'left')`),
    indexCheck: check(
      'baccarat_table_seats_index_check',
      sql`seat_index >= 0 AND seat_index < 8`,
    ),
  }),
);

export const baccaratTableBets = pgTable(
  'baccarat_table_bets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: uuid('table_id')
      .notNull()
      .references(() => baccaratTables.id, { onDelete: 'cascade' }),
    /** The table window (`baccarat_tables.round_seq`) this bet plays in. */
    roundSeq: bigint('round_seq', { mode: 'number' }).notNull(),
    seatIndex: integer('seat_index').notNull(),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** 'human' | 'agent'. Passed to the ledger as `actorKind` at settle. */
    actorKind: text('actor_kind').notNull(),
    /** Agent string id when an agent placed the bet; NULL for a human. */
    agentId: text('agent_id'),
    /** 'rest' | 'autonomous' (an `[ACTION: play_cove_game(game=baccarat ...)]` bet). */
    origin: text('origin').notNull().default('rest'),
    /** 'player' | 'banker' | 'tie'. */
    bet: text('bet').notNull(),
    /** Stake (stringified bigint vCLAW). */
    stake: text('stake').notNull(),
    /** 'pending' | 'settled' | 'void' | 'cancelled'. */
    status: text('status').notNull().default('pending'),
    /** Why a bet went 'void' (insufficient_at_settle, no_owner, daily_cap, settle_failed, orphaned). */
    voidReason: text('void_reason'),
    /** Set at settle. */
    shoeId: uuid('shoe_id').references(() => baccaratShoes.id, { onDelete: 'set null' }),
    /** Set at settle. (coup_id, seat_index) is a settle anchor. */
    coupId: uuid('coup_id').references(() => baccaratCoups.id, { onDelete: 'set null' }),
    /** The shoe coup index this bet settled in (NULL until settled). */
    coupIndex: integer('coup_index'),
    /** Gross payout (stringified bigint). NULL until settled. */
    payout: text('payout'),
    /** payout - stake (signed, stringified bigint). NULL until settled. */
    net: text('net'),
    /** Banker commission withheld (stringified bigint). NULL until settled. */
    commission: text('commission'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roundIdx: index('baccarat_table_bets_round_idx').on(table.tableId, table.roundSeq),
    avatarIdx: index('baccarat_table_bets_avatar_idx').on(
      table.avatarId,
      table.createdAt.desc(),
    ),
    // One live bet per (table, round, seat); replace = UPDATE this row.
    pendingRoundSeatUnique: uniqueIndex('baccarat_table_bets_pending_round_seat_unique')
      .on(table.tableId, table.roundSeq, table.seatIndex)
      .where(sql`status = 'pending'`),
    // Settle anchors: an avatar is charged at most once per (table, round),
    // and a seat at most once per coup.
    roundAvatarUnique: uniqueIndex('baccarat_table_bets_round_avatar_unique')
      .on(table.tableId, table.roundSeq, table.avatarId)
      .where(sql`status IN ('pending', 'settled')`),
    coupSeatUnique: uniqueIndex('baccarat_table_bets_coup_seat_unique')
      .on(table.coupId, table.seatIndex)
      .where(sql`coup_id IS NOT NULL AND status = 'settled'`),
    actorKindCheck: check(
      'baccarat_table_bets_actor_kind_check',
      sql`actor_kind IN ('human', 'agent')`,
    ),
    originCheck: check('baccarat_table_bets_origin_check', sql`origin IN ('rest', 'autonomous')`),
    betCheck: check('baccarat_table_bets_bet_check', sql`bet IN ('player', 'banker', 'tie')`),
    statusCheck: check(
      'baccarat_table_bets_status_check',
      sql`status IN ('pending', 'settled', 'void', 'cancelled')`,
    ),
  }),
);

export type BaccaratTable = typeof baccaratTables.$inferSelect;
export type NewBaccaratTable = typeof baccaratTables.$inferInsert;
export type BaccaratTableSeat = typeof baccaratTableSeats.$inferSelect;
export type NewBaccaratTableSeat = typeof baccaratTableSeats.$inferInsert;
export type BaccaratTableBet = typeof baccaratTableBets.$inferSelect;
export type NewBaccaratTableBet = typeof baccaratTableBets.$inferInsert;
