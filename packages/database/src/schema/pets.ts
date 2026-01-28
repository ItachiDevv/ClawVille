import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  pgEnum,
  integer,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const petSpeciesEnum = pgEnum('pet_species', [
  'cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle',
]);

export const petColorEnum = pgEnum('pet_color', [
  'green', 'red', 'blue', 'yellow',
]);

export const petGenderEnum = pgEnum('pet_gender', ['male', 'female']);

export interface PetPersonalityJson {
  habitat: string;
  hobby: string;
  greeting: string;
}

export interface PetStatsJson {
  strength: number;
  defence: number;
  movement: number;
}

export const pets = pgTable('pets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull().unique(),
  species: petSpeciesEnum('species').notNull(),
  color: petColorEnum('color').notNull(),
  gender: petGenderEnum('gender').notNull(),
  personality: jsonb('personality').$type<PetPersonalityJson>().notNull(),
  stats: jsonb('stats').$type<PetStatsJson>().notNull(),
  positionX: integer('position_x').default(400).notNull(),
  positionY: integer('position_y').default(250).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
