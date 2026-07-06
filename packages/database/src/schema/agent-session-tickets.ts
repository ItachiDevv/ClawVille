import {
  pgTable,
  text,
  uuid,
  varchar,
  timestamp,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { avatars } from './avatars';

/**
 * Phase 5 — agent-issued magic-link tickets.
 *
 * A ticket is minted at `POST /api/agent/connect` (or `/join`) and
 * redeemed at `GET /api/auth/enter?t=...`. It swaps the agent's
 * presented identity for a real Lucia session cookie on the human's
 * browser so first-contact users never see a signup form.
 *
 * Security invariants — see Phase 5 plan §7:
 *   - 128-bit random ticket (base58, `sess-` prefix), unguessable.
 *   - `expires_at > created_at` guaranteed at the DB layer via
 *     `ticket_ttl`.
 *   - One-time use — enforced by the atomic
 *     `UPDATE ... SET consumed_at = now() WHERE consumed_at IS NULL
 *      RETURNING *` pattern in the exchanger.
 *   - Partial index on `expires_at WHERE consumed_at IS NULL` drives
 *     the hourly GC cron in `scripts/gc-agent-session-tickets.ts`.
 *
 * `identity_type` + `identity_key` are duplicated here (already hashed
 * into `users.identity_fingerprint`) as an audit trail. They're never
 * returned in any API response — the hash stored on users is the only
 * externally-observable form.
 */
export const agentSessionTickets = pgTable(
  'agent_session_tickets',
  {
    /**
     * Opaque ticket string, e.g. `sess-HvH8GQwzsYoPpB5xvBmEv9`.
     * TEXT rather than a length-bounded varchar so base58 output of any
     * entropy length fits without truncation risk.
     */
    ticket: text('ticket').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Optional — some tickets bind to a specific avatar; others just to a user */
    avatarId: uuid('avatar_id').references(() => avatars.id, { onDelete: 'cascade' }),
    /**
     * The agent session that minted this ticket, for audit/debug. Not
     * required because the ticket is still valid for redemption even
     * if the agent session later expires or is revoked.
     */
    issuedToAgentSession: varchar('issued_to_agent_session', { length: 64 }),
    /**
     * Magic-link onboarding (2026-07-02) — the PUBLIC `openclaw_bots.agent_id`
     * of the agent this ticket was minted FOR. Redemption at `GET /api/auth/enter`
     * uses it as the deferred-bind claim event: on successful consume the
     * exchanger binds `openclaw_bots.user_id = ticket.user_id` for this agent
     * (never clobbering a DIFFERENT existing owner) so the agent's live session
     * becomes ledger-capable without a reconnect. NULLABLE + additive: tickets
     * minted by non-agent flows (email login links, reconnect) leave it null and
     * redemption skips the bind. This is a public handle, NOT a bearer — unlike
     * `issued_to_agent_session` it needs no digesting.
     */
    issuedToAgentId: text('issued_to_agent_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** NULL until redeemed; set to `now()` atomically on redemption. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** Identity audit trail — see JSDoc above. */
    identityType: varchar('identity_type', { length: 16 }).notNull(),
    identityKey: text('identity_key'),
  },
  (t) => ({
    /**
     * Partial index on unredeemed tickets only — the GC script scans
     * `WHERE consumed_at IS NULL AND expires_at < now() - '1 day'::interval`
     * and this covers both predicates cheaply.
     */
    expiresIdx: index('agent_session_tickets_expires_idx').on(t.expiresAt)
      .where(sql`${t.consumedAt} IS NULL`),
    ttlCheck: check('ticket_ttl', sql`${t.expiresAt} > ${t.createdAt}`),
  }),
);
