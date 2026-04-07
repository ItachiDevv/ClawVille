import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';
import { pets } from './pets';

/**
 * NPC/Pet memories — stores conversation summaries and observations.
 */
export const npcMemories = pgTable('npc_memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Who owns this memory (NPC id string or pet UUID) */
  entityId: varchar('entity_id', { length: 100 }).notNull(),
  entityType: varchar('entity_type', { length: 20 }).notNull(), // 'npc' | 'pet'
  /** Who/what this memory is about */
  targetEntityId: varchar('target_entity_id', { length: 100 }),
  content: text('content').notNull(),
  importance: integer('importance').default(5).notNull(), // 0-9
  kind: varchar('kind', { length: 30 }).notNull(), // 'conversation' | 'observation' | 'reflection'
  metadata: jsonb('metadata').$type<Record<string, any>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Activity log — tracks autonomous pet actions for the activity feed.
 */
export const activityLog = pgTable('activity_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  petId: uuid('pet_id')
    .notNull()
    .references(() => pets.id, { onDelete: 'cascade' }),
  activityType: varchar('activity_type', { length: 50 }).notNull(),
  description: text('description').notNull(),
  tokensEarned: integer('tokens_earned').default(0).notNull(),
  metadata: jsonb('metadata').$type<Record<string, any>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
