import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { pets } from './pets';
import { publishedSkills } from './marketplace';
import { agentConfigs } from './agent-configs';

export const bountyStatusEnum = pgEnum('bounty_status', [
  'open',
  'in_progress',
  'completed',
  'cancelled',
  'expired',
]);

export const bountyAttemptStatusEnum = pgEnum('bounty_attempt_status', [
  'claimed',
  'in_progress',
  'submitted',
  'approved',
  'rejected',
  'abandoned',
]);

export const bountyDifficultyEnum = pgEnum('bounty_difficulty', [
  'beginner',
  'intermediate',
  'advanced',
  'expert',
]);

export const bountyRewardTypeEnum = pgEnum('bounty_reward_type', [
  'token',
  'skill',
  'agent_config',
  'knowledge_book',
  'custom',
]);

export const reputationTierEnum = pgEnum('reputation_tier', [
  'newcomer',
  'apprentice',
  'journeyman',
  'expert',
  'master',
]);

export const bounties = pgTable('bounties', {
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id')
    .notNull()
    .references(() => pets.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description').notNull(),
  requirements: text('requirements'),
  difficulty: bountyDifficultyEnum('difficulty').default('intermediate').notNull(),
  status: bountyStatusEnum('status').default('open').notNull(),
  tokenReward: integer('token_reward').notNull(),
  maxAttempts: integer('max_attempts').default(1).notNull(),
  currentAttempts: integer('current_attempts').default(0).notNull(),
  isFeatured: boolean('is_featured').default(false).notNull(),
  tags: jsonb('tags').$type<string[]>().default([]),
  expiresAt: timestamp('expires_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const bountyRewards = pgTable('bounty_rewards', {
  id: uuid('id').primaryKey().defaultRandom(),
  bountyId: uuid('bounty_id')
    .notNull()
    .references(() => bounties.id, { onDelete: 'cascade' }),
  rewardType: bountyRewardTypeEnum('reward_type').notNull(),
  skillId: uuid('skill_id')
    .references(() => publishedSkills.id, { onDelete: 'set null' }),
  agentConfigId: uuid('agent_config_id')
    .references(() => agentConfigs.id, { onDelete: 'set null' }),
  bookId: varchar('book_id', { length: 50 }),
  customDescription: text('custom_description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const bountyAttempts = pgTable('bounty_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  bountyId: uuid('bounty_id')
    .notNull()
    .references(() => bounties.id, { onDelete: 'cascade' }),
  hunterId: uuid('hunter_id')
    .notNull()
    .references(() => pets.id, { onDelete: 'cascade' }),
  status: bountyAttemptStatusEnum('status').default('claimed').notNull(),
  prLink: varchar('pr_link', { length: 500 }),
  submissionNote: text('submission_note'),
  reviewNote: text('review_note'),
  claimedAt: timestamp('claimed_at').defaultNow().notNull(),
  submittedAt: timestamp('submitted_at'),
  reviewedAt: timestamp('reviewed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const bountyReputation = pgTable('bounty_reputation', {
  id: uuid('id').primaryKey().defaultRandom(),
  petId: uuid('pet_id')
    .notNull()
    .unique()
    .references(() => pets.id, { onDelete: 'cascade' }),
  tier: reputationTierEnum('tier').default('newcomer').notNull(),
  totalCompleted: integer('total_completed').default(0).notNull(),
  totalEarned: integer('total_earned').default(0).notNull(),
  totalPosted: integer('total_posted').default(0).notNull(),
  successRate: integer('success_rate').default(100).notNull(),
  lastActivityAt: timestamp('last_activity_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
