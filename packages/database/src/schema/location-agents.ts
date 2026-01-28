import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { mapLocations } from './locations';
import { platformAgents } from './agents';

export interface CharacterConfigJson {
  name: string;
  personality: string;
  bio: string;
  greeting: string;
  tone: 'formal' | 'casual' | 'friendly' | 'professional';
  topics: string[];
  rules: string[];
  style: string[];
}

export const locationAgents = pgTable('location_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  locationId: varchar('location_id', { length: 50 })
    .notNull()
    .references(() => mapLocations.id),
  agentName: varchar('agent_name', { length: 100 }).notNull(),
  characterConfig: jsonb('character_config').$type<CharacterConfigJson>().notNull(),
  platformAgentId: uuid('platform_agent_id')
    .references(() => platformAgents.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
