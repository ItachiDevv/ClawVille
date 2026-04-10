import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { avatars } from './avatars';

/**
 * Custodial Solana wallets auto-generated per avatar.
 *
 * Every avatar — whether created by a human on clawville.world or spawned by
 * a connecting agent (Milady, OpenClaw, nanoclaw, etc.) — gets a Solana
 * keypair assigned at birth. The public key is mirrored to
 * `avatars.walletAddress` for O(1) lookups; the secret key lives here,
 * encrypted at rest with the same AES-256-GCM master key
 * (`VANITY_ENCRYPTION_KEY`) used by `treasury_wallets` and
 * `vanity_keypairs`.
 *
 * ⚠️  CUSTODIAL WARNING — ClawVille holds the secret key. For v1 the only
 *     intended use is as a payment source for Phase 4 x402 pings
 *     (~$0.001 per request). DO NOT load these wallets with meaningful
 *     value until a legal review of the custody model is done. There is
 *     no withdrawal / export flow by design.
 *
 * Generation: see `apps/api/src/services/avatar-wallet-service.ts`
 * Backfill:   see `scripts/backfill-avatar-wallets.ts`
 */
export const petWallets = pgTable('avatar_wallet', {
  id: uuid('id').primaryKey().defaultRandom(),
  avatarId: uuid('avatar_id')
    .notNull()
    .unique()
    .references(() => avatars.id, { onDelete: 'cascade' }),
  /** Base58 Solana public key (also mirrored on avatars.walletAddress) */
  publicKey: varchar('public_key', { length: 64 }).notNull().unique(),
  /** AES-256-GCM encrypted 64-byte secret key, base64-encoded */
  encryptedSecretKey: text('encrypted_secret_key').notNull(),
  /** AES-256-GCM IV, base64-encoded */
  encryptionIv: varchar('encryption_iv', { length: 32 }).notNull(),
  /** AES-256-GCM auth tag, base64-encoded */
  encryptionTag: varchar('encryption_tag', { length: 32 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type PetWallet = typeof petWallets.$inferSelect;
export type NewPetWallet = typeof petWallets.$inferInsert;
