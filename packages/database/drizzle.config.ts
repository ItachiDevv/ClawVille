import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../../.env.local') });

// ──────────────────────────────────────────────────────────────────────────────
// DO NOT REMOVE — ElizaOS plugin-sql owns its own ~20-table schema
// (agents, memories, entities, rooms, components, participants, embeddings,
// logs, cache, tasks, worlds, relationships, servers, channels, messages,
// message_servers, channel_participants, message_server_agents,
// pairing_allowlist, pairing_requests). Those tables live in our DB but are
// NOT part of our Drizzle schema.
//
// With ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true (set in prod env), a naive
// `drizzle-kit push` would treat those tables as "unknown" and DROP them —
// silently breaking every chat route. It happened on 2026-04-16 and AGAIN on
// 2026-04-23. Fix: make push literally blind to those tables via tablesFilter
// negation patterns, so push only ever sees our own tables.
//
// If you add a new ElizaOS plugin that registers more tables, add them here.
// See scripts/recover-eliza-schema.mjs for emergency recovery.
// ──────────────────────────────────────────────────────────────────────────────
const ELIZAOS_MANAGED_TABLES = [
  '!agents',
  '!memories',
  '!entities',
  '!rooms',
  '!components',
  '!participants',
  '!embeddings',
  '!logs',
  '!cache',
  '!tasks',
  '!worlds',
  '!relationships',
  '!servers',
  '!channels',
  '!messages',
  '!message_servers',
  '!channel_participants',
  '!message_server_agents',
  '!pairing_allowlist',
  '!pairing_requests',
];

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  tablesFilter: ELIZAOS_MANAGED_TABLES,
  verbose: true,
  strict: true,
});
