import {
  pgTable,
  varchar,
  integer,
  text,
} from 'drizzle-orm/pg-core';

export const mapLocations = pgTable('map_locations', {
  id: varchar('id', { length: 50 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description').notNull(),
  icon: varchar('icon', { length: 10 }).notNull(),
  positionX: integer('position_x').notNull(),
  positionY: integer('position_y').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
});
