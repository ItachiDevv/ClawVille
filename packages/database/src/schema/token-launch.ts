import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  text,
  pgEnum,
  integer,
  jsonb,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { pets } from './pets';

// --- Vanity Keypair Pool ---

export const vanityKeypairStatusEnum = pgEnum('vanity_keypair_status', [
  'available',
  'reserved',
  'used',
]);

export const vanitySuffixEnum = pgEnum('vanity_suffix', ['CLAW', 'HRMS']);

export const vanityKeypairs = pgTable('vanity_keypairs', {
  id: uuid('id').primaryKey().defaultRandom(),
  suffix: vanitySuffixEnum('suffix').notNull(),
  publicKey: varchar('public_key', { length: 64 }).notNull().unique(),
  /** AES-256-GCM encrypted secret key bytes, base64-encoded */
  encryptedSecretKey: text('encrypted_secret_key').notNull(),
  /** AES-256-GCM IV, base64-encoded */
  encryptionIv: varchar('encryption_iv', { length: 32 }).notNull(),
  /** AES-256-GCM auth tag, base64-encoded */
  encryptionTag: varchar('encryption_tag', { length: 32 }).notNull(),
  status: vanityKeypairStatusEnum('status').default('available').notNull(),
  reservedBy: uuid('reserved_by').references(() => users.id, { onDelete: 'set null' }),
  reservedAt: timestamp('reserved_at'),
  usedAt: timestamp('used_at'),
  /** The token mint address (same as publicKey once used) */
  tokenMint: varchar('token_mint', { length: 64 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// --- Token Launches ---

export const launchPlatformEnum = pgEnum('launch_platform', ['pumpfun', 'raydium']);

export const launchStatusEnum = pgEnum('launch_status', [
  'pending',
  'confirming',
  'live',
  'graduated',
  'failed',
]);

export const devWalletSourceEnum = pgEnum('dev_wallet_source', [
  'user',      // user connected Phantom/Solflare
  'agent',     // agent's own Solana wallet
  'generated', // we generated a fresh wallet for them
]);

export interface TokenLaunchMetadata {
  tokenName: string;
  tokenSymbol: string;
  tokenDescription?: string;
  imageUrl?: string;
  metadataUri?: string;
  initialBuyLamports?: number;
  bondingCurveType?: 'linear' | 'exponential' | 'logarithmic';
  graduationThresholdSol?: number;
}

export const tokenLaunches = pgTable('token_launches', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  petId: uuid('pet_id')
    .notNull()
    .references(() => pets.id, { onDelete: 'cascade' }),
  /** Which vanity keypair was used as the mint */
  vanityKeypairId: uuid('vanity_keypair_id')
    .notNull()
    .references(() => vanityKeypairs.id),
  /** The on-chain token mint address */
  mintAddress: varchar('mint_address', { length: 64 }).notNull().unique(),
  platform: launchPlatformEnum('platform').notNull(),
  status: launchStatusEnum('status').default('pending').notNull(),
  devWalletSource: devWalletSourceEnum('dev_wallet_source').notNull(),
  /** The dev wallet public key (creator on-chain) */
  devWalletAddress: varchar('dev_wallet_address', { length: 64 }).notNull(),
  /** Encrypted dev wallet secret key — only set for 'generated' source */
  encryptedDevWalletKey: text('encrypted_dev_wallet_key'),
  devWalletIv: varchar('dev_wallet_iv', { length: 32 }),
  devWalletTag: varchar('dev_wallet_tag', { length: 32 }),
  /** Token metadata + launch config */
  metadata: jsonb('metadata').$type<TokenLaunchMetadata>().notNull(),
  /** On-chain transaction signature for the create tx */
  createTxSignature: varchar('create_tx_signature', { length: 128 }),
  /** Bonding curve pool address (pump.fun or Raydium) */
  poolAddress: varchar('pool_address', { length: 64 }),
  /** AMM pool address after graduation */
  graduatedPoolAddress: varchar('graduated_pool_address', { length: 64 }),
  graduatedAt: timestamp('graduated_at'),
  /** Error message if launch failed */
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
