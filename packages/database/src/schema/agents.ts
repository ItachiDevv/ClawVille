import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  text,
  pgEnum,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

export const platformAgentStatusEnum = pgEnum('platform_agent_status', [
  'pending',
  'starting',
  'running',
  'paused',
  'error',
  'stopped',
]);

export const platformAgents = pgTable(
  'platform_agents',
  {
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
  },
  (table) => ({
    /**
     * Partial unique index — guarantees only ONE system-agent row per
     * (userId, customization.slug) triple. Enforces the invariant that
     * `ensureSystemAgents()` upserts by slug, not by name: two slugs could
     * share a template name, and two users (humans vs system) could share
     * a slug in theory, but for a given userId+slug combination exactly
     * one system agent row exists.
     *
     * Why partial: we don't want this constraint applied to the 10
     * per-user `location-agent` rows or the future `avatar-agent` /
     * `openclaw-bot` / etc. rows — they have their own uniqueness rules.
     * `WHERE type = 'system-agent'` scopes it.
     *
     * drizzle-kit 0.24+ supports `.where(sql\`...\`)` on indexes. Plain
     * push — NO `CREATE INDEX CONCURRENTLY` (drizzle-kit wraps DDL in a
     * transaction, which rejects CONCURRENTLY at plan time).
     */
    systemAgentSingleton: uniqueIndex('platform_agents_system_singleton')
      .on(table.userId, table.type, sql`(${table.customization}->>'slug')`)
      .where(sql`${table.type} = 'system-agent'`),

    /**
     * R3 (2026-07-02): partial unique index — at most ONE openclaw-bot row per
     * (userId, type, config->>'openclawBotId'). Prevents concurrent boots from
     * inserting duplicate `platform_agents` rows for the SAME house/connected bot,
     * which made `house-agent-seeder.ts` and `routes/openclaw.ts` (both `.find()`
     * an arbitrary matching row) bind a nondeterministic runtime each boot.
     *
     * Uses `IS NOT NULL` (NOT the jsonb `?` existence operator) so the predicate is
     * a plain SQL expression and dodges the `?`→param-placeholder ambiguity in the
     * driver. Mirrors the systemAgentSingleton partial-index precedent above.
     *
     * Manual migration + pre-index dedupe (a CREATE UNIQUE INDEX would throw on
     * existing dups): migrations-manual/2026-07-02_platform_agents_openclaw_bot_singleton.sql.
     */
    openclawBotSingleton: uniqueIndex('platform_agents_openclaw_bot_singleton')
      .on(table.userId, table.type, sql`(${table.config}->>'openclawBotId')`)
      .where(
        sql`${table.type} = 'openclaw-bot' AND (${table.config}->>'openclawBotId') IS NOT NULL`,
      ),
  }),
);

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
