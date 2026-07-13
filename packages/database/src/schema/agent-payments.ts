import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
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
import { clawTokenTransactions } from './treasury';

/** Durable state machine for one custodial avatar-to-avatar PayAI payment. */
export const agentPaymentStatusEnum = pgEnum('agent_payment_status', [
  'pending',
  'settling',
  'settled',
  'failed',
  'reconcile',
]);

export const agentPaymentRecipientKindEnum = pgEnum('agent_payment_recipient_kind', [
  'avatar',
  'agent',
]);

export const agentPayments = pgTable(
  'agent_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    senderAvatarId: uuid('sender_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'restrict' }),
    recipientAvatarId: uuid('recipient_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'restrict' }),
    recipientKind: agentPaymentRecipientKindEnum('recipient_kind').notNull(),
    /** Original client target, retained so idempotency compares request identity. */
    recipientRef: varchar('recipient_ref', { length: 200 }).notNull(),
    senderWallet: varchar('sender_wallet', { length: 64 }).notNull(),
    recipientWallet: varchar('recipient_wallet', { length: 64 }).notNull(),
    usdCents: integer('usd_cents').notNull(),
    /** Exact on-chain amount (USDC 6dp) derived from usd_cents. */
    usdcAtomic: numeric('usdc_atomic', { precision: 20, scale: 0 }).notNull(),
    status: agentPaymentStatusEnum('status').notNull().default('pending'),
    idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
    settlingId: uuid('settling_id'),
    settlingStartedAt: timestamp('settling_started_at', { withTimezone: true }),
    /** Facilitator-confirmed signature. Captured while status remains settling. */
    txSignature: text('tx_signature'),
    /** Best-effort signature when capture/state is uncertain; not a credit key. */
    reconcileTxSignature: text('reconcile_tx_signature'),
    settlePayer: varchar('settle_payer', { length: 64 }),
    network: varchar('network', { length: 100 }).notNull(),
    earnedVclaw: integer('earned_vclaw').notNull().default(0),
    earnedUsdBasis: numeric('earned_usd_basis', { precision: 20, scale: 6 }),
    earnedLedgerId: uuid('earned_ledger_id').references(() => clawTokenTransactions.id, {
      onDelete: 'restrict',
    }),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    senderIdempotencyUnique: uniqueIndex('agent_payments_sender_idem_unique').on(
      t.senderAvatarId,
      t.idempotencyKey,
    ),
    txSignatureUnique: uniqueIndex('agent_payments_txsig_unique')
      .on(t.txSignature)
      .where(sql`tx_signature IS NOT NULL`),
    earnedLedgerUnique: uniqueIndex('agent_payments_earned_ledger_unique')
      .on(t.earnedLedgerId)
      .where(sql`earned_ledger_id IS NOT NULL`),
    recipientHistoryIdx: index('agent_payments_recipient_idx').on(
      t.recipientAvatarId,
      t.createdAt,
    ),
    statusIdx: index('agent_payments_status_idx').on(t.status, t.updatedAt),
    amountPositive: check('agent_payments_amount_positive', sql`${t.usdCents} >= 1`),
    atomicMatchesCents: check(
      'agent_payments_atomic_matches_cents',
      sql`${t.usdcAtomic} = ${t.usdCents} * 10000`,
    ),
    earnedNonnegative: check('agent_payments_earned_nonnegative', sql`${t.earnedVclaw} >= 0`),
    settledComplete: check(
      'agent_payments_settled_complete',
      sql`${t.status} <> 'settled' OR (
        ${t.txSignature} IS NOT NULL AND ${t.fulfilledAt} IS NOT NULL
        AND ${t.earnedVclaw} > 0 AND ${t.earnedLedgerId} IS NOT NULL
        AND ${t.earnedUsdBasis} IS NOT NULL
      )`,
    ),
  }),
);

export type AgentPayment = typeof agentPayments.$inferSelect;
export type NewAgentPayment = typeof agentPayments.$inferInsert;
