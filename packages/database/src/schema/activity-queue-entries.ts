import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { activities } from './activities';
import { activityRooms } from './activity-rooms';
import { avatars } from './avatars';

/**
 * Q2 Activity Portals §7 — persisted queue entries.
 *
 * In-memory per-activity queues drive matchmaking, but every entry also
 * lands here so a pod restart doesn't drop queued players. On boot the
 * queue re-hydrates from rows where `left_at IS NULL` and fast-prunes
 * entries without a live WS.
 *
 * `party_id` groups party entries atomically (all or none).
 * `matched_room_id` is filled when the matcher allocates the player into
 * a room; combined with `left_at` it records the exact terminal state.
 *
 * Indexes (per backend §7.3):
 *   (activity_id, queued_at) WHERE left_at IS NULL — matcher sweep
 *   (avatar_id, queued_at DESC)                        — "my queue history"
 */
export const activityQueueEntries = pgTable(
  'activity_queue_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id),
    /** Populated when subject_type='agent' */
    agentId: text('agent_id'),
    /** 'human' | 'agent' */
    subjectType: text('subject_type').notNull(),
    /** Null = solo queue; non-null = atomic party entry */
    partyId: uuid('party_id'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).defaultNow().notNull(),
    /** Null while waiting; set when matched/left/timed out */
    leftAt: timestamp('left_at', { withTimezone: true }),
    matchedRoomId: uuid('matched_room_id').references(() => activityRooms.id),
  },
  (t) => ({
    activeQueueIdx: index('idx_activity_queue_active')
      .on(t.activityId, t.queuedAt)
      .where(sql`left_at IS NULL`),
    petQueueIdx: index('idx_activity_queue_pet').on(
      t.avatarId,
      t.queuedAt.desc(),
    ),
  }),
);

export type ActivityQueueEntry = typeof activityQueueEntries.$inferSelect;
export type NewActivityQueueEntry = typeof activityQueueEntries.$inferInsert;
