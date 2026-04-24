import { pgTable, uuid, varchar, timestamp, boolean, integer, text, check } from 'drizzle-orm/pg-core';
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

    // -----------------------------------------------------------------
    // Phase 5.1 — ed25519 identity keypair (replaces string-based
    // identity_fingerprint as the primary reconnect anchor).
    //
    // The pubkey is rotatable; `users.id` (UUID PK) is the stable handle
    // stored in the agent config. All columns use an `identity_` prefix
    // to disambiguate from the wallets-row encryption columns when the
    // two tables are joined for auditing.
    // -----------------------------------------------------------------
    /** Base58 ed25519 current pubkey (32 bytes). UNIQUE so one user = one active pubkey. */
    identityPubkey: varchar('identity_pubkey', { length: 44 }).unique(),
    /** AES-GCM(sk, DEK) — base64. Encryption-version-aware; see identity_encryption_version. */
    identityEncryptedSk: text('identity_encrypted_sk'),
    /** AES-GCM 12-byte IV, base64. */
    identityIv: varchar('identity_iv', { length: 32 }),
    /** AES-GCM 16-byte auth tag, base64. */
    identityTag: varchar('identity_tag', { length: 32 }),
    /** Base64 of the per-row DEK wrapped by the Cloudflare-held KEK. */
    identityDekWrapped: text('identity_dek_wrapped'),
    /**
     * Envelope encryption version for the identity secret.
     *   2 = envelope (Cloudflare-wrapped DEK; the day-1 default for
     *       identity since there are no v1 rows).
     * If we ever downgrade (emergency), bump schema + keep both
     * branches in `decryptSecretKeyEnveloped`.
     */
    identityEncryptionVersion: integer('identity_encryption_version').notNull().default(2),

    // -----------------------------------------------------------------
    // Phase 5.1 — 'scape portal identity derivatives
    //
    // On first ClawVille → 'scape crossing we auto-provision a scape
    // account keyed on principalId/worldCharacterId. These two columns
    // cache those derivatives so subsequent crossings don't need to
    // look them up or recompute.
    // -----------------------------------------------------------------
    scapePrincipalId: varchar('scape_principal_id', { length: 128 }).unique(),
    scapeWorldCharacterId: varchar('scape_world_character_id', { length: 64 }).unique(),

    // -----------------------------------------------------------------
    // Phase 5.1 §15 — account linking (existing scape account ↔ ClawVille)
    //
    // Set by the mutual-challenge flow when a user pastes a ClawVille
    // link code into scape. Once set, the portal minter uses these over
    // the auto-provisioned scape_* columns above.
    // -----------------------------------------------------------------
    linkedScapePrincipalId: varchar('linked_scape_principal_id', { length: 128 }).unique(),
    linkedScapeWorldCharacterId: varchar('linked_scape_world_character_id', { length: 64 }).unique(),
    linkedScapeDisplayName: varchar('linked_scape_display_name', { length: 64 }),
    linkedScapeAt: timestamp('linked_scape_at', { withTimezone: true }),

    // -----------------------------------------------------------------
    // Guest-avatar auto-create (2026-04-23) — un-authenticated visitors get
    // a throwaway user + avatar so they can play the Q2 activity games and
    // chat with NPCs without signing up. Cleanup cron deletes rows where
    // is_guest = true AND guest_expires_at < now() (TODO: scripts/prune-
    // guest-avatars.ts — not in this PR).
    //
    // Brand carve-out: guest users are filtered out of the agent
    // leaderboard, the per-activity leaderboards, and the /dash teacher-
    // chat metric (same pattern as bot avatars in Q2 chunk #10). They still
    // earn ClawTokens in-match — the dopamine works even pre-signup —
    // but they get 0 leaderboard points.
    // -----------------------------------------------------------------
    isGuest: boolean('is_guest').notNull().default(false),
    guestExpiresAt: timestamp('guest_expires_at', { withTimezone: true }),

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
