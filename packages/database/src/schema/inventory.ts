import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
} from 'drizzle-orm/pg-core';
import { pets } from './pets';

export const petInventory = pgTable('pet_inventory', {
  id: uuid('id').primaryKey().defaultRandom(),
  petId: uuid('pet_id')
    .notNull()
    .references(() => pets.id, { onDelete: 'cascade' }),
  itemId: varchar('item_id', { length: 50 }).notNull(),
  quantity: integer('quantity').notNull().default(1),
  acquiredAt: timestamp('acquired_at').defaultNow().notNull(),
});
