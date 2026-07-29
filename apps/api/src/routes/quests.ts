import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { createMiddleware } from 'hono/factory';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import { creditClawTokens } from '../services/claw-token-ledger';
import { logEventFromContext } from '../services/event-logger';
// Covenant action-record stream (2026-07-13): quest lifecycle commitments
// (accept/submit/approve/reject) append records in the SAME tx as the write.
// The reward credit's economy.credit record rides the ledger hook.
import {
  recordCovenantAction,
  type CovenantActorKind,
} from '../services/covenant-action-recorder';
import { createHash } from 'crypto';

/** Map the auth identity kind onto the covenant actor vocabulary. */
const toActorKind = (kind: 'user' | 'agent'): CovenantActorKind =>
  kind === 'user' ? 'human' : 'agent';
import {
  db,
  users,
  avatars,
  quests,
  questSubmissions,
  questRewards,
  avatarInventory,
  tutorialQuestClaims,
} from '@clawville/database';
import { eq, and, desc, sql } from 'drizzle-orm';
import { count } from 'drizzle-orm';
import {
  TUTORIAL_QUEST_REWARDS,
  TUTORIAL_QUEST_STATUS,
  getTutorialQuestReward,
  type TutorialQuestId,
} from '@clawville/shared';

// PARITY (Rule E5, 2026-07-13): the five PLAYER routes (my-quests, quest-log,
// accept, start, submit) resolve identity via `requireAuthOrAgentSession`, so a
// connected/hosted agent plays quests AS ITSELF — its `X-Clawville-Agent-Session`
// header resolves to its BOUND avatar and the submission/reward rows bind to
// that avatar exactly as a human's do. Guests (human or guest-owned agent) are
// blocked by `requireNonGuestIdentity` on the write paths. Agent identities must
// ALSO be `ledgerCapable` on ALL FIVE routes (Codex adversarial review
// 2026-07-13, HIGH #1): an ownership-UNPROVEN session (agentId-only reconnect to
// an already-bound bot / legacy register) resolves the BOUND user's avatar with
// `ledgerCapable=false`, so without this gate it could read the victim's quest
// history and lock them out of quests by squatting junk submissions on their
// avatar. Same fail-closed shape as the cove — never a guest demotion.
// Admin routes + the tutorial ladder (client-tracked human onboarding, keyed on
// `userId`) intentionally stay human-only.
export const questRoutes = new Hono<ActivityAuthContext>();
questRoutes.use('*', sessionMiddleware);

/**
 * 403 an agent identity that has not PROVEN ownership of its bound avatar.
 * Humans (`kind:'user'`) pass untouched. Exported for the parity test suite.
 */
export const requireLedgerCapableIdentity = createMiddleware<ActivityAuthContext>(
  async (c, next) => {
    const identity = c.get('identity');
    if (identity && identity.kind === 'agent' && identity.ledgerCapable !== true) {
      throw new HTTPException(403, {
        message:
          'agent_session_not_ledger_authorized: prove avatar ownership (fresh connect-token or signed-challenge reconnect) before using the quest board',
      });
    }
    return next();
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_EMAILS = ['admin@clawville.com']; // extend later

function isAdmin(userEmail: string | null): boolean {
  return !!userEmail && ADMIN_EMAILS.includes(userEmail);
}

async function getUserAvatar(userId: string) {
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
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
questRoutes.get('/my-quests', requireAuthOrAgentSession, requireLedgerCapableIdentity, noStorePrivate, async (c) => {
  const { avatarId } = c.get('identity');

  const rows = await db
    .select({
      submission: questSubmissions,
      questTitle: quests.title,
      questDescription: quests.description,
      questTier: quests.tier,
      questTokenReward: quests.tokenReward,
      questTitleReward: quests.titleReward,
      questStatus: quests.status,
    })
    .from(questSubmissions)
    .innerJoin(quests, eq(questSubmissions.questId, quests.id))
    .where(eq(questSubmissions.avatarId, avatarId))
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
      titleReward: r.questTitleReward,
      status: r.questStatus,
    },
  }));

  return c.json({ submissions });
});

// ---------------------------------------------------------------------------
// 7. GET /quest-log — Completed quests and rewards earned (auth)
// ---------------------------------------------------------------------------
questRoutes.get('/quest-log', requireAuthOrAgentSession, requireLedgerCapableIdentity, noStorePrivate, async (c) => {
  const { avatarId } = c.get('identity');

  const rows = await db
    .select({
      reward: questRewards,
      questTitle: quests.title,
      questTier: quests.tier,
      questDescription: quests.description,
    })
    .from(questRewards)
    .innerJoin(quests, eq(questRewards.questId, quests.id))
    .where(eq(questRewards.avatarId, avatarId))
    .orderBy(desc(questRewards.claimedAt));

  const rewards = rows.map((r) => ({
    id: r.reward.id,
    questId: r.reward.questId,
    submissionId: r.reward.submissionId,
    tokensAwarded: r.reward.tokensAwarded,
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

  const [quest] = await db
    .insert(quests)
    .values({
      title: data.title,
      description: data.description,
      tier: data.tier,
      tokenReward: data.tokenReward,
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
      avatarName: avatars.name,
      avatarSpecies: avatars.species,
    })
    .from(questSubmissions)
    .innerJoin(quests, eq(questSubmissions.questId, quests.id))
    .innerJoin(avatars, eq(questSubmissions.avatarId, avatars.id))
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
    avatarId: r.submission.avatarId,
    status: r.submission.status,
    prLink: r.submission.prLink,
    submissionNote: r.submission.submissionNote,
    reviewNote: r.submission.reviewNote,
    startedAt: r.submission.startedAt.toISOString(),
    submittedAt: r.submission.submittedAt?.toISOString() ?? null,
    createdAt: r.submission.createdAt.toISOString(),
    questTitle: r.questTitle,
    questTier: r.questTier,
    avatarName: r.avatarName,
    avatarSpecies: r.avatarSpecies,
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
  const now = new Date();

  if (decision === 'approved') {
    // Wrap the entire approval flow in a transaction to prevent double-approval
    // races. The atomic UPDATE ... WHERE status IN (...) RETURNING * ensures
    // only one concurrent request can claim the submission.
    const result = await db.transaction(async (tx) => {
      // 1. Atomically claim the submission — if 0 rows, another request got it
      const [claimed] = await tx
        .update(questSubmissions)
        .set({
          status: 'approved',
          reviewNote: reviewNote ?? null,
          reviewedBy: admin.id,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(questSubmissions.id, submissionId),
            sql`${questSubmissions.status} IN ('submitted', 'in_review')`
          )
        )
        .returning();

      if (!claimed) {
        throw new HTTPException(409, {
          message: 'Submission already reviewed or not found',
        });
      }

      // 2. Atomically CONSUME a completion slot BEFORE any credit (Codex
      // adversarial review 2026-07-13, HIGH #2). The conditional
      // UPDATE ... WHERE under-cap RETURNING both row-locks the quest
      // (serializing concurrent approvals of DIFFERENT submissions) and
      // enforces maxCompletions in the same statement — the old read-then-
      // increment let two approvals of a 1-max quest both read
      // currentCompletions=0 and both pay. 0 rows ⇒ cap already reached ⇒
      // 409, and the tx rollback un-claims the submission (it stays
      // 'submitted' so the admin can reject it instead).
      const [quest] = await tx
        .update(quests)
        .set({
          currentCompletions: sql`COALESCE(${quests.currentCompletions}, 0) + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(quests.id, claimed.questId),
            sql`(${quests.maxCompletions} IS NULL OR COALESCE(${quests.currentCompletions}, 0) < ${quests.maxCompletions})`
          )
        )
        .returning();

      if (!quest) {
        // Distinguish cap-reached from a genuinely missing quest row.
        const [exists] = await tx
          .select({ id: quests.id })
          .from(quests)
          .where(eq(quests.id, claimed.questId))
          .limit(1);
        if (!exists) {
          throw new HTTPException(500, { message: 'Quest not found for submission' });
        }
        throw new HTTPException(409, {
          message:
            'Quest has reached its maximum completions — approve rolled back; reject this submission instead',
        });
      }

      // `quest.currentCompletions` is now the POST-increment value.
      const newCompletions = quest.currentCompletions ?? 1;

      // 3. Award tokens to avatar (within the same transaction)
      await creditClawTokens({
        avatarId: claimed.avatarId,
        amount: quest.tokenReward,
        reason: 'quest_complete',
        source: 'quest',
        metadata: { questId: quest.id, submissionId: claimed.id },
        // Ledger-hook attribution: the ADMIN's approval drove this credit.
        actorKind: 'admin',
      }, tx);

      // 4. Create quest_reward record
      await tx.insert(questRewards).values({
        submissionId,
        avatarId: claimed.avatarId,
        questId: quest.id,
        tokensAwarded: quest.tokenReward,
        titleAwarded: quest.titleReward ?? null,
      });

      // Covenant record — same tx as claim+slot+credit+reward: the approval
      // verdict and its record commit or roll back together. (The credit above
      // additionally emitted its own economy.credit record via the ledger hook.)
      await recordCovenantAction(
        {
          action: 'quest.approve',
          subjectType: 'avatar',
          subjectId: claimed.avatarId,
          actorKind: 'admin',
          payload: {
            questId: quest.id,
            submissionId: claimed.id,
            reviewedByUserId: admin.id,
            tokensAwarded: quest.tokenReward,
            ...(quest.titleReward ? { titleAwarded: quest.titleReward } : {}),
            ...(reviewNote ? { reviewNote } : {}),
          },
        },
        tx,
      );

      // 5. If currentCompletions >= maxCompletions, mark quest as 'completed'
      if (quest.maxCompletions && newCompletions >= quest.maxCompletions) {
        await tx
          .update(quests)
          .set({ status: 'completed', updatedAt: now })
          .where(eq(quests.id, quest.id));
      }

      return {
        tokensAwarded: quest.tokenReward,
        titleAwarded: quest.titleReward ?? null,
        questCompleted:
          quest.maxCompletions != null && newCompletions >= quest.maxCompletions,
      };
    });

    return c.json({
      success: true,
      decision: 'approved',
      ...result,
    });
  } else {
    // Rejected — also use atomic update to prevent double-review. Wrapped in a
    // tx so the covenant record commits with the verdict.
    const claimed = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(questSubmissions)
        .set({
          status: 'rejected',
          reviewNote: reviewNote ?? null,
          reviewedBy: admin.id,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(questSubmissions.id, submissionId),
            sql`${questSubmissions.status} IN ('submitted', 'in_review')`
          )
        )
        .returning();
      if (!row) return undefined;
      await recordCovenantAction(
        {
          action: 'quest.reject',
          subjectType: 'avatar',
          subjectId: row.avatarId,
          actorKind: 'admin',
          payload: {
            questId: row.questId,
            submissionId: row.id,
            reviewedByUserId: admin.id,
            ...(reviewNote ? { reviewNote } : {}),
          },
        },
        tx,
      );
      return row;
    });

    if (!claimed) {
      throw new HTTPException(409, {
        message: 'Submission already reviewed or not found',
      });
    }

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

  return c.json({
    quest: {
      id: quest.id,
      title: quest.title,
      description: quest.description,
      tier: quest.tier,
      status: quest.status,
      tokenReward: quest.tokenReward,
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
questRoutes.post('/:id/accept', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Quest');

  const { avatarId, kind: identityKind } = c.get('identity');

  // Verify quest exists, is active, and has not expired (Codex round 3 —
  // expiry was enforced by the hosted ACCEPT_QUEST action but not here, so
  // behavior differed by surface).
  const [quest] = await db
    .select()
    .from(quests)
    .where(
      and(
        eq(quests.id, id),
        eq(quests.status, 'active'),
        sql`(${quests.expiresAt} IS NULL OR ${quests.expiresAt} > now())`
      )
    )
    .limit(1);

  if (!quest) {
    throw new HTTPException(404, {
      message: 'Quest not found, not active, or expired',
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

  // One submission LINE per (quest, avatar): block when an ACTIVE submission
  // exists, AND when an APPROVED one does (Codex round 3 — re-accepting after
  // approval minted a fresh submission id that could be approved and PAID
  // again; only a REJECTED submission unlocks a retry). The DB layers behind
  // this check: quest_submissions_active_unique (concurrent accepts) and
  // quest_rewards_avatar_quest_unique (one payout per avatar per quest).
  const existingSubmission = await db.query.questSubmissions.findFirst({
    where: and(
      eq(questSubmissions.questId, id),
      eq(questSubmissions.avatarId, avatarId),
      sql`${questSubmissions.status} <> 'rejected'`
    ),
  });

  if (existingSubmission) {
    throw new HTTPException(400, {
      message:
        existingSubmission.status === 'approved'
          ? 'You have already completed this quest'
          : 'You already have an active submission for this quest',
    });
  }

  // The read-then-insert above is advisory UX; the AUTHORITATIVE guard is the
  // partial unique index `quest_submissions_active_unique` (one active
  // submission per quest+avatar — Codex adversarial review 2026-07-13, HIGH
  // #2). A concurrent accept that races past the read collides here (23505)
  // and gets the same 400 the slow path returns.
  let submission;
  try {
    submission = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(questSubmissions)
        .values({
          questId: id,
          avatarId,
          status: 'accepted',
        })
        .returning();
      // Covenant record — same tx: the acceptance commitment and its record
      // commit or roll back together.
      await recordCovenantAction(
        {
          action: 'quest.accept',
          subjectType: 'avatar',
          subjectId: avatarId,
          actorKind: toActorKind(identityKind),
          payload: { questId: id, submissionId: inserted.id },
        },
        tx,
      );
      return inserted;
    });
  } catch (err) {
    const pgCode = (err as { code?: string; cause?: { code?: string } });
    if (pgCode?.code === '23505' || pgCode?.cause?.code === '23505') {
      throw new HTTPException(400, {
        message: 'You already have an active submission for this quest',
      });
    }
    throw err;
  }

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
questRoutes.post('/:id/start', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const id = c.req.param('id'); // quest ID
  validateUuid(id, 'Quest');

  const { avatarId } = c.get('identity');

  // Single compare-and-set (Codex round 2, 2026-07-13): the status predicate
  // lives INSIDE the update's WHERE, so a delayed/stale request can never
  // regress a row that has since moved on (the old read-then-update let a
  // stale start overwrite 'submitted' back to 'in_progress'). The partial
  // unique index guarantees at most one active row matches.
  const [updated] = await db
    .update(questSubmissions)
    .set({ status: 'in_progress', updatedAt: new Date() })
    .where(
      and(
        eq(questSubmissions.questId, id),
        eq(questSubmissions.avatarId, avatarId),
        eq(questSubmissions.status, 'accepted')
      )
    )
    .returning();

  if (!updated) {
    throw new HTTPException(404, {
      message:
        'No accepted submission found for this quest. Accept the quest first.',
    });
  }

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
questRoutes.post('/:id/submit', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
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

  const { avatarId, kind: identityKind } = c.get('identity');

  const now = new Date();

  // Single compare-and-set (Codex round 2, 2026-07-13): the allowed source
  // statuses live INSIDE the update's WHERE. The old read-then-update let two
  // concurrent submits both pass the read, and the delayed one could overwrite
  // a row an admin had ALREADY approved back to 'submitted' — making it
  // approvable (and creditable) a second time. An 'approved'/'rejected' row can
  // now never match; the quest_rewards_submission_unique index is the
  // defense-in-depth behind this.
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(questSubmissions)
      .set({
        status: 'submitted',
        prLink: parsed.data.prLink ?? null,
        submissionNote: parsed.data.submissionNote,
        submittedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(questSubmissions.questId, id),
          eq(questSubmissions.avatarId, avatarId),
          sql`${questSubmissions.status} IN ('accepted', 'in_progress')`
        )
      )
      .returning();
    if (!row) return undefined;
    // Covenant record — same tx as the submit CAS. The note itself lives on
    // the submission row; the record carries its sha256 + length so the claim
    // is bound without duplicating up to 2000 chars into every record.
    await recordCovenantAction(
      {
        action: 'quest.submit',
        subjectType: 'avatar',
        subjectId: avatarId,
        actorKind: toActorKind(identityKind),
        payload: {
          questId: id,
          submissionId: row.id,
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
    throw new HTTPException(404, {
      message:
        'No active submission found for this quest. Accept and start it first.',
    });
  }

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
  const conditions: (ReturnType<typeof eq> | ReturnType<typeof sql>)[] = [
    eq(
      quests.status,
      statusFilter as 'draft' | 'active' | 'completed' | 'archived'
    ),
  ];

  // An 'active' listing must not advertise expired quests (Codex round 3 —
  // they were listable and acceptable here while the hosted action refused
  // them). Other status filters (admin views) keep the full history.
  if (statusFilter === 'active') {
    conditions.push(sql`(${quests.expiresAt} IS NULL OR ${quests.expiresAt} > now())`);
  }

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

// ---------------------------------------------------------------------------
// Q3 plan §2.6 — Tutorial quest claim (CLIENT-tracked, SERVER-credited)
// ---------------------------------------------------------------------------
//
// The 8+ tutorial quests defined in apps/web/src/lib/quests.ts are tracked
// in zustand persist on the client (counters, threshold checks). When the
// client detects completion, it calls this endpoint to settle the token
// reward on the authoritative ledger.
//
// **Trust model (v1):** the SERVER is the source of truth for amounts
// (TUTORIAL_QUEST_REWARDS in @clawville/shared) and idempotency
// (tutorial_quest_claims unique on userId+questId). The CLIENT is trusted
// for the granular threshold check (e.g. "did you walk 200u?"), but the
// SERVER applies a per-quest proof-of-engagement event-log gate so a fresh
// account can't claim all 175 CT instantly. Edge cases of farming are
// bounded by the small per-quest amounts (5–50 CT) and the once-ever cap.
//
// Future tightening: add server-side counters per quest for stricter
// validation. v1 ships the framework; values can be tuned.

const claimTutorialQuestParamSchema = z.object({
  id: z.string().min(1).max(50),
});

/**
 * Per-quest server-side proof-of-engagement check.
 *
 * Returns:
 *   - { ok: true }                                  → user has met the bar
 *   - { ok: false, pending: true,  reason: '...' }  → feature isn't shipped
 *   - { ok: false, pending: false, reason: '...' }  → user hasn't done it yet
 *
 * The route maps `pending` to error code `pending_feature` (so the client
 * knows to render "coming soon" rather than retry forever) vs the standard
 * `engagement_required` for not-yet-completed live quests.
 *
 * Q3 plan §2.6 + 2026-04-29 redesign — extended for the 30-quest ladder.
 */
type EngagementResult = { ok: true } | { ok: false; pending: boolean; reason: string };

async function validateTutorialQuestEngagement(
  userId: string,
  avatarId: string,
  questId: TutorialQuestId,
): Promise<EngagementResult> {
  // Hard-block pending quests — their server emitter doesn't exist yet.
  if (TUTORIAL_QUEST_STATUS[questId] === 'pending') {
    return { ok: false, pending: true, reason: 'feature_not_shipped' };
  }

  async function countEvents(predicate: ReturnType<typeof sql>): Promise<number> {
    const rows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM events
      WHERE (user_id = ${userId} OR avatar_id = ${avatarId})
        AND ${predicate}
    `);
    return Number(rows[0]?.c ?? 0);
  }

  async function distinctTeacherChats(): Promise<number> {
    const rows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(DISTINCT building_id)::int AS c FROM events
      WHERE event_type = 'agent.chat.turn'
        AND payload->>'chatType' IN ('character','building','location')
        AND (user_id = ${userId} OR avatar_id = ${avatarId})
        AND building_id IS NOT NULL
    `);
    return Number(rows[0]?.c ?? 0);
  }

  async function distinctBuildingsVisited(): Promise<number> {
    const rows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(DISTINCT building_id)::int AS c FROM events
      WHERE event_type = 'building.visited'
        AND (user_id = ${userId} OR avatar_id = ${avatarId})
        AND building_id IS NOT NULL
    `);
    return Number(rows[0]?.c ?? 0);
  }

  async function distinctBookBuildings(): Promise<number> {
    const rows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(DISTINCT payload->>'buildingId')::int AS c FROM events
      WHERE event_type = 'item.purchased'
        AND coalesce(payload->>'isBook','') = 'true'
        AND (user_id = ${userId} OR avatar_id = ${avatarId})
        AND payload->>'buildingId' IS NOT NULL
    `);
    return Number(rows[0]?.c ?? 0);
  }

  async function distinctActivityTypes(): Promise<number> {
    const rows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(DISTINCT payload->>'activityType')::int AS c FROM events
      WHERE event_type = 'activity.match.placed'
        AND (user_id = ${userId} OR avatar_id = ${avatarId})
        AND coalesce(payload->>'subjectType','') <> 'bot'
        AND payload->>'activityType' IS NOT NULL
    `);
    return Number(rows[0]?.c ?? 0);
  }

  const ok = (): EngagementResult => ({ ok: true });
  const fail = (reason: string): EngagementResult => ({ ok: false, pending: false, reason });

  switch (questId) {
    // ── TIER 1 ────────────────────────────────────────────────────────
    case 'say-hi-nori':
      return (await countEvents(
        sql`event_type = 'agent.chat.turn' AND payload->>'chatType' = 'system-agent'`,
      )) >= 1 ? ok() : fail('no_system_chats');

    case 'meet-your-agent':
      return (await countEvents(
        sql`event_type = 'agent.chat.turn' AND payload->>'chatType' = 'avatar'`,
      )) >= 1 ? ok() : fail('no_avatar_chats');

    case 'first-steps':
      return (await countEvents(sql`event_type = 'building.visited'`)) >= 1
        ? ok()
        : fail('no_building_visits');

    // ── TIER 2 ────────────────────────────────────────────────────────
    case 'town-briefing':
      return (await countEvents(
        sql`event_type = 'agent.chat.turn' AND payload->>'chatType' = 'system-agent'`,
      )) >= 3 ? ok() : fail('insufficient_system_chats');

    case 'bonded':
      return (await countEvents(
        sql`event_type = 'agent.chat.turn' AND payload->>'chatType' = 'avatar'`,
      )) >= 5 ? ok() : fail('insufficient_avatar_chats');

    case 'door-knocker': {
      const visits = await countEvents(sql`event_type = 'building.visited'`);
      const teacherChats = await countEvents(
        sql`event_type = 'agent.chat.turn'
            AND payload->>'chatType' IN ('character','building','location')`,
      );
      return visits >= 1 && teacherChats >= 1 ? ok() : fail('compound_unmet');
    }

    // ── TIER 3 ────────────────────────────────────────────────────────
    case 'town-tour': {
      const distinctVisits = await distinctBuildingsVisited();
      const distinctTeachers = await distinctTeacherChats();
      return distinctVisits >= 3 && distinctTeachers >= 2 ? ok() : fail('compound_unmet');
    }

    case 'star-pupil':
      return (await distinctTeacherChats()) >= 5 ? ok() : fail('insufficient_distinct_teachers');

    case 'cartographer':
      return (await distinctBuildingsVisited()) >= 10
        ? ok()
        : fail('insufficient_distinct_buildings');

    // ── TIER 4 ────────────────────────────────────────────────────────
    case 'shop-and-study': {
      const bought = await countEvents(
        sql`event_type = 'item.purchased' AND coalesce(payload->>'isBook','') = 'true'`,
      );
      const learned = await countEvents(sql`event_type = 'book.read'`);
      return bought >= 1 && learned >= 1 ? ok() : fail('compound_unmet');
    }

    case 'inventory-in-action': {
      const bought = await countEvents(sql`event_type = 'item.purchased'`);
      const used = await countEvents(
        sql`event_type IN ('book.read','cosmetic.equipped')`,
      );
      return bought >= 1 && used >= 1 ? ok() : fail('compound_unmet');
    }

    case 'library-card': {
      const buildings = await distinctBookBuildings();
      const learned = await countEvents(sql`event_type = 'book.read'`);
      return buildings >= 3 && learned >= 3 ? ok() : fail('compound_unmet');
    }

    case 'polymath':
      return (await countEvents(sql`event_type = 'book.read'`)) >= 10
        ? ok()
        : fail('insufficient_knowledge');

    // ── TIER 5 ────────────────────────────────────────────────────────
    case 'first-match':
      return (await countEvents(
        sql`event_type = 'activity.match.placed'
            AND coalesce(payload->>'subjectType','') <> 'bot'`,
      )) >= 1 ? ok() : fail('no_matches');

    case 'game-day': {
      const distinctTeachers = await distinctTeacherChats();
      const matches = await countEvents(
        sql`event_type = 'activity.match.placed'
            AND coalesce(payload->>'subjectType','') <> 'bot'`,
      );
      return distinctTeachers >= 2 && matches >= 1 ? ok() : fail('compound_unmet');
    }

    case 'reef-veteran':
      return (await distinctActivityTypes()) >= 2 ? ok() : fail('insufficient_activity_types');

    case 'first-victory':
      return (await countEvents(
        sql`event_type = 'activity.match.placed'
            AND payload->>'placement' = '1'
            AND coalesce(payload->>'subjectType','') <> 'bot'`,
      )) >= 1 ? ok() : fail('no_wins');

    case 'match-maker': {
      const matches = await countEvents(
        sql`event_type = 'activity.match.placed'
            AND coalesce(payload->>'subjectType','') <> 'bot'`,
      );
      const wins = await countEvents(
        sql`event_type = 'activity.match.placed'
            AND payload->>'placement' = '1'
            AND coalesce(payload->>'subjectType','') <> 'bot'`,
      );
      return matches >= 5 && wins >= 1 ? ok() : fail('compound_unmet');
    }

    // ── TIER 6 ────────────────────────────────────────────────────────
    case 'bot-master':
      return (await countEvents(sql`event_type = 'agent.connected'`)) >= 1
        ? ok()
        : fail('no_bot_connection');

    case 'open-house': {
      const connected = await countEvents(sql`event_type = 'agent.connected'`);
      // Bot teacher chats: chatType in (character/building/location)
      // emitted by the agent gateway when an OpenClaw bot speaks. We
      // count distinct buildings here.
      const botChatRows = await db.execute<{ c: number }>(sql`
        SELECT COUNT(DISTINCT building_id)::int AS c FROM events
        WHERE event_type IN ('agent.chat.turn','agent.collaboration.turn')
          AND payload->>'chatType' IN ('character','building','location')
          AND (user_id = ${userId} OR avatar_id = ${avatarId})
          AND building_id IS NOT NULL
      `);
      const distinctBotTeachers = Number(botChatRows[0]?.c ?? 0);
      const matches = await countEvents(
        sql`event_type = 'activity.match.placed'`,
      );
      return connected >= 1 && distinctBotTeachers >= 2 && matches >= 1
        ? ok()
        : fail('compound_unmet');
    }

    // ── TIER 7 ────────────────────────────────────────────────────────
    case 'on-the-board':
      // "Has any leaderboard-scoring event" — any chat / match / building
      // visit / skill_md fetch counts.
      return (await countEvents(
        sql`event_type IN ('agent.chat.turn','agent.collaboration.turn',
                           'building.visited','skill_md.fetched',
                           'activity.match.placed')`,
      )) >= 1 ? ok() : fail('no_scoring_events');

    case 'top-100': {
      // Compute the avatar's current rank in the agents leaderboard (24h
      // window) and check against threshold 100. This is a heavy SQL
      // path — leaderboard.ts already snapshot-caches similar; for
      // tutorial gating we recompute on-demand (per claim, infrequent).
      const rankRows = await db.execute<{ rank: number }>(sql`
        WITH events_window AS (
          SELECT avatar_id FROM events
          WHERE ts > NOW() - INTERVAL '24 hours'
            AND avatar_id IS NOT NULL
        ),
        ranked AS (
          SELECT avatar_id,
                 ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS rank
          FROM events_window
          GROUP BY avatar_id
        )
        SELECT rank::int FROM ranked WHERE avatar_id = ${avatarId}
      `);
      const rank = Number(rankRows[0]?.rank ?? 9999);
      return rank > 0 && rank <= 100 ? ok() : fail('rank_too_low');
    }

    case 'building-champion': {
      // Avatar is the top-visited subject for any single building (24h).
      const rows = await db.execute<{ matched: number }>(sql`
        WITH per_building AS (
          SELECT building_id, avatar_id, COUNT(*) AS visits
          FROM events
          WHERE event_type = 'building.visited'
            AND ts > NOW() - INTERVAL '24 hours'
            AND building_id IS NOT NULL
            AND avatar_id IS NOT NULL
          GROUP BY building_id, avatar_id
        ),
        winners AS (
          SELECT building_id, avatar_id,
                 ROW_NUMBER() OVER (PARTITION BY building_id ORDER BY visits DESC) AS rk
          FROM per_building
        )
        SELECT COUNT(*)::int AS matched FROM winners
        WHERE rk = 1 AND avatar_id = ${avatarId}
      `);
      return Number(rows[0]?.matched ?? 0) >= 1 ? ok() : fail('not_top_visitor');
    }

    // ── TIER 8 ────────────────────────────────────────────────────────
    case 'crossover':
      return (await countEvents(
        sql`event_type IN ('portal.scape.crossed','portal.scape.linked')`,
      )) >= 1 ? ok() : fail('no_portal_cross');

    // ── TIER 9 ────────────────────────────────────────────────────────
    case 'full-house': {
      const distinctVisits = await distinctBuildingsVisited();
      const distinctTeachers = await distinctTeacherChats();
      const booksBought = await countEvents(
        sql`event_type = 'item.purchased' AND coalesce(payload->>'isBook','') = 'true'`,
      );
      const learned = await countEvents(sql`event_type = 'book.read'`);
      return distinctVisits >= 10 &&
        distinctTeachers >= 10 &&
        booksBought >= 5 &&
        learned >= 5
        ? ok()
        : fail('compound_unmet');
    }

    case 'elite-trainer': {
      const connected = await countEvents(sql`event_type = 'agent.connected'`);
      const wins = await countEvents(
        sql`event_type = 'activity.match.placed'
            AND payload->>'placement' = '1'
            AND coalesce(payload->>'subjectType','') <> 'bot'`,
      );
      const learned = await countEvents(sql`event_type = 'book.read'`);
      // Reuse top-100 rank check.
      const rankRows = await db.execute<{ rank: number }>(sql`
        WITH events_window AS (
          SELECT avatar_id FROM events
          WHERE ts > NOW() - INTERVAL '24 hours'
            AND avatar_id IS NOT NULL
        ),
        ranked AS (
          SELECT avatar_id,
                 ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS rank
          FROM events_window
          GROUP BY avatar_id
        )
        SELECT rank::int FROM ranked WHERE avatar_id = ${avatarId}
      `);
      const rank = Number(rankRows[0]?.rank ?? 9999);
      return connected >= 1 && wins >= 3 && learned >= 10 && rank > 0 && rank <= 100
        ? ok()
        : fail('compound_unmet');
    }

    // Pending quests (style-statement, big-spender, wallet-aware,
    // brand-ambassador) get short-circuited at the top of the function
    // to `pending_feature`. They land here only via the type union; we
    // double-gate as pending so a future un-pending without a case
    // doesn't accidentally credit.
    case 'style-statement':
    case 'big-spender':
    case 'wallet-aware':
    case 'brand-ambassador':
      return { ok: false, pending: true, reason: 'feature_not_shipped' };
  }
}

questRoutes.post('/tutorial/:id/claim', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };

  const parsed = claimTutorialQuestParamSchema.safeParse({ id: c.req.param('id') });
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid quest id' });
  }
  const questId = parsed.data.id;

  const reward = getTutorialQuestReward(questId);
  if (reward === null) {
    throw new HTTPException(404, { message: 'Unknown tutorial quest' });
  }

  // Audit-fix 2026-04-29 — block guest accounts. Each guest signup creates
  // a fresh `userId`, and the idempotency key is `(userId, questId)`. Without
  // this guard a guest could mint the full ~175 CT tutorial reward, then
  // re-signup and farm again. Brand carve-out (Brand Identity §"guest mode"):
  // guests can play, queue activities, and chat with NPCs — but tutorial
  // rewards require a real account so progress is tied to a stable identity.
  const userRow = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: { isGuest: true },
  });
  if (userRow?.isGuest) {
    return c.json(
      {
        ok: false,
        error: 'guest_not_eligible',
        message:
          'Sign up to claim tutorial rewards. Guest play earns vCLAW through activity matches; tutorial-quest rewards are reserved for real accounts.',
        credited: 0,
        balance: 0,
      },
      403,
    );
  }

  const avatar = await getUserAvatar(user.id);

  // Idempotency: pre-check (cheap path) — unique index is the source of
  // truth, this just avoids running the full validator + transaction when
  // we know it'll fail.
  const existingClaim = await db.query.tutorialQuestClaims.findFirst({
    where: and(
      eq(tutorialQuestClaims.userId, user.id),
      eq(tutorialQuestClaims.questId, questId),
    ),
  });
  if (existingClaim) {
    return c.json(
      {
        ok: false,
        error: 'already_claimed',
        message: 'This tutorial quest has already been claimed.',
        credited: 0,
        balance: avatar.clawTokens,
      },
      409,
    );
  }

  // Engagement gate — server-side proof that the user actually played.
  const validation = await validateTutorialQuestEngagement(
    user.id,
    avatar.id,
    questId as TutorialQuestId,
  );
  if (!validation.ok) {
    return c.json(
      {
        ok: false,
        error: validation.pending ? 'pending_feature' : 'engagement_required',
        reason: validation.reason,
        message: validation.pending
          ? 'This quest is for an upcoming feature — claim opens once the backend ships.'
          : 'Server cannot verify completion yet — keep playing and try again.',
        credited: 0,
        balance: avatar.clawTokens,
      },
      400,
    );
  }

  // Atomic credit + claim insert. Unique index on (user_id, quest_id)
  // serves as the authoritative idempotency barrier — a concurrent
  // double-claim still rolls back at INSERT time.
  try {
    const result = await db.transaction(async (tx) => {
      const ledger = await creditClawTokens(
        {
          avatarId: avatar.id,
          amount: reward,
          reason: 'tutorial_quest', // Q3 plan §0 L6 locked decision
          source: 'quest',
          metadata: { questId, tutorial: true },
        },
        tx,
      );

      await tx.insert(tutorialQuestClaims).values({
        userId: user.id,
        avatarId: avatar.id,
        questId,
        tokensCredited: reward,
        ledgerId: ledger.ledgerId,
      });

      return ledger;
    });

    // Fire-and-forget event for analytics. Uses logEventFromContext so the
    // anti-farm fp_hash + ip_prefix_hash get persisted.
    void logEventFromContext(c, {
      eventType: 'tutorial_quest.claimed',
      userId: user.id,
      avatarId: avatar.id,
      payload: { questId, tokensCredited: reward, ledgerId: result.ledgerId },
    });

    return c.json({
      ok: true,
      questId,
      credited: reward,
      balance: result.balanceAfter,
    });
  } catch (err) {
    // Unique-violation race — another concurrent request beat us to the
    // insert. Same shape as the pre-check 409 so the client can treat
    // both branches identically.
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      const refreshed = await db.query.avatars.findFirst({
        where: eq(avatars.id, avatar.id),
      });
      return c.json(
        {
          ok: false,
          error: 'already_claimed',
          message: 'This tutorial quest has already been claimed (race).',
          credited: 0,
          balance: refreshed?.clawTokens ?? avatar.clawTokens,
        },
        409,
      );
    }
    throw err;
  }
});

// Quest-board restore (2026-07-29 prod incident): the tutorial ladder's
// completion DISPLAY lives in client localStorage and is wiped by the
// auth-transition identity sweep on session expiry / account switch — but
// every claimed quest already has a durable tutorial_quest_claims row. This
// read-back lets the SAME account re-mark its claimed quests as completed
// after login, restoring the quest board. Human-only (`requireAuth`) by the
// same design as the claim write above (the tutorial ladder is the human
// onboarding surface); guest accounts have no claim rows and receive an
// empty list. Read-only — no ledger or economy mutation.
questRoutes.get('/tutorial/claims', requireAuth, noStorePrivate, async (c) => {
  const user = c.get('user') as { id: string };
  const rows = await db.query.tutorialQuestClaims.findMany({
    where: eq(tutorialQuestClaims.userId, user.id),
    columns: { questId: true, tokensCredited: true, claimedAt: true },
  });
  return c.json({
    ok: true,
    claims: rows.map((r) => ({
      questId: r.questId,
      tokensCredited: r.tokensCredited,
      claimedAt: r.claimedAt.toISOString(),
    })),
  });
});
