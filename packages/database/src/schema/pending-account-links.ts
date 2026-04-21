import {
  pgTable,
  varchar,
  uuid,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

/**
 * Phase 5.1 §15 — pending account-linking challenges.
 *
 * When a ClawVille user wants to link an existing partner-world account
 * (today only 'scape; tomorrow any federated partner), we mint a
 * one-time short-TTL code here and display it to the user. They paste
 * the code into the partner world's "Link External Account" UI, which
 * POSTs back to ClawVille's `/api/portal/accept-<world>-link` with a
 * partner-signed payload. We verify the signature, look up the code,
 * and write the linked_<world>_* columns on the users table.
 *
 * Rows are one-shot: a successful link updates `consumed_at` and the
 * row is retained as audit history (do NOT delete on consume — the
 * events table references this for observability).
 *
 * Expiry is short (10 min per plan §15.2) to limit leaked-code attacks.
 * The partial "active" index keeps scanning fast for the code-lookup
 * query even if the table grows long-term.
 */
export const pendingAccountLinks = pgTable(
  'pending_account_links',
  {
    /** Link code — e.g. "link-7fj3k". PRIMARY KEY so consumption is atomic. */
    code: varchar('code', { length: 32 }).primaryKey(),
    /** The ClawVille user who minted the code. */
    clawvilleUserId: uuid('clawville_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which remote world this code is valid for. Today always 'scape'. */
    remoteWorld: varchar('remote_world', { length: 64 }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
    /** issued_at + 10 min by default. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** NULL until the partner's signed POST lands. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => ({
    // Quick "active codes for this user" lookup — the ClawVille UI polls
    // while the human is copying the code across.
    userIdx: index('idx_pal_user').on(t.clawvilleUserId, t.issuedAt.desc()),
    // Scan only live codes when the partner submits a code for lookup.
    // Partial index on (expires_at) WHERE consumed_at IS NULL.
    activeIdx: index('idx_pal_active')
      .on(t.expiresAt)
      .where(sql`consumed_at IS NULL`),
  }),
);

export type PendingAccountLink = typeof pendingAccountLinks.$inferSelect;
export type NewPendingAccountLink = typeof pendingAccountLinks.$inferInsert;
