import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { creditClawTokens, debitClawTokens } from '../services/claw-token-ledger';
import {
  db,
  avatars,
  publishedSkills,
  agentConfigs,
  avatarInventory,
  bounties,
  bountyRewards,
  bountyAttempts,
  bountyReputation,
} from '@clawville/database';
import { eq, and, desc, asc, sql, ne } from 'drizzle-orm';
import { count } from 'drizzle-orm';

// Agent parity (Rule E5, Phase B). Every WRITE binds to `identity.avatarId` from
// `requireAuthOrAgentSession` — the SAME avatar for a Lucia human AND a
// connected/hosted agent (`X-Clawville-Agent-Session` → its bound avatar). The
// route group runs `sessionMiddleware` FIRST so the middleware can read
// `c.get('user')` for the human path; the agent path reads the session header.
// Escrow + self-deal guards (creator≠claimant, only-creator-reviews,
// only-creator-cancels) are unchanged — they were already keyed on the acting
// avatar id, which is now the resolved `identity.avatarId`.
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
async function getActingAvatar(c: { get: (k: 'identity') => ActivityAuthContext['Variables']['identity'] }) {
  const identity = c.get('identity');
  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.id, identity.avatarId),
  });
  if (!avatar) throw new HTTPException(404, { message: 'No active agent found' });
  return avatar;
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

const bonusRewardSchema = z.object({
  rewardType: z.enum(['skill', 'agent_config', 'knowledge_book', 'custom']),
  skillId: z.string().uuid().optional(),
  agentConfigId: z.string().uuid().optional(),
  bookId: z.string().optional(),
  customDescription: z.string().max(500).optional(),
});

const createBountySchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  requirements: z.string().max(5000).optional(),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced', 'expert']),
  tokenReward: z.number().int().min(10),
  maxAttempts: z.number().int().min(1).max(100).default(1),
  tags: z.array(z.string().max(30)).max(10).optional(),
  expiresAt: z.string().datetime().optional(),
  bonusRewards: z.array(bonusRewardSchema).max(5).optional(),
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
      status: r.bountyStatus,
    },
  }));

  return c.json({ attempts });
});

// ---------------------------------------------------------------------------
// 4. POST /create — Create a bounty (auth + escrow)
// ---------------------------------------------------------------------------
bountyRoutes.post('/create', requireAuthOrAgentSession, async (c) => {
  const body = await c.req.json().catch(() => ({}));
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

  // ESCROW: Verify creator has enough tokens
  if (avatar.clawTokens < data.tokenReward) {
    throw new HTTPException(400, {
      message: `Not enough ClawTokens. Need ${data.tokenReward}, have ${avatar.clawTokens}.`,
    });
  }

  // Validate bonus reward references
  if (data.bonusRewards) {
    for (const reward of data.bonusRewards) {
      if (reward.rewardType === 'skill' && reward.skillId) {
        const [skill] = await db
          .select({ id: publishedSkills.id })
          .from(publishedSkills)
          .where(eq(publishedSkills.id, reward.skillId))
          .limit(1);
        if (!skill) {
          throw new HTTPException(404, { message: `Skill reward not found: ${reward.skillId}` });
        }
      }
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

  // ESCROW: Debit + bounty INSERT in a single transaction so if INSERT
  // fails, the debit rolls back and the creator doesn't lose tokens.
  const bounty = await db.transaction(async (tx) => {
    // Deduct tokenReward from creator (atomic + audited)
    await debitClawTokens({
      avatarId: avatar.id,
      amount: data.tokenReward,
      reason: 'bounty_escrow',
      source: 'bounty',
      metadata: { bountyTitle: data.title },
    }, tx);

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
      })
      .returning();

    // Create bonus reward records
    if (data.bonusRewards && data.bonusRewards.length > 0) {
      await tx.insert(bountyRewards).values(
        data.bonusRewards.map((reward) => ({
          bountyId: created.id,
          rewardType: reward.rewardType,
          skillId: reward.skillId ?? null,
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
      expiresAt: bounty.expiresAt?.toISOString() ?? null,
      createdAt: bounty.createdAt.toISOString(),
    },
    // The debitClawTokens call above already updated the balance — recompute
    // the display value from avatar.clawTokens (stale read) minus the debit
    clawTokens: avatar.clawTokens - data.tokenReward,
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
bountyRoutes.post('/attempts/:attemptId/review', requireAuthOrAgentSession, async (c) => {
  const attemptId = c.req.param('attemptId');
  validateUuid(attemptId, 'Attempt');

  const body = await c.req.json().catch(() => ({}));
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

  if (decision === 'approved') {
    // Entire approval flow in a single transaction to prevent partial
    // state (e.g. tokens credited but bounty not marked completed).
    const { rewards } = await db.transaction(async (tx) => {
      // 1. ATOMIC CLAIM (double-settle guard, FIX-1). The status transition IS
      //    the claim: flip submitted→approved gated on `status='submitted'`.
      //    Two concurrent approvals both passed the in-memory `status==='submitted'`
      //    check above, but only ONE can flip the row here — the loser matches 0
      //    rows and 409s BEFORE crediting the hunter, so the escrowed reward can
      //    never be released twice (no CT minted). Mirrors bazaar.ts buy.
      const claimed = await tx
        .update(bountyAttempts)
        .set({
          status: 'approved',
          reviewNote: reviewNote ?? null,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(and(eq(bountyAttempts.id, attemptId), eq(bountyAttempts.status, 'submitted')))
        .returning({ id: bountyAttempts.id });
      if (claimed.length === 0) {
        throw new HTTPException(409, { message: 'Attempt already reviewed' });
      }

      // 2. Transfer escrowed tokenReward to hunter's clawTokens (UNREACHABLE
      //    unless the claim above won this attempt's review).
      const hunterAvatar = await tx.query.avatars.findFirst({
        where: eq(avatars.id, attempt.hunterId),
      });

      if (!hunterAvatar) {
        throw new HTTPException(500, { message: 'Hunter avatar not found' });
      }

      // Release escrowed tokenReward to hunter (atomic + audited)
      await creditClawTokens({
        avatarId: hunterAvatar.id,
        amount: bounty.tokenReward,
        reason: 'bounty_reward',
        source: 'bounty',
        metadata: { bountyId: bounty.id, attemptId: attempt.id },
      }, tx);

      // 3. Transfer bonus rewards to hunter
      const txRewards = await tx
        .select()
        .from(bountyRewards)
        .where(eq(bountyRewards.bountyId, bounty.id));

      for (const reward of txRewards) {
        if (reward.rewardType === 'skill' && reward.skillId) {
          const itemId = `skill-${reward.skillId}`;
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

      // 4. Mark bounty as 'completed'
      await tx
        .update(bounties)
        .set({
          status: 'completed',
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(bounties.id, bounty.id));

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

      // 5. Update bounty reputation for hunter
      const hunterRep = await tx.query.bountyReputation.findFirst({
        where: eq(bountyReputation.avatarId, hunterAvatar.id),
      });

      const newSuccessRate = await recalculateSuccessRate(hunterAvatar.id, tx);

      if (hunterRep) {
        const newCompleted = hunterRep.totalCompleted + 1;
        const newTier = calculateReputationTier(newCompleted);
        await tx
          .update(bountyReputation)
          .set({
            totalCompleted: newCompleted,
            totalEarned: hunterRep.totalEarned + bounty.tokenReward,
            tier: newTier as any,
            successRate: newSuccessRate,
            lastActivityAt: now,
            updatedAt: now,
          })
          .where(eq(bountyReputation.id, hunterRep.id));
      } else {
        const newTier = calculateReputationTier(1);
        await tx.insert(bountyReputation).values({
          avatarId: hunterAvatar.id,
          totalCompleted: 1,
          totalEarned: bounty.tokenReward,
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

      return { rewards: txRewards };
    });

    return c.json({
      success: true,
      decision: 'approved',
      tokensAwarded: bounty.tokenReward,
      bonusRewardsCount: rewards.length,
    });
  } else {
    // Rejected — wrap in transaction so attempt rejection + slot release
    // + reputation update are atomic (prevents orphaned slot on crash).
    await db.transaction(async (tx) => {
      // ATOMIC CLAIM (FIX-1): flip submitted→rejected gated on the state so two
      // concurrent reviews (reject racing reject, or reject racing approve)
      // can't BOTH run the slot-release + reputation update. Only the winner
      // proceeds; the loser 409s before decrementing currentAttempts twice.
      const claimed = await tx
        .update(bountyAttempts)
        .set({
          status: 'rejected',
          reviewNote: reviewNote ?? null,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(and(eq(bountyAttempts.id, attemptId), eq(bountyAttempts.status, 'submitted')))
        .returning({ id: bountyAttempts.id });
      if (claimed.length === 0) {
        throw new HTTPException(409, { message: 'Attempt already reviewed' });
      }

      // Decrement currentAttempts to allow new attempts
      await tx
        .update(bounties)
        .set({
          currentAttempts: sql`GREATEST(${bounties.currentAttempts} - 1, 0)`,
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
      skillId: r.skillId,
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
bountyRoutes.post('/:id/claim', requireAuthOrAgentSession, async (c) => {
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
bountyRoutes.post('/:id/submit', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id'); // bounty ID
  validateUuid(id, 'Bounty');

  const body = await c.req.json().catch(() => ({}));
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
bountyRoutes.post('/:id/abandon', requireAuthOrAgentSession, async (c) => {
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
bountyRoutes.patch('/:id', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Bounty');

  const body = await c.req.json().catch(() => ({}));
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
bountyRoutes.delete('/:id', requireAuthOrAgentSession, async (c) => {
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

  // ESCROW REFUND + CANCEL in a single transaction to prevent double-refund
  // if the status update were to fail after the credit succeeds.
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

    // 2. Return escrowed tokens to creator (atomic + audited)
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
    message: 'Bounty cancelled and tokens refunded',
    refunded: bounty.tokenReward,
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
    maxAttempts: r.maxAttempts,
    currentAttempts: r.currentAttempts,
    isFeatured: r.isFeatured,
    tags: r.tags,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));

  return c.json({ bounties: bountyList, total: totalCount, page, pageSize });
});
