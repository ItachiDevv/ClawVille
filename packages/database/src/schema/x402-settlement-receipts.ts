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
    grossUsdcAtomic: bigint('gross_usdc_atomic', { mode: 'bigint' }),
    platformFeeUsdcAtomic: bigint('platform_fee_usdc_atomic', {
      mode: 'bigint',
    }),
    treasuryFeeUsdcAtomic: bigint('treasury_fee_usdc_atomic', {
      mode: 'bigint',
    }),
    netUsdcAtomic: bigint('net_usdc_atomic', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    referenceIdx: index('x402_settlement_receipts_reference_idx').on(t.rail, t.referenceId),
    amountPositive: check(
      'x402_settlement_receipts_amount_positive',
      sql`${t.amountUsdcAtomic} > 0`,
    ),
    feeConservation: check(
      'x402_settlement_receipts_fee_conservation',
      sql`(${t.grossUsdcAtomic} IS NULL
          AND ${t.platformFeeUsdcAtomic} IS NULL
          AND ${t.treasuryFeeUsdcAtomic} IS NULL
          AND ${t.netUsdcAtomic} IS NULL)
        OR (${t.grossUsdcAtomic} > 0
        AND ${t.platformFeeUsdcAtomic} >= 0
        AND ${t.treasuryFeeUsdcAtomic} >= 0
        AND ${t.netUsdcAtomic} > 0
        AND ${t.amountUsdcAtomic} = ${t.grossUsdcAtomic}
        AND ${t.grossUsdcAtomic} = ${t.netUsdcAtomic}
          + ${t.platformFeeUsdcAtomic}
          + ${t.treasuryFeeUsdcAtomic})`,
    ),
  }),
);

export type X402SettlementReceipt = typeof x402SettlementReceipts.$inferSelect;
export type NewX402SettlementReceipt = typeof x402SettlementReceipts.$inferInsert;
