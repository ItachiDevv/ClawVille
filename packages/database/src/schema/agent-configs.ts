import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  integer,
  timestamp,
  boolean,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { pets } from './pets';

export interface AgentConfigExport {
  version: number;
  name: string;
  species: string;
  color: string;
  archetype: string;
  personality: any;
  stats: any;
  characterConfig: any;
  equippedSkills: string[];
  totalXp: number;
  exportedAt: string;
  /** Phase 2 — optional. Older exports predate these fields; import falls
   *  back to DB DEFAULTs ('lobster', 'openclaw', 'milady') when omitted. */
  modelKey?: string;
  agentCategory?: 'openclaw' | 'hermes' | 'milady' | 'other';
  harness?: 'openclaw' | 'hermes' | 'milady' | 'custom';
}

export const agentConfigs = pgTable('agent_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  petId: uuid('pet_id')
    .references(() => pets.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  configData: jsonb('config_data').$type<AgentConfigExport>().notNull(),
  isPublic: boolean('is_public').default(false).notNull(),
  downloadCount: integer('download_count').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
