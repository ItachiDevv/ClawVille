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

import { db, bounties, bountyAttempts, bountyReputation, eq, and, sql } from '@clawville/database';
import { asc, ne } from 'drizzle-orm';
import {
  settleComposedBounty as settleComposedBountyImpl,
  bountySettlementRail,
  type SettleComposedBountyResult,
} from './bounty-escrow-link';
import { alertError } from './alert-error';
import { recordCovenantAction } from './covenant-action-recorder';
import { enqueueBountyReputation } from './sap/sap-reputation-writer';

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
const RESUMABLE_STATES = ['awaiting_finalize', 'reconcile_payout_failed', 'vault_held'] as const;

interface ResumeContext {
  compositionState: string | null;
  escrowPda: string | null;
  creatorAvatarId: string;
  hunterAvatarId: string | null;
  tokenReward: number;
}

/** Real DB read for the crank: bounty row + its winning (approved) hunter. */
async function loadResumeContext(bountyId: string): Promise<ResumeContext | null> {
  const [row] = await db
    .select({
      compositionState: bounties.compositionState,
      escrowPda: bounties.escrowPda,
      creatorAvatarId: bounties.creatorId,
      tokenReward: bounties.tokenReward,
    })
    .from(bounties)
    .where(eq(bounties.id, bountyId))
    .limit(1);
  if (!row) return null;
  // The winning hunter is the single approved attempt (a composed bounty is a
  // maxAttempts=1 single-call escrow; the approve route auto-rejects the rest).
  const [attempt] = await db
    .select({ hunterId: bountyAttempts.hunterId })
    .from(bountyAttempts)
    .where(and(eq(bountyAttempts.bountyId, bountyId), eq(bountyAttempts.status, 'approved')))
    .limit(1);
  return { ...row, hunterAvatarId: attempt?.hunterId ?? null };
}

export interface ResumeComposedBountyDeps extends ApplyComposedDeps {
  /** Test seam — the DB read (default: `loadResumeContext`). */
  loadContext?: (bountyId: string) => Promise<ResumeContext | null>;
  /** Test seam — the settle+persist step (default: `applyComposedSettleOutcome`). */
  applyOutcome?: typeof applyComposedSettleOutcome;
  /** Test seam — the persistent-wedge alert emitter (default: `alertError`). */
  alertError?: typeof alertError;
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

/** Test-only: clear the persistent-wedge alert throttle state. */
export function _resetComposedWedgeAlerts(): void {
  wedgeAlertLastSentAt.clear();
}

export type ResumeComposedBountyOutcome =
  | { resumed: true; phase: SettleComposedBountyResult['phase'] }
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
  if (!ctx.hunterAvatarId) return { resumed: false, reason: 'no_winner' };

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
              `pre-settle wedge needs ops (reconcile the on-chain vault, or admin-fail-refund).`,
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
  // TIER 1 — money mid-flight; never starved by tier 2.
  const priority = await db
    .select({ id: bounties.id })
    .from(bounties)
    .where(sql`${bounties.compositionState} IN ('awaiting_finalize', 'reconcile_payout_failed')`)
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
          AND EXISTS (
            SELECT 1 FROM ${bountyAttempts}
            WHERE ${bountyAttempts.bountyId} = ${bounties.id}
              AND ${bountyAttempts.status} = 'approved'
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
 * Start the recurring composed-bounty resume worker (idempotent). DARK-SAFE double
 * gate: the index.ts boot wiring only calls this when the composed rail is fully
 * live (`bountySettlementRail() === 'sap-payai-composed'`), AND this refuses to
 * start otherwise — so no worker polls a dark rail (and no stuck rows can exist
 * while it is off: an `awaiting_finalize`/`reconcile` row only appears after the
 * rail has been on). Each pass is idempotent crash-recovery.
 */
export function startComposedBountyResumeWorker(): void {
  if (resumeWorkerInterval) return;
  if (bountySettlementRail() !== 'sap-payai-composed') return; // dark — never poll while off
  const periodMs = resolveResumePollMs();
  resumeWorkerInterval = setInterval(() => {
    runComposedBountyResumePass().catch((err) => {
      console.error('[bounty-composition] resume worker pass failed (non-fatal):', err);
    });
  }, periodMs);
  console.log(
    `[bounty-composition] resume worker started — advancing stuck composed bounties every ` +
      `${Math.round(periodMs / 60_000)}min (finalize leg 1c + retry leg 2; every leg idempotent)`,
  );
}

/** Stop the resume worker interval (graceful shutdown). Idempotent. */
export function stopComposedBountyResumeWorker(): void {
  if (resumeWorkerInterval) {
    clearInterval(resumeWorkerInterval);
    resumeWorkerInterval = null;
  }
}
