import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Q2 Activity Portals §7 — season resets for activity leaderboards.
 *
 * The `season` window on `GET /api/activities/:id/leaderboard` filters
 * `activity_results.created_at BETWEEN active.started_at AND ends_at`.
 * Past seasons are preserved as `active=false` rows (no data loss; they
 * become a hall-of-fame readable via `GET /api/activities/seasons`).
 *
 * `activity_ids` (text[]) lists which activities participate in a given
 * season — some activities may run "all-time only" and stay out of any
 * seasonal cycle.
 *
 * First season starts the day Activity Portals ship. **Locked duration:
 * 30 days** (per plan resolved-decisions §3).
 *
 * The activity_ids column uses a TS-modeled text[] (Drizzle `text(...)
 * .array()`).
 */
export const activitySeasons = pgTable('activity_seasons', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  /** Which activity ids this season covers */
  activityIds: text('activity_ids').array().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  active: boolean('active').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type ActivitySeason = typeof activitySeasons.$inferSelect;
export type NewActivitySeason = typeof activitySeasons.$inferInsert;
