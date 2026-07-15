import type { Action, ActionResult } from './types';
import { hasServices, getMessageText, getParam , getDbModule } from './types';

/**
 * CLAIM_BOUNTY — claim an open bounty and create an attempt record.
 *
 * Parameters:
 *   bountyId — UUID of the bounty to claim
 */
export const claimBountyAction: Action = {
  name: 'CLAIM_BOUNTY',
  description: 'Claim an open bounty and start working toward its reward.',
  similes: [
    'TAKE_BOUNTY',
    'START_BOUNTY',
    'HUNT_BOUNTY',
    'ACCEPT_BOUNTY',
  ],

  parameters: [
    {
      name: 'bountyId',
      description: 'The UUID of the bounty to claim.',
      required: true,
      schema: { type: 'string' },
    },
  ],

  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Claim that bounty', action: 'CLAIM_BOUNTY' },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: { text: 'I want to hunt this bounty', action: 'CLAIM_BOUNTY' },
      },
    ],
  ],

  async validate(_runtime: any, message: any, _state?: any): Promise<boolean> {
    const text = getMessageText(message).toLowerCase();
    const triggers = ['bounty', 'claim', 'hunt', 'take bounty'];
    return triggers.some((t) => text.includes(t));
  },

  async handler(
    _runtime: any,
    message: any,
    state?: any,
    _options?: any,
    _callback?: any,
  ): Promise<ActionResult> {
    try {
      if (!hasServices(state)) {
        return { success: false, text: 'Service layer not available' };
      }

      const { avatarId, services } = state;
      const { db } = services;

      const bountyId = getParam(message, 'bountyId');
      if (!bountyId) {
        return {
          success: false,
          text: 'Please specify a bounty ID to claim.',
        };
      }

      const { bounties, bountyAttempts, eq, and } = await getDbModule();

      // 1. Find the bounty
      const [bounty] = await db
        .select({
          id: bounties.id,
          title: bounties.title,
          description: bounties.description,
          requirements: bounties.requirements,
          difficulty: bounties.difficulty,
          status: bounties.status,
          tokenReward: bounties.tokenReward,
          maxAttempts: bounties.maxAttempts,
          currentAttempts: bounties.currentAttempts,
          tags: bounties.tags,
          expiresAt: bounties.expiresAt,
          creatorId: bounties.creatorId,
        })
        .from(bounties)
        .where(eq(bounties.id, bountyId))
        .limit(1);

      if (!bounty) {
        return { success: false, text: 'Bounty not found.' };
      }

      if (bounty.status !== 'open') {
        return {
          success: false,
          text: `This bounty is not open (status: ${bounty.status}).`,
        };
      }

      // Cannot claim your own bounty
      if (bounty.creatorId === avatarId) {
        return { success: false, text: 'You cannot claim your own bounty.' };
      }

      // Check expiry
      if (bounty.expiresAt && new Date(bounty.expiresAt) < new Date()) {
        return { success: false, text: 'This bounty has expired.' };
      }

      // 2. Check max attempts
      if (bounty.currentAttempts >= bounty.maxAttempts) {
        return {
          success: false,
          text: 'This bounty has reached its maximum number of attempts.',
        };
      }

      // 3. Check if this avatar already has an active attempt
      const [existingAttempt] = await db
        .select({ id: bountyAttempts.id, status: bountyAttempts.status })
        .from(bountyAttempts)
        .where(
          and(
            eq(bountyAttempts.bountyId, bountyId),
            eq(bountyAttempts.hunterId, avatarId),
          ),
        )
        .limit(1);

      if (existingAttempt) {
        const terminalStatuses = ['approved', 'rejected', 'abandoned'];
        if (!terminalStatuses.includes(existingAttempt.status)) {
          return {
            success: false,
            text: `You already have an active attempt on this bounty (status: ${existingAttempt.status}).`,
          };
        }
      }

      // 4/5. Create the attempt, advance the bounty, and append the covenant
      // record atomically. The injected adapter pre-binds actorKind='agent'.
      // Older/bespoke service constructors may omit the recorder; the business
      // action remains backward-compatible and commits recordless in that case.
      const record = services.recordCovenantAction;
      const attempt = await db.transaction(async (tx: typeof db) => {
        const [inserted] = await tx
          .insert(bountyAttempts)
          .values({
            bountyId,
            hunterId: avatarId,
            status: 'claimed',
          })
          .returning({ id: bountyAttempts.id });

        await tx
          .update(bounties)
          .set({
            currentAttempts: bounty.currentAttempts + 1,
            status:
              bounty.currentAttempts + 1 >= bounty.maxAttempts
                ? 'in_progress'
                : 'open',
            updatedAt: new Date(),
          })
          .where(eq(bounties.id, bountyId));

        if (record) {
          await record(
            {
              action: 'bounty.claim',
              subjectType: 'avatar',
              subjectId: avatarId,
              payload: { bountyId, attemptId: inserted.id },
            },
            tx,
          );
        }
        return inserted;
      });

      const difficultyLabel =
        bounty.difficulty.charAt(0).toUpperCase() +
        bounty.difficulty.slice(1);

      return {
        success: true,
        text: [
          `Bounty claimed: **${bounty.title}** (${difficultyLabel})`,
          '',
          bounty.description,
          bounty.requirements
            ? `\nRequirements: ${bounty.requirements}`
            : '',
          '',
          `Reward: ${bounty.tokenReward} vCLAW`,
          bounty.tags && bounty.tags.length > 0
            ? `Tags: ${bounty.tags.join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        data: {
          bountyId: bounty.id,
          attemptId: attempt.id,
          title: bounty.title,
          difficulty: bounty.difficulty,
          tokenReward: bounty.tokenReward,
          tags: bounty.tags,
        },
      };
    } catch (error: any) {
      return { success: false, text: error.message ?? 'Failed to claim bounty' };
    }
  },

  suppressPostActionContinuation: false,
};
