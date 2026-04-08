import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppContext } from '../types';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import {
  db,
  users,
  pets,
  publishedSkills,
  quests,
  questSubmissions,
  questRewards,
  petInventory,
} from '@elizapets/database';
import { eq, and, desc, sql } from 'drizzle-orm';
import { count } from 'drizzle-orm';

export const questRoutes = new Hono<AppContext>();
questRoutes.use('*', sessionMiddleware);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_EMAILS = ['admin@clawville.com']; // extend later

function isAdmin(userEmail: string | null): boolean {
  return !!userEmail && ADMIN_EMAILS.includes(userEmail);
}

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

function requireAdminUser(c: any): { id: string; email: string } {
  const user = c.get('user') as { id: string; email: string | null };
  if (!isAdmin(user.email)) {
    throw new HTTPException(403, { message: 'Admin access required' });
  }
  return user as { id: string; email: string };
}

const GITHUB_URL_REGEX = /^https:\/\/github\.com\/.+\/.+\/pull\/\d+/;

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const submitSchema = z.object({
  prLink: z
    .string()
    .url()
    .regex(GITHUB_URL_REGEX, 'Must be a GitHub pull request URL')
    .optional(),
  submissionNote: z.string().min(10).max(2000),
});

const createQuestSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  tier: z.enum(['side_quest', 'main_quest', 'legendary']),
  tokenReward: z.number().int().min(1),
  skillRewardId: z.string().uuid().optional(),
  titleReward: z.string().max(100).optional(),
  maxCompletions: z.number().int().min(1).default(1),
  requirements: z.string().max(5000).optional(),
  verificationMethod: z.string().max(50).default('manual'),
  expiresAt: z.string().datetime().optional(),
});

const updateQuestSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(10).max(5000).optional(),
  tier: z.enum(['side_quest', 'main_quest', 'legendary']).optional(),
  status: z.enum(['draft', 'active', 'completed', 'archived']).optional(),
  tokenReward: z.number().int().min(1).optional(),
  skillRewardId: z.string().uuid().nullable().optional(),
  titleReward: z.string().max(100).nullable().optional(),
  maxCompletions: z.number().int().min(1).optional(),
  requirements: z.string().max(5000).nullable().optional(),
  verificationMethod: z.string().max(50).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewNote: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------------------
// STATIC ROUTES FIRST (before /:id)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. GET /my-quests — User's quest submissions with quest details (auth)
// ---------------------------------------------------------------------------
questRoutes.get('/my-quests', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const pet = await getUserPet(user.id);

  const rows = await db
    .select({
      submission: questSubmissions,
      questTitle: quests.title,
      questDescription: quests.description,
      questTier: quests.tier,
      questTokenReward: quests.tokenReward,
      questSkillRewardId: quests.skillRewardId,
      questTitleReward: quests.titleReward,
      questStatus: quests.status,
    })
    .from(questSubmissions)
    .innerJoin(quests, eq(questSubmissions.questId, quests.id))
    .where(eq(questSubmissions.petId, pet.id))
    .orderBy(desc(questSubmissions.createdAt));

  const submissions = rows.map((r) => ({
    id: r.submission.id,
    questId: r.submission.questId,
    status: r.submission.status,
    prLink: r.submission.prLink,
    submissionNote: r.submission.submissionNote,
    reviewNote: r.submission.reviewNote,
    startedAt: r.submission.startedAt.toISOString(),
    submittedAt: r.submission.submittedAt?.toISOString() ?? null,
    reviewedAt: r.submission.reviewedAt?.toISOString() ?? null,
    createdAt: r.submission.createdAt.toISOString(),
    quest: {
      title: r.questTitle,
      description: r.questDescription,
      tier: r.questTier,
      tokenReward: r.questTokenReward,
      skillRewardId: r.questSkillRewardId,
      titleReward: r.questTitleReward,
      status: r.questStatus,
    },
  }));

  return c.json({ submissions });
});

// ---------------------------------------------------------------------------
// 7. GET /quest-log — Completed quests and rewards earned (auth)
// ---------------------------------------------------------------------------
questRoutes.get('/quest-log', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const pet = await getUserPet(user.id);

  const rows = await db
    .select({
      reward: questRewards,
      questTitle: quests.title,
      questTier: quests.tier,
      questDescription: quests.description,
      skillName: publishedSkills.name,
    })
    .from(questRewards)
    .innerJoin(quests, eq(questRewards.questId, quests.id))
    .leftJoin(publishedSkills, eq(questRewards.skillId, publishedSkills.id))
    .where(eq(questRewards.petId, pet.id))
    .orderBy(desc(questRewards.claimedAt));

  const rewards = rows.map((r) => ({
    id: r.reward.id,
    questId: r.reward.questId,
    submissionId: r.reward.submissionId,
    tokensAwarded: r.reward.tokensAwarded,
    skillId: r.reward.skillId,
    skillName: r.skillName ?? null,
    titleAwarded: r.reward.titleAwarded,
    claimedAt: r.reward.claimedAt.toISOString(),
    quest: {
      title: r.questTitle,
      tier: r.questTier,
      description: r.questDescription,
    },
  }));

  return c.json({ rewards });
});

// ---------------------------------------------------------------------------
// ADMIN ROUTES (static paths, auth + admin check)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 8. POST /admin/create — Create a new quest (admin)
// ---------------------------------------------------------------------------
questRoutes.post('/admin/create', requireAuth, async (c) => {
  const admin = requireAdminUser(c);

  const body = await c.req.json();
  const parsed = createQuestSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const data = parsed.data;

  // If skillRewardId provided, verify it exists
  if (data.skillRewardId) {
    const [skill] = await db
      .select({ id: publishedSkills.id })
      .from(publishedSkills)
      .where(eq(publishedSkills.id, data.skillRewardId))
      .limit(1);

    if (!skill) {
      throw new HTTPException(404, { message: 'Skill reward not found' });
    }
  }

  const [quest] = await db
    .insert(quests)
    .values({
      title: data.title,
      description: data.description,
      tier: data.tier,
      tokenReward: data.tokenReward,
      skillRewardId: data.skillRewardId ?? null,
      titleReward: data.titleReward ?? null,
      maxCompletions: data.maxCompletions,
      requirements: data.requirements ?? null,
      verificationMethod: data.verificationMethod,
      createdBy: admin.id,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    })
    .returning();

  return c.json({
    success: true,
    quest: {
      id: quest.id,
      title: quest.title,
      description: quest.description,
      tier: quest.tier,
      status: quest.status,
      tokenReward: quest.tokenReward,
      skillRewardId: quest.skillRewardId,
      titleReward: quest.titleReward,
      maxCompletions: quest.maxCompletions,
      currentCompletions: quest.currentCompletions,
      requirements: quest.requirements,
      verificationMethod: quest.verificationMethod,
      expiresAt: quest.expiresAt?.toISOString() ?? null,
      createdAt: quest.createdAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// 11. GET /admin/submissions — List all pending submissions for review (admin)
// ---------------------------------------------------------------------------
questRoutes.get('/admin/submissions', requireAuth, async (c) => {
  requireAdminUser(c);

  const statusFilter = c.req.query('status') || 'submitted';

  const rows = await db
    .select({
      submission: questSubmissions,
      questTitle: quests.title,
      questTier: quests.tier,
      petName: pets.name,
      petSpecies: pets.species,
    })
    .from(questSubmissions)
    .innerJoin(quests, eq(questSubmissions.questId, quests.id))
    .innerJoin(pets, eq(questSubmissions.petId, pets.id))
    .where(
      eq(
        questSubmissions.status,
        statusFilter as
          | 'accepted'
          | 'in_progress'
          | 'submitted'
          | 'in_review'
          | 'approved'
          | 'rejected'
      )
    )
    .orderBy(desc(questSubmissions.submittedAt));

  const submissions = rows.map((r) => ({
    id: r.submission.id,
    questId: r.submission.questId,
    petId: r.submission.petId,
    status: r.submission.status,
    prLink: r.submission.prLink,
    submissionNote: r.submission.submissionNote,
    reviewNote: r.submission.reviewNote,
    startedAt: r.submission.startedAt.toISOString(),
    submittedAt: r.submission.submittedAt?.toISOString() ?? null,
    createdAt: r.submission.createdAt.toISOString(),
    questTitle: r.questTitle,
    questTier: r.questTier,
    petName: r.petName,
    petSpecies: r.petSpecies,
  }));

  return c.json({ submissions });
});

// ---------------------------------------------------------------------------
// 9. PATCH /admin/:id — Update quest details (admin)
// ---------------------------------------------------------------------------
questRoutes.patch('/admin/:id', requireAuth, async (c) => {
  requireAdminUser(c);
  const id = c.req.param('id');
  validateUuid(id, 'Quest');

  const body = await c.req.json();
  const parsed = updateQuestSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  // Verify quest exists
  const [existing] = await db
    .select()
    .from(quests)
    .where(eq(quests.id, id))
    .limit(1);

  if (!existing) {
    throw new HTTPException(404, { message: 'Quest not found' });
  }

  const data = parsed.data;
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (data.title !== undefined) updates.title = data.title;
  if (data.description !== undefined) updates.description = data.description;
  if (data.tier !== undefined) updates.tier = data.tier;
  if (data.status !== undefined) updates.status = data.status;
  if (data.tokenReward !== undefined) updates.tokenReward = data.tokenReward;
  if (data.skillRewardId !== undefined)
    updates.skillRewardId = data.skillRewardId;
  if (data.titleReward !== undefined) updates.titleReward = data.titleReward;
  if (data.maxCompletions !== undefined)
    updates.maxCompletions = data.maxCompletions;
  if (data.requirements !== undefined) updates.requirements = data.requirements;
  if (data.verificationMethod !== undefined)
    updates.verificationMethod = data.verificationMethod;
  if (data.expiresAt !== undefined)
    updates.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;

  const [updated] = await db
    .update(quests)
    .set(updates)
    .where(eq(quests.id, id))
    .returning();

  return c.json({
    success: true,
    quest: {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      tier: updated.tier,
      status: updated.status,
      tokenReward: updated.tokenReward,
      skillRewardId: updated.skillRewardId,
      titleReward: updated.titleReward,
      maxCompletions: updated.maxCompletions,
      currentCompletions: updated.currentCompletions,
      requirements: updated.requirements,
      verificationMethod: updated.verificationMethod,
      expiresAt: updated.expiresAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// 10. POST /admin/:submissionId/review — Review a submission (admin)
// ---------------------------------------------------------------------------
questRoutes.post('/admin/:submissionId/review', requireAuth, async (c) => {
  const admin = requireAdminUser(c);
  const submissionId = c.req.param('submissionId');
  validateUuid(submissionId, 'Submission');

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

  // Fetch submission with quest details
  const [submissionRow] = await db
    .select({
      submission: questSubmissions,
      quest: quests,
    })
    .from(questSubmissions)
    .innerJoin(quests, eq(questSubmissions.questId, quests.id))
    .where(eq(questSubmissions.id, submissionId))
    .limit(1);

  if (!submissionRow) {
    throw new HTTPException(404, { message: 'Submission not found' });
  }

  const submission = submissionRow.submission;
  const quest = submissionRow.quest;

  // Only review submissions in 'submitted' or 'in_review' status
  if (submission.status !== 'submitted' && submission.status !== 'in_review') {
    throw new HTTPException(400, {
      message: `Cannot review submission with status '${submission.status}'`,
    });
  }

  const now = new Date();

  if (decision === 'approved') {
    // 1. Update submission status to 'approved'
    await db
      .update(questSubmissions)
      .set({
        status: 'approved',
        reviewNote: reviewNote ?? null,
        reviewedBy: admin.id,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(questSubmissions.id, submissionId));

    // 2. Award tokens to pet
    const pet = await db.query.pets.findFirst({
      where: eq(pets.id, submission.petId),
    });

    if (!pet) {
      throw new HTTPException(500, { message: 'Submission pet not found' });
    }

    await db
      .update(pets)
      .set({
        neoTokens: pet.neoTokens + quest.tokenReward,
        updatedAt: now,
      })
      .where(eq(pets.id, pet.id));

    // 3. If quest has skillRewardId, add skill to pet_inventory
    if (quest.skillRewardId) {
      const itemId = `skill-${quest.skillRewardId}`;
      const existingItem = await db.query.petInventory.findFirst({
        where: and(
          eq(petInventory.petId, pet.id),
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
          petId: pet.id,
          itemId,
          quantity: 1,
        });
      }
    }

    // 4. Create quest_reward record
    await db.insert(questRewards).values({
      submissionId,
      petId: pet.id,
      questId: quest.id,
      tokensAwarded: quest.tokenReward,
      skillId: quest.skillRewardId ?? null,
      titleAwarded: quest.titleReward ?? null,
    });

    // 5. Increment quest.currentCompletions
    const newCompletions = (quest.currentCompletions ?? 0) + 1;
    const questUpdates: Record<string, unknown> = {
      currentCompletions: newCompletions,
      updatedAt: now,
    };

    // 6. If currentCompletions >= maxCompletions, mark quest as 'completed'
    if (quest.maxCompletions && newCompletions >= quest.maxCompletions) {
      questUpdates.status = 'completed';
    }

    await db.update(quests).set(questUpdates).where(eq(quests.id, quest.id));

    return c.json({
      success: true,
      decision: 'approved',
      tokensAwarded: quest.tokenReward,
      skillRewardId: quest.skillRewardId ?? null,
      titleAwarded: quest.titleReward ?? null,
      questCompleted:
        quest.maxCompletions != null && newCompletions >= quest.maxCompletions,
    });
  } else {
    // Rejected
    await db
      .update(questSubmissions)
      .set({
        status: 'rejected',
        reviewNote: reviewNote ?? null,
        reviewedBy: admin.id,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(questSubmissions.id, submissionId));

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
// 2. GET /:id — Get quest details with submission count (public)
// ---------------------------------------------------------------------------
questRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Quest');

  const [quest] = await db
    .select()
    .from(quests)
    .where(eq(quests.id, id))
    .limit(1);

  if (!quest) {
    throw new HTTPException(404, { message: 'Quest not found' });
  }

  // Count submissions by status
  const submissionCounts = await db
    .select({
      status: questSubmissions.status,
      count: count(),
    })
    .from(questSubmissions)
    .where(eq(questSubmissions.questId, id))
    .groupBy(questSubmissions.status);

  const countByStatus: Record<string, number> = {};
  for (const row of submissionCounts) {
    countByStatus[row.status] = row.count;
  }

  // Get skill reward details if present
  let skillReward = null;
  if (quest.skillRewardId) {
    const [skill] = await db
      .select({
        id: publishedSkills.id,
        name: publishedSkills.name,
        description: publishedSkills.description,
        rarity: publishedSkills.rarity,
      })
      .from(publishedSkills)
      .where(eq(publishedSkills.id, quest.skillRewardId))
      .limit(1);

    if (skill) {
      skillReward = skill;
    }
  }

  return c.json({
    quest: {
      id: quest.id,
      title: quest.title,
      description: quest.description,
      tier: quest.tier,
      status: quest.status,
      tokenReward: quest.tokenReward,
      skillRewardId: quest.skillRewardId,
      skillReward,
      titleReward: quest.titleReward,
      maxCompletions: quest.maxCompletions,
      currentCompletions: quest.currentCompletions,
      requirements: quest.requirements,
      verificationMethod: quest.verificationMethod,
      expiresAt: quest.expiresAt?.toISOString() ?? null,
      createdAt: quest.createdAt.toISOString(),
      updatedAt: quest.updatedAt.toISOString(),
    },
    submissionCounts: countByStatus,
  });
});

// ---------------------------------------------------------------------------
// 3. POST /:id/accept — Accept a quest (auth)
// ---------------------------------------------------------------------------
questRoutes.post('/:id/accept', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  validateUuid(id, 'Quest');

  const pet = await getUserPet(user.id);

  // Verify quest exists and is active
  const [quest] = await db
    .select()
    .from(quests)
    .where(and(eq(quests.id, id), eq(quests.status, 'active')))
    .limit(1);

  if (!quest) {
    throw new HTTPException(404, {
      message: 'Quest not found or not active',
    });
  }

  // Verify not full
  if (
    quest.maxCompletions &&
    (quest.currentCompletions ?? 0) >= quest.maxCompletions
  ) {
    throw new HTTPException(400, {
      message: 'This quest has reached its maximum number of completions',
    });
  }

  // Verify pet doesn't already have an active submission for this quest
  // Active = any status that isn't 'approved' or 'rejected'
  const existingSubmission = await db.query.questSubmissions.findFirst({
    where: and(
      eq(questSubmissions.questId, id),
      eq(questSubmissions.petId, pet.id),
      sql`${questSubmissions.status} NOT IN ('approved', 'rejected')`
    ),
  });

  if (existingSubmission) {
    throw new HTTPException(400, {
      message: 'You already have an active submission for this quest',
    });
  }

  const [submission] = await db
    .insert(questSubmissions)
    .values({
      questId: id,
      petId: pet.id,
      status: 'accepted',
    })
    .returning();

  return c.json({
    success: true,
    submission: {
      id: submission.id,
      questId: submission.questId,
      status: submission.status,
      startedAt: submission.startedAt.toISOString(),
      createdAt: submission.createdAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// 4. POST /:id/start — Mark submission as in_progress (auth)
// ---------------------------------------------------------------------------
questRoutes.post('/:id/start', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id'); // quest ID
  validateUuid(id, 'Quest');

  const pet = await getUserPet(user.id);

  // Find the pet's accepted submission for this quest
  const submission = await db.query.questSubmissions.findFirst({
    where: and(
      eq(questSubmissions.questId, id),
      eq(questSubmissions.petId, pet.id),
      eq(questSubmissions.status, 'accepted')
    ),
  });

  if (!submission) {
    throw new HTTPException(404, {
      message:
        'No accepted submission found for this quest. Accept the quest first.',
    });
  }

  const [updated] = await db
    .update(questSubmissions)
    .set({ status: 'in_progress', updatedAt: new Date() })
    .where(eq(questSubmissions.id, submission.id))
    .returning();

  return c.json({
    success: true,
    submission: {
      id: updated.id,
      questId: updated.questId,
      status: updated.status,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// 5. POST /:id/submit — Submit completed work (auth)
// ---------------------------------------------------------------------------
questRoutes.post('/:id/submit', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id'); // quest ID
  validateUuid(id, 'Quest');

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

  // Find the pet's in_progress (or accepted) submission for this quest
  const submission = await db.query.questSubmissions.findFirst({
    where: and(
      eq(questSubmissions.questId, id),
      eq(questSubmissions.petId, pet.id),
      sql`${questSubmissions.status} IN ('accepted', 'in_progress')`
    ),
  });

  if (!submission) {
    throw new HTTPException(404, {
      message:
        'No active submission found for this quest. Accept and start it first.',
    });
  }

  const now = new Date();

  const [updated] = await db
    .update(questSubmissions)
    .set({
      status: 'submitted',
      prLink: parsed.data.prLink ?? null,
      submissionNote: parsed.data.submissionNote,
      submittedAt: now,
      updatedAt: now,
    })
    .where(eq(questSubmissions.id, submission.id))
    .returning();

  return c.json({
    success: true,
    submission: {
      id: updated.id,
      questId: updated.questId,
      status: updated.status,
      prLink: updated.prLink,
      submissionNote: updated.submissionNote,
      submittedAt: updated.submittedAt?.toISOString() ?? null,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// 1. GET / — List active quests (paginated, filterable) (public)
// ---------------------------------------------------------------------------
questRoutes.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const pageSize = Math.min(
    50,
    Math.max(1, parseInt(c.req.query('pageSize') || '20', 10))
  );
  const offset = (page - 1) * pageSize;

  const tierFilter = c.req.query('tier');
  const statusFilter = c.req.query('status') || 'active';

  // Build WHERE conditions
  const conditions: ReturnType<typeof eq>[] = [
    eq(
      quests.status,
      statusFilter as 'draft' | 'active' | 'completed' | 'archived'
    ),
  ];

  if (tierFilter) {
    conditions.push(
      eq(
        quests.tier,
        tierFilter as 'side_quest' | 'main_quest' | 'legendary'
      )
    );
  }

  const whereClause = and(...conditions);

  // Count total
  const [{ total: totalCount }] = await db
    .select({ total: count() })
    .from(quests)
    .where(whereClause);

  // Fetch quests
  const rows = await db
    .select({
      id: quests.id,
      title: quests.title,
      description: quests.description,
      tier: quests.tier,
      status: quests.status,
      tokenReward: quests.tokenReward,
      skillRewardId: quests.skillRewardId,
      titleReward: quests.titleReward,
      maxCompletions: quests.maxCompletions,
      currentCompletions: quests.currentCompletions,
      requirements: quests.requirements,
      verificationMethod: quests.verificationMethod,
      expiresAt: quests.expiresAt,
      createdAt: quests.createdAt,
    })
    .from(quests)
    .where(whereClause)
    .orderBy(desc(quests.createdAt))
    .limit(pageSize)
    .offset(offset);

  const questList = rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    tier: r.tier,
    status: r.status,
    tokenReward: r.tokenReward,
    skillRewardId: r.skillRewardId,
    titleReward: r.titleReward,
    maxCompletions: r.maxCompletions,
    currentCompletions: r.currentCompletions,
    requirements: r.requirements,
    verificationMethod: r.verificationMethod,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));

  return c.json({ quests: questList, total: totalCount, page, pageSize });
});
