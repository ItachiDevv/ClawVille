import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { avatars } from './avatars';

/**
 * Q2 Activity Portals §7 — party system.
 *
 * Two tables co-located in this file (mirrors the auctions / bounties
 * convention of pairing a parent table with its join table when they're
 * always read together).
 *
 * `activity_parties` — one row per party (max 4 members, leader-owned).
 *   `short_code` is a 6-char base32-crockford code shared out-of-band
 *   so members can join via `POST /api/activities/party/:shortCode/join`.
 *   `disbanded_at` is set when the party empties or is GC'd after 1h
 *   of idle (no match joined, no chat activity).
 *
 * `activity_party_members` — join table, composite PK `(party_id, avatar_id)`.
 *   `left_at` is set on voluntary leave / kick. The party row is kept
 *   for audit/history.
 */
export const activityParties = pgTable('activity_parties', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 6-char base32-crockford share code, unique across active parties */
  shortCode: varchar('short_code', { length: 10 }).notNull().unique(),
  leaderAvatarId: uuid('leader_avatar_id')
    .notNull()
    .references(() => avatars.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  disbandedAt: timestamp('disbanded_at', { withTimezone: true }),
});

export type ActivityParty = typeof activityParties.$inferSelect;
export type NewActivityParty = typeof activityParties.$inferInsert;

export const activityPartyMembers = pgTable(
  'activity_party_members',
  {
    partyId: uuid('party_id')
      .notNull()
      .references(() => activityParties.id, { onDelete: 'cascade' }),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.partyId, t.avatarId] }),
  }),
);

export type ActivityPartyMember = typeof activityPartyMembers.$inferSelect;
export type NewActivityPartyMember = typeof activityPartyMembers.$inferInsert;
