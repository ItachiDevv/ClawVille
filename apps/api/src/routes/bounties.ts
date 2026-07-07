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
import { creditClawTokens, debitClawTokens } from '../services/claw-token-ledger';
import {
  refundBountyEscrow,
  runBountyUsdcSettle,
  usdcRailGateOpen,
} from '../services/bounty-escrow-link';
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
//   same endpoints via X-Clawville-Agent-Session → bound avatar. CT settlement
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
      return 403;
    case 'over_release':
      return 400;
    case 'already_settled':
    case 'settle_in_progress':
    case 'refund_in_progress':
    case 'funding_unconfirmed':
    case 'job_not_open':
    case 'rail_mixed_forbidden':
      return 409;
    case 'rpc_unreachable':
    case 'payai_unavailable':
    case 'payai_release_failed':
      return 502;
    case 'internal':
      return 500;
    default:
      return 400;
  }
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
 * Business ceiling for a USDC-rail bounty reward (whole USDC). A create over this
 * is a clean 400 at the schema boundary (solana SEV-3) — NOT a u64-range throw
 * deep in the escrow instruction builder. 1,000,000 USDC → 1e12 base units, far
 * inside u64 (max ~1.8e19) with headroom, and far above any realistic bounty. The
 * min is the shared `tokenReward` floor (10). Bump deliberately if the product
 * ever needs a larger single-bounty escrow.
 */
const USDC_BOUNTY_REWARD_MAX = 1_000_000;

const bonusRewardSchema = z.object({
  rewardType: z.enum(['agent_config', 'knowledge_book', 'custom']),
  agentConfigId: z.string().uuid().optional(),
  bookId: z.string().optional(),
  customDescription: z.string().max(500).optional(),
});

const createBountySchema = z
  .object({
    title: z.string().min(3).max(200),
    description: z.string().min(10).max(5000),
    requirements: z.string().max(5000).optional(),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced', 'expert']),
    // The shared reward floor is 10. For a USDC bounty this is 10 WHOLE USDC (the
    // unit is whole dollars, converted to base units × 1e6 at the escrow boundary
    // — see bounty-escrow-link.usdcRewardBaseUnits); for CT it is 10 ClawTokens.
    // The USDC ceiling is USDC_BOUNTY_REWARD_MAX (checked in the superRefine).
    tokenReward: z.number().int().min(10),
    maxAttempts: z.number().int().min(1).max(100).default(1),
    tags: z.array(z.string().max(30)).max(10).optional(),
    expiresAt: z.string().datetime().optional(),
    bonusRewards: z.array(bonusRewardSchema).max(5).optional(),
    // ── Phase 1: USDC rail (default 'ct' = the classic CT board) ──
    /** Payout rail. 'usdc' opens a SAP escrow (gated OFF + dry-run by default). */
    paymentRail: z.enum(['ct', 'usdc']).default('ct'),
    /**
     * Human/agent-readable acceptance criteria the verdict is judged against.
     * MANDATORY for a USDC bounty (enforced by the superRefine below — a verdict
     * with nothing to verify against is scaffolding theater). Optional for CT.
     */
    acceptanceCriteria: z.string().min(10).max(5000).optional(),
  })
  .superRefine((data, ctx) => {
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
    // escrow builder (usdcRewardBaseUnits × 1e6 must stay well inside u64).
    if (data.paymentRail === 'usdc' && data.tokenReward > USDC_BOUNTY_REWARD_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tokenReward'],
        message: `A USDC bounty reward may not exceed ${USDC_BOUNTY_REWARD_MAX} USDC.`,
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
bountyRoutes.get('/my-bounties', requireAuthOrAgentSession, async (c) => {
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
bountyRoutes.get('/my-attempts', requireAuthOrAgentSession, async (c) => {
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

  if (isUsdc) {
    // A USDC bounty escrows on-chain USDC (custodial-wallet sign at settle), so a
    // connected agent MUST have proven ledger capability. The CT rail is fine for
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
          'SAP_USDC_ESCROW_ENABLED). Post a ClawToken (payment_rail=ct) bounty instead.',
      });
    }
  } else {
    // ESCROW (CT rail): Verify creator has enough tokens. USDC bounties do NOT
    // debit CT — their reward is on-chain USDC prepaid into a SAP escrow.
    if (avatar.clawTokens < data.tokenReward) {
      throw new HTTPException(400, {
        message: `Not enough ClawTokens. Need ${data.tokenReward}, have ${avatar.clawTokens}.`,
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

  // ESCROW: Debit (CT rail only) + bounty INSERT in a single transaction so if
  // INSERT fails, the CT debit rolls back and the creator doesn't lose tokens.
  // For the USDC rail there is NO CT debit — the reward is on-chain USDC that is
  // escrowed LAZILY at approve time (once a winning hunter is known); the row is
  // persisted with `payment_rail='usdc'` + `verdict_required=true` + NULL escrow.
  const bounty = await db.transaction(async (tx) => {
    if (!isUsdc) {
      // Deduct tokenReward from creator (atomic + audited) — CT rail only.
      await debitClawTokens({
        avatarId: avatar.id,
        amount: data.tokenReward,
        reason: 'bounty_escrow',
        source: 'bounty',
        metadata: { bountyTitle: data.title },
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
        // Phase 1 — payout rail + verdict binding. A CT bounty keeps the schema
        // defaults ('ct', verdict_required=false, criteria NULL).
        paymentRail: data.paymentRail,
        acceptanceCriteria: data.acceptanceCriteria ?? null,
        verdictRequired: isUsdc,
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

    return created;
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
      await tx
        .update(bounties)
        .set({
          status: 'completed',
          completedAt: now,
          updatedAt: now,
        })
        .where(and(eq(bounties.id, bounty.id), eq(bounties.status, 'open')));

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
    let escrowResult:
      | { ok: true; escrowPda: string | null; auditRootHex: string | null; dryRun: boolean }
      | null = null;
    if (isUsdc) {
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
      // PASS — persist the verdict provenance onto the bounty.
      await db
        .update(bounties)
        .set({
          escrowPda: settle.escrowPda,
          escrowJobId: settle.escrowPda ? bounty.id : null,
          covenantAuditRootHex: settle.auditRootHex,
          covenantVerificationPassed: true,
          updatedAt: new Date(),
        })
        .where(eq(bounties.id, bounty.id));

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
      usdcReward: isUsdc ? bounty.tokenReward : 0,
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
  if (!bounty.escrowPda) {
    throw new HTTPException(409, {
      message:
        'This USDC bounty has no open escrow to refund (the escrow is opened at ' +
        'approve time; a bounty never approved has nothing on-chain to reclaim).',
    });
  }
  // SEV-2-B guard (Codex): NEVER attempt a refund on an already-SETTLED bounty.
  // A PASS verdict (`covenant_verification_passed === true`) means the escrow was
  // released to the worker — the escrow gate would reject a refund on a `settled`
  // row anyway, but a clean 409 here is correct + prevents operator confusion (a
  // fail-refund is only for a FAILED/disputed job, not a paid-out one).
  if (bounty.covenantVerificationPassed === true) {
    throw new HTTPException(409, {
      message:
        'This USDC bounty already settled (PASS verdict) — its escrow was released ' +
        'to the worker and cannot be fail-refunded.',
    });
  }

  // Drive the depositor-bound refund. The escrow gate re-asserts the depositor,
  // makes its own atomic `refunding` claim, and ceilings the amount — the admin
  // can only trigger it, never redirect the funds.
  const refund = await refundBountyEscrow({
    bountyId: bounty.id,
    escrowPda: bounty.escrowPda,
    creatorAvatarId: bounty.creatorId,
    tokenReward: bounty.tokenReward,
  });

  if (refund.ok === false) {
    throw new HTTPException(escrowFailureStatus(refund.code), {
      message: `USDC escrow refund failed (${refund.code}): ${refund.message}`,
    });
  }

  // Record the FAIL verdict provenance on the bounty (idempotent).
  await db
    .update(bounties)
    .set({
      covenantVerificationPassed: false,
      updatedAt: new Date(),
    })
    .where(eq(bounties.id, bounty.id));

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
      // paymentRail disambiguates whether tokenReward is CT or WHOLE USDC;
      // acceptanceCriteria is the USDC-bounty verdict rubric (null for CT).
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

  const [updated] = await db
    .update(bountyAttempts)
    .set({
      status: 'submitted',
      prLink: parsed.data.prLink ?? null,
      submissionNote: parsed.data.submissionNote,
      submittedAt: now,
      updatedAt: now,
    })
    .where(eq(bountyAttempts.id, attempt.id))
    .returning();

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

  // SEV-1-B guard (Codex, defense-in-depth): a USDC bounty with an OPEN on-chain
  // escrow must NEVER be plain-deleted — that would orphan the escrowed USDC.
  // Today an escrow only opens at APPROVE (which flips the bounty to `completed`,
  // so status!='open' already blocks this path), but a future lifecycle change
  // (e.g. eager-open at claim) could strand funds. Fail closed on a code guard,
  // not just the comment: route any escrow reclaim through `admin-fail-refund`.
  if (isUsdc && bounty.escrowPda) {
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
    // paymentRail disambiguates whether tokenReward is CT or WHOLE USDC.
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
