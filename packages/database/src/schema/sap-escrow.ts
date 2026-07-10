/**
 * SAP Option C — on-chain USDC escrow gate: backend settlement ledger.
 *
 * The single durable record that makes the verify-before-release gate SAFE.
 * Option C enforces "verify, THEN settle" in ClawVille's orchestration on the
 * PROVEN OOBE SelfReport USDC settle (the deployed program has NO on-chain
 * settlement-receipt anti-replay — see `oobe-usdc-selfreport-spec.md`). So the
 * anti-double-release invariant lives HERE, in this table, not on-chain.
 * V2 adds an authoritative on-chain PendingSettlement replay guard; this ledger
 * still supplies the authorization, atomic broadcast claim, accounting, and
 * broadcast-unknown reconciliation state around that chain guard.
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
 *   settled    — terminal release: V1 settle or V2 finalize confirmed (or
 *                completed its honest dry-run equivalent).
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
 *   pending    — V2 settle confirmed: the fee leg was charged and a per-index
 *                PendingSettlement PDA reserves principal for later finalize.
 *   settle_unknown — V2 settle broadcast but confirmation is unknown. Reconcile
 *                only: retrying may double-charge the fee or trip chain replay.
 *   finalizing — atomic V2 permissionless-finalize claim; prevents two cranks
 *                from broadcasting the same principal release concurrently.
 *   finalize_unknown — V2 finalize broadcast but confirmation is unknown.
 *                Principal may have moved; reconcile only, never auto-retry.
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
  'pending',
  'settle_unknown',
  'finalizing',
  'finalize_unknown',
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
     * The on-chain escrow PDA (base58). V1 uses
     * `["sap_escrow", agentPda, depositor]`; V2 uses nonce'd
     * `["sap_escrow_v2", agentPda, depositor, escrowNonce]` seeds.
     */
    escrowPda: varchar('escrow_pda', { length: 64 }).notNull(),
    /** Wire generation for this row; V1 remains the default for old writers. */
    escrowVersion: varchar('escrow_version', { length: 8 }).notNull().default('v1'),
    /** V2's explicit u64 nonce; NULL for the nonce-less V1 shared vault. */
    escrowNonce: varchar('escrow_nonce', { length: 32 }),
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
     * The USDC this job funded into its escrow vault (u64 string). V1 escrows are
     * shared per (agent,depositor); V2 escrows are nonce'd. This is the per-job
     * funded portion that the cross-job accounting invariant
     * (BLOCKING #3 fix) enforces releases against: sum of a job's releases may
     * never exceed its own `funded_amount`, and the escrow-wide
     * sum(released)+sum(refunded) may never exceed sum(funded).
     */
    fundedAmount: varchar('funded_amount', { length: 32 }),
    /** Number of calls released on the settle so far (u64 as a decimal string). */
    callsSettled: varchar('calls_settled', { length: 32 }),
    /**
     * USDC base units actually released to the worker for THIS job (u64 string).
     * For V2 this remains NULL while principal is reserved in `pending` and is
     * booked only after finalize confirms. The per-job + escrow-wide accounting
     * ledger reads this to enforce sum(released)+sum(refunded) ≤ sum(funded).
     */
    releasedAmount: varchar('released_amount', { length: 32 }),
    /**
     * V2 principal reserved by a confirmed settle but not yet released by
     * finalize. Moved into `released_amount` only after finalize confirms.
     */
    reservedPrincipalAmount: varchar('reserved_principal_amount', { length: 32 }),
    /**
     * V2 protocol fee charged during settle (a separate money leg from
     * principal). NULL for V1 and before V2 settle confirms.
     */
    feeAmount: varchar('fee_amount', { length: 32 }),
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
     * Settle tx signature (base58) from a LIVE send: confirmed on `settled`/V2
     * `pending`, or the reconciliation anchor on V2 `settle_unknown`. NULL for
     * dry-run simulation and before a live settle broadcasts.
     */
    settleSignature: varchar('settle_signature', { length: 128 }),
    /** V2 pre-increment index that seeds the PendingSettlement PDA. */
    settlementIndex: varchar('settlement_index', { length: 32 }),
    /** Confirmed or broadcast-unknown V2 finalize signature. */
    finalizeSignature: varchar('finalize_signature', { length: 128 }),
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

/**
 * sap_deposit_requests — R3 DEPOSIT IDEMPOTENCY (flip-gate fix, doc line 591).
 *
 * `deposit_escrow_v2` is ADDITIVE: a duplicate client POST (double-click / 5xx
 * retry) would top up the depositor's OWN escrow twice. `executeTx`'s
 * broadcast/confirm split stops an SDK auto-resend but NOT a fresh duplicate
 * request. This table is the durable route-level idempotency guard on
 * `POST /api/sap/escrow/v2/deposit`.
 *
 * ── Key shape (deliberate deviation from the doc's `(subject, escrowNonce,
 *    requestId)`) ──────────────────────────────────────────────────────────────
 * The doc suggested keying on `escrowNonce`, but a nonce alone does NOT identify
 * an escrow — the V2 PDA is `["sap_escrow_v2", agentPda(worker), depositor,
 * nonce]`, so the SAME nonce can address two different escrows against two
 * different workers. We use STANDARD STRICT idempotency instead:
 *   - UNIQUE (subject_avatar_id, request_id) is the idempotency key.
 *   - (escrow_pda, amount) is the request FINGERPRINT stored alongside it.
 *     A replay with the same key + same fingerprint returns the recorded outcome
 *     (`replayed:true`, NO re-send); the same key + a DIFFERENT fingerprint is
 *     key reuse → typed 409; an in-flight duplicate → typed 409.
 *
 * ── Lifecycle (LIVE only — dry-run skips this table entirely) ─────────────────
 *   in_flight        — the claim was won; the on-chain deposit is being built/sent.
 *                      A concurrent duplicate finds this and 409s (`deposit_in_flight`).
 *   succeeded         — the deposit confirmed on-chain; `signature` +
 *                      `outcome_accounts` record the outcome for a faithful replay.
 *   broadcast_unknown — the deposit tx was BROADCAST but its confirmation was
 *                      never observed (it MAY have landed). Terminal + reconcile-
 *                      only: a replay returns the same unconfirmed signal, NEVER
 *                      re-sends (mirrors the settlement funding_unknown discipline).
 * A failure BEFORE broadcast books NOTHING — the row is DELETED so the SAME
 * request_id can be retried cleanly (nothing hit the wire).
 *
 * PURELY ADDITIVE new table; gated OFF with the rest of the V2 release path.
 */
export const sapDepositRequests = pgTable(
  'sap_deposit_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The depositor (requester) avatar acting on the deposit — resolved from
     * `identity.avatarId` (Rule E5: a human OR a connected/hosted agent, never a
     * body pubkey). The idempotency key's subject half.
     */
    subjectAvatarId: uuid('subject_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** Caller-supplied idempotency token — the key's request half. */
    requestId: varchar('request_id', { length: 128 }).notNull(),

    // ── request fingerprint (guards against key reuse for a DIFFERENT deposit) ──
    /** The derived V2 escrow PDA (base58) this request funds. */
    escrowPda: varchar('escrow_pda', { length: 64 }).notNull(),
    /** The USDC base-unit amount (u64 string) this request deposits. */
    amount: varchar('amount', { length: 32 }).notNull(),

    /** in_flight | succeeded | broadcast_unknown (CHECK-enforced in the migration). */
    status: varchar('status', { length: 24 }).notNull().default('in_flight'),
    /** Confirmed / broadcast-unknown deposit tx signature (base58). NULL until sent. */
    signature: varchar('signature', { length: 128 }),
    /** The chain executor's accounts map, stored for a faithful replay response. */
    outcomeAccounts: jsonb('outcome_accounts').$type<Record<string, string>>(),
    /** The chain failure code on a broadcast_unknown terminal (for reconciliation). */
    failureCode: varchar('failure_code', { length: 64 }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** THE idempotency key — one logical deposit per (subject, requestId). */
    subjectRequestUnique: uniqueIndex('sap_deposit_requests_subject_request_unique').on(
      t.subjectAvatarId,
      t.requestId,
    ),
    /** Per-escrow audit / reconciliation scan. */
    escrowIdx: index('sap_deposit_requests_escrow_idx').on(t.escrowPda, t.createdAt),
  }),
);

export type SapDepositRequest = typeof sapDepositRequests.$inferSelect;
export type NewSapDepositRequest = typeof sapDepositRequests.$inferInsert;

/**
 * sap_escrow_withdrawals — V2-WITHDRAW GATE-LEDGER LEG (flip-gate fix, doc line 623).
 *
 * `POST /api/sap/escrow/v2/withdraw` moves USDC vault→depositor ON-CHAIN
 * (self-custody free balance) but historically booked NOTHING into the gate's
 * settlements ledger (V1 refunds go through `refundJob`, which books
 * `refundedAmount`; the V2 withdraw route predates the gate). Consequence: the
 * ledger's `remaining` OVERSTATES the vault after an out-of-band withdraw, so a
 * later settle ceiling could be computed against funds that already left.
 *
 * This ESCROW-SCOPED (not job-scoped) ledger records each successful/broadcast-
 * unknown withdraw so `escrowFundsLedger` subtracts it from `remaining`. It is a
 * SEPARATE table (not a synthetic settlement row) on purpose: it never collides
 * with a caller-supplied `job_id`, never overloads the settlement status enum,
 * and leaves the `settle_unknown` quarantine + every V1 path untouched (a V1
 * escrow simply has no rows here). Paired with the live-vault clamp inside the
 * settle claim (the same doc-line-623 fix), the ledger stays truthful even when
 * the clamp's RPC read falls back.
 *
 * ── What the ledger subtracts ─────────────────────────────────────────────────
 *   succeeded         — the withdraw confirmed on-chain; funds definitely left.
 *   broadcast_unknown — the withdraw broadcast but was never confirmed; it MAY
 *                      have moved funds, so it is subtracted PESSIMISTICALLY
 *                      (fail-closed — never over-state the spendable vault).
 * A pre-broadcast failure books NOTHING (nothing left the vault). LIVE only —
 * dry-run moves nothing on-chain and writes no row.
 *
 * PURELY ADDITIVE new table; gated OFF with the rest of the V2 release path.
 */
export const sapEscrowWithdrawals = pgTable(
  'sap_escrow_withdrawals',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** The on-chain V2 escrow PDA (base58) the withdraw drew from. */
    escrowPda: varchar('escrow_pda', { length: 64 }).notNull(),
    /** The depositor avatar that withdrew (Rule E5 — its own custodial wallet). */
    subjectAvatarId: uuid('subject_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** The V2 nonce (u64 string), recorded for audit / reconciliation. */
    escrowNonce: varchar('escrow_nonce', { length: 32 }),

    /** USDC base units withdrawn (u64 string) — subtracted from the funds ledger. */
    amount: varchar('amount', { length: 32 }).notNull(),
    /** succeeded | broadcast_unknown (CHECK-enforced in the migration). */
    status: varchar('status', { length: 24 }).notNull(),
    /** Confirmed / broadcast-unknown withdraw tx signature (base58). */
    signature: varchar('signature', { length: 128 }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** "all withdrawals for this escrow" — the funds-ledger subtraction scan. */
    escrowIdx: index('sap_escrow_withdrawals_escrow_idx').on(t.escrowPda, t.createdAt),
  }),
);

export type SapEscrowWithdrawal = typeof sapEscrowWithdrawals.$inferSelect;
export type NewSapEscrowWithdrawal = typeof sapEscrowWithdrawals.$inferInsert;
