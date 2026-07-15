import {
  pgTable,
  text,
  uuid,
  bigint,
  timestamp,
  check,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Global ownership registry for an on-chain x402 settlement signature.
 *
 * Individual rail tables retain their own signature UNIQUE indexes, but every
 * economic effect must also claim this table in the SAME transaction as its
 * credit/fulfillment. The primary key makes one Solana payment consumable by
 * at most one ClawVille rail across the entire database.
 */
export const x402SettlementReceipts = pgTable(
  'x402_settlement_receipts',
  {
    txSignature: text('tx_signature').primaryKey(),
    rail: text('rail').notNull(),
    kind: text('kind').notNull(),
    referenceId: text('reference_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    amountUsdcAtomic: bigint('amount_usdc_atomic', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    referenceIdx: index('x402_settlement_receipts_reference_idx').on(t.rail, t.referenceId),
    amountPositive: check(
      'x402_settlement_receipts_amount_positive',
      sql`${t.amountUsdcAtomic} > 0`,
    ),
  }),
);

export type X402SettlementReceipt = typeof x402SettlementReceipts.$inferSelect;
export type NewX402SettlementReceipt = typeof x402SettlementReceipts.$inferInsert;
