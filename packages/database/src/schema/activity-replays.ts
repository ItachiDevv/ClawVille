import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { activities } from './activities';
import { activityRooms } from './activity-rooms';

/**
 * Q2 Activity Portals §7 — input log per match.
 *
 * Write-only today: no code reads this table (checked 2026-10-20). Planned
 * uses were post-hoc anti-cheat audit and bot controller baselines. Reef
 * Race personal-best ghosts do NOT come from here; they live in
 * `reef_race_personal_bests.ghost_replay_data`.
 *
 * `frames` is a compressed JSONB array of input frames (typed as
 * `unknown[]` here; shape is owned by the activity-replay-log service).
 * `participants` snapshots avatarId → display info (color/species/name) so
 * the replay viewer can render without re-fetching live avatar rows that
 * may have changed.
 *
 * Retention: 14 days. Pruned daily by
 * `apps/api/src/services/activity/activity-replay-prune.ts`. The only
 * index is `(activity_id, created_at DESC)`; the prune's `created_at <`
 * scan has no leading-column index (fine at current size).
 *
 * One replay per room (UNIQUE on room_id + ON DELETE CASCADE so dropping
 * a room cascades the replay).
 */
export interface ActivityReplayParticipantsJson {
  [avatarId: string]: {
    name?: string;
    color?: string;
    species?: string;
    modelKey?: string;
    subjectType?: 'human' | 'agent' | 'bot';
  };
}

export const activityReplays = pgTable(
  'activity_replays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .unique()
      .references(() => activityRooms.id, { onDelete: 'cascade' }),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id),
    /** Compressed input log — shape owned by activity-replay-log service */
    frames: jsonb('frames').$type<unknown[]>().notNull(),
    /** Snapshot of avatar display info at match time */
    participants: jsonb('participants')
      .$type<ActivityReplayParticipantsJson>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    activityCreatedIdx: index('idx_activity_replays_activity_created').on(
      t.activityId,
      t.createdAt.desc(),
    ),
  }),
);

export type ActivityReplay = typeof activityReplays.$inferSelect;
export type NewActivityReplay = typeof activityReplays.$inferInsert;
