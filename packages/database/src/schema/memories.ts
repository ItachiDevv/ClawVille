import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';
import { avatars } from './avatars';

/**
 * NPC/Avatar memories — stores conversation summaries and observations.
 */
export const npcMemories = pgTable('npc_memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Who owns this memory (NPC id string or avatar UUID) */
  entityId: varchar('entity_id', { length: 100 }).notNull(),
  entityType: varchar('entity_type', { length: 20 }).notNull(), // 'npc' | 'avatar'
  /** Who/what this memory is about */
  targetEntityId: varchar('target_entity_id', { length: 100 }),
  content: text('content').notNull(),
  importance: integer('importance').default(5).notNull(), // 0-9
  kind: varchar('kind', { length: 30 }).notNull(), // 'conversation' | 'observation' | 'reflection'
  metadata: jsonb('metadata').$type<Record<string, any>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Activity log — tracks autonomous avatar actions for the activity feed.
 */
export const activityLog = pgTable('activity_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  avatarId: uuid('avatar_id')
    .notNull()
    .references(() => avatars.id, { onDelete: 'cascade' }),
  activityType: varchar('activity_type', { length: 50 }).notNull(),
  description: text('description').notNull(),
  tokensEarned: integer('tokens_earned').default(0).notNull(),
  metadata: jsonb('metadata').$type<Record<string, any>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
