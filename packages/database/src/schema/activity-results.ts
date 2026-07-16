import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
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
 *   (avatar_id, created_at DESC)              — "my recent results"
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
    /**
     * Chunk #7 — set when the result owner has acknowledged seeing this
     * row in the recent-results UX (POST
     * /api/activities/results/:resultId/acknowledge). Idempotent — second
     * call is a no-op. Drives the "new results!" badge.
     *
     * Nullable + defaults missing so the additive 0003 migration backfills
     * existing rows as "unseen".
     */
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    /**
     * Phase 4 (Reef Race only) — best consecutive clean checkpoint
     * crosses this match. Null for other activities. Embedded on the
     * per-match row so `/results` can return it without a JOIN, and so
     * the dashboard can aggregate without back-tracking through events.
     *
     * S3 fix: renamed from `best_streak` to `match_best_streak` to
     * disambiguate from a hypothetical "personal best streak" (which
     * isn't tracked yet).
     */
    matchBestStreak: integer('match_best_streak'),
    /**
     * Phase 4 (Reef Race only) — daily-best-lap rank (1..100) earned by
     * this match if it set a new PB. Null when the match did NOT set a
     * new PB OR rank was off-board (>100). Sourced from
     * `maybeUpdatePersonalBest`'s indexed scan against the freshly-
     * written PB row (C2 fix — never the cached daily snapshot).
     */
    matchPbDailyRank: integer('match_pb_daily_rank'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    roomAvatarUnique: uniqueIndex('activity_results_room_avatar_unique').on(
      t.roomId,
      t.avatarId,
    ),
    activityPlacementIdx: index('idx_activity_results_activity_placement').on(
      t.activityId,
      t.placement,
      t.createdAt.desc(),
    ),
    avatarCreatedIdx: index('idx_activity_results_avatar_created').on(
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
