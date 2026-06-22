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
import { avatars } from './avatars';

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
   *  back to DB DEFAULTs ('lobster', 'openclaw', 'milady') when omitted.
   *  `agentCategory` mirrors the shared AGENT_CATEGORIES tuple (hardcoded here
   *  to avoid a @clawville/shared → @clawville/database dependency cycle).
   *  'hatcher' added 2026-06-01 (partner #2); 'chibi' added 2026-06-21 (F5) —
   *  keep in lockstep with AGENT_CATEGORIES in
   *  packages/shared/src/constants/agent-models.ts. */
  modelKey?: string;
  agentCategory?: 'openclaw' | 'hermes' | 'milady' | 'other' | 'hatcher' | 'chibi';
  harness?: 'openclaw' | 'hermes' | 'milady' | 'custom';
}

export const agentConfigs = pgTable('agent_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  avatarId: uuid('avatar_id')
    .references(() => avatars.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  configData: jsonb('config_data').$type<AgentConfigExport>().notNull(),
  isPublic: boolean('is_public').default(false).notNull(),
  downloadCount: integer('download_count').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
