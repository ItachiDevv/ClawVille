import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  pgEnum,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Unified wallet subject type.
 *
 * Every wallet in ClawVille belongs to exactly one "subject" — a thing that
 * owns a keypair and can participate in the economy. Subjects today:
 *
 *   'avatar'  — a human-owned avatar from the avatars table
 *   'agent'   — an external agent from the openclaw_bots table
 *               (Milady, OpenClaw, Hermes, custom, etc.)
 *   'treasury'— a process-owned wallet (merchant, fee collector, escrow)
 *               — NOTE: the existing `treasury_wallets` table is the
 *               authoritative store for treasury keypairs. This enum value
 *               is reserved for future unification but not used yet.
 *
 * Future subject types we might add: 'dao' (collective), 'repo' (for the
 * free promotion marketplace), 'quest' (auto-generated reward wallets).
 */
export const walletSubjectTypeEnum = pgEnum('wallet_subject_type', [
  'avatar',
  'agent',
  'treasury',
]);

/**
 * Unified custodial wallet table — one row per (subject_type, subject_id)
 * pair. Replaces the previous split between `avatar_wallet` (legacy) and a
 * would-be `agent_wallets` table. Single source of truth for "who owns this
 * keypair" across the whole ClawVille economy.
 *
 * Encryption (Phase 5.1): two versions coexist in-column.
 *   encryption_version = 1  →  encrypted_secret_key is AES-GCM(sk, KEK)
 *                              under `VANITY_ENCRYPTION_KEY` (legacy).
 *                              dek_wrapped is NULL.
 *   encryption_version = 2  →  envelope-encrypted. A random 32-byte DEK
 *                              per row encrypts the secret via AES-GCM;
 *                              the DEK itself is AES-KW-wrapped by the
 *                              Cloudflare-held master KEK and stored in
 *                              `dek_wrapped`.
 * New wallet rows go to v2 going forward. `decryptWalletRow()` in
 * `apps/api/src/services/keypair-vault.ts` dispatches on `encryption_version`.
 * See Phase 5.1 plan §4.2 and §8.
 *
 * Mirror columns: `avatars.wallet_address` and `openclaw_bots.wallet_address`
 * mirror the public key for O(1) lookups without a join. The
 * wallet-service keeps both in sync.
 *
 * ⚠️  CUSTODIAL — ONE approved export channel.
 *     ClawVille holds the secret on the user's behalf. There is exactly
 *     ONE server-side path that ever releases a plaintext secret key to a
 *     caller: the first-time provisioning return value from
 *     `ensureWalletWithFirstTimeSecret()` in
 *     `apps/api/src/services/wallet-service.ts`. That function returns
 *     the freshly-generated base58 secret in the SAME response that
 *     creates the row, and the caller (the agent gateway) is contracted
 *     to relay it to the human ONCE, in-chat, for self-custody backup.
 *     On every subsequent call for the same subject the secret field is
 *     omitted from the return type — the server will never re-export it.
 *
 *     There is no GET endpoint that returns the secret. There is no
 *     admin panel that reveals it. There is no "export wallet" button.
 *     If the user loses their one-time backup, their funds stay in
 *     custodial server-signed storage — recoverable only via the
 *     deferred support-chat identity-verification workflow (not v1).
 *
 *     Until legal review of the custody model completes, wallets on this
 *     table should not hold meaningful on-chain value beyond the
 *     ClawVille-native economy (ClawTokens, x402 ~$0.001 pings).
 *
 * Ownership model:
 *   Marketplace listings reference wallets via `subject_type` + `subject_id`
 *   (or a `wallet_id` join), so an avatar selling a skill to an agent is just
 *   two rows in the same table. Leaderboard queries become `GROUP BY
 *   subject_type, subject_id` — no UNIONs across parallel tables.
 */
export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'avatar' | 'agent' | 'treasury' (reserved) */
    subjectType: walletSubjectTypeEnum('subject_type').notNull(),
    /** UUID of the owning avatars.id or openclaw_bots.id row */
    subjectId: uuid('subject_id').notNull(),
    /** Base58 Solana public key (mirrored on avatars/openclaw_bots for fast lookup) */
    publicKey: varchar('public_key', { length: 64 }).notNull().unique(),
    /** AES-256-GCM encrypted 64-byte secret key, base64-encoded */
    encryptedSecretKey: text('encrypted_secret_key').notNull(),
    /** AES-256-GCM IV, base64-encoded */
    encryptionIv: varchar('encryption_iv', { length: 32 }).notNull(),
    /** AES-256-GCM auth tag, base64-encoded */
    encryptionTag: varchar('encryption_tag', { length: 32 }).notNull(),
    /**
     * Phase 5.1 envelope encryption.
     *
     *   1 = legacy — encrypted_secret_key is AES-GCM(sk, KEK) under
     *       VANITY_ENCRYPTION_KEY. dek_wrapped MUST be NULL.
     *   2 = envelope — encrypted_secret_key is AES-GCM(sk, DEK) with
     *       a random per-row 32-byte DEK. dek_wrapped is the DEK
     *       wrapped by the Cloudflare-held master KEK (AES-KW).
     */
    encryptionVersion: integer('encryption_version').notNull().default(1),
    /** Base64 of AES-KW-wrapped DEK. NULL iff encryption_version = 1. */
    dekWrapped: text('dek_wrapped'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    // Every (subject_type, subject_id) pair gets at most one wallet
    subjectUniq: uniqueIndex('wallets_subject_uniq').on(t.subjectType, t.subjectId),
    // Fast "all wallets for this subject type" queries for the leaderboard
    subjectTypeIdx: index('wallets_subject_type_idx').on(t.subjectType),
  }),
);

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
export type WalletSubjectType = (typeof walletSubjectTypeEnum.enumValues)[number];
