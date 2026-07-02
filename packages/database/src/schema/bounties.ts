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
import { avatars } from './avatars';
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

/**
 * How a bounty pays out. `'ct'` = the classic ClawToken escrow (creator's CT is
 * debited at create, released to the hunter on approve). `'usdc'` = the SAP
 * Option-C on-chain USDC escrow rail (creator → depositor, hunter → worker; the
 * reward is prepaid into a SAP escrow vault, released on a PASS verdict, refunded
 * on a FAIL). The USDC rail is triple-gated OFF + dry-run by default — a
 * `payment_rail='usdc'` bounty simulates the escrow legs and NEVER moves real
 * money until a deliberate founder flip. Default `'ct'` so every existing bounty
 * and the whole live CT board are unchanged.
 */
export const bountyPaymentRailEnum = pgEnum('bounty_payment_rail', [
  'ct',
  'usdc',
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
    .references(() => avatars.id, { onDelete: 'cascade' }),
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

  // ── Phase 1: acceptance criteria + USDC escrow linkage (ALL additive) ────────
  // These columns are NULL/default for every existing CT bounty; only a
  // `payment_rail='usdc'` bounty populates the escrow/verdict fields.
  //
  /**
   * Human/agent-readable acceptance criteria the verdict is judged against.
   * MANDATORY for a `payment_rail='usdc'` bounty (a verdict with nothing to
   * verify against is scaffolding theater — the route rejects a USDC bounty
   * without it). Optional/NULL for a classic CT bounty.
   */
  acceptanceCriteria: text('acceptance_criteria'),
  /** Which payout rail funds this bounty. Default 'ct' (the live CT board). */
  paymentRail: bountyPaymentRailEnum('payment_rail').default('ct').notNull(),

  // ── SAP escrow binding (only for payment_rail='usdc') ────────────────────────
  /**
   * The on-chain SAP escrow PDA (base58) this bounty's reward is escrowed into.
   * Set at create time when the depositor (=creator) opens the USDC escrow.
   * NULL for a CT bounty or a USDC bounty whose escrow open failed/was skipped
   * (dry-run open that never recorded a PDA). Combined with `escrow_job_id` it
   * is the (escrow, job) key the SAP settlement ledger is idempotent on.
   */
  escrowPda: varchar('escrow_pda', { length: 64 }),
  /**
   * The off-chain job id half of the (escrow, job) SAP idempotency key. We bind
   * it to the bounty id (`jobId === bounties.id`) so the SAP ledger's
   * at-most-once-settle guard maps 1:1 to a bounty. Persisted here for a clean
   * lookup without re-deriving.
   */
  escrowJobId: varchar('escrow_job_id', { length: 128 }),

  // ── verdict provenance (v1 = requester/admin approval; Phase 3 = Covenant) ───
  /**
   * The SAP settlement row's audit-root hex (the verification provider's 32-byte
   * root, bound into the on-chain service_hash). Recorded on the bounty for a
   * one-glance provenance trail. Phase 3 replaces the v1 requester-approval root
   * with a Covenant `root_hash_hex` via the SAME VerificationProvider seam.
   */
  covenantAuditRootHex: varchar('covenant_audit_root_hex', { length: 64 }),
  /**
   * The verdict outcome: true = PASS (settle fired / simulated), false = FAIL
   * (refund path), NULL = not yet judged. Distinct from `status` so a reviewer
   * decision is recorded even before the escrow leg resolves.
   */
  covenantVerificationPassed: boolean('covenant_verification_passed'),
  /**
   * A verdict-id handle for the external verification record (Phase 3 Covenant
   * verdict id). NULL under v1 requester-approval (no external verdict). Reserved
   * so a `CovenantVerificationProvider` drops in without a schema change.
   */
  covenantVerdictId: varchar('covenant_verdict_id', { length: 128 }),
  /**
   * When true, this bounty REQUIRES a recorded verdict before its reward can be
   * released (the escrow settle gate). Defaults true for a USDC bounty (set at
   * create), false for a classic CT bounty (whose release is the existing
   * creator-review approve). Kept explicit so the release path can branch on it.
   */
  verdictRequired: boolean('verdict_required').default(false).notNull(),

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
  // NOTE: the 'skill' bounty_reward_type enum value is now UNUSED (peer skill
  // commerce removed 2026-07-02) — left in place because dropping a pg enum
  // value requires a migration we are not running. No route ever writes it.
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
    .references(() => avatars.id, { onDelete: 'cascade' }),
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
  avatarId: uuid('avatar_id')
    .notNull()
    .unique()
    .references(() => avatars.id, { onDelete: 'cascade' }),
  tier: reputationTierEnum('tier').default('newcomer').notNull(),
  totalCompleted: integer('total_completed').default(0).notNull(),
  totalEarned: integer('total_earned').default(0).notNull(),
  totalPosted: integer('total_posted').default(0).notNull(),
  successRate: integer('success_rate').default(100).notNull(),
  lastActivityAt: timestamp('last_activity_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
