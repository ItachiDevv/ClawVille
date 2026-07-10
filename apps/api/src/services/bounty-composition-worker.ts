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
import { ne } from 'drizzle-orm';
import {
  settleComposedBounty as settleComposedBountyImpl,
  bountySettlementRail,
  type SettleComposedBountyResult,
} from './bounty-escrow-link';
import { alertError } from './alert-error';

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
 * counter and a USDC reward must never inflate it). Only ever called from inside
 * the atomic `paid`-claim below, so it runs exactly once per bounty.
 */
async function bookHunterCompletion(hunterAvatarId: string, now: Date): Promise<void> {
  const rep = await db.query.bountyReputation.findFirst({
    where: eq(bountyReputation.avatarId, hunterAvatarId),
  });
  if (rep) {
    const bumped = rep.totalCompleted + 1;
    await db
      .update(bountyReputation)
      .set({
        totalCompleted: bumped,
        tier: reputationTier(bumped) as any,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(bountyReputation.id, rep.id));
  } else {
    await db.insert(bountyReputation).values({
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
  const claimed = await db
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
  await bookHunterCompletion(input.hunterAvatarId, now);
  return { booked: true };
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
// The crank re-drives `settleComposedBounty` (fully idempotent: it replays legs
// 1a–1c then retries leg 2) and re-persists via `applyComposedSettleOutcome`
// (which books the completion + reclaim EXACTLY ONCE on the paid transition). It
// NEVER touches `vault_held` (never approved → no winning hunter to pay) or the
// terminal `paid`/`refunded` states.

/** The composition states the crank is allowed to advance. */
const RESUMABLE_STATES = ['awaiting_finalize', 'reconcile_payout_failed'] as const;

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
}

export type ResumeComposedBountyOutcome =
  | { resumed: true; phase: SettleComposedBountyResult['phase'] }
  | {
      resumed: false;
      reason: 'not_found' | 'not_composed' | 'not_resumable' | 'no_escrow' | 'no_winner';
    };

/**
 * Idempotently re-drive ONE stuck composed bounty toward `paid`. Safe to call
 * repeatedly (every underlying leg is idempotent); a no-op for a bounty that is
 * not composed, is terminal (`paid`/`refunded`), or was never approved
 * (`vault_held` — nothing to pay out). Returns a structured outcome for the worker
 * + tests; throws nothing on a normal miss.
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
      // it just loaded (awaiting_finalize | reconcile_payout_failed).
      expectedPriorState: ctx.compositionState,
    },
    deps,
  );
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

/** One sweep: advance every composed bounty stuck in a resumable state. */
export async function runComposedBountyResumePass(): Promise<void> {
  const stuck = await db
    .select({ id: bounties.id })
    .from(bounties)
    .where(sql`${bounties.compositionState} IN ('awaiting_finalize', 'reconcile_payout_failed')`)
    .limit(RESUME_BATCH);
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
