import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { activityRooms } from './activity-rooms';
import { pets } from './pets';

/**
 * Q2 Activity Portals §7 — who was in each room.
 *
 * Composite PK `(room_id, pet_id)` — one row per participant per room.
 * `subject_type` distinguishes 'human' | 'agent' | 'bot':
 *   - 'human'  — Lucia-authed user playing as their pet
 *   - 'agent'  — agent-session-authed (Phase 5.1) playing as their bound pet
 *   - 'bot'    — system-spawned bot backfill (placeholder petIds 'bot-000'..)
 *
 * `agent_id` is populated when subject_type='agent' so the WS hub can
 * apply per-agent rate limits and so leaderboard queries can compute
 * agent-vs-agent collaboration credit.
 *
 * `pet_id` MUST exist in `pets` even for bots — the matcher uses a
 * reserved pool of placeholder pet rows for that. (Confirmed Q2 design;
 * keeps the FK clean.)
 *
 * Index: (pet_id, joined_at DESC) drives "my recent rooms" lookup.
 */
export const activityRoomParticipants = pgTable(
  'activity_room_participants',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => activityRooms.id, { onDelete: 'cascade' }),
    petId: uuid('pet_id')
      .notNull()
      .references(() => pets.id),
    /** Populated when subject_type='agent' */
    agentId: text('agent_id'),
    /** 'human' | 'agent' | 'bot' */
    subjectType: text('subject_type').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roomId, t.petId] }),
    petJoinedIdx: index('idx_arp_pet_joined').on(t.petId, t.joinedAt.desc()),
  }),
);

export type ActivityRoomParticipant = typeof activityRoomParticipants.$inferSelect;
export type NewActivityRoomParticipant = typeof activityRoomParticipants.$inferInsert;
