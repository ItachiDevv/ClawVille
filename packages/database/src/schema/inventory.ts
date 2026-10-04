import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { avatars } from './avatars';

export const avatarInventory = pgTable(
  'avatar_inventory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    itemId: varchar('item_id', { length: 50 }).notNull(),
    quantity: integer('quantity').notNull().default(1),
    acquiredAt: timestamp('acquired_at').defaultNow().notNull(),
  },
  (table) => ({
    // One row per (avatar, item) (migration 0075, security M10 Codex round 2):
    // `grantInventoryItem` is an INSERT ... ON CONFLICT (avatar_id, item_id)
    // DO UPDATE upsert on this index.
    avatarItemUnique: uniqueIndex('avatar_inventory_avatar_item_unique').on(
      table.avatarId,
      table.itemId,
    ),
  }),
);
