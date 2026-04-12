import type { Action, ActionResult } from './types';
import { hasServices, getMessageText } from './types';

/**
 * CHECK_BALANCE — query the pet's NeoToken balance, inventory count,
 * and knowledge count.
 *
 * Parameters: none
 */
export const checkBalanceAction: Action = {
  name: 'CHECK_BALANCE',
  description:
    'Check your NeoToken balance, inventory count, and knowledge count.',
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
      'my nt',
      'neotoken',
      'neo token',
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

      const { petId, services } = state;
      const { db } = services;

      const { pets, petInventory, eq, sql } = await import('@clawville/database');

      // Get pet data
      const [pet] = await db
        .select({
          name: pets.name,
          neoTokens: pets.neoTokens,
          level: pets.level,
          xp: pets.xp,
          characterConfig: pets.characterConfig,
        })
        .from(pets)
        .where(eq(pets.id, petId))
        .limit(1);

      if (!pet) {
        return { success: false, text: 'Pet not found.' };
      }

      // Count inventory items
      const [inventoryResult] = await db
        .select({
          totalItems: sql<number>`COALESCE(SUM(${petInventory.quantity}), 0)`,
          uniqueItems: sql<number>`COUNT(*)`,
        })
        .from(petInventory)
        .where(eq(petInventory.petId, petId));

      const totalItems = Number(inventoryResult?.totalItems ?? 0);
      const uniqueItems = Number(inventoryResult?.uniqueItems ?? 0);
      const knowledgeCount = pet.characterConfig?.knowledge?.length ?? 0;

      return {
        success: true,
        text: [
          `**${pet.name}'s Status**`,
          `Level: ${pet.level} (${pet.xp} XP)`,
          `NeoTokens: ${pet.neoTokens} NT`,
          `Inventory: ${totalItems} items (${uniqueItems} unique)`,
          `Knowledge: ${knowledgeCount} entries`,
        ].join('\n'),
        data: {
          neoTokens: pet.neoTokens,
          level: pet.level,
          xp: pet.xp,
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
