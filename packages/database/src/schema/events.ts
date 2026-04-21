import {
  pgTable,
  bigserial,
  timestamp,
  text,
  uuid,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { avatars } from './avatars';

/**
 * Append-only analytics spine.
 *
 * Every meaningful app action writes one row here. The dashboard at /dash
 * reads from this table exclusively — no historical derivation from
 * domain tables, no per-event specialized tables. One shape, flexible
 * jsonb payload, indexed for the queries we actually run.
 *
 * Retention: no prune, revisit if row count crosses 10M. See improvements.md §6.
 *
 * See apps/api/src/services/event-logger.ts for the write path and
 * apps/api/src/routes/dashboard.ts for the read path.
 */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
    eventType: text('event_type').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    agentId: text('agent_id'),
    avatarId: uuid('avatar_id').references(() => avatars.id, { onDelete: 'set null' }),
    buildingId: text('building_id'),
    sessionId: text('session_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
  },
  (t) => ({
    idxTypeTs: index('idx_events_type_ts').on(t.eventType, t.ts.desc()),
    idxAgentTs: index('idx_events_agent_ts').on(t.agentId, t.ts.desc()),
    idxPetTs: index('idx_events_pet_ts').on(t.avatarId, t.ts.desc()),
    idxBuildingTs: index('idx_events_building_ts').on(t.buildingId, t.ts.desc()),
  }),
);
