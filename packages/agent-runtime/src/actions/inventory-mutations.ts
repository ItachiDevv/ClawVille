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
 * `avatar_inventory_avatar_item_unique` (migration 0075) makes (avatar_id,
 * item_id) unique, so a grant is one `INSERT ... ON CONFLICT DO UPDATE`: two
 * concurrent first grants serialize on the index and end as ONE row with
 * quantity 2, never two rows.
 */
export type InventoryDatabase = Pick<Database, 'execute'>;

export interface InventoryItemRef {
  avatarId: string;
  itemId: string;
}

/** Add ONE of `itemId` to the avatar's inventory (one atomic upsert). */
export async function grantInventoryItem(
  db: InventoryDatabase,
  input: InventoryItemRef,
): Promise<void> {
  await db.execute(
    sql`INSERT INTO avatar_inventory AS inventory (avatar_id, item_id, quantity)
        VALUES (${input.avatarId}, ${input.itemId}, 1)
        ON CONFLICT (avatar_id, item_id)
        DO UPDATE SET quantity = inventory.quantity + 1`,
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
