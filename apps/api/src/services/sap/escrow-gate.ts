/**
 * SAP Option C — escrow-gate orchestration (verify-before-release + HARD
 * idempotency).
 *
 * FEATURE_GATE: sap_usdc_escrow_gate
 * Status: FULLY built, GATED OFF (build-only). The whole Option C USDC escrow
 *   gate is dark unless SAP_ENABLED=true AND SAP_ESCROW_ENABLED=true AND
 *   SAP_USDC_ESCROW_ENABLED=true; and even then SAP_DRY_RUN=true (the default)
 *   builds + simulates only — NEVER broadcasts. In-game economy stays ClawTokens;
 *   this is an additive, flip-to-live, on-chain USDC layer.
 * Metric to graduate: a deliberate founder decision to run AI↔AI USDC commerce
 *   on-chain (devnet smoke with a funded depositor → mainnet code gate). No /dash
 *   metric drives this — it is an opt-in commerce layer, not an A/B'd feature.
 * Review deadline: 2026-09-22.
 * On deadline: if still disabled with no devnet escrow smoke, either flip on
 *   devnet for a real create→verify→settle smoke OR delete escrow-gate.ts +
 *   sap-escrow-usdc.ts + the escrow routes (keep the spec for a future revisit).
 *   Do NOT silently extend.
 * Reference: .claude/plans/sap-onchain-agents/PLAN.md (Option C),
 *   oobe-usdc-selfreport-spec.md, docs/sap-integration.md §10.
 *
 * ── Lifecycle (open → submit → approve → verify → settle | refund) ────────────
 *   open    — depositor funds an OOBE USDC escrow against the worker agent
 *             (custodial-signed for the depositor's Phase-5.1 wallet). A
 *             `sap_escrow_settlements` row is upserted in `open` for (escrow,job),
 *             recording `max_calls` + the job's `funded_amount`. depositor==worker
 *             is REJECTED (no self-dealing escrow — BLOCKING #1).
 *   submit  — the worker submits the deliverable (records `submitted`).
 *   approve — the DEPOSITOR (and ONLY the depositor) records an authenticated
 *             approval row (`sap_escrow_approvals`, keyed (escrow,job)). This is
 *             the ONLY thing that authorizes a release (BLOCKING #1) — a worker
 *             can no longer forge a request-body approval to self-release.
 *   verify  — the gate runs the pluggable VerificationProvider over a signal built
 *             SERVER-SIDE from the persisted approval (never the caller's body).
 *   settle  — ONLY on `passed===true`: clamps `callsToSettle` to the
 *             authorized/approved/funded ceiling (BLOCKING #2/#3), an atomic
 *             at-most-once claim flips the row to `settling` (the unique index is
 *             the lock), the gate binds the provider auditRoot into `service_hash`,
 *             calls the SelfReport `settle_calls` (release vault → worker), records
 *             `settled` + books `released_amount` into the funds ledger.
 *   refund  — on cancel/expiry/verify-fail the depositor `withdraw`s unspent USDC
 *             via an atomic `refunding` claim BEFORE any chain send (BLOCKING #4),
 *             books `refunded_amount`.
 *
 * ── Two recovery states (BLOCKING #4 + #5) ────────────────────────────────────
 *   refunding       — the atomic refund claim (mirrors `settling`); exactly one of
 *                     {settle, refund} ever reaches the chain for an escrow.
 *   funding_unknown — an OPEN tx BROADCAST but never confirmed; held for
 *                     reconciliation with `funding_signature`, NEVER auto-deleted
 *                     (deleting would free the slot → double-fund + orphan landed
 *                     USDC). Excluded from the spendable funds ledger (fail-closed).
 *
 * ── HARD idempotency (money invariant) ────────────────────────────────────────
 * A settle fires AT MOST ONCE per (escrow_pda, job_id). The mechanism:
 *   1. The `sap_escrow_settlements (escrow_pda, job_id)` UNIQUE index.
 *   2. The settle path, in ONE DB transaction, does a conditional UPDATE that
 *      flips the row to `settling` ONLY from a non-terminal state
 *      (`open|submitted`). The row-lock + the WHERE-clause state guard make the
 *      check-then-claim atomic: a concurrent OR retried second settle finds the
 *      row already `settling|settled` and gets ZERO rows updated → it bails
 *      WITHOUT touching the chain. The chain send happens AFTER the claim commits,
 *      so two callers can never both reach `settle_calls`.
 *   3. On a successful settle the row is flipped to `settled` (terminal). On a
 *      chain failure AFTER the claim it is flipped to `failed` (terminal, NOT
 *      auto-retried — a send whose confirmation we never observed may have
 *      landed; re-releasing would double-pay).
 *
 * ── Settlement rails (three-party topology) ───────────────────────────────────
 * Every (escrow, job) row records its RAIL at open (`metadata.rail`):
 *   onchain — the SAP program vault (fund at open, `settle_calls` releases
 *             vault → worker ATA). The historical default.
 *   payai   — the x402/PayAI settlement leg (SAP_PAYAI_SETTLEMENT_ENABLED):
 *             NO vault; the single USDC movement is an x402 exact-scheme
 *             payment (depositor custodial wallet → worker) settled by the
 *             PayAI facilitator at settle time (payai-release.ts). SAP stays
 *             the record/at-most-once/approval/ceiling gate; the Covenant/
 *             verification verdict stays the release authorization; PayAI
 *             moves the money. Dry-run = facilitator VERIFY-only.
 * Dispatch always follows the ROW's recorded rail (never the live env flag) and
 * rails never mix on one escrow PDA (`rail_mixed_forbidden`), so exactly ONE
 * money movement exists per job, on exactly one rail — no double-pay is
 * constructible from any flag flip or mixed ledger.
 *
 * This module NEVER writes avatars.clawTokens (this is a USDC path, not CT) and
 * NEVER logs the custodial secret (the chain leg in sap-client decrypts in-memory
 * only; the payai leg's payload signing is equally in-memory-only). It returns
 * structured results; the route maps them to clean HTTP codes.
 */

import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  db,
  wallets,
  sapEscrowSettlements,
  sapEscrowApprovals,
  sapDepositRequests,
  sapEscrowWithdrawals,
  type SapEscrowSettlement,
} from '@clawville/database';
import {
  createEscrowUsdc,
  depositEscrowUsdc,
  settleCallsUsdc,
  withdrawEscrowUsdc,
  resolveUsdcEscrowAddresses,
  createEscrowV2Usdc,
  depositEscrowV2Usdc,
  withdrawEscrowV2Usdc,
  settleCallsV2Usdc,
  finalizeSettlementUsdc,
  resolveV2UsdcEscrowAddress,
  inspectV2SettlementState,
  readV2VaultBalanceBaseUnits,
  preflightCreateEscrowV2Coverage,
  preflightDepositEscrowV2Coverage,
  sapConfigSnapshot,
  type SapWriteResult,
  type SapFailure,
} from './sap-client';
import {
  defaultVerificationProvider,
  type VerificationProvider,
  type VerificationJobContext,
} from './sap-verification';
// The x402/PayAI settlement leg (rail='payai'): prepare (pre-claim, no money)
// + execute (post-claim, the ONLY money-moving step on that rail).
import {
  preparePayaiRelease,
  executePayaiRelease,
  type PreparedPayaiRelease,
} from './payai-release';
// FIX 3 — per-escrowPda serialization. `withKeyedMutex` serializes concurrent
// sibling settles/refunds WITHIN this process (so the read-ledger → claim → book
// window can't interleave); the `pg_advisory_xact_lock` inside the claim txn
// serializes ACROSS processes. Mirrors the ct-topup / land per-subject pattern.
import { withKeyedMutex } from '../keyed-mutex';

/** Per-escrow mutex key — serializes all settle/refund critical sections for one vault. */
function escrowMutexKey(escrowPda: string): string {
  return `sap-escrow:${escrowPda}`;
}

// ─── settlement rail (three-party topology: SAP record · Covenant verdict · PayAI money) ─

/**
 * Which rail moves the job's USDC:
 *   'onchain' — the SAP program vault (create/deposit at open, `settle_calls`
 *               releases vault → worker ATA). The historical default.
 *   'payai'   — the x402/PayAI settlement leg: NO on-chain vault; on a passing
 *               verdict the release is an x402 exact-scheme payment (depositor
 *               custodial wallet → worker) settled by the PayAI facilitator
 *               (see `payai-release.ts`). The settlement ledger row is the
 *               same at-most-once / approval / ceiling gate either way.
 *
 * The rail is RECORDED on the row's `metadata.rail` at OPEN and every later
 * transition dispatches from the ROW — never from the live env flag — so a
 * flag flip mid-lifecycle can never fund a vault AND settle via PayAI (the
 * conservation keystone: exactly one money movement per job, on one rail).
 * Rows predating this field (no `rail` key) are on-chain by definition.
 */
export type EscrowSettlementRail = 'onchain' | 'payai';

/** Read the row's recorded rail (legacy rows without the key ⇒ 'onchain'). */
export function settlementRail(
  row: Pick<SapEscrowSettlement, 'metadata'>,
): EscrowSettlementRail {
  const rail = (row.metadata as Record<string, unknown> | null | undefined)?.rail;
  return rail === 'payai' ? 'payai' : 'onchain';
}

// ─── structured gate results ──────────────────────────────────────────────────

export type EscrowGateErrorCode =
  | SapFailure['code']
  | 'gate_disabled'
  | 'wallet_pubkey_missing'
  | 'verification_failed'
  | 'already_settled'
  | 'settle_in_progress'
  | 'job_not_open'
  | 'job_not_found'
  // The acting caller is not the party authorized for this transition (e.g. a
  // non-worker calling submit/settle, asserted server-side). 403.
  | 'unauthorized_caller'
  // BLOCKING #1 — an agent may not be on both sides of its own release.
  | 'self_dealing_forbidden'
  // BLOCKING #1 — only the depositor's PERSISTED approval authorizes a release.
  | 'not_approved'
  | 'approver_mismatch'
  // BLOCKING #2/#3 — the requested release exceeds the job's authorized calls,
  // its approved calls, or the escrow's remaining funded balance.
  | 'over_release'
  // BLOCKING #4 — a refund/settle is already claimed; the live broadcast is gated.
  | 'refund_in_progress'
  // BLOCKING #5 — the (escrow, job) is in funding_unknown and must be reconciled.
  | 'funding_unconfirmed'
  | 'settle_unconfirmed'
  | 'finalize_unconfirmed'
  | 'finalize_not_ready'
  | 'finalize_in_progress'
  | 'release_rail_forbidden'
  // payai rail — the job was opened on (or requested for) the PayAI x402
  // settlement rail while SAP_PAYAI_SETTLEMENT_ENABLED is off. Fail-closed:
  // a payai row NEVER falls back to the on-chain vault (it was never funded
  // on-chain), and an on-chain row never settles via PayAI. 503.
  | 'payai_rail_disabled'
  // payai rail — the facilitator/x402 config, fee-payer discovery, or payload
  // construction failed BEFORE the settle claim. Nothing moved; retryable. 502.
  | 'payai_unavailable'
  // payai rail — the facilitator verify/settle failed AFTER the claim. The row
  // is terminal `failed` (mirrors the on-chain post-claim failure posture). 502.
  | 'payai_release_failed'
  // An open tried to put a SECOND rail on an escrow PDA that already carries
  // jobs on the other rail. The per-PDA funds ledger must never blend on-chain
  // vault balances with payai commitments — one rail per vault. 409.
  | 'rail_mixed_forbidden'
  | 'internal';

export interface EscrowGateFailure {
  ok: false;
  code: EscrowGateErrorCode;
  message: string;
}

export interface EscrowGateOpenResult {
  ok: true;
  phase: 'open';
  settlement: SapEscrowSettlement;
  /**
   * The chain result IF a chain leg actually ran this call. NULL on an idempotent
   * replay (the (escrow, job) was already open — we did NOT re-fund) AND on a
   * `payai`-rail open (that rail has NO on-chain funding leg — the commitment is
   * ledger-recorded only; the single money movement happens at settle, via the
   * PayAI facilitator). Honest: never fabricates a fake simulation/signature.
   */
  chain: SapWriteResult | null;
  /** True when this call was an idempotent replay of an already-open job. */
  replay: boolean;
}

export interface EscrowGateSubmitResult {
  ok: true;
  phase: 'submitted';
  settlement: SapEscrowSettlement;
}

export interface EscrowGateApproveResult {
  ok: true;
  phase: 'approved';
  settlement: SapEscrowSettlement;
  /** The number of calls the depositor approved (null ⇒ the job's full maxCalls). */
  approvedCalls: string | null;
}

export interface EscrowGateSettleResult {
  ok: true;
  phase: 'settled';
  settlement: SapEscrowSettlement;
  /**
   * The chain settle result IF the chain settle ran this call (dry-run sim or
   * live signature). NULL on an idempotent replay of an already-settled job —
   * the prior outcome is on the `settlement` row (`settleSignature`/`dryRun`) —
   * AND on a `payai`-rail settle (no SAP chain leg; see `payai` below).
   */
  chain: SapWriteResult | null;
  /**
   * PayAI-rail outcome (rail='payai' settles only): the facilitator settlement.
   * `signature` is the facilitator-submitted on-chain tx signature (null on a
   * dry-run, which is facilitator VERIFY-only — no settle, no money moved).
   */
  payai?: { dryRun: boolean; signature: string | null };
  /** True when this call was an idempotent replay of an already-settled job. */
  replay: boolean;
}

export interface EscrowGatePendingResult {
  ok: true;
  phase: 'pending';
  settlement: SapEscrowSettlement;
  chain: SapWriteResult | null;
  replay: boolean;
  /** The principal is reserved on-chain; callers must use the V2 finalize route. */
  next: 'finalize';
}

export interface EscrowGateRefundResult {
  ok: true;
  phase: 'refunded';
  settlement: SapEscrowSettlement;
  /**
   * The on-chain withdraw result. NULL on a `payai`-rail refund — that rail has
   * no vault, so a refund is a pure LEDGER release of the job's commitment (the
   * depositor's USDC never left their wallet; nothing to withdraw).
   */
  chain: SapWriteResult | null;
}

export type EscrowGateResult =
  | EscrowGateOpenResult
  | EscrowGateSubmitResult
  | EscrowGateApproveResult
  | EscrowGateSettleResult
  | EscrowGatePendingResult
  | EscrowGateRefundResult
  | EscrowGateFailure;

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Top-level gate check mirrored from the config snapshot (defense-in-depth). */
function gateOpen(): EscrowGateFailure | null {
  const cfg = sapConfigSnapshot();
  if (!cfg.enabled || !cfg.escrowEnabled || !cfg.usdcEscrowEnabled) {
    return {
      ok: false,
      code: 'gate_disabled',
      message: 'SAP Option C USDC escrow gate is disabled.',
    };
  }
  return null;
}

/** Read an avatar's custodial wallet PUBKEY (base58) WITHOUT decrypting the secret. */
async function avatarWalletPubkey(avatarId: string): Promise<string | null> {
  const row = await db.query.wallets.findFirst({
    where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
    columns: { publicKey: true },
  });
  return row?.publicKey ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/** Parse a u64-as-decimal-string column to bigint; null/empty/garbage → 0n. */
function u64(s: string | null | undefined): bigint {
  if (!s) return 0n;
  try {
    const v = BigInt(s);
    return v < 0n ? 0n : v;
  } catch {
    return 0n;
  }
}

/** The verdict→settle authorization decision (see `evaluateSettleAuthorization`). */
export type SettleAuthorization =
  | { authorized: true; auditRootHex: string }
  | { authorized: false; reason: string };

/**
 * The verdict→settle authorization gate, extracted PURE so the money invariant is
 * a NAMED, UNIT-TESTED unit instead of inline call-order in `settleJobLocked`
 * (Codex audit advisory, 2026-07-06). Invariant: a settle — on EITHER rail (the
 * on-chain SAP vault OR the payai facilitator) — may proceed to prepare/claim/
 * release ONLY when this returns `{authorized:true}`. Two ways to be unauthorized:
 *   (a) the verification verdict did not pass, or
 *   (b) it passed but carries no valid 32-byte non-zero audit root (the provenance
 *       binding) — refused as an integrity guard.
 * Pure: no I/O, no DB, no side effects — the caller owns the failing-verdict
 * provenance write. Behavior is byte-identical to the prior inline logic.
 */
export function evaluateSettleAuthorization(verdict: {
  passed: boolean;
  detail?: string | null;
  auditRoot: Uint8Array;
}): SettleAuthorization {
  if (!verdict.passed) {
    return { authorized: false, reason: verdict.detail ?? 'verification did not pass; no settle.' };
  }
  if (verdict.auditRoot.length !== 32 || verdict.auditRoot.every((b) => b === 0)) {
    return {
      authorized: false,
      reason: 'verification passed but produced no valid audit root; refusing to settle.',
    };
  }
  return { authorized: true, auditRootHex: Buffer.from(verdict.auditRoot).toString('hex') };
}

/**
 * BLOCKING #2 + #3 — the PURE settle-ceiling computation, extracted so it is unit
 * testable without a DB. The number of calls a settle may release is the MIN of:
 *   (a) remainingAuthorized = maxCalls − callsAlreadySettled  (the job's ceiling),
 *   (b) the depositor's approved calls (0 ⇒ no explicit cap, defaults to (a)),
 *   (c) floor(escrowRemainingVaultBalance / pricePerCall)     (escrow-wide funds),
 *   (d) floor(jobRemainingFunded / pricePerCall)              (this job's funds).
 * A requested `callsToSettle` over this ceiling is an over-release (rejected, not
 * truncated). All inputs are bigint base units; pricePerCall MUST be > 0.
 */
export function computeSettleCeiling(args: {
  maxCalls: bigint;
  callsAlreadySettled: bigint;
  approvedCalls: bigint; // 0n ⇒ no explicit cap
  pricePerCall: bigint; // > 0
  escrowRemaining: bigint;
  jobRemainingFunded: bigint;
}): bigint {
  if (args.pricePerCall <= 0n) return 0n;
  const remainingAuthorized =
    args.maxCalls > args.callsAlreadySettled ? args.maxCalls - args.callsAlreadySettled : 0n;
  const approvalBound = args.approvedCalls > 0n ? args.approvedCalls : remainingAuthorized;
  const callsVaultCanPay = args.escrowRemaining / args.pricePerCall; // floor
  const callsJobFundsCanPay = args.jobRemainingFunded / args.pricePerCall; // floor

  let ceiling = remainingAuthorized;
  if (approvalBound < ceiling) ceiling = approvalBound;
  if (callsVaultCanPay < ceiling) ceiling = callsVaultCanPay;
  if (callsJobFundsCanPay < ceiling) ceiling = callsJobFundsCanPay;
  return ceiling < 0n ? 0n : ceiling;
}

/**
 * FIX 2 — the PURE refund-ceiling computation, extracted so it is unit testable
 * without a DB. The USDC base units a refund may reclaim is the MIN of:
 *   (a) jobRemainingFunded = jobFunded − jobReleased − jobRefunded (this job's own
 *       unspent funded portion of the shared nonce-less vault), and
 *   (b) escrowRemaining (the escrow-wide spendable balance =
 *       sum(funded) − sum(released) − sum(refunded) across all jobs).
 * A requested refund amount over this ceiling is an over-release (rejected, never
 * broadcast — so an over-amount can't strand the row in terminal `failed`). All
 * inputs are bigint base units; the result is floored at 0.
 */
export function computeRefundCeiling(args: {
  jobRemainingFunded: bigint;
  escrowRemaining: bigint;
}): bigint {
  const ceiling =
    args.jobRemainingFunded < args.escrowRemaining
      ? args.jobRemainingFunded
      : args.escrowRemaining;
  return ceiling < 0n ? 0n : ceiling;
}

/**
 * BLOCKING #2 + #3 — the per-escrow + per-job funds ledger.
 *
 * The V1 USDC escrow PDA is one-per-(agent,depositor) with NO nonce, so EVERY
 * jobId for the pair shares ONE on-chain vault. There is no on-chain per-job
 * accounting, so it lives HERE: we sum the funded / released / refunded amounts
 * across ALL settlement rows for the escrow and enforce, before any settle:
 *   - escrow-wide: sum(released) + sum(refunded) + thisRelease ≤ sum(funded)
 *   - per-job:     job.released + thisRelease ≤ job.funded
 * so a worker controlling one job can never release USDC the depositor earmarked
 * for a sibling job, and no settle can over-draw the vault.
 *
 * Reads only CONFIRMED-funded rows (status NOT in the un-funded/abandoned set) so
 * a never-funded or funding_unknown row never inflates the available balance.
 */
async function escrowFundsLedger(escrowPda: string): Promise<{
  funded: bigint;
  released: bigint;
  refunded: bigint;
  reserved: bigint;
  fees: bigint;
  /** V2 self-custody withdraws booked against this escrow (doc line 623 fix). */
  withdrawn: bigint;
  /**
   * funded − released − refunded − reserved − fees − withdrawn, floored at 0
   * (the spendable vault balance).
   */
  remaining: bigint;
}> {
  const rows = await db.query.sapEscrowSettlements.findMany({
    where: eq(sapEscrowSettlements.escrowPda, escrowPda),
    columns: {
      status: true,
      fundedAmount: true,
      releasedAmount: true,
      refundedAmount: true,
      reservedPrincipalAmount: true,
      feeAmount: true,
    },
  });
  // FIX (doc line 623) — book V2 self-custody withdraws. `/escrow/v2/withdraw`
  // moves USDC vault→depositor ON-CHAIN without a settlement row, so without this
  // the ledger OVERSTATES the vault after an out-of-band withdraw. Only
  // `succeeded`/`broadcast_unknown` rows are ever written (a pre-broadcast failure
  // books nothing), so summing every row is correct AND pessimistic — a
  // broadcast-unknown withdraw MAY have moved funds and is subtracted fail-closed.
  const withdrawRows = await db.query.sapEscrowWithdrawals.findMany({
    where: eq(sapEscrowWithdrawals.escrowPda, escrowPda),
    columns: { amount: true },
  });
  let funded = 0n;
  let released = 0n;
  let refunded = 0n;
  let reserved = 0n;
  let fees = 0n;
  let withdrawn = 0n;
  for (const r of rows) {
    // A settle_unknown row quarantines exactly its own funded allocation. Skip
    // the row as a unit: adding no funding and then subtracting its provisional
    // reservation would over-quarantine sibling jobs by the reservation twice.
    if (r.status === 'settle_unknown') continue;
    // Only count funding that actually landed. A `funding_unknown` row's deposit
    // is UNCONFIRMED — exclude it from the spendable balance (fail-closed: it can
    // only be counted after reconciliation flips it to a funded status).
    if (r.status !== 'funding_unknown') {
      funded += u64(r.fundedAmount);
    }
    released += u64(r.releasedAmount);
    refunded += u64(r.refundedAmount);
    reserved += u64(r.reservedPrincipalAmount);
    fees += u64(r.feeAmount);
  }
  for (const w of withdrawRows) withdrawn += u64(w.amount);
  const net = funded - released - refunded - reserved - fees - withdrawn;
  return { funded, released, refunded, reserved, fees, withdrawn, remaining: net < 0n ? 0n : net };
}

/**
 * Deployed V2 protocol fee: 50 bps with integer-floor arithmetic. The V2
 * executor does not return the fee separately, so the ledger mirrors the
 * program's fixed-bps integer calculation; this is intentionally distinct from
 * create's conservative 100-bps/ceil funding-headroom preflight.
 */
export function computeV2ProtocolFee(principal: bigint): bigint {
  return principal <= 0n ? 0n : (principal * 50n) / 10_000n;
}

/** The drizzle transaction handle type, for helpers that run inside `db.transaction`. */
type SapDbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A2 — statuses under which a settlement row already OWNS the on-chain pending at
 * its recorded `settlementIndex`. If a DIFFERENT row of the same escrow holds one
 * of these at the index we're about to reconcile, the pending belongs to it and we
 * must never book it a second time.
 */
const PENDING_INDEX_OWNER_STATUSES = [
  'settling',
  'pending',
  'finalizing',
  'finalize_unknown',
  'settled',
] as const;

/**
 * A2 — does a DIFFERENT settlement row of this escrow already own the on-chain
 * pending at `settlementIndex`? Must be called UNDER the per-escrow advisory lock so
 * the check-then-book is atomic across processes (the in-process keyed mutex already
 * serializes same-escrow settles). Reads the escrow's rows and filters in memory
 * (small N per escrow; keeps the test seam simple).
 *
 * SEMANTICS (verified against OOBE escrow_v2.rs @55d29ed): `settlement_index`
 * increments INSIDE `settle_calls_v2` (`checked_add(1)` in the DisputeWindow arm),
 * and the PendingSettlement account is KEPT (marked `is_finalized=true`, NOT closed)
 * at finalize. So each settle owns a UNIQUE index and this guard is defensive
 * (out-of-band writer / stale read) — but it is correct under either increment
 * semantics and is the only thing that stops a sibling job from double-booking one
 * on-chain pending into two ledger rows.
 */
async function siblingOwnsPendingIndex(
  tx: SapDbTx,
  escrowPda: string,
  selfRowId: string,
  settlementIndex: string,
): Promise<boolean> {
  const escrowRows = await tx
    .select({
      id: sapEscrowSettlements.id,
      settlementIndex: sapEscrowSettlements.settlementIndex,
      status: sapEscrowSettlements.status,
    })
    .from(sapEscrowSettlements)
    .where(eq(sapEscrowSettlements.escrowPda, escrowPda));
  return escrowRows.some(
    (r) =>
      r.id !== selfRowId &&
      r.settlementIndex === settlementIndex &&
      (PENDING_INDEX_OWNER_STATUSES as readonly string[]).includes(r.status ?? ''),
  );
}

function dryRunSimulationError(result: SapWriteResult): unknown | null {
  if (!result.ok || !result.dryRun) return null;
  if (result.simulation.err) return result.simulation.err;
  if (!result.accepted || result.programReached !== 'yes') {
    return {
      kind: 'inconclusive_simulation',
      accepted: result.accepted,
      programReached: result.programReached,
    };
  }
  return null;
}

function isV2ReplaySignal(value: unknown): boolean {
  let rendered: string;
  try {
    rendered = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  return /(?:6138|6097|6099|SettlementReplay|EscrowNonceReused|SettlementAlreadyFinalized)/i.test(
    rendered,
  );
}

// ─── 1. OPEN (deposit) ────────────────────────────────────────────────────────

export interface OpenEscrowInput {
  /** Depositor (requester) avatar — funds the escrow as itself. Rule E5 parity. */
  depositorAvatarId: string;
  /** Worker (service) avatar — the settle beneficiary. */
  workerAvatarId: string;
  /** Off-chain job id — the (escrow, job) idempotency key's job half. */
  jobId: string;
  pricePerCall: bigint;
  maxCalls: bigint;
  initialDeposit: bigint;
  /** Absolute unix-seconds expiry (i64). 0 = no expiry. */
  expiresAt: bigint;
  /**
   * Settlement rail for this job (default 'onchain'). 'payai' records the
   * commitment in the settlement ledger WITHOUT an on-chain funding leg — the
   * single USDC movement happens at settle, as an x402 payment through the
   * PayAI facilitator. Recorded on the row at open; immutable thereafter.
   * Requires SAP_PAYAI_SETTLEMENT_ENABLED (fail-closed here at open).
   * NOTE (payai): `expiresAt` has no on-chain enforcement on this rail (there
   * is no vault); expiry semantics live with the caller (e.g. bounty expiry).
   */
  rail?: EscrowSettlementRail;
}

export interface OpenEscrowV2Input extends Omit<OpenEscrowInput, 'rail'> {
  /** Explicit u64 seed for ["sap_escrow_v2", agent, depositor, nonce]. */
  escrowNonce: bigint;
  /** Test/defense seam only: V2 release is on-chain-only and rejects payai. */
  rail?: EscrowSettlementRail;
}

/**
 * Open (or top-up) a USDC escrow for (worker, depositor) and record/advance the
 * `sap_escrow_settlements` row for (escrow, job).
 *
 * Because the V1 USDC escrow PDA is one-per-(agent,depositor) (no nonce), a
 * second job for the same pair TOPS UP the same escrow (deposit_escrow), and is
 * tracked as a DISTINCT settlement row keyed by its own jobId. The first job for
 * the pair creates the escrow; subsequent ones deposit.
 */
export async function openEscrow(input: OpenEscrowInput): Promise<EscrowGateResult> {
  const gated = gateOpen();
  if (gated) return gated;

  // BLOCKING #1 — an agent must NEVER be on both sides of its own release. If the
  // depositor and worker are the same avatar, the worker could approve + settle to
  // itself with no independent party. Reject self-dealing at open time (the
  // simplest, hardest gate; a future self-dealing job would require an independent
  // verifier provider, not the requester-approval one).
  if (input.depositorAvatarId === input.workerAvatarId) {
    return {
      ok: false,
      code: 'self_dealing_forbidden',
      message: 'depositor and worker cannot be the same avatar (self-dealing escrow forbidden).',
    };
  }

  const cfg = sapConfigSnapshot();

  // Rail selection — recorded on the row below and immutable thereafter. The
  // payai rail is gated by its own flag ON TOP of the escrow gates (fail-closed
  // at open: a disabled rail can never accumulate commitments).
  const rail: EscrowSettlementRail = input.rail ?? 'onchain';
  if (rail === 'payai' && !cfg.payaiSettlementEnabled) {
    return {
      ok: false,
      code: 'payai_rail_disabled',
      message: 'the PayAI x402 settlement rail is disabled (SAP_PAYAI_SETTLEMENT_ENABLED).',
    };
  }

  const workerWalletPubkey = await avatarWalletPubkey(input.workerAvatarId);
  const depositorWalletPubkey = await avatarWalletPubkey(input.depositorAvatarId);
  if (!workerWalletPubkey || !depositorWalletPubkey) {
    return {
      ok: false,
      code: 'wallet_pubkey_missing',
      message: 'worker or depositor avatar has no custodial wallet.',
    };
  }

  const addr = resolveUsdcEscrowAddresses({ workerWalletPubkey, depositorWalletPubkey });
  if (addr.ok === false) return { ok: false, code: addr.code, message: addr.message };
  const escrowPda = addr.addrs.escrowPda.toBase58();

  // ── CLAIM-FIRST, FUND-SECOND (no double-fund race) ──────────────────────────
  // INSERT the (escrow, job) row FIRST so the unique index serializes concurrent
  // opens: exactly ONE caller wins the INSERT and is the only one that funds the
  // chain; a racing loser trips 23505, never funds, and serves the existing row.
  // This closes the double-deposit window the old "read → fund → insert" had.
  let row: SapEscrowSettlement;
  let isTopUp: boolean;
  try {
    // "Top up vs create": is there ALREADY another job row for this escrow pair?
    // (The first job for a pair created the on-chain escrow; a later one deposits.)
    // Read INSIDE the try so the value is consistent with the row we then insert.
    const priorForEscrow = await db.query.sapEscrowSettlements.findFirst({
      where: eq(sapEscrowSettlements.escrowPda, escrowPda),
      columns: { id: true, metadata: true },
    });
    isTopUp = !!priorForEscrow;

    // RAIL HOMOGENEITY — one rail per escrow PDA. The per-PDA funds ledger sums
    // fundedAmount across ALL the vault's jobs; blending on-chain vault balances
    // with payai commitments would corrupt the escrow-wide conservation check.
    // Every open checks against an existing row, so homogeneity holds by
    // induction. (The per-JOB funded bound independently caps each job at its
    // own funding either way — this guard keeps the AGGREGATE ledger honest.)
    if (priorForEscrow && settlementRail(priorForEscrow) !== rail) {
      return {
        ok: false,
        code: 'rail_mixed_forbidden',
        message:
          `escrow ${escrowPda} already carries '${settlementRail(priorForEscrow)}'-rail jobs; ` +
          `a '${rail}'-rail job cannot share the same vault ledger.`,
      };
    }

    const [inserted] = await db
      .insert(sapEscrowSettlements)
      .values({
        escrowPda,
        jobId: input.jobId,
        depositorAvatarId: input.depositorAvatarId,
        workerAvatarId: input.workerAvatarId,
        workerWalletPubkey,
        depositorWalletPubkey,
        tokenMint: addr.mint.toBase58(),
        pricePerCall: input.pricePerCall.toString(),
        // BLOCKING #2 — record the authorized call ceiling so settle clamps to it.
        maxCalls: input.maxCalls.toString(),
        // BLOCKING #3 — record this job's funded portion of the SHARED vault for
        // the cross-job accounting invariant. Not counted toward the spendable
        // balance until the chain fund leg confirms (set below on success).
        fundedAmount: '0',
        status: 'open',
        dryRun: cfg.dryRun,
        metadata: { isTopUp, funded: false, rail },
      })
      .returning();
    row = inserted;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // A concurrent / retried open already claimed this (escrow, job). We did NOT
      // fund — serve the existing row idempotently (no double-charge).
      const existing = await db.query.sapEscrowSettlements.findFirst({
        where: and(
          eq(sapEscrowSettlements.escrowPda, escrowPda),
          eq(sapEscrowSettlements.jobId, input.jobId),
        ),
      });
      if (existing) return { ok: true, phase: 'open', settlement: existing, chain: null, replay: true };
    }
    return { ok: false, code: 'internal', message: 'failed to record escrow settlement.' };
  }

  // ── PAYAI RAIL — no on-chain funding leg ─────────────────────────────────────
  // The depositor's USDC stays in their custodial wallet until settle (where the
  // PayAI facilitator moves it depositor→worker in ONE payment). We book the
  // job's COMMITMENT as `fundedAmount` so the settle/refund ceilings enforce the
  // exact same per-job + per-PDA conservation bounds as the vault rail.
  // `funded:false` in metadata is honest — nothing sits in an on-chain vault;
  // the facilitator's verify (payer balance/signature) is the funding check,
  // run at settle time. A depositor draining their wallet between open and
  // settle fails that verify — fail-closed, money never wrong (the bounty flow
  // opens+approves+settles back-to-back, so the exposure window is one request).
  if (rail === 'payai') {
    const [committed] = await db
      .update(sapEscrowSettlements)
      .set({
        dryRun: cfg.dryRun,
        fundedAmount: input.initialDeposit.toString(),
        metadata: { isTopUp, funded: false, committed: true, rail },
        updatedAt: new Date(),
      })
      .where(eq(sapEscrowSettlements.id, row.id))
      .returning();
    return { ok: true, phase: 'open', settlement: committed, chain: null, replay: false };
  }

  // We hold the claim — fund the chain (create the escrow, or top up an existing
  // one for the pair). On dry-run this simulates only.
  const chain = isTopUp
    ? await depositEscrowUsdc({
        depositorAvatarId: input.depositorAvatarId,
        workerWalletPubkey,
        amount: input.initialDeposit,
      })
    : await createEscrowUsdc({
        depositorAvatarId: input.depositorAvatarId,
        workerWalletPubkey,
        pricePerCall: input.pricePerCall,
        maxCalls: input.maxCalls,
        initialDeposit: input.initialDeposit,
        expiresAt: input.expiresAt,
      });
  if (chain.ok === false) {
    if (chain.broadcast) {
      // BLOCKING #5 — the fund tx was BROADCAST but we never confirmed it. It may
      // have LANDED, putting real USDC in the vault. DELETING the row would (a)
      // free the (escrow, job) slot → a retry could DOUBLE-FUND, and (b) orphan
      // any landed USDC. So we DO NOT delete: persist a terminal-but-recoverable
      // `funding_unknown` state + the broadcast signature for a reconciler to poll
      // the chain before the slot is reused. The funds ledger excludes
      // `funding_unknown` from the spendable balance (fail-closed).
      await db
        .update(sapEscrowSettlements)
        .set({
          status: 'funding_unknown',
          fundingSignature: chain.signature ?? null,
          dryRun: false,
          metadata: { ...((row.metadata as object) ?? {}), isTopUp, funded: false, fundingError: chain.code },
          updatedAt: new Date(),
        })
        .where(eq(sapEscrowSettlements.id, row.id));
      return {
        ok: false,
        code: 'funding_unconfirmed',
        message:
          'escrow fund tx was broadcast but its confirmation was not observed; the ' +
          'job is held in funding_unknown for reconciliation (no auto-retry / no slot reuse).',
      };
    }
    // The chain fund leg NEVER hit the wire (build/blockhash/pre-broadcast reject,
    // or a dry-run sim failure) — no funds moved. DELETE our just-claimed row so the
    // (escrow, job) slot frees for a clean retry, and a later settle can never try
    // to release an escrow that was never funded.
    await db.delete(sapEscrowSettlements).where(eq(sapEscrowSettlements.id, row.id));
    return { ok: false, code: chain.code, message: chain.message };
  }

  // Mark the row funded (records the realized dry-run flag from the chain leg) and
  // book this job's funded portion into the per-escrow accounting ledger
  // (BLOCKING #3). On dry-run the deposit is simulated; we still record the
  // intended funded amount so the dry-run settle path exercises the SAME bounds.
  const [funded] = await db
    .update(sapEscrowSettlements)
    .set({
      dryRun: chain.dryRun,
      fundedAmount: input.initialDeposit.toString(),
      metadata: { isTopUp, funded: true, rail },
      updatedAt: new Date(),
    })
    .where(eq(sapEscrowSettlements.id, row.id))
    .returning();

  return { ok: true, phase: 'open', settlement: funded, chain, replay: false };
}

/** Nonce-scoped V2 open with the same claim-first/fund-second posture as V1. */
export async function openEscrowV2(input: OpenEscrowV2Input): Promise<EscrowGateResult> {
  const gated = gateOpen();
  if (gated) return gated;
  if (input.rail === 'payai') {
    return { ok: false, code: 'release_rail_forbidden', message: 'V2 escrows support only the onchain release rail.' };
  }
  if (input.depositorAvatarId === input.workerAvatarId) {
    return { ok: false, code: 'self_dealing_forbidden', message: 'depositor and worker cannot be the same avatar (self-dealing escrow forbidden).' };
  }
  if (input.pricePerCall <= 0n || input.maxCalls <= 0n || input.initialDeposit <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'pricePerCall, maxCalls, and initialDeposit must be > 0.' };
  }
  // Apply createEscrowV2Usdc's conservative fee-headroom preflight here too.
  // A nonce may already exist and dispatch to depositEscrowV2Usdc, whose generic
  // top-up executor cannot know this new job's full obligation.
  const obligation = input.pricePerCall * input.maxCalls;
  const headroom = ((obligation * 100n + 9_999n) / 10_000n) || 1n;
  const minimumDeposit = obligation + headroom;
  if (input.initialDeposit < minimumDeposit) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: `initialDeposit must cover obligation plus V2 fee headroom (required >= ${minimumDeposit}).`,
    };
  }
  const cfg = sapConfigSnapshot();
  const workerWalletPubkey = await avatarWalletPubkey(input.workerAvatarId);
  const depositorWalletPubkey = await avatarWalletPubkey(input.depositorAvatarId);
  if (!workerWalletPubkey || !depositorWalletPubkey) {
    return { ok: false, code: 'wallet_pubkey_missing', message: 'worker or depositor avatar has no custodial wallet.' };
  }
  const addr = resolveV2UsdcEscrowAddress({ workerWalletPubkey, depositorWalletPubkey, escrowNonce: input.escrowNonce });
  if (addr.ok === false) return { ok: false, code: addr.code, message: addr.message };
  const escrowPda = addr.escrowPda.toBase58();
  return withKeyedMutex(escrowMutexKey(escrowPda), async () => {
  let row: SapEscrowSettlement;
  let isTopUp = false;
  try {
    const prior = await db.query.sapEscrowSettlements.findFirst({
      where: eq(sapEscrowSettlements.escrowPda, escrowPda),
      columns: { id: true, escrowVersion: true, escrowNonce: true, metadata: true },
    });
    isTopUp = !!prior;
    if (prior && (prior.escrowVersion !== 'v2' || prior.escrowNonce !== input.escrowNonce.toString())) {
      return { ok: false, code: 'internal', message: 'V2 escrow ledger coordinates do not match the requested nonce.' };
    }
    if (prior && settlementRail(prior) !== 'onchain') {
      return { ok: false, code: 'release_rail_forbidden', message: 'a payai row cannot share a V2 on-chain escrow.' };
    }
    const coverageGate = prior
      ? await preflightDepositEscrowV2Coverage({
          workerWalletPubkey,
          depositorWalletPubkey,
          escrowNonce: input.escrowNonce,
          amount: input.initialDeposit,
        })
      : await preflightCreateEscrowV2Coverage({
          workerWalletPubkey,
          pricePerCall: input.pricePerCall,
          maxCalls: input.maxCalls,
          initialDeposit: input.initialDeposit,
        });
    if (coverageGate) return coverageGate;
    [row] = await db.insert(sapEscrowSettlements).values({
      escrowPda,
      escrowVersion: 'v2',
      escrowNonce: input.escrowNonce.toString(),
      jobId: input.jobId,
      depositorAvatarId: input.depositorAvatarId,
      workerAvatarId: input.workerAvatarId,
      workerWalletPubkey,
      depositorWalletPubkey,
      tokenMint: addr.mint.toBase58(),
      pricePerCall: input.pricePerCall.toString(),
      maxCalls: input.maxCalls.toString(),
      fundedAmount: '0',
      status: 'open',
      dryRun: cfg.dryRun,
      metadata: { isTopUp, funded: false, rail: 'onchain' },
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await db.query.sapEscrowSettlements.findFirst({
        where: and(eq(sapEscrowSettlements.escrowPda, escrowPda), eq(sapEscrowSettlements.jobId, input.jobId)),
      });
      if (existing) return { ok: true, phase: 'open', settlement: existing, chain: null, replay: true };
    }
    return { ok: false, code: 'internal', message: 'failed to record V2 escrow settlement.' };
  }
  const chain = isTopUp
    ? await depositEscrowV2Usdc({ depositorAvatarId: input.depositorAvatarId, workerWalletPubkey, escrowNonce: input.escrowNonce, amount: input.initialDeposit })
    : await createEscrowV2Usdc({ depositorAvatarId: input.depositorAvatarId, workerWalletPubkey, escrowNonce: input.escrowNonce, pricePerCall: input.pricePerCall, maxCalls: input.maxCalls, initialDeposit: input.initialDeposit, expiresAt: input.expiresAt });
  if (chain.ok === false) {
    if (chain.broadcast) {
      await db.update(sapEscrowSettlements).set({
        status: 'funding_unknown', fundingSignature: chain.signature ?? null, dryRun: false,
        metadata: { ...((row.metadata as object) ?? {}), isTopUp, funded: false, fundingError: chain.code }, updatedAt: new Date(),
      }).where(eq(sapEscrowSettlements.id, row.id));
      return { ok: false, code: 'funding_unconfirmed', message: 'V2 escrow fund tx was broadcast but unconfirmed; reconcile before retry.' };
    }
    await db.delete(sapEscrowSettlements).where(eq(sapEscrowSettlements.id, row.id));
    return { ok: false, code: chain.code, message: chain.message };
  }
  const fundingSimulationError = dryRunSimulationError(chain);
  if (fundingSimulationError) {
    await db.delete(sapEscrowSettlements).where(eq(sapEscrowSettlements.id, row.id));
    return {
      ok: false,
      code: 'on_chain_error',
      message: `V2 escrow funding simulation failed before broadcast: ${JSON.stringify(fundingSimulationError)}`,
    };
  }
  const [funded] = await db.update(sapEscrowSettlements).set({
    dryRun: chain.dryRun, fundedAmount: input.initialDeposit.toString(),
    metadata: { isTopUp, funded: true, rail: 'onchain' }, updatedAt: new Date(),
  }).where(eq(sapEscrowSettlements.id, row.id)).returning();
  return { ok: true, phase: 'open', settlement: funded, chain, replay: false };
  });
}

// ─── 1b. V2 DEPOSIT — idempotent top-up (FIX 1, doc line 591) ──────────────────

export interface DepositEscrowV2IdempotentInput {
  /** Depositor (requester) avatar — funds its OWN escrow. Rule E5 parity. */
  depositorAvatarId: string;
  /** Worker's registered wallet pubkey (base58) — the escrow PDA seed component. */
  workerWalletPubkey: string;
  /** Explicit V2 u64 nonce identifying the escrow. */
  escrowNonce: bigint;
  /** USDC base units to top up. */
  amount: bigint;
  /** Caller idempotency token (trimmed / validated at the route). */
  requestId: string;
}

export type DepositEscrowV2IdempotentResult =
  | { ok: true; chain: SapWriteResult; replayed: boolean }
  | {
      ok: false;
      // L1 — reuse the house `avatar_wallet_missing` code (same as the withdraw
      // wrapper + the SapFailure union), not a bespoke `wallet_pubkey_missing`.
      code:
        | 'deposit_in_flight'
        | 'deposit_request_mismatch'
        | 'avatar_wallet_missing'
        | 'invalid_pubkey'
        | 'internal';
      message: string;
    };

/** Reconstruct the response `chain` object recorded on a terminal idempotency row. */
function reconstructDepositChain(row: {
  status: string;
  signature: string | null;
  outcomeAccounts: Record<string, string> | null;
  failureCode: string | null;
}): SapWriteResult {
  if (row.status === 'succeeded') {
    return {
      ok: true,
      dryRun: false,
      signature: row.signature ?? '',
      accounts: row.outcomeAccounts ?? {},
    };
  }
  // broadcast_unknown — the prior deposit MAY have landed; NEVER re-send.
  return {
    ok: false,
    code: (row.failureCode as SapFailure['code']) ?? 'on_chain_error',
    message:
      'a prior deposit with this requestId was broadcast but never confirmed; ' +
      'reconcile the recorded signature before any retry (never auto-retried).',
    broadcast: true,
    signature: row.signature ?? undefined,
  };
}

/**
 * FIX 1 (doc line 591) — idempotent V2 escrow top-up.
 *
 * `deposit_escrow_v2` is additive, so a duplicate client POST double-funds the
 * depositor's OWN escrow. This wraps `depositEscrowV2Usdc` with a DB-backed
 * route-level idempotency claim keyed UNIQUE (subject avatarId, requestId), with
 * (escrowPda, amount) as the request fingerprint:
 *   - a replay with the same key + same fingerprint returns the RECORDED outcome
 *     (`replayed:true`, NO re-send);
 *   - a replay with the same key + a DIFFERENT fingerprint is key reuse → 409
 *     `deposit_request_mismatch`;
 *   - an in-flight duplicate → 409 `deposit_in_flight`.
 *
 * The claim is INSERTed BEFORE any wire construction. A pre-broadcast failure
 * DELETEs the claim so the SAME requestId retries cleanly; a broadcast-unknown is
 * held terminal (reconcile-only, NEVER auto-retried), mirroring the
 * `funding_unknown` discipline.
 *
 * DRY-RUN skips the idempotency table entirely — a dry-run sends nothing on-chain,
 * so persisting a claim would wrongly block a later real request. This keeps the
 * currently-reachable (flags OFF + dry-run) behavior byte-identical to a direct
 * `depositEscrowV2Usdc` call; the guard activates only on a deliberate live flip.
 */
export async function depositEscrowV2Idempotent(
  input: DepositEscrowV2IdempotentInput,
): Promise<DepositEscrowV2IdempotentResult> {
  const cfg = sapConfigSnapshot();

  // DRY-RUN — no persistence (see the JSDoc). Proxy straight to the executor.
  if (cfg.dryRun) {
    const chain = await depositEscrowV2Usdc({
      depositorAvatarId: input.depositorAvatarId,
      workerWalletPubkey: input.workerWalletPubkey,
      escrowNonce: input.escrowNonce,
      amount: input.amount,
    });
    return { ok: true, chain, replayed: false };
  }

  // LIVE — resolve the escrow PDA (the fingerprint) then claim idempotency.
  const depositorWalletPubkey = await avatarWalletPubkey(input.depositorAvatarId);
  if (!depositorWalletPubkey) {
    return { ok: false, code: 'avatar_wallet_missing', message: 'depositor avatar has no custodial wallet.' };
  }
  const addr = resolveV2UsdcEscrowAddress({
    workerWalletPubkey: input.workerWalletPubkey,
    depositorWalletPubkey,
    escrowNonce: input.escrowNonce,
  });
  if (addr.ok === false) {
    // The route already gated; this is defense-in-depth. Surface a bad pubkey
    // precisely, map any other resolver failure to a tight `internal`.
    const code = addr.code === 'invalid_pubkey' ? 'invalid_pubkey' : 'internal';
    return { ok: false, code, message: addr.message };
  }
  const escrowPda = addr.escrowPda.toBase58();
  const amountStr = input.amount.toString();

  // ── ATOMIC INSERT-claim BEFORE any wire construction (the unique index is the lock) ──
  let claimId: string;
  try {
    const [claim] = await db
      .insert(sapDepositRequests)
      .values({
        subjectAvatarId: input.depositorAvatarId,
        requestId: input.requestId,
        escrowPda,
        amount: amountStr,
        status: 'in_flight',
      })
      .returning({ id: sapDepositRequests.id });
    claimId = claim.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await db.query.sapDepositRequests.findFirst({
        where: and(
          eq(sapDepositRequests.subjectAvatarId, input.depositorAvatarId),
          eq(sapDepositRequests.requestId, input.requestId),
        ),
      });
      if (!existing) {
        return { ok: false, code: 'internal', message: 'idempotency claim raced without a readable row.' };
      }
      // Fingerprint FIRST — a same-key / different-(escrow,amount) is ALWAYS key
      // reuse (a client error), whether or not the prior request is still in flight.
      if (existing.escrowPda !== escrowPda || existing.amount !== amountStr) {
        return {
          ok: false,
          code: 'deposit_request_mismatch',
          message: 'requestId already used for a different deposit (escrow/amount fingerprint mismatch).',
        };
      }
      if (existing.status === 'in_flight') {
        return { ok: false, code: 'deposit_in_flight', message: 'an identical deposit request is already in flight.' };
      }
      // Terminal (succeeded | broadcast_unknown) — replay the recorded outcome, NO re-send.
      return { ok: true, chain: reconstructDepositChain(existing), replayed: true };
    }
    return { ok: false, code: 'internal', message: 'failed to claim deposit idempotency.' };
  }

  // We hold the claim — now (and only now) touch the chain. M2: the executor call
  // AND the outcome-persist UPDATEs are wrapped so a THROW never strands the claim
  // 'in_flight' forever (which would 409-brick every retry of this requestId).
  // R3-3 — capture any signature the executor surfaced BEFORE the persist, so a throw
  // during the persist still parks a reconcilable signature (not null).
  let sentSignature: string | null = null;
  try {
    const chain = await depositEscrowV2Usdc({
      depositorAvatarId: input.depositorAvatarId,
      workerWalletPubkey: input.workerWalletPubkey,
      escrowNonce: input.escrowNonce,
      amount: input.amount,
    });
    sentSignature = chain.ok === true ? (chain.dryRun ? null : chain.signature) : (chain.signature ?? null);

    if (chain.ok === true) {
      // Confirmed (live) — persist the terminal outcome for a faithful replay.
      await db
        .update(sapDepositRequests)
        .set({
          status: 'succeeded',
          signature: chain.dryRun ? null : chain.signature,
          outcomeAccounts: chain.dryRun ? null : chain.accounts,
          updatedAt: new Date(),
        })
        .where(eq(sapDepositRequests.id, claimId));
      return { ok: true, chain, replayed: false };
    }

    if (chain.broadcast) {
      // Broadcast-unknown — the deposit MAY have landed. Hold the claim terminal +
      // record the signature so a replay returns the same unconfirmed signal and
      // NEVER re-sends (mirrors funding_unknown). Reconcile-only.
      await db
        .update(sapDepositRequests)
        .set({
          status: 'broadcast_unknown',
          signature: chain.signature ?? null,
          failureCode: chain.code,
          updatedAt: new Date(),
        })
        .where(eq(sapDepositRequests.id, claimId));
      return { ok: true, chain, replayed: false };
    }

    // Pre-broadcast failure — nothing hit the wire. DELETE the claim so the SAME
    // requestId can be retried cleanly (documented contract: retry reuses the key).
    await db.delete(sapDepositRequests).where(eq(sapDepositRequests.id, claimId));
    return { ok: true, chain, replayed: false };
  } catch {
    // M2 — a throw AFTER the claim (executor bug, or a persist UPDATE) has UNKNOWN
    // timing relative to broadcast: the send MAY have landed. NEVER delete (that
    // would re-open the requestId → a retry could DOUBLE-FUND). Hold the claim
    // 'broadcast_unknown' (pessimistic, reconcile-only) so a replay returns the
    // recorded unconfirmed signal and never re-sends. Best-effort — if this UPDATE
    // itself throws, the row stays 'in_flight' (stuck, but still never double-funds).
    try {
      // R3-4 — canonical `internal` (in the SapFailure union), not off-contract
      // 'internal_error'. R3-3 — park the captured signature so a post-send DB blip
      // stays reconcilable.
      await db
        .update(sapDepositRequests)
        .set({ status: 'broadcast_unknown', failureCode: 'internal', signature: sentSignature, updatedAt: new Date() })
        .where(eq(sapDepositRequests.id, claimId));
    } catch {
      // swallow — the money invariant (no double-fund) holds regardless.
    }
    return {
      ok: false,
      code: 'internal',
      message: 'deposit outcome unknown after an internal error; the requestId is held for reconcile.',
    };
  }
}

// ─── 1c. V2 WITHDRAW — books the gate ledger (FIX 2b, doc line 623) ────────────

export interface WithdrawEscrowV2BookedInput {
  /** Depositor avatar — reclaims its OWN unspent (free) vault balance. */
  depositorAvatarId: string;
  workerWalletPubkey: string;
  escrowNonce: bigint;
  amount: bigint;
}

/**
 * FIX 2b (doc line 623) — book a V2 self-custody withdraw into the gate ledger.
 *
 * `/escrow/v2/withdraw` moves USDC vault→depositor ON-CHAIN. Without booking, the
 * gate's `escrowFundsLedger.remaining` overstates the vault, so a later settle
 * ceiling could be computed against funds that already left. This wraps
 * `withdrawEscrowV2Usdc` and records the drain into `sap_escrow_withdrawals`
 * (escrow-scoped) so the ledger subtracts it. Together with the live-vault clamp
 * inside the settle claim (FIX 2a), a settle can never reserve more than the vault
 * physically holds.
 *
 * DRY-RUN books nothing (it moves nothing on-chain) — identical to a direct
 * `withdrawEscrowV2Usdc` call, so the currently-reachable path is unchanged.
 */
export async function withdrawEscrowV2Booked(
  input: WithdrawEscrowV2BookedInput,
): Promise<SapWriteResult> {
  const cfg = sapConfigSnapshot();

  // DRY-RUN — no on-chain movement, so book nothing (mirror the convention).
  if (cfg.dryRun) {
    return withdrawEscrowV2Usdc(input);
  }

  // Resolve the escrow PDA for the escrow-scoped booking BEFORE the send (a bad
  // resolve must fail before touching the chain). depositorWalletPubkey is the
  // acting avatar's own wallet — the same pubkey withdrawEscrowV2Usdc signs with.
  const depositorWalletPubkey = await avatarWalletPubkey(input.depositorAvatarId);
  if (!depositorWalletPubkey) {
    return { ok: false, code: 'avatar_wallet_missing', message: 'depositor avatar has no custodial wallet.' };
  }
  const addr = resolveV2UsdcEscrowAddress({
    workerWalletPubkey: input.workerWalletPubkey,
    depositorWalletPubkey,
    escrowNonce: input.escrowNonce,
  });
  if (addr.ok === false) return addr;
  const escrowPda = addr.escrowPda.toBase58();

  const chain = await withdrawEscrowV2Usdc(input);

  // Book AFTER the outcome is known. The live-vault clamp inside the settle claim
  // is the authoritative physical guard, so a rare crash between a confirmed send
  // and this booking is covered there; this booking keeps the ledger truthful for
  // the common case + the clamp's RPC-read fallback.
  if (chain.ok === true && !chain.dryRun) {
    await db.insert(sapEscrowWithdrawals).values({
      escrowPda,
      subjectAvatarId: input.depositorAvatarId,
      escrowNonce: input.escrowNonce.toString(),
      amount: input.amount.toString(),
      status: 'succeeded',
      signature: chain.signature,
    });
  } else if (chain.ok === false && chain.broadcast) {
    // Broadcast-unknown — the withdraw MAY have moved funds. Book PESSIMISTICALLY
    // so the ledger fail-closes (never over-states the spendable vault).
    await db.insert(sapEscrowWithdrawals).values({
      escrowPda,
      subjectAvatarId: input.depositorAvatarId,
      escrowNonce: input.escrowNonce.toString(),
      amount: input.amount.toString(),
      status: 'broadcast_unknown',
      signature: chain.signature ?? null,
    });
  }
  // A pre-broadcast failure books nothing (nothing left the vault).
  return chain;
}

// ─── 2. SUBMIT ────────────────────────────────────────────────────────────────

/**
 * Record that the worker submitted the deliverable (open → submitted).
 *
 * AUTH (FIX 1): only the recorded WORKER may submit. The route forwards the
 * acting `identity.avatarId` as `callerAvatarId`; we load the row, assert the
 * caller IS the worker, and only then advance. Mirrors how approveJob (depositor)
 * and settleJob (worker) already bind the caller — without this, ANY authed
 * party could flip someone else's escrow to `submitted`.
 */
export async function submitJob(input: {
  escrowPda: string;
  jobId: string;
  /** The avatar ACTING on the submit — MUST be the recorded worker. */
  callerAvatarId: string;
}): Promise<EscrowGateResult> {
  const gated = gateOpen();
  if (gated) return gated;

  // Load the row FIRST so we can bind the caller before mutating anything.
  const existing = await db.query.sapEscrowSettlements.findFirst({
    where: and(
      eq(sapEscrowSettlements.escrowPda, input.escrowPda),
      eq(sapEscrowSettlements.jobId, input.jobId),
    ),
  });
  if (!existing) {
    return { ok: false, code: 'job_not_found', message: 'no settlement row for (escrow, job).' };
  }
  // Only the worker (the party who DID the work) may record a submission.
  if (existing.workerAvatarId !== input.callerAvatarId) {
    return {
      ok: false,
      code: 'unauthorized_caller',
      message: 'only the escrow worker (settle beneficiary) can submit this job.',
    };
  }

  // Only advance from `open`. A no-op on a non-open row (re-submit) is benign;
  // we re-read and return the current row.
  await db
    .update(sapEscrowSettlements)
    .set({ status: 'submitted', updatedAt: new Date() })
    .where(
      and(
        eq(sapEscrowSettlements.escrowPda, input.escrowPda),
        eq(sapEscrowSettlements.jobId, input.jobId),
        eq(sapEscrowSettlements.status, 'open'),
      ),
    );
  const row = await db.query.sapEscrowSettlements.findFirst({
    where: and(
      eq(sapEscrowSettlements.escrowPda, input.escrowPda),
      eq(sapEscrowSettlements.jobId, input.jobId),
    ),
  });
  if (!row) return { ok: false, code: 'job_not_found', message: 'no settlement row for (escrow, job).' };
  return { ok: true, phase: 'submitted', settlement: row };
}

// ─── 2b. APPROVE (depositor-authenticated; BLOCKING #1 fix) ────────────────────

export interface ApproveJobInput {
  escrowPda: string;
  jobId: string;
  /**
   * The avatar ACTING on the approve (the caller's bound avatar). Rule E5 + the
   * BLOCKING #1 fix: ONLY the escrow's recorded depositor (the funds owner) may
   * approve. The route already asserts `identity.avatarId === depositorAvatarId`;
   * we re-assert here on the money path (defense-in-depth).
   */
  callerAvatarId: string;
  /**
   * Optional cap on the calls this approval authorizes for release (u64). Omitted
   * ⇒ approve the job's full `maxCalls`. The settle path clamps `callsToSettle` to
   * AT MOST this (in addition to the maxCalls + vault-balance bounds).
   */
  approvedCalls?: bigint;
}

/**
 * Persist the depositor's AUTHENTICATED approval for (escrow, job). This is the
 * ONLY thing that authorizes a settle — the settle path reads THIS row, never a
 * request-body claim. Replaces the forgeable request-body `approval` object.
 *
 * The caller MUST be the recorded depositor. A re-approve UPSERTs (same (escrow,
 * job) key) so exactly one authoritative approval exists. The approval can only be
 * recorded while the job is still releasable (`open|submitted`) — not after a
 * settle/refund/failure or while a settle is mid-flight.
 */
export async function approveJob(input: ApproveJobInput): Promise<EscrowGateResult> {
  const gated = gateOpen();
  if (gated) return gated;

  const row = await db.query.sapEscrowSettlements.findFirst({
    where: and(
      eq(sapEscrowSettlements.escrowPda, input.escrowPda),
      eq(sapEscrowSettlements.jobId, input.jobId),
    ),
  });
  if (!row) {
    return { ok: false, code: 'job_not_found', message: 'no settlement row for (escrow, job).' };
  }
  // V2 inserts its durable open claim before funding. Refuse approval during
  // that zero-funded window so an approval cannot outlive a clean-delete/reopen.
  if (row.escrowVersion === 'v2' && u64(row.fundedAmount) === 0n) {
    return { ok: false, code: 'job_not_open', message: 'V2 escrow funding has not completed; approval is not yet allowed.' };
  }
  // ONLY the depositor (funds owner) may approve a release of their own escrow.
  if (row.depositorAvatarId !== input.callerAvatarId) {
    return {
      ok: false,
      code: 'approver_mismatch',
      message: 'only the escrow depositor (requester) can approve a release.',
    };
  }

  // Belt-and-suspenders: never let the depositor approve a release to itself.
  if (row.workerAvatarId === row.depositorAvatarId) {
    return {
      ok: false,
      code: 'self_dealing_forbidden',
      message: 'depositor and worker are the same avatar; self-dealing release forbidden.',
    };
  }

  // Only approve a job that is still releasable. A terminal/in-flight row cannot
  // gain a fresh approval (no approving an already-settled/refunded/failed job, or
  // racing an in-flight settle/refund claim).
  if (row.status !== 'open' && row.status !== 'submitted') {
    return {
      ok: false,
      code: 'job_not_open',
      message: `job is ${row.status}; cannot approve.`,
    };
  }

  // Validate the optional cap against the job's authorized ceiling.
  const maxCalls = u64(row.maxCalls);
  const approvedCalls = input.approvedCalls;
  if (approvedCalls !== undefined) {
    if (approvedCalls <= 0n) {
      return { ok: false, code: 'over_release', message: 'approvedCalls must be > 0.' };
    }
    if (maxCalls > 0n && approvedCalls > maxCalls) {
      return {
        ok: false,
        code: 'over_release',
        message: `approvedCalls (${approvedCalls}) exceeds the job's maxCalls (${maxCalls}).`,
      };
    }
  }

  const approvedCallsStr = approvedCalls !== undefined ? approvedCalls.toString() : null;

  // UPSERT on (escrow_pda, job_id) — one authoritative approval per job.
  await db
    .insert(sapEscrowApprovals)
    .values({
      escrowPda: input.escrowPda,
      jobId: input.jobId,
      approverAvatarId: row.depositorAvatarId,
      workerAvatarId: row.workerAvatarId,
      approvedCalls: approvedCallsStr,
    })
    .onConflictDoUpdate({
      target: [sapEscrowApprovals.escrowPda, sapEscrowApprovals.jobId],
      set: { approvedCalls: approvedCallsStr, approvedAt: new Date() },
    });

  return { ok: true, phase: 'approved', settlement: row, approvedCalls: approvedCallsStr };
}

// ─── 3+4. VERIFY + SETTLE (atomic, at-most-once) ──────────────────────────────

export interface SettleJobInput {
  escrowPda: string;
  jobId: string;
  /**
   * The avatar ACTING on the settle (the caller's bound avatar). Rule E5: the
   * worker settles AS ITSELF, so this MUST equal the recorded `workerAvatarId`.
   * The gate asserts it (defense-in-depth) so a non-worker caller can't drive a
   * settle of someone else's escrow even though the on-chain signer is always the
   * recorded worker.
   */
  callerAvatarId: string;
  /**
   * u64 calls the worker REQUESTS to release. This is an UPPER REQUEST, not a
   * trusted amount: the gate clamps/rejects it server-side (BLOCKING #2/#3)
   * against the job's `maxCalls`, the depositor's persisted `approvedCalls`, and
   * the escrow's remaining funded balance.
   */
  callsToSettle: bigint;
  /**
   * @deprecated BLOCKING #1 — IGNORED. The verification signal is built
   * SERVER-SIDE from the PERSISTED depositor approval (`sap_escrow_approvals`),
   * NEVER from a request body. A worker can no longer forge an approval. Kept on
   * the type only so any legacy caller compiles; the value is discarded.
   */
  verificationSignal?: Record<string, unknown>;
  /** Provider override (defaults to the v1 requester-approval provider). */
  provider?: VerificationProvider;
}

/**
 * Verify the job, and ONLY on a passing verdict, atomically claim + release the
 * escrow exactly once.
 *
 * BLOCKING #1 — the verification signal is read from the PERSISTED depositor
 * approval, NOT from the caller. The worker (who profits) can no longer fabricate
 * an approval object to self-release.
 *
 * BLOCKING #2/#3 — `callsToSettle` is clamped/rejected server-side against the
 * job's `maxCalls`, the depositor's `approvedCalls`, and the escrow's remaining
 * funded balance (the cross-job accounting ledger), so no settle can over-release
 * or drain USDC earmarked for a sibling job.
 *
 * Idempotency: the chain settle is reached ONLY if a conditional UPDATE flips the
 * row from a non-terminal state (`open|submitted`) to `settling` and affects
 * exactly ONE row. A concurrent/retried caller that finds the row already
 * `settling` or `settled` short-circuits — `settled` returns the cached result
 * (replay=true); `settling` returns `settle_in_progress`. The chain call only
 * happens after the claim, so two callers can never both release.
 */
export async function settleJob(input: SettleJobInput): Promise<EscrowGateResult> {
  const gated = gateOpen();
  if (gated) return gated;

  // FIX 3 — serialize the ENTIRE read-ledger → claim → chain → book window per
  // escrowPda within this process. Concurrent sibling settles (different jobIds
  // sharing the same nonce-less vault) would otherwise interleave: both could read
  // the same `escrowFundsLedger.remaining`, both clamp under it, and both
  // broadcast — the per-job bound prevents a real double-drain, but the aggregate
  // ledger check would be racy. The mutex makes it strictly one-at-a-time in this
  // process; the `pg_advisory_xact_lock` inside the claim txn covers cross-process.
  return withKeyedMutex(escrowMutexKey(input.escrowPda), () => settleJobLocked(input));
}

/** The serialized settle body — only ever entered under the per-escrow mutex. */
async function settleJobLocked(input: SettleJobInput): Promise<EscrowGateResult> {
  const provider = input.provider ?? defaultVerificationProvider;

  // Load the row (we need both parties + wallet pubkeys + current status).
  const row = await db.query.sapEscrowSettlements.findFirst({
    where: and(
      eq(sapEscrowSettlements.escrowPda, input.escrowPda),
      eq(sapEscrowSettlements.jobId, input.jobId),
    ),
  });
  if (!row) {
    return { ok: false, code: 'job_not_found', message: 'no settlement row for (escrow, job).' };
  }

  if ((row.escrowVersion ?? 'v1') !== 'v1') {
    return { ok: false, code: 'job_not_open', message: 'V2 rows must use the two-phase V2 settle path.' };
  }

  // Rule E5 — the worker settles AS ITSELF. The acting caller MUST be the
  // recorded worker. (The on-chain signer is always `row.workerAvatarId`'s wallet
  // regardless, but binding the caller here stops a non-worker from driving a
  // settle of someone else's escrow.)
  // FIX 5 — this is an AUTHORIZATION refusal (the caller is not the worker), NOT a
  // lifecycle conflict. Return a distinct `unauthorized_caller` (403), not the
  // misleading `job_not_open` (409) which implied the job was in a bad state.
  if (row.workerAvatarId !== input.callerAvatarId) {
    return { ok: false, code: 'unauthorized_caller', message: 'only the worker (settle beneficiary) can settle this job.' };
  }

  // Terminal/already-claimed short-circuits BEFORE running verification (cheap).
  if (row.status === 'settled') {
    // Idempotent replay — the prior outcome lives on the row
    // (`settleSignature`/`dryRun`). No fabricated chain object.
    return { ok: true, phase: 'settled', settlement: row, chain: null, replay: true };
  }
  if (row.status === 'settling') {
    return { ok: false, code: 'settle_in_progress', message: 'a settle is already in progress for this job.' };
  }
  if (row.status === 'refunding') {
    // BLOCKING #4 — a refund holds the claim; never let a settle broadcast against
    // an escrow with an in-flight withdraw.
    return { ok: false, code: 'refund_in_progress', message: 'a refund is in progress for this job; cannot settle.' };
  }
  if (row.status === 'funding_unknown') {
    // BLOCKING #5 — the fund tx was broadcast but never confirmed; the vault state
    // is unknown. Never release until a reconciler resolves it.
    return { ok: false, code: 'funding_unconfirmed', message: 'job funding is unconfirmed; cannot settle until reconciled.' };
  }
  if (row.status === 'refunded' || row.status === 'failed') {
    return { ok: false, code: 'job_not_open', message: `job is ${row.status}; cannot settle.` };
  }

  // ── RAIL DISPATCH — from the ROW's recorded rail, never the live env flag ────
  // (conservation keystone: the rail chosen at open is the only rail that can
  // ever move this job's money). A payai row whose rail flag has since been
  // turned OFF fails closed HERE — cheap, pre-claim, never a fallback to the
  // on-chain vault (which was never funded for a payai job).
  const rail = settlementRail(row);
  if (rail === 'payai' && !sapConfigSnapshot().payaiSettlementEnabled) {
    return {
      ok: false,
      code: 'payai_rail_disabled',
      message:
        'this job settles on the PayAI x402 rail, which is disabled ' +
        '(SAP_PAYAI_SETTLEMENT_ENABLED); re-enable the rail to settle.',
    };
  }

  // BLOCKING #1 — READ the depositor's PERSISTED approval. The verification signal
  // is built SERVER-SIDE from this row; the caller's `verificationSignal` is
  // IGNORED. No persisted approval ⇒ no settle (the worker cannot forge one).
  const approval = await db.query.sapEscrowApprovals.findFirst({
    where: and(
      eq(sapEscrowApprovals.escrowPda, input.escrowPda),
      eq(sapEscrowApprovals.jobId, input.jobId),
    ),
  });
  if (!approval) {
    return {
      ok: false,
      code: 'not_approved',
      message: 'the depositor has not approved this job; no settle (call POST /escrow/usdc/approve as the depositor).',
    };
  }
  // Defense-in-depth: the persisted approver MUST be the recorded depositor, and
  // the depositor must not equal the worker (self-dealing). These are invariants
  // the approve path already enforces; re-assert before releasing real money.
  if (approval.approverAvatarId !== row.depositorAvatarId) {
    return { ok: false, code: 'approver_mismatch', message: 'persisted approval approver is not the escrow depositor.' };
  }
  if (row.depositorAvatarId === row.workerAvatarId) {
    return { ok: false, code: 'self_dealing_forbidden', message: 'depositor and worker are the same avatar; refusing to settle.' };
  }

  // ── BLOCKING #2 + #3 — clamp the requested release SERVER-SIDE ────────────────
  // The settleable ceiling is the MIN of:
  //   (a) the job's remaining authorized calls: maxCalls − callsAlreadySettled,
  //   (b) the depositor's approved calls (if the approval set a cap),
  //   (c) the calls the escrow's remaining funded balance can pay for:
  //         floor(remainingVault / pricePerCall).
  // A worker-requested `callsToSettle` over this ceiling is REJECTED (not silently
  // truncated — an over-request is a protocol error / attack signal).
  const pricePerCall = u64(row.pricePerCall);
  if (pricePerCall <= 0n) {
    return { ok: false, code: 'internal', message: 'escrow has no valid pricePerCall.' };
  }
  if (input.callsToSettle <= 0n) {
    return { ok: false, code: 'over_release', message: 'callsToSettle must be > 0.' };
  }

  const maxCalls = u64(row.maxCalls);
  const alreadySettled = u64(row.callsSettled);

  // The escrow-wide accounting ledger (sum funded/released/refunded across ALL
  // jobs sharing this vault) gives the remaining spendable balance. The per-job
  // funded portion bounds this job's own releases so a worker can't drain USDC the
  // depositor funded for a SIBLING job.
  const ledger = await escrowFundsLedger(input.escrowPda);
  const jobFunded = u64(row.fundedAmount);
  const jobReleased = u64(row.releasedAmount);
  const jobRemainingFunded = jobFunded > jobReleased ? jobFunded - jobReleased : 0n;

  const ceiling = computeSettleCeiling({
    maxCalls,
    callsAlreadySettled: alreadySettled,
    approvedCalls: u64(approval.approvedCalls), // 0n ⇒ no explicit cap (full job)
    pricePerCall,
    escrowRemaining: ledger.remaining,
    jobRemainingFunded,
  });

  if (ceiling <= 0n || input.callsToSettle > ceiling) {
    return {
      ok: false,
      code: 'over_release',
      message:
        `requested ${input.callsToSettle} calls exceeds the settleable ceiling ${ceiling} ` +
        `(maxCalls=${maxCalls}, settled=${alreadySettled}, approved=${u64(approval.approvedCalls)}, ` +
        `escrowRemaining=${ledger.remaining}, jobRemainingFunded=${jobRemainingFunded}, price=${pricePerCall}).`,
    };
  }

  // The USDC base units this settle will release (for the accounting ledger).
  const releaseAmount = input.callsToSettle * pricePerCall;

  // (3) VERIFY — run the pluggable provider over the SERVER-BUILT signal derived
  // from the persisted approval. Settle ONLY on passed===true.
  const ctx: VerificationJobContext = {
    escrowId: row.escrowPda,
    jobId: row.jobId,
    depositorAvatarId: row.depositorAvatarId,
    workerAvatarId: row.workerAvatarId,
    signal: {
      approved: true,
      approverAvatarId: approval.approverAvatarId,
      approvedAt: approval.approvedAt.toISOString(),
    },
  };
  const verdict = await provider.verify(ctx);
  const auth = evaluateSettleAuthorization(verdict);

  if (!auth.authorized) {
    // Persist the FAILING-verdict provenance — ONLY when the verdict itself
    // failed (a malformed-audit-root refusal is an integrity guard, not a verdict
    // outcome, and writes no provenance) and ONLY on a still-non-terminal row, so
    // a late failing-verdict write can never clobber a row another caller already
    // flipped to settling/settled/failed/refunded. (For the SAME job + signal two
    // callers can't diverge on pass/fail; this is belt-and-suspenders.)
    if (!verdict.passed) {
      await db
        .update(sapEscrowSettlements)
        .set({
          verificationProvider: provider.id,
          verificationPassed: false,
          verificationDetail: verdict.detail ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sapEscrowSettlements.id, row.id),
            sql`${sapEscrowSettlements.status} IN ('open','submitted')`,
          ),
        );
    }
    return { ok: false, code: 'verification_failed', message: auth.reason };
  }

  // Authorized: the verdict passed with a validated 32-byte non-zero root.
  // `auditRootHex` binds the payai rail (x402 `extra`); the raw bytes bind the
  // on-chain rail (`settle_calls` `service_hash`).
  const auditRootHex = auth.auditRootHex;
  const auditRoot = verdict.auditRoot;

  // ── payai rail: PREPARE the x402 payment BEFORE the claim ────────────────────
  // Everything fallible that moves NO money (gate/facilitator/fee-payer checks,
  // custodial decrypt + payload signing) runs pre-claim: a failure here returns
  // a clean structured error and leaves the row untouched + retryable, instead
  // of bricking it terminal-`failed`. Only the facilitator verify→settle (the
  // actual money movement) runs after the claim.
  let payaiPrep: PreparedPayaiRelease | null = null;
  if (rail === 'payai') {
    const prep = await preparePayaiRelease({
      depositorAvatarId: row.depositorAvatarId,
      workerWalletPubkey: row.workerWalletPubkey,
      amountBaseUnits: releaseAmount,
      jobId: row.jobId,
      auditRootHex,
    });
    if (prep.ok === false) {
      return { ok: false, code: prep.code, message: prep.message };
    }
    payaiPrep = prep;
  }

  // (4a) ATOMIC CLAIM — flip open|submitted → settling for THIS row only, AND
  // re-confirm the escrow-wide ledger can still pay, all UNDER a cross-process
  // advisory lock (FIX 3). The conditional WHERE on status is the at-most-once
  // lock: a second concurrent settle that already lost the race updates 0 rows.
  // We do NOT yet advance `callsSettled`/`releasedAmount` here — those are booked
  // on the SUCCESS path (4c) so a chain-failed settle never inflates the
  // per-job/per-escrow ledger.
  //
  // The `pg_advisory_xact_lock(hashtext(escrowPda))` serializes the
  // re-read-ledger → claim across PROCESSES (the in-process mutex covers this
  // worker; the advisory lock covers a second API instance). Inside the txn we
  // RE-READ the funds ledger AFTER acquiring the lock and ABORT if a sibling
  // settle that committed first has drawn the vault below this release — closing
  // the racy-aggregate window the per-job bound alone didn't cover.
  const claimResult = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.escrowPda}, 0))`,
    );

    // Re-read the escrow-wide ledger UNDER the lock. A sibling settle/refund that
    // committed between our earlier read and here is now visible.
    const lockedLedgerRows = await tx
      .select({
        status: sapEscrowSettlements.status,
        fundedAmount: sapEscrowSettlements.fundedAmount,
        releasedAmount: sapEscrowSettlements.releasedAmount,
        refundedAmount: sapEscrowSettlements.refundedAmount,
      })
      .from(sapEscrowSettlements)
      .where(eq(sapEscrowSettlements.escrowPda, input.escrowPda));
    let lFunded = 0n;
    let lReleased = 0n;
    let lRefunded = 0n;
    for (const r of lockedLedgerRows) {
      if (r.status === 'settle_unknown') continue;
      if (r.status !== 'funding_unknown') lFunded += u64(r.fundedAmount);
      lReleased += u64(r.releasedAmount);
      lRefunded += u64(r.refundedAmount);
    }
    const lockedRemaining = lFunded - lReleased - lRefunded;
    if (lockedRemaining < releaseAmount) {
      // A sibling settle won the race and drew the vault below this release.
      // Abort WITHOUT claiming (the txn commits with no row mutated).
      return { kind: 'ledger_short' as const, remaining: lockedRemaining };
    }

    const claimed = await tx
      .update(sapEscrowSettlements)
      .set({
        status: 'settling',
        verificationProvider: provider.id,
        verificationPassed: true,
        verificationDetail: verdict.detail ?? null,
        auditRootHex,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sapEscrowSettlements.id, row.id),
          sql`${sapEscrowSettlements.status} IN ('open','submitted')`,
        ),
      )
      .returning({ id: sapEscrowSettlements.id });
    return { kind: 'claimed' as const, count: claimed.length };
  });

  if (claimResult.kind === 'ledger_short') {
    return {
      ok: false,
      code: 'over_release',
      message:
        `escrow vault was drawn below this release by a concurrent settle/refund ` +
        `(escrowRemaining=${claimResult.remaining}, need=${releaseAmount}); retry with a smaller amount.`,
    };
  }

  if (claimResult.count !== 1) {
    // Lost the race — someone else claimed it between our read and the update.
    // Re-read to report the precise state.
    const cur = await db.query.sapEscrowSettlements.findFirst({
      where: eq(sapEscrowSettlements.id, row.id),
    });
    if (cur?.status === 'settled') {
      return { ok: true, phase: 'settled', settlement: cur, chain: null, replay: true };
    }
    return { ok: false, code: 'settle_in_progress', message: 'a settle is already in progress for this job.' };
  }

  // ── (4b-payai) PAYAI SETTLE — the x402 payment through the facilitator ───────
  // Reached by AT MOST ONE caller (we hold the `settling` claim — the SAME
  // at-most-once lock that guards the on-chain rail guards this one). The
  // depositor-signed payment prepared above is verified and settled by the
  // PayAI facilitator (dry-run = VERIFY-only, no /settle, no money). This is
  // the job's ONLY money movement — the vault leg never ran for a payai row.
  if (rail === 'payai') {
    const outcome = await executePayaiRelease(payaiPrep!, {
      dryRun: sapConfigSnapshot().dryRun,
    });

    if (outcome.ok === false) {
      // Failed AFTER the claim. Terminal `failed` — the exact posture of the
      // on-chain rail: when the facilitator verify passed, a /settle was
      // ATTEMPTED and may have landed (broadcastUnknown) — auto-retrying could
      // double-pay; a human/reconciler inspects the facilitator + chain. A
      // verify-stage failure provably submitted nothing, but stays terminal
      // too (no auto-retry on the money path); the operator re-drive handle
      // (admin re-settle) is the recovery, mirroring the on-chain rail.
      await db
        .update(sapEscrowSettlements)
        .set({
          status: 'failed',
          updatedAt: new Date(),
          metadata: {
            ...((row.metadata as object) ?? {}),
            settleError: outcome.code,
            payaiFailure: outcome.message,
            settleBroadcastUnconfirmed: outcome.broadcastUnknown,
          },
        })
        .where(eq(sapEscrowSettlements.id, row.id));
      return { ok: false, code: outcome.code, message: outcome.message };
    }

    // Success — book the ledger exactly like the on-chain rail (4c): terminal
    // `settled`, calls + released accumulated so the per-job/per-PDA invariants
    // hold for any sibling job. The facilitator tx signature IS the settle
    // signature (a real on-chain USDC transfer, submitted by the facilitator).
    const payaiSignature = outcome.dryRun ? null : outcome.signature;
    const [settledPayai] = await db
      .update(sapEscrowSettlements)
      .set({
        status: 'settled',
        callsSettled: (alreadySettled + input.callsToSettle).toString(),
        releasedAmount: (jobReleased + releaseAmount).toString(),
        settleSignature: payaiSignature,
        dryRun: outcome.dryRun,
        settledAt: new Date(),
        updatedAt: new Date(),
        metadata: {
          ...((row.metadata as object) ?? {}),
          payaiFeePayer: payaiPrep!.feePayer,
          // Audit only — pubkeys, never secrets. The facilitator-reported payer
          // (when present) cross-checks the depositor custodial pubkey we signed as.
          payaiPayer: outcome.payer ?? payaiPrep!.payerPubkey,
        },
      })
      .where(eq(sapEscrowSettlements.id, row.id))
      .returning();

    return {
      ok: true,
      phase: 'settled',
      settlement: settledPayai,
      chain: null,
      payai: { dryRun: outcome.dryRun, signature: payaiSignature },
      replay: false,
    };
  }

  // (4b) CHAIN SETTLE — release vault → worker ATA. Reached by AT MOST ONE caller
  // (we hold the `settling` claim). The worker avatar signs as itself.
  const chain = await settleCallsUsdc({
    workerAvatarId: row.workerAvatarId,
    depositorWalletPubkey: row.depositorWalletPubkey,
    callsToSettle: input.callsToSettle,
    auditRoot,
  });

  if (chain.ok === false) {
    // Chain failed AFTER the claim. Mark `failed` (terminal) — do NOT auto-retry.
    // A send whose confirmation we never saw could have landed; re-releasing
    // would double-pay. A human must inspect the chain + decide. (BLOCKING #5
    // parity — if the failure carries `broadcast`, record the signature so the
    // reconciler knows a settle MAY have released; we still leave it `failed`,
    // never auto-retried.)
    await db
      .update(sapEscrowSettlements)
      .set({
        status: 'failed',
        settleSignature: chain.broadcast ? (chain.signature ?? null) : null,
        updatedAt: new Date(),
        metadata: {
          ...((row.metadata as object) ?? {}),
          settleError: chain.code,
          settleBroadcastUnconfirmed: chain.broadcast === true,
        },
      })
      .where(eq(sapEscrowSettlements.id, row.id));
    return { ok: false, code: chain.code, message: chain.message };
  }

  // (4c) Success — flip to settled (terminal) + BOOK the accounting ledger:
  // accumulate this job's settled-calls + released-USDC so the per-job and
  // escrow-wide invariants (BLOCKING #2/#3) hold for any sibling/subsequent settle.
  const settleSignature = chain.dryRun ? null : chain.signature;
  const newCallsSettled = (alreadySettled + input.callsToSettle).toString();
  const newReleasedAmount = (jobReleased + releaseAmount).toString();
  const [settled] = await db
    .update(sapEscrowSettlements)
    .set({
      status: 'settled',
      callsSettled: newCallsSettled,
      releasedAmount: newReleasedAmount,
      settleSignature: settleSignature ?? null,
      dryRun: chain.dryRun,
      settledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(sapEscrowSettlements.id, row.id))
    .returning();

  return { ok: true, phase: 'settled', settlement: settled, chain, replay: false };
}

/** Injected dependencies for `settleJobV2` (test seam; production uses defaults). */
export interface SettleJobV2Deps {
  /**
   * FIX 2a (doc line 623) — the LIVE on-chain vault-balance reader used to clamp
   * the settle ceiling. Production omits it (defaults to
   * `readV2VaultBalanceBaseUnits`); tests inject a deterministic fake, mirroring
   * the coverage-preflight reader seam. Returns the vault USDC base units, or NULL
   * on any read failure → the claim falls back to the ledger ceiling (never rejects).
   */
  readVaultBalance?: (args: {
    workerWalletPubkey: string;
    depositorWalletPubkey: string;
    escrowNonce: bigint;
  }) => Promise<bigint | null>;
}

/** V2 settle: authorize exactly like V1, then reserve principal in PendingSettlement. */
export async function settleJobV2(
  input: SettleJobInput,
  deps: SettleJobV2Deps = {},
): Promise<EscrowGateResult> {
  const gated = gateOpen();
  if (gated) return gated;
  return withKeyedMutex(escrowMutexKey(input.escrowPda), async () => {
    const provider = input.provider ?? defaultVerificationProvider;
    const row = await db.query.sapEscrowSettlements.findFirst({
      where: and(eq(sapEscrowSettlements.escrowPda, input.escrowPda), eq(sapEscrowSettlements.jobId, input.jobId)),
    });
    if (!row) return { ok: false, code: 'job_not_found', message: 'no settlement row for (escrow, job).' };
    if (row.escrowVersion !== 'v2' || row.escrowNonce == null) {
      return { ok: false, code: 'job_not_open', message: 'this row is not a V2 escrow.' };
    }
    if (settlementRail(row) !== 'onchain') {
      return { ok: false, code: 'release_rail_forbidden', message: 'V2 settle is onchain-only; payai rows are refused.' };
    }
    if (row.workerAvatarId !== input.callerAvatarId) {
      return { ok: false, code: 'unauthorized_caller', message: 'only the worker (settle beneficiary) can settle this job.' };
    }
    if (row.status === 'settled') return { ok: true, phase: 'settled', settlement: row, chain: null, replay: true };
    if (row.status === 'pending') return { ok: true, phase: 'pending', settlement: row, chain: null, replay: true, next: 'finalize' };
    if (row.status === 'settling') return { ok: false, code: 'settle_in_progress', message: 'a settle is already in progress for this job.' };
    if (row.status === 'settle_unknown') return { ok: false, code: 'settle_unconfirmed', message: 'settle broadcast is unconfirmed; reconcile it and never auto-retry.' };
    if (row.status === 'finalizing') return { ok: false, code: 'finalize_in_progress', message: 'finalize is already in progress.' };
    if (row.status === 'finalize_unknown') return { ok: false, code: 'finalize_unconfirmed', message: 'finalize broadcast is unconfirmed; reconcile it and never auto-retry.' };
    if (row.status === 'refunding') return { ok: false, code: 'refund_in_progress', message: 'a refund is in progress for this job; cannot settle.' };
    if (row.status === 'funding_unknown') return { ok: false, code: 'funding_unconfirmed', message: 'job funding is unconfirmed; cannot settle until reconciled.' };
    if (row.status === 'refunded' || row.status === 'failed') return { ok: false, code: 'job_not_open', message: `job is ${row.status}; cannot settle.` };

    // The row is now guaranteed 'open' | 'submitted'. Capture it BEFORE any claim so
    // M3/M4 can restore the exact pre-claim status when a claimed settle must
    // un-claim (the in-memory `row` object may be mutated by the claim UPDATE).
    const preClaimStatus = row.status;

    const approval = await db.query.sapEscrowApprovals.findFirst({
      where: and(eq(sapEscrowApprovals.escrowPda, input.escrowPda), eq(sapEscrowApprovals.jobId, input.jobId)),
    });
    if (!approval) return { ok: false, code: 'not_approved', message: 'the depositor has not approved this job; no settle.' };
    if (approval.approverAvatarId !== row.depositorAvatarId) return { ok: false, code: 'approver_mismatch', message: 'persisted approval approver is not the escrow depositor.' };
    if (row.depositorAvatarId === row.workerAvatarId) return { ok: false, code: 'self_dealing_forbidden', message: 'depositor and worker are the same avatar; refusing to settle.' };

    const pricePerCall = u64(row.pricePerCall);
    if (pricePerCall <= 0n) return { ok: false, code: 'internal', message: 'escrow has no valid pricePerCall.' };
    if (input.callsToSettle <= 0n) return { ok: false, code: 'over_release', message: 'callsToSettle must be > 0.' };
    const maxCalls = u64(row.maxCalls);
    const alreadySettled = u64(row.callsSettled);
    const ledger = await escrowFundsLedger(input.escrowPda);
    const jobFunded = u64(row.fundedAmount);
    const jobReleased = u64(row.releasedAmount);
    const jobReserved = u64(row.reservedPrincipalAmount);
    const jobFees = u64(row.feeAmount);
    const jobConsumed = jobReleased + jobReserved + jobFees;
    const jobRemainingFunded = jobFunded > jobConsumed ? jobFunded - jobConsumed : 0n;
    const ceiling = computeSettleCeiling({
      maxCalls,
      callsAlreadySettled: alreadySettled,
      approvedCalls: u64(approval.approvedCalls),
      pricePerCall,
      escrowRemaining: ledger.remaining,
      jobRemainingFunded,
    });
    const principal = input.callsToSettle * pricePerCall;
    const fee = computeV2ProtocolFee(principal);
    const totalDebit = principal + fee;
    if (ceiling <= 0n || input.callsToSettle > ceiling || totalDebit > ledger.remaining || totalDebit > jobRemainingFunded) {
      return { ok: false, code: 'over_release', message: `requested ${input.callsToSettle} calls exceeds the V2 settleable ceiling ${ceiling} or funded fee headroom.` };
    }

    const verdict = await provider.verify({
      escrowId: row.escrowPda,
      jobId: row.jobId,
      depositorAvatarId: row.depositorAvatarId,
      workerAvatarId: row.workerAvatarId,
      signal: { approved: true, approverAvatarId: approval.approverAvatarId, approvedAt: approval.approvedAt.toISOString() },
    });
    const auth = evaluateSettleAuthorization(verdict);
    if (!auth.authorized) {
      if (!verdict.passed) await db.update(sapEscrowSettlements).set({
        verificationProvider: provider.id, verificationPassed: false,
        verificationDetail: verdict.detail ?? null, updatedAt: new Date(),
      }).where(and(eq(sapEscrowSettlements.id, row.id), sql`${sapEscrowSettlements.status} IN ('open','submitted')`));
      return { ok: false, code: 'verification_failed', message: auth.reason };
    }

    const nonce = u64(row.escrowNonce);
    const inspected = await inspectV2SettlementState({
      workerWalletPubkey: row.workerWalletPubkey,
      depositorWalletPubkey: row.depositorWalletPubkey,
      escrowNonce: nonce,
    });
    if (inspected.ok === false) return { ok: false, code: inspected.code, message: inspected.message };
    if (inspected.escrowPda !== row.escrowPda) return { ok: false, code: 'internal', message: 'persisted V2 escrow PDA does not match derived coordinates.' };
    if (inspected.pendingExists) {
      // FIX 3 (doc line 624) — a PendingSettlement PDA already exists for this index.
      // Book the DECODED on-chain principal/calls, NEVER the caller's requested numbers.
      // A decode gap is a retryable failure (book nothing) — `inspectV2SettlementState`
      // returns a `SapFailure` on decode/RPC error, but guard defensively too.
      if (!inspected.pending) {
        return { ok: false, code: 'on_chain_error', message: 'on-chain pending settlement could not be decoded; retry.' };
      }
      const p = inspected.pending;
      // M4 (a) — a DISPUTED pending must never auto-book (finalize is on-chain-blocked;
      // ops must resolve). Books nothing, row untouched (open|submitted), retryable.
      // No lock needed — it mutates no state.
      if (p.isDisputed) {
        return { ok: false, code: 'on_chain_error', message: 'on-chain pending is disputed; manual resolution required.' };
      }
      const decodedPrincipal = p.amount;
      const decodedCalls = p.callsToSettle;
      const decodedFee = computeV2ProtocolFee(decodedPrincipal);
      const targetIndex = inspected.settlementIndex.toString();
      // A2 — advisory-lock + sibling guard + book, ALL in one transaction so the
      // check-then-book is atomic across processes (the in-process keyed mutex already
      // serializes same-escrow settles here). Without this, two instances — or a
      // sibling job row that sees the same on-chain pending — could double-book it.
      const reconcile = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.escrowPda}, 0))`);
        if (await siblingOwnsPendingIndex(tx, input.escrowPda, row.id, targetIndex)) {
          return { kind: 'sibling' as const };
        }
        if (p.isFinalized) {
          // M4 (b) — already FINALIZED on-chain (the account survives finalize with
          // isFinalized=true — verified). Booking 'pending' would send finalizeJobV2
          // at an already-finalized settlement that reverts forever. Reconcile TERMINAL
          // 'settled' with the principal booked RELEASED (never reserved — we never
          // reserved it), so finalize never runs and conservation holds.
          const [settled] = await tx.update(sapEscrowSettlements).set({
            status: 'settled', settlementIndex: targetIndex,
            callsSettled: (alreadySettled + decodedCalls).toString(),
            releasedAmount: (jobReleased + decodedPrincipal).toString(),
            reservedPrincipalAmount: jobReserved.toString(),
            feeAmount: (jobFees + decodedFee).toString(),
            verificationProvider: provider.id, verificationPassed: true, verificationDetail: verdict.detail ?? null,
            auditRootHex: auth.auditRootHex, settledAt: new Date(), updatedAt: new Date(),
            metadata: { ...((row.metadata as object) ?? {}), replayReconciledFromPendingPda: true, reconciledFinalized: true },
          }).where(and(eq(sapEscrowSettlements.id, row.id), sql`${sapEscrowSettlements.status} IN ('open','submitted')`)).returning();
          return { kind: 'settled' as const, row: settled };
        }
        // M4 (c) — a live (not-yet-finalized) pending: book 'pending' for finalize.
        const [pending] = await tx.update(sapEscrowSettlements).set({
          status: 'pending', settlementIndex: targetIndex,
          callsSettled: (alreadySettled + decodedCalls).toString(),
          reservedPrincipalAmount: (jobReserved + decodedPrincipal).toString(), feeAmount: (jobFees + decodedFee).toString(),
          verificationProvider: provider.id, verificationPassed: true, verificationDetail: verdict.detail ?? null,
          auditRootHex: auth.auditRootHex, updatedAt: new Date(),
          metadata: { ...((row.metadata as object) ?? {}), replayReconciledFromPendingPda: true },
        }).where(and(eq(sapEscrowSettlements.id, row.id), sql`${sapEscrowSettlements.status} IN ('open','submitted')`)).returning();
        return { kind: 'pending' as const, row: pending };
      });
      if (reconcile.kind === 'sibling') {
        return { ok: false, code: 'settle_in_progress', message: 'the on-chain pending at this index is already booked to another job; wait for its finalize.' };
      }
      if (reconcile.kind === 'settled') {
        if (reconcile.row) return { ok: true, phase: 'settled', settlement: reconcile.row, chain: null, replay: true };
        return { ok: false, code: 'settle_in_progress', message: 'the row changed while reconciling the finalized on-chain settlement.' };
      }
      if (reconcile.row) return { ok: true, phase: 'pending', settlement: reconcile.row, chain: null, replay: true, next: 'finalize' };
      return { ok: false, code: 'settle_in_progress', message: 'the row changed while reconciling the on-chain pending settlement.' };
    }

    const readVaultBalance = deps.readVaultBalance ?? readV2VaultBalanceBaseUnits;
    const claim = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.escrowPda}, 0))`);
      const lockedRows = await tx.select({
        status: sapEscrowSettlements.status, fundedAmount: sapEscrowSettlements.fundedAmount,
        releasedAmount: sapEscrowSettlements.releasedAmount, refundedAmount: sapEscrowSettlements.refundedAmount,
        reservedPrincipalAmount: sapEscrowSettlements.reservedPrincipalAmount, feeAmount: sapEscrowSettlements.feeAmount,
      }).from(sapEscrowSettlements).where(eq(sapEscrowSettlements.escrowPda, input.escrowPda));
      let remaining = 0n;
      // A1 — reserved principal PHYSICALLY still sits in the vault until FINALIZE
      // (settle only moves the fee out), so the vault holds `free + reserved`. To
      // clamp the FREE balance we must compare the debit against `vault − reserved`,
      // not the raw vault. Accumulate reserved over the SAME rows the `remaining` loop
      // counts (skip settle_unknown identically, so the quarantine isn't double-hit).
      let reservedInVault = 0n;
      for (const r of lockedRows) {
        if (r.status === 'settle_unknown') continue;
        if (r.status !== 'funding_unknown') remaining += u64(r.fundedAmount);
        remaining -= u64(r.releasedAmount) + u64(r.refundedAmount) + u64(r.reservedPrincipalAmount) + u64(r.feeAmount);
        reservedInVault += u64(r.reservedPrincipalAmount);
      }
      // M1 — subtract booked V2 withdrawals UNDER THE LOCK too (mirrors
      // escrowFundsLedger: sum ALL rows — only succeeded/broadcast_unknown ever
      // exist). Without this, a withdraw booked AFTER the pre-claim ceiling read but
      // before this claim would be invisible here, so the RPC-null vault fallback
      // would compute a stale (too-high) ceiling. The vault clamp below then takes
      // the min of this now-truthful ledger and the live physical-free balance.
      const lockedWithdrawals = await tx
        .select({ amount: sapEscrowWithdrawals.amount })
        .from(sapEscrowWithdrawals)
        .where(eq(sapEscrowWithdrawals.escrowPda, input.escrowPda));
      for (const w of lockedWithdrawals) remaining -= u64(w.amount);
      // FIX 2a + A1 (doc line 623) — CLAMP the ceiling to the LIVE PHYSICAL-FREE vault
      // balance (= on-chain vault − reserved principal), read UNDER the advisory lock
      // so the clamp is atomic with the claim. Comparing against `vault − reserved`
      // (not the raw vault) is what makes this catch ANY out-of-band drain: `min(remaining,
      // vault)` was INERT for any drain ≤ reserved (the vault still nominally covered
      // `remaining`), which is exactly the crash-window drain FIX 2b's best-effort
      // booking can miss. A read failure returns NULL → KEEP the ledger ceiling and
      // never reject on uncertain state; the on-chain program stays the authoritative
      // fail-closed guard (6062). Never false-rejects: a consistent state always has
      // vault − reserved ≥ remaining. Holding the lock across one RPC round-trip is
      // acceptable: settle is a rare, per-escrow-serialized, gated path and A3 bounds
      // the read to ~4s so a hung RPC can't pin the lock.
      const vaultBalance = await readVaultBalance({
        workerWalletPubkey: row.workerWalletPubkey,
        depositorWalletPubkey: row.depositorWalletPubkey,
        escrowNonce: nonce,
      });
      const physicalFree =
        vaultBalance === null ? null : vaultBalance > reservedInVault ? vaultBalance - reservedInVault : 0n;
      const effectiveRemaining =
        physicalFree !== null && physicalFree < remaining ? physicalFree : remaining;
      if (effectiveRemaining < totalDebit) return { kind: 'ledger_short' as const, remaining: effectiveRemaining };
      const claimed = await tx.update(sapEscrowSettlements).set({
        status: 'settling', settlementIndex: inspected.settlementIndex.toString(),
        // Reserve both V2 money legs INSIDE the advisory-lock transaction. A
        // second API process can only observe the row after these values commit,
        // so a sibling claim/refund cannot spend principal or fee headroom while
        // this process is broadcasting settle.
        reservedPrincipalAmount: (jobReserved + principal).toString(),
        feeAmount: (jobFees + fee).toString(),
        verificationProvider: provider.id, verificationPassed: true,
        verificationDetail: verdict.detail ?? null, auditRootHex: auth.auditRootHex, updatedAt: new Date(),
      }).where(and(eq(sapEscrowSettlements.id, row.id), sql`${sapEscrowSettlements.status} IN ('open','submitted')`)).returning({ id: sapEscrowSettlements.id });
      return { kind: 'claimed' as const, count: claimed.length };
    });
    if (claim.kind === 'ledger_short') return { ok: false, code: 'over_release', message: `escrow was drawn below this V2 debit (remaining=${claim.remaining}, need=${totalDebit}).` };
    if (claim.count !== 1) return { ok: false, code: 'settle_in_progress', message: 'a settle is already in progress for this job.' };

    const chain = await settleCallsV2Usdc({
      workerAvatarId: row.workerAvatarId, depositorWalletPubkey: row.depositorWalletPubkey,
      escrowNonce: nonce, callsToSettle: input.callsToSettle, auditRoot: verdict.auditRoot, amount: principal,
    });
    const simError = dryRunSimulationError(chain);
    if (chain.ok === false || simError) {
      const failure = chain.ok === false ? chain : null;
      if (isV2ReplaySignal(failure ?? simError)) {
        const replayCheck = await inspectV2SettlementState({
          workerWalletPubkey: row.workerWalletPubkey, depositorWalletPubkey: row.depositorWalletPubkey,
          escrowNonce: nonce, settlementIndex: inspected.settlementIndex,
        });
        if (replayCheck.ok && replayCheck.pendingExists && replayCheck.pending) {
          // FIX 3 (doc line 624) — a settle replay hit an already-existing pending;
          // book the DECODED on-chain principal/calls, NEVER the caller's numbers.
          // A2 — do the sibling guard + booking UNDER the advisory lock (atomic vs a
          // cross-process sibling). Our row is already 'settling'; the sibling and
          // disputed cases UN-CLAIM it back to pre-claim so it never strands 'settling'.
          const p = replayCheck.pending;
          const decodedPrincipal = p.amount;
          const decodedCalls = p.callsToSettle;
          const decodedFee = computeV2ProtocolFee(decodedPrincipal);
          const targetIndex = inspected.settlementIndex.toString();
          const reconcile = await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.escrowPda}, 0))`);
            if (await siblingOwnsPendingIndex(tx, input.escrowPda, row.id, targetIndex)) {
              // The on-chain pending at our index belongs to ANOTHER job — our settle
              // targeted a taken index. UN-CLAIM (release the reservation) + refuse.
              await tx.update(sapEscrowSettlements).set({
                status: preClaimStatus, reservedPrincipalAmount: jobReserved.toString(), feeAmount: jobFees.toString(), updatedAt: new Date(),
                metadata: { ...((row.metadata as object) ?? {}), settleError: failure?.code ?? 'replay_sibling', replaySignalSiblingConflict: true },
              }).where(and(eq(sapEscrowSettlements.id, row.id), eq(sapEscrowSettlements.status, 'settling')));
              return { kind: 'sibling' as const };
            }
            if (p.isDisputed) {
              // M4 (a) — disputed: UN-CLAIM (restore pre-claim, release reservation) +
              // ops failure. NEVER strand the row in 'settling'.
              await tx.update(sapEscrowSettlements).set({
                status: preClaimStatus, reservedPrincipalAmount: jobReserved.toString(), feeAmount: jobFees.toString(), updatedAt: new Date(),
                metadata: { ...((row.metadata as object) ?? {}), settleError: failure?.code ?? 'replay_disputed', replaySignalDisputed: true },
              }).where(and(eq(sapEscrowSettlements.id, row.id), eq(sapEscrowSettlements.status, 'settling')));
              return { kind: 'disputed' as const };
            }
            if (p.isFinalized) {
              // M4 (b) — already finalized on-chain: book TERMINAL 'settled' from
              // 'settling' (principal RELEASED, never reserved). finalize never runs.
              const [settled] = await tx.update(sapEscrowSettlements).set({
                status: 'settled', callsSettled: (alreadySettled + decodedCalls).toString(),
                releasedAmount: (jobReleased + decodedPrincipal).toString(), reservedPrincipalAmount: jobReserved.toString(),
                feeAmount: (jobFees + decodedFee).toString(), settledAt: new Date(), updatedAt: new Date(),
                metadata: { ...((row.metadata as object) ?? {}), replayReconciledFromPendingPda: true, reconciledFinalized: true },
              }).where(and(eq(sapEscrowSettlements.id, row.id), eq(sapEscrowSettlements.status, 'settling'))).returning();
              return { kind: 'settled' as const, row: settled };
            }
            // M4 (c) — a live (not-yet-finalized) pending: book 'pending' for finalize.
            const [pending] = await tx.update(sapEscrowSettlements).set({
              status: 'pending', callsSettled: (alreadySettled + decodedCalls).toString(),
              reservedPrincipalAmount: (jobReserved + decodedPrincipal).toString(), feeAmount: (jobFees + decodedFee).toString(), updatedAt: new Date(),
            }).where(and(eq(sapEscrowSettlements.id, row.id), eq(sapEscrowSettlements.status, 'settling'))).returning();
            return { kind: 'pending' as const, row: pending };
          });
          if (reconcile.kind === 'sibling') {
            return { ok: false, code: 'settle_in_progress', message: 'the on-chain pending at this index is already booked to another job; wait for its finalize.' };
          }
          if (reconcile.kind === 'disputed') {
            return { ok: false, code: 'on_chain_error', message: 'on-chain pending is disputed; manual resolution required.' };
          }
          if (reconcile.kind === 'settled') {
            if (reconcile.row) return { ok: true, phase: 'settled', settlement: reconcile.row, chain: null, replay: true };
            return { ok: false, code: 'settle_in_progress', message: 'the row changed while reconciling the finalized on-chain settlement.' };
          }
          if (reconcile.row) return { ok: true, phase: 'pending', settlement: reconcile.row, chain: null, replay: true, next: 'finalize' };
          return { ok: false, code: 'settle_in_progress', message: 'the row changed while reconciling the on-chain pending settlement.' };
        }
        // R3-1 — the re-probe did NOT positively decode a pending. GATE THE RESTORE ON
        // BROADCAST. `isV2ReplaySignal` substring-matches the STRINGIFIED failure (incl.
        // the base58 signature), so a genuine confirm-timeout `broadcast:true` failure can
        // FALSE-MATCH the replay regex. Restoring + releasing the reservation on a
        // broadcast:true tx is UNSAFE: the tx MAY still land, and a retry would then settle
        // at the NEXT index → two pendings for one job → double principal release. So:
        //   • broadcast:true → FALL THROUGH to the generic handler → `settle_unknown`
        //     (reservation KEPT, reconcile-only). Safe for BOTH a false match AND a genuine
        //     replay whose on-chain pending we simply could not read this time.
        //   • broadcast falsy → provably pre-broadcast (nothing hit the wire): restore to
        //     pre-claim, release the reservation, retryable — the next call reconciles
        //     with-decode once RPC recovers. NOT terminal 'failed' (unrecoverable).
        if (failure?.broadcast !== true) {
          const restoreMessage = replayCheck.ok
            ? 'settle replay-signal but no on-chain pending found at the index; retry.'
            : 'settle replay-signal: the on-chain pending could not be read/decoded; retry.';
          await db.update(sapEscrowSettlements).set({
            status: preClaimStatus, reservedPrincipalAmount: jobReserved.toString(), feeAmount: jobFees.toString(), updatedAt: new Date(),
            metadata: { ...((row.metadata as object) ?? {}), settleError: failure?.code ?? 'simulation_error', replaySignalUnresolved: true },
          }).where(and(eq(sapEscrowSettlements.id, row.id), eq(sapEscrowSettlements.status, 'settling')));
          return { ok: false, code: 'on_chain_error', message: restoreMessage };
        }
        // broadcast:true + unresolved probe → fall through to the generic quarantine below.
      }
      const unknown = failure?.broadcast === true;
      await db.update(sapEscrowSettlements).set({
        status: unknown ? 'settle_unknown' : 'failed',
        settleSignature: unknown ? (failure?.signature ?? null) : null, updatedAt: new Date(),
        // A broadcast-unknown may have charged/reserved on-chain, so retain the
        // pessimistic claim reservation. A provably pre-broadcast refusal moved
        // nothing and restores the prior ledger values.
        reservedPrincipalAmount: unknown ? (jobReserved + principal).toString() : jobReserved.toString(),
        feeAmount: unknown ? (jobFees + fee).toString() : jobFees.toString(),
        metadata: { ...((row.metadata as object) ?? {}), settleError: failure?.code ?? 'simulation_error', settleBroadcastUnconfirmed: unknown, simulationError: simError ?? undefined },
      }).where(and(eq(sapEscrowSettlements.id, row.id), eq(sapEscrowSettlements.status, 'settling')));
      return unknown
        ? { ok: false, code: 'settle_unconfirmed', message: 'V2 settle broadcast was unconfirmed; reconcile and never auto-retry.' }
        : { ok: false, code: failure?.code ?? 'on_chain_error', message: failure?.message ?? 'V2 settle simulation failed after the durable claim.' };
    }

    const settlementIndex = u64(chain.accounts.settlementIndex) || inspected.settlementIndex;
    const [pending] = await db.update(sapEscrowSettlements).set({
      status: 'pending', settlementIndex: settlementIndex.toString(),
      settleSignature: chain.dryRun ? null : chain.signature,
      callsSettled: (alreadySettled + input.callsToSettle).toString(),
      reservedPrincipalAmount: (jobReserved + principal).toString(), feeAmount: (jobFees + fee).toString(),
      dryRun: chain.dryRun, updatedAt: new Date(),
    }).where(and(eq(sapEscrowSettlements.id, row.id), eq(sapEscrowSettlements.status, 'settling'))).returning();
    return { ok: true, phase: 'pending', settlement: pending, chain, replay: false, next: 'finalize' };
  });
}

export interface FinalizeJobV2Input { escrowPda: string; jobId: string; callerAvatarId: string }

/** Permissionless authenticated crank for V2 pending principal. */
export async function finalizeJobV2(input: FinalizeJobV2Input): Promise<EscrowGateResult> {
  const gated = gateOpen();
  if (gated) return gated;
  return withKeyedMutex(escrowMutexKey(input.escrowPda), async () => {
    const row = await db.query.sapEscrowSettlements.findFirst({
      where: and(eq(sapEscrowSettlements.escrowPda, input.escrowPda), eq(sapEscrowSettlements.jobId, input.jobId)),
    });
    if (!row) return { ok: false, code: 'job_not_found', message: 'no settlement row for (escrow, job).' };
    if (row.escrowVersion !== 'v2' || row.escrowNonce == null || row.settlementIndex == null) return { ok: false, code: 'job_not_open', message: 'row has no finalized V2 settle coordinates.' };
    if (settlementRail(row) !== 'onchain') return { ok: false, code: 'release_rail_forbidden', message: 'V2 finalize is onchain-only; payai rows are refused.' };
    if (row.status === 'settled') return { ok: true, phase: 'settled', settlement: row, chain: null, replay: true };
    if (row.status === 'finalizing') return { ok: false, code: 'finalize_in_progress', message: 'finalize is already in progress.' };
    if (row.status === 'finalize_unknown') return { ok: false, code: 'finalize_unconfirmed', message: 'finalize broadcast is unconfirmed; reconcile it and never auto-retry.' };
    if (row.status === 'settle_unknown') return { ok: false, code: 'settle_unconfirmed', message: 'settle broadcast is unconfirmed; reconcile before finalize.' };
    if (row.status !== 'pending') return { ok: false, code: 'finalize_not_ready', message: `job is ${row.status}; only pending V2 settlements can finalize.` };

    const claimed = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.escrowPda}, 0))`);
      return tx.update(sapEscrowSettlements).set({ status: 'finalizing', updatedAt: new Date() })
        .where(and(eq(sapEscrowSettlements.id, row.id), eq(sapEscrowSettlements.status, 'pending')))
        .returning({ id: sapEscrowSettlements.id });
    });
    if (claimed.length !== 1) return { ok: false, code: 'finalize_in_progress', message: 'another crank claimed finalize.' };

    const chain = await finalizeSettlementUsdc({
      payerAvatarId: input.callerAvatarId, workerWalletPubkey: row.workerWalletPubkey,
      depositorWalletPubkey: row.depositorWalletPubkey, escrowNonce: u64(row.escrowNonce),
      settlementIndex: u64(row.settlementIndex),
    });
    const simError = dryRunSimulationError(chain);
    if (chain.ok === false || simError) {
      const failure = chain.ok === false ? chain : null;
      if (failure?.broadcast) {
        await db.update(sapEscrowSettlements).set({
          status: 'finalize_unknown', finalizeSignature: failure.signature ?? null, updatedAt: new Date(),
          metadata: { ...((row.metadata as object) ?? {}), finalizeError: failure.code, finalizeBroadcastUnconfirmed: true },
        }).where(and(eq(sapEscrowSettlements.id, row.id), eq(sapEscrowSettlements.status, 'finalizing')));
        return { ok: false, code: 'finalize_unconfirmed', message: 'V2 finalize broadcast was unconfirmed; reconcile and never auto-retry.' };
      }
      await db.update(sapEscrowSettlements).set({
        status: 'pending', updatedAt: new Date(),
        metadata: { ...((row.metadata as object) ?? {}), finalizeError: failure?.code ?? 'simulation_error', simulationError: simError ?? undefined },
      }).where(and(eq(sapEscrowSettlements.id, row.id), eq(sapEscrowSettlements.status, 'finalizing')));
      return { ok: false, code: 'finalize_not_ready', message: failure?.message ?? 'V2 finalize simulation refused before broadcast; pending remains retryable.' };
    }

    const released = u64(row.releasedAmount) + u64(row.reservedPrincipalAmount);
    const [settled] = await db.update(sapEscrowSettlements).set({
      status: 'settled', releasedAmount: released.toString(), reservedPrincipalAmount: '0',
      finalizeSignature: chain.dryRun ? null : chain.signature, dryRun: chain.dryRun,
      settledAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(sapEscrowSettlements.id, row.id), eq(sapEscrowSettlements.status, 'finalizing'))).returning();
    return { ok: true, phase: 'settled', settlement: settled, chain, replay: false };
  });
}

// ─── 5. REFUND (cancel / expiry / verify-fail) ────────────────────────────────

export interface RefundEscrowInput {
  /** Depositor avatar — only the depositor can withdraw their unspent USDC. */
  depositorAvatarId: string;
  escrowPda: string;
  jobId: string;
  /** Amount of unspent USDC (base units) to reclaim. */
  amount: bigint;
}

/**
 * Refund unspent USDC to the depositor (cancel/expiry/verify-fail).
 *
 * BLOCKING #4 — refund vs settle TOCTOU fix. The OLD code sent the `withdraw`
 * on-chain BEFORE any atomic claim, so a refund and a settle could BOTH broadcast
 * live instructions against one escrow. Now refund makes an ATOMIC `refunding`
 * claim (the same conditional-UPDATE lock the settle path uses) BEFORE any chain
 * send, and operates ONLY from `open|submitted`:
 *   - a settle holding the `settling` claim blocks the refund claim (0 rows), and
 *     vice-versa — exactly one of {settle, refund} ever reaches the chain;
 *   - a `settled` row can NEVER be relabelled `refunded` (the settle provenance
 *     — settleSignature/auditRoot — is preserved), closing the 4th-reviewer's
 *     provenance-overwrite hole;
 *   - the final status UPDATE is guarded on `status='refunding'`.
 */
export async function refundEscrow(input: RefundEscrowInput): Promise<EscrowGateResult> {
  const gated = gateOpen();
  if (gated) return gated;

  if (input.amount <= 0n) {
    return { ok: false, code: 'over_release', message: 'refund amount must be > 0.' };
  }

  // FIX 3 — serialize per-escrowPda within this process (same key as settleJob),
  // so a refund and a sibling settle can't interleave their read-ledger → claim
  // windows. Exactly one of {settle, refund} ever touches the chain per escrow.
  return withKeyedMutex(escrowMutexKey(input.escrowPda), () => refundEscrowLocked(input));
}

/** The serialized refund body — only ever entered under the per-escrow mutex. */
async function refundEscrowLocked(input: RefundEscrowInput): Promise<EscrowGateResult> {
  const row = await db.query.sapEscrowSettlements.findFirst({
    where: and(
      eq(sapEscrowSettlements.escrowPda, input.escrowPda),
      eq(sapEscrowSettlements.jobId, input.jobId),
    ),
  });
  if (!row) return { ok: false, code: 'job_not_found', message: 'no settlement row for (escrow, job).' };
  if ((row.escrowVersion ?? 'v1') !== 'v1') {
    return { ok: false, code: 'job_not_open', message: 'V2 rows cannot use the V1 refund executor.' };
  }

  // The depositor must be the row's depositor (the route already binds identity,
  // but re-assert here as defense-in-depth on the money path).
  if (row.depositorAvatarId !== input.depositorAvatarId) {
    return { ok: false, code: 'internal', message: 'only the depositor can refund this escrow.' };
  }

  // Reject terminal / in-flight states up front for a precise error (the atomic
  // claim below is the real guard against a concurrent settle).
  if (row.status === 'settled' || row.status === 'refunded' || row.status === 'failed') {
    return { ok: false, code: 'job_not_open', message: `job is ${row.status}; cannot refund.` };
  }
  if (row.status === 'settling') {
    return { ok: false, code: 'settle_in_progress', message: 'cannot refund while a settle is in progress.' };
  }
  if (row.status === 'refunding') {
    return { ok: false, code: 'refund_in_progress', message: 'a refund is already in progress for this job.' };
  }
  if (row.status === 'funding_unknown') {
    return { ok: false, code: 'funding_unconfirmed', message: 'job funding is unconfirmed; resolve reconciliation before refunding.' };
  }

  // FIX 2 — CEILING the refund against the ledger BEFORE any claim/chain. The OLD
  // code took the body `amount` straight to `withdraw_escrow` with NO upper bound,
  // so an over-amount would (a) reach the chain and (b) on failure flip the row
  // terminal-`failed`, bricking a legitimate later refund. The refundable ceiling
  // is the MIN of this job's own unspent funded portion and the escrow-wide
  // spendable balance — a request over it is rejected as `over_release`, never
  // broadcast. (The on-chain withdraw would also reject an over-amount, but we must
  // not let it strand the row in `failed`.)
  {
    const jobFundedR = u64(row.fundedAmount);
    const jobReleasedR = u64(row.releasedAmount);
    const jobRefundedR = u64(row.refundedAmount);
    const jobRemainingFundedR =
      jobFundedR > jobReleasedR + jobRefundedR ? jobFundedR - jobReleasedR - jobRefundedR : 0n;
    const ledgerR = await escrowFundsLedger(input.escrowPda);
    const refundCeiling = computeRefundCeiling({
      jobRemainingFunded: jobRemainingFundedR,
      escrowRemaining: ledgerR.remaining,
    });
    if (refundCeiling <= 0n || input.amount > refundCeiling) {
      return {
        ok: false,
        code: 'over_release',
        message:
          `requested refund ${input.amount} exceeds the refundable ceiling ${refundCeiling} ` +
          `(jobRemainingFunded=${jobRemainingFundedR}, escrowRemaining=${ledgerR.remaining}).`,
      };
    }
  }

  // BLOCKING #4 + FIX 3 — ATOMIC CLAIM `refunding` BEFORE any chain send, UNDER a
  // cross-process advisory lock + a re-read of the ledger. Only flips from
  // open|submitted; a concurrent settle that already claimed `settling` makes this
  // affect 0 rows → we bail WITHOUT broadcasting. The post-lock ledger re-read
  // aborts if a sibling settle/refund committed first and drew the vault below
  // this refund (closing the racy-aggregate window).
  const claimResult = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.escrowPda}, 0))`,
    );

    const lockedLedgerRows = await tx
      .select({
        status: sapEscrowSettlements.status,
        fundedAmount: sapEscrowSettlements.fundedAmount,
        releasedAmount: sapEscrowSettlements.releasedAmount,
        refundedAmount: sapEscrowSettlements.refundedAmount,
      })
      .from(sapEscrowSettlements)
      .where(eq(sapEscrowSettlements.escrowPda, input.escrowPda));
    let lFunded = 0n;
    let lReleased = 0n;
    let lRefunded = 0n;
    for (const r of lockedLedgerRows) {
      if (r.status === 'settle_unknown') continue;
      if (r.status !== 'funding_unknown') lFunded += u64(r.fundedAmount);
      lReleased += u64(r.releasedAmount);
      lRefunded += u64(r.refundedAmount);
    }
    const lockedRemaining = lFunded - lReleased - lRefunded;
    if (lockedRemaining < input.amount) {
      return { kind: 'ledger_short' as const, remaining: lockedRemaining };
    }

    const claimed = await tx
      .update(sapEscrowSettlements)
      .set({ status: 'refunding', updatedAt: new Date() })
      .where(
        and(
          eq(sapEscrowSettlements.id, row.id),
          sql`${sapEscrowSettlements.status} IN ('open','submitted')`,
        ),
      )
      .returning({ id: sapEscrowSettlements.id });
    return { kind: 'claimed' as const, count: claimed.length };
  });

  if (claimResult.kind === 'ledger_short') {
    return {
      ok: false,
      code: 'over_release',
      message:
        `escrow vault was drawn below this refund by a concurrent settle/refund ` +
        `(escrowRemaining=${claimResult.remaining}, need=${input.amount}); retry with a smaller amount.`,
    };
  }

  if (claimResult.count !== 1) {
    // Lost the race to a concurrent settle/refund. Re-read for a precise code.
    const cur = await db.query.sapEscrowSettlements.findFirst({
      where: eq(sapEscrowSettlements.id, row.id),
    });
    if (cur?.status === 'settling' || cur?.status === 'settled') {
      return { ok: false, code: 'settle_in_progress', message: 'a settle claimed this job first; cannot refund.' };
    }
    return { ok: false, code: 'refund_in_progress', message: 'a refund is already in progress for this job.' };
  }

  // ── PAYAI RAIL refund — pure ledger release, no chain withdraw ───────────────
  // A payai job's USDC never left the depositor's wallet (the single movement
  // happens only at settle), so there is NO vault to withdraw from. The refund
  // books the commitment released in the ledger and closes the row. The atomic
  // `refunding` claim above still serializes this against a concurrent payai
  // settle (exactly one of {settle, refund} wins). Deliberately NOT gated on
  // SAP_PAYAI_SETTLEMENT_ENABLED: this moves no money, and a depositor must be
  // able to close a stale commitment even after the rail is turned off.
  if (settlementRail(row) === 'payai') {
    const newRefundedPayai = (u64(row.refundedAmount) + input.amount).toString();
    const [refundedPayai] = await db
      .update(sapEscrowSettlements)
      .set({ status: 'refunded', refundedAmount: newRefundedPayai, updatedAt: new Date() })
      .where(
        and(
          eq(sapEscrowSettlements.id, row.id),
          eq(sapEscrowSettlements.status, 'refunding'),
        ),
      )
      .returning();
    return { ok: true, phase: 'refunded', settlement: refundedPayai, chain: null };
  }

  // We hold the `refunding` claim — now (and only now) touch the chain.
  const chain = await withdrawEscrowUsdc({
    depositorAvatarId: input.depositorAvatarId,
    workerWalletPubkey: row.workerWalletPubkey,
    amount: input.amount,
  });

  if (chain.ok === false) {
    // BLOCKING #4/#5 — a withdraw failed AFTER claiming `refunding`. If it was
    // BROADCAST-but-unconfirmed it may have moved funds → leave the row in a
    // terminal `failed` state with the signature; NEVER auto-revert to open (that
    // would let a retry double-withdraw). A pre-broadcast failure is also left
    // `failed` (do not auto-retry on the money path); a human reconciles.
    await db
      .update(sapEscrowSettlements)
      .set({
        status: 'failed',
        settleSignature: chain.broadcast ? (chain.signature ?? null) : null,
        updatedAt: new Date(),
        metadata: {
          ...((row.metadata as object) ?? {}),
          refundError: chain.code,
          refundBroadcastUnconfirmed: chain.broadcast === true,
        },
      })
      .where(
        and(
          eq(sapEscrowSettlements.id, row.id),
          eq(sapEscrowSettlements.status, 'refunding'),
        ),
      );
    return { ok: false, code: chain.code, message: chain.message };
  }

  // Success — flip refunding → refunded (guarded) + book the refunded amount into
  // the accounting ledger (BLOCKING #3: counts toward sum(released)+sum(refunded)).
  const newRefunded = (u64(row.refundedAmount) + input.amount).toString();
  const [refunded] = await db
    .update(sapEscrowSettlements)
    .set({ status: 'refunded', refundedAmount: newRefunded, updatedAt: new Date() })
    .where(
      and(
        eq(sapEscrowSettlements.id, row.id),
        eq(sapEscrowSettlements.status, 'refunding'),
      ),
    )
    .returning();

  return { ok: true, phase: 'refunded', settlement: refunded, chain };
}
