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
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { avatars } from './avatars';

export const tutorialQuestClaims = pgTable(
  'tutorial_quest_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    questId: text('quest_id').notNull(),
    tokensCredited: integer('tokens_credited').notNull(),
    /** Echoed from the source-of-truth claw_token_transactions.id for cross-ref. */
    ledgerId: uuid('ledger_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniqUserQuest: uniqueIndex('uniq_tutorial_quest_claim_user_quest').on(
      t.userId,
      t.questId,
    ),
  }),
);
