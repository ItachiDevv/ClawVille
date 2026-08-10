/**
 * Reef Race Phase 4 — per-avatar personal-best lap + ghost replay.
 *
 * One row per (avatar, activity) holding the FASTEST single lap that avatar
 * has ever set in a given racing activity, plus the captured ghost
 * replay frames at 5 Hz for client-side playback.
 *
 * Distinct from `activity_results` (one row per FINISHED match): this
 * stores per-LAP best (a sub-event of a match) and a JSONB ghost replay
 * blob (~5 KB) that doesn't belong on the per-match row hot path.
 *
 * Writes: gated by `maybeUpdatePersonalBest` (apps/api/src/services/activity/
 * reef-race-personal-best-service.ts). Atomic compare-and-set via
 * `INSERT ... ON CONFLICT (avatar_id, activity_id) DO UPDATE WHERE
 * EXCLUDED.best_lap_ms < reef_race_personal_bests.best_lap_ms`.
 *
 * Reads:
 *   - Snapshot.init carries the self avatar's ghost frames (RoomMeta.selfBestLapGhost).
 *   - `/api/leaderboard/reef-race/daily-best-lap` aggregates over the last
 *     24h ordered by `best_lap_ms ASC`.
 *   - `/api/activities/:id/rooms/:roomId/results` joins to surface
 *     `match_pb_daily_rank` on the per-match row written by the reward
 *     pipeline at PB-write time.
 *
 * Anti-cheat: see §4.4 in the Phase 4 plan — sub-MIN_LAP_MS laps never
 * reach this table (sim discards them); avatars with anti-cheat flags this
 * match are skipped at the reward-pipeline call site; bots and guests
 * are excluded via subject-type filters in the daily-best-lap SQL.
 *
 * Spec: `.claude/plans/reef-race-phase4-detailed.md` §1.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';
import { activityRooms } from './activity-rooms';

export const reefRacePersonalBests = pgTable(
  'reef_race_personal_bests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id),
    /**
     * Always 'reef-race' today; column kept for forward-compat parity with
     * `activity_results.activity_id` (avoids a future rename if a second
     * racing activity ships).
     */
    activityId: text('activity_id').notNull().default('reef-race'),
    /** Best single-lap time in ms. */
    bestLapMs: integer('best_lap_ms').notNull(),
    /** Wall-clock when the lap was set. */
    bestLapRecordedAt: timestamp('best_lap_recorded_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * `room_id` of the match where the PB was set. Audit / future replay
     * link target. Nullable so support tooling can manually backfill.
     */
    sourceRoomId: uuid('source_room_id').references(() => activityRooms.id),
    /**
     * Captured ghost-replay frames, JSONB.
     *
     * Shape (mirrors `GhostFrame` in @clawville/shared):
     *   { frames: Array<{ t: number; x: number; z: number; rot: number }> }
     *
     * 5 Hz capture × ~30 sec fastest lap = ~150 frames; 200 frames worst
     * case = ~5 KB after JSONB packing. Hard cap of 250 frames per lap
     * enforced sim-side via FIFO drop.
     */
    ghostReplayData: jsonb('ghost_replay_data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /** One PB per (avatar, activity). Replaced (not appended) on improvement. */
    avatarActivityUq: uniqueIndex('uq_reef_race_pb_avatar_activity').on(
      t.avatarId,
      t.activityId,
    ),
    /**
     * Composite index for both:
     *   - daily-best-lap window scan (best_lap_recorded_at > NOW() - 24h
     *     ORDER BY best_lap_ms ASC)
     *   - per-PB dailyRank scan (count(*) WHERE best_lap_ms < $1
     *     AND best_lap_recorded_at > $cutoff)
     * Partial on activity_id = 'reef-race' to keep the index lean while
     * the table is single-activity. When a second racing activity ships,
     * drop the partial predicate in a follow-up migration.
     */
    recordedAtIdx: index('idx_reef_race_pb_recorded_lap')
      .on(t.bestLapRecordedAt.desc(), t.bestLapMs.asc())
      .where(sql`activity_id = 'reef-race'`),
  }),
);

/**
 * Append-only ownership record for every room that actually lowered an
 * avatar's Reef Race best lap. Unlike `reef_race_personal_bests`, these rows
 * are never replaced by a later/faster room, so reward settlement can prove a
 * prior room's earned PB claim after a crash or retry.
 */
export const reefRacePersonalBestClaims = pgTable(
  'reef_race_personal_best_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceRoomId: uuid('source_room_id')
      .notNull()
      .references(() => activityRooms.id),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id),
    activityId: text('activity_id').notNull().default('reef-race'),
    bestLapMs: integer('best_lap_ms').notNull(),
    previousBestLapMs: integer('previous_best_lap_ms'),
    dailyRank: integer('daily_rank'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    roomAvatarUq: uniqueIndex('uq_reef_race_pb_claim_room_avatar').on(
      t.sourceRoomId,
      t.avatarId,
    ),
    avatarCreatedIdx: index('idx_reef_race_pb_claim_avatar_created').on(
      t.avatarId,
      t.createdAt.desc(),
    ),
  }),
);

export type ReefRacePersonalBest = typeof reefRacePersonalBests.$inferSelect;
export type NewReefRacePersonalBest = typeof reefRacePersonalBests.$inferInsert;
export type ReefRacePersonalBestClaim =
  typeof reefRacePersonalBestClaims.$inferSelect;
export type NewReefRacePersonalBestClaim =
  typeof reefRacePersonalBestClaims.$inferInsert;
