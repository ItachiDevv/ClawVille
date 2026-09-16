import {
  bigint,
  boolean,
  check,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  text,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { avatars } from './avatars';
import { agentBots } from './claws';

export const tradingWallets = pgTable('trading_wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  subjectKind: varchar('subject_kind', { length: 8 }).notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'cascade' }),
  agentId: varchar('agent_id', { length: 200 }).references(() => agentBots.agentId, { onDelete: 'cascade' }),
  pubkey: varchar('pubkey', { length: 44 }).notNull(),
  source: varchar('source', { length: 16 }).notNull(),
  operatedByClawville: boolean('operated_by_clawville').default(false).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  boundAt: timestamp('bound_at', { withTimezone: true }).defaultNow().notNull(),
  boundSlot: bigint('bound_slot', { mode: 'number' }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  cursorSignature: varchar('cursor_signature', { length: 128 }),
  cursorBlockTime: bigint('cursor_block_time', { mode: 'number' }),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  subjectAgentConsistent: check('trading_wallets_subject_agent_consistent', sql`(${t.subjectKind} = 'agent') = (${t.agentId} IS NOT NULL)`),
  subjectKindCheck: check('trading_wallets_subject_kind_check', sql`${t.subjectKind} IN ('avatar', 'agent')`),
  sourceCheck: check('trading_wallets_source_check', sql`${t.source} IN ('linked', 'clawpump', 'custodial', 'signed')`),
  pubkeyActiveUnique: uniqueIndex('trading_wallets_pubkey_active_unique').on(t.pubkey).where(sql`${t.revokedAt} IS NULL`),
  avatarActiveIdx: index('trading_wallets_avatar_active_idx').on(t.avatarId).where(sql`${t.revokedAt} IS NULL`),
  observerIdx: index('trading_wallets_observer_idx').on(t.lastPolledAt.asc().nullsFirst()).where(sql`${t.revokedAt} IS NULL`),
}));

export const verifiedTrades = pgTable('verified_trades', {
  signature: varchar('signature', { length: 128 }).primaryKey(),
  tradingWalletId: uuid('trading_wallet_id').references(() => tradingWallets.id, { onDelete: 'set null' }),
  subjectKind: varchar('subject_kind', { length: 8 }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  avatarId: uuid('avatar_id').references(() => avatars.id, { onDelete: 'set null' }),
  agentId: varchar('agent_id', { length: 200 }),
  wallet: varchar('wallet', { length: 44 }).notNull(),
  dex: varchar('dex', { length: 16 }).notNull(),
  inputMint: varchar('input_mint', { length: 44 }).notNull(),
  outputMint: varchar('output_mint', { length: 44 }).notNull(),
  inputAmount: numeric('input_amount', { precision: 40, scale: 0 }).notNull(),
  outputAmount: numeric('output_amount', { precision: 40, scale: 0 }).notNull(),
  inputDecimals: smallint('input_decimals').notNull(),
  outputDecimals: smallint('output_decimals').notNull(),
  notionalUsd: numeric('notional_usd', { precision: 20, scale: 6 }),
  notionalSource: varchar('notional_source', { length: 16 }),
  multiplierTier: varchar('multiplier_tier', { length: 8 }).notNull(),
  scored: boolean('scored').default(false).notNull(),
  unscoredReason: varchar('unscored_reason', { length: 32 }),
  eventId: bigint('event_id', { mode: 'bigint' }),
  blockTime: bigint('block_time', { mode: 'number' }),
  slot: bigint('slot', { mode: 'number' }).notNull(),
  scoreDay: date('score_day'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
  decisionId: text('decision_id'),
  source: varchar('source', { length: 12 }).notNull(),
}, (t) => ({
  subjectAgentConsistent: check('verified_trades_subject_agent_consistent', sql`(${t.subjectKind} = 'agent') = (${t.agentId} IS NOT NULL)`),
  subjectKindCheck: check('verified_trades_subject_kind_check', sql`${t.subjectKind} IN ('avatar', 'agent')`),
  dexCheck: check('verified_trades_dex_check', sql`${t.dex} IN ('jupiter', 'pumpswap', 'pumpfun')`),
  notionalSourceCheck: check('verified_trades_notional_source_check', sql`${t.notionalSource} IS NULL OR ${t.notionalSource} IN ('usdc_leg', 'live_price')`),
  tierCheck: check('verified_trades_multiplier_tier_check', sql`${t.multiplierTier} IN ('base', 'clv', 'ansem')`),
  reasonCheck: check('verified_trades_unscored_reason_check', sql`${t.unscoredReason} IS NULL OR ${t.unscoredReason} IN ('below_min_notional','price_unavailable','price_stale_window','pre_bind','chain_time_unavailable','pair_repeat_today','daily_cap')`),
  sourceCheck: check('verified_trades_source_check', sql`${t.source} IN ('observer', 'report', 'prime')`),
  scoredStamp: check('verified_trades_scored_stamp', sql`(${t.scored} = true) = (${t.unscoredReason} IS NULL)`),
  scoredNeedsChainTime: check('verified_trades_scored_needs_chain_time', sql`${t.scored} = false OR (${t.slot} IS NOT NULL AND ${t.blockTime} IS NOT NULL AND ${t.scoreDay} IS NOT NULL)`),
  amountsPositive: check('verified_trades_amounts_positive', sql`${t.inputAmount} > 0 AND ${t.outputAmount} > 0`),
  decimalsSane: check('verified_trades_decimals_sane', sql`${t.inputDecimals} BETWEEN 0 AND 18 AND ${t.outputDecimals} BETWEEN 0 AND 18`),
  notionalPair: check('verified_trades_notional_pair', sql`(${t.notionalUsd} IS NULL) = (${t.notionalSource} IS NULL)`),
  avatarTimeIdx: index('verified_trades_avatar_time_idx').on(t.avatarId, t.verifiedAt.desc()),
  feedIdx: index('verified_trades_feed_idx').on(t.verifiedAt.desc()),
  dailyCapIdx: index('verified_trades_daily_cap_idx').on(t.avatarId, t.verifiedAt).where(sql`${t.scored}`),
}));

export type TradingWallet = typeof tradingWallets.$inferSelect;
export type NewTradingWallet = typeof tradingWallets.$inferInsert;
export type VerifiedTrade = typeof verifiedTrades.$inferSelect;
export type NewVerifiedTrade = typeof verifiedTrades.$inferInsert;
