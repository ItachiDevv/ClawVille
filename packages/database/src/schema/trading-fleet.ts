import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { avatars } from './avatars';
import { users } from './users';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export interface TradingBaselineEvidence {
  slot: number;
  equityUsdMicros: string;
  nativeLamports: string;
  positions: Array<{
    symbol: string;
    mint: string;
    amountAtomic: string;
    decimals: number;
    valueUsdMicros: string;
    priceUsdMicros: string;
    priceTimestampMs: number;
  }>;
}

export const clawpumpAgentLinks = pgTable('clawpump_agent_links', {
  avatarId: uuid('avatar_id').primaryKey().references(() => avatars.id, { onDelete: 'restrict' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  clawvilleAgentId: varchar('clawville_agent_id', { length: 128 }),
  clawpumpAgentId: varchar('clawpump_agent_id', { length: 128 }).unique(),
  walletPubkey: varchar('wallet_pubkey', { length: 64 }).notNull().unique(),
  objective: varchar('objective', { length: 48 }).notNull(),
  armed: boolean('armed').default(false).notNull(),
  killed: boolean('killed').default(true).notNull(),
  floatStartLamports: numeric('float_start_lamports', { precision: 20, scale: 0 }).default('0').notNull(),
  floatStartUsdMicros: numeric('float_start_usd_micros', { precision: 20, scale: 0 }).default('0').notNull(),
  baselineSlot: bigint('baseline_slot', { mode: 'number' }),
  baselineEvidence: jsonb('baseline_evidence').$type<TradingBaselineEvidence>(),
  operatedByClawville: boolean('operated_by_clawville').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  objectiveValid: check('clawpump_agent_links_objective_valid', sql`${t.objective} IN ('momentum-board','ansem-clawville-dca','sol-usdc-mean-reversion','intel-signal-follower','conservative-rebalancer')`),
  floatNonneg: check('clawpump_agent_links_float_nonneg', sql`${t.floatStartLamports} >= 0 AND ${t.floatStartUsdMicros} >= 0`),
  armedNeedsBaseline: check('clawpump_agent_links_armed_needs_baseline', sql`${t.armed} = false OR ${t.floatStartUsdMicros} > 0`),
  armedNeedsEvidence: check('clawpump_agent_links_armed_needs_evidence', sql`${t.armed} = false OR ${t.baselineEvidence} IS NOT NULL`),
}));

export const tradingDecisions = pgTable('trading_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'restrict' }),
  origin: varchar('origin', { length: 16 }).notNull(),
  inputMint: varchar('input_mint', { length: 64 }).notNull(),
  outputMint: varchar('output_mint', { length: 64 }).notNull(),
  amountUsdMicros: numeric('amount_usd_micros', { precision: 20, scale: 0 }).notNull(),
  amountAtomic: numeric('amount_atomic', { precision: 40, scale: 0 }),
  slippageBps: integer('slippage_bps'),
  verdict: varchar('verdict', { length: 32 }).notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  reason: varchar('reason', { length: 240 }).default('').notNull(),
  detail: varchar('detail', { length: 400 }).default('').notNull(),
  signature: varchar('signature', { length: 128 }),
  signedTxBytes: bytea('signed_tx_bytes'),
  recentBlockhash: varchar('recent_blockhash', { length: 64 }),
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'number' }),
  buildHash: varchar('build_hash', { length: 64 }),
  localConfirmOutcome: varchar('local_confirm_outcome', { length: 12 }),
  localConfirmSlot: bigint('local_confirm_slot', { mode: 'number' }),
  localConfirmedAt: timestamp('local_confirmed_at', { withTimezone: true }),
  directiveId: varchar('directive_id', { length: 64 }),
  directiveOrdinal: integer('directive_ordinal'),
  operatorId: uuid('operator_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, (t) => ({
  originValid: check('trading_decisions_origin_valid', sql`${t.origin} IN ('autonomous','agent-tool','human-rest','admin-test')`),
  statusValid: check('trading_decisions_status_valid', sql`${t.status} IN ('refused','admitted','submitted','executed','failed','expired','reconcile')`),
  amountPositive: check('trading_decisions_amount_positive', sql`${t.amountUsdMicros} > 0`),
  localConfirmValid: check('trading_decisions_local_confirm_valid', sql`${t.localConfirmOutcome} IS NULL OR ${t.localConfirmOutcome} IN ('confirmed','failed')`),
  avatarSpendIdx: index('trading_decisions_avatar_spend_idx').on(t.avatarId, t.createdAt).where(sql`${t.status} IN ('admitted','submitted','executed','reconcile')`),
  signatureUniq: uniqueIndex('trading_decisions_signature_uniq').on(t.signature).where(sql`${t.signature} IS NOT NULL`),
  directiveUniq: uniqueIndex('trading_decisions_directive_uniq').on(t.directiveId, t.directiveOrdinal).where(sql`${t.directiveId} IS NOT NULL`),
  feedIdx: index('trading_decisions_feed_idx').on(t.createdAt.desc()),
}));

export const tradingHalts = pgTable('trading_halts', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: varchar('scope', { length: 8 }).notNull(),
  scopeId: uuid('scope_id'),
  reason: varchar('reason', { length: 240 }).notNull(),
  engagedBy: varchar('engaged_by', { length: 64 }).notNull(),
  haltedAt: timestamp('halted_at', { withTimezone: true }).defaultNow().notNull(),
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
  clearedBy: varchar('cleared_by', { length: 64 }),
}, (t) => ({
  scopeValid: check('trading_halts_scope_valid', sql`(${t.scope}='fleet' AND ${t.scopeId} IS NULL) OR (${t.scope}='agent' AND ${t.scopeId} IS NOT NULL)`),
  clearStamp: check('trading_halts_clear_stamp', sql`(${t.clearedAt} IS NULL) = (${t.clearedBy} IS NULL)`),
  activeFleetUniq: uniqueIndex('trading_halts_active_fleet_uniq').on(t.scope).where(sql`${t.scope}='fleet' AND ${t.clearedAt} IS NULL`),
  activeAgentUniq: uniqueIndex('trading_halts_active_agent_uniq').on(t.scopeId).where(sql`${t.scope}='agent' AND ${t.clearedAt} IS NULL`),
}));

export const tradingUsdcReservations = pgTable('trading_usdc_reservations', {
  decisionId: uuid('decision_id').primaryKey().references(() => tradingDecisions.id, { onDelete: 'restrict' }),
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'restrict' }),
  amountBaseUnits: numeric('amount_base_units', { precision: 20, scale: 0 }).notNull(),
  status: varchar('status', { length: 16 }).default('open').notNull(),
  releaseReason: varchar('release_reason', { length: 64 }),
  lastWedgeAlertAt: timestamp('last_wedge_alert_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
}, (t) => ({
  amountPositive: check('trading_usdc_reservations_amount_positive', sql`${t.amountBaseUnits} > 0`),
  statusValid: check('trading_usdc_reservations_status_valid', sql`${t.status} IN ('open','settled','failed','expired','reconcile')`),
  releaseStamp: check('trading_usdc_reservations_release_stamp', sql`(${t.status} IN ('open','reconcile')) = (${t.releasedAt} IS NULL)`),
  liabilityIdx: index('trading_usdc_reservations_liability_idx').on(t.avatarId).where(sql`${t.status} IN ('open','reconcile')`),
}));

export type TradingLink = typeof clawpumpAgentLinks.$inferSelect;
export type TradingDecisionRow = typeof tradingDecisions.$inferSelect;
export type TradingHalt = typeof tradingHalts.$inferSelect;
export type TradingUsdcReservation = typeof tradingUsdcReservations.$inferSelect;
