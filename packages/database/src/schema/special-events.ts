/**
 * Special Events (2026-06-16) — the GENERIC, REUSABLE PARENT layer for ANY
 * one-time event in ClawVille (a poker championship today; future event types
 * — a season-launch festival, a tournament-of-tournaments, a sponsored arena
 * night — tomorrow).
 *
 * ── DEPENDENCY DIRECTION (CRITICAL) ──────────────────────────────────────────
 * `special_events` is the PARENT. The poker tournament is a SUBTABLE/DEPENDENCY
 * that hangs OFF the event — the FK points UP:
 *
 *     poker_tournaments.special_event_id → special_events.id   (in `poker.ts`)
 *
 * NOT the other way around. `special_events` carries NO `poker_tournament_id`
 * column — that would couple the generic parent to one specific event-content
 * type. Instead each event-content type adds its OWN subtable referencing this
 * parent (poker is just the first). An event has 0..N poker tournaments as
 * dependents (exactly 1 for the launch poker event). This keeps the parent
 * reusable: adding a new event type never touches this table.
 *
 * ── GATE MODEL (FLEXIBLE — all fields nullable) ──────────────────────────────
 * Entry is gated by a SET of optional conditions evaluated server-side at
 * signup (`special-event-manager.ts evaluateGate`). The columns express the
 * config, not the runtime decision:
 *   - ALL gate_* null                     → FREE entry (anyone signs up).
 *   - gate_hold_mint + gate_hold_bps set  → TOKEN-HOLD gate: the subject's
 *     chosen wallet must hold ≥ (gate_hold_bps / 10000 × token supply) of the
 *     mint. When met, entry is FREE (the hold IS the ticket); the holding is
 *     snapshotted into the signup's `entry_proof_json`.
 *   - gate_sol_lamports set                → SOL fallback: pay this many lamports
 *     to the treasury (verified on-chain) when the hold gate is unmet/unused.
 *   - gate_ct set                          → CT fallback: debit this many atomic
 *     ClawTokens via the ledger when the hold gate is unmet/unused.
 * The hold-gate is ONLY invoked when `gate_hold_mint` is non-null. With a hold
 * gate configured AND a fallback (sol/ct) configured, a subject that does not
 * meet the hold threshold must satisfy the fallback to enter.
 *
 * ── MONEY (no new ledger path) ───────────────────────────────────────────────
 * Entry settlement at the EVENT layer is one of: nothing (free/hold), a verified
 * SOL transfer to the treasury, or a CT debit via `claw-token-ledger`. The event
 * funds the dependent poker tournament's PRIZE POOL directly (the tournament is
 * created in PREPAID mode with `seedPrizePoolCt`, debited from the HOUSE TREASURY
 * in the tournament-create tx since security M3, 2026-09-30), so the per-entrant
 * tournament buy-in debit is SKIPPED — entry was already settled here. CT amounts are
 * TEXT-stringified atomic integers (mirroring poker.ts / cove-events.ts); SOL is
 * a stringified lamport bigint.
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
 * A venue/structure config hook. The 3D / in-world structure is the USER's to
 * build later — this column ONLY stores its config (a nullable opaque jsonb).
 * No 3D, no temp-structure code, no web rendering lives here. Shape is
 * intentionally open (`Record<string, unknown>`) so the user can fill it in
 * without a schema migration.
 */
export type VenueConfig = Record<string, unknown>;

/**
 * Prize config the event manager reads to fund + lay out the dependent
 * tournament's prizes. Open-shaped (the manager owns the contract); a typical
 * shape is `{ seedPrizePoolCt: string, payoutCurve?: PayoutCurveEntry[] }`.
 */
export type PrizeConfig = Record<string, unknown>;

export const specialEvents = pgTable(
  'special_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** URL-safe stable handle (the public lookup key). Unique. */
    slug: text('slug').notNull(),
    /** Display name. */
    name: text('name').notNull(),
    /** Optional long description / marketing copy. */
    description: text('description'),
    /**
     * The EVENT-CONTENT type. Extensible — 'poker_tournament' today; future
     * event types add their own value + their own dependent subtable. This does
     * NOT couple the parent to poker; it only tags what KIND of event this is.
     */
    kind: text('kind').notNull().default('poker_tournament'),
    /**
     * Lifecycle:
     *   'draft'        → created, not yet open for signups
     *   'signup_open'  → accepting signups (gate-evaluated)
     *   'starting'     → a start claimed the event (signups closed) and is creating
     *                    + seating the dependent tournament; → 'live' on success,
     *                    back to 'signup_open' on failure (security M4, 2026-09-30)
     *   'live'         → signups closed, the dependent tournament(s) seated + running
     *   'completed'    → settled (prizes paid from the linked tournament results)
     *   'cancelled'    → called off
     */
    status: text('status').notNull().default('draft'),

    // ── Gate config (all nullable — see header GATE MODEL) ──────────────────────
    /** Token-hold gate mint (base58). Null ⇒ no hold gate. */
    gateHoldMint: text('gate_hold_mint'),
    /** Hold threshold in basis points of total supply (1..10000). Null ⇒ no hold gate. */
    gateHoldBps: integer('gate_hold_bps'),
    /** SOL fallback price in lamports (stringified bigint). Null ⇒ no SOL fallback. */
    gateSolLamports: text('gate_sol_lamports'),
    /** CT fallback price in atomic ClawTokens. Null ⇒ no CT fallback. */
    gateCt: integer('gate_ct'),

    // ── Config hooks (USER-FILLED — NOT built here) ─────────────────────────────
    /**
     * The in-world venue/structure config. A USER-FILLED hook — the 3D structure
     * is built later by the user; this column only carries its config. Shape =
     * VenueConfig (open). Null until the user configures a venue.
     */
    venueConfigJson: jsonb('venue_config_json'),
    /** Prize layout/funding config the event manager reads. Shape = PrizeConfig. */
    prizeConfigJson: jsonb('prize_config_json'),

    /** Hard cap on participants (signups). Null ⇒ uncapped at the event layer. */
    maxParticipants: integer('max_participants'),

    // ── Scheduling (all nullable — manual control by default) ───────────────────
    registrationOpensAt: timestamp('registration_opens_at', { withTimezone: true }),
    registrationClosesAt: timestamp('registration_closes_at', { withTimezone: true }),
    startsAt: timestamp('starts_at', { withTimezone: true }),

    /**
     * AUDIT — the avatar of the operator who created this event. Nullable (a
     * dash-cookie admin path or a system/boot create has no avatar) + FK `set null`
     * so a deleted creator never cascades the event away.
     */
    createdBy: uuid('created_by').references(() => avatars.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When signups closed + the dependent tournament(s) seated (status → live). */
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** When the event settled (status → completed). */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * The in-flight start's claim (security M4, 2026-09-30): set with status
     * 'starting' and cleared by every exit from it. Every write of that start
     * CASes on the token; a claim older than SPECIAL_EVENT_START_CLAIM_STALE_MS
     * belongs to a crashed start and is reconciled (special-event-manager.ts).
     */
    startClaimId: uuid('start_claim_id'),
    startClaimedAt: timestamp('start_claimed_at', { withTimezone: true }),
  },
  (table) => ({
    slugUnique: uniqueIndex('special_events_slug_unique').on(table.slug),
    statusIdx: index('special_events_status_idx').on(table.status),
    statusCheck: check(
      'special_events_status_check',
      sql`status in ('draft','signup_open','starting','live','completed','cancelled')`,
    ),
    // gate_hold_bps, when present, is a basis-points fraction of supply (1..10000).
    gateHoldBpsCheck: check(
      'special_events_gate_hold_bps_check',
      sql`gate_hold_bps IS NULL OR (gate_hold_bps >= 1 AND gate_hold_bps <= 10000)`,
    ),
    gateCtCheck: check(
      'special_events_gate_ct_check',
      sql`gate_ct IS NULL OR gate_ct >= 0`,
    ),
    maxParticipantsCheck: check(
      'special_events_max_participants_check',
      sql`max_participants IS NULL OR max_participants >= 1`,
    ),
  }),
);

export const specialEventSignups = pgTable(
  'special_event_signups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => specialEvents.id, { onDelete: 'cascade' }),
    /** Lucia user id for a human signup; null for an agent playing as itself. */
    userId: uuid('user_id'),
    /** The subject's avatar — the ledger + leaderboard + tournament-entrant subject. */
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** OpenClaw agent string id when an agent signed up AS ITSELF; null for a human. */
    agentId: text('agent_id'),
    /** 'human' | 'agent' (NEVER guest — an economy gate has no guest tier). */
    subjectType: text('subject_type').notNull(),
    /** How entry was satisfied: 'free' | 'hold' | 'sol' | 'ct'. */
    entryMethod: text('entry_method').notNull(),
    /** Which wallet was used for an on-chain gate (hold/sol). 'external' | 'custodial' | null. */
    walletUsed: text('wallet_used'),
    /**
     * Proof/snapshot of how entry was satisfied. Shape depends on entryMethod:
     *   'hold' → { mint, walletPubkey, balance, supply, thresholdBps, requiredAtomic }
     *   'sol'  → { txSig, lamports, fromPubkey?, toPubkey, payerPubkey? }
     *            (`fromPubkey` is the CLIENT-CLAIMED wallet and is never trusted;
     *            `payerPubkey`, written since 2026-10-03, is the sender PROVEN by
     *            the on-chain verification — the SOL refund destination)
     *   'ct'   → { amountCt, ledgerId }
     *   'free' → {} / null
     */
    entryProofJson: jsonb('entry_proof_json'),
    /**
     * 'pending'   → row created, entry not yet verified
     * 'confirmed' → entry verified/settled (the subject IS in the event)
     * 'refunded'  → event cancelled / entry reversed
     */
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (table) => ({
    // One signup per (event, avatar) — idempotency anchor for signup.
    eventAvatarUnique: uniqueIndex('special_event_signups_event_avatar_unique').on(
      table.eventId,
      table.avatarId,
    ),
    /**
     * GLOBAL single-use of a SOL tx-sig — the race-proof replay backstop.
     * The treasury is ONE shared pubkey across EVERY SOL-gated event, so a single
     * on-chain payment could otherwise satisfy entry to multiple concurrent
     * SOL-gated events (pay once, enter every live SOL event for free). The in-tx
     * SELECT-then-INSERT guard in `signup()` is NOT race-proof here: two concurrent
     * signups for DIFFERENT events lock different `special_events` rows and never
     * serialize, so two valid SOL signups for the same sig could interleave past the
     * SELECT. This partial unique index makes the second INSERT fail at the DB level
     * regardless of event, closing the cross-event gate-bypass. Partial (not full)
     * so non-SOL methods (free/hold/ct, which carry no txSig) and refunded rows are
     * exempt, and so the index covers ONLY rows where `txSig` is meaningful.
     */
    solTxSigGlobalUnique: uniqueIndex('special_event_signups_sol_txsig_global_unique')
      .on(sql`(entry_proof_json->>'txSig')`)
      .where(sql`entry_method = 'sol' AND status <> 'refunded'`),
    eventIdx: index('special_event_signups_event_idx').on(table.eventId),
    subjectTypeCheck: check(
      'special_event_signups_subject_type_check',
      sql`subject_type in ('human','agent')`,
    ),
    entryMethodCheck: check(
      'special_event_signups_entry_method_check',
      sql`entry_method in ('free','hold','sol','ct')`,
    ),
    walletUsedCheck: check(
      'special_event_signups_wallet_used_check',
      sql`wallet_used IS NULL OR wallet_used in ('external','custodial')`,
    ),
    statusCheck: check(
      'special_event_signups_status_check',
      sql`status in ('pending','confirmed','refunded')`,
    ),
  }),
);

/**
 * SOL entry refunds owed by a cancelled event (2026-10-03, migration 0076).
 *
 * `cancelEvent` writes ONE row per SOL signup (UNIQUE `signup_id`) in the same
 * transaction as the event's `cancelled` CAS, so a cancelled event can never
 * leave a SOL payment without a durable record. The SOL signup row itself stays
 * 'confirmed' so its entry tx sig stays reserved by
 * `special_event_signups_sol_txsig_global_unique` (a 'refunded' signup would
 * free that sig for reuse as another entry).
 *
 *   'owed'     → the treasury still owes `lamports` to `destination_pubkey`
 *   'refunded' → a named admin recorded the payout (`refund_tx_sig`, verified on
 *                chain to pay ≥ `lamports` to `destination_pubkey`, with System
 *                transfers FROM `receiving_pubkey` TO it summing to ≥ `lamports`)
 *
 * `receiving_pubkey` is the wallet that received the entry (the treasury); the
 * payout must come from it (Codex r2). `destination_pubkey` is the single source
 * whose OWN System transfers into the receiving wallet cover the full credited
 * entry (Codex r2), never the client-claimed wallet. It is null when the chain
 * proves no such source; mark-paid re-verifies the entry tx, or a named admin
 * sets it once (`destination_set_by` / `destination_set_at`; both null for a
 * chain-proven destination). `refund_tx_sig` is globally unique: one on-chain
 * payout settles one refund. No FK on `signup_id` / `avatar_id`: the obligation
 * must outlive an avatar delete (the signup row cascades with its avatar).
 */
export const specialEventSolRefunds = pgTable(
  'special_event_sol_refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => specialEvents.id),
    signupId: uuid('signup_id').notNull(),
    /** The paying signup's avatar (human or agent), for audit. */
    avatarId: uuid('avatar_id').notNull(),
    /** The verified entry payment signature. */
    entryTxSig: text('entry_tx_sig').notNull(),
    /** Lamports owed back (stringified bigint) = the verified entry amount. */
    lamports: text('lamports').notNull(),
    /** The wallet that received the entry (base58); the refund must come FROM it. */
    receivingPubkey: text('receiving_pubkey').notNull(),
    /** Proven (or admin-set) entry sender (base58); the only allowed refund destination. */
    destinationPubkey: text('destination_pubkey'),
    /** Lucia user id of the named admin who set the destination by hand (null = chain-proven). */
    destinationSetBy: uuid('destination_set_by'),
    destinationSetAt: timestamp('destination_set_at', { withTimezone: true }),
    status: text('status').notNull().default('owed'),
    refundTxSig: text('refund_tx_sig'),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    /** Lucia user id of the named admin who recorded the payout. */
    refundedBy: uuid('refunded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    signupUnique: uniqueIndex('special_event_sol_refunds_signup_unique').on(table.signupId),
    refundTxUnique: uniqueIndex('special_event_sol_refunds_refund_tx_unique')
      .on(table.refundTxSig)
      .where(sql`refund_tx_sig IS NOT NULL`),
    eventIdx: index('special_event_sol_refunds_event_idx').on(table.eventId),
    statusCheck: check(
      'special_event_sol_refunds_status_check',
      sql`status in ('owed','refunded')`,
    ),
    paidCheck: check(
      'special_event_sol_refunds_paid_check',
      sql`status = 'owed' OR (refund_tx_sig IS NOT NULL AND refunded_at IS NOT NULL AND destination_pubkey IS NOT NULL)`,
    ),
  }),
);

/**
 * Every transaction signature a special event consumed (2026-10-03, Codex r2,
 * migration 0076): a SOL entry ('entry') or a SOL refund payout ('refund').
 * PRIMARY KEY `tx_sig`: the signup and the refund mark-paid paths insert into it
 * in the same transaction as their own write, so one signature can never serve
 * as both an entry and a refund, even when two requests race.
 */
export const specialEventUsedTxSigs = pgTable(
  'special_event_used_tx_sigs',
  {
    txSig: text('tx_sig').primaryKey(),
    /** 'entry' | 'refund'. */
    useKind: text('use_kind').notNull(),
    /** The signup the signature paid for (entry) or refunded (refund). */
    signupId: uuid('signup_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => ({
    useKindCheck: check(
      'special_event_used_tx_sigs_use_kind_check',
      sql`use_kind in ('entry','refund')`,
    ),
  }),
);

// ── $inferSelect / $inferInsert exports (mirror poker.ts style) ───────────────

export type SpecialEvent = typeof specialEvents.$inferSelect;
export type NewSpecialEvent = typeof specialEvents.$inferInsert;
export type SpecialEventSignup = typeof specialEventSignups.$inferSelect;
export type NewSpecialEventSignup = typeof specialEventSignups.$inferInsert;
export type SpecialEventSolRefund = typeof specialEventSolRefunds.$inferSelect;
export type NewSpecialEventSolRefund = typeof specialEventSolRefunds.$inferInsert;
export type SpecialEventUsedTxSig = typeof specialEventUsedTxSigs.$inferSelect;
