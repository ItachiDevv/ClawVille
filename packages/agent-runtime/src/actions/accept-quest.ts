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

      const { quests, questSubmissions, eq, and } = await getDbModule();

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

      // 2. Check if avatar already has an active submission for this quest
      const [existingSubmission] = await db
        .select({ id: questSubmissions.id, status: questSubmissions.status })
        .from(questSubmissions)
        .where(
          and(
            eq(questSubmissions.questId, questId),
            eq(questSubmissions.avatarId, avatarId),
          ),
        )
        .limit(1);

      if (existingSubmission) {
        const terminalStatuses = ['approved', 'rejected'];
        if (!terminalStatuses.includes(existingSubmission.status)) {
          return {
            success: false,
            text: `You already have an active submission for this quest (status: ${existingSubmission.status}).`,
          };
        }
      }

      // 3. Create submission
      const [submission] = await db
        .insert(questSubmissions)
        .values({
          questId,
          avatarId,
          status: 'accepted',
        })
        .returning({ id: questSubmissions.id });

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
