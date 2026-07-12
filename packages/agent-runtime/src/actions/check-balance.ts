import type { Action, ActionResult } from './types';
import { hasServices, getMessageText, getDbModule } from './types';

/**
 * CHECK_BALANCE — query the avatar's ClawToken balance, inventory count,
 * and knowledge count.
 *
 * Parameters: none
 */
export const checkBalanceAction: Action = {
  name: 'CHECK_BALANCE',
  description:
    'Check your vCLAW balance, inventory count, and knowledge count.',
  similes: [
    'VIEW_BALANCE',
    'MY_TOKENS',
    'WALLET',
    'HOW_MUCH',
    'SHOW_BALANCE',
    'MY_INVENTORY',
  ],

  parameters: [],

  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'How many tokens do I have?', action: 'CHECK_BALANCE' },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: { text: 'Check my balance', action: 'CHECK_BALANCE' },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: { text: "What's in my wallet?", action: 'CHECK_BALANCE' },
      },
    ],
  ],

  async validate(_runtime: any, message: any, _state?: any): Promise<boolean> {
    const text = getMessageText(message).toLowerCase();
    const triggers = [
      'balance',
      'tokens',
      'how much',
      'wallet',
      'inventory',
      'how many',
      'clawtoken',
      'claw token',
    ];
    return triggers.some((t) => text.includes(t));
  },

  async handler(
    _runtime: any,
    _message: any,
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

      const { avatars, avatarInventory, eq, sql } = await getDbModule();

      // Get avatar data
      const [avatar] = await db
        .select({
          name: avatars.name,
          clawTokens: avatars.clawTokens,
          level: avatars.level,
          xp: avatars.xp,
          characterConfig: avatars.characterConfig,
        })
        .from(avatars)
        .where(eq(avatars.id, avatarId))
        .limit(1);

      if (!avatar) {
        return { success: false, text: 'Avatar not found.' };
      }

      // Count inventory items
      const [inventoryResult] = await db
        .select({
          totalItems: sql<number>`COALESCE(SUM(${avatarInventory.quantity}), 0)`,
          uniqueItems: sql<number>`COUNT(*)`,
        })
        .from(avatarInventory)
        .where(eq(avatarInventory.avatarId, avatarId));

      const totalItems = Number(inventoryResult?.totalItems ?? 0);
      const uniqueItems = Number(inventoryResult?.uniqueItems ?? 0);
      const knowledgeCount = avatar.characterConfig?.knowledge?.length ?? 0;

      return {
        success: true,
        text: [
          `**${avatar.name}'s Status**`,
          `Level: ${avatar.level} (${avatar.xp} XP)`,
          `vCLAW: ${avatar.clawTokens}`,
          `Inventory: ${totalItems} items (${uniqueItems} unique)`,
          `Knowledge: ${knowledgeCount} entries`,
        ].join('\n'),
        data: {
          clawTokens: avatar.clawTokens,
          level: avatar.level,
          xp: avatar.xp,
          inventoryTotal: totalItems,
          inventoryUnique: uniqueItems,
          knowledgeCount,
        },
      };
    } catch (error: any) {
      return { success: false, text: error.message ?? 'Failed to check balance' };
    }
  },

  suppressPostActionContinuation: false,
};
