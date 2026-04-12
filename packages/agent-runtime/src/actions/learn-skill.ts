import { KNOWLEDGE_BOOKS, getBookById } from '@clawville/shared';
import type { Action, ActionResult } from './types';
import { hasServices, getMessageText, getParam , getDbModule } from './types';

/**
 * LEARN_SKILL — read a knowledge book from inventory and absorb its entries
 * into the avatar's characterConfig.knowledge[].
 *
 * Parameters:
 *   itemId — the book ID in the avatar's inventory
 */
export const learnSkillAction: Action = {
  name: 'LEARN_SKILL',
  description:
    'Read a knowledge book from your inventory and absorb its knowledge entries.',
  similes: [
    'READ_BOOK',
    'STUDY',
    'LEARN_FROM_BOOK',
    'ABSORB_KNOWLEDGE',
    'READ_TO_PET',
  ],

  parameters: [
    {
      name: 'itemId',
      description: 'The ID of the inventory book to learn from.',
      required: true,
      schema: {
        type: 'string',
        enum: KNOWLEDGE_BOOKS.map((b) => b.id),
      },
    },
  ],

  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Learn from the Webhook Patterns book', action: 'LEARN_SKILL' },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: { text: 'Read the Cron Scheduling 101 to my avatar', action: 'LEARN_SKILL' },
      },
    ],
  ],

  async validate(_runtime: any, message: any, _state?: any): Promise<boolean> {
    const text = getMessageText(message).toLowerCase();
    const triggers = ['learn', 'read', 'study', 'absorb', 'read to avatar'];
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

      // Resolve itemId
      let itemId = getParam(message, 'itemId');

      if (!itemId) {
        const text = getMessageText(message).toLowerCase();
        for (const book of KNOWLEDGE_BOOKS) {
          if (
            text.includes(book.id) ||
            text.includes(book.name.toLowerCase())
          ) {
            itemId = book.id;
            break;
          }
        }
      }

      if (!itemId) {
        return {
          success: false,
          text: 'Could not determine which book to learn from. Please specify a book name or ID.',
        };
      }

      const book = getBookById(itemId);
      if (!book) {
        return { success: false, text: `Book "${itemId}" not found.` };
      }

      const { avatarInventory, avatars, eq, and } = await getDbModule();

      // Check inventory
      const [inventoryItem] = await db
        .select({ id: avatarInventory.id, quantity: avatarInventory.quantity })
        .from(avatarInventory)
        .where(and(eq(avatarInventory.avatarId, avatarId), eq(avatarInventory.itemId, itemId)))
        .limit(1);

      if (!inventoryItem || inventoryItem.quantity < 1) {
        return {
          success: false,
          text: `You don't have "${book.name}" in your inventory. Visit ${book.building} to buy it first.`,
        };
      }

      // Get current character config
      const [avatar] = await db
        .select({ characterConfig: avatars.characterConfig })
        .from(avatars)
        .where(eq(avatars.id, avatarId))
        .limit(1);

      if (!avatar) {
        return { success: false, text: 'Avatar not found.' };
      }

      // Merge knowledge entries
      const existingKnowledge: string[] = avatar.characterConfig?.knowledge ?? [];
      const newEntries = book.knowledgeEntries.filter(
        (entry) => !existingKnowledge.includes(entry),
      );

      const mergedKnowledge = [...existingKnowledge, ...newEntries];

      // Update characterConfig
      const updatedConfig = {
        ...(avatar.characterConfig ?? {}),
        knowledge: mergedKnowledge,
      };

      await db
        .update(avatars)
        .set({ characterConfig: updatedConfig, updatedAt: new Date() })
        .where(eq(avatars.id, avatarId));

      // Decrement inventory quantity (remove row if 0)
      if (inventoryItem.quantity <= 1) {
        await db
          .delete(avatarInventory)
          .where(eq(avatarInventory.id, inventoryItem.id));
      } else {
        await db
          .update(avatarInventory)
          .set({ quantity: inventoryItem.quantity - 1 })
          .where(eq(avatarInventory.id, inventoryItem.id));
      }

      return {
        success: true,
        text: `${book.icon} Learned ${newEntries.length} new knowledge entries from **${book.name}**! Total knowledge: ${mergedKnowledge.length} entries.${newEntries.length === 0 ? ' (You already knew everything in this book.)' : ''}`,
        data: {
          bookId: book.id,
          bookName: book.name,
          newEntriesCount: newEntries.length,
          totalKnowledge: mergedKnowledge.length,
        },
      };
    } catch (error: any) {
      return { success: false, text: error.message ?? 'Failed to learn skill' };
    }
  },

  suppressPostActionContinuation: false,
};
