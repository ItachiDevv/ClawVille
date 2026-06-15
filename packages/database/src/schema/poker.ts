/**
 * Poker MTT (P3) — single-table tournament schema (ADDITIVE ONLY).
 *
 * Six tables back the tournament engine. They sit ABOVE the per-hand cove
 * holdem tables (`holdem_tables`/`holdem_hands`, which model the vs-bots
 * single-seat replay game) — this is a DIFFERENT product: a multi-entrant
 * sit-n-go / MTT with a CT buy-in, a prize pool, rising blinds, busts→placement,
 * and a proportional pool payout. P3 is SINGLE TABLE (≤9 seats); multi-table
 * rebalancing / break / final-table is P4.
 *
 *   - `poker_tournaments` — one row per tournament. Config (buy-in, rake, entrant
 *     bounds, starting stack, payout curve, blind schedule) + the live status
 *     machine + the prize-pool accounting + the settle idempotency anchor
 *     (`settledAt`).
 *   - `poker_tournament_entrants` — one row per registered subject (human OR
 *     agent — NEVER bot; no-bot-fill is a brand constraint). Carries the
 *     buy-in-paid + refunded accounting, the live chip stack + seat, and the
 *     final placement. unique(tournamentId, avatarId) = one entry per subject.
 *   - `poker_tables` — one row per physical table in a tournament. P3 = exactly
 *     one. Tracks the dealer button + hand count. Optional roomId links to the
 *     activity room that surfaces the table over WS (P1.2b transport).
 *   - `poker_blind_schedules` — reusable rising-blind ladders
 *     (`levelsJson: [{level, sb, bb, ante, durationSec}]`). Referenced by a
 *     tournament; a default ladder is seeded in code (DEFAULT_BLIND_SCHEDULE).
 *   - `poker_hands` — one row per settled hand at a table. Commit-reveal seed
 *     pair + board + per-seat pot result + the per-hand idempotency anchor
 *     (`settledAt`). unique(tableId, handNumber). This is the crash-recovery
 *     checkpoint surface (P4) and the provably-fair audit trail.
 *   - `poker_tournament_results` — one row per PAID/placed subject at tournament
 *     close. placement + prizeCt + the credit idempotency anchor (`settledAt`).
 *     unique(tournamentId, avatarId).
 *
 * ── MONEY MODEL (LOCKED) ─────────────────────────────────────────────────────
 * Tournament CHIPS are NOT ClawTokens — they are play-money stacks internal to
 * the tournament. ONLY two flows cross the ClawToken ledger:
 *   1. the buy-in DEBIT at registration (subject → prize-pool accounting), and
 *   2. the prize CREDIT at finish (prize-pool → placed subjects).
 * `prizePoolCt` is the authoritative escrow accumulator. `rakeBps` is the
 * house cut taken off the TOP of the pool before the payout curve is applied,
 * so the conservation invariant is exactly:
 *     sum(poker_tournament_results.prizeCt) + rakeTakenCt == prizePoolCt
 * Money columns are TEXT-stringified bigints (atomic CT), mirroring holdem.ts /
 * cove-events.ts — lamport/µUSDC precision survives without a migration if a
 * crypto buy-in tier is ever added.
 *
 * `settledAt` columns are the idempotency anchors: a settle that finds a
 * non-null `settledAt` under the FOR UPDATE row lock replays the stored outcome
 * instead of double-crediting (same pattern as `holdem_hands.status` /
 * `blackjack_hands.settledAt`).
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

/**
 * One rising-blind ladder. `levelsJson` is an ordered array of levels; the TM
 * advances to the next level when the current level's `durationSec` elapses.
 */
export interface BlindLevel {
  level: number;
  sb: number;
  bb: number;
  ante: number;
  durationSec: number;
}

/**
 * Payout curve: ordered placement-share entries. `share` is a fraction of the
 * post-rake prize pool (the TM normalizes shares to sum to 1 defensively, and
 * assigns the rounding remainder to 1st so conservation holds exactly). A
 * placement deeper than the curve length earns 0 (min-cash boundary).
 */
export interface PayoutCurveEntry {
  /** 1-based placement this share applies to. */
  placement: number;
  /** Fraction of the post-rake pool (0..1). */
  share: number;
}

export const pokerBlindSchedules = pgTable('poker_blind_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Human-readable label, e.g. 'turbo-8'. */
  name: text('name').notNull(),
  /** Ordered rising-blind levels. Shape = BlindLevel[]. */
  levelsJson: jsonb('levels_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pokerTournaments = pgTable(
  'poker_tournaments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Display name. */
    name: text('name').notNull(),
    /**
     * Lifecycle:
     *   'registering' → open for entrants
     *   'seating'     → registration closed, seats being assigned
     *   'running'     → at least one hand has started
     *   'completed'   → a champion was crowned + prizes settled
     *   'cancelled'   → floor not met (or admin) → all buy-ins refunded
     */
    status: text('status').notNull().default('registering'),
    /** Buy-in per entrant (atomic CT, stringified bigint). Debited at registration. */
    buyInCt: text('buy_in_ct').notNull(),
    /** House rake in basis points (0..10000) taken off the top of the pool. */
    rakeBps: integer('rake_bps').notNull().default(0),
    /** Minimum entrants to start; below this at the trigger → cancel + refund. */
    minEntrants: integer('min_entrants').notNull().default(2),
    /** Hard cap on entrants (P3 single table ≤ seatsPerTable). */
    maxEntrants: integer('max_entrants').notNull(),
    /** Seats per table. P3 = single table, so this also bounds maxEntrants. */
    seatsPerTable: integer('seats_per_table').notNull().default(9),
    /** Starting chip stack each entrant is seated with (play chips, NOT CT). */
    startingStack: integer('starting_stack').notNull(),
    /**
     * Authoritative prize-pool escrow accumulator (atomic CT, stringified). Sum
     * of all collected buy-ins. Conservation at settle:
     *   sum(results.prizeCt) + rakeTakenCt == prizePoolCt.
     */
    prizePoolCt: text('prize_pool_ct').notNull().default('0'),
    /** Rake actually taken off the pool at settle (stringified bigint). Null until settle. */
    rakeTakenCt: text('rake_taken_ct'),
    /** Payout curve. Shape = PayoutCurveEntry[]. */
    payoutCurveJson: jsonb('payout_curve_json').notNull(),
    /** The blind schedule this tournament uses. */
    blindScheduleId: uuid('blind_schedule_id')
      .notNull()
      .references(() => pokerBlindSchedules.id, { onDelete: 'restrict' }),
    /** Registration auto-closes (and the start trigger fires) at this time. Null = manual. */
    registrationClosesAt: timestamp('registration_closes_at', { withTimezone: true }),
    /** When seating began (status → seating). Null until seated. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    /**
     * Idempotency anchor for the FINAL prize settlement. A settle that finds
     * this non-null under the FOR UPDATE lock replays — never double-credits.
     */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /** When refunds completed (status → cancelled). Idempotency anchor for refund. */
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index('poker_tournaments_status_idx').on(table.status),
    statusCheck: check(
      'poker_tournaments_status_check',
      sql`status in ('registering','seating','running','completed','cancelled')`,
    ),
    rakeBpsCheck: check('poker_tournaments_rake_bps_check', sql`rake_bps >= 0 AND rake_bps <= 10000`),
    // P4 (multi-table) RELAXED this from the original P3 single-table form, which
    // also required `max_entrants <= seats_per_table`. That clause was a single-table
    // assumption: the MTT engine seats `ceil(maxEntrants / seatsPerTable)` BALANCED
    // tables, so max_entrants legitimately exceeds seats_per_table. The bounds now
    // enforce only what's universally true: a ≥2 floor, max ≥ min, and a sane
    // 2..9-seat table. (A live DB pushed under the P3 form must run
    // migrations-manual/2026-06-…_poker_relax_entrant_bounds.sql to drop+recreate
    // this constraint — drizzle push does NOT auto-replace a renamed CHECK body.)
    entrantBoundsCheck: check(
      'poker_tournaments_entrant_bounds_check',
      sql`min_entrants >= 2 AND max_entrants >= min_entrants AND seats_per_table >= 2 AND seats_per_table <= 9`,
    ),
    startingStackCheck: check('poker_tournaments_starting_stack_check', sql`starting_stack > 0`),
  }),
);

export const pokerTournamentEntrants = pgTable(
  'poker_tournament_entrants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => pokerTournaments.id, { onDelete: 'cascade' }),
    /** The entrant's avatar — the ledger + leaderboard subject (human OR agent's bound avatar). */
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** OpenClaw agent string id when an agent entered AS ITSELF; null for a human. */
    agentId: text('agent_id'),
    /** 'human' | 'agent'. NEVER 'bot' (no-bot-fill brand constraint, enforced by check). */
    subjectType: text('subject_type').notNull(),
    /** CT actually debited at registration (atomic CT, stringified). */
    buyInPaidCt: text('buy_in_paid_ct').notNull(),
    /** CT refunded on cancellation (atomic CT, stringified). '0' until/unless refunded. */
    refundedCt: text('refunded_ct').notNull().default('0'),
    /**
     * Final placement (1 = champion). Null while still alive / unseated. Lower
     * is better. Set at bust (or at win for the champion).
     */
    placement: integer('placement'),
    /** Live chip stack (play chips, NOT CT). Updated after every settled hand. */
    chipStack: integer('chip_stack').notNull().default(0),
    /** Which table this entrant sits at (P3 = the single table). Null until seated. */
    currentTableId: uuid('current_table_id').references(() => pokerTables.id, {
      onDelete: 'set null',
    }),
    /** Seat index at the current table (0..seatsPerTable-1). Null until seated. */
    seatIndex: integer('seat_index'),
    /**
     * 'registered' → bought in, awaiting seating
     * 'seated'     → has a seat + chips, alive
     * 'busted'     → eliminated (chipStack 0), placement assigned
     * 'refunded'   → tournament cancelled, buy-in returned
     */
    status: text('status').notNull().default('registered'),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    bustedAt: timestamp('busted_at', { withTimezone: true }),
  },
  (table) => ({
    tournamentAvatarUnique: uniqueIndex('poker_entrants_tournament_avatar_unique').on(
      table.tournamentId,
      table.avatarId,
    ),
    tournamentIdx: index('poker_entrants_tournament_idx').on(table.tournamentId),
    subjectTypeCheck: check(
      'poker_entrants_subject_type_check',
      sql`subject_type in ('human','agent')`,
    ),
    statusCheck: check(
      'poker_entrants_status_check',
      sql`status in ('registered','seated','busted','refunded')`,
    ),
  }),
);

export const pokerTables = pgTable(
  'poker_tables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => pokerTournaments.id, { onDelete: 'cascade' }),
    /** 1-based table number within the tournament. P3 = always 1. */
    tableNumber: integer('table_number').notNull().default(1),
    /** Optional activity-room id surfacing this table over WS (P1.2b transport). */
    roomId: uuid('room_id'),
    /** 'live' while hands play; 'broken' when consolidated away (P4); 'done' at table win. */
    status: text('status').notNull().default('live'),
    /** Dealer button seat index for the NEXT hand (rotates among live seats). */
    buttonSeatIndex: integer('button_seat_index').notNull().default(0),
    /** Hands dealt at this table so far (monotonic; the sim's handNumber). */
    handCount: integer('hand_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tournamentIdx: index('poker_tables_tournament_idx').on(table.tournamentId),
    tournamentNumberUnique: uniqueIndex('poker_tables_tournament_number_unique').on(
      table.tournamentId,
      table.tableNumber,
    ),
    statusCheck: check('poker_tables_status_check', sql`status in ('live','broken','done')`),
  }),
);

export const pokerHands = pgTable(
  'poker_hands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: uuid('table_id')
      .notNull()
      .references(() => pokerTables.id, { onDelete: 'cascade' }),
    /** Monotonic hand number at this table (RNG nonce; the sim's handNumber). */
    handNumber: integer('hand_number').notNull(),
    /** sha256(serverSeed) committed before the hand (public). */
    serverSeedCommit: text('server_seed_commit').notNull(),
    /** Revealed server seed (post-settle audit). Null until settled. */
    serverSeedReveal: text('server_seed_reveal'),
    /** Client seed entropy contribution for this hand. */
    clientSeed: text('client_seed').notNull(),
    /** Final community board (5 cards) as JSON. Null until settled. Shape = Card[]. */
    boardJson: jsonb('board_json'),
    /**
     * Per-seat pot result for this hand. Shape mirrors HandResult.perSeat[]
     * ({seatIndex, avatarId, totalCommitted, won, net, status, ...}). Null until settled.
     */
    potResultJson: jsonb('pot_result_json'),
    /** Idempotency anchor: a settled hand replays instead of re-applying chip deltas. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tableHandUnique: uniqueIndex('poker_hands_table_hand_unique').on(
      table.tableId,
      table.handNumber,
    ),
    tableIdx: index('poker_hands_table_idx').on(table.tableId),
  }),
);

export const pokerTournamentResults = pgTable(
  'poker_tournament_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => pokerTournaments.id, { onDelete: 'cascade' }),
    /** The placed subject's avatar (ledger + leaderboard subject). */
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** OpenClaw agent string id when the placed subject was an agent; null for a human. */
    agentId: text('agent_id'),
    /** Final placement (1 = champion). */
    placement: integer('placement').notNull(),
    /** CT prize credited for this placement (atomic CT, stringified). 0 for non-cashing places. */
    prizeCt: text('prize_ct').notNull().default('0'),
    /**
     * Idempotency anchor: the prize credit for THIS result row happened exactly
     * once. The TM writes the row first (settledAt null) then flips it to now()
     * in the SAME tx as the creditClawTokens call, so a re-settle that sees a
     * non-null settledAt skips the credit.
     */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tournamentAvatarUnique: uniqueIndex('poker_results_tournament_avatar_unique').on(
      table.tournamentId,
      table.avatarId,
    ),
    tournamentPlacementIdx: index('poker_results_tournament_placement_idx').on(
      table.tournamentId,
      table.placement,
    ),
  }),
);

// ── $inferSelect / $inferInsert exports (mirror holdem.ts style) ──────────────

export type PokerBlindSchedule = typeof pokerBlindSchedules.$inferSelect;
export type NewPokerBlindSchedule = typeof pokerBlindSchedules.$inferInsert;
export type PokerTournament = typeof pokerTournaments.$inferSelect;
export type NewPokerTournament = typeof pokerTournaments.$inferInsert;
export type PokerTournamentEntrant = typeof pokerTournamentEntrants.$inferSelect;
export type NewPokerTournamentEntrant = typeof pokerTournamentEntrants.$inferInsert;
export type PokerTable = typeof pokerTables.$inferSelect;
export type NewPokerTable = typeof pokerTables.$inferInsert;
export type PokerHand = typeof pokerHands.$inferSelect;
export type NewPokerHand = typeof pokerHands.$inferInsert;
export type PokerTournamentResult = typeof pokerTournamentResults.$inferSelect;
export type NewPokerTournamentResult = typeof pokerTournamentResults.$inferInsert;
