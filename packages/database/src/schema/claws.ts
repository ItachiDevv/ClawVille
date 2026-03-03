import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  integer,
} from 'drizzle-orm/pg-core';
import { users } from './users';

// --- OpenClaw Bot Persistence ---

export interface OpenClawBotMetadata {
  personality?: string;
  homeX?: number;
  homeY?: number;
  patrolRadius?: number;
  stats?: { hp: number; attack: number; defense: number; speed: number };
  lastX?: number;
  lastY?: number;
}

export const openclawBots = pgTable('openclaw_bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: varchar('agent_id', { length: 200 }).notNull().unique(),
  gatewayUrl: varchar('gateway_url', { length: 500 }).notNull(),
  protocol: varchar('protocol', { length: 50 }).default('openai-compat').notNull(),
  mode: varchar('mode', { length: 20 }).notNull(),
  targetNpcId: varchar('target_npc_id', { length: 100 }),
  name: varchar('name', { length: 100 }),
  species: varchar('species', { length: 50 }),
  color: integer('color'),
  knowledge: jsonb('knowledge').$type<string[]>().default([]),
  metadata: jsonb('metadata').$type<OpenClawBotMetadata>(),
  totalSessions: integer('total_sessions').default(0).notNull(),
  totalMessages: integer('total_messages').default(0).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
