import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppContext } from '../types';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import {
  db,
  pets,
  publishedSkills,
  agentConfigs,
  petInventory,
  bounties,
  bountyRewards,
  bountyAttempts,
  bountyReputation,
} from '@clawville/database';
import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { count } from 'drizzle-orm';

export const bountyRoutes = new Hono<AppContext>();
bountyRoutes.use('*', sessionMiddleware);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getUserPet(userId: string) {
  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, userId), eq(pets.isActive, true)),
  });
  if (!pet) throw new HTTPException(404, { message: 'No active agent found' });
  return pet;
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
      creatorPetName: pets.name,
      creatorSpecies: pets.species,
    })
    .from(bounties)
    .innerJoin(pets, eq(bounties.creatorId, pets.id))
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
    creatorPetName: r.creatorPetName,
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
bountyRoutes.get('/my-bounties', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const pet = await getUserPet(user.id);

  const rows = await db
    .select()
    .from(bounties)
    .where(eq(bounties.creatorId, pet.id))
    .orderBy(desc(bounties.createdAt));

  // Fetch attempts for all these bounties (with hunter names)
  const bountyIds = rows.map((r) => r.id);
  const attemptRows = bountyIds.length > 0
    ? await db
        .select({
          attempt: bountyAttempts,
          hunterName: pets.name,
        })
        .from(bountyAttempts)
        .innerJoin(pets, eq(bountyAttempts.hunterId, pets.id))
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
bountyRoutes.get('/my-attempts', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const pet = await getUserPet(user.id);

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
    .where(eq(bountyAttempts.hunterId, pet.id))
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
bountyRoutes.post('/create', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };

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
  const pet = await getUserPet(user.id);

  // ESCROW: Verify creator has enough tokens
  if (pet.clawTokens < data.tokenReward) {
    throw new HTTPException(400, {
      message: `Not enough ClawTokens. Need ${data.tokenReward}, have ${pet.clawTokens}.`,
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

  // ESCROW: Deduct tokenReward from creator
  await db
    .update(pets)
    .set({
      clawTokens: pet.clawTokens - data.tokenReward,
      updatedAt: new Date(),
    })
    .where(eq(pets.id, pet.id));

  // Create bounty
  const [bounty] = await db
    .insert(bounties)
    .values({
      creatorId: pet.id,
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
    await db.insert(bountyRewards).values(
      data.bonusRewards.map((reward) => ({
        bountyId: bounty.id,
        rewardType: reward.rewardType,
        skillId: reward.skillId ?? null,
        agentConfigId: reward.agentConfigId ?? null,
        bookId: reward.bookId ?? null,
        customDescription: reward.customDescription ?? null,
      }))
    );
  }

  // Update reputation: increment totalPosted
  const existingRep = await db.query.bountyReputation.findFirst({
    where: eq(bountyReputation.petId, pet.id),
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
      petId: pet.id,
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
    clawTokens: pet.clawTokens - data.tokenReward,
  });
});

// ---------------------------------------------------------------------------
// 13. GET /reputation/:petId — Get bounty reputation for a pet
// ---------------------------------------------------------------------------
bountyRoutes.get('/reputation/:petId', async (c) => {
  const petId = c.req.param('petId');
  validateUuid(petId, 'Pet');

  const rep = await db.query.bountyReputation.findFirst({
    where: eq(bountyReputation.petId, petId),
  });

  if (!rep) {
    // Return default newcomer reputation
    return c.json({
      reputation: {
        petId,
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
      petId: rep.petId,
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
bountyRoutes.post('/attempts/:attemptId/review', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
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
  const reviewerPet = await getUserPet(user.id);

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
  if (bounty.creatorId !== reviewerPet.id) {
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
    // 1. Update attempt status to 'approved'
    await db
      .update(bountyAttempts)
      .set({
        status: 'approved',
        reviewNote: reviewNote ?? null,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(bountyAttempts.id, attemptId));

    // 2. Transfer escrowed tokenReward to hunter's clawTokens
    const hunterPet = await db.query.pets.findFirst({
      where: eq(pets.id, attempt.hunterId),
    });

    if (!hunterPet) {
      throw new HTTPException(500, { message: 'Hunter pet not found' });
    }

    await db
      .update(pets)
      .set({
        clawTokens: hunterPet.clawTokens + bounty.tokenReward,
        updatedAt: now,
      })
      .where(eq(pets.id, hunterPet.id));

    // 3. Transfer bonus rewards to hunter
    const rewards = await db
      .select()
      .from(bountyRewards)
      .where(eq(bountyRewards.bountyId, bounty.id));

    for (const reward of rewards) {
      if (reward.rewardType === 'skill' && reward.skillId) {
        const itemId = `skill-${reward.skillId}`;
        const existingItem = await db.query.petInventory.findFirst({
          where: and(
            eq(petInventory.petId, hunterPet.id),
            eq(petInventory.itemId, itemId)
          ),
        });

        if (existingItem) {
          await db
            .update(petInventory)
            .set({ quantity: existingItem.quantity + 1 })
            .where(eq(petInventory.id, existingItem.id));
        } else {
          await db.insert(petInventory).values({
            petId: hunterPet.id,
            itemId,
            quantity: 1,
          });
        }
      }

      if (reward.rewardType === 'knowledge_book' && reward.bookId) {
        const itemId = `book-${reward.bookId}`;
        const existingItem = await db.query.petInventory.findFirst({
          where: and(
            eq(petInventory.petId, hunterPet.id),
            eq(petInventory.itemId, itemId)
          ),
        });

        if (existingItem) {
          await db
            .update(petInventory)
            .set({ quantity: existingItem.quantity + 1 })
            .where(eq(petInventory.id, existingItem.id));
        } else {
          await db.insert(petInventory).values({
            petId: hunterPet.id,
            itemId,
            quantity: 1,
          });
        }
      }

      // agent_config and custom rewards are noted but don't auto-transfer inventory
    }

    // 4. Mark bounty as 'completed'
    await db
      .update(bounties)
      .set({
        status: 'completed',
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(bounties.id, bounty.id));

    // 5. Update bounty reputation for hunter
    const hunterRep = await db.query.bountyReputation.findFirst({
      where: eq(bountyReputation.petId, hunterPet.id),
    });

    if (hunterRep) {
      const newCompleted = hunterRep.totalCompleted + 1;
      const newTier = calculateReputationTier(newCompleted);
      await db
        .update(bountyReputation)
        .set({
          totalCompleted: newCompleted,
          totalEarned: hunterRep.totalEarned + bounty.tokenReward,
          tier: newTier as any,
          lastActivityAt: now,
          updatedAt: now,
        })
        .where(eq(bountyReputation.id, hunterRep.id));
    } else {
      const newTier = calculateReputationTier(1);
      await db.insert(bountyReputation).values({
        petId: hunterPet.id,
        totalCompleted: 1,
        totalEarned: bounty.tokenReward,
        tier: newTier as any,
        lastActivityAt: now,
      });
    }

    // 6. Update reputation for creator (track activity)
    const creatorRep = await db.query.bountyReputation.findFirst({
      where: eq(bountyReputation.petId, reviewerPet.id),
    });

    if (creatorRep) {
      await db
        .update(bountyReputation)
        .set({
          lastActivityAt: now,
          updatedAt: now,
        })
        .where(eq(bountyReputation.id, creatorRep.id));
    }

    return c.json({
      success: true,
      decision: 'approved',
      tokensAwarded: bounty.tokenReward,
      bonusRewardsCount: rewards.length,
    });
  } else {
    // Rejected
    await db
      .update(bountyAttempts)
      .set({
        status: 'rejected',
        reviewNote: reviewNote ?? null,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(bountyAttempts.id, attemptId));

    // Decrement currentAttempts to allow new attempts
    await db
      .update(bounties)
      .set({
        currentAttempts: sql`GREATEST(${bounties.currentAttempts} - 1, 0)`,
        updatedAt: now,
      })
      .where(eq(bounties.id, bounty.id));

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
      creatorPetName: pets.name,
      creatorSpecies: pets.species,
    })
    .from(bounties)
    .innerJoin(pets, eq(bounties.creatorId, pets.id))
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
    where: eq(bountyReputation.petId, row.creatorId),
  });

  return c.json({
    bounty: {
      id: row.id,
      creatorId: row.creatorId,
      creatorPetName: row.creatorPetName,
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
bountyRoutes.post('/:id/claim', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  validateUuid(id, 'Bounty');

  const pet = await getUserPet(user.id);

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
  if (bounty.creatorId === pet.id) {
    throw new HTTPException(400, {
      message: 'Cannot claim your own bounty',
    });
  }

  // Verify currentAttempts < maxAttempts
  if (bounty.currentAttempts >= bounty.maxAttempts) {
    throw new HTTPException(400, {
      message: 'This bounty has reached its maximum number of active attempts',
    });
  }

  // Verify hunter doesn't already have an active attempt
  const existingAttempt = await db.query.bountyAttempts.findFirst({
    where: and(
      eq(bountyAttempts.bountyId, id),
      eq(bountyAttempts.hunterId, pet.id),
      sql`${bountyAttempts.status} IN ('claimed', 'in_progress', 'submitted')`
    ),
  });

  if (existingAttempt) {
    throw new HTTPException(400, {
      message: 'You already have an active attempt for this bounty',
    });
  }

  // Create attempt
  const [attempt] = await db
    .insert(bountyAttempts)
    .values({
      bountyId: id,
      hunterId: pet.id,
      status: 'claimed',
    })
    .returning();

  // Increment currentAttempts
  await db
    .update(bounties)
    .set({
      currentAttempts: bounty.currentAttempts + 1,
      updatedAt: new Date(),
    })
    .where(eq(bounties.id, id));

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
bountyRoutes.post('/:id/submit', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
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

  const pet = await getUserPet(user.id);

  // Find the hunter's active attempt (claimed or in_progress) for this bounty
  const attempt = await db.query.bountyAttempts.findFirst({
    where: and(
      eq(bountyAttempts.bountyId, id),
      eq(bountyAttempts.hunterId, pet.id),
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
bountyRoutes.post('/:id/abandon', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id'); // bounty ID
  validateUuid(id, 'Bounty');

  const pet = await getUserPet(user.id);

  // Find the hunter's active attempt for this bounty
  const attempt = await db.query.bountyAttempts.findFirst({
    where: and(
      eq(bountyAttempts.bountyId, id),
      eq(bountyAttempts.hunterId, pet.id),
      sql`${bountyAttempts.status} IN ('claimed', 'in_progress')`
    ),
  });

  if (!attempt) {
    throw new HTTPException(404, {
      message: 'No active attempt found for this bounty',
    });
  }

  const now = new Date();

  // Update attempt to 'abandoned'
  await db
    .update(bountyAttempts)
    .set({
      status: 'abandoned',
      updatedAt: now,
    })
    .where(eq(bountyAttempts.id, attempt.id));

  // Decrement bounty.currentAttempts
  await db
    .update(bounties)
    .set({
      currentAttempts: sql`GREATEST(${bounties.currentAttempts} - 1, 0)`,
      updatedAt: now,
    })
    .where(eq(bounties.id, id));

  return c.json({
    success: true,
    message: 'Attempt abandoned',
  });
});

// ---------------------------------------------------------------------------
// 5. PATCH /:id — Update bounty (only if open, only by creator, can't change tokenReward)
// ---------------------------------------------------------------------------
bountyRoutes.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
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

  const pet = await getUserPet(user.id);

  const [bounty] = await db
    .select()
    .from(bounties)
    .where(eq(bounties.id, id))
    .limit(1);

  if (!bounty) {
    throw new HTTPException(404, { message: 'Bounty not found' });
  }

  if (bounty.creatorId !== pet.id) {
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
bountyRoutes.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  validateUuid(id, 'Bounty');

  const pet = await getUserPet(user.id);

  const [bounty] = await db
    .select()
    .from(bounties)
    .where(eq(bounties.id, id))
    .limit(1);

  if (!bounty) {
    throw new HTTPException(404, { message: 'Bounty not found' });
  }

  if (bounty.creatorId !== pet.id) {
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

  // ESCROW REFUND: Return escrowed tokens to creator
  await db
    .update(pets)
    .set({
      clawTokens: pet.clawTokens + bounty.tokenReward,
      updatedAt: new Date(),
    })
    .where(eq(pets.id, pet.id));

  // Mark bounty as cancelled
  await db
    .update(bounties)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(bounties.id, id));

  return c.json({
    success: true,
    message: 'Bounty cancelled and tokens refunded',
    refunded: bounty.tokenReward,
    clawTokens: pet.clawTokens + bounty.tokenReward,
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
      creatorPetName: pets.name,
      creatorSpecies: pets.species,
    })
    .from(bounties)
    .innerJoin(pets, eq(bounties.creatorId, pets.id))
    .where(whereClause)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const bountyList = rows.map((r) => ({
    id: r.id,
    creatorId: r.creatorId,
    creatorPetName: r.creatorPetName,
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
