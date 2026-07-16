import {
  agents,
  avatarInventory,
  avatars,
  and,
  eq,
  sql,
  type AvatarCharacterConfigJson,
  type Database,
} from '@clawville/database';
import { getBookById, type KnowledgeBook } from '@clawville/shared';
import type { ClawvilleServices } from './types';
import {
  mergeKnowledgeCustomization,
  mergeKnowledgeEntries,
  recordValue,
} from './knowledge-merge';

export type LearnBookErrorCode =
  | 'book_not_found'
  | 'avatar_not_found'
  | 'book_not_owned';

export class LearnBookError extends Error {
  constructor(
    readonly code: LearnBookErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LearnBookError';
  }
}

export interface LearnBookResult {
  book: KnowledgeBook;
  updatedAvatar: typeof avatars.$inferSelect;
  platformAgentId: string | null;
  newKnowledge: string[];
  mergedKnowledge: string[];
}

export type LearnBookDatabase = Pick<Database, 'transaction'>;
export type LearnBookCovenantRecorder = NonNullable<
  ClawvilleServices['recordCovenantAction']
>;

/**
 * Consume one knowledge book and persist its knowledge as one atomic operation.
 *
 * The avatar row is the serialization lock for every book read by an avatar.
 * This protects both the inventory quantity and the shared characterConfig JSON
 * when the HTTP route and autonomous runtime dispatch concurrently.
 */
export async function learnBookAtomically(
  database: LearnBookDatabase,
  input: { avatarId: string; bookId: string },
  recordCovenantAction?: LearnBookCovenantRecorder,
): Promise<LearnBookResult> {
  // Validate before opening the transaction so an unknown id can never consume
  // an inventory row, even if a malformed row with that id exists.
  const book = getBookById(input.bookId);
  if (!book) {
    throw new LearnBookError('book_not_found', 'Book not found');
  }

  return database.transaction(async (tx) => {
    const lockedRows = await tx.execute<{
      id: string;
      platform_agent_id: string | null;
      character_config: Record<string, unknown> | null;
    }>(
      sql`SELECT id, platform_agent_id, character_config
          FROM avatars
          WHERE id = ${input.avatarId} AND is_active = true
          FOR UPDATE`,
    );
    const lockedAvatar = lockedRows[0];
    if (!lockedAvatar) {
      throw new LearnBookError('avatar_not_found', 'No avatar found');
    }

    // The avatar lock serializes every inventory claim for this avatar. The
    // positive-quantity predicate is a second fail-closed guard against reuse.
    const consumedRows = await tx.execute<{ id: string; quantity: number }>(
      sql`WITH inventory_item AS (
            SELECT id
            FROM avatar_inventory
            WHERE avatar_id = ${lockedAvatar.id}
              AND item_id = ${book.id}
              AND quantity > 0
            ORDER BY acquired_at ASC, id ASC
            LIMIT 1
            FOR UPDATE
          )
          UPDATE avatar_inventory AS inventory
          SET quantity = inventory.quantity - 1
          FROM inventory_item
          WHERE inventory.id = inventory_item.id
          RETURNING inventory.id, inventory.quantity`,
    );
    const consumed = consumedRows[0];
    if (!consumed) {
      throw new LearnBookError(
        'book_not_owned',
        'You do not have this book in your inventory',
      );
    }

    const currentConfig = recordValue(lockedAvatar.character_config);
    const { newKnowledge, mergedKnowledge } = mergeKnowledgeEntries(
      currentConfig.knowledge,
      book.knowledgeEntries,
    );
    const updatedConfig = {
      ...currentConfig,
      knowledge: mergedKnowledge,
    };

    // The platform-agent customization is a separate configuration surface
    // from the avatar's characterConfig. In particular, connected agents keep
    // their gateway credentials and persona fields here. Lock and merge the
    // current agent row inside this transaction; copying `updatedConfig` over
    // it would silently erase every agent-only field on each book read.
    const lockedAgent = lockedAvatar.platform_agent_id
      ? (
          await tx.execute<{
            customization: Record<string, unknown> | null;
          }>(
            sql`SELECT customization
                FROM platform_agents
                WHERE id = ${lockedAvatar.platform_agent_id}
                FOR UPDATE`,
          )
        )[0]
      : undefined;
    const [updatedAvatar] = await tx
      .update(avatars)
      .set({
        characterConfig: updatedConfig as AvatarCharacterConfigJson,
        updatedAt: new Date(),
      })
      .where(eq(avatars.id, lockedAvatar.id))
      .returning();
    if (!updatedAvatar) {
      throw new LearnBookError('avatar_not_found', 'No avatar found');
    }

    if (lockedAvatar.platform_agent_id && lockedAgent) {
      const hostedKnowledge = mergeKnowledgeEntries(
        recordValue(lockedAgent.customization).knowledge,
        mergedKnowledge,
      ).mergedKnowledge;
      await tx
        .update(agents)
        .set({
          customization: mergeKnowledgeCustomization(
            lockedAgent.customization,
            hostedKnowledge,
          ),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, lockedAvatar.platform_agent_id));
    }

    if (consumed.quantity === 0) {
      await tx
        .delete(avatarInventory)
        .where(and(eq(avatarInventory.id, consumed.id), eq(avatarInventory.quantity, 0)));
    }

    if (recordCovenantAction) {
      await recordCovenantAction(
        {
          action: 'agent.action.learn',
          subjectType: 'avatar',
          subjectId: input.avatarId,
          payload: { bookId: book.id },
        },
        tx,
      );
    }

    return {
      book,
      updatedAvatar,
      platformAgentId: lockedAvatar.platform_agent_id,
      newKnowledge,
      mergedKnowledge,
    };
  });
}
