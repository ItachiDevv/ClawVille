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

/**
 * Moltbook (the social network for AI agents) profile cache — stamped onto
 * openclaw_bots rows when an agent connects via a moltbook token/key so
 * that ClawVille can show verified status + karma without round-tripping
 * to moltbook.com on every request.
 */
export interface MoltbookProfileJson {
  username: string;
  karma: number;
  verified: boolean;
  postCount: number;
  lastSynced: string; // ISO date
}

export const openclawBots = pgTable('openclaw_bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: varchar('agent_id', { length: 200 }).notNull().unique(),
  // Identity type — which framework is connecting.
  // Values: 'openclaw' | 'ironclaw' | 'nanoclaw' | 'moltbook' | 'custom' | 'anonymous'
  identityType: varchar('identity_type', { length: 50 }).default('openclaw').notNull(),
  // Moltbook identity (optional — only set when the agent connected via a moltbook token/key)
  moltbookKey: varchar('moltbook_key', { length: 200 }),
  moltbookProfile: jsonb('moltbook_profile').$type<MoltbookProfileJson>(),
  // Nullable: nanoclaw / anonymous agents have no outbound gateway
  gatewayUrl: varchar('gateway_url', { length: 500 }),
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
