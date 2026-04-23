import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Q2 Activity Portals §7 — `activities` catalog.
 *
 * Static/semi-static catalog of available minigames. One row per
 * registered activity (e.g. `bumper-shells`, `reef-race`). Seeded via
 * `scripts/seed-activities.ts` and rarely updated.
 *
 * - `building_id` informally references `map_locations.id` but is NOT a
 *   FK so standalone activities (not tied to a specific building) can
 *   be added later without schema churn.
 * - `reward_config` carries the per-activity payout schedule — placements,
 *   participation floor, first-play-of-day bonus, focus-alignment bonus,
 *   leaderboard point tiers. See plan "Rewards (LOCKED)" + backend §5.3.
 * - `enabled = false` entries still render as "coming soon" stubs; the
 *   frontend `ACTIVITY_REGISTRY` mirrors this with a `status` field.
 */
export interface ActivityRewardPlacement {
  rank: number;
  tokens: number;
}

export interface ActivityRewardConfig {
  placements?: ActivityRewardPlacement[];
  participationTokens?: number;
  firstPlayOfDayBonusTokens?: number;
  personalBestBonusTokens?: number;
  focusBonusPct?: number;
  leaderboardPoints?: Record<string, number>;
}

export const activities = pgTable('activities', {
  /** Text PK, e.g. 'bumper-shells', 'reef-race' */
  id: text('id').primaryKey(),
  /** Home building — informal reference to map_locations.id (not a FK) */
  buildingId: text('building_id').notNull(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  description: text('description').notNull(),
  minPlayers: integer('min_players').notNull(),
  maxPlayers: integer('max_players').notNull(),
  preferredPlayers: integer('preferred_players').notNull(),
  /** Per-activity payout schedule — see §5.3 */
  rewardConfig: jsonb('reward_config').$type<ActivityRewardConfig>().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Activity = typeof activities.$inferSelect;
export type NewActivity = typeof activities.$inferInsert;
