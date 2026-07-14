/**
 * Tokenomics E1/E2 — EARNED import, sybil verification, and dollar backing.
 *
 * Every EARNED mint has exactly one `earned_mint_lots` row. A `backed` lot also
 * has one `earned_backing` row mapping one vCLAW to exactly 10,000 micro-USDC
 * held by `treasury_wallets(purpose='earned-backing')`; `none` lots remain spendable
 * but can never cross the exit rail. Lot consumption is recorded for every
 * ordinary spend, redemption, and claw-back so fungible avatar balances can
 * never substitute an unbacked unit for a backed one.
 */
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
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';
import { clawTokenTransactions, treasuryWallets } from './treasury';

export const earnPayerVerificationEnum = pgEnum('earn_payer_verification', [
  'pending',
  'verified',
  'rejected',
]);

export const earnedBackingKindEnum = pgEnum('earned_backing_kind', [
  'backed',
  'none',
]);

export const earnedConsumptionKindEnum = pgEnum('earned_consumption_kind', [
  'spend',
  'redemption',
  'clawback',
]);

export const earnedLedgerAccountKindEnum = pgEnum('earned_ledger_account_kind', [
  'mint',
  'spend',
  'redemption',
  'clawback',
  'legacy',
]);

/** Exact membership, not timestamps: every EARNED ledger row is accounted once. */
export const earnedAccountedLedger = pgTable('earned_accounted_ledger', {
  ledgerId: uuid('ledger_id')
    .primaryKey()
    .references(() => clawTokenTransactions.id, { onDelete: 'restrict' }),
  kind: earnedLedgerAccountKindEnum('kind').notNull(),
  accountedAt: timestamp('accounted_at', { withTimezone: true }).defaultNow().notNull(),
});

/** One external, house-custodied settlement eligible to mint EARNED. */
export const earnEvents = pgTable(
  'earn_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    earnerAvatarId: uuid('earner_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'restrict' }),
    payerWallet: varchar('payer_wallet', { length: 64 }).notNull(),
    /** Rewritten from payer wallet to the verified first-funder cluster. */
    payerClusterKey: varchar('payer_cluster_key', { length: 64 }).notNull(),
    firstFunderWallet: varchar('first_funder_wallet', { length: 64 }),
    source: varchar('source', { length: 32 }).notNull(),
    backingNetwork: varchar('backing_network', { length: 16 })
      .$type<'mainnet' | 'devnet'>()
      .notNull(),
    grossUsdcAtomic: numeric('gross_usdc_atomic', { precision: 20, scale: 0 }).notNull(),
    /** Entry rake is founder-locked to zero. The only fee is E3's exit fee. */
    rakeBps: integer('rake_bps').notNull().default(0),
    vclawMinted: integer('vclaw_minted').notNull(),
    ledgerId: uuid('ledger_id').references(() => clawTokenTransactions.id, {
      onDelete: 'restrict',
    }),
    payerVerification: earnPayerVerificationEnum('payer_verification')
      .notNull()
      .default('pending'),
    verificationReason: text('verification_reason'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    vestsAt: timestamp('vests_at', { withTimezone: true }).notNull(),
    epochStart: timestamp('epoch_start', { withTimezone: true }).notNull(),
    clawedBackAt: timestamp('clawed_back_at', { withTimezone: true }),
    clawbackReason: text('clawback_reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idemUnique: uniqueIndex('earn_events_idem_unique').on(t.idempotencyKey),
    ledgerUnique: uniqueIndex('earn_events_ledger_unique')
      .on(t.ledgerId)
      .where(sql`ledger_id IS NOT NULL`),
    earnerIdx: index('earn_events_earner_idx').on(t.earnerAvatarId, t.vestsAt),
    pairIdx: index('earn_events_pair_idx').on(
      t.payerClusterKey,
      t.earnerAvatarId,
      t.createdAt,
    ),
    verificationIdx: index('earn_events_verification_idx').on(
      t.payerVerification,
      t.createdAt,
    ),
    centAligned: check(
      'earn_events_cent_aligned',
      sql`${t.grossUsdcAtomic} > 0 AND MOD(${t.grossUsdcAtomic}, 10000) = 0
        AND ${t.vclawMinted} = ${t.grossUsdcAtomic} / 10000`,
    ),
    entryRakeZero: check('earn_events_entry_rake_zero', sql`${t.rakeBps} = 0`),
    backingNetworkValid: check(
      'earn_events_backing_network_valid',
      sql`${t.backingNetwork} IN ('mainnet', 'devnet')`,
    ),
    verificationShape: check(
      'earn_events_verification_shape',
      sql`(${t.payerVerification} = 'pending' AND ${t.verifiedAt} IS NULL)
        OR (${t.payerVerification} = 'verified'
            AND ${t.verifiedAt} IS NOT NULL AND ${t.firstFunderWallet} IS NOT NULL)
        OR (${t.payerVerification} = 'rejected'
            AND ${t.verifiedAt} IS NOT NULL AND ${t.verificationReason} IS NOT NULL)`,
    ),
    clawbackShape: check(
      'earn_events_clawback_shape',
      sql`(${t.clawedBackAt} IS NULL AND ${t.clawbackReason} IS NULL)
        OR (${t.clawedBackAt} IS NOT NULL AND ${t.clawbackReason} IS NOT NULL)`,
    ),
  }),
);

/** E1 inner bound: one payer wallet cannot exceed the pair cap per epoch. */
export const earnWalletEpochCounters = pgTable(
  'earn_wallet_epoch_counters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    backingNetwork: varchar('backing_network', { length: 16 }).notNull(),
    payerWallet: varchar('payer_wallet', { length: 64 }).notNull(),
    earnerAvatarId: uuid('earner_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'restrict' }),
    epochStart: timestamp('epoch_start', { withTimezone: true }).notNull(),
    usdcAtomic: numeric('usdc_atomic', { precision: 20, scale: 0 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    walletEpochUnique: uniqueIndex('earn_wallet_epoch_unique').on(
      t.backingNetwork,
      t.payerWallet,
      t.earnerAvatarId,
      t.epochStart,
    ),
    nonnegative: check('earn_wallet_epoch_nonnegative', sql`${t.usdcAtomic} >= 0`),
    networkValid: check('earn_wallet_epoch_network_valid',
      sql`${t.backingNetwork} IN ('mainnet', 'devnet')`),
  }),
);

/** E2 outer bound: first-funder-linked payer wallets share one cap bucket. */
export const earnClusterEpochCounters = pgTable(
  'earn_cluster_epoch_counters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payerClusterKey: varchar('payer_cluster_key', { length: 64 }).notNull(),
    backingNetwork: varchar('backing_network', { length: 16 }).notNull(),
    earnerAvatarId: uuid('earner_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'restrict' }),
    epochStart: timestamp('epoch_start', { withTimezone: true }).notNull(),
    usdcAtomic: numeric('usdc_atomic', { precision: 20, scale: 0 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    clusterEpochUnique: uniqueIndex('earn_cluster_epoch_unique').on(
      t.backingNetwork,
      t.payerClusterKey,
      t.earnerAvatarId,
      t.epochStart,
    ),
    nonnegative: check('earn_cluster_epoch_nonnegative', sql`${t.usdcAtomic} >= 0`),
    networkValid: check('earn_cluster_epoch_network_valid',
      sql`${t.backingNetwork} IN ('mainnet', 'devnet')`),
  }),
);

/** Durable payer-wallet -> first-funder cluster mapping produced by the job. */
export const earnPayerClusters = pgTable('earn_payer_clusters', {
  backingNetwork: varchar('backing_network', { length: 16 }).notNull(),
  payerWallet: varchar('payer_wallet', { length: 64 }).notNull(),
  firstFunderWallet: varchar('first_funder_wallet', { length: 64 }).notNull(),
  clusterKey: varchar('cluster_key', { length: 64 }).notNull(),
  walletAgeSeconds: integer('wallet_age_seconds').notNull(),
  signatureCount: integer('signature_count').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
}, (t) => ({
  networkPayerPk: primaryKey({
    name: 'earn_payer_clusters_network_payer_pk',
    columns: [t.backingNetwork, t.payerWallet],
  }),
  heuristicNonnegative: check(
    'earn_payer_clusters_heuristic_nonnegative',
    sql`${t.walletAgeSeconds} >= 0 AND ${t.signatureCount} >= 0`,
  ),
  networkValid: check('earn_payer_clusters_network_valid',
    sql`${t.backingNetwork} IN ('mainnet', 'devnet')`),
}));

/** One fungibility lot per EARNED mint, including unbacked agent-pay mints. */
export const earnedMintLots = pgTable(
  'earned_mint_lots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => clawTokenTransactions.id, { onDelete: 'restrict' }),
    earnEventId: uuid('earn_event_id').references(() => earnEvents.id, {
      onDelete: 'restrict',
    }),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'restrict' }),
    backingKind: earnedBackingKindEnum('backing_kind').notNull(),
    /** Mint identity, e.g. earn:<event> or agent-pay:<payment>. */
    mintRef: varchar('mint_ref', { length: 200 }).notNull(),
    originalVclaw: integer('original_vclaw').notNull(),
    remainingVclaw: integer('remaining_vclaw').notNull(),
    exhaustedAt: timestamp('exhausted_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: text('release_reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ledgerUnique: uniqueIndex('earned_mint_lots_ledger_unique').on(t.ledgerId),
    eventUnique: uniqueIndex('earned_mint_lots_event_unique')
      .on(t.earnEventId)
      .where(sql`earn_event_id IS NOT NULL`),
    mintRefUnique: uniqueIndex('earned_mint_lots_ref_unique').on(t.mintRef),
    avatarRemainingIdx: index('earned_mint_lots_avatar_remaining_idx').on(
      t.avatarId,
      t.backingKind,
      t.createdAt,
    ),
    amountShape: check(
      'earned_mint_lots_amount_shape',
      sql`${t.originalVclaw} > 0 AND ${t.remainingVclaw} >= 0
        AND ${t.remainingVclaw} <= ${t.originalVclaw}`,
    ),
    releaseShape: check(
      'earned_mint_lots_release_shape',
      sql`(${t.releasedAt} IS NULL AND ${t.releaseReason} IS NULL)
        OR (${t.releasedAt} IS NOT NULL AND ${t.releaseReason} IS NOT NULL)`,
    ),
  }),
);

/**
 * Physical backing ledger. Initially backed lots have a row here; an agent-pay
 * ④ `none` lot is structurally absent. A rejected/clawed backed lot retains a
 * zero-remaining historical row, so only `remaining_usdc_atomic` enters solvency.
 */
export const earnedBackings = pgTable(
  'earned_backing',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mintLotId: uuid('mint_lot_id')
      .notNull()
      .references(() => earnedMintLots.id, { onDelete: 'restrict' }),
    custodyWalletId: uuid('custody_wallet_id')
      .notNull()
      .references(() => treasuryWallets.id, { onDelete: 'restrict' }),
    /** Unique inbound settlement ref: one house-held dollar backs one mint. */
    sourceRef: varchar('source_ref', { length: 200 }).notNull(),
    originalUsdcAtomic: numeric('original_usdc_atomic', { precision: 20, scale: 0 })
      .notNull(),
    remainingUsdcAtomic: numeric('remaining_usdc_atomic', { precision: 20, scale: 0 })
      .notNull(),
    consumedUsdcAtomic: numeric('consumed_usdc_atomic', { precision: 20, scale: 0 })
      .notNull()
      .default('0'),
    releasedUsdcAtomic: numeric('released_usdc_atomic', { precision: 20, scale: 0 })
      .notNull()
      .default('0'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lotUnique: uniqueIndex('earned_backing_lot_unique').on(t.mintLotId),
    sourceUnique: uniqueIndex('earned_backing_source_unique').on(t.sourceRef),
    custodyIdx: index('earned_backing_custody_idx').on(t.custodyWalletId, t.updatedAt),
    conservation: check(
      'earned_backing_conservation',
      sql`${t.originalUsdcAtomic} > 0 AND ${t.remainingUsdcAtomic} >= 0
        AND ${t.consumedUsdcAtomic} >= 0
        AND ${t.releasedUsdcAtomic} >= 0
        AND ${t.originalUsdcAtomic} = ${t.remainingUsdcAtomic}
          + ${t.consumedUsdcAtomic} + ${t.releasedUsdcAtomic}`,
    ),
  }),
);

/** Exact lot attribution for every EARNED debit. */
export const earnedLotConsumptions = pgTable(
  'earned_lot_consumptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mintLotId: uuid('mint_lot_id')
      .notNull()
      .references(() => earnedMintLots.id, { onDelete: 'restrict' }),
    ledgerDebitId: uuid('ledger_debit_id')
      .notNull()
      .references(() => clawTokenTransactions.id, { onDelete: 'restrict' }),
    kind: earnedConsumptionKindEnum('kind').notNull(),
    vclawAmount: integer('vclaw_amount').notNull(),
    usdcAtomic: numeric('usdc_atomic', { precision: 20, scale: 0 }).notNull(),
    /** Redemption/clawback row id; NULL for an ordinary in-game spend. */
    referenceId: uuid('reference_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lotLedgerUnique: uniqueIndex('earned_lot_consumptions_lot_ledger_unique').on(
      t.mintLotId,
      t.ledgerDebitId,
    ),
    referenceIdx: index('earned_lot_consumptions_reference_idx').on(t.kind, t.referenceId),
    positive: check(
      'earned_lot_consumptions_positive',
      sql`${t.vclawAmount} > 0 AND ${t.usdcAtomic} >= 0`,
    ),
  }),
);

/** One durable, idempotent administrative reversal per fraudulent earn event. */
export const earnClawbacks = pgTable(
  'earn_clawbacks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    earnEventId: uuid('earn_event_id')
      .notNull()
      .references(() => earnEvents.id, { onDelete: 'restrict' }),
    requestedVclaw: integer('requested_vclaw').notNull(),
    debitedVclaw: integer('debited_vclaw').notNull(),
    deficitVclaw: integer('deficit_vclaw').notNull(),
    releasedUsdcAtomic: numeric('released_usdc_atomic', { precision: 20, scale: 0 })
      .notNull(),
    ledgerDebitId: uuid('ledger_debit_id').references(() => clawTokenTransactions.id, {
      onDelete: 'restrict',
    }),
    reason: text('reason').notNull(),
    adminUserId: text('admin_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    eventUnique: uniqueIndex('earn_clawbacks_event_unique').on(t.earnEventId),
    conservation: check(
      'earn_clawbacks_conservation',
      sql`${t.requestedVclaw} > 0 AND ${t.debitedVclaw} >= 0
        AND ${t.deficitVclaw} >= 0
        AND ${t.requestedVclaw} = ${t.debitedVclaw} + ${t.deficitVclaw}`,
    ),
    ledgerShape: check(
      'earn_clawbacks_ledger_shape',
      sql`(${t.debitedVclaw} = 0 AND ${t.ledgerDebitId} IS NULL)
        OR (${t.debitedVclaw} > 0 AND ${t.ledgerDebitId} IS NOT NULL)`,
    ),
    releaseNonnegative: check(
      'earn_clawbacks_release_nonnegative',
      sql`${t.releasedUsdcAtomic} >= 0`,
    ),
  }),
);

export type EarnEvent = typeof earnEvents.$inferSelect;
export type EarnedMintLot = typeof earnedMintLots.$inferSelect;
export type EarnedBacking = typeof earnedBackings.$inferSelect;
export type EarnClawback = typeof earnClawbacks.$inferSelect;
