import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
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
 *   'pet'     — a human-owned pet from the pets table
 *   'agent'   — an external agent from the openclaw_bots table
 *               (Milady, OpenClaw, Hermes, nanoclaw, etc.)
 *   'treasury'— a process-owned wallet (merchant, fee collector, escrow)
 *               — NOTE: the existing `treasury_wallets` table is the
 *               authoritative store for treasury keypairs. This enum value
 *               is reserved for future unification but not used yet.
 *
 * Future subject types we might add: 'dao' (collective), 'repo' (for the
 * free promotion marketplace), 'quest' (auto-generated reward wallets).
 */
export const walletSubjectTypeEnum = pgEnum('wallet_subject_type', [
  'pet',
  'agent',
  'treasury',
]);

/**
 * Unified custodial wallet table — one row per (subject_type, subject_id)
 * pair. Replaces the previous split between `pet_wallets` and a would-be
 * `agent_wallets` table. Single source of truth for "who owns this
 * keypair" across the whole ClawVille economy.
 *
 * Encryption: secret keys are encrypted with the same AES-256-GCM master
 * key (VANITY_ENCRYPTION_KEY) used by `treasury_wallets` and
 * `vanity_keypairs`. See `apps/api/src/services/keypair-vault.ts`.
 *
 * Mirror columns: `pets.wallet_address` and `openclaw_bots.wallet_address`
 * mirror the public key for O(1) lookups without a join. The
 * wallet-service keeps both in sync.
 *
 * ⚠️  CUSTODIAL WARNING: ClawVille holds the secret. v1 use case is the
 *     Phase 4 x402 paywall (~$0.001 per request) and internal ClawToken
 *     bookkeeping. There is no withdrawal / export flow by design. Do
 *     NOT load these wallets with meaningful value until a legal review
 *     of the custody model is done.
 *
 * Ownership model:
 *   Marketplace listings reference wallets via `subject_type` + `subject_id`
 *   (or a `wallet_id` join), so a pet selling a skill to an agent is just
 *   two rows in the same table. Leaderboard queries become `GROUP BY
 *   subject_type, subject_id` — no UNIONs across parallel tables.
 */
export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'pet' | 'agent' | 'treasury' (reserved) */
    subjectType: walletSubjectTypeEnum('subject_type').notNull(),
    /** UUID of the owning pets.id or openclaw_bots.id row */
    subjectId: uuid('subject_id').notNull(),
    /** Base58 Solana public key (mirrored on pets/openclaw_bots for fast lookup) */
    publicKey: varchar('public_key', { length: 64 }).notNull().unique(),
    /** AES-256-GCM encrypted 64-byte secret key, base64-encoded */
    encryptedSecretKey: text('encrypted_secret_key').notNull(),
    /** AES-256-GCM IV, base64-encoded */
    encryptionIv: varchar('encryption_iv', { length: 32 }).notNull(),
    /** AES-256-GCM auth tag, base64-encoded */
    encryptionTag: varchar('encryption_tag', { length: 32 }).notNull(),
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
