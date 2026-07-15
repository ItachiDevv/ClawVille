import {
  pgTable,
  uuid,
  text,
  varchar,
  smallint,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { avatars } from './avatars';

/**
 * Wager lobby + escrow schema (concern 1 of the gambling-contracts vertical
 * slice). Mirrors the on-chain state machine of the deployed `clawville_wager`
 * Anchor program at `HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG`.
 *
 * Source-of-truth split:
 *
 *   - **On-chain** is authoritative for money: Lobby PDA, Vault PDA, Player
 *     PDA hold the deposits + state machine guards (open → locked → settled /
 *     cancelled). The 5% rake is computed by the program at settle.
 *   - **Off-chain** (these tables) is authoritative for product discovery,
 *     listing, invite-code lookup, room→lobby join, FE polling, and event
 *     timelines. The `lobby_id` column mirrors the on-chain `u64` seed so
 *     every off-chain row can be resolved to its PDA at any time.
 *
 * State `mode='solo-bots'` is the bot-only carve-out — no on-chain lobby is
 * created, no players join, no escrow runs. It exists in this table purely
 * to give the FE / leaderboard a uniform handle on the activity match for
 * solo practice runs.
 */

// ─── Sequence for lobby_id ────────────────────────────────────────────────
//
// `lobby_id` is the on-chain seed `u64`. We back it with a Postgres sequence
// so concurrent creators never collide. The sequence is created in the
// migration file (drizzle-kit push does NOT emit `CREATE SEQUENCE` from
// Drizzle metadata alone — see drizzle/0007_wager_lobbies.sql).
//
// We use `bigint` with mode 'bigint' so consumers get a real JS bigint at
// runtime, matching the @clawville/wager-program PDA-helper signatures.

export const lobbies = pgTable(
  'lobbies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * On-chain `u64` seed for the Lobby/Vault/Player PDAs. Allocated by the
     * `wager_lobby_id_seq` sequence via `DEFAULT nextval(...)` (set in the
     * migration). Bigint mode because Postgres bigint -> JS Number loses
     * precision above 2^53.
     */
    lobbyId: bigint('lobby_id', { mode: 'bigint' })
      .notNull()
      .unique()
      .default(sql`nextval('wager_lobby_id_seq')`),
    /** Activity slug — e.g. 'bumper-shells', 'reef-race'. */
    activityId: text('activity_id').notNull(),
    /** Matches the `[roomId]` URL path param + activity_rooms.id when present. */
    roomId: text('room_id').notNull(),
    creatorUserId: uuid('creator_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    creatorAvatarId: uuid('creator_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** 0 ⇒ free lobby. Mirrors lobby.wager_amount on chain (lamports for SOL). */
    wagerAmountLamports: bigint('wager_amount_lamports', { mode: 'bigint' })
      .notNull()
      // `sql`0`` (not the `0n` BigInt literal) — identical `DEFAULT 0` DDL, but
      // drizzle-kit 0.24.2 can't JSON.stringify a BigInt into its diff snapshot,
      // which crashed `db:push`/`generate` repo-wide. See 2026-06-16 fix.
      .default(sql`0`),
    /**
     * `null` ⇒ SOL lobby. Future: base58 SPL mint pubkey.
     * The SPL write path is gated by a `FEATURE_GATE` in routes/wager.ts.
     */
    wagerMint: text('wager_mint'),
    /** Mirrors on-chain max_players (smallint; check 2..16). */
    maxPlayers: smallint('max_players').notNull(),
    /** Server-maintained mirror of on-chain lobby.joined_count. */
    joinedCount: smallint('joined_count').notNull().default(1),
    /** 'open' | 'locked' | 'settled' | 'cancelled'. Check constraint below. */
    state: text('state').notNull().default('open'),
    /** 'public' | 'private' | 'friends'. Private/friends require invite_code. */
    visibility: text('visibility').notNull().default('public'),
    /** ~12-char URL-safe code; nullable + unique-not-null (partial unique index). */
    inviteCode: text('invite_code'),
    /**
     * 'multiplayer' | 'solo-bots'. solo-bots bypasses escrow entirely; the
     * row exists only so the FE has a uniform lobby handle and the
     * leaderboard can credit the player for the activity result.
     */
    mode: text('mode').notNull().default('multiplayer'),
    settledWinnerUserId: uuid('settled_winner_user_id').references(
      () => users.id,
      { onDelete: 'set null' },
    ),
    settledWinnerAvatarId: uuid('settled_winner_avatar_id').references(
      () => avatars.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /**
     * Durable create-broadcast state. Existing/solo rows default confirmed;
     * multiplayer creates explicitly begin prepared and are hidden from public
     * discovery until the matching chain intent confirms and DB finalization
     * completes.
     */
    onChainCreateStatus: text('on_chain_create_status')
      .notNull()
      .default('confirmed'),
    onChainCreateSig: text('on_chain_create_sig'),
    onChainLockSig: text('on_chain_lock_sig'),
    onChainSettleSig: text('on_chain_settle_sig'),
    onChainCancelSig: text('on_chain_cancel_sig'),
  },
  (t) => ({
    stateActivityIdx: index('idx_lobbies_state_activity').on(t.state, t.activityId),
    inviteCodeIdx: uniqueIndex('idx_lobbies_invite_code_uniq')
      .on(t.inviteCode)
      .where(sql`invite_code IS NOT NULL`),
    roomIdIdx: index('idx_lobbies_room_id').on(t.roomId),
    activeMultiplayerRoomUniq: uniqueIndex(
      'idx_lobbies_active_multiplayer_room_uniq',
    )
      .on(t.activityId, t.roomId)
      .where(sql`mode = 'multiplayer' AND state IN ('open','locked')`),
    maxPlayersCheck: check(
      'lobbies_max_players_range',
      sql`max_players >= 2 AND max_players <= 16`,
    ),
    stateCheck: check(
      'lobbies_state_valid',
      sql`state IN ('open','locked','settled','cancelled')`,
    ),
    visibilityCheck: check(
      'lobbies_visibility_valid',
      sql`visibility IN ('public','private','friends')`,
    ),
    modeCheck: check(
      'lobbies_mode_valid',
      sql`mode IN ('multiplayer','solo-bots')`,
    ),
    /** A private/friends lobby MUST have an invite code. */
    inviteCodeRequiredCheck: check(
      'lobbies_invite_code_required',
      sql`visibility = 'public' OR invite_code IS NOT NULL`,
    ),
    /** Joined count must stay within roster bounds. */
    joinedCountCheck: check(
      'lobbies_joined_count_range',
      sql`joined_count >= 0 AND joined_count <= max_players`,
    ),
    createStatusCheck: check(
      'lobbies_on_chain_create_status_valid',
      sql`on_chain_create_status IN ('prepared','sending','confirmed','reconcile','failed')`,
    ),
  }),
);

export type Lobby = typeof lobbies.$inferSelect;
export type NewLobby = typeof lobbies.$inferInsert;

/**
 * Durable capture-before-send witness for wager broadcasts that move deposits.
 * The stable operation key makes create/join idempotent before chain I/O; the
 * signed transaction signature is committed while status='sending' before the
 * exact bytes are broadcast. `target_pda` is the deterministic Lobby or Player
 * PDA used by the forward-only reconciliation hook.
 */
export const wagerChainIntents = pgTable(
  'wager_chain_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operationKey: varchar('operation_key', { length: 200 }).notNull(),
    operation: text('operation').notNull(),
    lobbyId: uuid('lobby_id')
      .notNull()
      .references(() => lobbies.id, { onDelete: 'restrict' }),
    actorAvatarId: uuid('actor_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('prepared'),
    targetPda: text('target_pda').notNull(),
    txSignature: text('tx_signature'),
    blockhash: text('blockhash'),
    lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'bigint' }),
    /** Machine-safe phase/reason only; never bearer, key, or raw transaction data. */
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    operationKeyUniq: uniqueIndex('idx_wager_chain_intents_operation_key_uniq').on(
      t.operationKey,
    ),
    txSignatureUniq: uniqueIndex('idx_wager_chain_intents_tx_signature_uniq')
      .on(t.txSignature)
      .where(sql`tx_signature IS NOT NULL`),
    statusUpdatedIdx: index('idx_wager_chain_intents_status_updated').on(
      t.status,
      t.updatedAt,
    ),
    operationCheck: check(
      'wager_chain_intents_operation_valid',
      sql`operation IN ('create','join')`,
    ),
    statusCheck: check(
      'wager_chain_intents_status_valid',
      sql`status IN ('prepared','sending','confirmed','reconcile','failed')`,
    ),
    captureStateCheck: check(
      'wager_chain_intents_capture_state_valid',
      sql`(
        status IN ('prepared','failed')
        AND tx_signature IS NULL
        AND blockhash IS NULL
        AND last_valid_block_height IS NULL
      ) OR (
        status IN ('sending','confirmed','reconcile')
        AND tx_signature IS NOT NULL
        AND blockhash IS NOT NULL
        AND last_valid_block_height IS NOT NULL
      )`,
    ),
  }),
);

export type WagerChainIntent = typeof wagerChainIntents.$inferSelect;
export type NewWagerChainIntent = typeof wagerChainIntents.$inferInsert;

/**
 * Per-player deposit witness. One row per (lobby, user) — mirrors the
 * on-chain Player PDA. The `on_chain_join_sig` proves the deposit
 * actually settled on devnet before we mark them joined.
 */
export const lobbyPlayers = pgTable(
  'lobby_players',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** lobbies.id (UUID), NOT the on-chain bigint. */
    lobbyId: uuid('lobby_id')
      .notNull()
      .references(() => lobbies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** Snapshot of the on-chain wager_amount at the time of join, in lamports. */
    depositAmountLamports: bigint('deposit_amount_lamports', { mode: 'bigint' })
      .notNull(),
    depositedAt: timestamp('deposited_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    refunded: boolean('refunded').notNull().default(false),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    /** Required — proves the deposit landed on chain (or 'free-play' sentinel). */
    onChainJoinSig: text('on_chain_join_sig').notNull(),
    onChainRefundSig: text('on_chain_refund_sig'),
  },
  (t) => ({
    /** Mirrors on-chain Player PDA uniqueness. */
    userPerLobbyUniq: uniqueIndex('idx_lobby_players_lobby_user_uniq').on(
      t.lobbyId,
      t.userId,
    ),
    userIdx: index('idx_lobby_players_user').on(t.userId),
  }),
);

export type LobbyPlayer = typeof lobbyPlayers.$inferSelect;
export type NewLobbyPlayer = typeof lobbyPlayers.$inferInsert;

/**
 * Append-only timeline of lifecycle events for a lobby. Mirrors the on-chain
 * `LobbyCreated` / `LobbyJoined` / `LobbyLocked` / `LobbySettled` /
 * `LobbyCancelled` / `LobbyRefunded` Anchor events when available; also
 * carries `'cleanup'` for vault/player-PDA close txs we issue after settle.
 */
export const lobbyEvents = pgTable(
  'lobby_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lobbyId: uuid('lobby_id')
      .notNull()
      .references(() => lobbies.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    txSig: text('tx_sig'),
    /** Decoded Anchor event payload, when available. */
    rawEventJson: jsonb('raw_event_json'),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    lobbyOccurredIdx: index('idx_lobby_events_lobby_occurred').on(
      t.lobbyId,
      t.occurredAt.desc(),
    ),
    kindCheck: check(
      'lobby_events_kind_valid',
      sql`kind IN ('created','joined','locked','settled','cancelled','refunded','cleanup')`,
    ),
  }),
);

export type LobbyEvent = typeof lobbyEvents.$inferSelect;
export type NewLobbyEvent = typeof lobbyEvents.$inferInsert;

/**
 * Convenience: the on-chain state literal type, used by the API service +
 * FE component prop types. Keep in sync with the `lobbies_state_valid`
 * check constraint above.
 */
export type LobbyState = 'open' | 'locked' | 'settled' | 'cancelled';
export type LobbyVisibility = 'public' | 'private' | 'friends';
export type LobbyMode = 'multiplayer' | 'solo-bots';
export type LobbyEventKind =
  | 'created'
  | 'joined'
  | 'locked'
  | 'settled'
  | 'cancelled'
  | 'refunded'
  | 'cleanup';
