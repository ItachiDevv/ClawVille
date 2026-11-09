/**
 * Own AI for hosted agents (migration 0099, MCP hub step 4 part A, 2026-11-09).
 * Written only by `apps/api/src/services/own-ai.ts`.
 * - `agent_ai_settings`: the AI that powers one avatar's hosted agent. The key
 *   (or UsePod token) is encrypted with keypair-vault `encryptToken`; only the
 *   last 4 characters are ever returned.
 * - `agent_ai_usage`: own-AI calls per avatar per UTC day, with the ESTIMATED
 *   cost in integer micro-USD. One atomic upsert adds each call.
 *   `reservedMicroUsd` holds the worst-case estimate of the calls in flight (one
 *   conditional upsert reserves it under the limit; settlement or release
 *   subtracts it).
 */

import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { avatars } from './avatars';
import { users } from './users';

export const agentAiSettings = pgTable('agent_ai_settings', {
  avatarId: uuid('avatar_id').primaryKey().references(() => avatars.id, { onDelete: 'cascade' }),
  source: text('source').notNull().default('clawville'),
  provider: text('provider'),
  model: text('model'),
  speedSeconds: integer('speed_seconds').notNull().default(25),
  dailyLimitCents: integer('daily_limit_cents'),
  keyEnc: text('key_enc'),
  keyIv: text('key_iv'),
  keyTag: text('key_tag'),
  keyLast4: text('key_last4'),
  usepodRegistered: boolean('usepod_registered').notNull().default(false),
  /** The UsePod token ClawVille registered. Never touched by clear, a provider switch or a new own key. */
  usepodTokenEnc: text('usepod_token_enc'),
  usepodTokenIv: text('usepod_token_iv'),
  usepodTokenTag: text('usepod_token_tag'),
  usepodTokenLast4: text('usepod_token_last4'),
  fallbackReason: text('fallback_reason'),
  fallbackAt: timestamp('fallback_at', { withTimezone: true }),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  sourceCheck: check('agent_ai_settings_source_check', sql`${t.source} IN ('clawville', 'own_key', 'usepod')`),
  providerCheck: check(
    'agent_ai_settings_provider_check',
    sql`${t.provider} IS NULL OR ${t.provider} IN ('openai', 'anthropic', 'openrouter', 'usepod')`,
  ),
  modelCheck: check('agent_ai_settings_model_check', sql`${t.model} IS NULL OR char_length(${t.model}) BETWEEN 1 AND 128`),
  speedCheck: check('agent_ai_settings_speed_check', sql`${t.speedSeconds} BETWEEN 10 AND 25`),
  dailyLimitCheck: check(
    'agent_ai_settings_daily_limit_check',
    sql`${t.dailyLimitCents} IS NULL OR ${t.dailyLimitCents} BETWEEN 10 AND 50000`,
  ),
  fallbackReasonCheck: check(
    'agent_ai_settings_fallback_reason_check',
    sql`${t.fallbackReason} IS NULL OR ${t.fallbackReason} IN ('daily_limit', 'key_rejected', 'balance_empty', 'provider_error', 'model_unavailable')`,
  ),
  usepodRegisteredCheck: check(
    'agent_ai_settings_usepod_registered_check',
    sql`${t.usepodRegistered} = (${t.usepodTokenEnc} IS NOT NULL)`,
  ),
  ownCompleteCheck: check(
    'agent_ai_settings_own_complete_check',
    sql`${t.source} = 'clawville' OR (${t.provider} IS NOT NULL AND ${t.model} IS NOT NULL AND ${t.dailyLimitCents} IS NOT NULL AND (${t.keyEnc} IS NOT NULL OR (${t.source} = 'usepod' AND ${t.usepodTokenEnc} IS NOT NULL)))`,
  ),
}));

export const agentAiUsage = pgTable(
  'agent_ai_usage',
  {
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    calls: integer('calls').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    estimatedMicroUsd: bigint('estimated_micro_usd', { mode: 'number' }).notNull().default(0),
    reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ name: 'agent_ai_usage_pkey', columns: [t.avatarId, t.day] }),
  }),
);
