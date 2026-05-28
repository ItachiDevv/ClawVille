/**
 * Phase 6.1 — slice 3 (fun-money backend wire).
 *
 * Two tables back the ClawTokens session-escrow + commit-reveal spin loop:
 *
 *   - `slot_sessions` — one row per "sit down at a machine." Holds the
 *     commit-reveal pair (serverSeed hidden until close, serverSeedHash
 *     published at open), the engine cursor (`nonceCounter` + monotone
 *     `cursorCounter`), the escrow + balance accounting, and a session
 *     state machine (`open` → `closed` | `expired`). A partial-unique
 *     index enforces at-most-one open session per user; the DB raises
 *     on conflict and the route maps it to a 409.
 *
 *   - `slot_spins` — every spin within a session — full audit trail for
 *     the public verifier. RNG inputs (nonce + cursor before/after) and
 *     evaluated outputs (reels, winning lines) are persisted so any
 *     third party can replay every spin after the server seed is
 *     revealed on session close.
 *
 * Currency-agnostic by design (`currency: 'clawtokens' | 'sol' | 'usdc'`)
 * even though slice 3 only wires ClawTokens — SOL/USDC routes return 501
 * until Phase 6.2 custody lands. Monetary fields are stored as TEXT so
 * future bigint precision (lamports / µUSDC) survives without a schema
 * migration; today's ClawTokens values stringify cleanly into the same
 * column.
 *
 * Bigint mode `'number'` on `nonceCounter`/`cursorCounter`/`nonce`/
 * `cursorBefore`/`cursorAfter` matches the slot-engine API surface,
 * which uses `number` for the RNG cursor (bounded well below
 * MAX_SAFE_INTEGER — `provable-rng` already throws if it isn't).
 */

import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

export const slotSessions = pgTable(
  'slot_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Phase 6.7.5 — nullable for guest sessions. Exactly one of (`userId`,
     * `guestFpHash`) must be set; enforced by the
     * `slot_sessions_subject_check` DB constraint. Guest sessions get
     * re-stamped to a real user_id on signup via `POST /api/cove/history/claim`.
     */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Phase 6.7.5 — salted-sha256 fingerprint from `fingerprintMiddleware`,
     * set when the session opener is unauthenticated (NPC mode). NULL once
     * claimed.
     */
    guestFpHash: text('guest_fp_hash'),
    /** Machine identifier — only 'classic-3x5' in MVP. */
    paytableId: text('paytable_id').notNull(),
    /** 'clawtokens' | 'sol' | 'usdc'. Non-clawtokens currencies return 501 at the route. */
    currency: text('currency').notNull(),

    // ─── commit-reveal ────────────────────────────────────────────────
    /**
     * 64-char hex CSPRNG. NEVER expose while status='open' — the route
     * layer redacts this field from any owner read until close.
     */
    serverSeed: text('server_seed').notNull(),
    /** sha256(serverSeed). Public at open — backbone of the commit. */
    serverSeedHash: text('server_seed_hash').notNull(),
    /**
     * Per-session client seed (server-generated 16 hex chars for slice 3).
     * Later phases will accept a player-supplied value; the column is
     * already non-null so swapping in a user-provided seed is a route
     * change, not a schema change.
     */
    clientSeed: text('client_seed').notNull(),

    // ─── engine cursor (replay key) ───────────────────────────────────
    /** Monotonic per-spin nonce — `0` at session open, increments by 1 each spin. */
    nonceCounter: bigint('nonce_counter', { mode: 'number' }).notNull().default(0),
    /**
     * Byte cursor into the HMAC-derived stream. Slot engine's
     * `runSpin.cursorAfter` becomes the next spin's `cursor`. Monotone.
     */
    cursorCounter: bigint('cursor_counter', { mode: 'number' }).notNull().default(0),

    // ─── money (stringified bigint so future lamport/µUSDC values survive) ──
    /** Reserved escrow at session open — refunded on close. */
    startingBalance: text('starting_balance').notNull(),
    /** Current session balance — debited per predict, credited per win. */
    currentBalance: text('current_balance').notNull(),
    /** Unused reservation — refunded to the user on close. */
    escrowAmount: text('escrow_amount').notNull().default('0'),
    /** Cumulative wagered across the session. */
    totalStaked: text('total_staked').notNull().default('0'),
    /** Cumulative winnings across the session. */
    totalWon: text('total_won').notNull().default('0'),

    // ─── state machine ────────────────────────────────────────────────
    /** 'open' | 'closed' | 'expired'. */
    status: text('status').notNull().default('open'),
    /** 'base' | 'free-spin'. Free-spin runtime arrives in slice 6.1.5. */
    mode: text('mode').notNull().default('base'),
    freeSpinsRemaining: integer('free_spins_remaining').notNull().default(0),
    spinCount: integer('spin_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSpinAt: timestamp('last_spin_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => ({
    /** Partial — guest sessions ride `guestFpIdx`. */
    userIdIdx: index('slot_sessions_user_id_idx')
      .on(table.userId)
      .where(sql`user_id IS NOT NULL`),
    statusIdx: index('slot_sessions_status_idx').on(table.status),
    /**
     * One open session per user. The route layer SELECTs for an existing
     * `status='open'` row first and returns 409 cleanly, but the DB
     * unique index is the load-bearing race-safety guarantee — two
     * concurrent /session/open calls can't both win because one of them
     * will trip this partial index and fail at INSERT time. Guest open
     * sessions ride `openGuestSessionUnique` below.
     */
    openSessionUnique: uniqueIndex('slot_sessions_user_open_unique')
      .on(table.userId)
      .where(sql`status = 'open' AND user_id IS NOT NULL`),
    /**
     * Phase 6.7.5 — guest history index + one-open-session-per-fp guard.
     * Guests can't bypass the open-session race by simply not having a
     * user_id.
     */
    guestFpIdx: index('slot_sessions_guest_fp_idx')
      .on(table.guestFpHash)
      .where(sql`guest_fp_hash IS NOT NULL`),
    openGuestSessionUnique: uniqueIndex('slot_sessions_guest_open_unique')
      .on(table.guestFpHash)
      .where(sql`status = 'open' AND guest_fp_hash IS NOT NULL`),
  }),
);

export const slotSpins = pgTable(
  'slot_spins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => slotSessions.id, { onDelete: 'cascade' }),

    // ─── RNG inputs (replayable) ──────────────────────────────────────
    /** Spin's nonce within the session (matches slotSessions.nonceCounter pre-increment). */
    nonce: bigint('nonce', { mode: 'number' }).notNull(),
    /** Byte cursor before reel sampling. */
    cursorBefore: bigint('cursor_before', { mode: 'number' }).notNull(),
    /** Byte cursor after reel sampling — fed into the next spin. */
    cursorAfter: bigint('cursor_after', { mode: 'number' }).notNull(),

    // ─── wager ────────────────────────────────────────────────────────
    predict: text('predict').notNull(),
    isFreeSpin: boolean('is_free_spin').notNull().default(false),

    // ─── outcome (JSONB so the verifier can re-derive structurally) ──
    /** 5×3 grid of symbol ids. */
    reels: jsonb('reels').notNull(),
    /**
     * `WinningLine[]` — winAmount inside each entry is STRINGIFIED to
     * preserve bigint shape across the JSON wire. The engine returns
     * bigint; routes/verifier convert via `serializeSpinResult`.
     */
    winningLines: jsonb('winning_lines').notNull(),
    /** Stringified bigint — total payout for this spin. */
    winAmount: text('win_amount').notNull(),
    /** Reserved for 6.1.5 — empty array today. */
    wildMultipliers: jsonb('wild_multipliers').notNull().default(sql`'[]'::jsonb`),
    /** Reserved for 6.1.5 — '0' today. */
    scatterPayout: text('scatter_payout').notNull().default('0'),

    // ─── idempotency ──────────────────────────────────────────────────
    /**
     * Client-supplied via `Idempotency-Key` header. The partial unique
     * index on (sessionId, idempotencyKey) lets us SELECT the cached
     * spin and replay the exact response, dodging double-spin charges
     * on network retries.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    /**
     * Paytable version snapshot at spin-time. Required for verifier
     * replay after a paytable retune — when payouts change, replaying
     * an old spin through the CURRENT engine produces a winAmount
     * mismatch even though the reels are byte-identical. Verifier
     * branches on this column to load the historical payout table.
     *
     *   'v1' — pre-Phase 6.1.10 (classic 96% / bonus ~97.5% RTP)
     *   'v2' — Phase 6.1.10+ (94% RTP across both paytables)
     *
     * Existing rows backfill to 'v1' via the same-diff manual migration
     * (packages/database/migrations-manual/2026-05-20_add_slot_spins_paytable_version.sql).
     */
    paytableVersion: text('paytable_version').notNull().default('v2'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdIdx: index('slot_spins_session_id_idx').on(table.sessionId),
    idempotencyUnique: uniqueIndex('slot_spins_session_idempotency_unique').on(
      table.sessionId,
      table.idempotencyKey,
    ),
  }),
);

export type SlotSession = typeof slotSessions.$inferSelect;
export type NewSlotSession = typeof slotSessions.$inferInsert;
export type SlotSpin = typeof slotSpins.$inferSelect;
export type NewSlotSpin = typeof slotSpins.$inferInsert;
