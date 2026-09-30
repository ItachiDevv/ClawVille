import { sql, type Database } from '@clawville/database';

/**
 * Atomic `avatar_inventory` count changes (security M10/M11, 2026-09-30).
 *
 * The book writers used to read `quantity`, add 1 in JavaScript, and write the
 * sum back. Two concurrent writers (two buys, or a buy racing a learn) could then
 * lose an update: a paid book disappeared, or a book that a learn had just
 * consumed came back. These helpers change the count inside ONE SQL statement,
 * so Postgres applies each change to the latest committed row.
 *
 * `avatar_inventory` has no unique (avatar_id, item_id) index. Two concurrent
 * FIRST grants can therefore insert two rows; the total quantity stays correct,
 * and `learnBookAtomically` / `takeInventoryItem` consume from any row with
 * quantity > 0. Callers that already hold the avatar row lock (the ledger debit
 * takes it) never produce the duplicate.
 */
export type InventoryDatabase = Pick<Database, 'execute'>;

export interface InventoryItemRef {
  avatarId: string;
  itemId: string;
}

/** Add ONE of `itemId` to the avatar's inventory (atomic increment, else insert). */
export async function grantInventoryItem(
  db: InventoryDatabase,
  input: InventoryItemRef,
): Promise<void> {
  const incremented = await db.execute<{ id: string }>(
    sql`UPDATE avatar_inventory AS inventory
        SET quantity = inventory.quantity + 1
        WHERE inventory.id = (
          SELECT id
          FROM avatar_inventory
          WHERE avatar_id = ${input.avatarId}
            AND item_id = ${input.itemId}
          ORDER BY acquired_at ASC, id ASC
          LIMIT 1
        )
        RETURNING inventory.id`,
  );
  if (incremented[0]) return;
  await db.execute(
    sql`INSERT INTO avatar_inventory (avatar_id, item_id, quantity)
        VALUES (${input.avatarId}, ${input.itemId}, 1)`,
  );
}

/**
 * Remove ONE of `itemId` from the avatar's inventory. Returns false (and changes
 * nothing) when the avatar holds none. Same conditional decrement as
 * `learnBookAtomically`: the positive-quantity predicate is checked again on
 * the locked row.
 */
export async function takeInventoryItem(
  db: InventoryDatabase,
  input: InventoryItemRef,
): Promise<boolean> {
  const taken = await db.execute<{ id: string }>(
    sql`WITH inventory_item AS (
          SELECT id
          FROM avatar_inventory
          WHERE avatar_id = ${input.avatarId}
            AND item_id = ${input.itemId}
            AND quantity > 0
          ORDER BY acquired_at ASC, id ASC
          LIMIT 1
          FOR UPDATE
        )
        UPDATE avatar_inventory AS inventory
        SET quantity = inventory.quantity - 1
        FROM inventory_item
        WHERE inventory.id = inventory_item.id
          AND inventory.quantity > 0
        RETURNING inventory.id`,
  );
  return taken.length > 0;
}
