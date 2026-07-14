import type { Action, ActionResult } from './types';
import { hasServices, getMessageText, getParam , getDbModule } from './types';

/**
 * ACCEPT_QUEST — accept an active quest and create a submission record.
 *
 * Parameters:
 *   questId — UUID of the quest to accept
 */
export const acceptQuestAction: Action = {
  name: 'ACCEPT_QUEST',
  description:
    'Accept an active quest and begin working toward its completion.',
  similes: [
    'TAKE_QUEST',
    'START_QUEST',
    'JOIN_QUEST',
    'ACCEPT_MISSION',
    'TAKE_ON',
  ],

  parameters: [
    {
      name: 'questId',
      description: 'The UUID of the quest to accept.',
      required: true,
      schema: { type: 'string' },
    },
  ],

  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Accept the quest', action: 'ACCEPT_QUEST' },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: { text: 'I want to take on this mission', action: 'ACCEPT_QUEST' },
      },
    ],
  ],

  async validate(_runtime: any, message: any, _state?: any): Promise<boolean> {
    // Structured invocation path (executeAction builds a synthetic message
    // with EMPTY text but real parameters — Codex round 4, same fix as
    // SUBMIT_QUEST): a present questId param IS the intent signal; trigger
    // words remain the natural-language fallback.
    if (getParam(message, 'questId')) return true;
    const text = getMessageText(message).toLowerCase();
    const triggers = [
      'quest',
      'accept',
      'take on',
      'mission',
      'start quest',
      'join quest',
    ];
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

      const questId = getParam(message, 'questId');
      if (!questId) {
        return {
          success: false,
          text: 'Please specify a quest ID to accept.',
        };
      }

      const { quests, questSubmissions, avatars, users, eq, and } = await getDbModule();

      // Canonical identity gate (Codex round 5, fail-closed at the choke
      // point regardless of which runtime/caller injected the state):
      // `state.avatarId` must resolve to a REAL `avatars.id` (a caller that
      // wrongly supplies e.g. an openclaw_bots.id fails HERE, honestly,
      // instead of writing a mismatched row), and the avatar's OWNER must not
      // be a guest (quest rewards pay real vCLAW after review — the guest
      // demo-economy wall applies to every earning surface).
      const [actor] = await db
        .select({ id: avatars.id, isGuest: users.isGuest })
        .from(avatars)
        .innerJoin(users, eq(users.id, avatars.userId))
        .where(eq(avatars.id, avatarId))
        .limit(1);
      if (!actor) {
        return {
          success: false,
          text: 'quest_actor_unresolved: this runtime is not bound to a real avatar, so it cannot use the quest board.',
        };
      }
      if (actor.isGuest) {
        return {
          success: false,
          text: 'Guests run a demo economy — quest rewards pay real vCLAW, so the quest board needs a full account.',
        };
      }

      // 1. Find the quest
      const [quest] = await db
        .select({
          id: quests.id,
          title: quests.title,
          description: quests.description,
          tier: quests.tier,
          status: quests.status,
          tokenReward: quests.tokenReward,
          titleReward: quests.titleReward,
          requirements: quests.requirements,
          maxCompletions: quests.maxCompletions,
          currentCompletions: quests.currentCompletions,
          expiresAt: quests.expiresAt,
        })
        .from(quests)
        .where(eq(quests.id, questId))
        .limit(1);

      if (!quest) {
        return { success: false, text: 'Quest not found.' };
      }

      if (quest.status !== 'active') {
        return {
          success: false,
          text: `This quest is not active (status: ${quest.status}).`,
        };
      }

      // Check expiry
      if (quest.expiresAt && new Date(quest.expiresAt) < new Date()) {
        return { success: false, text: 'This quest has expired.' };
      }

      // Check max completions
      if (
        quest.maxCompletions != null &&
        quest.currentCompletions != null &&
        quest.currentCompletions >= quest.maxCompletions
      ) {
        return {
          success: false,
          text: 'This quest has reached its maximum number of completions.',
        };
      }

      // 2. One submission LINE per (quest, avatar): an ACTIVE submission
      // blocks, and an APPROVED one blocks PERMANENTLY (Codex round 3 —
      // re-accepting after approval minted a new payable submission; only a
      // rejection unlocks a retry). Scan ALL rows, not the first — a rejected
      // row must not mask an approved one. Mirrors the REST accept route;
      // DB backstops: quest_submissions_active_unique +
      // quest_rewards_avatar_quest_unique.
      const existingSubmissions = await db
        .select({ id: questSubmissions.id, status: questSubmissions.status })
        .from(questSubmissions)
        .where(
          and(
            eq(questSubmissions.questId, questId),
            eq(questSubmissions.avatarId, avatarId),
          ),
        );

      for (const existing of existingSubmissions) {
        if (existing.status === 'approved') {
          return {
            success: false,
            text: 'You have already completed this quest.',
          };
        }
        if (existing.status !== 'rejected') {
          return {
            success: false,
            text: `You already have an active submission for this quest (status: ${existing.status}).`,
          };
        }
      }

      // 3. Create submission (+ covenant record in the same tx when the
      // injected recorder is present — the acceptance commitment and its
      // stream record commit or roll back together; see runtime-services-
      // adapter.ts, which pre-binds the surface's actor kind).
      const record = services.recordCovenantAction;
      const [submission] = await db.transaction(async (tx: any) => {
        const inserted = await tx
          .insert(questSubmissions)
          .values({
            questId,
            avatarId,
            status: 'accepted',
          })
          .returning({ id: questSubmissions.id });
        if (record) {
          await record(
            {
              action: 'quest.accept',
              subjectType: 'avatar',
              subjectId: avatarId,
              payload: { questId, submissionId: inserted[0].id },
            },
            tx,
          );
        }
        return inserted;
      });

      const tierLabel =
        quest.tier === 'legendary'
          ? 'Legendary'
          : quest.tier === 'main_quest'
            ? 'Main Quest'
            : 'Side Quest';

      return {
        success: true,
        text: [
          `Quest accepted: **${quest.title}** (${tierLabel})`,
          '',
          quest.description,
          quest.requirements ? `\nRequirements: ${quest.requirements}` : '',
          '',
          `Reward: ${quest.tokenReward} vCLAW${quest.titleReward ? ` + title "${quest.titleReward}"` : ''}`,
        ]
          .filter((l) => l !== undefined)
          .join('\n'),
        data: {
          questId: quest.id,
          submissionId: submission.id,
          title: quest.title,
          tier: quest.tier,
          tokenReward: quest.tokenReward,
          titleReward: quest.titleReward,
        },
      };
    } catch (error: any) {
      return { success: false, text: error.message ?? 'Failed to accept quest' };
    }
  },

  suppressPostActionContinuation: false,
};
