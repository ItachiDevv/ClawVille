import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
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
  findTier1BountyHold,
  insertTier1BountyHold,
  releaseTier1BountyHold,
  resolveTier1BountyMaxUsdCents,
  settleTier1Bounty,
  assertTier1BountyApprovable,
  claimTier1BountyCancellation,
  Tier1HoldAdmissionError,
  Tier1LifecycleConflictError,
} from '../services/bounty-tier1';
import { lockPosterUsdcSpend } from '../services/usdc-spend-admission';
import { usdcRewardBaseUnits } from '../services/x402-payai';
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
//   settlement binds to the Tier-1 hold + agent-pay state machine — both act as
//   themselves, no guest fallback.
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
 * NEVER drive a real-money (custodial-wallet) transition — the USDC payment rail.
 * The CT rail is fine for any resolved avatar (CT is the in-game economy, not a
 * custodial sign). Mirrors the other custodial `requireLedgerCapable` gates.
 */
function agentNotLedgerCapable(
  identity: ActivityAuthContext['Variables']['identity'],
): boolean {
  return identity.kind === 'agent' && identity.ledgerCapable !== true;
}

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
 * deep in the payment builder. 1,000,000 vCLAW ($10,000) × 10^4 =
 * 1e10 USDC base units, far inside signed-u64 headroom and above any realistic bounty. The
 * floor is `USDC_BOUNTY_REWARD_MIN` (below). Bump deliberately if the product ever
 * needs a larger single-bounty payment.
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
    // is vCLAW (1 vCLAW = $0.01); Tier 1 converts it to integer USDC base units × 10^4.
    tokenReward: z.number().int().min(1),
    maxAttempts: z.number().int().min(1).max(100).default(1),
    tags: z.array(z.string().max(30)).max(10).optional(),
    expiresAt: z.string().datetime().optional(),
    bonusRewards: z.array(bonusRewardSchema).max(5).optional(),
    // ── Phase 1: USDC rail (default 'vclaw' = the in-game vCLAW board) ──
    /** Payout rail. 'usdc' selects the Tier-1 hold + agent-pay rail. */
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
      const tier1Max = resolveTier1BountyMaxUsdCents();
      if (data.tokenReward > tier1Max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tokenReward'],
          message:
            `A Tier-1 USDC bounty may not exceed ${tier1Max} vCLAW ` +
            `($${(tier1Max / 100).toFixed(2)}).`,
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
    // A USDC bounty keeps a custodial balance hold until it is paid, rejected,
    // cancelled, or expires. Require an explicit expiry so the Tier-1 sweeper has a
    // deterministic release deadline. vCLAW bounties stay expiry-optional.
    if (data.paymentRail === 'usdc' && !data.expiresAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message:
          'expiresAt is required for a USDC bounty (the custodial hold needs a release deadline).',
      });
    }
    // A USDC bounty is paid to one winning hunter, so maxAttempts must be 1.
    if (data.paymentRail === 'usdc' && data.maxAttempts !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxAttempts'],
        message: 'A USDC bounty must have maxAttempts=1 (one payment, one winning hunter).',
      });
    }
    // Cap the USDC reward at a sane business ceiling (solana SEV-3): reject an
    // oversized reward as a clean 400 HERE, not as a u64-range throw deep in the
    // payment builder (usdcRewardBaseUnits × 10^4 must stay well inside u64).
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
  const settlementTier = isUsdc ? 1 : 0;
  const isTier1 = isUsdc;

  if (isUsdc) {
    // A USDC bounty can authorize real custodial funds at settlement, so a connected
    // agent MUST have proven ledger capability. The vCLAW rail is fine for any
    // resolved avatar. Fail closed here, mirroring the other money routes.
    if (agentNotLedgerCapable(c.get('identity'))) {
      throw new HTTPException(403, {
        message:
          'This agent session has not proven ownership of its avatar and cannot post a ' +
          'real-USDC bounty. Reconnect with a fresh connect-token or the signed-challenge reconnect.',
      });
    }
  } else {
    // ESCROW (vCLAW rail): Verify creator has enough vCLAW. USDC bounties never
    // debit vCLAW; Tier 1 records a custodial balance hold.
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
  // For USDC there is no vCLAW debit. Tier 1 inserts its hold in this transaction.
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
      })
      .returning();

    if (isTier1) {
      await insertTier1BountyHold(tx, {
        bountyId: created.id,
        posterAvatarId: avatar.id,
        amountBaseUnits: usdcRewardBaseUnits(created.tokenReward),
      });
    }

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
          ...(isUsdc ? { settlementTier } : {}),
        },
      },
      tx,
    );

    return created;
  }).catch((error) => {
    if (error instanceof Tier1HoldAdmissionError) {
      const status = error.code === 'balance_unavailable'
        ? 503
        : error.code === 'wallet_missing'
          ? 404
          : 409;
      throw new HTTPException(status, { message: error.message });
    }
    throw error;
  });

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
      settlementTier: isUsdc ? settlementTier : null,
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
  const tier1Hold = isUsdc ? await findTier1BountyHold(bounty.id) : null;
  const isTier1 = tier1Hold !== null;

  // Tier 1 is the only supported USDC path. Historical USDC rows without a
  // Tier-1 hold belong to the retired rail and must not mutate their verdict,
  // bounty, reputation, or payment state.
  if (isUsdc && !isTier1) {
    throw new HTTPException(409, {
      message:
        'This legacy USDC bounty is not backed by a Tier-1 hold and cannot be reviewed. ' +
        'An operator must reconcile or migrate it.',
    });
  }

  // A USDC approval drives a real custodial payment — require ledger capability.
  if (isUsdc && agentNotLedgerCapable(c.get('identity'))) {
    throw new HTTPException(403, {
        message:
        'This agent session has not proven ownership of its avatar and cannot settle a ' +
        'real-USDC bounty. Reconnect with a fresh connect-token or the signed-challenge reconnect.',
    });
  }

  if (decision === 'approved') {
    // Entire approval flow in a single transaction to prevent partial
    // state (e.g. tokens credited but bounty not marked completed). The Tier-1
    // payment runs after this transaction through its own idempotent state machine.
    const { rewards, hunterAvatarId } = await db.transaction(async (tx) => {
      if (isTier1) {
        try {
          await assertTier1BountyApprovable(tx, {
            bountyId: bounty.id,
            posterAvatarId: bounty.creatorId,
            now,
          });
        } catch (error) {
          if (error instanceof Tier1LifecycleConflictError) {
            throw new HTTPException(409, {
              message: 'This Tier-1 bounty is no longer open; approval was refused.',
            });
          }
          throw error;
        }
      }

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
      // vCLAW rides the ledger hook in this transaction; Tier-1 records its
      // settlement through the payment state machine after this transaction.
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
      // pay through Tier 1 after this transaction and never credit vCLAW.
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
      if (!isTier1) {
        const completed = await tx
          .update(bounties)
          .set({
            status: 'completed',
            completedAt: now,
            updatedAt: now,
          })
          .where(and(eq(bounties.id, bounty.id), eq(bounties.status, 'open')))
          .returning({ id: bounties.id });
        if (completed.length !== 1) {
          throw new HTTPException(409, { message: 'Bounty completion CAS lost.' });
        }
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
      // completion bump until AFTER Tier-1 settlement succeeds (post-commit) so a
      // failed payment can't leave phantom completion+earnings. Here
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

    if (isTier1) {
      const result = await settleTier1Bounty({
        bountyId: bounty.id,
        posterAvatarId: bounty.creatorId,
        hunterAvatarId,
        rewardUsdCents: bounty.tokenReward,
      });
      if (!result.ok) {
        const ambiguous = result.payment.code === 'payment_reconcile';
        return c.json({
          success: true,
          decision: 'approved',
          paymentRail: bounty.paymentRail,
          settlement: {
            rail: 'tier1-agent-pay',
            state: ambiguous ? 'payment_reconcile' : 'payment_pending',
            paymentId: result.payment.paymentId ?? null,
            code: result.payment.code,
          },
          message: ambiguous
            ? 'Approved. The Tier-1 USDC payment outcome is ambiguous and frozen for operator reconciliation. The poster balance hold remains open.'
            : 'Approved. The Tier-1 USDC payment is pending automatic retry or operator resolution. The poster balance hold remains open until payment is confirmed.',
        }, 202);
      }
      return c.json({
        success: true,
        decision: 'approved',
        paymentRail: bounty.paymentRail,
        tokensAwarded: 0,
        rewardVclaw: bounty.tokenReward,
        rewardUsdcBaseUnits: tier1Hold.amountBaseUnits,
        bonusRewardsCount: rewards.length,
        settlement: {
          rail: 'tier1-agent-pay',
          state: 'paid',
          paymentId: result.payment.paymentId,
          txSignature: result.payment.txSignature,
          replay: result.replay,
        },
      });
    }

    const escrowResult = null;

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
      if (isTier1) await lockPosterUsdcSpend(tx, bounty.creatorId);
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

      // A Tier-1 rejection terminalizes the bounty and releases its custodial
      // balance hold atomically. vCLAW rejection only frees the attempt slot.
      if (isTier1) {
        const terminal = await tx
          .update(bounties)
          .set({
            status: 'cancelled',
            currentAttempts: 0,
            covenantVerificationPassed: false,
            updatedAt: now,
          })
          .where(and(eq(bounties.id, bounty.id), eq(bounties.status, 'open')))
          .returning({ id: bounties.id });
        if (terminal.length !== 1) {
          throw new HTTPException(409, { message: 'Tier-1 bounty rejection CAS lost.' });
        }
        await releaseTier1BountyHold(tx, {
          bountyId: bounty.id,
          posterAvatarId: bounty.creatorId,
          reason: 'rejected',
          actorKind: toActorKind(c.get('identity').kind),
        });
      } else {
        await tx
          .update(bounties)
          .set({
            currentAttempts: sql`GREATEST(${bounties.currentAttempts} - 1, 0)`,
            ...(isUsdc ? { covenantVerificationPassed: false } : {}),
            updatedAt: now,
          })
          .where(eq(bounties.id, bounty.id));
      }

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

  const isUsdc = bounty.paymentRail === 'usdc';
  const tier1Hold = isUsdc ? await findTier1BountyHold(bounty.id) : null;
  const isTier1 = tier1Hold !== null;
  if (isUsdc && !isTier1) {
    throw new HTTPException(409, {
      message:
        'This legacy USDC bounty is not backed by a Tier-1 hold and cannot be claimed. ' +
        'An operator must reconcile or migrate it.',
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

  const [bounty] = await db
    .select({ paymentRail: bounties.paymentRail })
    .from(bounties)
    .where(eq(bounties.id, id))
    .limit(1);
  const isUsdc = bounty?.paymentRail === 'usdc';
  const tier1Hold = isUsdc ? await findTier1BountyHold(id) : null;
  const isTier1 = tier1Hold !== null;
  if (isUsdc && !isTier1) {
    throw new HTTPException(409, {
      message:
        'This legacy USDC bounty is not backed by a Tier-1 hold and cannot accept submitted work. ' +
        'An operator must reconcile or migrate it.',
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
    // A USDC bounty has one payment and one winning hunter (the create schema pins
    // maxAttempts=1). PATCH must not widen it.
    if (bounty.paymentRail === 'usdc' && data.maxAttempts !== 1) {
      throw new HTTPException(400, {
        message: 'A USDC bounty must keep maxAttempts=1 (one payment, one winning hunter).',
      });
    }
    updates.maxAttempts = data.maxAttempts;
  }
  if (data.tags !== undefined) updates.tags = data.tags;
  if (data.expiresAt !== undefined) {
    // A USDC bounty's expiry is the ONLY release mechanism for its custodial
    // hold (the Tier-1 sweeper). Nulling it would park the poster's money
    // forever, so a USDC bounty must always keep a deadline.
    if (bounty.paymentRail === 'usdc' && !data.expiresAt) {
      throw new HTTPException(400, {
        message:
          'A USDC bounty must keep an expiry (the custodial hold needs a release deadline).',
      });
    }
    updates.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  }

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
  const tier1Hold = isUsdc ? await findTier1BountyHold(bounty.id) : null;
  const isTier1 = tier1Hold !== null;

  // Tier 1 is the only supported USDC path. Refuse historical rows before any
  // cancellation or hold-release mutation; they require operator reconciliation.
  if (isUsdc && !isTier1) {
    throw new HTTPException(409, {
      message:
        'This legacy USDC bounty is not backed by a Tier-1 hold and cannot be cancelled. ' +
        'An operator must reconcile or migrate it.',
    });
  }

  if (isTier1) {
    const approvedAttempt = await db.query.bountyAttempts.findFirst({
      where: and(
        eq(bountyAttempts.bountyId, bounty.id),
        eq(bountyAttempts.status, 'approved'),
      ),
    });
    if (approvedAttempt) {
      throw new HTTPException(409, {
        message:
          'This Tier-1 bounty has an approved payment in progress and cannot be cancelled.',
      });
    }
  }

  // CANCEL + HOLD/TOKEN RELEASE in one transaction so terminal state and funds
  // availability cannot diverge.
  //
  // USDC rail: NO CT is credited on cancel — the creator never debited CT. Tier 1
  // releases the poster's custodial balance hold instead.
  // Crediting CT here would be a CT FAUCET (mint free CT the creator never spent)
  // — a CLAUDE.md "never let a game be a faucet" violation. So we ONLY credit for
  // the CT rail.
  const { refundedBalance } = await db.transaction(async (tx) => {
    // 1. Atomically claim the bounty for cancellation. Tier 1 re-asserts every
    // no-attempt/no-payment precondition after taking the poster lock; the
    // earlier route reads are UX only and never authorize hold release.
    const claimed = isTier1
      ? await claimTier1BountyCancellation(tx, {
          bountyId: bounty.id,
          posterAvatarId: bounty.creatorId,
          now: new Date(),
        })
      : (await tx
          .update(bounties)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(and(eq(bounties.id, id), eq(bounties.status, 'open')))
          .returning()).length === 1;

    if (!claimed) {
      throw new HTTPException(409, {
        message: isTier1
          ? 'Tier-1 bounty cancellation lost to an active/approved attempt or payment.'
          : 'Bounty already cancelled or no longer open',
      });
    }

    // 2. Return escrowed tokens to creator (atomic + audited) — CT rail ONLY.
    if (isTier1) {
      await releaseTier1BountyHold(tx, {
        bountyId: bounty.id,
        posterAvatarId: bounty.creatorId,
        reason: 'cancelled',
        actorKind: toActorKind(c.get('identity').kind),
      });
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
    message: isTier1
      ? 'Tier-1 USDC bounty cancelled and its custodial balance hold released.'
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
