/**
 * Phase 6.7.0 — unified cross-game history table for the Cove casino.
 *
 * One row per atomic gameplay unit (per-spin for slots, per-hand for
 * blackjack / Hold'em, per-coup for baccarat — see plan §0 decision 11).
 * Lives parallel to the per-game tables (`slot_spins`, future blackjack /
 * Hold'em / baccarat tables) — those remain authoritative for engine
 * replay; this table is the cross-game query + display surface.
 *
 * Provably-fair shape (plan §0 decision 2):
 *
 *   - `serverSeedHash` is committed at session/shoe open. NEVER reveal
 *     `revealedServerSeed` while the session is still 'open' — the route
 *     layer is responsible for nulling `revealedServerSeed` until the
 *     parent session closes (the column is nullable for exactly this
 *     reason).
 *   - `clientSeed` + `nonce` + revealed seed feed the per-game verifier
 *     to deterministically re-derive `outcomeJson`. Verifier asserts
 *     `sha256(revealedServerSeed) === serverSeedHash` AND
 *     `engineReplay(...) === outcomeJson`.
 *
 * `outcomeJson` is a discriminated union keyed by `gameType` — full type
 * definitions in `@clawville/shared/types/cove-history.ts` (Zod-validated
 * on write AND render per plan §9 risk register). Stringified bigints
 * inside (winAmount, etc.) match the on-the-wire format the existing
 * slots verifier already round-trips.
 *
 * `engineVersion` pins the engine code that produced the row — old rows
 * verify against their original engine even after a paytable retune or
 * engine rewrite (plan §9 risk #engine drift; mirrors the existing
 * `slot_spins.paytable_version` pattern). Default `'v1'` on rows that
 * don't yet carry a finer-grained version.
 *
 * Money columns are TEXT-stringified bigints — same convention as
 * `slot_sessions.starting_balance` / `slot_spins.win_amount` — so future
 * lamport / µUSDC precision survives without a schema migration.
 *
 * Idempotency: `(gameType, sessionId, nonce)` is unique. The backfill
 * script (`scripts/casino/backfill-slot-history.ts`) uses
 * `ON CONFLICT DO NOTHING` against this key so re-running the script
 * after a partial run is safe.
 */

import {
  pgTable,
  uuid,
  text,
  bigint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const coveGameEvents = pgTable(
  'cove_game_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** 'slots' | 'blackjack' | 'holdem' | 'baccarat'. Discriminator for `outcomeJson`. */
    gameType: text('game_type').notNull(),

    /**
     * Parent session id — slot session UUID, blackjack shoe UUID, etc.
     * String (NOT FK) so cross-game sessions can live in different
     * tables without per-game FK columns. Indexed for shoe-level audits.
     */
    sessionId: text('session_id').notNull(),

    /**
     * Shoe id — many sessions may share a shoe (blackjack 8-deck, etc.);
     * for slots `shoeId === sessionId`. Indexed for the per-shoe
     * `verify-all` audit endpoint.
     */
    shoeId: text('shoe_id').notNull(),

    /** Stringified bigint — amount risked on this event. */
    betAmount: text('bet_amount').notNull(),

    /** Stringified bigint — total payout (0 on a loss). */
    payout: text('payout').notNull(),

    /**
     * Game-specific outcome payload. Discriminated union by `gameType`
     * — see `@clawville/shared/types/cove-history.ts`. JSONB so we get
     * indexable queries on inner fields (e.g. "blackjack hands where
     * dealer busted").
     */
    outcomeJson: jsonb('outcome_json').notNull(),

    // ─── commit-reveal ────────────────────────────────────────────────
    /** Public at session/shoe open. sha256(serverSeed) hex. */
    serverSeedHash: text('server_seed_hash').notNull(),
    /**
     * NULL until the parent session/shoe closes. Route layer MUST gate
     * exposure: while parent status='open' this stays NULL. Once revealed,
     * verifier can prove `sha256(revealedServerSeed) === serverSeedHash`.
     */
    revealedServerSeed: text('revealed_server_seed'),
    /** Per-session client seed. May be player-supplied in future phases. */
    clientSeed: text('client_seed').notNull(),
    /**
     * Monotonic per-session counter. Slots: pre-increment spin index;
     * blackjack: hand index within the shoe; etc. Used with sessionId
     * for idempotent inserts via ON CONFLICT.
     */
    nonce: bigint('nonce', { mode: 'number' }).notNull(),

    /**
     * On-chain settlement signature for real-money tier (Phase 6.7.4).
     * NULL on fun-money rows. Clickable Solscan link in the UI once present.
     */
    txSignature: text('tx_signature'),

    /**
     * Pins the engine version that produced this row so the verifier
     * loads the matching replay code after future engine changes (plan
     * §9 risk #engine drift). Mirrors `slot_spins.paytable_version`.
     *
     *   'v1' — current backfill default for pre-6.7.0 slot history;
     *   per-game engines may bump this independently when their replay
     *   shape changes (e.g. blackjack 'bj-v1', Hold'em 'th-v1').
     */
    engineVersion: text('engine_version').notNull().default('v1'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /** Primary history-fetch path: `WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`. */
    userCreatedAtIdx: index('cove_game_events_user_created_at_idx').on(
      table.userId,
      table.createdAt.desc(),
    ),
    /** Per-shoe audit + bulk-verify queries. */
    shoeIdIdx: index('cove_game_events_shoe_id_idx').on(table.shoeId),
    /** Per-game-filtered history (`?game=blackjack`). */
    userGameCreatedAtIdx: index(
      'cove_game_events_user_game_created_at_idx',
    ).on(table.userId, table.gameType, table.createdAt.desc()),
    /**
     * Idempotent backfill key — `ON CONFLICT (game_type, session_id, nonce)
     * DO NOTHING`. Without this the slots backfill duplicates every row
     * on every re-run. Per-game uniqueness within a session is a real
     * invariant (no two slot spins share the same nonce within a session;
     * same for blackjack hands within a shoe).
     */
    gameSessionNonceUnique: uniqueIndex(
      'cove_game_events_game_session_nonce_unique',
    ).on(table.gameType, table.sessionId, table.nonce),
  }),
);

export type CoveGameEvent = typeof coveGameEvents.$inferSelect;
export type NewCoveGameEvent = typeof coveGameEvents.$inferInsert;
