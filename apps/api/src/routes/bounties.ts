import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { adminOnly } from '../middleware/admin-only';
import { noStorePrivate } from '../middleware/no-store';
import { creditClawTokens, debitClawTokens } from '../services/claw-token-ledger';
// Covenant action-record stream (2026-07-13): bounty lifecycle commitments
// (create/claim/submit/approve/reject/settle/refund) append records in the SAME
// tx as their writes. vCLAW money legs additionally emit economy.* records via
// the ledger hook; USDC on-chain/x402 legs (which never touch the vCLAW ledger)
// get explicit bounty.settle records.
import {
  recordCovenantAction,
  type CovenantActorKind,
} from '../services/covenant-action-recorder';
import { createHash } from 'crypto';

/** Map the auth identity kind onto the covenant actor vocabulary. */
const toActorKind = (kind: 'user' | 'agent'): CovenantActorKind =>
  kind === 'user' ? 'human' : 'agent';
import {
  bountySettlementRail,
  openComposedBountyEscrow,
  refundBountyEscrow,
  refundComposedBounty,
  runBountyUsdcSettle,
  settleComposedBounty,
  usdcRewardBaseUnits,
  usdcRailGateOpen,
} from '../services/bounty-escrow-link';
import { alertError } from '../services/alert-error';
// R-team-lead ruling: the →paid booking (completed flip + composition_state='paid' +
// the once-only completion/reputation bump) is the ONE transition reached by BOTH this
// route (instant approve→paid, prior 'vault_held') AND the finalize/payout crank
// (deferred awaiting_finalize→paid). It is a single SHARED write path — owned by
// `bookComposedBountyPaid` under a per-path CAS on the expected prior — so the two authors
// can never drift (a future hook added to one path but not the other would else book
// deferred payouts differently than instant ones).
import { bookComposedBountyPaid } from '../services/bounty-composition-worker';
import {
  db,
  avatars,
  agentConfigs,
  avatarInventory,
  bounties,
  bountyRewards,
  bountyAttempts,
  bountyReputation,
} from '@clawville/database';
import { eq, and, desc, asc, sql, ne } from 'drizzle-orm';
import { count } from 'drizzle-orm';

// ── Rule E5 agent parity (Phase 1). Every WRITE binds to `identity.avatarId`
// from `requireAuthOrAgentSession` — the SAME avatar for a Lucia human AND a
// connected/hosted agent (`X-Clawville-Agent-Session` → its bound avatar). The
// route group runs `sessionMiddleware` FIRST so the middleware can read
// `c.get('user')` for the human path; the agent path reads the session header.
// The existing escrow + self-deal guards (creator≠claimant, only-creator-reviews,
// only-creator-cancels) are unchanged — they were already keyed on the acting
// avatar id, which is now the resolved `identity.avatarId`.
//
// PARITY note — human path: POST /api/bounties/* via Lucia cookie; agent path:
//   same endpoints via X-Clawville-Agent-Session → bound avatar. vCLAW settlement
//   binds to `claw-token-ledger` on `identity.avatarId`; USDC (payment_rail=usdc)
//   settlement binds to the SAP escrow gate (depositor=creator avatar,
//   worker=hunter avatar) — both act as themselves, no guest fallback.
export const bountyRoutes = new Hono<ActivityAuthContext>();
bountyRoutes.use('*', sessionMiddleware);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the acting avatar (full row) from the dual-identity middleware.
 * `requireAuthOrAgentSession` already proved a live human/agent session and
 * resolved a real, active `identity.avatarId` (it 403s an unbound/expired agent
 * and a user with no active avatar). We re-load the row by THAT id (never a
 * body-supplied id) so we have `clawTokens`/`id`/`userId` for escrow checks +
 * audit. The id comes from the middleware, not the request body — unspoofable.
 */
async function getActingAvatar(c: {
  get: (k: 'identity') => ActivityAuthContext['Variables']['identity'];
}) {
  const identity = c.get('identity');
  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.id, identity.avatarId),
  });
  if (!avatar) throw new HTTPException(404, { message: 'No active agent found' });
  return avatar;
}

/**
 * Is the acting identity a connected/hosted agent that has NOT proven ledger
 * capability (ownership of its avatar)? Such a session may perceive/chat but must
 * NEVER drive a real-money (custodial-wallet) transition — the USDC escrow rail.
 * The CT rail is fine for any resolved avatar (CT is the in-game economy, not a
 * custodial sign). Mirrors the cove / SAP `requireLedgerCapable` gate.
 */
function agentNotLedgerCapable(
  identity: ActivityAuthContext['Variables']['identity'],
): boolean {
  return identity.kind === 'agent' && identity.ledgerCapable !== true;
}

/**
 * Map an escrow-gate failure code → an HTTP status (mirrors sap.ts
 * `gateFailureStatus`). Used when a USDC bounty's escrow leg fails so the caller
 * gets a clean, honest status instead of a 500. A dry-run escrow leg NEVER errors
 * on the gate itself; a `gate_disabled` (rail off) surfaces as 503.
 */
function escrowFailureStatus(code: string): 400 | 403 | 404 | 409 | 500 | 502 | 503 {
  switch (code) {
    case 'gate_disabled':
    case 'sap_disabled':
    case 'sap_escrow_disabled':
    case 'sap_usdc_escrow_disabled':
    case 'payai_rail_disabled':
    case 'mainnet_broadcast_refused':
      return 503;
    case 'wallet_pubkey_missing':
    case 'avatar_wallet_missing':
    case 'job_not_found':
      return 404;
    case 'verification_failed':
    case 'not_approved':
    case 'approver_mismatch':
    case 'self_dealing_forbidden':
    case 'unauthorized_caller':
    // Composed rail (V2): a settle/finalize/refund whose row is on the wrong rail.
    case 'release_rail_forbidden':
      return 403;
    case 'over_release':
      return 400;
    case 'already_settled':
    case 'settle_in_progress':
    case 'refund_in_progress':
    case 'funding_unconfirmed':
    case 'job_not_open':
    case 'rail_mixed_forbidden':
    // Composed rail (V2 settle/finalize) — ops-reconcile / retryable conflicts.
    case 'finalize_in_progress':
    case 'finalize_not_ready':
    case 'unreconciled_onchain_pending':
    case 'settle_slot_consumed':
    // Composed rail (V2 refund idempotency, from `refundComposedBounty`).
    case 'withdraw_in_flight':
    case 'withdraw_request_mismatch':
      return 409;
    case 'rpc_unreachable':
    case 'payai_unavailable':
    case 'payai_release_failed':
    // Composed rail (V2): a broadcast-unknown / unverifiable on-chain state — the
    // pending/settle/finalize MAY have landed; reconcile, never auto-retry.
    case 'settle_unconfirmed':
    case 'finalize_unconfirmed':
    case 'pending_state_unverifiable':
      return 502;
    case 'internal':
      return 500;
    default:
      return 400;
  }
}

/**
 * The escrow-gate failure codes that `openEscrowV2` (escrow-gate.ts, reached via
 * `openComposedBountyEscrow`) returns ONLY on a PROVABLY PRE-BROADCAST path — the
 * fund transaction was never broadcast, so the creator's USDC was NEVER moved and
 * NO on-chain vault can exist. ONLY on one of these is it money-safe to DELETE the
 * just-inserted composed bounty (there is nothing to orphan). Enumerated against
 * `openEscrowV2` (escrow-gate.ts ~L1145-1262), each with WHY it is pre-broadcast:
 *
 *   - 'release_rail_forbidden'   — rail / row-rail validation, BEFORE any chain call.
 *   - 'self_dealing_forbidden'   — depositor==worker guard, BEFORE any chain call.
 *   - 'invalid_amount'           — amount / coverage-floor guard, BEFORE any chain call.
 *   - 'wallet_pubkey_missing'    — worker/depositor wallet lookup, BEFORE any chain call.
 *   - 'invalid_pubkey'/'invalid_mint' — V2 PDA-address derivation failure, BEFORE any chain call.
 *   - 'internal'                 — house-not-provisioned (openComposedBountyEscrow) OR the
 *                                  settlement-ledger insert failure — BOTH strictly BEFORE the
 *                                  create/deposit chain send.
 *   - 'on_chain_error'           — returned ONLY pre-broadcast: the `chain.broadcast===false`
 *                                  passthrough (the gate already DELETED its own settlement
 *                                  row) AND the dry-run funding simulation failure "before
 *                                  broadcast" (the gate deletes its row there too).
 *   - 'sap_disabled'/'sap_escrow_disabled'/'sap_usdc_escrow_disabled'/'gate_disabled'
 *                                — the self-gate short-circuit: the rail is OFF, nothing runs.
 *
 * DELIBERATELY EXCLUDED — 'funding_unconfirmed': the ONE broadcast-UNKNOWN code
 * (`chain.broadcast===true` but the confirm never landed). The gate persisted a
 * `funding_unknown` settlement row + signature and the creator's USDC MAY be in the
 * vault. And, FAIL-CLOSED, EVERY code NOT in this set defaults to KEEP: an unknown /
 * newly-added failure code is treated as possible-custody, because a possibly-funded
 * vault must never be orphaned by a delete. The cost of a false KEEP is an ops reconcile
 * that finds no vault (derive it from the deterministic bounty nonce); the cost of a
 * false DELETE is the creator's lost USDC. We bias hard to KEEP.
 *
 * Exported so the composed-bounty unit suite can lock this classification (the exact
 * KEEP-vs-DELETE money decision the create path switches on) without a DB/route harness.
 */
export const PRE_BROADCAST_NO_CUSTODY: ReadonlySet<string> = new Set([
  'release_rail_forbidden',
  'self_dealing_forbidden',
  'invalid_amount',
  'wallet_pubkey_missing',
  'invalid_pubkey',
  'invalid_mint',
  'internal',
  // The V2 coverage rejections (escrow-gate.ts L1194-1207 →
  // preflightCreate/DepositEscrowV2Coverage in sap-client.ts): 'stake_below_coverage'
  // (checkAgentStakeCoverage — the house worker's on-chain stake does not cover this
  // bounty's obligation; the REALISTIC over-budget-bounty create failure) and its
  // top-up sibling 'escrow_coverage_exceeded' (checkEscrowDepositCoverage). These have
  // TWO origins (impl2 cross-review): (1) the read-only coverage preflight, which returns
  // strictly BEFORE the L1234 chain send — no broadcast, no custody; AND (2) the on-chain
  // custom-error map (sap-client 6145→stake_below_coverage / 6153→escrow_coverage_exceeded).
  // The on-chain origin is STILL delete-safe, but the safety is LOAD-BEARING on an
  // invariant elsewhere: openEscrowV2's broadcast branch returns ONLY 'funding_unconfirmed'
  // (never chain.code) on broadcast===true, so a landed-revert 6145/6153 is MASKED and can
  // reach here ONLY broadcast===false; and 6145/6153 are pre-fund-movement validation
  // errors (a rejected create moves no USDC → no vault even if it landed-reverted). If that
  // masking in openEscrowV2 ever changes, RE-REVIEW these two codes' delete-safety.
  'stake_below_coverage',
  'escrow_coverage_exceeded',
  'on_chain_error',
  'sap_disabled',
  'sap_escrow_disabled',
  'sap_usdc_escrow_disabled',
  'gate_disabled',
]);

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(id: string, label = 'Resource') {
  if (!uuidRegex.test(id)) {
    throw new HTTPException(404, { message: `${label} not found` });
  }
}

function calculateReputationTier(totalCompleted: number): string {
  if (totalCompleted >= 50) return 'master';
  if (totalCompleted >= 25) return 'expert';
  if (totalCompleted >= 10) return 'journeyman';
  if (totalCompleted >= 3) return 'apprentice';
  return 'newcomer';
}

/** Recalculate successRate for a hunter based on their attempt history */
type BountyTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function recalculateSuccessRate(avatarId: string, tx?: BountyTx): Promise<number> {
  const qb = tx ?? db;
  const attemptCounts = await qb
    .select({
      status: bountyAttempts.status,
      count: count(),
    })
    .from(bountyAttempts)
    .where(
      and(
        eq(bountyAttempts.hunterId, avatarId),
        sql`${bountyAttempts.status} IN ('approved', 'rejected')`
      )
    )
    .groupBy(bountyAttempts.status);

  let approved = 0;
  let total = 0;
  for (const row of attemptCounts) {
    total += row.count;
    if (row.status === 'approved') approved = row.count;
  }

  return total === 0 ? 100 : Math.round((approved / total) * 100);
}

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Business ceiling for a USDC-rail bounty reward, denominated in vCLAW. A create over this
 * is a clean 400 at the schema boundary (solana SEV-3) — NOT a u64-range throw
 * deep in the escrow instruction builder. 1,000,000 vCLAW ($10,000) × 10^4 =
 * 1e10 USDC base units, far inside signed-u64 headroom and above any realistic bounty. The
 * floor is `USDC_BOUNTY_REWARD_MIN` (below). Bump deliberately if the product ever
 * needs a larger single-bounty escrow.
 */
const USDC_BOUNTY_REWARD_MAX = 1_000_000;

/**
 * Env-configurable FLOOR for a USDC-rail bounty reward in vCLAW. Default 5;
 * clamped to an integer ≥ 1. Set `USDC_BOUNTY_REWARD_MIN=1` on the staging smoke box
 * to permit a 1-vCLAW ($0.01) smoke bounty. The vCLAW rail floor is fixed at 5,
 * enforced separately in the superRefine. Read per-parse (env-driven, no
 * redeploy needed beyond the Coolify env set). Exported pure resolver for tests.
 */
export function resolveUsdcBountyRewardMin(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '5', 10);
  return Number.isInteger(n) && n >= 1 ? n : 5;
}

const bonusRewardSchema = z.object({
  rewardType: z.enum(['agent_config', 'knowledge_book', 'custom']),
  agentConfigId: z.string().uuid().optional(),
  bookId: z.string().optional(),
  customDescription: z.string().max(500).optional(),
});

export const createBountySchema = z
  .object({
    title: z.string().min(3).max(200),
    description: z.string().min(10).max(5000),
    requirements: z.string().max(5000).optional(),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced', 'expert']),
    // Positive-integer reward; the RAIL-SPECIFIC floor is enforced in the superRefine
    // (vCLAW: 5; USDC: `USDC_BOUNTY_REWARD_MIN`, default 5, overridable to 1 for
    // the staging smoke). The field-level floor is the absolute minimum valid for
    // either rail (1), then the rail-specific checks apply below. The canonical unit
    // is vCLAW (1 vCLAW = $0.01); USDC escrow converts it to integer base units × 10^4.
    tokenReward: z.number().int().min(1),
    maxAttempts: z.number().int().min(1).max(100).default(1),
    tags: z.array(z.string().max(30)).max(10).optional(),
    expiresAt: z.string().datetime().optional(),
    bonusRewards: z.array(bonusRewardSchema).max(5).optional(),
    // ── Phase 1: USDC rail (default 'vclaw' = the in-game vCLAW board) ──
    /** Payout rail. 'usdc' opens a SAP escrow (gated OFF + dry-run by default). */
    paymentRail: z.enum(['vclaw', 'usdc']).default('vclaw'),
    /**
     * Human/agent-readable acceptance criteria the verdict is judged against.
     * MANDATORY for a USDC bounty (enforced by the superRefine below — a verdict
     * with nothing to verify against is scaffolding theater). Optional for vCLAW.
     */
    acceptanceCriteria: z.string().min(10).max(5000).optional(),
  })
  .superRefine((data, ctx) => {
    // RAIL-SPECIFIC reward floor (the field-level check only enforces ≥ 1). Both
    // rails default to 5 vCLAW ($0.05); staging may lower the USDC rail via env.
    if (data.paymentRail === 'vclaw' && data.tokenReward < 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tokenReward'],
        message: 'A vCLAW bounty reward must be at least 5 vCLAW ($0.05).',
      });
    }
    if (data.paymentRail === 'usdc') {
      const usdcMin = resolveUsdcBountyRewardMin(process.env.USDC_BOUNTY_REWARD_MIN);
      if (data.tokenReward < usdcMin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tokenReward'],
          message:
            `A USDC-funded bounty reward must be at least ${usdcMin} vCLAW ` +
            '(1 vCLAW = $0.01).',
        });
      }
    }
    // A USDC bounty MUST carry acceptance criteria (nothing to verify against ⇒
    // no meaningful verdict). Reject at the schema boundary, not deep in the
    // handler, so the error is a clean 400 with a precise path.
    if (data.paymentRail === 'usdc' && !data.acceptanceCriteria) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptanceCriteria'],
        message:
          'acceptanceCriteria is required for a USDC bounty (a verdict needs criteria to judge against).',
      });
    }
    // A USDC bounty custodies its reward in an on-chain escrow VAULT (the composed
    // rail funds it creator→house AT POST; the legacy rail at approve). The deployed
    // `create_escrow_v2` REQUIRES a positive expiry — the vault's refund/reclaim
    // deadline — and refuses `expiresAt <= 0` (`invalid_amount`). A custodial bounty
    // whose funds could lock forever with NO deadline is not a valid product, so
    // require an explicit expiry for the USDC rail (vCLAW bounties, which custody
    // nothing on-chain, stay expiry-OPTIONAL). Reject at the schema boundary so the
    // error is a clean 400 with a precise path, not a confusing vault-open failure
    // deep in the create handler.
    if (data.paymentRail === 'usdc' && !data.expiresAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message:
          'expiresAt is required for a USDC bounty (the on-chain escrow vault needs a refund/reclaim deadline).',
      });
    }
    // A USDC bounty is settled as a SINGLE-call escrow for the whole reward and
    // released to ONE winning hunter, so maxAttempts must be 1 (multiple parallel
    // claimants would each expect the one escrow — undefined who settles). Enforce
    // it here to keep the escrow mapping unambiguous.
    if (data.paymentRail === 'usdc' && data.maxAttempts !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxAttempts'],
        message: 'A USDC bounty must have maxAttempts=1 (single-call escrow, one winning hunter).',
      });
    }
    // Cap the USDC reward at a sane business ceiling (solana SEV-3): reject an
    // oversized reward as a clean 400 HERE, not as a u64-range throw deep in the
    // escrow builder (usdcRewardBaseUnits × 10^4 must stay well inside u64).
    if (data.paymentRail === 'usdc' && data.tokenReward > USDC_BOUNTY_REWARD_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tokenReward'],
        message:
          `A USDC-funded bounty reward may not exceed ${USDC_BOUNTY_REWARD_MAX} vCLAW ` +
          '($10,000).',
      });
    }
  });

const updateBountySchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(10).max(5000).optional(),
  requirements: z.string().max(5000).nullable().optional(),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced', 'expert']).optional(),
  maxAttempts: z.number().int().min(1).max(100).optional(),
  tags: z.array(z.string().max(30)).max(10).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

const submitSchema = z.object({
  prLink: z.string().url().optional(),
  submissionNote: z.string().min(10).max(2000),
});

const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewNote: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------------------
// STATIC ROUTES FIRST (before /:id)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. GET /featured — Get featured bounties
// ---------------------------------------------------------------------------
bountyRoutes.get('/featured', async (c) => {
  const rows = await db
    .select({
      id: bounties.id,
      creatorId: bounties.creatorId,
      title: bounties.title,
      description: bounties.description,
      difficulty: bounties.difficulty,
      status: bounties.status,
      tokenReward: bounties.tokenReward,
      paymentRail: bounties.paymentRail,
      maxAttempts: bounties.maxAttempts,
      currentAttempts: bounties.currentAttempts,
      tags: bounties.tags,
      expiresAt: bounties.expiresAt,
      createdAt: bounties.createdAt,
      creatorAvatarName: avatars.name,
      creatorSpecies: avatars.species,
    })
    .from(bounties)
    .innerJoin(avatars, eq(bounties.creatorId, avatars.id))
    .where(
      and(
        eq(bounties.status, 'open'),
        eq(bounties.isFeatured, true)
      )
    )
    .orderBy(desc(bounties.createdAt))
    .limit(10);

  const bountyList = rows.map((r) => ({
    id: r.id,
    creatorId: r.creatorId,
    creatorAvatarName: r.creatorAvatarName,
    creatorSpecies: r.creatorSpecies,
    title: r.title,
    description: r.description,
    difficulty: r.difficulty,
    status: r.status,
    tokenReward: r.tokenReward,
    paymentRail: r.paymentRail,
    maxAttempts: r.maxAttempts,
    currentAttempts: r.currentAttempts,
    tags: r.tags,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));

  return c.json({ bounties: bountyList });
});

// ---------------------------------------------------------------------------
// 7. GET /my-bounties — Get bounties I created (auth)
// ---------------------------------------------------------------------------
bountyRoutes.get('/my-bounties', requireAuthOrAgentSession, noStorePrivate, async (c) => {
  const avatar = await getActingAvatar(c);

  const rows = await db
    .select()
    .from(bounties)
    .where(eq(bounties.creatorId, avatar.id))
    .orderBy(desc(bounties.createdAt));

  // Fetch attempts for all these bounties (with hunter names)
  const bountyIds = rows.map((r) => r.id);
  const attemptRows = bountyIds.length > 0
    ? await db
        .select({
          attempt: bountyAttempts,
          hunterName: avatars.name,
        })
        .from(bountyAttempts)
        .innerJoin(avatars, eq(bountyAttempts.hunterId, avatars.id))
        .where(sql`${bountyAttempts.bountyId} IN ${bountyIds}`)
        .orderBy(desc(bountyAttempts.createdAt))
    : [];

  // Group attempts by bounty ID
  const attemptsByBounty = new Map<string, typeof attemptRows>();
  for (const row of attemptRows) {
    const arr = attemptsByBounty.get(row.attempt.bountyId) ?? [];
    arr.push(row);
    attemptsByBounty.set(row.attempt.bountyId, arr);
  }

  const bountyList = rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    requirements: r.requirements,
    difficulty: r.difficulty,
    status: r.status,
    tokenReward: r.tokenReward,
    paymentRail: r.paymentRail,
    acceptanceCriteria: r.acceptanceCriteria,
    maxAttempts: r.maxAttempts,
    currentAttempts: r.currentAttempts,
    isFeatured: r.isFeatured,
    tags: r.tags,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    attempts: (attemptsByBounty.get(r.id) ?? []).map((a) => ({
      id: a.attempt.id,
      hunterId: a.attempt.hunterId,
      hunterName: a.hunterName,
      status: a.attempt.status,
      prLink: a.attempt.prLink,
      submissionNote: a.attempt.submissionNote,
      reviewNote: a.attempt.reviewNote,
      claimedAt: a.attempt.claimedAt.toISOString(),
      submittedAt: a.attempt.submittedAt?.toISOString() ?? null,
    })),
  }));

  return c.json({ bounties: bountyList });
});

// ---------------------------------------------------------------------------
// 11. GET /my-attempts — Get my bounty attempts (auth)
// ---------------------------------------------------------------------------
bountyRoutes.get('/my-attempts', requireAuthOrAgentSession, noStorePrivate, async (c) => {
  const avatar = await getActingAvatar(c);

  const rows = await db
    .select({
      attempt: bountyAttempts,
      bountyTitle: bounties.title,
      bountyDescription: bounties.description,
      bountyDifficulty: bounties.difficulty,
      bountyTokenReward: bounties.tokenReward,
      bountyPaymentRail: bounties.paymentRail,
      bountyStatus: bounties.status,
    })
    .from(bountyAttempts)
    .innerJoin(bounties, eq(bountyAttempts.bountyId, bounties.id))
    .where(eq(bountyAttempts.hunterId, avatar.id))
    .orderBy(desc(bountyAttempts.createdAt));

  const attempts = rows.map((r) => ({
    id: r.attempt.id,
    bountyId: r.attempt.bountyId,
    status: r.attempt.status,
    prLink: r.attempt.prLink,
    submissionNote: r.attempt.submissionNote,
    reviewNote: r.attempt.reviewNote,
    claimedAt: r.attempt.claimedAt.toISOString(),
    submittedAt: r.attempt.submittedAt?.toISOString() ?? null,
    reviewedAt: r.attempt.reviewedAt?.toISOString() ?? null,
    createdAt: r.attempt.createdAt.toISOString(),
    bounty: {
      title: r.bountyTitle,
      description: r.bountyDescription,
      difficulty: r.bountyDifficulty,
      tokenReward: r.bountyTokenReward,
      paymentRail: r.bountyPaymentRail,
      status: r.bountyStatus,
    },
  }));

  return c.json({ attempts });
});

// ---------------------------------------------------------------------------
// 4. POST /create — Create a bounty (auth + escrow)
// ---------------------------------------------------------------------------
bountyRoutes.post('/create', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {

  const body = await c.req.json();
  const parsed = createBountySchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const data = parsed.data;
  const avatar = await getActingAvatar(c);
  const isUsdc = data.paymentRail === 'usdc';
  // COMPOSED-rail decision, computed ONCE here and reused for BOTH the insert
  // sentinel (below) AND the post-insert vault open, so the row's composition_state
  // marker and the open decision can never disagree — a live-flag flip mid-request
  // could otherwise stamp the marker one way and branch the open the other. A composed
  // bounty is a usdc bounty while the live settlement rail is the two-leg composed rail;
  // vCLAW + legacy-usdc bounties are NOT composed (their marker stays NULL). The `&&`
  // short-circuits, so a vCLAW bounty never calls bountySettlementRail() (unchanged).
  const isComposedRail = isUsdc && bountySettlementRail() === 'sap-payai-composed';

  if (isUsdc) {
    // A USDC bounty escrows on-chain USDC (custodial-wallet sign at settle), so a
    // connected agent MUST have proven ledger capability. The vCLAW rail is fine for
    // any resolved avatar. Fail closed here, mirroring the cove / SAP gate.
    if (agentNotLedgerCapable(c.get('identity'))) {
      throw new HTTPException(403, {
        message:
          'This agent session has not proven ownership of its avatar and cannot post a ' +
          'USDC (on-chain) bounty. Reconnect with a fresh connect-token or the signed-challenge reconnect.',
      });
    }
    // The whole SAP USDC escrow rail must be enabled (even for a dry-run open) or a
    // USDC bounty is scaffolding — reject at create so we never persist a
    // usdc-rail bounty whose escrow can never open. NOTE: the escrow is opened
    // LAZILY at approve time (a worker isn't known at create), so no chain leg
    // runs here — this only asserts the rail is live enough to eventually settle.
    if (!usdcRailGateOpen()) {
      throw new HTTPException(503, {
        message:
          'The USDC bounty rail is disabled (SAP_ENABLED / SAP_ESCROW_ENABLED / ' +
          'SAP_USDC_ESCROW_ENABLED). Post a vCLAW (payment_rail=vclaw) bounty instead.',
      });
    }
  } else {
    // ESCROW (vCLAW rail): Verify creator has enough vCLAW. USDC bounties do not
    // debit vCLAW — their reward is on-chain USDC prepaid into a SAP escrow.
    if (avatar.clawTokens < data.tokenReward) {
      throw new HTTPException(400, {
        message: `Not enough vCLAW. Need ${data.tokenReward}, have ${avatar.clawTokens}.`,
      });
    }
  }

  // Validate bonus reward references
  if (data.bonusRewards) {
    for (const reward of data.bonusRewards) {
      if (reward.rewardType === 'agent_config' && reward.agentConfigId) {
        const [config] = await db
          .select({ id: agentConfigs.id })
          .from(agentConfigs)
          .where(eq(agentConfigs.id, reward.agentConfigId))
          .limit(1);
        if (!config) {
          throw new HTTPException(404, { message: `Agent config not found: ${reward.agentConfigId}` });
        }
      }
    }
  }

  // ESCROW: Debit (vCLAW rail only) + bounty INSERT in a single transaction so if
  // INSERT fails, the vCLAW debit rolls back and the creator doesn't lose tokens.
  // For the USDC rail there is no vCLAW debit — the reward is on-chain USDC that is
  // escrowed LAZILY at approve time (once a winning hunter is known); the row is
  // persisted with `payment_rail='usdc'` + `verdict_required=true` + NULL escrow.
  const bounty = await db.transaction(async (tx) => {
    if (!isUsdc) {
      // Deduct tokenReward from creator (atomic + audited) — vCLAW rail only.
      await debitClawTokens({
        avatarId: avatar.id,
        amount: data.tokenReward,
        reason: 'bounty_escrow',
        source: 'bounty',
        metadata: { bountyTitle: data.title },
        actorKind: toActorKind(c.get('identity').kind),
      }, tx);
    }

    // Create bounty
    const [created] = await tx
      .insert(bounties)
      .values({
        creatorId: avatar.id,
        title: data.title,
        description: data.description,
        requirements: data.requirements ?? null,
        difficulty: data.difficulty,
        tokenReward: data.tokenReward,
        maxAttempts: data.maxAttempts,
        tags: data.tags ?? [],
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        // Phase 1 — payout rail + verdict binding. A vCLAW bounty keeps the schema
        // defaults ('vclaw', verdict_required=false, criteria NULL).
        paymentRail: data.paymentRail,
        acceptanceCriteria: data.acceptanceCriteria ?? null,
        verdictRequired: isUsdc,
        // FAIL-CLOSED sentinel (cross-review): stamp the composed marker as
        // 'vault_pending' IN this insert, so the row is 'vault_pending' the instant it
        // exists — BEFORE the vault opens below. If a hard crash lands between this
        // commit and the 'vault_held' flip, the row survives as 'vault_pending' (NOT
        // null) with a NULL escrow_pda, so every post-create transition sees
        // isComposed=true and fails CLOSED (approve 409s; cancel refunds via the
        // deterministic vault nonce) instead of the OLD null-marker double-charge
        // (isComposed=false → the legacy branch opened a SECOND escrow → creator charged
        // twice). vCLAW + legacy-usdc stay NULL — unchanged (the column has no default, so
        // explicit null is identical to the prior omitted-default insert).
        compositionState: isComposedRail ? 'vault_pending' : null,
      })
      .returning();

    // Create bonus reward records
    if (data.bonusRewards && data.bonusRewards.length > 0) {
      await tx.insert(bountyRewards).values(
        data.bonusRewards.map((reward) => ({
          bountyId: created.id,
          rewardType: reward.rewardType,
          agentConfigId: reward.agentConfigId ?? null,
          bookId: reward.bookId ?? null,
          customDescription: reward.customDescription ?? null,
        }))
      );
    }

    // Covenant record — same tx as the (optional) escrow debit + insert.
    await recordCovenantAction(
      {
        action: 'bounty.create',
        subjectType: 'avatar',
        subjectId: avatar.id,
        actorKind: toActorKind(c.get('identity').kind),
        payload: {
          bountyId: created.id,
          paymentRail: created.paymentRail,
          tokenReward: created.tokenReward,
          maxAttempts: created.maxAttempts,
          ...(created.compositionState ? { compositionState: created.compositionState } : {}),
        },
      },
      tx,
    );

    return created;
  });

  // ── COMPOSED rail (SLICE 2b): open LEG 1 (the SAP V2 vault) AT POST ──────────
  // The composed rail custodies the creator's USDC on-chain at CREATE (worker =
  // the ClawVille house), unlike the legacy usdc path which opens the escrow
  // LAZILY at approve. The rail decision was made ONCE above (`isComposedRail`) and
  // was already stamped into the row as `composition_state='vault_pending'`; a
  // SUCCESSFUL open below flips it to the IMMUTABLE 'vault_held' marker every later
  // transition branches on — a mid-lifecycle flag flip can never re-route an existing
  // bounty. A chain call must never run inside the DB transaction, so the open runs
  // AFTER the insert commits.
  //
  // ON FAILURE the vault did NOT open ⇒ NO custody ⇒ the bounty must NOT go live.
  // We DELETE the just-inserted row (its bounty_rewards children cascade via the
  // FK ON DELETE CASCADE) and throw the gate's mapped error — insert→open→delete-
  // on-fail keeps the DB consistent (no orphan bounty without custody), and the
  // delete runs BEFORE the reputation bump so a failed create leaves zero trace.
  // (A HARD crash — not a gate failure — between the insert commit and the
  // 'vault_held' flip is the exact window the 'vault_pending' sentinel above covers.)
  // DRY-RUN: the open simulates + returns a simulated escrowPda ⇒ the bounty is
  // flipped to `vault_held` with no real custody (the correct dry-run posture).
  if (isComposedRail) {
    const opened = await openComposedBountyEscrow({
      bountyId: bounty.id,
      creatorAvatarId: avatar.id,
      tokenReward: bounty.tokenReward,
      expiresAt: bounty.expiresAt,
    });
    if (opened.ok === false) {
      if (PRE_BROADCAST_NO_CUSTODY.has(opened.code)) {
        // PROVABLY pre-broadcast (see PRE_BROADCAST_NO_CUSTODY): the fund tx never
        // went out, no on-chain vault exists, nothing to orphan. Safe to DELETE the
        // just-inserted row (its bounty_rewards children cascade via FK) and fail
        // the create — insert→open→delete-on-fail keeps the DB consistent.
        // Covenant compensation (Codex covenant round 1 HIGH #3): the append-only
        // bounty.create record survives this delete, so partners would forever
        // observe a creation for a nonexistent bounty. Append the terminal
        // create_failed event ATOMICALLY with the delete (idempotent via dedupe).
        await db.transaction(async (tx) => {
          await tx.delete(bounties).where(eq(bounties.id, bounty.id));
          await recordCovenantAction(
            {
              action: 'bounty.create_failed',
              subjectType: 'avatar',
              subjectId: avatar.id,
              actorKind: 'system',
              payload: {
                bountyId: bounty.id,
                reason: 'vault_open_failed_pre_broadcast',
                code: opened.code,
              },
              dedupeKey: `bounty:${bounty.id}:create_failed`,
            },
            tx,
          );
        });
        throw new HTTPException(escrowFailureStatus(opened.code), {
          message: `USDC bounty vault could not be opened (${opened.code}): ${opened.message}. The bounty was not created.`,
        });
      }
      // POSSIBLE CUSTODY — 'funding_unconfirmed' (the ONE broadcast-unknown code) OR any
      // non-allowlisted / unknown code (fail-closed). The fund tx MAY have landed and the
      // creator's USDC MAY sit in the vault; DELETING the bounty would ORPHAN that
      // possibly-funded vault. So we KEEP the row EXACTLY as inserted —
      // composition_state='vault_pending', escrow_pda NULL — for ops reconciliation. It is
      // deliberately NOT flipped to 'vault_held' (the vault is UNCONFIRMED, not confirmed-
      // held). The F1 vault_pending sentinel already fails every post-create transition
      // closed (approve 409s; cancel/refund reclaims-or-cleans via the deterministic bounty
      // nonce, refund-first-then-flip), so no double-charge or premature go-live is possible.
      // Ops resolves the on-chain state via bountyEscrowNonce(bounty.id).
      throw new HTTPException(escrowFailureStatus(opened.code), {
        message:
          `USDC bounty vault open is UNCONFIRMED (${opened.code}): ${opened.message}. ` +
          `The reward MAY already be in the vault, so the bounty is HELD as vault_pending ` +
          `for reconciliation (it was NOT deleted).`,
      });
    }
    const composedEscrowPda = opened.settlement.escrowPda;
    if (!composedEscrowPda) {
      // opened.ok === true means the vault WAS funded — a missing recorded PDA is a
      // possibly-funded vault too, so (exactly like 'funding_unconfirmed' above) we must
      // NOT delete it. KEEP the row as inserted (composition_state='vault_pending',
      // escrow_pda NULL) — the funded vault's PDA is derivable from the deterministic
      // bounty nonce, so ops reconciles + backfills it. Same money-safety principle:
      // NEVER delete after ok===true.
      throw new HTTPException(500, {
        message:
          'USDC bounty vault opened but no escrow PDA was recorded; the bounty is HELD as ' +
          'vault_pending for reconciliation (it was NOT deleted) — the funded vault PDA is ' +
          'derivable from the deterministic bounty nonce.',
      });
    }
    await db
      .update(bounties)
      .set({
        escrowPda: composedEscrowPda,
        escrowJobId: bounty.id,
        compositionState: 'vault_held',
        updatedAt: new Date(),
      })
      .where(eq(bounties.id, bounty.id));
  }

  // Update reputation: increment totalPosted
  const existingRep = await db.query.bountyReputation.findFirst({
    where: eq(bountyReputation.avatarId, avatar.id),
  });

  if (existingRep) {
    await db
      .update(bountyReputation)
      .set({
        totalPosted: existingRep.totalPosted + 1,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bountyReputation.id, existingRep.id));
  } else {
    await db.insert(bountyReputation).values({
      avatarId: avatar.id,
      totalPosted: 1,
      lastActivityAt: new Date(),
    });
  }

  return c.json({
    success: true,
    bounty: {
      id: bounty.id,
      creatorId: bounty.creatorId,
      title: bounty.title,
      description: bounty.description,
      requirements: bounty.requirements,
      difficulty: bounty.difficulty,
      status: bounty.status,
      tokenReward: bounty.tokenReward,
      maxAttempts: bounty.maxAttempts,
      currentAttempts: bounty.currentAttempts,
      tags: bounty.tags,
      paymentRail: bounty.paymentRail,
      acceptanceCriteria: bounty.acceptanceCriteria,
      verdictRequired: bounty.verdictRequired,
      expiresAt: bounty.expiresAt?.toISOString() ?? null,
      createdAt: bounty.createdAt.toISOString(),
    },
    // CT rail: the debitClawTokens call above already updated the balance —
    // recompute the display value from avatar.clawTokens (stale read) minus the
    // debit. USDC rail: no CT moved, so the balance is unchanged.
    clawTokens: isUsdc ? avatar.clawTokens : avatar.clawTokens - data.tokenReward,
  });
});

// ---------------------------------------------------------------------------
// 13. GET /reputation/:avatarId — Get bounty reputation for an avatar
// ---------------------------------------------------------------------------
bountyRoutes.get('/reputation/:avatarId', async (c) => {
  const avatarId = c.req.param('avatarId');
  validateUuid(avatarId, 'Avatar');

  const rep = await db.query.bountyReputation.findFirst({
    where: eq(bountyReputation.avatarId, avatarId),
  });

  if (!rep) {
    // Return default newcomer reputation
    return c.json({
      reputation: {
        avatarId,
        tier: 'newcomer',
        totalCompleted: 0,
        totalEarned: 0,
        totalPosted: 0,
        successRate: 100,
        lastActivityAt: null,
      },
    });
  }

  return c.json({
    reputation: {
      avatarId: rep.avatarId,
      tier: rep.tier,
      totalCompleted: rep.totalCompleted,
      totalEarned: rep.totalEarned,
      totalPosted: rep.totalPosted,
      successRate: rep.successRate,
      lastActivityAt: rep.lastActivityAt?.toISOString() ?? null,
    },
  });
});

// ---------------------------------------------------------------------------
// 12. POST /attempts/:attemptId/review — Review a submission (bounty creator)
// ---------------------------------------------------------------------------
bountyRoutes.post('/attempts/:attemptId/review', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const attemptId = c.req.param('attemptId');
  validateUuid(attemptId, 'Attempt');

  const body = await c.req.json();
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const { decision, reviewNote } = parsed.data;
  const reviewerAvatar = await getActingAvatar(c);

  // Fetch attempt with bounty details
  const [attemptRow] = await db
    .select({
      attempt: bountyAttempts,
      bounty: bounties,
    })
    .from(bountyAttempts)
    .innerJoin(bounties, eq(bountyAttempts.bountyId, bounties.id))
    .where(eq(bountyAttempts.id, attemptId))
    .limit(1);

  if (!attemptRow) {
    throw new HTTPException(404, { message: 'Attempt not found' });
  }

  const attempt = attemptRow.attempt;
  const bounty = attemptRow.bounty;

  // Only bounty creator can review
  if (bounty.creatorId !== reviewerAvatar.id) {
    throw new HTTPException(403, {
      message: 'Only the bounty creator can review submissions',
    });
  }

  // Only review submissions in 'submitted' status
  if (attempt.status !== 'submitted') {
    throw new HTTPException(400, {
      message: `Cannot review attempt with status '${attempt.status}'`,
    });
  }

  const now = new Date();
  const isUsdc = bounty.paymentRail === 'usdc';
  // The IMMUTABLE composed-rail marker (set to 'vault_held' at create). Every
  // post-create transition keys off THIS, never the live `bountySettlementRail()`
  // flag, so a mid-lifecycle flag flip can't re-route an existing bounty. A
  // composed bounty is a USDC bounty whose LEG-1 vault opened at post.
  const isComposed = bounty.compositionState != null;

  // For a USDC bounty the reviewer (creator=depositor) drives an on-chain
  // custodial sign at settle — require ledger capability, exactly like create.
  if (isUsdc && agentNotLedgerCapable(c.get('identity'))) {
    throw new HTTPException(403, {
      message:
        'This agent session has not proven ownership of its avatar and cannot settle a ' +
        'USDC bounty escrow. Reconnect with a fresh connect-token or the signed-challenge reconnect.',
    });
  }

  // SEV-1-B (Codex) — PRE-FLIGHT the USDC escrow rail BEFORE the review DB txn
  // commits. The approve txn auto-rejects competing attempts + flips the bounty
  // `completed` (a terminal, locked-out state). If we let that commit and THEN
  // find the rail is gated off, the escrow can't open (escrow_pda stays null →
  // admin-fail-refund is unreachable → the hunter is permanently cheated: bounty
  // completed, no USDC released, no reclaim path). Fail the review 503 HERE, so a
  // USDC approve NEVER commits a completed state it can't settle. Only an
  // `approved` decision opens an escrow; a reject never does, so gate only that.
  // (Today the rail is gated off so this is the reachable outcome on staging — the
  // guard makes the failure a clean, non-committing 503 instead of a locked bounty.)
  if (isUsdc && decision === 'approved' && !usdcRailGateOpen()) {
    throw new HTTPException(503, {
      message:
        'The USDC bounty escrow rail is disabled (SAP_ENABLED / SAP_ESCROW_ENABLED / ' +
        'SAP_USDC_ESCROW_ENABLED) — cannot settle this USDC bounty right now. The review ' +
        'was NOT applied; the bounty stays open. Retry once the rail is enabled.',
    });
  }

  // FAIL-CLOSED PRE-FLIGHT (cross-review, impl2 recommendation): refuse an APPROVE of a
  // composed bounty whose vault binding is INDETERMINATE ('vault_pending' — a create
  // crashed after the insert stamped 'vault_pending' but BEFORE the vault opened + recorded
  // 'vault_held'+escrow_pda). Refused HERE, BEFORE the review txn, so the attempt stays
  // 'submitted' and the recovery path is CLEAN: an operator reconciles the row (derive the
  // vault from the deterministic bounty nonce, confirm on-chain, set vault_held or delete
  // the orphan), then the creator simply RE-APPROVES the still-submitted attempt. A post-txn
  // refusal would leave the attempt 'approved' → the re-approve would 409 ('already
  // reviewed') → a reconciled bounty stranded with no clean settle path.
  if (isComposed && decision === 'approved' && bounty.compositionState === 'vault_pending') {
    throw new HTTPException(409, {
      message:
        'This bounty is not settle-ready: its reward-vault binding is indeterminate ' +
        '(composition_state=vault_pending — a create crashed mid-open, so the on-chain ' +
        'vault may or may not have opened and its escrow PDA is unrecorded). No review was ' +
        'applied. An operator must reconcile it (derive the vault from the deterministic ' +
        'bounty nonce, confirm on-chain, then set vault_held or delete the orphan) before ' +
        'this bounty can be approved.',
    });
  }

  if (decision === 'approved') {
    // Entire approval flow in a single transaction to prevent partial
    // state (e.g. tokens credited but bounty not marked completed). NOTE: the
    // USDC on-chain escrow legs (open/approve/settle) run AFTER this txn commits
    // (below) — a chain call must never be held inside a DB transaction, and the
    // SAP settlement ledger has its OWN at-most-once idempotency.
    const { rewards, hunterAvatarId } = await db.transaction(async (tx) => {
      // 1. ATOMIC APPROVAL CLAIM (SEV-1 CT double-pay fix). The pre-txn
      // `attempt.status !== 'submitted'` check above is a STALE READ under no lock:
      // two concurrent approves for the same attemptId both pass it, both enter
      // this txn, and — without a status guard on the UPDATE — both would credit
      // the hunter `tokenReward` (creditClawTokens row-locks the avatar so they
      // serialize, but BOTH land), minting CT from nothing (the creator was
      // debited ONCE at create). We make the flip CONDITIONAL on the row still
      // being 'submitted' and claim it via `.returning()`: exactly ONE concurrent
      // approve claims the row (and proceeds to credit); the loser claims 0 rows
      // and 409s BEFORE any credit. This mirrors the /claim route's atomic
      // increment pattern.
      const [claimed] = await tx
        .update(bountyAttempts)
        .set({
          status: 'approved',
          reviewNote: reviewNote ?? null,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyAttempts.id, attemptId),
            eq(bountyAttempts.status, 'submitted'),
          ),
        )
        .returning({ id: bountyAttempts.id });
      if (!claimed) {
        throw new HTTPException(409, {
          message: 'Attempt already reviewed (concurrent approve lost the race).',
        });
      }

      // Covenant record — the APPROVE verdict, same tx as the atomic claim.
      // Money-leg records follow separately: vCLAW rides the ledger hook in
      // this same tx; USDC rails emit bounty.settle at their release points.
      await recordCovenantAction(
        {
          action: 'bounty.approve',
          subjectType: 'avatar',
          subjectId: attempt.hunterId,
          actorKind: toActorKind(c.get('identity').kind),
          payload: {
            bountyId: bounty.id,
            attemptId: attempt.id,
            paymentRail: bounty.paymentRail,
            tokenReward: bounty.tokenReward,
            reviewerAvatarId: reviewerAvatar.id,
            ...(reviewNote ? { reviewNote } : {}),
          },
        },
        tx,
      );

      // 2. Transfer escrowed tokenReward to hunter's clawTokens (CT rail ONLY).
      const hunterAvatar = await tx.query.avatars.findFirst({
        where: eq(avatars.id, attempt.hunterId),
      });

      if (!hunterAvatar) {
        throw new HTTPException(500, { message: 'Hunter avatar not found' });
      }

      // Release escrowed tokenReward to hunter (atomic + audited). USDC bounties
      // release on-chain USDC via the SAP escrow settle AFTER this txn (not CT).
      if (!isUsdc) {
        await creditClawTokens({
          avatarId: hunterAvatar.id,
          amount: bounty.tokenReward,
          reason: 'bounty_reward',
          source: 'bounty',
          metadata: { bountyId: bounty.id, attemptId: attempt.id },
          actorKind: toActorKind(c.get('identity').kind),
        }, tx);
      }

      // 3. Transfer bonus rewards to hunter
      const txRewards = await tx
        .select()
        .from(bountyRewards)
        .where(eq(bountyRewards.bountyId, bounty.id));

      for (const reward of txRewards) {
        if (reward.rewardType === 'knowledge_book' && reward.bookId) {
          const itemId = `book-${reward.bookId}`;
          const existingItem = await tx.query.avatarInventory.findFirst({
            where: and(
              eq(avatarInventory.avatarId, hunterAvatar.id),
              eq(avatarInventory.itemId, itemId)
            ),
          });

          if (existingItem) {
            await tx
              .update(avatarInventory)
              .set({ quantity: existingItem.quantity + 1 })
              .where(eq(avatarInventory.id, existingItem.id));
          } else {
            await tx.insert(avatarInventory).values({
              avatarId: hunterAvatar.id,
              itemId,
              quantity: 1,
            });
          }
        }

        // agent_config and custom rewards are noted but don't auto-transfer inventory
      }

      // 4. Mark bounty as 'completed' (guarded on status='open' for symmetry with
      // the atomic approval claim — a bounty can only be completed from open, so a
      // race that somehow re-entered can't re-complete an already-terminal bounty).
      //
      // COMPOSED rail: do NOT mark completed here. A composed bounty is "done" only
      // when the hunter has actually been PAID (the two-leg settle reaches `paid`,
      // post-commit below). Marking it completed at approve — while the payout is
      // still finalizing on-chain (awaiting_finalize) — would show a paid-out state
      // for an unpaid hunter. The `paid` phase flips status='completed'; the other
      // phases (awaiting_finalize / reconcile / failed) leave it open + settling.
      if (!isComposed) {
        await tx
          .update(bounties)
          .set({
            status: 'completed',
            completedAt: now,
            updatedAt: now,
          })
          .where(and(eq(bounties.id, bounty.id), eq(bounties.status, 'open')));
      }

      // 4b. Reject all other pending attempts for this bounty (prevent orphans)
      await tx
        .update(bountyAttempts)
        .set({
          status: 'rejected',
          reviewNote: 'Auto-rejected: bounty completed by another hunter',
          reviewedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyAttempts.bountyId, bounty.id),
            ne(bountyAttempts.id, attemptId),
            sql`${bountyAttempts.status} IN ('claimed', 'in_progress', 'submitted')`
          )
        );

      // 5. Update bounty reputation for hunter.
      //
      // CT rail: bump totalCompleted + totalEarned (CT-denominated) IN-TX, since
      // the CT reward is credited in this same transaction — completion and
      // earnings are simultaneous and can't diverge.
      //
      // USDC rail (adversary S3+S4 / regress SEV-3): (a) do NOT add the USDC
      // reward into `totalEarned` — that column is a CT counter; conflating USDC
      // into it corrupts the leaderboard/earnings metric. (b) DEFER the
      // completion bump until AFTER `runBountyUsdcSettle` SUCCEEDS (below, post-
      // commit) so a failed settle can't leave phantom completion+earnings. Here
      // we only refresh the successRate + lastActivityAt (both true the moment the
      // attempt is approved, independent of the on-chain settle).
      const hunterRep = await tx.query.bountyReputation.findFirst({
        where: eq(bountyReputation.avatarId, hunterAvatar.id),
      });

      const newSuccessRate = await recalculateSuccessRate(hunterAvatar.id, tx);

      if (hunterRep) {
        const newCompleted = isUsdc
          ? hunterRep.totalCompleted
          : hunterRep.totalCompleted + 1;
        const newTier = calculateReputationTier(newCompleted);
        await tx
          .update(bountyReputation)
          .set({
            totalCompleted: newCompleted,
            // USDC: leave totalEarned unchanged (CT counter). CT: add the reward.
            totalEarned: isUsdc
              ? hunterRep.totalEarned
              : hunterRep.totalEarned + bounty.tokenReward,
            tier: newTier as any,
            successRate: newSuccessRate,
            lastActivityAt: now,
            updatedAt: now,
          })
          .where(eq(bountyReputation.id, hunterRep.id));
      } else {
        // First-ever reputation row. CT: 1 completed + reward earned. USDC: 0
        // completed / 0 earned here (the completion is booked post-settle).
        const newTier = calculateReputationTier(isUsdc ? 0 : 1);
        await tx.insert(bountyReputation).values({
          avatarId: hunterAvatar.id,
          totalCompleted: isUsdc ? 0 : 1,
          totalEarned: isUsdc ? 0 : bounty.tokenReward,
          tier: newTier as any,
          successRate: newSuccessRate,
          lastActivityAt: now,
        });
      }

      // 6. Update reputation for creator (track activity)
      const creatorRep = await tx.query.bountyReputation.findFirst({
        where: eq(bountyReputation.avatarId, reviewerAvatar.id),
      });

      if (creatorRep) {
        await tx
          .update(bountyReputation)
          .set({
            lastActivityAt: now,
            updatedAt: now,
          })
          .where(eq(bountyReputation.id, creatorRep.id));
      }

      return { rewards: txRewards, hunterAvatarId: hunterAvatar.id };
    });

    // ── COMPOSED rail (SLICE 2b): PASS verdict → two-leg settle (SAP V2 vault →
    // PayAI x402). Branches on the IMMUTABLE `composition_state` marker, NOT the
    // live `bountySettlementRail()` flag. Runs AFTER the DB txn commits (no chain
    // call in a transaction). `settleComposedBounty` is fully idempotent on the
    // (escrow, job) ledger + the deterministic vault nonce, so a replay is safe; a
    // dry-run leg simulates only. Each of the 4 phases persists its exact
    // `composition_state` and RESPONDS — none falls through to the legacy dispatch.
    if (isComposed) {
      // NOTE (cross-review): 'vault_pending' (an indeterminate vault binding from a create
      // that crashed mid-open) is refused PRE-FLIGHT above — BEFORE the review txn, so the
      // attempt stays 'submitted' and the reconcile→re-approve recovery path is clean. So a
      // composed bounty reaching HERE is settle-ready ('vault_held', or a replay of a later
      // state). This is the fail-closed custody classification that structurally REPLACES the
      // old null-marker double-charge (vault_pending ⇒ isComposed=true ⇒ legacy branch skipped).
      if (!bounty.escrowPda) {
        // Invariant: a settle-ready composed bounty (state !== 'vault_pending') always
        // carries its LEG-1 vault PDA (persisted WITH composition_state='vault_held' at
        // create). A null here is a corrupted row — fail closed rather than settle against
        // an unknown vault.
        throw new HTTPException(500, {
          message: 'Composed bounty is missing its escrow PDA; cannot settle. Contact an operator.',
        });
      }
      const result = await settleComposedBounty({
        bountyId: bounty.id,
        escrowPda: bounty.escrowPda,
        creatorAvatarId: bounty.creatorId,
        hunterAvatarId,
        tokenReward: bounty.tokenReward,
      });

      if (result.phase === 'paid') {
        // Both legs done: LEG 1 finalized the principal to the house AND LEG 2's x402
        // paid the hunter exactly the reward. The →paid booking is the ONE shared write
        // path (see the import note): `bookComposedBountyPaid` owns composition_state=
        // 'paid' + the completed flip + the payout/covenant fields + the once-only
        // completion bump (totalCompleted += 1; totalEarned UNCHANGED for a USDC reward —
        // it is the CT counter), under a CAS on the expected prior. This INSTANT path is
        // still 'vault_held' here (settleComposedBounty never touches the bounty row), so
        // we pass that prior; the deferred crank passes 'awaiting_finalize'. The bounty IS
        // paid either way (idempotent), so we return HTTP 200 REGARDLESS of whether THIS
        // call won the CAS (`booked`) — the crank books it otherwise; the once-only bump
        // is handled inside the helper.
        await bookComposedBountyPaid({
          bountyId: bounty.id,
          expectedPriorState: 'vault_held',
          hunterAvatarId,
          payoutEscrowPda: result.payoutEscrowPda,
          auditRootHex: result.auditRootHex,
        });

        return c.json({
          success: true,
          decision: 'approved',
          paymentRail: bounty.paymentRail,
          tokensAwarded: 0,
          rewardVclaw: bounty.tokenReward,
          rewardUsdcBaseUnits: usdcRewardBaseUnits(bounty.tokenReward).toString(),
          bonusRewardsCount: rewards.length,
          settlement: {
            rail: 'sap-payai-composed',
            state: 'paid',
            escrowPda: result.escrowPda,
            payoutEscrowPda: result.payoutEscrowPda,
            dryRun: result.dryRun,
          },
        });
      }

      if (result.phase === 'awaiting_finalize') {
        // LEG 1b settled (principal reserved on-chain); LEG 1c finalize is pending
        // the dispute window (or an ops reconcile). The verdict PASSED but the
        // hunter is UNPAID and LEG 2 has NOT run — no double-pay is constructible.
        // Do NOT mark completed. Re-running settleComposedBounty (idempotent) once
        // the window elapses drives it to `paid`.
        await db
          .update(bounties)
          .set({
            compositionState: 'awaiting_finalize',
            covenantVerificationPassed: true,
            updatedAt: new Date(),
          })
          // LOW-1 defense-in-depth: guard the non-paid persist symmetrically with the
          // crank's `ne(compositionState,'paid')` so a future edit / a concurrent →paid
          // flip can never be downgraded FROM paid back to awaiting_finalize.
          .where(and(eq(bounties.id, bounty.id), ne(bounties.compositionState, 'paid')));

        return c.json({
          success: true,
          decision: 'approved',
          paymentRail: bounty.paymentRail,
          rewardVclaw: bounty.tokenReward,
          rewardUsdcBaseUnits: usdcRewardBaseUnits(bounty.tokenReward).toString(),
          bonusRewardsCount: rewards.length,
          settlement: {
            rail: 'sap-payai-composed',
            state: 'awaiting_finalize',
            escrowPda: result.escrowPda,
            payoutPending: true,
            code: result.code,
          },
          message:
            'Approved — payout settling. The vault release is finalizing on-chain; ' +
            'the hunter is paid once it completes. Re-running settlement is safe (idempotent) — no double-pay.',
        });
      }

      if (result.phase === 'reconcile_payout_failed') {
        // LEG 1 FINALIZED (the house holds the reward) but LEG 2 (the hunter payout)
        // failed. Funds are SAFE in the house wallet; LEG 2 replays idempotently.
        // Persist the reconcile marker + page ops; a re-run of settleComposedBounty
        // replays legs 1a-1c (no-ops) then retries LEG 2.
        await db
          .update(bounties)
          .set({
            compositionState: 'reconcile_payout_failed',
            payoutEscrowPda: result.payoutEscrowPda ?? null,
            covenantVerificationPassed: true,
            updatedAt: new Date(),
          })
          // LOW-1 defense-in-depth: symmetric non-paid guard (see awaiting_finalize) so a
          // row the crank already flipped to paid can never be downgraded to reconcile.
          .where(and(eq(bounties.id, bounty.id), ne(bounties.compositionState, 'paid')));

        await alertError({
          severity: 'critical',
          source: 'bounty-composed-payout',
          message:
            `Composed bounty ${bounty.id}: LEG 1 finalized (principal at the house) but LEG 2 ` +
            `payout to the hunter FAILED (${result.code}): ${result.message}. Funds are safe at the ` +
            `house; the payout replays idempotently — re-run settleComposedBounty to reconcile.`,
          context: {
            bountyId: bounty.id,
            hunterAvatarId,
            escrowPda: result.escrowPda,
            payoutEscrowPda: result.payoutEscrowPda,
            code: result.code,
          },
        });

        // 202 Accepted — the approve + LEG-1 settle were accepted; the payout is
        // being reconciled asynchronously (ops paged). NOT a clean failure (the
        // money moved to the house) and NOT complete (the hunter is unpaid).
        return c.json(
          {
            success: true,
            decision: 'approved',
            paymentRail: bounty.paymentRail,
            settlement: {
              rail: 'sap-payai-composed',
              state: 'reconcile_payout_failed',
              escrowPda: result.escrowPda,
              payoutEscrowPda: result.payoutEscrowPda,
              payoutPending: true,
              reconcile: true,
              code: result.code,
            },
            message:
              'Approved — LEG 1 finalized but the hunter payout is being reconciled by ops. ' +
              'Funds are safe and the payout will complete; no action needed from you.',
          },
          202,
        );
      }

      // result.phase === 'failed' — the settle failed BEFORE any money moved; the
      // creator's USDC is still fully in the vault (composition_state stays
      // 'vault_held'). Mirror the legacy path: surface the gate error WITHOUT
      // un-approving the attempt, and — because the approve txn did NOT mark a
      // composed bounty completed — the bounty is provably NOT completed. This now
      // AUTO-RECOVERS: the composed resume worker sweeps `vault_held` bounties that
      // carry an APPROVED attempt (L-1) and re-drives settleComposedBounty (idempotent),
      // and the L-2 gate fix means a pre-broadcast settle failure restores the V2 row to
      // a retryable status instead of terminal 'failed' — so a transient approve-time
      // failure SELF-HEALS on the next sweep. Ops / admin-fail-refund stay a manual
      // fallback. No persistence change here (the vault still holds the funds).
      throw new HTTPException(escrowFailureStatus(result.code), {
        message:
          `Bounty approved, but the composed USDC settle failed (${result.code}): ${result.message}. ` +
          `No funds moved — the vault still holds the creator's USDC; retryable.`,
      });
    }

    // ── USDC rail: PASS verdict → open + approve + settle the SAP escrow ────────
    // Runs AFTER the DB txn commits (no chain call inside a transaction). The
    // reward is released as on-chain USDC to the hunter's custodial wallet. Each
    // leg is idempotent via the SAP (escrow, job) ledger; jobId = bounty.id.
    // A dry-run leg simulates only (default) and never broadcasts.
    //
    // SEV-3-A (Codex, operator-visible, NOT a bug): a USDC bounty CREATED while
    // the rail was gated ON, then APPROVED after the rail was gated OFF, returns
    // 503 (`gate_disabled`) here with the bounty already `completed` in the DB —
    // no escrow opens, no money moves. The escrow leg is re-drivable the moment
    // the rail is re-enabled (idempotent on (escrow, job)); the admin re-settle
    // route (Phase 2) is the operator handle for that. This is an intended
    // fail-closed state, surfaced to the operator, not a fund-loss path.
    //
    // `&& !isComposed` is defense-in-depth: the composed branch above ALWAYS
    // returns/throws (exhaustive over its 4 phases), so this is only ever reached
    // by a legacy (single-leg) USDC bounty — but the guard makes a hypothetical
    // fall-through a harmless wrong-response instead of a double-settle.
    let escrowResult:
      | { ok: true; escrowPda: string | null; auditRootHex: string | null; dryRun: boolean }
      | null = null;
    if (isUsdc && !isComposed) {
      // Covenant INTENT record BEFORE the external release (Codex covenant
      // round 2 HIGH #2): the legacy rail has no recovery crank, so a crash
      // between chain success and the settle record's tx would otherwise
      // leave an irreversible payout with NO stream trace. The intent commits
      // first — a settle_requested without a matching bounty.settle is the
      // durable, queryable anomaly signature for reconciliation (the SAP
      // (escrow, job) ledger holds the on-chain truth to reconcile against).
      await recordCovenantAction({
        action: 'bounty.settle_requested',
        subjectType: 'avatar',
        subjectId: hunterAvatarId,
        actorKind: toActorKind(c.get('identity').kind),
        dedupeKey: `bounty:${bounty.id}:settle_requested`,
        payload: {
          bountyId: bounty.id,
          rail: 'sap-usdc',
          rewardUsdcBaseUnits: usdcRewardBaseUnits(bounty.tokenReward).toString(),
        },
      });
      const settle = await runBountyUsdcSettle({
        bountyId: bounty.id,
        creatorAvatarId: bounty.creatorId,
        hunterAvatarId,
        tokenReward: bounty.tokenReward,
        expiresAt: bounty.expiresAt,
      });
      if (settle.ok === false) {
        // The DB approval already committed, but the on-chain release failed. We
        // record the FAILING verdict provenance and surface the escrow error code
        // — the operator/reconciler resolves the escrow (the SAP ledger holds the
        // exact state; it never double-releases). We do NOT roll back the bounty
        // completion: the review decision stands, the money leg is retryable via
        // the SAP settle idempotency (same (escrow, job) key).
        await db
          .update(bounties)
          .set({
            covenantVerificationPassed: false,
            escrowPda: settle.escrowPda ?? null,
            escrowJobId: settle.escrowPda ? bounty.id : null,
            updatedAt: new Date(),
          })
          .where(eq(bounties.id, bounty.id));
        throw new HTTPException(escrowFailureStatus(settle.code), {
          message: `Bounty approved, but USDC escrow settle failed (${settle.code}): ${settle.message}`,
        });
      }
      // PASS — persist the verdict provenance onto the bounty (+ the covenant
      // settle record in the same tx: this USDC release never touches the vCLAW
      // ledger, so this is its ONLY stream record).
      await db.transaction(async (tx) => {
        await tx
          .update(bounties)
          .set({
            escrowPda: settle.escrowPda,
            escrowJobId: settle.escrowPda ? bounty.id : null,
            covenantAuditRootHex: settle.auditRootHex,
            covenantVerificationPassed: true,
            updatedAt: new Date(),
          })
          .where(eq(bounties.id, bounty.id));
        await recordCovenantAction(
          {
            action: 'bounty.settle',
            subjectType: 'avatar',
            subjectId: hunterAvatarId,
            actorKind: toActorKind(c.get('identity').kind),
            dedupeKey: `bounty:${bounty.id}:settle`,
            payload: {
              bountyId: bounty.id,
              rail: 'sap-usdc',
              rewardUsdcBaseUnits: usdcRewardBaseUnits(bounty.tokenReward).toString(),
              ...(settle.escrowPda ? { escrowPda: settle.escrowPda } : {}),
              ...(settle.auditRootHex ? { auditRootHex: settle.auditRootHex } : {}),
              dryRun: settle.dryRun,
            },
          },
          tx,
        );
      });

      // DEFERRED completion bump (adversary S4): now that the settle SUCCEEDED,
      // book the hunter's completion count (NOT totalEarned — that's the CT
      // counter; USDC earnings are not tracked there). A failed settle above
      // returned before reaching here, so a phantom completion can never be
      // recorded for an unreleased USDC bounty. totalEarned is intentionally left
      // unchanged. (A crash between the DB approval commit and here would omit the
      // completion bump — a strictly-conservative undercount, never a phantom.)
      const usdcHunterRep = await db.query.bountyReputation.findFirst({
        where: eq(bountyReputation.avatarId, hunterAvatarId),
      });
      if (usdcHunterRep) {
        const bumped = usdcHunterRep.totalCompleted + 1;
        await db
          .update(bountyReputation)
          .set({
            totalCompleted: bumped,
            tier: calculateReputationTier(bumped) as any,
            lastActivityAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(bountyReputation.id, usdcHunterRep.id));
      } else {
        await db.insert(bountyReputation).values({
          avatarId: hunterAvatarId,
          totalCompleted: 1,
          totalEarned: 0,
          tier: calculateReputationTier(1) as any,
          lastActivityAt: new Date(),
        });
      }

      escrowResult = {
        ok: true,
        escrowPda: settle.escrowPda,
        auditRootHex: settle.auditRootHex,
        dryRun: settle.dryRun,
      };
    }

    return c.json({
      success: true,
      decision: 'approved',
      paymentRail: bounty.paymentRail,
      tokensAwarded: isUsdc ? 0 : bounty.tokenReward,
      rewardVclaw: bounty.tokenReward,
      rewardUsdcBaseUnits: isUsdc
        ? usdcRewardBaseUnits(bounty.tokenReward).toString()
        : '0',
      bonusRewardsCount: rewards.length,
      escrow: escrowResult,
    });
  } else {
    // Rejected — wrap in transaction so attempt rejection + slot release
    // + reputation update are atomic (prevents orphaned slot on crash).
    await db.transaction(async (tx) => {
      // ATOMIC REJECTION CLAIM (same SEV-1 TOCTOU class as approve). The pre-txn
      // status check is a stale read under no lock: two concurrent rejects — or a
      // reject racing an approve — could both pass it, and without a status guard
      // both would flip the row + BOTH decrement `currentAttempts` (a double
      // slot-release that frees more attempt slots than exist, letting extra
      // claims past maxAttempts). Claim the row conditionally on it still being
      // 'submitted': exactly ONE reviewer transition (approve OR reject) lands; a
      // loser claims 0 rows and 409s before touching the slot counter.
      const [claimed] = await tx
        .update(bountyAttempts)
        .set({
          status: 'rejected',
          reviewNote: reviewNote ?? null,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyAttempts.id, attemptId),
            eq(bountyAttempts.status, 'submitted'),
          ),
        )
        .returning({ id: bountyAttempts.id });
      if (!claimed) {
        throw new HTTPException(409, {
          message: 'Attempt already reviewed (concurrent review lost the race).',
        });
      }

      // Covenant record — the REJECT verdict, same tx as the atomic claim.
      await recordCovenantAction(
        {
          action: 'bounty.reject',
          subjectType: 'avatar',
          subjectId: attempt.hunterId,
          actorKind: toActorKind(c.get('identity').kind),
          payload: {
            bountyId: bounty.id,
            attemptId: attempt.id,
            reviewerAvatarId: reviewerAvatar.id,
            ...(reviewNote ? { reviewNote } : {}),
          },
        },
        tx,
      );

      // Decrement currentAttempts to allow new attempts + record a FAIL verdict on
      // a USDC bounty. No escrow refund is needed here: a USDC bounty's escrow is
      // opened LAZILY at APPROVE time (once a winning hunter is bound), so a
      // rejected submission never had an on-chain escrow to reclaim — the creator's
      // USDC was never escrowed. The verdict flag records the FAIL provenance; the
      // reward stays fully in the creator's wallet. (The admin fail-refund route
      // handles the distinct case where an escrow WAS opened and must be reclaimed.)
      await tx
        .update(bounties)
        .set({
          currentAttempts: sql`GREATEST(${bounties.currentAttempts} - 1, 0)`,
          ...(isUsdc ? { covenantVerificationPassed: false } : {}),
          updatedAt: now,
        })
        .where(eq(bounties.id, bounty.id));

      // Update hunter's successRate after rejection
      const hunterRep = await tx.query.bountyReputation.findFirst({
        where: eq(bountyReputation.avatarId, attempt.hunterId),
      });
      const updatedSuccessRate = await recalculateSuccessRate(attempt.hunterId, tx);
      if (hunterRep) {
        await tx
          .update(bountyReputation)
          .set({
            successRate: updatedSuccessRate,
            lastActivityAt: now,
            updatedAt: now,
          })
          .where(eq(bountyReputation.id, hunterRep.id));
      }
    });

    return c.json({
      success: true,
      decision: 'rejected',
      reviewNote: reviewNote ?? null,
    });
  }
});

// ---------------------------------------------------------------------------
// 12b. POST /:id/admin-fail-refund — ADMIN-ONLY: force-refund a USDC bounty
//      escrow back to the creator on a FAIL (the "admin holds fail/refund" path).
// ---------------------------------------------------------------------------
//
// Net-new (Phase 1). Today the SAP escrow refund is DEPOSITOR-only — the escrow
// gate binds the on-chain withdraw signer to the depositor's (creator's) wallet.
// A creator-review reject BEFORE approve never opened an escrow (nothing to
// reclaim). The genuinely-missing case is: an escrow WAS opened for a USDC bounty
// (jobId=bounty.id) and an operator must force a FAIL-refund to the creator
// (e.g. a disputed/abandoned settle, a stuck approval). This admin route drives
// `refundBountyEscrow` AS the recorded depositor (the escrow gate re-asserts
// depositor identity + its own atomic refund claim + funds ceiling), so the admin
// cannot mis-route funds — it can only trigger the depositor-bound withdraw.
//
// PARITY note: this is an OPERATOR safety route (admin allowlist), not a
// player-facing economy action, so it is admin-gated rather than agent-parity —
// the money still binds to the creator's (depositor's) own wallet.
const adminFailRefundSchema = z
  .object({
    /** Optional operator note (audit trail). */
    reason: z.string().max(500).optional(),
  })
  .strict();

bountyRoutes.post('/:id/admin-fail-refund', adminOnly, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Bounty');

  // Body is optional; validate if present.
  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = adminFailRefundSchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid request body' });
  }

  const [bounty] = await db
    .select()
    .from(bounties)
    .where(eq(bounties.id, id))
    .limit(1);
  if (!bounty) {
    throw new HTTPException(404, { message: 'Bounty not found' });
  }

  if (bounty.paymentRail !== 'usdc') {
    throw new HTTPException(400, {
      message: 'admin-fail-refund only applies to a USDC (payment_rail=usdc) bounty.',
    });
  }

  // The IMMUTABLE composed-rail marker — a composed bounty refunds its LEG-1 SAP
  // V2 vault, a legacy usdc bounty refunds its V1 escrow. Branch off THIS, never
  // the live rail flag. Evaluated BEFORE the escrow-PDA guard so a composed bounty's
  // composition_state is the PRIMARY gate: a 'vault_pending' row carries a NULL
  // escrow_pda (a create crashed mid-open) and must get the indeterminate-binding
  // diagnosis below — NOT the generic "never approved, no escrow" 409, whose meaning
  // is the legacy path's and is wrong for a composed vault that may hold funds.
  const isComposed = bounty.compositionState != null;

  // SEV-2-B guard + F2 (cross-review): a composed fail-refund is a FULL-DEPOSIT LEG-1
  // vault withdraw, only SOUND from 'vault_held' (the vault still holds the whole
  // deposit and nothing downstream has moved). Refuse every other composed state
  // rather than issue an opaque on-chain failure:
  //   • 'paid'                    → LEG 2 already paid the hunter; a refund double-spends.
  //   • 'awaiting_finalize'       → principal reserved on-chain (LEG 1b), finalize pending.
  //   • 'reconcile_payout_failed' → LEG 1 finalized to the house, LEG 2 retrying.
  //       For BOTH mid-settlement states the full-deposit withdraw fails opaquely (the
  //       funds are NOT free in the vault); re-run the finalize/payout crank
  //       (settleComposedBounty, idempotent) to drive them to 'paid' — not a force-refund.
  //   • 'vault_pending'           → a create crashed mid-open: the vault MAY or MAY NOT
  //       hold funds and escrow_pda is unrecorded — the binding is indeterminate; ops must
  //       reconcile (derive the vault from the deterministic bounty nonce, confirm
  //       on-chain, set vault_held or delete) before ANY withdraw.
  if (isComposed) {
    if (bounty.compositionState === 'paid') {
      throw new HTTPException(409, {
        message:
          'This composed USDC bounty already paid the hunter (composition_state=paid) — ' +
          'its reward was released and cannot be fail-refunded.',
      });
    }
    if (bounty.compositionState !== 'vault_held') {
      // awaiting_finalize | reconcile_payout_failed | vault_pending
      throw new HTTPException(409, {
        message:
          `This composed USDC bounty is mid-settlement or its vault binding is indeterminate ` +
          `(composition_state=${bounty.compositionState}) — do NOT force-refund. ` +
          `awaiting_finalize / reconcile_payout_failed re-drive to paid via the finalize/payout ` +
          `crank (re-run settlement — idempotent); vault_pending must first be reconciled ` +
          `(derive the vault from the deterministic bounty nonce, confirm on-chain, then set ` +
          `vault_held or delete). A full-deposit refund of a mid-settlement or indeterminate ` +
          `vault would fail on-chain or risk the funds.`,
      });
    }
    // vault_held falls through — it carries a real escrow_pda recorded at create, so the
    // escrow-PDA guard below passes and refundComposedBounty reclaims the LEG-1 vault.
  }

  if (!bounty.escrowPda) {
    throw new HTTPException(409, {
      message:
        'This USDC bounty has no open escrow to refund (the escrow is opened at ' +
        'approve time; a bounty never approved has nothing on-chain to reclaim).',
    });
  }

  // SEV-2-B guard (Codex) — LEGACY usdc path only now (composed states are fully gated
  // above): NEVER refund an already-SETTLED legacy escrow — a PASS verdict
  // (`covenant_verification_passed === true`) means it was released to the worker.
  if (!isComposed && bounty.covenantVerificationPassed === true) {
    throw new HTTPException(409, {
      message:
        'This USDC bounty already settled (PASS verdict) — its escrow was released ' +
        'to the worker and cannot be fail-refunded.',
    });
  }

  // INTENT-BEFORE-EXTERNAL (Codex covenant round 5 HIGH #4): terminalize the
  // bounty + write the durable refund intent BEFORE the irreversible chain
  // call. A crash after the chain succeeds can then never leave an open,
  // claimable bounty against an emptied vault with zero stream trace — the
  // worst post-crash state is cancelled + intent-without-refund-record, a
  // queryable anomaly the idempotent retry of THIS route completes (the SAP
  // refund replays on its own ledger key; the records dedupe).
  await db.transaction(async (tx) => {
    const refundedAt = new Date();
    await tx
      .update(bounties)
      .set({
        status: 'cancelled',
        covenantVerificationPassed: false,
        updatedAt: refundedAt,
      })
      .where(eq(bounties.id, bounty.id));
    await tx
      .update(bountyAttempts)
      .set({
        status: 'rejected',
        reviewNote: 'Auto-rejected: bounty escrow fail-refunded to the creator by an admin',
        reviewedAt: refundedAt,
        updatedAt: refundedAt,
      })
      .where(
        and(
          eq(bountyAttempts.bountyId, bounty.id),
          sql`${bountyAttempts.status} IN ('claimed', 'in_progress', 'submitted', 'approved')`,
        ),
      );
    await recordCovenantAction(
      {
        action: 'bounty.refund_requested',
        subjectType: 'avatar',
        subjectId: bounty.creatorId,
        actorKind: 'admin',
        dedupeKey: `bounty:${bounty.id}:refund_requested:admin`,
        payload: {
          bountyId: bounty.id,
          rail: isComposed ? 'sap-payai-composed' : 'sap-usdc',
          tokenReward: bounty.tokenReward,
          ...(bounty.escrowPda ? { escrowPda: bounty.escrowPda } : {}),
        },
      },
      tx,
    );
  });

  // Drive the depositor-bound refund. COMPOSED → the SAP V2 vault withdraw
  // (creator ← the LEG-1 vault, idempotent on `${bountyId}:refund`); LEGACY → the
  // V1 escrow-gate refund. Both re-assert the depositor + ceiling the amount, so
  // the admin can only trigger the refund, never redirect the funds.
  const refund = isComposed
    ? await refundComposedBounty({
        bountyId: bounty.id,
        escrowPda: bounty.escrowPda,
        creatorAvatarId: bounty.creatorId,
        tokenReward: bounty.tokenReward,
      })
    : await refundBountyEscrow({
        bountyId: bounty.id,
        escrowPda: bounty.escrowPda,
        creatorAvatarId: bounty.creatorId,
        tokenReward: bounty.tokenReward,
      });

  if (refund.ok === false) {
    // The bounty is already terminalized (cancelled + attempts rejected +
    // intent recorded) — funds remain safely in the vault/escrow. Retrying
    // THIS route completes the refund: the SAP leg is idempotent and both
    // records dedupe.
    throw new HTTPException(escrowFailureStatus(refund.code), {
      message:
        `USDC escrow refund failed (${refund.code}): ${refund.message}. The bounty is ` +
        `cancelled (non-claimable) and the refund intent is recorded — retry this route ` +
        `to complete the refund (idempotent).`,
    });
  }

  // OUTCOME record — the refund executed on-chain. Terminalization happened
  // BEFORE the external call (intent-before-external above); composition_state
  // deliberately stays as-is (the schema has no 'refunded' label; terminal-
  // refunded = status cancelled + covenant_verification_passed=false, and the
  // resume crank only drives awaiting_finalize/reconcile states, never a
  // cancelled vault_held row).
  await recordCovenantAction({
    action: 'bounty.refund',
    subjectType: 'avatar',
    subjectId: bounty.creatorId,
    actorKind: 'admin',
    dedupeKey: `bounty:${bounty.id}:refund`,
    payload: {
      bountyId: bounty.id,
      rail: isComposed ? 'sap-payai-composed' : 'sap-usdc',
      tokenReward: bounty.tokenReward,
      terminalized: 'cancelled',
      ...(bounty.escrowPda ? { escrowPda: bounty.escrowPda } : {}),
    },
  });

  // The refund result's chain leg is a SapWriteResult union — read dryRun only
  // from the success arm (a failed chain leg would have bubbled up as !refund.ok).
  const refundChain = 'chain' in refund ? refund.chain : null;
  const refundDryRun = refundChain && refundChain.ok ? refundChain.dryRun : undefined;

  return c.json({
    success: true,
    decision: 'fail-refund',
    escrowPda: bounty.escrowPda,
    refunded: bounty.tokenReward,
    dryRun: refundDryRun,
    reason: parsed.data.reason ?? null,
  });
});

// ---------------------------------------------------------------------------
// DYNAMIC ROUTES (/:id patterns)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2. GET /:id — Get bounty details with rewards + attempt count
// ---------------------------------------------------------------------------
bountyRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Bounty');

  const [row] = await db
    .select({
      id: bounties.id,
      creatorId: bounties.creatorId,
      title: bounties.title,
      description: bounties.description,
      requirements: bounties.requirements,
      difficulty: bounties.difficulty,
      status: bounties.status,
      tokenReward: bounties.tokenReward,
      paymentRail: bounties.paymentRail,
      acceptanceCriteria: bounties.acceptanceCriteria,
      maxAttempts: bounties.maxAttempts,
      currentAttempts: bounties.currentAttempts,
      isFeatured: bounties.isFeatured,
      tags: bounties.tags,
      expiresAt: bounties.expiresAt,
      completedAt: bounties.completedAt,
      createdAt: bounties.createdAt,
      updatedAt: bounties.updatedAt,
      creatorAvatarName: avatars.name,
      creatorSpecies: avatars.species,
    })
    .from(bounties)
    .innerJoin(avatars, eq(bounties.creatorId, avatars.id))
    .where(eq(bounties.id, id))
    .limit(1);

  if (!row) {
    throw new HTTPException(404, { message: 'Bounty not found' });
  }

  // Fetch bonus rewards
  const rewards = await db
    .select()
    .from(bountyRewards)
    .where(eq(bountyRewards.bountyId, id));

  // Count attempts by status
  const attemptCounts = await db
    .select({
      status: bountyAttempts.status,
      count: count(),
    })
    .from(bountyAttempts)
    .where(eq(bountyAttempts.bountyId, id))
    .groupBy(bountyAttempts.status);

  const countByStatus: Record<string, number> = {};
  for (const ac of attemptCounts) {
    countByStatus[ac.status] = ac.count;
  }

  // Fetch creator reputation
  const creatorRep = await db.query.bountyReputation.findFirst({
    where: eq(bountyReputation.avatarId, row.creatorId),
  });

  return c.json({
    bounty: {
      id: row.id,
      creatorId: row.creatorId,
      creatorAvatarName: row.creatorAvatarName,
      creatorSpecies: row.creatorSpecies,
      creatorReputation: creatorRep
        ? { tier: creatorRep.tier, totalPosted: creatorRep.totalPosted }
        : { tier: 'newcomer', totalPosted: 0 },
      title: row.title,
      description: row.description,
      requirements: row.requirements,
      difficulty: row.difficulty,
      status: row.status,
      tokenReward: row.tokenReward,
      // paymentRail disambiguates vclaw (in-game, 1 vCLAW=$0.01) from usdc (on-chain);
      // acceptanceCriteria is the USDC-bounty verdict rubric (null for vCLAW).
      paymentRail: row.paymentRail,
      acceptanceCriteria: row.acceptanceCriteria,
      maxAttempts: row.maxAttempts,
      currentAttempts: row.currentAttempts,
      isFeatured: row.isFeatured,
      tags: row.tags,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    rewards: rewards.map((r) => ({
      id: r.id,
      rewardType: r.rewardType,
      agentConfigId: r.agentConfigId,
      bookId: r.bookId,
      customDescription: r.customDescription,
    })),
    attemptCounts: countByStatus,
  });
});

// ---------------------------------------------------------------------------
// 8. POST /:id/claim — Claim a bounty (auth)
// ---------------------------------------------------------------------------
bountyRoutes.post('/:id/claim', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Bounty');

  const avatar = await getActingAvatar(c);

  // Verify bounty exists and is open
  const [bounty] = await db
    .select()
    .from(bounties)
    .where(and(eq(bounties.id, id), eq(bounties.status, 'open')))
    .limit(1);

  if (!bounty) {
    throw new HTTPException(404, {
      message: 'Bounty not found or not open',
    });
  }

  // Prevent self-claiming
  if (bounty.creatorId === avatar.id) {
    throw new HTTPException(400, {
      message: 'Cannot claim your own bounty',
    });
  }

  // Verify hunter doesn't already have an active attempt
  const existingAttempt = await db.query.bountyAttempts.findFirst({
    where: and(
      eq(bountyAttempts.bountyId, id),
      eq(bountyAttempts.hunterId, avatar.id),
      sql`${bountyAttempts.status} IN ('claimed', 'in_progress', 'submitted')`
    ),
  });

  if (existingAttempt) {
    throw new HTTPException(400, {
      message: 'You already have an active attempt for this bounty',
    });
  }

  // Wrap increment + insert in a transaction so a failed INSERT doesn't
  // leave a phantom slot (currentAttempts incremented with no attempt row).
  const attempt = await db.transaction(async (tx) => {
    // Atomic increment: UPDATE ... WHERE currentAttempts < maxAttempts
    // Prevents concurrent claims from exceeding maxAttempts
    const [updated] = await tx
      .update(bounties)
      .set({
        currentAttempts: sql`${bounties.currentAttempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bounties.id, id),
          eq(bounties.status, 'open'),
          sql`${bounties.currentAttempts} < ${bounties.maxAttempts}`
        )
      )
      .returning();

    if (!updated) {
      throw new HTTPException(400, {
        message: 'This bounty has reached its maximum number of active attempts',
      });
    }

    // Create attempt
    const [newAttempt] = await tx
      .insert(bountyAttempts)
      .values({
        bountyId: id,
        hunterId: avatar.id,
        status: 'claimed',
      })
      .returning();

    // Covenant record — same tx as the slot increment + attempt insert.
    await recordCovenantAction(
      {
        action: 'bounty.claim',
        subjectType: 'avatar',
        subjectId: avatar.id,
        actorKind: toActorKind(c.get('identity').kind),
        payload: { bountyId: id, attemptId: newAttempt.id },
      },
      tx,
    );

    return newAttempt;
  });

  return c.json({
    success: true,
    attempt: {
      id: attempt.id,
      bountyId: attempt.bountyId,
      status: attempt.status,
      claimedAt: attempt.claimedAt.toISOString(),
      createdAt: attempt.createdAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// 9. POST /:id/submit — Submit completed work (auth)
// ---------------------------------------------------------------------------
bountyRoutes.post('/:id/submit', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const id = c.req.param('id'); // bounty ID
  validateUuid(id, 'Bounty');

  const body = await c.req.json();
  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const avatar = await getActingAvatar(c);

  // Find the hunter's active attempt (claimed or in_progress) for this bounty
  const attempt = await db.query.bountyAttempts.findFirst({
    where: and(
      eq(bountyAttempts.bountyId, id),
      eq(bountyAttempts.hunterId, avatar.id),
      sql`${bountyAttempts.status} IN ('claimed', 'in_progress')`
    ),
  });

  if (!attempt) {
    throw new HTTPException(404, {
      message:
        'No active attempt found for this bounty. Claim it first.',
    });
  }

  const now = new Date();

  const updated = await db.transaction(async (tx) => {
    // Compare-and-set (Codex covenant round 1 HIGH #1): the pre-tx find is a
    // stale read — a review/abandon landing between find and update would be
    // OVERWRITTEN back to 'submitted' (re-payable) by an id-only predicate.
    // The allowed source statuses live INSIDE the WHERE; a raced-away row
    // matches 0 rows and nothing (row or record) is written.
    const [row] = await tx
      .update(bountyAttempts)
      .set({
        status: 'submitted',
        prLink: parsed.data.prLink ?? null,
        submissionNote: parsed.data.submissionNote,
        submittedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(bountyAttempts.id, attempt.id),
          eq(bountyAttempts.bountyId, id),
          eq(bountyAttempts.hunterId, avatar.id),
          sql`${bountyAttempts.status} IN ('claimed', 'in_progress')`,
        ),
      )
      .returning();
    if (!row) return row; // raced away (reviewed/abandoned between find and CAS) — no record
    // Covenant record — same tx as the submit flip. The note lives on the
    // attempt row; the record binds it by sha256 + length.
    await recordCovenantAction(
      {
        action: 'bounty.submit',
        subjectType: 'avatar',
        subjectId: avatar.id,
        actorKind: toActorKind(c.get('identity').kind),
        payload: {
          bountyId: id,
          attemptId: row.id,
          ...(row.prLink ? { prLink: row.prLink } : {}),
          noteSha256: createHash('sha256')
            .update(parsed.data.submissionNote, 'utf8')
            .digest('hex'),
          noteLength: parsed.data.submissionNote.length,
        },
      },
      tx,
    );
    return row;
  });

  if (!updated) {
    throw new HTTPException(409, {
      message:
        'This attempt is no longer submittable (it was reviewed or abandoned while you were submitting).',
    });
  }

  return c.json({
    success: true,
    attempt: {
      id: updated.id,
      bountyId: updated.bountyId,
      status: updated.status,
      prLink: updated.prLink,
      submissionNote: updated.submissionNote,
      submittedAt: updated.submittedAt?.toISOString() ?? null,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// 10. POST /:id/abandon — Abandon an attempt (auth)
// ---------------------------------------------------------------------------
bountyRoutes.post('/:id/abandon', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const id = c.req.param('id'); // bounty ID
  validateUuid(id, 'Bounty');

  const avatar = await getActingAvatar(c);

  // Find the hunter's active attempt for this bounty
  const attempt = await db.query.bountyAttempts.findFirst({
    where: and(
      eq(bountyAttempts.bountyId, id),
      eq(bountyAttempts.hunterId, avatar.id),
      sql`${bountyAttempts.status} IN ('claimed', 'in_progress')`
    ),
  });

  if (!attempt) {
    throw new HTTPException(404, {
      message: 'No active attempt found for this bounty',
    });
  }

  const now = new Date();

  // Wrap abandon + slot release in a transaction so a crash between
  // them doesn't leave currentAttempts inflated (blocking new claims).
  await db.transaction(async (tx) => {
    // Update attempt to 'abandoned'
    await tx
      .update(bountyAttempts)
      .set({
        status: 'abandoned',
        updatedAt: now,
      })
      .where(eq(bountyAttempts.id, attempt.id));

    // Decrement bounty.currentAttempts
    await tx
      .update(bounties)
      .set({
        currentAttempts: sql`GREATEST(${bounties.currentAttempts} - 1, 0)`,
        updatedAt: now,
      })
      .where(eq(bounties.id, id));
  });

  return c.json({
    success: true,
    message: 'Attempt abandoned',
  });
});

// ---------------------------------------------------------------------------
// 5. PATCH /:id — Update bounty (only if open, only by creator, can't change tokenReward)
// ---------------------------------------------------------------------------
bountyRoutes.patch('/:id', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Bounty');

  const body = await c.req.json();
  const parsed = updateBountySchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const avatar = await getActingAvatar(c);

  const [bounty] = await db
    .select()
    .from(bounties)
    .where(eq(bounties.id, id))
    .limit(1);

  if (!bounty) {
    throw new HTTPException(404, { message: 'Bounty not found' });
  }

  if (bounty.creatorId !== avatar.id) {
    throw new HTTPException(403, {
      message: 'Only the bounty creator can update this bounty',
    });
  }

  if (bounty.status !== 'open') {
    throw new HTTPException(400, {
      message: 'Can only update open bounties',
    });
  }

  const data = parsed.data;
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (data.title !== undefined) updates.title = data.title;
  if (data.description !== undefined) updates.description = data.description;
  if (data.requirements !== undefined) updates.requirements = data.requirements;
  if (data.difficulty !== undefined) updates.difficulty = data.difficulty;
  if (data.maxAttempts !== undefined) {
    // Can't set maxAttempts below current active attempts
    if (data.maxAttempts < bounty.currentAttempts) {
      throw new HTTPException(400, {
        message: `Cannot reduce maxAttempts below current active attempts (${bounty.currentAttempts})`,
      });
    }
    // SEV-2 (Codex) — a USDC bounty is a SINGLE-call escrow settled to ONE winning
    // hunter (the create superRefine pins maxAttempts=1). PATCH must NOT be able to
    // widen it: maxAttempts>1 on a USDC bounty would let multiple hunters expect
    // the one escrow (undefined who settles). Re-assert the invariant here.
    if (bounty.paymentRail === 'usdc' && data.maxAttempts !== 1) {
      throw new HTTPException(400, {
        message: 'A USDC bounty must keep maxAttempts=1 (single-call escrow, one winning hunter).',
      });
    }
    updates.maxAttempts = data.maxAttempts;
  }
  if (data.tags !== undefined) updates.tags = data.tags;
  if (data.expiresAt !== undefined)
    updates.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;

  const [updated] = await db
    .update(bounties)
    .set(updates)
    .where(eq(bounties.id, id))
    .returning();

  return c.json({
    success: true,
    bounty: {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      requirements: updated.requirements,
      difficulty: updated.difficulty,
      status: updated.status,
      tokenReward: updated.tokenReward,
      paymentRail: updated.paymentRail,
      maxAttempts: updated.maxAttempts,
      currentAttempts: updated.currentAttempts,
      tags: updated.tags,
      expiresAt: updated.expiresAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// 6. DELETE /:id — Cancel bounty (refund escrow if no active attempts)
// ---------------------------------------------------------------------------
bountyRoutes.delete('/:id', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Bounty');

  const avatar = await getActingAvatar(c);

  const [bounty] = await db
    .select()
    .from(bounties)
    .where(eq(bounties.id, id))
    .limit(1);

  if (!bounty) {
    throw new HTTPException(404, { message: 'Bounty not found' });
  }

  if (bounty.creatorId !== avatar.id) {
    throw new HTTPException(403, {
      message: 'Only the bounty creator can cancel this bounty',
    });
  }

  if (bounty.status !== 'open') {
    throw new HTTPException(400, {
      message: 'Can only cancel open bounties',
    });
  }

  // Check for active attempts (claimed, in_progress, or submitted)
  const activeAttempt = await db.query.bountyAttempts.findFirst({
    where: and(
      eq(bountyAttempts.bountyId, id),
      sql`${bountyAttempts.status} IN ('claimed', 'in_progress', 'submitted')`
    ),
  });

  if (activeAttempt) {
    throw new HTTPException(400, {
      message: 'Cannot cancel bounty with active attempts. Wait for attempts to resolve or be abandoned.',
    });
  }

  const isUsdc = bounty.paymentRail === 'usdc';
  const isComposed = bounty.compositionState != null;

  // ── COMPOSED rail (SLICE 2b): cancel refunds the LEG-1 vault to the creator ──
  // A composed bounty custodied the creator's USDC in an on-chain SAP V2 vault AT
  // CREATE (escrow_pda set, composition_state='vault_held'), so — unlike a legacy
  // usdc bounty — cancel MUST reclaim it (not just flip the row). Refund on the
  // depositor-bound V2 withdraw (idempotent on `${bountyId}:refund`), THEN flip to
  // cancelled: refund-FIRST means a refund failure never leaves a 'cancelled'
  // bounty with an unreclaimed vault; the flip is guarded on status='open', so
  // concurrent cancels can't double-cancel (the loser 409s after an idempotent
  // no-op refund — never a double-withdraw). A chain call must not run inside a DB
  // transaction, so this is refund → guarded-flip, not a single txn.
  if (isComposed) {
    // GRIEFING GUARD: a composed bounty with an APPROVED winner is mid-settlement
    // (the two-leg payout is running or reconciling). Its attempt is 'approved' —
    // NOT in the active-attempt set checked above — so without this a creator could
    // cancel-and-refund AFTER approving a winner, reclaiming the vault and cheating
    // the hunter (whose payout may be one crank away, and whose reward on a `failed`
    // settle is still fully in the vault). Route a decided bounty's reclaim through
    // admin-fail-refund / the settle crank, never a plain cancel.
    const decidedAttempt = await db.query.bountyAttempts.findFirst({
      where: and(
        eq(bountyAttempts.bountyId, id),
        eq(bountyAttempts.status, 'approved'),
      ),
    });
    if (decidedAttempt) {
      throw new HTTPException(409, {
        message:
          'This composed USDC bounty has an approved winner and a settlement in ' +
          'progress — it cannot be cancelled. Let the payout finalize, or route a ' +
          'reclaim through POST /:id/admin-fail-refund (admin).',
      });
    }
    // Belt-and-suspenders: a 'vault_held' composed bounty ALWAYS carries its LEG-1
    // vault PDA (recorded at create) — a null there is a corrupted row → fail closed.
    // EXCEPTION (cross-review): a 'vault_pending' bounty legitimately has a NULL
    // escrow_pda (a create crashed after the INSERT but before the vault opened+
    // recorded). It is NOT corrupted, so DON'T crash the cancel here — refundComposedBounty
    // re-derives the vault PDA from the deterministic bounty nonce (bountyEscrowNonce) and
    // IGNORES the escrow_pda arg entirely, so it reclaims an orphaned vault the crashed
    // create may have opened; passing the NULL through is safe.
    if (!bounty.escrowPda && bounty.compositionState !== 'vault_pending') {
      throw new HTTPException(500, {
        message: 'Composed bounty is missing its escrow PDA; cannot refund. Contact an operator.',
      });
    }

    // INTENT-BEFORE-EXTERNAL (Codex covenant round 5 HIGH #4; supersedes the
    // old refund-first-then-flip ordering): atomically claim the cancel (CAS
    // open→cancelled — a raced second cancel 409s HERE, before any chain
    // call) and write the durable refund intent, THEN run the irreversible
    // chain refund. A crash after chain success can no longer leave an OPEN,
    // claimable bounty with zero stream trace — the worst post-crash state is
    // cancelled + intent-without-outcome, completed idempotently via
    // admin-fail-refund (same SAP ledger key, same dedupe keys).
    // FUNDS SAFETY (the old ordering's vault_pending reasoning, preserved):
    // a refund failure leaves the vault deposit fully custodied on-chain; the
    // bounty being 'cancelled' (instead of the old still-open) is deliberate —
    // non-claimable while funds are in limbo. Recovery: 'vault_held' →
    // admin-fail-refund completes it; 'vault_pending' (crash-artifact create)
    // → ops reconcile, exactly as before. DRY-RUN simulates ok either way. The
    // `?? ''` only satisfies the (string) param type — refundComposedBounty
    // re-derives the vault PDA from the bounty nonce and never reads it.
    const claimed = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(bounties)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(bounties.id, id), eq(bounties.status, 'open')))
        .returning();
      if (!row) return undefined;
      await recordCovenantAction(
        {
          action: 'bounty.refund_requested',
          subjectType: 'avatar',
          subjectId: bounty.creatorId,
          actorKind: toActorKind(c.get('identity').kind),
          dedupeKey: `bounty:${bounty.id}:refund_requested:cancel`,
          payload: {
            bountyId: bounty.id,
            rail: 'sap-payai-composed',
            reason: 'creator_cancelled',
            tokenReward: bounty.tokenReward,
            ...(bounty.escrowPda ? { escrowPda: bounty.escrowPda } : {}),
          },
        },
        tx,
      );
      return row;
    });
    if (!claimed) {
      throw new HTTPException(409, {
        message: 'Bounty already cancelled or no longer open',
      });
    }

    const refund = await refundComposedBounty({
      bountyId: bounty.id,
      escrowPda: bounty.escrowPda ?? '',
      creatorAvatarId: bounty.creatorId,
      tokenReward: bounty.tokenReward,
    });
    if (refund.ok === false) {
      throw new HTTPException(escrowFailureStatus(refund.code), {
        message:
          `Composed USDC bounty vault refund failed (${refund.code}): ${refund.message}. ` +
          `The bounty is cancelled (non-claimable) and your deposit remains custodied ` +
          `on-chain — an admin completes the refund via admin-fail-refund (idempotent).`,
      });
    }

    // OUTCOME record — the refund executed. Same dedupe key as
    // admin-fail-refund: a bounty refunds once, whichever path completes it.
    await recordCovenantAction({
      action: 'bounty.refund',
      subjectType: 'avatar',
      subjectId: bounty.creatorId,
      actorKind: toActorKind(c.get('identity').kind),
      dedupeKey: `bounty:${bounty.id}:refund`,
      payload: {
        bountyId: bounty.id,
        rail: 'sap-payai-composed',
        reason: 'creator_cancelled',
        tokenReward: bounty.tokenReward,
        ...(bounty.escrowPda ? { escrowPda: bounty.escrowPda } : {}),
      },
    });

    const refundDryRun = refund.chain.ok ? refund.chain.dryRun : undefined;
    return c.json({
      success: true,
      message:
        'Composed USDC bounty cancelled and the on-chain vault deposit refunded to the creator.',
      refunded: bounty.tokenReward,
      dryRun: refundDryRun,
      // No CT moved on a USDC bounty — the balance is unchanged.
      clawTokens: avatar.clawTokens,
    });
  }

  // SEV-1-B guard (Codex, defense-in-depth): a USDC bounty with an OPEN on-chain
  // escrow must NEVER be plain-deleted — that would orphan the escrowed USDC.
  // Today a LEGACY (single-leg) usdc escrow only opens at APPROVE (which flips the
  // bounty to `completed`, so status!='open' already blocks this path), but a
  // future lifecycle change (e.g. eager-open at claim) could strand funds. Fail
  // closed on a code guard, not just the comment: route any escrow reclaim through
  // `admin-fail-refund`. `!isComposed` — a composed bounty is fully handled +
  // returned above; this is the legacy/single-leg path only.
  if (isUsdc && !isComposed && bounty.escrowPda) {
    throw new HTTPException(409, {
      message:
        'This USDC bounty has an open escrow and cannot be cancelled directly — ' +
        'route the reclaim through POST /:id/admin-fail-refund (admin) so the ' +
        'depositor-bound withdraw + escrow-gate guards apply.',
    });
  }

  // ESCROW REFUND + CANCEL in a single transaction to prevent double-refund
  // if the status update were to fail after the credit succeeds.
  //
  // USDC rail: NO CT is credited on cancel — the creator never debited CT (the
  // reward is on-chain USDC that is only escrowed LAZILY at approve time). Cancel
  // is only permitted with no active attempts (status='open', nothing claimed/
  // submitted), so a cancelled USDC bounty has NO open escrow to reclaim either.
  // Crediting CT here would be a CT FAUCET (mint free CT the creator never spent)
  // — a CLAUDE.md "never let a game be a faucet" violation. So we ONLY credit for
  // the CT rail.
  const { refundedBalance } = await db.transaction(async (tx) => {
    // 1. Atomically claim the bounty for cancellation
    const [claimed] = await tx
      .update(bounties)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(bounties.id, id), eq(bounties.status, 'open')))
      .returning();

    if (!claimed) {
      throw new HTTPException(409, {
        message: 'Bounty already cancelled or no longer open',
      });
    }

    // 2. Return escrowed tokens to creator (atomic + audited) — CT rail ONLY.
    if (isUsdc) {
      return { refundedBalance: avatar.clawTokens };
    }
    const { balanceAfter } = await creditClawTokens({
      avatarId: avatar.id,
      amount: bounty.tokenReward,
      reason: 'bounty_cancelled_refund',
      source: 'bounty',
      metadata: { bountyId: bounty.id },
    }, tx);

    return { refundedBalance: balanceAfter };
  });

  return c.json({
    success: true,
    message: isUsdc
      ? 'Bounty cancelled (USDC rail — no on-chain escrow was opened, nothing to refund)'
      : 'Bounty cancelled and tokens refunded',
    refunded: isUsdc ? 0 : bounty.tokenReward,
    clawTokens: refundedBalance,
  });
});

// ---------------------------------------------------------------------------
// 1. GET / — List open bounties (paginated, filterable, sortable)
// ---------------------------------------------------------------------------
bountyRoutes.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const pageSize = Math.min(
    50,
    Math.max(1, parseInt(c.req.query('pageSize') || '20', 10))
  );
  const offset = (page - 1) * pageSize;

  const difficulty = c.req.query('difficulty');
  const tag = c.req.query('tag');
  const statusFilter = c.req.query('status') || 'open';
  const sort = c.req.query('sort') || 'newest';

  // Build WHERE conditions
  const conditions: ReturnType<typeof eq>[] = [
    eq(
      bounties.status,
      statusFilter as 'open' | 'in_progress' | 'completed' | 'cancelled' | 'expired'
    ),
  ];

  if (difficulty) {
    conditions.push(
      eq(
        bounties.difficulty,
        difficulty as 'beginner' | 'intermediate' | 'advanced' | 'expert'
      )
    );
  }

  if (tag) {
    conditions.push(
      sql`${bounties.tags} @> ${JSON.stringify([tag])}::jsonb`
    );
  }

  const whereClause = and(...conditions);

  // Sort
  let orderBy;
  switch (sort) {
    case 'reward':
    case 'reward-high':
      orderBy = desc(bounties.tokenReward);
      break;
    case 'reward_asc':
    case 'reward-low':
      orderBy = asc(bounties.tokenReward);
      break;
    case 'expiring':
    case 'expiring-soon':
      orderBy = asc(bounties.expiresAt);
      break;
    case 'oldest':
      orderBy = asc(bounties.createdAt);
      break;
    default: // 'newest'
      orderBy = desc(bounties.createdAt);
  }

  // Count total
  const [{ total: totalCount }] = await db
    .select({ total: count() })
    .from(bounties)
    .where(whereClause);

  // Fetch bounties
  const rows = await db
    .select({
      id: bounties.id,
      creatorId: bounties.creatorId,
      title: bounties.title,
      description: bounties.description,
      difficulty: bounties.difficulty,
      status: bounties.status,
      tokenReward: bounties.tokenReward,
      paymentRail: bounties.paymentRail,
      maxAttempts: bounties.maxAttempts,
      currentAttempts: bounties.currentAttempts,
      isFeatured: bounties.isFeatured,
      tags: bounties.tags,
      expiresAt: bounties.expiresAt,
      createdAt: bounties.createdAt,
      creatorAvatarName: avatars.name,
      creatorSpecies: avatars.species,
    })
    .from(bounties)
    .innerJoin(avatars, eq(bounties.creatorId, avatars.id))
    .where(whereClause)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const bountyList = rows.map((r) => ({
    id: r.id,
    creatorId: r.creatorId,
    creatorAvatarName: r.creatorAvatarName,
    creatorSpecies: r.creatorSpecies,
    title: r.title,
    description: r.description,
    difficulty: r.difficulty,
    status: r.status,
    tokenReward: r.tokenReward,
    // paymentRail disambiguates vclaw (in-game, 1 vCLAW=$0.01) from usdc (on-chain).
    paymentRail: r.paymentRail,
    maxAttempts: r.maxAttempts,
    currentAttempts: r.currentAttempts,
    isFeatured: r.isFeatured,
    tags: r.tags,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));

  return c.json({ bounties: bountyList, total: totalCount, page, pageSize });
});
