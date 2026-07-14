/**
 * Tokenomics E3 — gated EARNED exit rail.
 *
 * One row is both the subject-scoped idempotency record and the durable
 * requested -> debited -> buy_queued -> bought -> delivering ->
 * delivered/reconcile machine. Money values are integer-exact:
 *
 *   gross micro-USDC = vCLAW * 10_000
 *   exit fee         = vCLAW * 444       (4.44%, retained by the house)
 *   CLV buy input    = vCLAW * 9_556
 *
 * Migration: 0031_tokenomics_redeem.sql. The API remains default-OFF behind
 * TOKENOMICS_REDEEM_ENABLED even after the additive DDL exists.
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  integer,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';
import { clawTokenTransactions, treasuryWallets } from './treasury';
import { clvBuyQueue, clvSwapFunding } from './swap';

export const earnedRedemptionStatusEnum = pgEnum('earned_redemption_status', [
  'requested',
  'refused',
  'debited',
  'buy_queued',
  'bought',
  'delivering',
  'delivered',
  'reconcile',
]);

export const earnedRedemptions = pgTable(
  'earned_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'user' for a Lucia human; 'agent' for a ledger-capable agent session. */
    subjectType: text('subject_type').notNull(),
    /** Middleware-resolved owner. Never accepted from request JSON. */
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'restrict' }),
    /** Required client key; unique within the exact subject. */
    idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
    amountVclaw: integer('amount_vclaw').notNull(),
    grossUsdcAtomic: numeric('gross_usdc_atomic', { precision: 20, scale: 0 }).notNull(),
    exitFeeUsdcAtomic: numeric('exit_fee_usdc_atomic', { precision: 20, scale: 0 })
      .notNull(),
    /** Set in the debit tx. This fee remains in backing custody as house revenue. */
    exitFeeRetainedAt: timestamp('exit_fee_retained_at', { withTimezone: true }),
    buyUsdcAtomic: numeric('buy_usdc_atomic', { precision: 20, scale: 0 }).notNull(),
    status: earnedRedemptionStatusEnum('status').notNull().default('requested'),
    /** EARNED-only debit emitted in the same tx as lot/backing consumption. */
    ledgerDebitId: uuid('ledger_debit_id').references(() => clawTokenTransactions.id, {
      onDelete: 'restrict',
    }),
    /** Exact singleton custody wallet that backs every selected lot. */
    backingCustodyWalletId: uuid('backing_custody_wallet_id').references(
      () => treasuryWallets.id,
      { onDelete: 'restrict' },
    ),
    /** Existing rail ② intent. reason='earned_redemption', source_ref=this id. */
    clvBuyQueueId: uuid('clv_buy_queue_id').references(() => clvBuyQueue.id, {
      onDelete: 'restrict',
    }),
    /** Real earned-backing -> swap-wallet USDC transfer record. */
    clvSwapFundingId: uuid('clv_swap_funding_id').references(() => clvSwapFunding.id, {
      onDelete: 'restrict',
    }),
    /** Delivery CAS token; only its holder may capture/mark. */
    deliveryClaimId: uuid('delivery_claim_id'),
    deliveryClaimedAt: timestamp('delivery_claimed_at', { withTimezone: true }),
    /** Captured before send; partial-UNIQUE across every redemption. */
    deliveryTxSignature: text('delivery_tx_signature'),
    /** Conservative sum of queue fill minima, never optimistic quote output. */
    deliveryClvAtomic: numeric('delivery_clv_atomic', { precision: 30, scale: 0 }),
    /** Server-resolved custodial owner pubkey captured with the delivery. */
    deliveryWalletPubkey: varchar('delivery_wallet_pubkey', { length: 64 }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    subjectIdemUnique: uniqueIndex('earned_redemptions_subject_idem_unique').on(
      t.subjectType,
      t.avatarId,
      t.idempotencyKey,
    ),
    ledgerDebitUnique: uniqueIndex('earned_redemptions_ledger_debit_unique')
      .on(t.ledgerDebitId)
      .where(sql`ledger_debit_id IS NOT NULL`),
    queueUnique: uniqueIndex('earned_redemptions_queue_unique')
      .on(t.clvBuyQueueId)
      .where(sql`clv_buy_queue_id IS NOT NULL`),
    fundingUnique: uniqueIndex('earned_redemptions_funding_unique')
      .on(t.clvSwapFundingId)
      .where(sql`clv_swap_funding_id IS NOT NULL`),
    deliverySigUnique: uniqueIndex('earned_redemptions_delivery_sig_unique')
      .on(t.deliveryTxSignature)
      .where(sql`delivery_tx_signature IS NOT NULL`),
    statusCreatedIdx: index('earned_redemptions_status_created_idx').on(
      t.status,
      t.createdAt,
    ),
    avatarCreatedIdx: index('earned_redemptions_avatar_created_idx').on(
      t.avatarId,
      t.createdAt,
    ),
    subjectTypeValid: check(
      'earned_redemptions_subject_type_valid',
      sql`${t.subjectType} IN ('user', 'agent')`,
    ),
    exactMoney: check(
      'earned_redemptions_exact_money',
      sql`${t.amountVclaw} > 0
        AND ${t.grossUsdcAtomic} = ${t.amountVclaw}::numeric * 10000
        AND ${t.exitFeeUsdcAtomic} = ${t.amountVclaw}::numeric * 444
        AND ${t.buyUsdcAtomic} = ${t.amountVclaw}::numeric * 9556
        AND ${t.grossUsdcAtomic} = ${t.exitFeeUsdcAtomic} + ${t.buyUsdcAtomic}`,
    ),
    debitShape: check(
      'earned_redemptions_debit_shape',
      sql`${t.status} IN ('requested', 'refused')
        OR (${t.ledgerDebitId} IS NOT NULL
          AND ${t.backingCustodyWalletId} IS NOT NULL
          AND ${t.exitFeeRetainedAt} IS NOT NULL)`,
    ),
    queueShape: check(
      'earned_redemptions_queue_shape',
      sql`${t.status} IN ('requested', 'refused', 'debited') OR ${t.clvBuyQueueId} IS NOT NULL`,
    ),
    deliveryShape: check(
      'earned_redemptions_delivery_shape',
      sql`${t.status} <> 'delivering'
        OR (${t.deliveryClaimId} IS NOT NULL AND ${t.deliveryClaimedAt} IS NOT NULL)`,
    ),
    boughtShape: check(
      'earned_redemptions_bought_shape',
      sql`${t.status} NOT IN ('bought', 'delivering', 'delivered')
        OR (${t.clvSwapFundingId} IS NOT NULL
          AND ${t.clvBuyQueueId} IS NOT NULL
          AND ${t.deliveryClvAtomic} > 0)`,
    ),
    capturedDeliveryShape: check(
      'earned_redemptions_captured_delivery_shape',
      sql`${t.deliveryTxSignature} IS NULL
        OR (${t.deliveryClvAtomic} > 0 AND ${t.deliveryWalletPubkey} IS NOT NULL)`,
    ),
    reconcileShape: check(
      'earned_redemptions_reconcile_shape',
      sql`${t.status} <> 'reconcile' OR ${t.failureReason} IS NOT NULL`,
    ),
    refusedShape: check(
      'earned_redemptions_refused_shape',
      sql`${t.status} <> 'refused' OR ${t.failureReason} IS NOT NULL`,
    ),
    deliveredShape: check(
      'earned_redemptions_delivered_shape',
      sql`${t.status} <> 'delivered'
        OR (${t.deliveryTxSignature} IS NOT NULL
          AND ${t.deliveryClvAtomic} > 0
          AND ${t.deliveryWalletPubkey} IS NOT NULL
          AND ${t.deliveredAt} IS NOT NULL)`,
    ),
  }),
);

export type EarnedRedemption = typeof earnedRedemptions.$inferSelect;
export type NewEarnedRedemption = typeof earnedRedemptions.$inferInsert;
