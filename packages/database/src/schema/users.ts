import { pgTable, uuid, varchar, timestamp, boolean, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Users table.
 *
 * Phase 5 — agent-issued magic-link login made two columns nullable and
 * added a third auth channel:
 *   - `email` / `password_hash`: still the only auth path for classic
 *     form-based signups. Both are now NULL-able so agent-bootstrapped
 *     users (no form, no email handshake) can exist.
 *   - `identity_fingerprint`: SHA-256 of `{identityType}:{identityKey}`
 *     presented by the agent on first connect. Serves as the stable
 *     account key for agent-bootstrapped users. UNIQUE so two concurrent
 *     `/api/agent/connect` calls with the same identity map to the same
 *     user row. See `apps/api/src/services/identity-service.ts` for the
 *     resolve-or-create race-safe pattern.
 *
 * The Postgres CHECK constraint `users_has_auth_method` guarantees every
 * user has at least ONE real auth channel — either a populated
 * (email + password_hash) pair OR an identity_fingerprint. Drizzle-kit
 * 0.24 is inconsistent about emitting this kind of CHECK on push; if it
 * gets skipped run the ALTER manually (see §5.2 of the Phase 5 plan
 * and the fallback block in `scripts/apply-phase5-users-check.ts`).
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).unique(),
    emailVerified: boolean('email_verified').default(false),
    passwordHash: varchar('password_hash', { length: 255 }),
    name: varchar('name', { length: 255 }),
    avatarUrl: varchar('avatar_url', { length: 500 }),
    /**
     * Phase 5 — SHA-256 hex of `{identityType}:{identityKey}`. Populated
     * when an agent bootstraps a user via `POST /api/agent/connect` or
     * `POST /api/agent/join`. NULL for classic email/password signups
     * until they later link an agent. UNIQUE so returning agents with
     * the same identity always map to the same user.
     */
    identityFingerprint: varchar('identity_fingerprint', { length: 64 }).unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    // Guard: a user must have AT LEAST ONE of (email+password) or
    // identity_fingerprint. Matches §5.2 of the Phase 5 plan. Runs at
    // every INSERT / UPDATE so a partially-initialized row (e.g. an
    // email row whose password failed to hash) gets rejected before it
    // lands in the table.
    hasAuthMethod: check(
      'users_has_auth_method',
      sql`(${t.email} IS NOT NULL AND ${t.passwordHash} IS NOT NULL) OR ${t.identityFingerprint} IS NOT NULL`,
    ),
  }),
);

export const sessions = pgTable('sessions', {
  id: varchar('id', { length: 255 }).primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
});
