/**
 * Composed-bounty settle → persist layer + (slice 3) the finalize/payout crank.
 *
 * The composition ORCHESTRATION (open/settle/refund/reclaim of the two-leg SAP V2
 * vault → PayAI x402 topology) lives in `bounty-escrow-link.ts` and is PURE (no
 * `bounties`-row writes). THIS file is the thin DB-coupled layer that:
 *   1. drives `settleComposedBounty` and maps its four-phase result onto the
 *      bounty row's `composition_state` + payout/verdict provenance, AND
 *   2. books the winning hunter's deferred completion bump EXACTLY ONCE (on the
 *      first transition into `paid`), AND
 *   3. (slice 3) re-drives stuck `awaiting_finalize` / `reconcile_payout_failed`
 *      bounties from a DARK-gated resume worker.
 *
 * Shared by BOTH the approve route (drives the settle immediately post-review) and
 * the resume worker (re-drives a settling bounty), so the persist + idempotency
 * discipline is written ONCE. Every write guards `composition_state != 'paid'` so
 * a paid bounty is never downgraded, and the completion bump rides an atomic
 * `... WHERE composition_state != 'paid' RETURNING` claim so a concurrent
 * approve+crank (or two cranks) can only book the metric a single time.
 *
 * The underlying money legs are already idempotent (deterministic V2 nonce +
 * `(escrowPda, jobId)` at-most-once ledger + `${bountyId}:payout|refund|reclaim`
 * request ids), so re-running `applyComposedSettleOutcome` is always safe — this
 * layer only adds the once-only bookkeeping on top.
 */

import { randomUUID } from 'node:crypto';
import {
  db,
  bounties,
  bountyAttempts,
  bountyReputation,
  covenantActionRecords,
  sapEscrowSettlements,
  sapEscrowWithdrawals,
  eq,
  and,
  sql,
} from '@clawville/database';
import { asc, ne } from 'drizzle-orm';
import {
  settleComposedBounty as settleComposedBountyImpl,
  refundComposedBounty,
  bountySettlementRail,
  type SettleComposedBountyResult,
} from './bounty-escrow-link';
import { alertError } from './alert-error';
import { recordCovenantAction } from './covenant-action-recorder';
import { enqueueBountyReputation } from './sap/sap-reputation-writer';
import {
  inspectCapturedSapTransaction,
  type SapCapturedTransactionInspection,
} from './sap/sap-client';

/**
 * A DB transaction handle (mirrors `LedgerTx` in `claw-token-ledger.ts`). Lets
 * `bookHunterCompletion` run inside the SAME transaction as the →paid CAS claim, so
 * the flip-to-paid and the completion bump commit atomically (LOW-2).
 */
type CompositionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The bounty reputation tier ladder — MIRRORS `calculateReputationTier` in
 * `routes/bounties.ts` (kept in lock-step; the thresholds are a stable product
 * constant). Duplicated here rather than imported so a service never depends on a
 * route module.
 */
function reputationTier(totalCompleted: number): string {
  if (totalCompleted >= 50) return 'master';
  if (totalCompleted >= 25) return 'expert';
  if (totalCompleted >= 10) return 'journeyman';
  if (totalCompleted >= 3) return 'apprentice';
  return 'newcomer';
}

/**
 * Book the winning hunter's bounty-completion bump for a composed USDC bounty.
 * MIRRORS the legacy USDC deferred bump in `routes/bounties.ts` (totalCompleted +1
 * + tier recompute; `totalEarned` intentionally UNCHANGED — that column is a CT
 * counter and a USDC reward must never inflate it). Runs on the caller's transaction
 * handle `tx` so the bump commits ATOMICALLY with the →paid CAS claim (LOW-2). Only
 * ever called from inside the winning `paid`-claim below, so it runs exactly once per
 * bounty.
 */
async function bookHunterCompletion(
  tx: CompositionTx,
  hunterAvatarId: string,
  now: Date,
): Promise<void> {
  const rep = await tx.query.bountyReputation.findFirst({
    where: eq(bountyReputation.avatarId, hunterAvatarId),
  });
  if (rep) {
    const bumped = rep.totalCompleted + 1;
    await tx
      .update(bountyReputation)
      .set({
        totalCompleted: bumped,
        tier: reputationTier(bumped) as any,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(bountyReputation.id, rep.id));
  } else {
    await tx.insert(bountyReputation).values({
      avatarId: hunterAvatarId,
      totalCompleted: 1,
      totalEarned: 0,
      tier: reputationTier(1) as any,
      lastActivityAt: now,
    });
  }
}

// ── THE ONE shared →paid write path (team-lead ruling) ────────────────────────

export interface BookComposedBountyPaidInput {
  bountyId: string;
  /**
   * The composition_state the caller OBSERVED before the settle reached `paid` —
   * the compare-and-swap guard. The approve route passes `'vault_held'` (a composed
   * bounty is created `vault_held` and, under the 1-slot window, settles straight to
   * paid); the resume crank passes the state it loaded (`'awaiting_finalize'` |
   * `'reconcile_payout_failed'`). The booking fires ONLY when the row is STILL at
   * this exact state, so the TWO authors of the →paid transition (route + crank) can
   * each book it at most once and never double-count.
   */
  expectedPriorState: string;
  hunterAvatarId: string;
  /** LEG-2 payout escrow PDA from the settle (provenance). */
  payoutEscrowPda: string | null;
  /** Verifier audit-root hex from the settle (verdict provenance). */
  auditRootHex: string | null;
}

export type BookComposedBountyPaidResult =
  | { booked: true }
  | { booked: false; reason: 'already_paid_or_state_drift' };

/**
 * THE single shared →paid write path (team-lead ruling). The →paid transition is
 * the ONE seam with two authors — the approve route's instant-paid branch AND the
 * resume crank's deferred-paid branch — so the completion/reputation bump must book
 * EXACTLY ONCE. Both callers route through here; nobody writes the paid state
 * inline.
 *
 * Atomic compare-and-swap: flips the bounty to `paid` + `completed` and writes ALL
 * paid-state fields (composition_state, status/completed_at, payout PDA, audit root,
 * covenant PASS, escrow_job_id) ONLY when the row is STILL at `expectedPriorState`
 * (and not already `paid`). The winner — exactly one caller — additionally books the
 * hunter completion bump (`totalCompleted += 1`; `totalEarned` UNCHANGED, it is a CT
 * counter a USDC reward must never inflate). A loser (already paid, or the state
 * drifted under a concurrent crank) returns `booked:false` and touches nothing; its
 * caller still treats the bounty as paid (idempotent). Keeping EVERY paid-state
 * write here makes the route and the crank byte-identical on the paid outcome.
 */
export async function bookComposedBountyPaid(
  input: BookComposedBountyPaidInput,
): Promise<BookComposedBountyPaidResult> {
  const now = new Date();
  // LOW-2 atomicity: the →paid CAS claim AND the winner's completion bump commit in ONE
  // transaction, so a crash BETWEEN them can never leave a 'paid' row whose hunter
  // `totalCompleted` was never incremented (a permanent reputation undercount). The CAS
  // still fires at most once — only the single caller whose UPDATE returns a row books the
  // bump; a loser (already paid / state drift) returns booked:false and its (write-free)
  // transaction commits as a no-op. Return contract is unchanged.
  const booked = await db.transaction(async (tx): Promise<BookComposedBountyPaidResult> => {
    const claimed = await tx
      .update(bounties)
      .set({
        status: 'completed',
        completedAt: now,
        compositionState: 'paid',
        payoutEscrowPda: input.payoutEscrowPda,
        escrowJobId: input.bountyId,
        covenantAuditRootHex: input.auditRootHex,
        covenantVerificationPassed: true,
        updatedAt: now,
      })
      .where(
        and(
          eq(bounties.id, input.bountyId),
          // CAS on the OBSERVED prior + belt-and-braces never-from-paid.
          eq(bounties.compositionState, input.expectedPriorState),
          eq(bounties.status, 'open'),
          ne(bounties.compositionState, 'paid'),
        ),
      )
      .returning({ id: bounties.id });
    if (claimed.length !== 1) return { booked: false, reason: 'already_paid_or_state_drift' };
    await bookHunterCompletion(tx, input.hunterAvatarId, now);
    // Covenant record — the composed-rail SETTLE, exactly once (only the CAS
    // winner reaches here; both →paid authors — approve route and resume
    // crank — funnel through this helper). actorKind stays null: this seam
    // cannot distinguish the reviewer-driven instant path from the system
    // crank, and attribution is never guessed. The x402 payout never touches
    // the vCLAW ledger, so this is the settle's ONLY stream record.
    await recordCovenantAction(
      {
        action: 'bounty.settle',
        subjectType: 'avatar',
        subjectId: input.hunterAvatarId,
        // The CAS already guarantees exactly-once; the dedupe key is
        // belt-and-braces against any future second settle author.
        dedupeKey: `bounty:${input.bountyId}:settle`,
        payload: {
          bountyId: input.bountyId,
          rail: 'sap-payai-composed',
          ...(input.payoutEscrowPda ? { payoutEscrowPda: input.payoutEscrowPda } : {}),
          ...(input.auditRootHex ? { auditRootHex: input.auditRootHex } : {}),
        },
      },
      tx,
    );
    return { booked: true };
  });
  // Reputation admission is deliberately AFTER the PAID transaction commits.
  // Both the approve route and resume worker call this shared CAS seam; only the
  // winner enqueues, and enqueue failure can never roll back or change payment.
  if (booked.booked) enqueueBountyReputation(input.bountyId, input.hunterAvatarId);
  return booked;
}

/**
 * Injectable seam for tests (the resume worker / approve route pass nothing in
 * production, getting the real `settleComposedBounty`). Mirrors the `SettleJobV2Deps`
 * idiom already used in `escrow-gate.ts`.
 */
export interface ApplyComposedDeps {
  settleComposedBounty?: typeof settleComposedBountyImpl;
}

export interface ApplyComposedInput {
  bountyId: string;
  creatorAvatarId: string;
  hunterAvatarId: string;
  /** The persisted LEG-1 V2 vault PDA (set on the bounty row at create). */
  escrowPda: string;
  tokenReward: number;
  /**
   * The composition_state the CALLER observed before this settle (the crank's
   * loaded state). Threaded into `bookComposedBountyPaid` as the CAS guard so the
   * paid booking fires at most once. See `BookComposedBountyPaidInput`.
   */
  expectedPriorState: string;
}

/**
 * Drive the composed two-leg settle for a bounty and persist its outcome onto the
 * bounty row. Returns the raw `SettleComposedBountyResult` so the caller can build
 * its HTTP response / decide whether to surface an error. Persistence by phase:
 *
 *   - `paid`                    → delegates to the shared `bookComposedBountyPaid`
 *     (atomic CAS on `input.expectedPriorState`): writes all paid-state fields +
 *     books the hunter completion EXACTLY ONCE. The approve route calls the SAME
 *     function, so the two →paid authors never double-count.
 *   - `awaiting_finalize`       → composition_state='awaiting_finalize' (hunter
 *     UNPAID; the resume worker finalizes leg 1c once the dispute window elapses).
 *   - `reconcile_payout_failed` → composition_state='reconcile_payout_failed' +
 *     payout PDA (if opened) + a CRITICAL `bounty-composition` alert. Leg 1
 *     finalized (the house HAS the reward); leg 2 replays idempotently.
 *   - `failed`                  → NO state change (stays 'vault_held'); the
 *     creator's USDC is still fully custodied and the settle is re-drivable.
 *
 * Idempotent + concurrency-safe: every non-paid write refuses to touch an already
 * 'paid' row, and the completion bump rides the paid-transition claim.
 */
export async function applyComposedSettleOutcome(
  input: ApplyComposedInput,
  deps: ApplyComposedDeps = {},
): Promise<SettleComposedBountyResult> {
  const settleComposedBounty = deps.settleComposedBounty ?? settleComposedBountyImpl;
  const settled = await settleComposedBounty({
    bountyId: input.bountyId,
    escrowPda: input.escrowPda,
    creatorAvatarId: input.creatorAvatarId,
    hunterAvatarId: input.hunterAvatarId,
    tokenReward: input.tokenReward,
  });
  const now = new Date();

  switch (settled.phase) {
    case 'paid': {
      // The ONE shared →paid write path (team-lead ruling): the crank and the
      // approve route BOTH book the paid state + the once-only completion bump
      // through `bookComposedBountyPaid` (atomic CAS on the observed prior state),
      // so the two authors of this transition can never double-count. The dust
      // auto-reclaim already fired inside `settleComposedBounty` leg 1d.
      await bookComposedBountyPaid({
        bountyId: input.bountyId,
        expectedPriorState: input.expectedPriorState,
        hunterAvatarId: input.hunterAvatarId,
        payoutEscrowPda: settled.payoutEscrowPda,
        auditRootHex: settled.auditRootHex,
      });
      break;
    }
    case 'awaiting_finalize': {
      // Leg 1b settled (principal reserved on-chain); leg 1c finalize pending. The
      // hunter is UNPAID and no double-pay is possible. Never downgrade a paid row.
      await db
        .update(bounties)
        .set({ compositionState: 'awaiting_finalize', updatedAt: now })
        .where(and(eq(bounties.id, input.bountyId), ne(bounties.compositionState, 'paid')));
      break;
    }
    case 'reconcile_payout_failed': {
      // Leg 1 FINALIZED (the house HAS the reward) but leg 2 (payout) failed. Funds
      // are safe in the house wallet; the resume worker replays leg 2 idempotently.
      await db
        .update(bounties)
        .set({
          compositionState: 'reconcile_payout_failed',
          ...(settled.payoutEscrowPda ? { payoutEscrowPda: settled.payoutEscrowPda } : {}),
          updatedAt: now,
        })
        .where(and(eq(bounties.id, input.bountyId), ne(bounties.compositionState, 'paid')));
      await alertError({
        severity: 'critical',
        source: 'bounty-composition',
        message:
          `Composed bounty ${input.bountyId}: leg-1 finalized (reward at the house) but ` +
          `the leg-2 hunter payout failed (${settled.code}): ${settled.message}. Funds are safe; ` +
          `the resume worker retries leg 2 idempotently — no double-pay is possible.`,
        context: {
          bountyId: input.bountyId,
          escrowPda: settled.escrowPda,
          payoutEscrowPda: settled.payoutEscrowPda,
          code: settled.code,
        },
      });
      break;
    }
    case 'failed': {
      // Leg 1a/1b failed BEFORE any settle — the creator's USDC is still fully in
      // the vault. Leave composition_state as-is ('vault_held'); the caller surfaces
      // the error and the settle re-drives idempotently.
      break;
    }
  }

  return settled;
}

// ════════════════════════════════════════════════════════════════════════════
// FINALIZE / PAYOUT CRANK (SLICE 3) — advance stuck composed bounties
// ════════════════════════════════════════════════════════════════════════════
//
// A composed bounty settles in ONE shot at approve when the (bounty-specific)
// dispute window is instant. But a raised `SAP_BOUNTY_DISPUTE_WINDOW_SLOTS`, a
// transient RPC/PayAI failure, or a leg-2 reconcile can leave a bounty in:
//   - `awaiting_finalize`       — leg 1b settled; leg 1c finalize not yet ready.
//   - `reconcile_payout_failed` — leg 1 finalized (reward at the house); leg 2
//                                 (hunter payout) failed and must be retried.
//   - `vault_held` WITH AN APPROVED ATTEMPT — L-1: an approve whose settle failed
//     BEFORE any on-chain settle (e.g. the pre-L-2 gate parked the V2 row terminal
//     'failed' on a transient sim failure, or the settle otherwise errored pre-settle)
//     leaves the bounty at `vault_held` even though the creator APPROVED a winner. The
//     route's own 'failed'-phase note promised "retryable via an ops crank re-running
//     settleComposedBounty" — this IS that crank. Paired with the L-2 gate fix (a
//     pre-broadcast settle failure now restores the row to a retryable status instead
//     of terminal 'failed'), an approve-time transient now SELF-HEALS on the next sweep.
// The crank re-drives `settleComposedBounty` (fully idempotent: it replays legs 1a–1c
// then retries leg 2) and re-persists via `applyComposedSettleOutcome` (which books the
// completion + reclaim EXACTLY ONCE on the paid transition).
//
// PROVENANCE GUARD (the money invariant): a `vault_held` bounty is swept ONLY when it
// carries a genuinely APPROVED attempt — the winning hunter is resolved FROM that
// approved attempt row (`loadResumeContext`), NEVER from caller input. An UNAPPROVED
// `vault_held` bounty is a refund-path bounty (no winner) and is NEVER touched: the
// sweep query's `EXISTS(approved attempt)` filter excludes it, and
// `resumeComposedBounty`'s `no_winner` guard is the backstop. The crank still NEVER
// touches the terminal `paid`/`refunded` states.
//
// DOUBLE-BOOK / DOUBLE-PAY SAFETY under a concurrent approve retry: the approve route
// settles a just-approved bounty SYNCHRONOUSLY (also from `vault_held`), so a sweep and
// an approve can drive the SAME bounty at once. Neither can double-anything:
//   • double-PAY is impossible — every settle leg is idempotent (V2 settle claims
//     'settling' at-most-once + pg advisory lock; leg-2 payout is at-most-once on
//     `(payoutPda, ${id}:payout)`); the loser replays or gets settle_in_progress.
//   • double-BOOK is impossible — the →paid completion bump rides
//     `bookComposedBountyPaid`'s atomic CAS (`WHERE composition_state = <observed prior>
//     AND != 'paid'`). BOTH the sweep and the approve pass the SAME observed prior
//     `'vault_held'`, so the vault_held→paid flip fires for EXACTLY ONE of them; the
//     other's CAS matches 0 rows (state already 'paid') and books nothing.

/**
 * The composition states the crank is allowed to advance. `vault_held` is resumable
 * ONLY together with the sweep query's `EXISTS(approved attempt)` filter + the
 * `no_winner` provenance backstop below — an unapproved vault_held bounty (no winner)
 * is a refund-path row the crank must never settle. See the crank header for the full
 * provenance + double-book/double-pay argument.
 */
const RESUMABLE_STATES = [
  'awaiting_finalize',
  'reconcile_payout_failed',
  'vault_held',
  'reconcile_refund_unknown',
] as const;

interface ResumeContext {
  compositionState: string | null;
  escrowPda: string | null;
  creatorAvatarId: string;
  hunterAvatarId: string | null;
  approvedAttemptId: string | null;
  tokenReward: number;
  expiresAt: Date | null;
  expiryRefundRequested: boolean;
}

/** Real DB read for the crank: bounty row + its winning (approved) hunter. */
async function loadResumeContext(bountyId: string): Promise<ResumeContext | null> {
  const [row] = await db
    .select({
      compositionState: bounties.compositionState,
      escrowPda: bounties.escrowPda,
      creatorAvatarId: bounties.creatorId,
      tokenReward: bounties.tokenReward,
      expiresAt: bounties.expiresAt,
    })
    .from(bounties)
    .where(eq(bounties.id, bountyId))
    .limit(1);
  if (!row) return null;
  // The winning hunter is the single approved attempt (a composed bounty is a
  // maxAttempts=1 single-call escrow; the approve route auto-rejects the rest).
  const [attempt] = await db
    .select({ id: bountyAttempts.id, hunterId: bountyAttempts.hunterId })
    .from(bountyAttempts)
    .where(
      and(
        eq(bountyAttempts.bountyId, bountyId),
        sql`(
          ${bountyAttempts.status} = 'approved'
          OR (
            ${bountyAttempts.status} = 'rejected'
            AND ${bountyAttempts.reviewNote} IN (
              'Auto-rejected: typed on-chain escrow expiry claimed for creator refund',
              'Auto-rejected: typed on-chain escrow expiry refunded to the creator',
              'Auto-rejected: typed on-chain escrow expiry refund requires reconciliation'
            )
          )
        )`,
      ),
    )
    .limit(1);
  const [expiryIntent] = await db
    .select({ id: covenantActionRecords.id })
    .from(covenantActionRecords)
    .where(eq(covenantActionRecords.dedupeKey, `bounty:${bountyId}:refund_requested:expiry`))
    .limit(1);
  return {
    ...row,
    hunterAvatarId: attempt?.hunterId ?? null,
    approvedAttemptId: attempt?.id ?? null,
    expiryRefundRequested: Boolean(expiryIntent),
  };
}

export interface ResumeComposedBountyDeps extends ApplyComposedDeps {
  /** Test seam — the DB read (default: `loadResumeContext`). */
  loadContext?: (bountyId: string) => Promise<ResumeContext | null>;
  /** Test seam — the settle+persist step (default: `applyComposedSettleOutcome`). */
  applyOutcome?: typeof applyComposedSettleOutcome;
  /** Test seam — the persistent-wedge alert emitter (default: `alertError`). */
  alertError?: typeof alertError;
  refundExpired?: typeof refundExpiredComposedBounty;
  expiryRefundDeps?: ExpiryRefundDeps;
  reconcileRefund?: typeof reconcileExpiryRefundUnknown;
  refundReconcileDeps?: ReconcileExpiryRefundDeps;
  now?: () => Date;
}

export function isEscrowExpiredFailure(
  failure: Pick<Extract<SettleComposedBountyResult, { ok: false }>, 'code' | 'message'>,
): boolean {
  return failure.code === 'escrow_expired';
}

const EXPIRY_REFUND_CLAIM_NOTE =
  'Auto-rejected: typed on-chain escrow expiry claimed for creator refund';
const EXPIRY_REFUND_CONFIRMED_NOTE =
  'Auto-rejected: typed on-chain escrow expiry refunded to the creator';
const EXPIRY_REFUND_RECONCILE_NOTE =
  'Auto-rejected: typed on-chain escrow expiry refund requires reconciliation';
const EXPIRY_REFUND_CLAIM_LEASE_MS = 10 * 60 * 1000;

type SapRefundPriorStatus = 'open' | 'submitted';

export type ExpiryRefundClaim =
  | {
      kind: 'claimed';
      priorSapStatus: SapRefundPriorStatus;
      ownerToken: string;
      replay: boolean;
    }
  | {
      kind: 'winner';
      winner:
        | 'paid'
        | 'refunded'
        | 'refund_reconcile'
        | 'refund_in_progress'
        | 'state_drift';
      signature?: string;
    };

export type ExpiryRefundResult =
  | { ok: true; phase: 'refunded'; message: string; signature?: string }
  | { ok: true; phase: 'superseded_paid'; message: string }
  | {
      ok: false;
      phase: 'refund_failed';
      code: 'refund_failed';
      causeCode?: string;
      retryable: true;
      message: string;
    }
  | {
      ok: false;
      phase: 'refund_in_progress';
      code: 'refund_in_progress';
      retryable: true;
      message: string;
    }
  | {
      ok: false;
      phase: 'refund_reconcile';
      code: 'refund_reconcile_required';
      causeCode?: string;
      retryable: false;
      signature?: string;
      message: string;
    };

type ExpiryRefundContext = ResumeContext & {
  bountyId: string;
  escrowPda: string;
};

export interface ExpiryRefundDeps {
  claim?: (ctx: ExpiryRefundContext, ownerToken: string) => Promise<ExpiryRefundClaim>;
  refundComposed?: typeof refundComposedBounty;
  finishConfirmed?: (
    ctx: ExpiryRefundContext,
    signature: string | undefined,
    ownerToken: string,
  ) => Promise<void>;
  restoreRetryable?: (
    ctx: ExpiryRefundContext,
    priorSapStatus: SapRefundPriorStatus,
    ownerToken: string,
  ) => Promise<void>;
  markReconcile?: (
    ctx: ExpiryRefundContext,
    signature: string | undefined,
    causeCode: string,
    ownerToken: string,
  ) => Promise<void>;
}

async function claimExpiryRefund(
  ctx: ExpiryRefundContext,
  ownerToken: string,
): Promise<ExpiryRefundClaim> {
  return db.transaction(async (tx): Promise<ExpiryRefundClaim> => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.escrowPda}, 0))`,
    );
    const [bounty] = await tx
      .select({
        status: bounties.status,
        compositionState: bounties.compositionState,
        refundSignature: bounties.compositionRefundSignature,
        refundClaimId: bounties.compositionRefundClaimId,
        refundClaimedAt: bounties.compositionRefundClaimedAt,
      })
      .from(bounties)
      .where(eq(bounties.id, ctx.bountyId))
      .limit(1);
    const [attempt] = ctx.approvedAttemptId
      ? await tx
          .select({ status: bountyAttempts.status, reviewNote: bountyAttempts.reviewNote })
          .from(bountyAttempts)
          .where(eq(bountyAttempts.id, ctx.approvedAttemptId))
          .limit(1)
      : [];
    const [sap] = await tx
      .select({ status: sapEscrowSettlements.status, metadata: sapEscrowSettlements.metadata })
      .from(sapEscrowSettlements)
      .where(
        and(
          eq(sapEscrowSettlements.escrowPda, ctx.escrowPda),
          eq(sapEscrowSettlements.jobId, ctx.bountyId),
        ),
      )
      .limit(1);

    if (!bounty || !sap || !attempt) return { kind: 'winner', winner: 'state_drift' };
    if (bounty.compositionState === 'paid' || bounty.status === 'completed') {
      return { kind: 'winner', winner: 'paid' };
    }
    if (bounty.compositionState === 'refunded' || sap.status === 'refunded') {
      return { kind: 'winner', winner: 'refunded', signature: bounty.refundSignature ?? undefined };
    }
    if (bounty.compositionState === 'reconcile_refund_unknown') {
      return {
        kind: 'winner',
        winner: 'refund_reconcile',
        signature: bounty.refundSignature ?? undefined,
      };
    }

    const metadata = (sap.metadata ?? {}) as Record<string, unknown>;
    if (
      sap.status === 'refunding' &&
      bounty.status === 'cancelled' &&
      bounty.compositionState === 'vault_held' &&
      attempt.status === 'rejected' &&
      attempt.reviewNote === EXPIRY_REFUND_CLAIM_NOTE
    ) {
      const prior = metadata.expiryRefundPriorStatus;
      const priorSapStatus = prior === 'submitted' ? 'submitted' : 'open';
      if (bounty.refundClaimId === ownerToken) {
        return {
          kind: 'claimed',
          priorSapStatus,
          ownerToken,
          replay: true,
        };
      }
      const takeover = await tx
        .update(bounties)
        .set({
          compositionRefundClaimId: ownerToken,
          compositionRefundClaimedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(bounties.id, ctx.bountyId),
            eq(bounties.status, 'cancelled'),
            eq(bounties.compositionState, 'vault_held'),
            sql`${bounties.compositionRefundClaimId} IS NOT DISTINCT FROM ${bounty.refundClaimId}`,
            sql`(
              ${bounties.compositionRefundClaimedAt} IS NULL
              OR ${bounties.compositionRefundClaimedAt} <
                now() - (${EXPIRY_REFUND_CLAIM_LEASE_MS} * interval '1 millisecond')
            )`,
          ),
        )
        .returning({ id: bounties.id });
      if (takeover.length !== 1) {
        return { kind: 'winner', winner: 'refund_in_progress' };
      }
      return {
        kind: 'claimed',
        priorSapStatus,
        ownerToken,
        replay: true,
      };
    }

    if (
      bounty.status !== 'open' ||
      bounty.compositionState !== 'vault_held' ||
      attempt.status !== 'approved' ||
      (sap.status !== 'open' && sap.status !== 'submitted')
    ) {
      return { kind: 'winner', winner: 'state_drift' };
    }
    const priorSapStatus = sap.status;
    const claimedSap = await tx
      .update(sapEscrowSettlements)
      .set({
        status: 'refunding',
        metadata: { ...metadata, expiryRefundPriorStatus: priorSapStatus },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sapEscrowSettlements.escrowPda, ctx.escrowPda),
          eq(sapEscrowSettlements.jobId, ctx.bountyId),
          eq(sapEscrowSettlements.status, priorSapStatus),
        ),
      )
      .returning({ id: sapEscrowSettlements.id });
    const claimedBounty = await tx
      .update(bounties)
      .set({
        status: 'cancelled',
        covenantVerificationPassed: false,
        compositionRefundClaimId: ownerToken,
        compositionRefundClaimedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(bounties.id, ctx.bountyId),
          eq(bounties.compositionState, 'vault_held'),
          eq(bounties.status, 'open'),
        ),
      )
      .returning({ id: bounties.id });
    const claimedAttempt = await tx
      .update(bountyAttempts)
      .set({
        status: 'rejected',
        reviewNote: EXPIRY_REFUND_CLAIM_NOTE,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bountyAttempts.id, ctx.approvedAttemptId!),
          eq(bountyAttempts.bountyId, ctx.bountyId),
          eq(bountyAttempts.status, 'approved'),
        ),
      )
      .returning({ id: bountyAttempts.id });
    if (
      claimedSap.length !== 1 ||
      claimedBounty.length !== 1 ||
      claimedAttempt.length !== 1
    ) {
      throw new Error('expiry refund CAS lost under the escrow lock');
    }
    await recordCovenantAction(
      {
        action: 'bounty.refund_requested',
        subjectType: 'avatar',
        subjectId: ctx.creatorAvatarId,
        actorKind: 'system',
        dedupeKey: `bounty:${ctx.bountyId}:refund_requested:expiry`,
        payload: {
          bountyId: ctx.bountyId,
          rail: 'sap-payai-composed',
          reason: 'typed_onchain_escrow_expired',
          tokenReward: ctx.tokenReward,
          escrowPda: ctx.escrowPda,
        },
      },
      tx,
    );
    return { kind: 'claimed', priorSapStatus, ownerToken, replay: false };
  }).catch(async () => {
    const [winner] = await db
      .select({
        status: bounties.status,
        compositionState: bounties.compositionState,
        signature: bounties.compositionRefundSignature,
        claimId: bounties.compositionRefundClaimId,
      })
      .from(bounties)
      .where(eq(bounties.id, ctx.bountyId))
      .limit(1);
    if (winner?.compositionState === 'paid' || winner?.status === 'completed') {
      return { kind: 'winner', winner: 'paid' };
    }
    if (winner?.compositionState === 'refunded') {
      return { kind: 'winner', winner: 'refunded', signature: winner.signature ?? undefined };
    }
    if (winner?.compositionState === 'reconcile_refund_unknown') {
      return {
        kind: 'winner',
        winner: 'refund_reconcile',
        signature: winner.signature ?? undefined,
      };
    }
    if (
      winner?.status === 'cancelled' &&
      winner.compositionState === 'vault_held' &&
      winner.claimId
    ) {
      return { kind: 'winner', winner: 'refund_in_progress' };
    }
    return { kind: 'winner', winner: 'state_drift' };
  });
}

async function finishExpiryRefundConfirmed(
  ctx: ExpiryRefundContext,
  signature: string | undefined,
  ownerToken: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.escrowPda}, 0))`,
    );
    const finishedSap = await tx
      .update(sapEscrowSettlements)
      .set({ status: 'refunded', updatedAt: new Date() })
      .where(
        and(
          eq(sapEscrowSettlements.escrowPda, ctx.escrowPda),
          eq(sapEscrowSettlements.jobId, ctx.bountyId),
          eq(sapEscrowSettlements.status, 'refunding'),
        ),
      )
      .returning({ id: sapEscrowSettlements.id });
    const finishedBounty = await tx
      .update(bounties)
      .set({
        status: 'cancelled',
        compositionState: 'refunded',
        compositionRefundSignature: signature ?? null,
        compositionRefundClaimId: null,
        compositionRefundClaimedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bounties.id, ctx.bountyId),
          eq(bounties.status, 'cancelled'),
          eq(bounties.compositionState, 'vault_held'),
          eq(bounties.compositionRefundClaimId, ownerToken),
        ),
      )
      .returning({ id: bounties.id });
    const finishedAttempt = await tx
      .update(bountyAttempts)
      .set({ reviewNote: EXPIRY_REFUND_CONFIRMED_NOTE, updatedAt: new Date() })
      .where(
        and(
          eq(bountyAttempts.id, ctx.approvedAttemptId!),
          eq(bountyAttempts.status, 'rejected'),
          eq(bountyAttempts.reviewNote, EXPIRY_REFUND_CLAIM_NOTE),
        ),
      )
      .returning({ id: bountyAttempts.id });
    if (
      finishedSap.length !== 1 ||
      finishedBounty.length !== 1 ||
      finishedAttempt.length !== 1
    ) {
      throw new Error('expiry refund terminal CAS lost');
    }
    await recordCovenantAction(
      {
        action: 'bounty.refund',
        subjectType: 'avatar',
        subjectId: ctx.creatorAvatarId,
        dedupeKey: `bounty:${ctx.bountyId}:refund`,
        payload: {
          bountyId: ctx.bountyId,
          rail: 'sap-payai-composed',
          tokenReward: ctx.tokenReward,
          escrowPda: ctx.escrowPda,
          ...(signature ? { signature } : {}),
        },
      },
      tx,
    );
  });
}

async function restoreExpiryRefundRetryable(
  ctx: ExpiryRefundContext,
  priorSapStatus: SapRefundPriorStatus,
  ownerToken: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.escrowPda}, 0))`,
    );
    const restoredSap = await tx
      .update(sapEscrowSettlements)
      .set({ status: priorSapStatus, updatedAt: new Date() })
      .where(
        and(
          eq(sapEscrowSettlements.escrowPda, ctx.escrowPda),
          eq(sapEscrowSettlements.jobId, ctx.bountyId),
          eq(sapEscrowSettlements.status, 'refunding'),
        ),
      )
      .returning({ id: sapEscrowSettlements.id });
    const restoredBounty = await tx
      .update(bounties)
      .set({
        status: 'open',
        compositionRefundClaimId: null,
        compositionRefundClaimedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bounties.id, ctx.bountyId),
          eq(bounties.status, 'cancelled'),
          eq(bounties.compositionState, 'vault_held'),
          eq(bounties.compositionRefundClaimId, ownerToken),
        ),
      )
      .returning({ id: bounties.id });
    const restoredAttempt = await tx
      .update(bountyAttempts)
      .set({
        status: 'approved',
        reviewNote: null,
        reviewedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bountyAttempts.id, ctx.approvedAttemptId!),
          eq(bountyAttempts.status, 'rejected'),
          eq(bountyAttempts.reviewNote, EXPIRY_REFUND_CLAIM_NOTE),
        ),
      )
      .returning({ id: bountyAttempts.id });
    if (
      restoredSap.length !== 1 ||
      restoredBounty.length !== 1 ||
      restoredAttempt.length !== 1
    ) {
      throw new Error('expiry refund restore CAS lost');
    }
  });
}

async function markExpiryRefundReconcile(
  ctx: ExpiryRefundContext,
  signature: string | undefined,
  causeCode: string,
  ownerToken: string,
): Promise<void> {
  if (!signature) {
    throw new Error('cannot quarantine an expiry refund without a captured signature');
  }
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.escrowPda}, 0))`,
    );
    const [sap] = await tx
      .select({ metadata: sapEscrowSettlements.metadata })
      .from(sapEscrowSettlements)
      .where(
        and(
          eq(sapEscrowSettlements.escrowPda, ctx.escrowPda),
          eq(sapEscrowSettlements.jobId, ctx.bountyId),
        ),
      )
      .limit(1);
    const reconciledSap = await tx
      .update(sapEscrowSettlements)
      .set({
        status: 'failed',
        settleSignature: signature,
        metadata: {
          ...((sap?.metadata ?? {}) as Record<string, unknown>),
          expiryRefundBroadcastUnknown: true,
          expiryRefundError: causeCode,
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sapEscrowSettlements.escrowPda, ctx.escrowPda),
          eq(sapEscrowSettlements.jobId, ctx.bountyId),
          eq(sapEscrowSettlements.status, 'refunding'),
        ),
      )
      .returning({ id: sapEscrowSettlements.id });
    const reconciledBounty = await tx
      .update(bounties)
      .set({
        status: 'cancelled',
        compositionState: 'reconcile_refund_unknown',
        compositionRefundSignature: signature,
        compositionRefundClaimId: null,
        compositionRefundClaimedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bounties.id, ctx.bountyId),
          eq(bounties.status, 'cancelled'),
          eq(bounties.compositionState, 'vault_held'),
          eq(bounties.compositionRefundClaimId, ownerToken),
        ),
      )
      .returning({ id: bounties.id });
    const reconciledAttempt = await tx
      .update(bountyAttempts)
      .set({ reviewNote: EXPIRY_REFUND_RECONCILE_NOTE, updatedAt: new Date() })
      .where(
        and(
          eq(bountyAttempts.id, ctx.approvedAttemptId!),
          eq(bountyAttempts.status, 'rejected'),
          eq(bountyAttempts.reviewNote, EXPIRY_REFUND_CLAIM_NOTE),
        ),
      )
      .returning({ id: bountyAttempts.id });
    if (
      reconciledSap.length !== 1 ||
      reconciledBounty.length !== 1 ||
      reconciledAttempt.length !== 1
    ) {
      throw new Error('expiry refund reconcile CAS lost');
    }
  });
}

async function rereadExpiryRefundDisposition(
  ctx: ExpiryRefundContext,
): Promise<ExpiryRefundResult> {
  const [row] = await db
    .select({
      status: bounties.status,
      compositionState: bounties.compositionState,
      signature: bounties.compositionRefundSignature,
      claimId: bounties.compositionRefundClaimId,
    })
    .from(bounties)
    .where(eq(bounties.id, ctx.bountyId))
    .limit(1);
  if (row?.compositionState === 'paid' || row?.status === 'completed') {
    return { ok: true, phase: 'superseded_paid', message: 'settlement won the expiry-refund race' };
  }
  if (row?.compositionState === 'refunded') {
    return {
      ok: true,
      phase: 'refunded',
      message: 'expired composed bounty was already refunded',
      signature: row.signature ?? undefined,
    };
  }
  if (row?.compositionState === 'reconcile_refund_unknown') {
    return {
      ok: false,
      phase: 'refund_reconcile',
      code: 'refund_reconcile_required',
      retryable: false,
      signature: row.signature ?? undefined,
      message: 'an expiry refund broadcast is already awaiting reconciliation',
    };
  }
  if (row?.status === 'cancelled' && row.compositionState === 'vault_held' && row.claimId) {
    return {
      ok: false,
      phase: 'refund_in_progress',
      code: 'refund_in_progress',
      retryable: true,
      message: 'another expiry-refund owner won the database claim',
    };
  }
  return {
    ok: false,
    phase: 'refund_failed',
    code: 'refund_failed',
    retryable: true,
    message: 'expiry refund state changed; retry after re-read',
  };
}

async function ownedRefundMutation(
  ctx: ExpiryRefundContext,
  mutation: () => Promise<void>,
): Promise<ExpiryRefundResult | null> {
  try {
    await mutation();
    return null;
  } catch {
    return rereadExpiryRefundDisposition(ctx);
  }
}

type RefundReconcileClaim =
  | { kind: 'claimed'; ownerToken: string }
  | { kind: 'in_progress' }
  | { kind: 'state_changed' };

async function claimRefundReconciliation(
  ctx: ExpiryRefundContext,
  ownerToken: string,
): Promise<RefundReconcileClaim> {
  return db.transaction(async (tx): Promise<RefundReconcileClaim> => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.escrowPda}, 0))`,
    );
    const claimed = await tx
      .update(bounties)
      .set({
        compositionRefundClaimId: ownerToken,
        compositionRefundClaimedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(bounties.id, ctx.bountyId),
          eq(bounties.status, 'cancelled'),
          eq(bounties.compositionState, 'reconcile_refund_unknown'),
          sql`(
            ${bounties.compositionRefundClaimId} IS NULL
            OR ${bounties.compositionRefundClaimedAt} <
              now() - (${EXPIRY_REFUND_CLAIM_LEASE_MS} * interval '1 millisecond')
          )`,
        ),
      )
      .returning({ id: bounties.id });
    if (claimed.length === 1) return { kind: 'claimed', ownerToken };
    const [row] = await tx
      .select({
        state: bounties.compositionState,
        claimId: bounties.compositionRefundClaimId,
      })
      .from(bounties)
      .where(eq(bounties.id, ctx.bountyId))
      .limit(1);
    return row?.state === 'reconcile_refund_unknown' && row.claimId
      ? { kind: 'in_progress' }
      : { kind: 'state_changed' };
  });
}

async function releaseRefundReconciliationClaim(
  ctx: ExpiryRefundContext,
  ownerToken: string,
): Promise<void> {
  await db
    .update(bounties)
    .set({
      compositionRefundClaimId: null,
      compositionRefundClaimedAt: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(bounties.id, ctx.bountyId),
        eq(bounties.compositionState, 'reconcile_refund_unknown'),
        eq(bounties.compositionRefundClaimId, ownerToken),
      ),
    );
}

async function finishReconciledExpiryRefund(
  ctx: ExpiryRefundContext,
  ownerToken: string,
  signature: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.escrowPda}, 0))`,
    );
    const sapRows = await tx
      .update(sapEscrowSettlements)
      .set({ status: 'refunded', updatedAt: sql`now()` })
      .where(
        and(
          eq(sapEscrowSettlements.escrowPda, ctx.escrowPda),
          eq(sapEscrowSettlements.jobId, ctx.bountyId),
          eq(sapEscrowSettlements.status, 'failed'),
        ),
      )
      .returning({ id: sapEscrowSettlements.id });
    const bountyRows = await tx
      .update(bounties)
      .set({
        compositionState: 'refunded',
        compositionRefundClaimId: null,
        compositionRefundClaimedAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(bounties.id, ctx.bountyId),
          eq(bounties.status, 'cancelled'),
          eq(bounties.compositionState, 'reconcile_refund_unknown'),
          eq(bounties.compositionRefundClaimId, ownerToken),
          eq(bounties.compositionRefundSignature, signature),
        ),
      )
      .returning({ id: bounties.id });
    const attemptRows = await tx
      .update(bountyAttempts)
      .set({ reviewNote: EXPIRY_REFUND_CONFIRMED_NOTE, updatedAt: sql`now()` })
      .where(
        and(
          eq(bountyAttempts.id, ctx.approvedAttemptId!),
          eq(bountyAttempts.status, 'rejected'),
          eq(bountyAttempts.reviewNote, EXPIRY_REFUND_RECONCILE_NOTE),
        ),
      )
      .returning({ id: bountyAttempts.id });
    const withdrawalRows = await tx
      .update(sapEscrowWithdrawals)
      .set({ status: 'succeeded', failureCode: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(sapEscrowWithdrawals.subjectAvatarId, ctx.creatorAvatarId),
          eq(sapEscrowWithdrawals.requestId, `${ctx.bountyId}:refund`),
          eq(sapEscrowWithdrawals.status, 'broadcast_unknown'),
          eq(sapEscrowWithdrawals.signature, signature),
        ),
      )
      .returning({ id: sapEscrowWithdrawals.id });
    if (
      sapRows.length !== 1 ||
      bountyRows.length !== 1 ||
      attemptRows.length !== 1 ||
      withdrawalRows.length !== 1
    ) {
      throw new Error('reconciled expiry refund terminal CAS lost');
    }
    await recordCovenantAction(
      {
        action: 'bounty.refund',
        subjectType: 'avatar',
        subjectId: ctx.creatorAvatarId,
        dedupeKey: `bounty:${ctx.bountyId}:refund`,
        payload: {
          bountyId: ctx.bountyId,
          rail: 'sap-payai-composed',
          tokenReward: ctx.tokenReward,
          escrowPda: ctx.escrowPda,
          signature,
          reconciled: true,
        },
      },
      tx,
    );
  });
}

async function restoreReconciledExpiryRefund(
  ctx: ExpiryRefundContext,
  ownerToken: string,
  signature: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.escrowPda}, 0))`,
    );
    const [sap] = await tx
      .select({ metadata: sapEscrowSettlements.metadata })
      .from(sapEscrowSettlements)
      .where(
        and(
          eq(sapEscrowSettlements.escrowPda, ctx.escrowPda),
          eq(sapEscrowSettlements.jobId, ctx.bountyId),
        ),
      )
      .limit(1);
    const prior = (sap?.metadata as Record<string, unknown> | null)?.expiryRefundPriorStatus;
    const priorStatus: SapRefundPriorStatus = prior === 'submitted' ? 'submitted' : 'open';
    const sapRows = await tx
      .update(sapEscrowSettlements)
      .set({ status: priorStatus, settleSignature: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(sapEscrowSettlements.escrowPda, ctx.escrowPda),
          eq(sapEscrowSettlements.jobId, ctx.bountyId),
          eq(sapEscrowSettlements.status, 'failed'),
        ),
      )
      .returning({ id: sapEscrowSettlements.id });
    const bountyRows = await tx
      .update(bounties)
      .set({
        status: 'open',
        compositionState: 'vault_held',
        compositionRefundSignature: null,
        compositionRefundClaimId: null,
        compositionRefundClaimedAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(bounties.id, ctx.bountyId),
          eq(bounties.status, 'cancelled'),
          eq(bounties.compositionState, 'reconcile_refund_unknown'),
          eq(bounties.compositionRefundClaimId, ownerToken),
          eq(bounties.compositionRefundSignature, signature),
        ),
      )
      .returning({ id: bounties.id });
    const attemptRows = await tx
      .update(bountyAttempts)
      .set({
        status: 'approved',
        reviewNote: null,
        reviewedAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(bountyAttempts.id, ctx.approvedAttemptId!),
          eq(bountyAttempts.status, 'rejected'),
          eq(bountyAttempts.reviewNote, EXPIRY_REFUND_RECONCILE_NOTE),
        ),
      )
      .returning({ id: bountyAttempts.id });
    const withdrawalRows = await tx
      .delete(sapEscrowWithdrawals)
      .where(
        and(
          eq(sapEscrowWithdrawals.subjectAvatarId, ctx.creatorAvatarId),
          eq(sapEscrowWithdrawals.requestId, `${ctx.bountyId}:refund`),
          eq(sapEscrowWithdrawals.status, 'broadcast_unknown'),
          eq(sapEscrowWithdrawals.signature, signature),
        ),
      )
      .returning({ id: sapEscrowWithdrawals.id });
    if (
      sapRows.length !== 1 ||
      bountyRows.length !== 1 ||
      attemptRows.length !== 1 ||
      withdrawalRows.length !== 1
    ) {
      throw new Error('reconciled expiry refund restore CAS lost');
    }
  });
}

export interface ReconcileExpiryRefundDeps {
  claim?: typeof claimRefundReconciliation;
  loadCapture?: (ctx: ExpiryRefundContext) => Promise<{
    signature: string | null;
    lastValidBlockHeight: bigint | null;
  } | null>;
  release?: typeof releaseRefundReconciliationClaim;
  inspect?: (input: {
    signature: string;
    lastValidBlockHeight: number;
  }) => Promise<SapCapturedTransactionInspection>;
  finish?: typeof finishReconciledExpiryRefund;
  restore?: typeof restoreReconciledExpiryRefund;
}

export async function reconcileExpiryRefundUnknown(
  ctx: ExpiryRefundContext,
  deps: ReconcileExpiryRefundDeps = {},
): Promise<ExpiryRefundResult> {
  const ownerToken = randomUUID();
  const claim = await (deps.claim ?? claimRefundReconciliation)(ctx, ownerToken);
  if (claim.kind === 'in_progress') {
    return {
      ok: false,
      phase: 'refund_in_progress',
      code: 'refund_in_progress',
      retryable: true,
      message: 'refund reconciliation is already in progress',
    };
  }
  if (claim.kind === 'state_changed') return rereadExpiryRefundDisposition(ctx);

  const loadCapture = deps.loadCapture ?? (async () => {
    const [row] = await db
      .select({
        signature: sapEscrowWithdrawals.signature,
        lastValidBlockHeight: sapEscrowWithdrawals.lastValidBlockHeight,
      })
      .from(sapEscrowWithdrawals)
      .where(
        and(
          eq(sapEscrowWithdrawals.subjectAvatarId, ctx.creatorAvatarId),
          eq(sapEscrowWithdrawals.requestId, `${ctx.bountyId}:refund`),
          eq(sapEscrowWithdrawals.status, 'broadcast_unknown'),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  const withdrawal = await loadCapture(ctx);
  if (!withdrawal?.signature || withdrawal.lastValidBlockHeight == null) {
    await (deps.release ?? releaseRefundReconciliationClaim)(ctx, ownerToken);
    return {
      ok: false,
      phase: 'refund_reconcile',
      code: 'refund_reconcile_required',
      retryable: false,
      message: 'refund reconciliation is missing captured expiry proof',
    };
  }

  let inspection: SapCapturedTransactionInspection;
  try {
    inspection = await (deps.inspect ?? inspectCapturedSapTransaction)({
      signature: withdrawal.signature,
      lastValidBlockHeight: Number(withdrawal.lastValidBlockHeight),
    });
  } catch {
    await (deps.release ?? releaseRefundReconciliationClaim)(ctx, ownerToken);
    return {
      ok: false,
      phase: 'refund_reconcile',
      code: 'refund_reconcile_required',
      retryable: false,
      signature: withdrawal.signature,
      message: 'refund signature status could not be observed',
    };
  }

  if (inspection === 'confirmed') {
    const winner = await ownedRefundMutation(
      ctx,
      () => (deps.finish ?? finishReconciledExpiryRefund)(
        ctx,
        ownerToken,
        withdrawal.signature!,
      ),
    );
    return winner ?? {
      ok: true,
      phase: 'refunded',
      message: 'refund signature proved landed and was finalized',
      signature: withdrawal.signature,
    };
  }
  if (inspection === 'confirmed_reverted') {
    const winner = await ownedRefundMutation(
      ctx,
      () => (deps.restore ?? restoreReconciledExpiryRefund)(
        ctx,
        ownerToken,
        withdrawal.signature!,
      ),
    );
    return winner ?? {
      ok: false,
      phase: 'refund_failed',
      code: 'refund_failed',
      causeCode: inspection,
      retryable: true,
      message: 'refund proved not landed; restored the retryable expiry state',
    };
  }

  if (inspection === 'expired_missing') {
    // B3 — null signature history after blockheight expiry is not positive proof
    // that the transfer never landed. Keep the captured withdrawal and the bounty
    // in reconcile_refund_unknown for operator investigation; only a confirmed
    // on-chain revert may restore the retryable state.
    await (deps.release ?? releaseRefundReconciliationClaim)(ctx, ownerToken);
    return {
      ok: false,
      phase: 'refund_reconcile',
      code: 'refund_reconcile_required',
      causeCode: 'expired_missing',
      retryable: false,
      signature: withdrawal.signature,
      message:
        'refund blockhash expired but signature history is absent; capture remains quarantined for ops',
    };
  }

  await (deps.release ?? releaseRefundReconciliationClaim)(ctx, ownerToken);
  return {
    ok: false,
    phase: 'refund_reconcile',
    code: 'refund_reconcile_required',
    retryable: false,
    signature: withdrawal.signature,
    message: 'refund signature is still live or pending',
  };
}

export async function refundExpiredComposedBounty(
  ctx: ExpiryRefundContext,
  deps: ExpiryRefundDeps = {},
): Promise<ExpiryRefundResult> {
  const ownerToken = randomUUID();
  const claim = await (deps.claim ?? claimExpiryRefund)(ctx, ownerToken);
  if (claim.kind === 'winner') {
    if (claim.winner === 'paid') {
      return {
        ok: true,
        phase: 'superseded_paid',
        message: 'settlement won the expiry-refund race',
      };
    }
    if (claim.winner === 'refunded') {
      return {
        ok: true,
        phase: 'refunded',
        message: 'expired composed bounty was already refunded',
        signature: claim.signature,
      };
    }
    if (claim.winner === 'refund_reconcile') {
      return {
        ok: false,
        phase: 'refund_reconcile',
        code: 'refund_reconcile_required',
        retryable: false,
        signature: claim.signature,
        message: 'an expiry refund broadcast is already awaiting reconciliation',
      };
    }
    if (claim.winner === 'refund_in_progress') {
      return {
        ok: false,
        phase: 'refund_in_progress',
        code: 'refund_in_progress',
        retryable: true,
        message: 'another expiry-refund owner holds a live database lease',
      };
    }
    return {
      ok: false,
      phase: 'refund_failed',
      code: 'refund_failed',
      retryable: true,
      message: 'expiry refund CAS lost to a non-terminal state; retry after re-read',
    };
  }

  const refund = await (deps.refundComposed ?? refundComposedBounty)({
    bountyId: ctx.bountyId,
    escrowPda: ctx.escrowPda,
    creatorAvatarId: ctx.creatorAvatarId,
    tokenReward: ctx.tokenReward,
  });
  if (refund.ok === false) {
    const winner = await ownedRefundMutation(
      ctx,
      () => (deps.restoreRetryable ?? restoreExpiryRefundRetryable)(
        ctx,
        claim.priorSapStatus,
        claim.ownerToken,
      ),
    );
    if (winner) return winner;
    return {
      ok: false,
      phase: 'refund_failed',
      code: 'refund_failed',
      causeCode: refund.code,
      retryable: true,
      message: refund.message,
    };
  }

  const chain = refund.chain;
  if (chain.ok) {
    const signature = chain.dryRun ? undefined : chain.signature;
    const winner = await ownedRefundMutation(
      ctx,
      () => (deps.finishConfirmed ?? finishExpiryRefundConfirmed)(
        ctx,
        signature,
        claim.ownerToken,
      ),
    );
    if (winner) return winner;
    return {
      ok: true,
      phase: 'refunded',
      message: 'expired composed bounty refunded to creator',
      signature,
    };
  }

  if (chain.broadcast && chain.landed !== 'confirmed_reverted') {
    const signature = chain.signature;
    const winner = await ownedRefundMutation(
      ctx,
      () => (deps.markReconcile ?? markExpiryRefundReconcile)(
        ctx,
        signature,
        chain.code,
        claim.ownerToken,
      ),
    );
    if (winner) return winner;
    return {
      ok: false,
      phase: 'refund_reconcile',
      code: 'refund_reconcile_required',
      retryable: false,
      signature,
      message: chain.message,
    };
  }

  const winner = await ownedRefundMutation(
    ctx,
    () => (deps.restoreRetryable ?? restoreExpiryRefundRetryable)(
      ctx,
      claim.priorSapStatus,
      claim.ownerToken,
    ),
  );
  if (winner) return winner;
  return {
    ok: false,
    phase: 'refund_failed',
    code: 'refund_failed',
    causeCode: chain.code,
    retryable: true,
    message: chain.message,
  };
}

// ── L-3c — PERSISTENT VAULT_HELD WEDGE ALERT (throttled) ──────────────────────
//
// A `vault_held`-origin resume that ends phase `failed` is a PERSISTENT WEDGE: an
// APPROVED bounty whose settle keeps failing PRE-settle (e.g. a deterministic
// out-of-band vault close — the exact class L-1/L-2 self-heal cannot recover). It
// otherwise pages NOTHING (applyComposedSettleOutcome's `failed` case is a no-op; a
// clean `failed` return doesn't throw, so the sweep loop's console.error never fires),
// so ops would be blind until a human noticed the unpaid hunter. We alert, throttled
// per bounty to ONE page per WEDGE_ALERT_WINDOW_MS.
//
// WHY a worker-level window (not alert-error.ts's own limiter): the crank runs every
// ~5 min but alert-error.ts dedupes only 60s, so back-to-back passes would re-page.
// This 1h in-memory Map is the primary per-bounty throttle. IN-MEMORY ⇒ RESETS ON
// RESTART (acceptable for an ops signal — a still-wedged bounty simply re-pages once
// within a window after a restart). The Map is bounded to LIVE wedges two ways:
// `resumeComposedBounty` deletes a swept row's entry the moment it heals, AND
// `runComposedBountyResumePass` prunes every key not in the current pass's swept set
// (so a row resolved OUT-OF-BAND — e.g. admin-fail-refund → `refunded`, never swept
// again — cannot leak a stale entry). The throttle records DELIVERY, not attempt: the
// timestamp is set only AFTER a successful `alertError`, so a failed alert retries next
// pass.
const WEDGE_ALERT_WINDOW_MS = 60 * 60 * 1000; // 1h
const wedgeAlertLastSentAt = new Map<string, number>();
const refundAlertLastSentAt = new Map<string, number>();

/** Test-only: clear the persistent-wedge alert throttle state. */
export function _resetComposedWedgeAlerts(): void {
  wedgeAlertLastSentAt.clear();
  refundAlertLastSentAt.clear();
}

export type ResumeComposedBountyOutcome =
  | { resumed: true; phase: SettleComposedBountyResult['phase'] }
  | {
      resumed: true;
      phase:
        | 'refunded'
        | 'refund_failed'
        | 'refund_reconcile'
        | 'refund_in_progress';
    }
  | {
      resumed: false;
      reason: 'not_found' | 'not_composed' | 'not_resumable' | 'no_escrow' | 'no_winner';
    };

/**
 * Idempotently re-drive ONE stuck composed bounty toward `paid`. Safe to call
 * repeatedly (every underlying leg is idempotent); a no-op for a bounty that is not
 * composed, is terminal (`paid`/`refunded`), or is `vault_held` with NO approved
 * attempt (`no_winner` — a refund-path bounty, never settled). A `vault_held` bounty
 * WITH an approved attempt IS resumed (L-1): the winning hunter is resolved from that
 * approved attempt row. Returns a structured outcome for the worker + tests; throws
 * nothing on a normal miss.
 */
export async function resumeComposedBounty(
  bountyId: string,
  deps: ResumeComposedBountyDeps = {},
): Promise<ResumeComposedBountyOutcome> {
  const ctx = await (deps.loadContext ?? loadResumeContext)(bountyId);
  if (!ctx) return { resumed: false, reason: 'not_found' };
  if (ctx.compositionState == null) return { resumed: false, reason: 'not_composed' };
  if (!(RESUMABLE_STATES as readonly string[]).includes(ctx.compositionState)) {
    return { resumed: false, reason: 'not_resumable' };
  }
  if (!ctx.escrowPda) return { resumed: false, reason: 'no_escrow' };
  if (!ctx.hunterAvatarId || !ctx.approvedAttemptId) {
    return { resumed: false, reason: 'no_winner' };
  }

  if (ctx.compositionState === 'reconcile_refund_unknown') {
    const reconciled = await (deps.reconcileRefund ?? reconcileExpiryRefundUnknown)(
      { ...ctx, bountyId, escrowPda: ctx.escrowPda },
      deps.refundReconcileDeps,
    );
    if (reconciled.phase === 'superseded_paid') {
      refundAlertLastSentAt.delete(`${bountyId}:refund_reconcile`);
      return { resumed: true, phase: 'paid' };
    }
    if (reconciled.phase === 'refunded') {
      refundAlertLastSentAt.delete(`${bountyId}:refund_reconcile`);
    } else if (reconciled.phase === 'refund_reconcile') {
      const condition = `${bountyId}:refund_reconcile`;
      if (!refundAlertLastSentAt.has(condition)) {
        try {
          await (deps.alertError ?? alertError)({
            severity: 'critical',
            source: 'bounty-composition-expiry',
            message:
              `Composed bounty ${bountyId} refund remains quarantined: ${reconciled.message}`,
            context: {
              bountyId,
              escrowPda: ctx.escrowPda,
              code: reconciled.code,
              ...('causeCode' in reconciled && reconciled.causeCode
                ? { causeCode: reconciled.causeCode }
                : {}),
              ...(reconciled.signature
                ? { refundSignature: reconciled.signature }
                : {}),
            },
          });
          // This quarantine is persistent. Page once per live condition instead
          // of once per crank; resolution/pruning clears the entry.
          refundAlertLastSentAt.set(condition, Date.now());
        } catch {
          // Failed delivery retries on the next worker pass.
        }
      }
    }
    return { resumed: true, phase: reconciled.phase };
  }

  const currentTime = (deps.now ?? (() => new Date()))();
  const driveExpiredRefund = async (): Promise<ResumeComposedBountyOutcome> => {
    const refund = await (deps.refundExpired ?? refundExpiredComposedBounty)(
      {
        ...ctx,
        bountyId,
        escrowPda: ctx.escrowPda!,
      },
      deps.expiryRefundDeps,
    );
    const refundCondition =
      refund.phase === 'refund_failed' || refund.phase === 'refund_reconcile'
        ? `${bountyId}:${refund.phase}`
        : null;
    const now = Date.now();
    const lastRefundAlert = refundCondition
      ? refundAlertLastSentAt.get(refundCondition)
      : undefined;
    const shouldAlert =
      refundCondition == null ||
      lastRefundAlert == null ||
      now - lastRefundAlert >= WEDGE_ALERT_WINDOW_MS;
    if (shouldAlert && refund.phase !== 'refund_in_progress') {
      try {
        await (deps.alertError ?? alertError)({
      severity: refund.phase === 'refund_reconcile' ? 'critical' : 'warning',
      source: 'bounty-composition-expiry',
      message:
        refund.phase === 'refunded'
          ? `Composed bounty ${bountyId} returned typed escrow_expired and was refunded to the creator.`
          : refund.phase === 'superseded_paid'
            ? `Composed bounty ${bountyId} settlement won the expiry-refund race; no refund was sent.`
            : refund.phase === 'refund_reconcile'
              ? `Composed bounty ${bountyId} refund broadcast is unknown and requires signature reconciliation.`
              : `Composed bounty ${bountyId} typed expiry refund failed before broadcast and remains retryable: ${refund.message}`,
      context: {
        bountyId,
        tokenReward: ctx.tokenReward,
        refundOk: refund.ok,
        ...('signature' in refund && refund.signature
          ? { refundSignature: refund.signature }
          : {}),
        ...(!refund.ok && refund.code ? { code: refund.code } : {}),
      },
        });
        if (refundCondition) refundAlertLastSentAt.set(refundCondition, now);
      } catch {
        // Delivery failure retries next pass and does not advance the throttle.
      }
    }
    if (refund.phase === 'refunded' || refund.phase === 'superseded_paid') {
      refundAlertLastSentAt.delete(`${bountyId}:refund_failed`);
      refundAlertLastSentAt.delete(`${bountyId}:refund_reconcile`);
    }
    wedgeAlertLastSentAt.delete(bountyId);
    if (refund.phase === 'superseded_paid') return { resumed: true, phase: 'paid' };
    return { resumed: true, phase: refund.phase };
  };

  if (ctx.compositionState === 'vault_held' && ctx.expiryRefundRequested) {
    return driveExpiredRefund();
  }

  const settled = await (deps.applyOutcome ?? applyComposedSettleOutcome)(
    {
      bountyId,
      creatorAvatarId: ctx.creatorAvatarId,
      hunterAvatarId: ctx.hunterAvatarId,
      escrowPda: ctx.escrowPda,
      tokenReward: ctx.tokenReward,
      // The CAS guard: the crank books →paid only if the row is STILL at the state
      // it just loaded (vault_held | awaiting_finalize | reconcile_payout_failed).
      expectedPriorState: ctx.compositionState,
    },
    deps,
  );

  if (
    ctx.compositionState === 'vault_held' &&
    settled.phase === 'failed' &&
    isEscrowExpiredFailure(settled)
  ) {
    return driveExpiredRefund();
  }

  // L-3c — page ops on a PERSISTENT vault_held wedge (an APPROVED vault_held bounty
  // whose resume ends `failed`), throttled per bounty (see WEDGE_ALERT_WINDOW_MS).
  // Only the crank reaches here for a vault_held row — the approve route settles
  // synchronously and surfaces the error over HTTP — so this is precisely the
  // "keeps wedging on the sweep" signal that otherwise pages nothing.
  if (ctx.compositionState === 'vault_held') {
    if (settled.phase === 'failed') {
      const now = Date.now();
      const last = wedgeAlertLastSentAt.get(bountyId);
      if (last === undefined || now - last >= WEDGE_ALERT_WINDOW_MS) {
        // Record the timestamp only AFTER a SUCCESSFUL send — throttle on DELIVERY,
        // not attempt — so a throwing/failed alert retries next pass (bounded by the
        // ~5-min crank cadence + alert-error.ts's own 60s limiter) instead of being
        // suppressed for a full hour. The try/catch also keeps this fn's "throws
        // nothing" contract (alertError is non-throwing in prod; a test spy may throw).
        try {
          await (deps.alertError ?? alertError)({
            severity: 'critical',
            source: 'bounty-composition',
            message:
              `Composed bounty ${bountyId}: an APPROVED vault_held bounty keeps FAILING to settle ` +
              `on the resume crank (${settled.code}): ${settled.message}. The creator's USDC is still ` +
              `safely custodied in the vault (no money moved) but the hunter is UNPAID — a persistent ` +
              `pre-settle wedge needs ops (reconcile the on-chain vault, or admin-fail-refund). ` +
              (ctx.expiresAt
                ? `escrow expires at ${ctx.expiresAt.toISOString()} (in ${Math.max(0, Math.ceil((ctx.expiresAt.getTime() - currentTime.getTime()) / 3_600_000))}h).`
                : 'escrow has no expiry and will not auto-refund.'),
            context: { bountyId, escrowPda: ctx.escrowPda, code: settled.code, phase: 'failed' },
          });
          wedgeAlertLastSentAt.set(bountyId, now);
        } catch (err) {
          console.warn(`[bounty-composition] wedge alert failed for ${bountyId} (non-fatal; retries next pass):`, err);
        }
      }
    } else {
      // Healed/advanced — drop the throttle entry so the Map stays bounded to
      // currently-wedged bounties (and a future re-wedge alerts promptly).
      wedgeAlertLastSentAt.delete(bountyId);
    }
  }

  return { resumed: true, phase: settled.phase };
}

// ─── the DARK-gated resume worker (mirrors startWithdrawResumeWorker) ─────────

const RESUME_POLL_MS_DEFAULT = 300_000; // 5 min
const RESUME_POLL_MS_FLOOR = 60_000; // 1 min
const RESUME_BATCH = 50;

function resolveResumePollMs(): number {
  const raw = process.env.SAP_BOUNTY_RESUME_POLL_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= RESUME_POLL_MS_FLOOR ? n : RESUME_POLL_MS_DEFAULT;
}

/**
 * One sweep: advance composed bounties stuck in a resumable state, TWO-TIER by
 * priority so the L-1 `vault_held` class can NEVER starve money-mid-flight rows.
 *
 * TIER 1 (money mid-flight — ALWAYS taken first): `awaiting_finalize` /
 * `reconcile_payout_failed`. A settle already reserved principal on-chain
 * (awaiting_finalize) or finalized it to the house with the hunter still unpaid
 * (reconcile_payout_failed) — these are DELAYED REAL PAYOUTS. They take the whole
 * batch if that many exist, and can never be crowded out by tier 2.
 *
 * TIER 2 (only with the slots tier 1 leaves): `vault_held` WITH an approved attempt
 * (the L-1 wedge self-heal). No money has moved yet (the creator's USDC is still in
 * the vault), so a delayed retry here is strictly less urgent than a mid-flight
 * payout. The EXISTS is the money-provenance guard (an unapproved vault_held is a
 * refund-path row, NEVER swept); `resumeComposedBounty` re-reads the approved attempt
 * (`no_winner` backstop) before any settle. Both tiers order `updated_at` ASC
 * (oldest-stuck first).
 *
 * RESIDUAL (accepted, deferred to the L-3 slice): WITHIN tier 2, a PERMANENTLY-wedged
 * vault_held row (e.g. a deterministic pre-settle failure such as an out-of-band vault
 * close) keeps occupying a slot every pass — a no-op `failed` resume does NOT bump
 * `bounties.updated_at`, so the same oldest rows resurface first — so ≥ RESUME_BATCH
 * simultaneous permanent wedges would starve NEWER vault_held wedges. Still MONEY-SAFE
 * (the creator's USDC stays custodied; only a delayed payout, and tier 1 is untouched).
 * NOT fixed here because the real fix is a terminal quarantine / backoff, which needs a
 * NEW composition_state — a bigger change than this availability nit warrants. A clean
 * `failed` resume DOES now page ops (the L-3c persistent-wedge alert in
 * `resumeComposedBounty`, throttled per bounty), so ops sees a stuck approved bounty long
 * before a batch-size backlog accumulates; only the terminal quarantine/backoff remains
 * deferred.
 */
export async function runComposedBountyResumePass(): Promise<void> {
  // Composed settlement remains founder-gated. Tier-1 expiry is owned by the
  // independent bounty-tier1-sweeper and never enters this SAP worker.
  if (bountySettlementRail() !== 'sap-payai-composed') return;

  // TIER 1 — money mid-flight; never starved by tier 2.
  const priority = await db
    .select({ id: bounties.id })
    .from(bounties)
    .where(sql`${bounties.compositionState} IN (
      'reconcile_refund_unknown',
      'awaiting_finalize',
      'reconcile_payout_failed'
    )`)
    .orderBy(asc(bounties.updatedAt))
    .limit(RESUME_BATCH);

  // TIER 2 — vault_held + approved (L-1), ONLY the slots tier 1 left free.
  const remaining = RESUME_BATCH - priority.length;
  let vaultHeld: Array<{ id: string }> = [];
  if (remaining > 0) {
    vaultHeld = await db
      .select({ id: bounties.id })
      .from(bounties)
      .where(
        sql`(
          ${bounties.compositionState} = 'vault_held'
          AND (
            EXISTS (
              SELECT 1 FROM ${bountyAttempts}
              WHERE ${bountyAttempts.bountyId} = ${bounties.id}
                AND ${bountyAttempts.status} = 'approved'
            )
            OR (
              EXISTS (
                SELECT 1 FROM ${covenantActionRecords}
                WHERE ${covenantActionRecords.dedupeKey} =
                  ('bounty:' || ${bounties.id}::text || ':refund_requested:expiry')
              )
              AND NOT EXISTS (
                SELECT 1 FROM ${covenantActionRecords}
                WHERE ${covenantActionRecords.dedupeKey} =
                  ('bounty:' || ${bounties.id}::text || ':refund')
              )
            )
          )
        )`,
      )
      .orderBy(asc(bounties.updatedAt))
      .limit(remaining);
  }

  const stuck = [...priority, ...vaultHeld];

  // Bound the L-3c wedge-alert throttle Map to CURRENTLY-swept rows. Without this, a
  // bounty that wedged (got an entry) and was then resolved OUT-OF-BAND (admin-fail-
  // refund → composition_state='refunded') is never swept again, so the delete-on-heal
  // path in resumeComposedBounty never runs and its entry lingers until restart. Dropping
  // every key not in this pass's swept set truly bounds the Map to live wedges. (A key
  // that merely fell out of the RESUME_BATCH-capped batch while STILL wedged simply
  // re-alerts when it re-enters — benign, and only reachable under a >batch wedge backlog,
  // itself a paged ops emergency.)
  const swept = new Set(stuck.map((b) => b.id));
  for (const k of wedgeAlertLastSentAt.keys()) {
    if (!swept.has(k)) wedgeAlertLastSentAt.delete(k);
  }
  for (const k of refundAlertLastSentAt.keys()) {
    const bountyId = k.slice(0, k.lastIndexOf(':'));
    if (!swept.has(bountyId)) refundAlertLastSentAt.delete(k);
  }

  for (const b of stuck) {
    try {
      await resumeComposedBounty(b.id);
    } catch (err) {
      // Never let one bounty's failure abort the sweep; the row stays stuck and
      // is retried next pass (and the reconcile alert already paged ops).
      console.error(`[bounty-composition] resume pass failed for ${b.id} (non-fatal):`, err);
    }
  }
}

let resumeWorkerInterval: ReturnType<typeof setInterval> | null = null;

/** True while the resume-worker interval is live (tests + ops introspection). */
export function isComposedBountyResumeWorkerRunning(): boolean {
  return resumeWorkerInterval !== null;
}

/**
 * Start the composed-bounty crank (idempotent). The pass gates work on the
 * composed SAP rail, so a paused rail never reaches chain settlement code.
 * Each pass is idempotent crash-recovery.
 */
export function startComposedBountyResumeWorker(): void {
  if (resumeWorkerInterval) return;
  const periodMs = resolveResumePollMs();
  resumeWorkerInterval = setInterval(() => {
    runComposedBountyResumePass().catch((err) => {
      console.error('[bounty-composition] resume worker pass failed (non-fatal):', err);
    });
  }, periodMs);
  console.log(
    `[bounty-composition] resume worker started, sweeping founder-gated ` +
      `composition settlement every ${Math.round(periodMs / 60_000)}min`,
  );
}

/** Stop the resume worker interval (graceful shutdown). Idempotent. */
export function stopComposedBountyResumeWorker(): void {
  if (resumeWorkerInterval) {
    clearInterval(resumeWorkerInterval);
    resumeWorkerInterval = null;
  }
}
