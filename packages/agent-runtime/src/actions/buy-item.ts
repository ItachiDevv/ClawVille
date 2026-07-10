import { KNOWLEDGE_BOOKS, getBookById } from '@clawville/shared';
import type { Action, ActionResult } from './types';
import { hasServices, getMessageText, getParam , getDbModule } from './types';

/**
 * BUY_ITEM — purchase a knowledge book from the current building's shop.
 *
 * Parameters:
 *   itemId — the book ID (e.g. "cron-automation-basics")
 */
export const buyItemAction: Action = {
  name: 'BUY_ITEM',
  description:
    'Purchase a knowledge book from a building shop using vCLAW.',
  similes: ['PURCHASE_ITEM', 'BUY_BOOK', 'BUY_KNOWLEDGE', 'PURCHASE'],

  parameters: [
    {
      name: 'itemId',
      description: 'The ID of the knowledge book to purchase.',
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
        content: { text: 'Buy the Cron Scheduling 101 book', action: 'BUY_ITEM' },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: { text: 'I want to purchase the Vector Memory Guide', action: 'BUY_ITEM' },
      },
    ],
  ],

  async validate(_runtime: any, message: any, _state?: any): Promise<boolean> {
    const text = getMessageText(message).toLowerCase();
    const triggers = ['buy', 'purchase', 'get the book', 'acquire'];
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
      const { db, debitClawTokens, creditClawTokens } = services;

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
          text: 'Could not determine which book to buy. Please specify a book name or ID.',
        };
      }

      const book = getBookById(itemId);
      if (!book) {
        return { success: false, text: `Book "${itemId}" not found.` };
      }

      // Check current balance
      const { avatars, eq } = await getDbModule();

      const [avatar] = await db
        .select({ clawTokens: avatars.clawTokens })
        .from(avatars)
        .where(eq(avatars.id, avatarId))
        .limit(1);

      if (!avatar) {
        return { success: false, text: 'Avatar not found.' };
      }

      if (avatar.clawTokens < book.price) {
        return {
          success: false,
          text: `Not enough vCLAW. You have ${avatar.clawTokens} vCLAW but "${book.name}" costs ${book.price} vCLAW.`,
        };
      }

      // Check if avatar already owns this book
      const { avatarInventory, and } = await getDbModule();

      const [existing] = await db
        .select({ id: avatarInventory.id, quantity: avatarInventory.quantity })
        .from(avatarInventory)
        .where(and(eq(avatarInventory.avatarId, avatarId), eq(avatarInventory.itemId, itemId)))
        .limit(1);

      // Debit ClawTokens
      const { balanceAfter } = await debitClawTokens({
        avatarId,
        amount: book.price,
        reason: `Purchased book: ${book.name}`,
        source: 'shop',
        metadata: { bookId: book.id, buildingId: book.building },
      });

      // Add or increment inventory — compensating credit on failure
      try {
        if (existing) {
          await db
            .update(avatarInventory)
            .set({ quantity: existing.quantity + 1 })
            .where(eq(avatarInventory.id, existing.id));
        } else {
          await db.insert(avatarInventory).values({
            avatarId,
            itemId,
            quantity: 1,
          });
        }
      } catch (invErr: any) {
        // Compensating credit — refund the debit so the avatar doesn't lose tokens
        await creditClawTokens({
          avatarId,
          amount: book.price,
          reason: 'buy_item_refund',
          source: 'api',
          metadata: { bookId: book.id, error: invErr.message },
        }).catch(() => {});
        return { success: false, text: `Purchase failed after payment — tokens refunded. Error: ${invErr.message}` };
      }

      return {
        success: true,
        text: `${book.icon} Purchased **${book.name}** for ${book.price} vCLAW. New balance: ${balanceAfter} vCLAW. Use "learn" or "read" to absorb its knowledge.`,
        data: {
          bookId: book.id,
          bookName: book.name,
          price: book.price,
          balanceAfter,
        },
      };
    } catch (error: any) {
      return { success: false, text: error.message ?? 'Failed to buy item' };
    }
  },

  suppressPostActionContinuation: false,
};
