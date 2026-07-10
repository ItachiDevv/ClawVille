import {
  pgTable,
  bigserial,
  timestamp,
  text,
  uuid,
  jsonb,
  boolean,
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
    /**
     * DURABLE guest stamp (2026-07-10) — frozen at event write time by
     * `event-logger.ts` from the subject's `users.is_guest` (the SoT). The
     * free-agent leaderboard CTE treats this frozen fact as AUTHORITATIVE: per
     * leg `subject_was_guest = false OR (subject_was_guest IS NULL AND NOT
     * EXISTS(<live is_guest join>))`. So `true` is excluded and `false` KEEPS
     * ranking even after ownership changes (a bot rebind via `/connect` or a
     * guest-account delete), which the live join alone could not survive; the
     * live join is consulted ONLY for NULL rows (pre-stamp / a write-time lookup
     * that couldn't resolve). Guest-ness is immutable per-user (no in-place
     * guest→real conversion), so a write-time stamp and a read-time lookup agree.
     */
    subjectWasGuest: boolean('subject_was_guest'),
    /**
     * Phase 1 anti-farm — sha256(FINGERPRINT_SECRET || browser_fp).
     * Permanent, ClawVille-scoped (server secret never leaves DB), never
     * rotated, so a farm running multi-day is detectable. Pre-Phase-1
     * rows are NULL; daily-cap squashing applies forward only.
     */
    fpHash: text('fp_hash'),
    /**
     * Phase 1 anti-farm — sha256(FINGERPRINT_SECRET || ip_first_3_octets).
     * Coarse /24 range so a single user behind dynamic IPs (mobile) keeps a
     * stable bucket while a single VPS hosting multiple agents collides into
     * one prefix and gets squashed by the daily cap.
     */
    ipPrefixHash: text('ip_prefix_hash'),
  },
  (t) => ({
    idxTypeTs: index('idx_events_type_ts').on(t.eventType, t.ts.desc()),
    idxAgentTs: index('idx_events_agent_ts').on(t.agentId, t.ts.desc()),
    idxAvatarTs: index('idx_events_avatar_ts').on(t.avatarId, t.ts.desc()),
    idxBuildingTs: index('idx_events_building_ts').on(t.buildingId, t.ts.desc()),
  }),
);
