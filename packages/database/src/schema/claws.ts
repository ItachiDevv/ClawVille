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
  // Identity type — which framework is connecting.
  // Values: 'openclaw' | 'ironclaw' | 'nanoclaw' | 'milady' | 'custom' | 'anonymous'
  //
  // For 'milady', the agent_id is prefixed with "milady:" and derived from
  // the Milady runtime's agentId. Runtime-trust model: no external
  // verification happens — the @clawville/app-clawville plugin is the
  // trust boundary.
  identityType: varchar('identity_type', { length: 50 }).default('openclaw').notNull(),
  // Nullable: nanoclaw / anonymous / milady agents have no outbound gateway
  gatewayUrl: varchar('gateway_url', { length: 500 }),
  protocol: varchar('protocol', { length: 50 }).default('openai-compat').notNull(),
  mode: varchar('mode', { length: 20 }).notNull(),
  targetNpcId: varchar('target_npc_id', { length: 100 }),
  name: varchar('name', { length: 100 }),
  species: varchar('species', { length: 50 }),
  color: integer('color'),
  knowledge: jsonb('knowledge').$type<string[]>().default([]),
  metadata: jsonb('metadata').$type<OpenClawBotMetadata>(),
  /**
   * Mirror of the agent's custodial Solana wallet address (base58 public key).
   * Secret key lives encrypted in the unified `wallets` table keyed on
   * (subject_type='agent', subject_id=openclaw_bots.id). Auto-populated by
   * ensureWallet() at /api/agent/connect time.
   */
  walletAddress: varchar('wallet_address', { length: 64 }),
  totalSessions: integer('total_sessions').default(0).notNull(),
  totalMessages: integer('total_messages').default(0).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
