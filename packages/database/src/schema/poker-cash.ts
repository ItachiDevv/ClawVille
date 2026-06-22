/**
 * Poker CASH GAMES (P1) — ring-table schema (ADDITIVE ONLY).
 *
 * Classic online poker CASH tables, ClawTokens (CT) ONLY. This is a SEPARATE
 * product from the tournament engine (`poker.ts` — `poker_tournaments` et al.):
 *   - a tournament has ONE buy-in, play-money chips, busts→placement, a prize
 *     pool, and rising blinds;
 *   - a CASH table has FIXED blinds, chips==CT 1:1, you SIT DOWN with a CT
 *     buy-in (debit) and LEAVE between hands to cash your CURRENT stack back to
 *     CT (credit), and join any open seat anytime.
 * These four `poker_cash_*` tables DO NOT touch `poker_tournaments` /
 * `poker_tables` / `poker_hands` — they are net-new and clean on a fresh push.
 *
 * ── MONEY MODEL (LOCKED, P1) ─────────────────────────────────────────────────
 * CASH chips ARE CT (1:1). The CT ledger crosses on exactly two flows:
 *   1. SIT/REBUY DEBIT — subject → `table_escrow_ct` (the table holds the chips
 *      while they are in play);
 *   2. LEAVE CASH-OUT CREDIT — `table_escrow_ct` → subject (the seat's CURRENT
 *      `current_stack_ct` is returned, between hands only).
 * RAKE is 0 for P1 (the `rake_bps` / `rake_cap_ct` / `rake_taken_ct` columns
 * exist so a rake can be switched on later WITHOUT a migration). The continuous
 * conservation invariant, at rest (no hand in flight):
 *     table_escrow_ct == sum(seat.current_stack_ct over sitting_in|sitting_out)
 * and across the whole lifecycle:
 *     sum(buy_in debits) == sum(cash_out credits) + table_escrow_ct + rake_taken_ct
 * Money columns are TEXT-stringified atomic bigints (mirroring poker.ts /
 * holdem.ts) so a future crypto buy-in tier survives without a migration.
 *
 * ── LEADERBOARD (P1) ─────────────────────────────────────────────────────────
 * Private tables do NOT score the leaderboard; public tables DO — but P1 emits
 * NO leaderboard event at all (the settle path only moves CT). Wiring the
 * `activity.match.*` event for public cash results is a LATER phase.
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
 * `poker_cash_hands.settled_at` is the per-hand idempotency anchor: a settle
 * that finds it non-null under the FOR UPDATE row lock replays the stored
 * outcome instead of re-applying chip deltas (the same pattern as
 * `poker_hands.settled_at` / `blackjack_hands.settledAt`).
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
import { avatars } from './avatars';

export const pokerCashTables = pgTable(
  'poker_cash_tables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Who stood the table up:
     *   'house'         → an operator/seeded house table (fixed tier).
     *   'player-public' → a player-created PUBLIC table (fixed tier; discoverable).
     *   'private'       → a player-created PRIVATE table (custom stakes; join_code only).
     */
    source: text('source').notNull(),
    /** 'public' (discoverable in GET /tables) | 'private' (join_code only). */
    visibility: text('visibility').notNull(),
    /**
     * Stake-tier label for fixed-tier tables ('low' | 'mid' | 'high'), or null for
     * a private custom-stakes table. Audit/display only — the authoritative stakes
     * are the buy_in/sb/bb columns below.
     */
    tierKey: text('tier_key'),
    /** Buy-in per sit (atomic CT, stringified bigint). chips==CT 1:1. */
    buyInCt: text('buy_in_ct').notNull(),
    /** Small blind (atomic CT, stringified bigint). */
    smallBlindCt: text('small_blind_ct').notNull(),
    /** Big blind (atomic CT, stringified bigint). bb >= sb (enforced by check on int form). */
    bigBlindCt: text('big_blind_ct').notNull(),
    /** Max seats at the table (2..8). */
    maxSeats: integer('max_seats').notNull(),
    /**
     * How many empty seats are eligible to be filled by a seeded agent so hands
     * complete (subject_type='agent', is_seeded=true). 0 disables agent fill.
     * Bounded 0..maxSeats by check.
     */
    seededAgentSlots: integer('seeded_agent_slots').notNull().default(0),
    /**
     * Short alphanumeric join code for PRIVATE tables (null for public). Partial
     * unique index enforces global uniqueness among non-null codes.
     */
    joinCode: text('join_code'),
    /**
     * AUDIT — the avatar that created this table (human's active avatar OR an
     * agent's bound avatar). Nullable + FK `set null` so deleting the creator's
     * avatar leaves the table row intact. House tables created by a system/boot
     * seeder carry null.
     */
    createdBy: uuid('created_by').references(() => avatars.id, { onDelete: 'set null' }),
    /** House rake in basis points (0..10000). 0 in P1; column exists for later. */
    rakeBps: integer('rake_bps').notNull().default(0),
    /** Optional per-pot rake cap (atomic CT, stringified). Null = no cap. Unused in P1. */
    rakeCapCt: text('rake_cap_ct'),
    /**
     * Authoritative escrow accumulator (atomic CT, stringified). Holds every chip
     * currently in play at the table. At rest:
     *   table_escrow_ct == sum(seat.current_stack_ct).
     */
    tableEscrowCt: text('table_escrow_ct').notNull().default('0'),
    /** Cumulative rake taken across all hands (atomic CT, stringified). 0 in P1. */
    rakeTakenCt: text('rake_taken_ct').notNull().default('0'),
    /** 'open' → seatable + playable; 'closed' → no new sits, drained/torn down. */
    status: text('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    discoveryIdx: index('poker_cash_tables_discovery_idx').on(
      table.visibility,
      table.status,
    ),
    createdByIdx: index('poker_cash_tables_created_by_idx').on(table.createdBy),
    // Global uniqueness of join codes ONLY among the non-null (private) ones.
    joinCodeUnique: uniqueIndex('poker_cash_tables_join_code_unique')
      .on(table.joinCode)
      .where(sql`join_code IS NOT NULL`),
    sourceCheck: check(
      'poker_cash_tables_source_check',
      sql`source in ('house','player-public','private')`,
    ),
    visibilityCheck: check(
      'poker_cash_tables_visibility_check',
      sql`visibility in ('public','private')`,
    ),
    statusCheck: check(
      'poker_cash_tables_status_check',
      sql`status in ('open','closed')`,
    ),
    seatBoundsCheck: check(
      'poker_cash_tables_seat_bounds_check',
      sql`max_seats >= 2 AND max_seats <= 8 AND seeded_agent_slots >= 0 AND seeded_agent_slots <= max_seats`,
    ),
    rakeBpsCheck: check(
      'poker_cash_tables_rake_bps_check',
      sql`rake_bps >= 0 AND rake_bps <= 10000`,
    ),
  }),
);

export const pokerCashSeats = pgTable(
  'poker_cash_seats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: uuid('table_id')
      .notNull()
      .references(() => pokerCashTables.id, { onDelete: 'cascade' }),
    /** The seated subject's avatar (human OR agent's bound avatar). */
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** OpenClaw agent string id when an agent sits AS ITSELF; null for a human. */
    agentId: text('agent_id'),
    /** 'human' | 'agent'. NEVER 'bot' (seeded agents are subject_type='agent'). */
    subjectType: text('subject_type').notNull(),
    /**
     * True for a SEEDED agent the table spawned to fill an empty seat so hands
     * complete (trivial stub policy). False for a real human/connected agent.
     */
    isSeeded: text('is_seeded').notNull().default('false'),
    /** Seat index at the table (0..maxSeats-1). */
    seatIndex: integer('seat_index').notNull(),
    /** Live chip stack (atomic CT, stringified). chips==CT 1:1. Cashed out on leave. */
    currentStackCt: text('current_stack_ct').notNull().default('0'),
    /**
     * 'sitting_in'  → seated + in the deal rotation.
     * 'sitting_out' → seated but skipped (not P1-exercised; reserved).
     * 'left'        → cashed out; seat freed (terminal). A 'left' row is history.
     */
    status: text('status').notNull().default('sitting_in'),
    /** Cumulative CT bought in at this seat (atomic CT, stringified). */
    totalBoughtInCt: text('total_bought_in_ct').notNull().default('0'),
    /** Cumulative CT cashed out from this seat (atomic CT, stringified). */
    totalCashedOutCt: text('total_cashed_out_ct').notNull().default('0'),
    seatedAt: timestamp('seated_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tableIdx: index('poker_cash_seats_table_idx').on(table.tableId),
    avatarIdx: index('poker_cash_seats_avatar_idx').on(table.avatarId),
    // ONE active seat per (table, avatar): a subject can't double-sit. Scoped to
    // non-'left' rows so a re-sit after leaving is allowed (the old row is history).
    activeSeatUnique: uniqueIndex('poker_cash_seats_active_avatar_unique')
      .on(table.tableId, table.avatarId)
      .where(sql`status <> 'left'`),
    // ONE occupant per (table, seat_index) among active seats.
    activeSeatIndexUnique: uniqueIndex('poker_cash_seats_active_index_unique')
      .on(table.tableId, table.seatIndex)
      .where(sql`status <> 'left'`),
    subjectTypeCheck: check(
      'poker_cash_seats_subject_type_check',
      sql`subject_type in ('human','agent')`,
    ),
    statusCheck: check(
      'poker_cash_seats_status_check',
      sql`status in ('sitting_in','sitting_out','left')`,
    ),
  }),
);

export const pokerCashHands = pgTable(
  'poker_cash_hands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: uuid('table_id')
      .notNull()
      .references(() => pokerCashTables.id, { onDelete: 'cascade' }),
    /** Monotonic hand number at this table (also the RNG nonce). */
    handNumber: integer('hand_number').notNull(),
    /** sha256(serverSeed) committed before the hand (public). */
    serverSeedCommit: text('server_seed_commit').notNull(),
    /** Revealed server seed (post-settle audit). Null until settled. */
    serverSeedReveal: text('server_seed_reveal'),
    /** Client seed entropy contribution for this hand. */
    clientSeed: text('client_seed').notNull(),
    /** Final community board (0..5 cards) as JSON. Null until settled. Shape = Card[]. */
    boardJson: jsonb('board_json'),
    /** Total chips in the pot this hand (atomic CT, stringified). Null until settled. */
    potTotalCt: text('pot_total_ct'),
    /** Rake taken off this hand's pot (atomic CT, stringified). 0 in P1. */
    rakeTakenCt: text('rake_taken_ct').notNull().default('0'),
    /**
     * Per-seat pot result. Shape mirrors HandResult.perSeat[]
     * ({seatIndex, avatarId, totalCommitted, won, net, status, ...}). Null until settled.
     */
    potResultJson: jsonb('pot_result_json'),
    /** Idempotency anchor: a settled hand replays instead of re-applying chip deltas. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tableHandUnique: uniqueIndex('poker_cash_hands_table_hand_unique').on(
      table.tableId,
      table.handNumber,
    ),
    tableIdx: index('poker_cash_hands_table_idx').on(table.tableId),
  }),
);

export const pokerCashLedgerEvents = pgTable(
  'poker_cash_ledger_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: uuid('table_id')
      .notNull()
      .references(() => pokerCashTables.id, { onDelete: 'cascade' }),
    /** The seat this CT flow is attributed to (null if the seat row was deleted). */
    seatId: uuid('seat_id').references(() => pokerCashSeats.id, { onDelete: 'set null' }),
    /** The subject's avatar this CT flow moved for. */
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** 'buy_in' | 'rebuy' | 'cash_out' | 'rake'. */
    kind: text('kind').notNull(),
    /** Signed-magnitude CT amount of the flow (atomic CT, stringified). Always positive. */
    amountCt: text('amount_ct').notNull(),
    /** The `claw_token_transactions.id` this flow produced (audit linkage). Null for rake. */
    ledgerTxnId: uuid('ledger_txn_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tableIdx: index('poker_cash_ledger_table_idx').on(table.tableId),
    avatarIdx: index('poker_cash_ledger_avatar_idx').on(table.avatarId),
    kindCheck: check(
      'poker_cash_ledger_kind_check',
      sql`kind in ('buy_in','rebuy','cash_out','rake')`,
    ),
  }),
);

// ── $inferSelect / $inferInsert exports (mirror poker.ts / holdem.ts style) ───

export type PokerCashTable = typeof pokerCashTables.$inferSelect;
export type NewPokerCashTable = typeof pokerCashTables.$inferInsert;
export type PokerCashSeat = typeof pokerCashSeats.$inferSelect;
export type NewPokerCashSeat = typeof pokerCashSeats.$inferInsert;
export type PokerCashHand = typeof pokerCashHands.$inferSelect;
export type NewPokerCashHand = typeof pokerCashHands.$inferInsert;
export type PokerCashLedgerEvent = typeof pokerCashLedgerEvents.$inferSelect;
export type NewPokerCashLedgerEvent = typeof pokerCashLedgerEvents.$inferInsert;
