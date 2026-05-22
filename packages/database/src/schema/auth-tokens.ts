import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

/**
 * Email-driven auth tokens — password reset + email verification.
 *
 * Mirrors `agent_session_tickets` (Phase 5 magic-link). One row per
 * issued token. The raw token is NEVER stored — only `sha256(token)` in
 * `tokenHash`. Verification compares hash(presented) against `tokenHash`
 * via a single atomic UPDATE...RETURNING with `consumed_at IS NULL AND
 * expires_at > now()` predicates so two concurrent requests for the
 * same link can't both succeed.
 *
 * Purposes:
 *   - `password-reset` — TTL 60 min, issued by `POST /api/auth/forgot-password`,
 *     consumed by `POST /api/auth/reset-password`.
 *   - `email-verify`  — TTL 24 h, issued by signup hook + `POST /api/auth/send-verification`,
 *     consumed by `GET /api/auth/verify-email`.
 *
 * The `purpose` column is a varchar(32) check-constrained string so a
 * caller passing the wrong purpose can never consume a token issued for
 * the other flow (defense-in-depth — the route also pins purpose at
 * query time).
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `'password-reset'` | `'email-verify'` — pinned by the check constraint below. */
    purpose: varchar('purpose', { length: 32 }).notNull(),
    /** sha256(raw_token) hex. Raw token only ever leaves the server inside the email URL. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** NULL until consumed; set atomically by the consume UPDATE. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    userPurposeIdx: index('auth_tokens_user_purpose_idx').on(t.userId, t.purpose),
    expiresIdx: index('auth_tokens_expires_idx')
      .on(t.expiresAt)
      .where(sql`${t.consumedAt} IS NULL`),
    purposeCheck: check(
      'auth_tokens_purpose_valid',
      sql`${t.purpose} IN ('password-reset', 'email-verify')`,
    ),
    ttlCheck: check('auth_tokens_ttl', sql`${t.expiresAt} > ${t.createdAt}`),
  }),
);
