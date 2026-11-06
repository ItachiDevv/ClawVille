/**
 * Per-avatar spend rules for paid third-party tools (migration 0089, MCP hub
 * step 2 phase 1). Written ONLY by `apps/api/src/services/spend-policy.ts`
 * from a human Lucia session; agents read it. NULL caps mean "not set yet":
 * every paid call is refused until the human chooses a cap.
 */

import { boolean, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { avatars } from './avatars';
import { users } from './users';

export const userSpendPolicies = pgTable('user_spend_policies', {
  avatarId: uuid('avatar_id')
    .primaryKey()
    .references(() => avatars.id, { onDelete: 'cascade' }),
  dailyCapUsdCents: integer('daily_cap_usd_cents'),
  perCallCapUsdCents: integer('per_call_cap_usd_cents'),
  allowedVendors: text('allowed_vendors').array().notNull().default([]),
  /** Studios images per UTC day on the human's own key (migration 0092); NULL = the code default. */
  studiosKeyImagesPerDay: integer('studios_key_images_per_day'),
  /** "Ask me before each payment" (migration 0093): agent requests wait for the human. */
  requireApproval: boolean('require_approval').notNull().default(false),
  /** Per-UTC-day counts per Studios operation class, key AND wallet mode (migration 0095); NULL = the code default, 0 = off. */
  studiosVideosPerDay: integer('studios_videos_per_day'),
  studiosCharacterShotsPerDay: integer('studios_character_shots_per_day'),
  studiosRecastsPerDay: integer('studios_recasts_per_day'),
  /** Who pays for a Studios call (migration 0096): 'wallet' | 'key' | 'signin'; NULL = the saved key if any, else the wallet. */
  studiosPayMode: varchar('studios_pay_mode', { length: 16 }),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type UserSpendPolicy = typeof userSpendPolicies.$inferSelect;
