/**
 * SAP Option C — on-chain USDC escrow gate: backend settlement ledger.
 *
 * The single durable record that makes the verify-before-release gate SAFE.
 * Option C enforces "verify, THEN settle" in ClawVille's orchestration on the
 * PROVEN OOBE SelfReport USDC settle (the deployed program has NO on-chain
 * settlement-receipt anti-replay — see `oobe-usdc-selfreport-spec.md`). So the
 * anti-double-release invariant lives HERE, in this table, not on-chain.
 *
 * ── Money-load-bearing invariant (the whole reason this table exists) ─────────
 * A `settle_calls` (which RELEASES USDC from the escrow vault to the worker
 * agent's USDC ATA) must fire AT MOST ONCE per logical job. We key the unique
 * index on the on-chain `escrow_pda` + the off-chain `job_id` so that:
 *   - a retried settle for the SAME (escrow, job) trips the unique index and is
 *     served as the cached prior result — it NEVER re-releases funds;
 *   - the check-then-settle is made atomic by INSERTing the `settling` claim row
 *     INSIDE a DB transaction and letting the unique index be the lock: the
 *     SECOND concurrent settle that loses the INSERT race gets a unique-violation
 *     and bails WITHOUT touching the chain.
 *
 * The on-chain `service_hash` (32 bytes) carried into `settle_calls` is the
 * verification provider's `auditRoot` — we persist it here too (`audit_root_hex`)
 * so the on-chain release is provably bound to a verified work record. The
 * `verification_passed` + `verification_provider` + `verification_detail` columns
 * record WHY the release was authorized (or why it was refused).
 *
 * PURELY ADDITIVE: one new enum + one new table, no change to any existing
 * table, so `db:push` is a clean CREATE (no destructive ALTER/DROP). Gated OFF
 * by default at the route/service layer (`SAP_ESCROW_ENABLED=false`,
 * `SAP_DRY_RUN=true`), so no row is ever written until a deliberate flip-to-live.
 *
 * ── Rule E5 parity seam ───────────────────────────────────────────────────────
 * `depositor_avatar_id` / `worker_avatar_id` bind to `avatars.id`, which is what
 * BOTH a Lucia-authed human AND a connected/hosted agent session resolve to via
 * `requireAuthOrAgentSession` → `identity.avatarId`. The depositor (requester)
 * and the worker (settler) each act AS THEMSELVES — there is no human-XOR-guest
 * column and no agent-locked-out path.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';

/**
 * Settlement lifecycle for one (escrow, job).
 *
 *   open       — escrow opened (deposit funded); job not yet submitted/verified.
 *   submitted  — worker submitted the deliverable; verification not yet run.
 *   settling   — the atomic claim: a settle is IN FLIGHT for this (escrow, job).
 *                The unique index on (escrow_pda, job_id) makes the INSERT of
 *                this state the lock — a concurrent second settle loses the race.
 *   settled    — the on-chain (or dry-run) settle returned; funds released. The
 *                `settle_signature` / `dry_run` columns record the outcome.
 *   refunding  — the atomic refund claim: a withdraw is IN FLIGHT (BLOCKING #4 fix).
 *                Claimed from `open|submitted` BEFORE any chain send so a refund
 *                and a settle can never both broadcast against the same escrow.
 *   refunded   — escrow withdrawn back to depositor (cancel / expiry / verify-fail).
 *   failed     — the settle attempt errored AFTER claiming `settling`; the row is
 *                left in `failed` so a human can inspect (it does NOT auto-retry,
 *                because a chain send whose confirmation we never saw may have
 *                landed — re-releasing would double-pay).
 *   funding_unknown — (BLOCKING #5 fix) an OPEN broadcast (create/top-up) landed
 *                on the wire but we never observed its confirmation (timeout / RPC
 *                drop). The row is NOT deleted (deleting would free the (escrow,
 *                job) slot → a retry could DOUBLE-FUND, and would orphan any USDC
 *                that actually landed in the vault). A human/reconciler must poll
 *                the broadcast signature / on-chain escrow account before the slot
 *                is reused. Terminal-but-recoverable; never auto-settled.
 */
export const sapEscrowSettlementStatusEnum = pgEnum('sap_escrow_settlement_status', [
  'open',
  'submitted',
  'settling',
  'settled',
  'refunding',
  'refunded',
  'failed',
  'funding_unknown',
]);

/**
 * sap_escrow_settlements — one row per (escrow, job). The `(escrow_pda, job_id)`
 * unique index is the at-most-once-settle guard that replaces the on-chain
 * receipt the deployed 0.18.0 program lacks.
 */
export const sapEscrowSettlements = pgTable(
  'sap_escrow_settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // ── identity of the escrow + job (the idempotency key) ──
    /**
     * The on-chain escrow PDA (base58) = `["sap_escrow", agentPda, depositor]`.
     * One escrow per (agent, depositor) pair (NO nonce in the V1 USDC path), so
     * a second job for the same pair TOPS UP the same escrow — and is
     * disambiguated from the first job by `job_id`, not by a new escrow.
     */
    escrowPda: varchar('escrow_pda', { length: 64 }).notNull(),
    /**
     * Off-chain job identifier (caller-supplied, namespaced by the use case,
     * e.g. an AI↔AI bounty id). Combined with `escrow_pda` it is the UNIQUE
     * at-most-once-settle key. Required (never null) so the unique index always
     * binds.
     */
    jobId: varchar('job_id', { length: 128 }).notNull(),

    // ── the two parties (Rule E5 parity — both are avatars) ──
    /** The requester/depositor avatar — funds the escrow, approves, can refund. */
    depositorAvatarId: uuid('depositor_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** The worker/service avatar — does the work, receives the release on settle. */
    workerAvatarId: uuid('worker_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),

    // ── on-chain coordinates (base58; recorded for audit + idempotent re-derive) ──
    /** Worker's registered wallet pubkey (= the agent PDA seed + the settle signer). */
    workerWalletPubkey: varchar('worker_wallet_pubkey', { length: 64 }).notNull(),
    /** Depositor's wallet pubkey (= the escrow PDA seed component). */
    depositorWalletPubkey: varchar('depositor_wallet_pubkey', { length: 64 }).notNull(),
    /** Payment mint (base58). USDC for the Option C path; recorded for audit. */
    tokenMint: varchar('token_mint', { length: 64 }).notNull(),

    // ── economics (string-encoded u64 base units; USDC = 6 decimals) ──
    /** Price per call in token base units (u64 as a decimal string). */
    pricePerCall: varchar('price_per_call', { length: 32 }).notNull(),
    /**
     * The job's authorized call ceiling (u64 string). Recorded at OPEN so the
     * settle path can clamp `callsToSettle` server-side (BLOCKING #2 fix) — a
     * settle may release AT MOST `maxCalls - callsSettled` for this job. The
     * worker-supplied `callsToSettle` is never trusted past this bound.
     */
    maxCalls: varchar('max_calls', { length: 32 }),
    /**
     * The USDC this job funded into the SHARED per-(agent,depositor) vault (u64
     * string). The escrow PDA has NO nonce, so many jobs share one vault; this is
     * the per-job funded portion that the cross-job accounting invariant
     * (BLOCKING #3 fix) enforces releases against: sum of a job's releases may
     * never exceed its own `funded_amount`, and the escrow-wide
     * sum(released)+sum(refunded) may never exceed sum(funded).
     */
    fundedAmount: varchar('funded_amount', { length: 32 }),
    /** Number of calls released on the settle so far (u64 as a decimal string). */
    callsSettled: varchar('calls_settled', { length: 32 }),
    /**
     * USDC base units actually released to the worker for THIS job (u64 string;
     * pricePerCall × callsSettled). The per-job + escrow-wide accounting ledger
     * reads this to enforce sum(released)+sum(refunded) ≤ sum(funded). NULL until
     * a settle releases.
     */
    releasedAmount: varchar('released_amount', { length: 32 }),
    /**
     * USDC base units refunded to the depositor for THIS job (u64 string). Counts
     * toward the escrow-wide sum(released)+sum(refunded) ≤ sum(funded) invariant.
     * NULL until a refund withdraws.
     */
    refundedAmount: varchar('refunded_amount', { length: 32 }),

    // ── verification provenance (WHY the release was authorized) ──
    /** Provider that produced the verdict (e.g. 'requester-approval', 'covenant'). */
    verificationProvider: varchar('verification_provider', { length: 64 }),
    /** The verdict — true authorizes a settle; false/null NEVER settles. */
    verificationPassed: boolean('verification_passed'),
    /**
     * 32-byte audit root (hex, no 0x) from the verification provider, bound into
     * the on-chain `service_hash`. The on-chain release is provably tied to this.
     */
    auditRootHex: varchar('audit_root_hex', { length: 64 }),
    /** Optional human-readable verification detail (provider note). */
    verificationDetail: text('verification_detail'),

    // ── settle outcome ──
    status: sapEscrowSettlementStatusEnum('status').notNull().default('open'),
    /**
     * The confirmed settle tx signature (base58) when a LIVE send landed. NULL
     * for a dry-run settle (simulate only) or an un-settled row.
     */
    settleSignature: varchar('settle_signature', { length: 128 }),
    /**
     * The broadcast signature of an OPEN (create/top-up) tx whose confirmation we
     * never observed (BLOCKING #5 fix). Persisted with `status='funding_unknown'`
     * so a reconciler can poll the chain before the (escrow, job) slot is reused.
     * NULL on a clean confirmed open or a dry-run.
     */
    fundingSignature: varchar('funding_signature', { length: 128 }),
    /** True when the settle was a dry-run (simulate only, NEVER broadcast). */
    dryRun: boolean('dry_run').notNull().default(true),

    /** Free-form provenance (sim logs digest, provider payload hash, etc.). */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => ({
    /**
     * THE at-most-once-settle guard. (escrow_pda, job_id) is unique — the INSERT
     * of the `settling` claim under a DB transaction is the lock that prevents a
     * concurrent OR retried second on-chain release for the same logical job.
     */
    escrowJobUnique: uniqueIndex('sap_escrow_settlements_escrow_job_unique').on(
      t.escrowPda,
      t.jobId,
    ),
    /** "all settlements for this escrow" + lifecycle scans. */
    escrowIdx: index('sap_escrow_settlements_escrow_idx').on(t.escrowPda, t.createdAt),
    /** Per-avatar history (depositor + worker dashboards). */
    depositorIdx: index('sap_escrow_settlements_depositor_idx').on(
      t.depositorAvatarId,
      t.createdAt,
    ),
    workerIdx: index('sap_escrow_settlements_worker_idx').on(
      t.workerAvatarId,
      t.createdAt,
    ),
    statusIdx: index('sap_escrow_settlements_status_idx').on(t.status, t.createdAt),
  }),
);

export type SapEscrowSettlement = typeof sapEscrowSettlements.$inferSelect;
export type NewSapEscrowSettlement = typeof sapEscrowSettlements.$inferInsert;

/**
 * sap_escrow_approvals — the PERSISTED, AUTHENTICATED depositor approval that
 * gates a settle (BLOCKING #1 fix).
 *
 * BEFORE this table, `/escrow/usdc/settle` trusted a request-body `approval`
 * object supplied by the WORKER (the very party who profits from the release),
 * so a worker could fabricate `{approved:true, approverAvatarId:<depositor>}` and
 * self-release the whole vault. Now the depositor (and ONLY the depositor) writes
 * this row via `POST /escrow/usdc/approve` (identity.avatarId asserted ===
 * depositorAvatarId on that row's escrow/job), and `settleJob` READS this row to
 * build the verification signal SERVER-SIDE — never from the caller's body.
 *
 * The row binds the FULL release intent: (escrow_pda, job_id, depositor, worker,
 * approvedCalls). The verification audit root is derived from a CANONICAL
 * encoding of this persisted tuple, so the on-chain `service_hash` is provably
 * bound to a real depositor approval, not a forged one.
 *
 * PURELY ADDITIVE: a second new table, no change to any existing one — db:push is
 * a clean CREATE. Gated OFF with the rest of the Option C path.
 */
export const sapEscrowApprovals = pgTable(
  'sap_escrow_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** The on-chain escrow PDA this approval authorizes a release from. */
    escrowPda: varchar('escrow_pda', { length: 64 }).notNull(),
    /** The off-chain job id (the (escrow, job) approval key's job half). */
    jobId: varchar('job_id', { length: 128 }).notNull(),

    /**
     * The depositor (requester) avatar who approved. The route asserts
     * `identity.avatarId === settlement.depositorAvatarId` before writing, so this
     * is always the authenticated funds-owner — never a worker-forged value.
     */
    approverAvatarId: uuid('approver_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** The worker the approval authorizes a release TO (bound for provenance). */
    workerAvatarId: uuid('worker_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),

    /**
     * The number of calls the depositor approved for release (u64 string). The
     * settle path clamps `callsToSettle` to AT MOST this (in addition to the
     * maxCalls / vault-balance bounds). NULL ⇒ approve the job's full `maxCalls`.
     */
    approvedCalls: varchar('approved_calls', { length: 32 }),

    approvedAt: timestamp('approved_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * One approval per (escrow, job). A re-approve UPSERTs (ON CONFLICT) rather
     * than stacking rows, so the settle path reads exactly one authoritative
     * approval. Matching the settlement's (escrow_pda, job_id) key.
     */
    escrowJobUnique: uniqueIndex('sap_escrow_approvals_escrow_job_unique').on(
      t.escrowPda,
      t.jobId,
    ),
    approverIdx: index('sap_escrow_approvals_approver_idx').on(
      t.approverAvatarId,
      t.approvedAt,
    ),
  }),
);

export type SapEscrowApproval = typeof sapEscrowApprovals.$inferSelect;
export type NewSapEscrowApproval = typeof sapEscrowApprovals.$inferInsert;
