import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
} from 'drizzle-orm/pg-core';
import { avatars } from './avatars';

export const avatarInventory = pgTable('avatar_inventory', {
  id: uuid('id').primaryKey().defaultRandom(),
  avatarId: uuid('avatar_id')
    .notNull()
    .references(() => avatars.id, { onDelete: 'cascade' }),
  itemId: varchar('item_id', { length: 50 }).notNull(),
  quantity: integer('quantity').notNull().default(1),
  acquiredAt: timestamp('acquired_at').defaultNow().notNull(),
});
