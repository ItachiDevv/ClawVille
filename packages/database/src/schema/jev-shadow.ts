/**
 * Jev decide SHADOW ledger (founder-approved 2026-10-13; migration 0081).
 *
 * One row per shadow call (or cap refusal) made by
 * `apps/api/src/services/jev-decide-shadow.ts`. SHADOW ONLY: no game path reads
 * this table. `usd` is both the spend record and the spend-cap ledger: a row is
 * inserted as `reserved` with a cost estimate under an advisory lock, then
 * updated with the actual cost. The prompt and the reply text are NEVER stored.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const jevDecideShadow = pgTable(
  'jev_decide_shadow',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    avatarId: uuid('avatar_id'),
    isHouse: boolean('is_house').notNull(),
    /** reserved | ok | error | timeout | skipped_cap */
    status: varchar('status', { length: 16 }).notNull(),
    localVerb: varchar('local_verb', { length: 48 }),
    localEmpty: boolean('local_empty').notNull(),
    localMs: integer('local_ms'),
    jevVerb: varchar('jev_verb', { length: 48 }),
    jevTopProb: real('jev_top_prob'),
    jevProbs: jsonb('jev_probs'),
    jevMs: integer('jev_ms'),
    inputTokens: integer('input_tokens'),
    usd: numeric('usd', { precision: 12, scale: 8 }).notNull().default('0'),
    error: text('error'),
  },
  (t) => ({
    createdAtIdx: index('jev_decide_shadow_created_at_idx').on(t.createdAt),
  }),
);

export type JevDecideShadowRow = typeof jevDecideShadow.$inferSelect;
export type NewJevDecideShadowRow = typeof jevDecideShadow.$inferInsert;
