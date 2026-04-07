import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { pets } from './pets';

export const publishedSkills = pgTable('published_skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  authorPetId: uuid('author_pet_id')
    .references(() => pets.id, { onDelete: 'cascade' }),
  authorClawName: varchar('author_claw_name', { length: 100 }),
  authorClawSpecies: varchar('author_claw_species', { length: 20 }),
  locationId: varchar('location_id', { length: 50 }),
  name: varchar('name', { length: 100 }).notNull(),
  description: varchar('description', { length: 200 }).notNull(),
  skillMd: text('skill_md').notNull(),
  price: integer('price').notNull().default(0),
  upvoteCount: integer('upvote_count').notNull().default(0),
  downloadCount: integer('download_count').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const skillUpvotes = pgTable(
  'skill_upvotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => publishedSkills.id, { onDelete: 'cascade' }),
    petId: uuid('pet_id')
      .references(() => pets.id, { onDelete: 'cascade' }),
    clawSessionId: varchar('claw_session_id', { length: 100 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    skillPetUnique: uniqueIndex('skill_upvotes_skill_pet_unique').on(t.skillId, t.petId),
  })
);
