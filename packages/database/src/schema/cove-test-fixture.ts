/**
 * BA-2 staging-only deterministic parity-fixture runs.
 *
 * Raw bearer tokens are show-once and NEVER persisted. `tokenHash` is the
 * sha256 digest used to authenticate the staging harness header.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';

export const coveTestFixtureRuns = pgTable(
  'cove_test_fixture_runs',
  {
    runId: uuid('run_id').primaryKey().defaultRandom(),
    ownerAvatarId: uuid('owner_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'restrict' }),
    scenarioName: text('scenario_name').notNull(),
    tokenHash: text('token_hash').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    exposureBudgetCt: integer('exposure_budget_ct').notNull(),
    spentCt: integer('spent_ct').notNull().default(0),
    status: text('status').notNull().default('active'),
    /** Atomic one-shot seed-arm marker; budget checks continue after consumption. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => ({
    ownerStatusIdx: index('cove_test_fixture_runs_owner_status_idx').on(
      table.ownerAvatarId,
      table.status,
    ),
    ownerActiveUnique: uniqueIndex('cove_test_fixture_runs_owner_active_unique')
      .on(table.ownerAvatarId)
      .where(sql`status = 'active'`),
    statusCheck: check(
      'cove_test_fixture_runs_status_check',
      sql`status in ('active','expired','closed')`,
    ),
    exposureCheck: check(
      'cove_test_fixture_runs_exposure_check',
      sql`exposure_budget_ct >= 0 AND spent_ct >= 0 AND spent_ct <= exposure_budget_ct`,
    ),
  }),
);

export type CoveTestFixtureRun = typeof coveTestFixtureRuns.$inferSelect;
export type NewCoveTestFixtureRun = typeof coveTestFixtureRuns.$inferInsert;
