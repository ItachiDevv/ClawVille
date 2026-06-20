/**
 * Support tickets — lean in-product help channel (2026-06-18).
 *
 * One append-only row per submitted ticket. Filable by ANY subject so nobody
 * who needs help is locked out:
 *   - a logged-in user  → subject_type='user',  user_id + avatar_id set
 *   - a connected agent  → subject_type='agent', agent_id (+ bound user/avatar)
 *   - a guest            → subject_type='guest', fp_hash set
 *
 * Deliberately NO foreign keys: this is an audit/log table, a dangling user_id
 * (e.g. account later deleted) must never block reading the ticket history, and
 * keeping it FK-free keeps the idempotent additive migration trivial.
 *
 * Write path: POST /api/support/tickets (`apps/api/src/routes/support.ts`) —
 * Zod-validated, per-subject rate-limited, persisted here, then best-effort
 * relayed to the itachi-debug Telegram bot (fail-open). `status` exists for a
 * future admin triage pass; the lean build only ever writes 'open'.
 *
 * NOT a dispute-audit system — "our math is solid; if a player needs to they can
 * file a ticket." The provably-fair verifier (/cove/verify) is the self-serve
 * fairness path; this is the human escape hatch.
 */

import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** 'user' | 'agent' | 'guest' — which identity filed it. */
    subjectType: text('subject_type').notNull(),
    /** Set when the filer is (or is bound to) a logged-in account. Nullable, no FK. */
    userId: uuid('user_id'),
    avatarId: uuid('avatar_id'),
    /** Set when filed via a connected/hosted agent session. */
    agentId: text('agent_id'),
    /** Guest / anti-abuse fingerprint (sha256 of fp + IP-prefix, as elsewhere). */
    fpHash: text('fp_hash'),

    /** Coarse routing bucket: 'bug' | 'payment' | 'fairness' | 'account' | 'other'. */
    category: text('category').notNull(),
    /** Optional short title. */
    subject: text('subject'),
    /** The ticket body. */
    message: text('message').notNull(),
    /** Light context: { page, url, game, eventId, userAgent }. */
    context: jsonb('context'),

    /** 'open' | 'resolved' | 'closed' — lean build only writes 'open'. */
    status: text('status').notNull().default('open'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCreated: index('support_tickets_created_at_idx').on(t.createdAt),
    byUser: index('support_tickets_user_id_idx').on(t.userId),
    byStatus: index('support_tickets_status_idx').on(t.status),
  }),
);

export type SupportTicket = typeof supportTickets.$inferSelect;
export type NewSupportTicket = typeof supportTickets.$inferInsert;
