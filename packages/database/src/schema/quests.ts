import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { avatars } from './avatars';

export const questTierEnum = pgEnum('quest_tier', [
  'side_quest',
  'main_quest',
  'legendary',
]);

export const questStatusEnum = pgEnum('quest_status', [
  'draft',
  'active',
  'completed',
  'archived',
]);

export const questSubmissionStatusEnum = pgEnum('quest_submission_status', [
  'accepted',
  'in_progress',
  'submitted',
  'in_review',
  'approved',
  'rejected',
]);

export const quests = pgTable('quests', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description').notNull(),
  tier: questTierEnum('tier').notNull(),
  status: questStatusEnum('status').default('active').notNull(),
  tokenReward: integer('token_reward').notNull(),
  titleReward: varchar('title_reward', { length: 100 }),
  maxCompletions: integer('max_completions').default(1),
  currentCompletions: integer('current_completions').default(0),
  requirements: text('requirements'),
  verificationMethod: varchar('verification_method', { length: 50 }).default('manual'),
  createdBy: uuid('created_by')
    .references(() => users.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const questSubmissions = pgTable(
  'quest_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quests.id, { onDelete: 'cascade' }),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    status: questSubmissionStatusEnum('status').default('accepted').notNull(),
    prLink: varchar('pr_link', { length: 500 }),
    submissionNote: text('submission_note'),
    reviewNote: text('review_note'),
    reviewedBy: uuid('reviewed_by')
      .references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at').defaultNow().notNull(),
    submittedAt: timestamp('submitted_at'),
    reviewedAt: timestamp('reviewed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    // ONE active (non-terminal) submission per (quest, avatar) — the DB-backed
    // race guard behind the accept handler's advisory check (Codex adversarial
    // review 2026-07-13). Concurrent accepts collide here (23505) instead of
    // creating parallel payable rows. Applied via CI-tracked
    // migrations/0026_quest_parity_race_guards.sql — NEVER db:push.
    activeSubmissionUnique: uniqueIndex('quest_submissions_active_unique')
      .on(t.questId, t.avatarId)
      .where(sql`status NOT IN ('approved', 'rejected')`),
  }),
);

export const questRewards = pgTable(
  'quest_rewards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => questSubmissions.id, { onDelete: 'cascade' }),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quests.id, { onDelete: 'cascade' }),
    tokensAwarded: integer('tokens_awarded').notNull(),
    titleAwarded: varchar('title_awarded', { length: 100 }),
    claimedAt: timestamp('claimed_at').defaultNow().notNull(),
  },
  (t) => ({
    // At most ONE reward per submission — defense-in-depth behind the CAS
    // status transitions (Codex round 2, 2026-07-13): a reopened-then-
    // re-approved submission must never credit twice. Applied via
    // migrations/0026_quest_parity_race_guards.sql.
    submissionUnique: uniqueIndex('quest_rewards_submission_unique').on(t.submissionId),
  }),
);
