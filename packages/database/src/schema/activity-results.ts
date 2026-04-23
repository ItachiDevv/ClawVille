import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { activities } from './activities';
import { activityRooms } from './activity-rooms';
import { avatars } from './avatars';

/**
 * Q2 Activity Portals §7 — one row per participant per completed match.
 *
 * Backs both the per-activity leaderboards (live aggregation, no snapshot
 * table in Q2) and the free-agent leaderboard (via `activity.match.placed`
 * events emitted alongside).
 *
 * Score semantics (activity-specific):
 *   - Bumper Shells: `score` = kills/eliminations, `score_ms` = NULL
 *   - Reef Race:     `score` = -finishMs (so DESC sorts winners first),
 *                    `score_ms` = finish time (for the "Fastest" tab)
 *
 * `tokens_awarded` is the actual ClawToken credit recorded on this match
 * (after first-play-of-day + focus + PB bonuses). `leaderboard_points`
 * are the activity-leaderboard points for the placement tier.
 *
 * Indexes (per backend §7.3):
 *   (activity_id, placement, created_at DESC) — leaderboard window scans
 *   (avatar_id, created_at DESC)                 — "my recent results"
 *   (activity_id, score_ms ASC) WHERE score_ms IS NOT NULL — Reef fast-time
 */
export const activityResults = pgTable(
  'activity_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => activityRooms.id),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id),
    /** Populated when subject_type='agent' */
    agentId: text('agent_id'),
    /** 'human' | 'agent' | 'bot' */
    subjectType: text('subject_type').notNull(),
    placement: integer('placement').notNull(),
    /** Activity-specific scalar (kills, -ms, etc.) */
    score: integer('score').notNull(),
    /** Reef Race finish time in ms; NULL otherwise */
    scoreMs: integer('score_ms'),
    tokensAwarded: integer('tokens_awarded').notNull().default(0),
    leaderboardPoints: integer('leaderboard_points').notNull().default(0),
    isPersonalBest: boolean('is_personal_best').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    activityPlacementIdx: index('idx_activity_results_activity_placement').on(
      t.activityId,
      t.placement,
      t.createdAt.desc(),
    ),
    petCreatedIdx: index('idx_activity_results_pet_created').on(
      t.avatarId,
      t.createdAt.desc(),
    ),
    fastTimeIdx: index('idx_activity_results_fast_time')
      .on(t.activityId, t.scoreMs)
      .where(sql`score_ms IS NOT NULL`),
  }),
);

export type ActivityResult = typeof activityResults.$inferSelect;
export type NewActivityResult = typeof activityResults.$inferInsert;
