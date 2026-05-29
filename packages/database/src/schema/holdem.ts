/**
 * Phase 6.5.1 — No-Limit Texas Hold'em table + hand schema (cove holdem).
 *
 * Mirrors the cove-blackjack two-table commit-reveal pattern
 * (blackjack_shoes / blackjack_hands):
 *   - holdem_tables: one row per commit-reveal TABLE SESSION. Holds the
 *     secret serverSeed (revealed at session close), the public
 *     serverSeedHash (committed at open), the per-session clientSeed, the
 *     monotonic handCounter (RNG nonce per hand), and the human seat's
 *     running stack. Unlike blackjack there is NO shared no-replacement
 *     shoe across hands: EACH hand shuffles a FRESH 52-card deck from the
 *     HMAC stream keyed on (serverSeed, clientSeed, nonce=handIndex,
 *     cursor=0). So there is no cursorCounter / dealtCount drift to track —
 *     every hand is independently replayable from (seed, handIndex).
 *   - holdem_hands: one row per HAND. Carries the in-progress state machine
 *     (recorded human actions, button position, posted blinds, status) and
 *     the terminal settlement. status flips in_progress→settled exactly once
 *     under a FOR UPDATE row lock — the idempotency backstop for settle.
 *     (tableId, handIndex) and (tableId, idempotencyKey) are both unique.
 *
 * Money columns are TEXT-stringified bigints — same convention as
 * blackjack.ts / cove-events.ts (lamport/µUSDC precision survives without a
 * schema migration; the SOL/USDC tier reuses these columns by swapping the
 * route's currency seam, not the schema).
 *
 * Stack model (LOCKED rule): the human seat buys in for `buyInStack` CT at
 * session open (authed: debited from avatar.clawTokens; guest: demo grant of
 * 100). The `playerStack` column is the human seat's CURRENT chip stack and
 * is the authoritative bankroll for every subsequent hand. At session close
 * the remaining `playerStack` is cashed out (authed: credited back to the
 * avatar; guest: discarded). Bots have ephemeral per-hand stacks (always the
 * default buy-in at hand start) — they are house seats with no persistent
 * bankroll, so no per-bot columns are needed.
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

export const holdemTables = pgTable(
  'holdem_tables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Exactly one of (userId, guestFpHash) is set (XOR check below). */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    guestFpHash: text('guest_fp_hash'),
    /** 'clawtoken' today; seam for 'sol' | 'usdc' (SOL/USDC tier, not yet wired). */
    currency: text('currency').notNull().default('clawtoken'),
    /** Secret until session close. 64-char hex. */
    serverSeed: text('server_seed').notNull(),
    /** Public at session open. sha256(serverSeed) hex. */
    serverSeedHash: text('server_seed_hash').notNull(),
    /** Per-session client seed (server-generated today; player-supplied future). */
    clientSeed: text('client_seed').notNull(),
    /** Monotonic hand index within the session (RNG nonce). Pre-increment. */
    handCounter: integer('hand_counter').notNull().default(0),
    /** Chips the human seat bought in for at session open (atomic CT, stringified). */
    buyInStack: text('buy_in_stack').notNull(),
    /** Human seat's CURRENT chip stack — authoritative bankroll (atomic CT, stringified). */
    playerStack: text('player_stack').notNull(),
    /** For authed users: snapshot of avatar.clawTokens at open (UI display). Guest: demo wallet snapshot. */
    startingBalance: text('starting_balance').notNull(),
    /** Sum of all chips the human put in pots this session (stringified bigint). */
    totalBet: text('total_bet').notNull().default('0'),
    /** Sum of all chips the human won back this session (stringified bigint). */
    totalPayout: text('total_payout').notNull().default('0'),
    /** 'open' | 'closed'. Closed reveals serverSeed on every cove_game_events row. */
    status: text('status').notNull().default('open'),
    handsPlayed: integer('hands_played').notNull().default(0),
    engineVersion: text('engine_version').notNull().default('th-v1'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastHandAt: timestamp('last_hand_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => ({
    userOpenUnique: uniqueIndex('holdem_tables_user_open_unique')
      .on(table.userId)
      .where(sql`status = 'open' AND user_id IS NOT NULL`),
    guestOpenUnique: uniqueIndex('holdem_tables_guest_open_unique')
      .on(table.guestFpHash)
      .where(sql`status = 'open' AND guest_fp_hash IS NOT NULL`),
    subjectCheck: check(
      'holdem_tables_subject_check',
      sql`(user_id IS NOT NULL) <> (guest_fp_hash IS NOT NULL)`,
    ),
  }),
);

export const holdemHands = pgTable(
  'holdem_hands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: uuid('table_id')
      .notNull()
      .references(() => holdemTables.id, { onDelete: 'cascade' }),
    /** Hand index within the session (RNG nonce; per-hand deck shuffle key). */
    handIndex: integer('hand_index').notNull(),
    /**
     * Button (dealer) seat index for this hand, 0..5. Rotates each hand so
     * the human (seat 0) cycles through every position over a session. The
     * blinds + action order derive from this — the engine recomputes them
     * deterministically so the verifier reproduces position-dependent bot
     * play. Persisted so settle/verify don't depend on a live counter.
     */
    buttonSeat: integer('button_seat').notNull(),
    /** Human seat's stack at the START of this hand (atomic CT, stringified). */
    startingStack: text('starting_stack').notNull(),
    /**
     * Recorded human decisions for this hand, in order. Each is one of
     * fold|check|call|bet|raise with an optional `amount` (total chips the
     * human wants in front after the action, for bet/raise). The engine
     * replays this list, running bots between each human decision, to
     * reproduce the exact hand. JSON shape = HoldemActionRecord[] (engine).
     */
    actions: jsonb('actions').notNull(),
    /** 'in_progress' | 'settled'. Terminal transition under FOR UPDATE = idempotency. */
    status: text('status').notNull().default('in_progress'),
    /** Final settled outcome payload (serializeHandResult shape). Null until settled. */
    outcomeJson: jsonb('outcome_json'),
    /** Total chips the human put in the pot this hand (stringified bigint). Null until settled. */
    betAmount: text('bet_amount'),
    /** Gross chips returned to the human at settle — pot won, or 0 (stringified bigint). Null until settled. */
    payout: text('payout'),
    /** Net P&L at settle (signed, stringified bigint). Null until settled. */
    net: text('net'),
    /** Human seat's stack AFTER this hand settled (atomic CT, stringified). Null until settled. */
    endingStack: text('ending_stack'),
    /** Idempotency key (per settle attempt). (tableId, idempotencyKey) unique. */
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => ({
    tableHandUnique: uniqueIndex('holdem_hands_table_hand_unique').on(
      table.tableId,
      table.handIndex,
    ),
    tableIdempotencyUnique: uniqueIndex('holdem_hands_table_idempotency_unique')
      .on(table.tableId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    tableIdx: index('holdem_hands_table_idx').on(table.tableId),
  }),
);

export type HoldemTable = typeof holdemTables.$inferSelect;
export type NewHoldemTable = typeof holdemTables.$inferInsert;
export type HoldemHand = typeof holdemHands.$inferSelect;
export type NewHoldemHand = typeof holdemHands.$inferInsert;
