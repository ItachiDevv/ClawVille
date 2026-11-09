/**
 * Vendor calls per avatar per UTC day for the market and trust reads (migration
 * 0098, MCP hub 2026-11-07). One atomic upsert in
 * `apps/api/src/services/ecosystem-reads.ts` checks the budget and counts the
 * call before the vendor is called. A reply from the shared cache writes nothing.
 */

import { date, integer, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { avatars } from './avatars';

export const ecosystemReadUsage = pgTable(
  'ecosystem_read_usage',
  {
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    calls: integer('calls').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ name: 'ecosystem_read_usage_pkey', columns: [t.avatarId, t.day] }),
  }),
);
