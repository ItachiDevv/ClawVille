import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  text,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const platformAgentStatusEnum = pgEnum('platform_agent_status', [
  'pending',
  'starting',
  'running',
  'paused',
  'error',
  'stopped',
]);

export const platformAgents = pgTable('platform_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  type: varchar('type', { length: 50 }).notNull().default('location-agent'),
  status: platformAgentStatusEnum('status').default('pending').notNull(),
  customization: jsonb('customization').$type<Record<string, unknown>>(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  lastHeartbeat: timestamp('last_heartbeat'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const platformAgentLogs = pgTable('platform_agent_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => platformAgents.id, { onDelete: 'cascade' }),
  level: varchar('level', { length: 20 }).notNull(),
  message: text('message').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Backward compatibility aliases
export const agents = platformAgents;
export const agentLogs = platformAgentLogs;
