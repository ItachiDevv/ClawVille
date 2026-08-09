/**
 * Q3 plan §2.6 — idempotency table for client-side tutorial quest rewards.
 *
 * The 8+ tutorial quests defined in apps/web/src/lib/quests.ts are CLIENT-
 * tracked (counters in zustand persist), but their token rewards must
 * settle on the server-side ledger. This table records "user X has claimed
 * tutorial quest Y" exactly once.
 *
 * Unique (userId, questId) — second claim on the same user/quest pair gets
 * 409 Conflict, no double-credit, no rollback needed.
 *
 * NOTE: this is distinct from `quests.questRewards` which tracks the
 * admin-curated PR-submission quest system. Tutorial quests are a separate
 * client-side onboarding checklist with no PR submission. See
 * GameFeatures.md §6 for the two-layer model.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { avatars } from './avatars';

export const tutorialQuestClaims = pgTable(
  'tutorial_quest_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Nullable so the AVATAR is the authority (migration 0054), not so unbound
     * actors can claim — every admitted claimer still resolves through
     * `requireAuthOrAgentSession` to a bound avatar whose agent has a
     * NOT NULL `platform_agents.user_id`. In practice this stays populated.
     */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    questId: text('quest_id').notNull(),
    /** vCLAW rail. Exactly one of this and `materialsCredited` is > 0. */
    tokensCredited: integer('tokens_credited').notNull(),
    /** Materials rail (land quests). Exactly one rail is > 0 — DB CHECK. */
    materialsCredited: integer('materials_credited').notNull().default(0),
    /**
     * Echoed from the source-of-truth claw_token_transactions.id for cross-ref.
     * Always null on the materials rail: materials have no transaction ledger,
     * this row IS their audit record.
     */
    ledgerId: uuid('ledger_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /**
     * THE authoritative idempotency barrier. `avatars.userId` is UNIQUE, so
     * this is strictly equivalent to the old (user_id, quest_id) index for
     * human claims while also binding an agent claiming as its own avatar.
     */
    uniqAvatarQuest: uniqueIndex('uniq_tutorial_quest_claim_avatar_quest').on(
      t.avatarId,
      t.questId,
    ),
    rewardNonNeg: check(
      'tutorial_claim_reward_nonneg',
      sql`${t.tokensCredited} >= 0 AND ${t.materialsCredited} >= 0`,
    ),
    singleRail: check(
      'tutorial_claim_single_rail',
      sql`(${t.tokensCredited} > 0) <> (${t.materialsCredited} > 0)`,
    ),
  }),
);
