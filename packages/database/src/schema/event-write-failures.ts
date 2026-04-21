import {
  pgTable,
  bigserial,
  timestamp,
  text,
  jsonb,
  boolean,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Safety net for the events pipeline.
 *
 * When a primary insert into `events` fails (bad data, constraint violation,
 * transient pooler hiccup), logEvent() attempts to persist the failure here
 * with the original intended row + error details. Nothing is silently lost
 * unless BOTH writes fail — that case falls through to console.warn +
 * immediate Telegram alert via alertError().
 *
 * Columns retriedAt + retrySucceeded exist so a future replay script can
 * walk unretried rows, re-insert into `events`, and mark them as retried
 * — without requiring a migration at that time.
 *
 * The partial index `idx_event_write_failures_unretried` keeps the replay
 * working set tiny: only unretried failures are indexed, making the scan
 * fast even as the full table grows.
 */
export const eventWriteFailures = pgTable(
  'event_write_failures',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
    attemptedEventType: text('attempted_event_type'),
    attemptedRow: jsonb('attempted_row'),
    errorMessage: text('error_message'),
    errorStack: text('error_stack'),
    retriedAt: timestamp('retried_at', { withTimezone: true }),
    retrySucceeded: boolean('retry_succeeded'),
  },
  (t) => ({
    idxTs: index('idx_event_write_failures_ts').on(t.ts.desc()),
    idxUnretried: index('idx_event_write_failures_unretried')
      .on(t.ts.desc())
      .where(sql`retried_at IS NULL`),
  }),
);
