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
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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
 * How a bounty pays out. `'vclaw'` = the in-game vCLAW escrow (creator's vCLAW is
 * debited at create, released to the hunter on approve). `'usdc'` = the Tier-1
 * custodial-balance hold settled through PayAI agent-pay. Default `'vclaw'` for
 * the live in-game bounty board.
 */
export const bountyPaymentRailEnum = pgEnum('bounty_payment_rail', [
  'vclaw',
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
  // These columns are NULL/default for every existing vCLAW bounty; only a
  // `payment_rail='usdc'` bounty populates the escrow/verdict fields.
  //
  /**
   * Human/agent-readable acceptance criteria the verdict is judged against.
   * MANDATORY for a `payment_rail='usdc'` bounty (a verdict with nothing to
   * verify against is scaffolding theater — the route rejects a USDC bounty
   * without it). Optional/NULL for an in-game vCLAW bounty.
   */
  acceptanceCriteria: text('acceptance_criteria'),
  /** Which payout rail funds this bounty. Default 'vclaw' (the live in-game board). */
  paymentRail: bountyPaymentRailEnum('payment_rail').default('vclaw').notNull(),

  // Legacy escrow identifiers retained for Covenant compatibility reads.
  /**
   * Historical on-chain escrow PDA (base58). No current bounty path writes it.
   * Combined with `escrow_job_id`, it keys retained settlement evidence.
   */
  escrowPda: varchar('escrow_pda', { length: 64 }),
  /**
   * Historical off-chain job id half of the retained (escrow, job) lookup key.
   */
  escrowJobId: varchar('escrow_job_id', { length: 128 }),

  // Legacy composed-rail identifier retained for historical row compatibility.
  /**
   * Historical PayAI payout escrow PDA (base58). No current bounty path writes it.
   */
  payoutEscrowPda: varchar('payout_escrow_pda', { length: 64 }),

  // ── LEGACY composed-rail evidence (SAP removal 2026-08-20) ───────────────────
  // No runtime reader or writer. Kept DECLARED so `db:push` can never silently
  // drop the historical reconciliation evidence before the deliberate, separate
  // drop migration removes the physical columns and this block together.
  compositionState: varchar('composition_state', { length: 32 }),
  compositionRefundSignature: varchar('composition_refund_signature', { length: 128 }),
  compositionRefundClaimId: uuid('composition_refund_claim_id'),
  compositionRefundClaimedAt: timestamp('composition_refund_claimed_at', {
    withTimezone: true,
  }),
  // ── verdict provenance (v1 = requester/admin approval; Phase 3 = Covenant) ───
  /**
   * Covenant audit-root hex retained for the partner verification read surface.
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
   * create), false for an in-game vCLAW bounty (whose release is the existing
   * creator-review approve). Kept explicit so the release path can branch on it.
   */
  verdictRequired: boolean('verdict_required').default(false).notNull(),

  expiresAt: timestamp('expires_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  // LEGACY (SAP removal 2026-08-20): both CHECKs still exist physically; kept
  // declared beside the legacy columns above until the deliberate drop migration.
  compositionRefundClaimLeasePair: check(
    'bounties_composition_refund_claim_lease_pair',
    sql`(${t.compositionRefundClaimId} IS NULL) = (${t.compositionRefundClaimedAt} IS NULL)`,
  ),
  compositionRefundReconcileHasSignature: check(
    'bounties_composition_refund_reconcile_has_signature',
    sql`${t.compositionState} <> 'reconcile_refund_unknown' OR ${t.compositionRefundSignature} IS NOT NULL`,
  ),
}));

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
