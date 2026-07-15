import { KNOWLEDGE_BOOKS } from '@clawville/shared';
import type { Action, ActionResult } from './types';
import { hasServices, getMessageText, getParam } from './types';
import { learnBookAtomically, LearnBookError } from './learn-book-transaction';

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

      let learned;
      try {
        learned = await learnBookAtomically(db, { avatarId, bookId: itemId });
      } catch (error) {
        if (error instanceof LearnBookError) {
          if (error.code === 'book_not_found') {
            return { success: false, text: `Book "${itemId}" not found.` };
          }
          if (error.code === 'avatar_not_found') {
            return { success: false, text: 'Avatar not found.' };
          }

          const knownBook = KNOWLEDGE_BOOKS.find((candidate) => candidate.id === itemId);
          return {
            success: false,
            text: knownBook
              ? `You don't have "${knownBook.name}" in your inventory. Visit ${knownBook.building} to buy it first.`
              : error.message,
          };
        }
        throw error;
      }

      const { book, newKnowledge: newEntries, mergedKnowledge } = learned;

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
