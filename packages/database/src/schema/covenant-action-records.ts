import {
  pgTable,
  bigserial,
  bigint,
  timestamp,
  text,
  uuid,
  jsonb,
  char,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Covenant action-record stream — the append-only, hash-chained record of every
 * economic agent-relevant action (founder directive 2026-07-13: "the agents'
 * actions should be managed with covenants").
 *
 * WRITE PATH: `apps/api/src/services/covenant-action-recorder.ts` — one insert
 * per action, in the SAME transaction as the business write wherever one exists
 * (record and action commit or roll back together). Producers:
 *   - `claw-token-ledger.ts` credit/debit primitives → `economy.credit` /
 *     `economy.debit` (complete vCLAW coverage: cove settles, shop buys, quest
 *     rewards, daily login, chat rewards, exchange, x402 on-ramp, EARNED mints).
 *   - quest lifecycle (`routes/quests.ts` + native ACCEPT_QUEST/SUBMIT_QUEST) →
 *     `quest.accept` / `quest.submit` / `quest.approve` / `quest.reject`.
 *   - bounty lifecycle (`routes/bounties.ts`, composition worker, payai-release)
 *     → `bounty.*` (the USDC legs never touch the vCLAW ledger).
 *
 * CHAIN: rows are inserted UNCHAINED (plain parallel inserts — chaining at write
 * time would put a global serialization point inside every money transaction).
 * The background sealer (`covenant-chain-sealer.ts`) assigns `chain_position` +
 * `prev_hash`/`record_hash` serially under one advisory lock, sealing rows older
 * than a 30s watermark in `seq` order. Chain order ≈ commit order; the sealed
 * chain is total, deterministic, and verifiable by walking positions. Batches in
 * `covenant_seal_batches` are what a future on-chain `anchor_receipt_batch`
 * anchors (see docs/covenant-utilization-audit-2026-07-03.md roadmap #2).
 *
 * TAMPER GUARD: migration 0028 installs a trigger forbidding DELETE and any
 * UPDATE that touches identity/payload columns (only the one-shot NULL→value
 * seal-column assignment is allowed). In-DB defense-in-depth; real
 * tamper-evidence lands with on-chain anchoring (later phase).
 *
 * READ PATH: `routes/partner-covenant.ts` `GET /actions` + `GET /actions/head`
 * (partner-signed + IP-allowlisted, GET-only).
 */
export const covenantActionRecords = pgTable(
  'covenant_action_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Arrival hint + the sealer's scan order. NOT the chain order authority —
     * bigserial values can commit out of order and roll back into gaps;
     * `chain_position` (sealer-assigned, gapless) is the canonical order.
     */
    seq: bigserial('seq', { mode: 'bigint' }),
    /** Namespaced verb, e.g. 'economy.credit', 'quest.approve', 'bounty.settle'. */
    action: text('action').notNull(),
    /** What the record is about: 'avatar' | 'treasury' | 'system'. */
    subjectType: text('subject_type').notNull(),
    /** The subject's id (avatar uuid for 'avatar'; free-form otherwise). */
    subjectId: text('subject_id').notNull(),
    /**
     * WHO performed the action when the call site knows: 'human' (Lucia cookie),
     * 'agent' (connected/hosted agent session), 'system' (sim/scheduled),
     * 'admin'. NULL = the choke point had no resolved identity (most raw ledger
     * calls) — never guessed.
     */
    actorKind: text('actor_kind'),
    /** Canonical action detail (amounts, ledgerId, questId, counterparty…). */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** sha256 hex of the canonical (sorted-key) JSON encoding of `payload`. */
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    /**
     * Business idempotency key for exactly-once actions driven by RETRYABLE
     * external legs (bounty settle/refund/create_failed — e.g.
     * `bounty:<id>:settle`). NULL for ordinary records. Partial unique index:
     * a retry's duplicate insert no-ops instead of double-recording.
     */
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),

    // ── seal columns — NULL until the sealer chains the row (one-shot write) ──
    /** Gapless canonical chain order, assigned serially by the sealer. */
    chainPosition: bigint('chain_position', { mode: 'bigint' }),
    /** record_hash of the previous chain position (64 zeros at genesis). */
    prevHash: char('prev_hash', { length: 64 }),
    /**
     * sha256 hex over the canonical seal encoding:
     * prev_hash‖payload_hash‖action‖subject_type‖subject_id‖chain_position‖created_at_iso
     * (NUL-separated). Walking positions 1..head recomputes the whole chain.
     */
    recordHash: char('record_hash', { length: 64 }),
    sealedAt: timestamp('sealed_at', { withTimezone: true }),
  },
  (t) => ({
    seqUnique: uniqueIndex('covenant_action_records_seq_unique').on(t.seq),
    chainPositionUnique: uniqueIndex('covenant_action_records_chain_position_unique').on(
      t.chainPosition,
    ),
    // Partial (WHERE dedupe_key IS NOT NULL) in the migration; drizzle models
    // the uniqueness — Postgres treats NULLs as distinct so plain records pass.
    dedupeKeyUnique: uniqueIndex('covenant_action_records_dedupe_key_unique').on(t.dedupeKey),
    // Partner reads: cursor by chain_position, filter by action / subject.
    idxAction: index('idx_covenant_records_action').on(t.action, t.chainPosition),
    idxSubject: index('idx_covenant_records_subject').on(t.subjectId, t.chainPosition),
    // Sealer scan: unsealed rows in seq order (partial index in the migration).
    idxCreatedAt: index('idx_covenant_records_created_at').on(t.createdAt),
  }),
);

/**
 * One row per sealer pass that chained ≥1 record. `batch_root` = the chain-head
 * `record_hash` after the batch — the value a future `anchor_receipt_batch`
 * merkle-anchors on-chain. `prev_batch_root` links batches into their own chain
 * so a verifier can audit seal history without walking every record.
 */
export const covenantSealBatches = pgTable(
  'covenant_seal_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firstPosition: bigint('first_position', { mode: 'bigint' }).notNull(),
    lastPosition: bigint('last_position', { mode: 'bigint' }).notNull(),
    recordCount: bigint('record_count', { mode: 'bigint' }).notNull(),
    batchRoot: char('batch_root', { length: 64 }).notNull(),
    prevBatchRoot: char('prev_batch_root', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lastPositionUnique: uniqueIndex('covenant_seal_batches_last_position_unique').on(
      t.lastPosition,
    ),
  }),
);
