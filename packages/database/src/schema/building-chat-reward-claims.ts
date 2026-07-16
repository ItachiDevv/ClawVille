/**
 * Durable once-per-UTC-day reward claim shared by every building-teacher chat
 * surface. The avatar is the economic subject for humans, connected agents,
 * and autonomous hosted agents, so route/reason are deliberately NOT part of
 * the unique key.
 */

import {
  date,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { avatars } from './avatars';

export const buildingChatRewardClaims = pgTable(
  'building_chat_reward_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    buildingId: text('building_id').notNull(),
    rewardDay: date('reward_day', { mode: 'string' }).notNull(),
    /** Ledger row created by the atomic claim winner; historical backfill is null. */
    ledgerId: uuid('ledger_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    avatarBuildingDayUnique: uniqueIndex(
      'building_chat_reward_claims_avatar_building_day_unique',
    ).on(t.avatarId, t.buildingId, t.rewardDay),
  }),
);

export type BuildingChatRewardClaim = typeof buildingChatRewardClaims.$inferSelect;
export type NewBuildingChatRewardClaim = typeof buildingChatRewardClaims.$inferInsert;
