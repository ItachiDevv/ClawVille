/**
 * One row per paid call from an avatar wallet to a third-party vendor
 * (migration 0090, MCP hub step 2 phase 2). Written by
 * `apps/api/src/services/outbound-x402.ts` and `usepod-deposit.ts`, BEFORE the wallet signs. Daily
 * sums for the user's spend rules come from this table. An 'ambiguous' row is
 * never retried automatically.
 */

import { bigint, check, jsonb, index, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';

export const vendorSpendStatusEnum = pgEnum('vendor_spend_status', ['pending', 'paid', 'failed', 'ambiguous']);

export const vendorSpendLedger = pgTable('vendor_spend_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'restrict' }),
  vendor: varchar('vendor', { length: 32 }).notNull(),
  tool: varchar('tool', { length: 64 }).notNull(),
  actor: varchar('actor', { length: 16 }).notNull(),
  status: vendorSpendStatusEnum('status').notNull().default('pending'),
  usdcAtomic: numeric('usdc_atomic', { precision: 20, scale: 0 }).notNull(),
  usdCents: integer('usd_cents').notNull(),
  payTo: varchar('pay_to', { length: 64 }).notNull(),
  payerWallet: varchar('payer_wallet', { length: 64 }).notNull(),
  network: varchar('network', { length: 100 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
  payerSignature: text('payer_signature'),
  txSignature: text('tx_signature'),
  signedTxB64: text('signed_tx_b64'),
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'number' }),
  feeLamports: bigint('fee_lamports', { mode: 'number' }),
  creditStatus: varchar('credit_status', { length: 16 }),
  depositTerms: jsonb('deposit_terms'),
  failureReason: text('failure_reason'),
  reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
  reconcileNextAt: timestamp('reconcile_next_at', { withTimezone: true }),
  /** Set with payer_signature, before the paid request is sent. */
  signedAt: timestamp('signed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  creditStatusCheck: check('vendor_spend_ledger_credit_status_check', sql`${table.creditStatus} IS NULL OR ${table.creditStatus} IN ('unknown', 'seen')`),
  avatarIdemUnique: uniqueIndex('vendor_spend_ledger_avatar_idem_unique').on(table.avatarId, table.idempotencyKey),
  avatarCreatedIdx: index('vendor_spend_ledger_avatar_created_idx').on(table.avatarId, table.createdAt),
  txSignatureUnique: uniqueIndex('vendor_spend_ledger_tx_signature_unique')
    .on(table.txSignature)
    .where(sql`tx_signature IS NOT NULL`),
}));

export type VendorSpendRow = typeof vendorSpendLedger.$inferSelect;
