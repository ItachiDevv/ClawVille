import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  text,
  pgEnum,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { pets } from './pets';

/**
 * Treasury wallet purposes — expand as new use cases appear.
 *
 * - `x402-merchant`: receives USDC payments from x402-gated endpoints
 *   (Phase 4 prep; activation deferred)
 * - `fee-collector`: generic fee sink if we add on-chain fees later
 * - `escrow`: holds funds between two parties during a transaction
 */
export const treasuryPurposeEnum = pgEnum('treasury_purpose', [
  'x402-merchant',
  'fee-collector',
  'escrow',
]);

/**
 * Treasury wallets — process-owned Solana keypairs whose secret keys
 * are encrypted at rest using the same AES-256-GCM scheme as
 * vanityKeypairs (VANITY_ENCRYPTION_KEY env var).
 *
 * Generation happens via scripts/generate-treasury-keypair.ts.
 * Secret keys MUST NEVER be printed, logged, or read back by humans.
 */
export const treasuryWallets = pgTable(
  'treasury_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purpose: treasuryPurposeEnum('purpose').notNull(),
    /** Base58 Solana public key */
    publicKey: varchar('public_key', { length: 64 }).notNull().unique(),
    /** AES-256-GCM encrypted secret key bytes, base64-encoded */
    encryptedSecretKey: text('encrypted_secret_key').notNull(),
    /** AES-256-GCM IV, base64-encoded */
    encryptionIv: varchar('encryption_iv', { length: 32 }).notNull(),
    /** AES-256-GCM auth tag, base64-encoded */
    encryptionTag: varchar('encryption_tag', { length: 32 }).notNull(),
    /** Freeform notes — e.g. "Phase 4 prep, production merchant wallet" */
    notes: text('notes'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    purposeIdx: index('treasury_purpose_idx').on(t.purpose),
  }),
);

// --- ClawToken audit ledger ---

/**
 * Source of a ClawToken transaction — used for observability and
 * replay-to-chain migrations.
 */
export const clawTokenSourceEnum = pgEnum('claw_token_source', [
  'api',              // user-initiated via REST route
  'simulation',       // autonomous pet action (Phase 2 bridge)
  'quest',            // quest reward
  'bounty',           // bounty reward
  'daily_login',      // daily login streak
  'admin',            // manual admin grant
  'x402',             // future: real USDC top-up via x402 (deferred)
  'system',           // fallback for internal adjustments
]);

/**
 * Append-only audit ledger for every ClawToken credit/debit.
 *
 * pets.clawTokens remains the authoritative balance column; this table
 * is the auditable history. Every write to pets.clawTokens MUST go
 * through creditClawTokens() / debitClawTokens() in
 * apps/api/src/services/claw-token-ledger.ts, which atomically
 * UPDATEs the balance AND INSERTs a row here in the same transaction.
 *
 * When we eventually tokenize ClawTokens (Phase 5+), we replay this
 * ledger to establish opening on-chain balances.
 */
export const clawTokenTransactions = pgTable(
  'claw_token_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    petId: uuid('pet_id')
      .notNull()
      .references(() => pets.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    /** Signed integer: positive = credit, negative = debit */
    amount: integer('amount').notNull(),
    /** Snapshot of pets.clawTokens AFTER this transaction applied */
    balanceAfter: integer('balance_after').notNull(),
    /** Short human-readable reason: 'buy_book', 'autonomous_visit', etc. */
    reason: text('reason').notNull(),
    /** High-level source category */
    source: clawTokenSourceEnum('source').notNull(),
    /** Reason-specific payload (bookId, buildingId, questId, txHash, etc.) */
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    petIdx: index('claw_token_tx_pet_idx').on(t.petId, t.createdAt),
    userIdx: index('claw_token_tx_user_idx').on(t.userId, t.createdAt),
    sourceIdx: index('claw_token_tx_source_idx').on(t.source, t.createdAt),
  }),
);

// Suppress unused-import warning if callers don't use the users relation
void users;
