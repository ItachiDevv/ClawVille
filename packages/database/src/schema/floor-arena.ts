/**
 * Trading Floor Arena (paper contest) tables. Contract:
 * `docs/trading-floor-arena.md` §4. Migrations: `0070_floor_arena.sql` + `0072_floor_arena_sources.sql`
 * + `0074_floor_arena_withdraw.sql` (idempotent, applied by the CI migrate gate, NEVER db:push).
 *
 * `floor_arena_addon_calls` and `floor_arena_withdrawals` record REAL USDC
 * and SOL that leave an agent's own ClawPump wallet. The other tables are
 * paper: their `numeric` P&L columns are paper USD. No table here holds a
 * ClawToken balance or a wallet secret. The live Floor board keeps reading
 * `verified_trades` and never these tables.
 *
 * The value sets in the CHECK constraints are the `FLOOR_ARENA_*` arrays in
 * `@clawville/shared` (constants/floor-arena.ts). drizzle-kit 0.24 does not
 * emit CHECKs, so the migration adds them in guarded DO blocks; the `check()`
 * entries here document them and keep the two in one place per table.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  FloorArenaAddonCallState,
  FloorArenaAgentAddon,
  FloorArenaAgentKind,
  FloorArenaAgentStatus,
  FloorArenaChainVerdict,
  FloorArenaEntryFillSource,
  FloorArenaEventType,
  FloorArenaExitFillSource,
  FloorArenaExitRun,
  FloorArenaExitReason,
  FloorArenaMode,
  FloorArenaParamChangeSource,
  FloorArenaParamDiff,
  FloorArenaParams,
  FloorArenaPositionStatus,
  FloorArenaProvisionState,
  FloorArenaSuggestion,
  FloorArenaSuggestionState,
  FloorArenaWithdrawAddressProof,
  FloorArenaWithdrawAmountMode,
  FloorArenaWithdrawAsset,
  FloorArenaWithdrawRevokeReason,
  FloorArenaWithdrawState,
  FloorArenaWithdrawSubjectKind,
  FloorDiscoverySnapshot,
} from '@clawville/shared';
import { users } from './users';

/** The ONE shared discovery queue (D2): each source is polled once per
 *  interval and every agent reads this table. */
export const floorDiscoveryMints = pgTable('floor_discovery_mints', {
  mint: text('mint').primaryKey(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  firstSource: text('first_source').notNull(),
  sources: text('sources').array().notNull().default(sql`'{}'::text[]`),
  /** D25: first sighting per source, {"<source id>": "<ISO time>"} (migration 0072). */
  sourceFirstSeen: jsonb('source_first_seen').$type<Record<string, string>>().default(sql`'{}'::jsonb`).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  symbol: text('symbol'),
  name: text('name'),
  snapshot: jsonb('snapshot').$type<FloorDiscoverySnapshot>(),
  snapshotAt: timestamp('snapshot_at', { withTimezone: true }),
  chainVerdict: jsonb('chain_verdict').$type<FloorArenaChainVerdict>(),
  chainCheckedAt: timestamp('chain_checked_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  firstSeenIdx: index('floor_discovery_mints_first_seen_idx').on(t.firstSeenAt.desc()),
  expiresIdx: index('floor_discovery_mints_expires_idx').on(t.expiresAt),
}));

/** One row per arena agent. House ids are `house:<templateId>`; user ids are
 *  uuid strings. A house row has no owner; a user row always has one, which
 *  makes the one-agent-per-account index cover every user row (D6). */
export const floorArenaAgents = pgTable('floor_arena_agents', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<FloorArenaAgentKind>().notNull(),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
  avatarId: uuid('avatar_id'),
  name: text('name').notNull(),
  templateId: text('template_id').notNull(),
  /** House rows below FLOOR_ARENA_TEMPLATE_VERSION get their params reset to the template (migration 0072). */
  templateVersion: integer('template_version').default(1).notNull(),
  params: jsonb('params').$type<FloorArenaParams>().notNull(),
  paramsVersion: integer('params_version').default(1).notNull(),
  mode: text('mode').$type<FloorArenaMode>().default('paper').notNull(),
  status: text('status').$type<FloorArenaAgentStatus>().default('active').notNull(),
  seated: boolean('seated').default(false).notNull(),
  seatIndex: integer('seat_index'),
  seatedAt: timestamp('seated_at', { withTimezone: true }),
  clawpumpAgentId: text('clawpump_agent_id'),
  clawpumpWallet: text('clawpump_wallet'),
  provisionState: text('provision_state').$type<FloorArenaProvisionState>().default('none').notNull(),
  provisionError: text('provision_error'),
  /** D8 retry state: failed ClawPump provisioning retries with backoff. */
  provisionAttempts: integer('provision_attempts').default(0).notNull(),
  provisionNextAt: timestamp('provision_next_at', { withTimezone: true }),
  addons: jsonb('addons').$type<FloorArenaAgentAddon[]>().default(sql`'[]'::jsonb`).notNull(),
  autoApplySuggestions: boolean('auto_apply_suggestions').default(false).notNull(),
  contestId: text('contest_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  kindValid: check('floor_arena_agents_kind_valid', sql`${t.kind} IN ('house','user')`),
  ownerMatchesKind: check('floor_arena_agents_owner_matches_kind', sql`(${t.kind} = 'house' AND ${t.ownerUserId} IS NULL) OR (${t.kind} = 'user' AND ${t.ownerUserId} IS NOT NULL)`),
  modeValid: check('floor_arena_agents_mode_valid', sql`${t.mode} IN ('paper','live')`),
  statusValid: check('floor_arena_agents_status_valid', sql`${t.status} IN ('active','paused','stopped')`),
  provisionStateValid: check('floor_arena_agents_provision_state_valid', sql`${t.provisionState} IN ('none','pending','creating','ready','failed')`),
  oneUserAgentPerOwner: uniqueIndex('floor_arena_agents_one_user_per_owner_uniq').on(t.ownerUserId).where(sql`${t.kind} = 'user'`),
  // One ClawPump agent serves at most one arena agent (D8).
  clawpumpAgentUq: uniqueIndex('floor_arena_agents_clawpump_agent_uq').on(t.clawpumpAgentId).where(sql`${t.clawpumpAgentId} IS NOT NULL`),
}));

/** Paper positions. `remaining_fraction` falls as take-profit legs fire; the
 *  legs are ascending (validateFloorArenaParams), so the fired legs follow
 *  from it. At most one OPEN position per agent and mint. */
export const floorArenaPositions = pgTable('floor_arena_positions', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: text('agent_id').notNull().references(() => floorArenaAgents.id, { onDelete: 'cascade' }),
  mint: text('mint').notNull(),
  symbol: text('symbol'),
  source: text('source'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  sizeUsd: numeric('size_usd').notNull(),
  tokens: numeric('tokens').notNull(),
  entryPriceUsd: numeric('entry_price_usd').notNull(),
  entryFillSource: text('entry_fill_source').$type<FloorArenaEntryFillSource>(),
  entryFeatures: jsonb('entry_features').$type<Record<string, unknown>>(),
  paramsVersion: integer('params_version').notNull(),
  peakMult: numeric('peak_mult').default('1').notNull(),
  lastMarkMult: numeric('last_mark_mult'),
  lastMarkAt: timestamp('last_mark_at', { withTimezone: true }),
  remainingFraction: numeric('remaining_fraction').default('1').notNull(),
  realisedUsd: numeric('realised_usd').default('0').notNull(),
  status: text('status').$type<FloorArenaPositionStatus>().default('open').notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  exitReason: text('exit_reason').$type<FloorArenaExitReason>(),
  exitFillSource: text('exit_fill_source').$type<FloorArenaExitFillSource>(),
  pnlUsd: numeric('pnl_usd'),
  pnlMult: numeric('pnl_mult'),
  exitQuoteFailures: integer('exit_quote_failures').default(0).notNull(),
  /** The engine's record of a failing exit (FloorArenaExitRun); NULL while no exit has failed. */
  exitRun: jsonb('exit_run').$type<FloorArenaExitRun>(),
}, (t) => ({
  statusValid: check('floor_arena_positions_status_valid', sql`${t.status} IN ('open','closed')`),
  closedStamp: check('floor_arena_positions_closed_stamp', sql`(${t.status} = 'open' AND ${t.closedAt} IS NULL) OR (${t.status} = 'closed' AND ${t.closedAt} IS NOT NULL AND ${t.exitReason} IS NOT NULL)`),
  exitReasonValid: check('floor_arena_positions_exit_reason_valid', sql`${t.exitReason} IS NULL OR ${t.exitReason} IN ('tp','stop','trail','time','manual','unresolved')`),
  entryFillSourceValid: check('floor_arena_positions_entry_fill_source_valid', sql`${t.entryFillSource} IS NULL OR ${t.entryFillSource} IN ('quote')`),
  exitFillSourceValid: check('floor_arena_positions_exit_fill_source_valid', sql`${t.exitFillSource} IS NULL OR ${t.exitFillSource} IN ('quote','mark_fallback','quote_confirmed','unresolved')`),
  // A closed position has a P&L unless its exit is unresolved.
  closedPnl: check('floor_arena_positions_closed_pnl', sql`${t.status} = 'open' OR ${t.pnlUsd} IS NOT NULL OR ${t.exitReason} = 'unresolved'`),
  amountsPositive: check('floor_arena_positions_amounts_positive', sql`${t.sizeUsd} > 0 AND ${t.tokens} > 0 AND ${t.entryPriceUsd} > 0`),
  remainingFractionRange: check('floor_arena_positions_remaining_fraction_range', sql`${t.remainingFraction} >= 0 AND ${t.remainingFraction} <= 1`),
  agentStatusIdx: index('floor_arena_positions_agent_status_idx').on(t.agentId, t.status),
  agentOpenedIdx: index('floor_arena_positions_agent_opened_idx').on(t.agentId, t.openedAt.desc()),
  closedIdx: index('floor_arena_positions_closed_idx').on(t.closedAt),
  openMintUniq: uniqueIndex('floor_arena_positions_open_mint_uniq').on(t.agentId, t.mint).where(sql`${t.status} = 'open'`),
}));

/** The public decision stream. `summary` is at most
 *  FLOOR_ARENA_EVENT_SUMMARY_MAX characters (writers truncate). Retention:
 *  prune rows older than 7 days except entry/exit/param_change/report. The
 *  `mode: 'number'` id is safe below 2^53 and serialises to JSON directly. */
export const floorArenaEvents = pgTable('floor_arena_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: text('agent_id').notNull().references(() => floorArenaAgents.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  type: text('type').$type<FloorArenaEventType>().notNull(),
  mint: text('mint'),
  summary: text('summary').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>(),
}, (t) => ({
  typeValid: check('floor_arena_events_type_valid', sql`${t.type} IN ('scan','pass','skip','entry','exit','param_change','report','status','addon','withdraw')`),
  agentIdIdx: index('floor_arena_events_agent_id_idx').on(t.agentId, t.id.desc()),
  atIdx: index('floor_arena_events_at_idx').on(t.at),
  // The public trade tape: newest entry/exit rows without walking scan/pass/skip rows.
  tradesIdx: index('floor_arena_events_trades_idx').on(t.id.desc()).where(sql`${t.type} IN ('entry','exit')`),
}));

/** 30-minute analysis reports (D10); at most one suggestion each. */
export const floorArenaReports = pgTable('floor_arena_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: text('agent_id').notNull().references(() => floorArenaAgents.id, { onDelete: 'cascade' }),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  stats: jsonb('stats').$type<Record<string, unknown>>().notNull(),
  summary: text('summary'),
  suggestion: jsonb('suggestion').$type<FloorArenaSuggestion>(),
  suggestionState: text('suggestion_state').$type<FloorArenaSuggestionState>().default('none').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  suggestionStateValid: check('floor_arena_reports_suggestion_state_valid', sql`${t.suggestionState} IN ('none','pending','applied','dismissed','auto_applied','rejected')`),
  agentCreatedIdx: index('floor_arena_reports_agent_created_idx').on(t.agentId, t.createdAt.desc()),
}));

/** Public log of every param change (diff list from diffFloorArenaParams). */
export const floorArenaParamChanges = pgTable('floor_arena_param_changes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: text('agent_id').notNull().references(() => floorArenaAgents.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  source: text('source').$type<FloorArenaParamChangeSource>().notNull(),
  changes: jsonb('changes').$type<FloorArenaParamDiff[]>().notNull(),
  paramsVersion: integer('params_version').notNull(),
  reason: text('reason'),
}, (t) => ({
  sourceValid: check('floor_arena_param_changes_source_valid', sql`${t.source} IN ('user','house-tuner','admin','suggestion')`),
  agentAtIdx: index('floor_arena_param_changes_agent_at_idx').on(t.agentId, t.at.desc()),
}));

/** Mints a paid add-on surfaced: visible to that agent only (D9). They never
 *  enter the shared queue, so they carry their own DexScreener snapshot and
 *  chain verdict (same shapes as floor_discovery_mints). */
export const floorArenaPrivateMints = pgTable('floor_arena_private_mints', {
  agentId: text('agent_id').notNull().references(() => floorArenaAgents.id, { onDelete: 'cascade' }),
  mint: text('mint').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  source: text('source').notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  symbol: text('symbol'),
  snapshot: jsonb('snapshot').$type<FloorDiscoverySnapshot>(),
  snapshotAt: timestamp('snapshot_at', { withTimezone: true }),
  chainVerdict: jsonb('chain_verdict').$type<FloorArenaChainVerdict>(),
  chainCheckedAt: timestamp('chain_checked_at', { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ name: 'floor_arena_private_mints_pkey', columns: [t.agentId, t.mint] }),
  mintIdx: index('floor_arena_private_mints_mint_idx').on(t.mint),
}));

/** Spend ledger for paid x402 add-on calls. REAL USDC leaves the agent's own
 *  ClawPump wallet here, so `price_usd` has no default: every row states what
 *  it cost, and the daily cap sums it. A call is first written `reserved` (at
 *  the catalog price, under a per-agent lock) BEFORE the payment, then `done`
 *  with the charged amount, so a concurrent call cannot pass the cap. */
export const floorArenaAddonCalls = pgTable('floor_arena_addon_calls', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: text('agent_id').notNull().references(() => floorArenaAgents.id, { onDelete: 'cascade' }),
  addonId: text('addon_id').notNull(),
  at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  priceUsd: numeric('price_usd').notNull(),
  ok: boolean('ok').notNull(),
  error: text('error'),
  mints: integer('mints').default(0).notNull(),
  responseRef: text('response_ref'),
  state: text('state').$type<FloorArenaAddonCallState>().default('done').notNull(),
}, (t) => ({
  stateValid: check('floor_arena_addon_calls_state_valid', sql`${t.state} IN ('reserved','done')`),
  priceNonneg: check('floor_arena_addon_calls_price_nonneg', sql`${t.priceUsd} >= 0`),
  mintsNonneg: check('floor_arena_addon_calls_mints_nonneg', sql`${t.mints} >= 0`),
  agentAddonAtIdx: index('floor_arena_addon_calls_agent_addon_at_idx').on(t.agentId, t.addonId, t.at.desc()),
}));

/** Proved withdraw destinations (D34-d, D34-e). At most one current (not revoked) row per agent: a new
 *  address revokes the old one (`replaced`) and works from `active_at`. A `signed` row keeps the exact
 *  message, the signature and the single-use challenge nonce; a `linked_wallet` row keeps none of them. */
export const floorArenaWithdrawAddresses = pgTable('floor_arena_withdraw_addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: text('agent_id').notNull().references(() => floorArenaAgents.id, { onDelete: 'cascade' }),
  ownerUserId: uuid('owner_user_id').notNull(),
  address: text('address').notNull(),
  proofKind: text('proof_kind').$type<FloorArenaWithdrawAddressProof>().notNull(),
  message: text('message'),
  signature: text('signature'),
  challengeNonce: text('challenge_nonce'),
  setBy: text('set_by').$type<FloorArenaWithdrawSubjectKind>().notNull(),
  setByAgentId: text('set_by_agent_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  activeAt: timestamp('active_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeReason: text('revoke_reason').$type<FloorArenaWithdrawRevokeReason>(),
}, (t) => ({
  proofValid: check('floor_arena_withdraw_addresses_proof_valid', sql`(${t.proofKind} = 'signed' AND ${t.message} IS NOT NULL AND ${t.signature} IS NOT NULL AND ${t.challengeNonce} IS NOT NULL) OR (${t.proofKind} = 'linked_wallet' AND ${t.message} IS NULL AND ${t.signature} IS NULL AND ${t.challengeNonce} IS NULL)`),
  setByValid: check('floor_arena_withdraw_addresses_set_by_valid', sql`${t.setBy} IN ('human','agent') AND ((${t.setBy} = 'agent') = (${t.setByAgentId} IS NOT NULL))`),
  revokeValid: check('floor_arena_withdraw_addresses_revoke_valid', sql`(${t.revokedAt} IS NULL AND ${t.revokeReason} IS NULL) OR (${t.revokedAt} IS NOT NULL AND ${t.revokeReason} IN ('owner','replaced','admin'))`),
  shape: check('floor_arena_withdraw_addresses_shape', sql`${t.address} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND ${t.activeAt} >= ${t.createdAt}`),
  oneCurrentUq: uniqueIndex('floor_arena_withdraw_addresses_one_current_uq').on(t.agentId).where(sql`${t.revokedAt} IS NULL`),
  nonceUq: uniqueIndex('floor_arena_withdraw_addresses_nonce_uq').on(t.challengeNonce).where(sql`${t.challengeNonce} IS NOT NULL`),
  agentCreatedIdx: index('floor_arena_withdraw_addresses_agent_created_idx').on(t.agentId, t.createdAt.desc()),
}));

/** Single-use proof challenges (D34-d): a DB row, not memory, because two API containers run during a
 *  deploy flip. Consumed once, before the signature check; dead after `expires_at`. */
export const floorArenaWithdrawChallenges = pgTable('floor_arena_withdraw_challenges', {
  nonce: text('nonce').primaryKey(),
  agentId: text('agent_id').notNull().references(() => floorArenaAgents.id, { onDelete: 'cascade' }),
  ownerUserId: uuid('owner_user_id').notNull(),
  address: text('address').notNull(),
  message: text('message').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  expiry: check('floor_arena_withdraw_challenges_expiry', sql`${t.expiresAt} > ${t.createdAt}`),
  agentIdx: index('floor_arena_withdraw_challenges_agent_idx').on(t.agentId, t.createdAt.desc()),
  expiresIdx: index('floor_arena_withdraw_challenges_expires_idx').on(t.expiresAt),
}));

/** Wallet withdrawals (D34). REAL USDC or SOL leaves the agent's own ClawPump wallet to `destination`,
 *  which is copied at request time from the active proved address (I3). States only move forward:
 *  requested -> dispatching -> sent -> confirmed, with side exits. The guard trigger
 *  `floor_arena_withdrawals_guard` (migration 0074 only; Drizzle has no triggers) refuses every move
 *  back to requested or dispatching and every change to a money field once it is set (I1, I2). The
 *  `*_atomic` and `*_lamports` columns are integer base units (USDC 6 decimals, SOL 9). */
export const floorArenaWithdrawals = pgTable('floor_arena_withdrawals', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: text('agent_id').notNull().references(() => floorArenaAgents.id, { onDelete: 'cascade' }),
  ownerUserId: uuid('owner_user_id').notNull(),
  subjectKind: text('subject_kind').$type<FloorArenaWithdrawSubjectKind>().notNull(),
  subjectAgentId: text('subject_agent_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  asset: text('asset').$type<FloorArenaWithdrawAsset>().notNull(),
  amountMode: text('amount_mode').$type<FloorArenaWithdrawAmountMode>().notNull(),
  requestedAtomic: bigint('requested_atomic', { mode: 'bigint' }),
  amountAtomic: bigint('amount_atomic', { mode: 'bigint' }),
  sourceClawpumpAgentId: text('source_clawpump_agent_id').notNull(),
  sourceWallet: text('source_wallet').notNull(),
  destination: text('destination').notNull(),
  addressId: uuid('address_id').notNull().references(() => floorArenaWithdrawAddresses.id),
  state: text('state').$type<FloorArenaWithdrawState>().default('requested').notNull(),
  errorCode: text('error_code'),
  preBalanceAtomic: bigint('pre_balance_atomic', { mode: 'bigint' }),
  preSolLamports: bigint('pre_sol_lamports', { mode: 'bigint' }),
  postBalanceAtomic: bigint('post_balance_atomic', { mode: 'bigint' }),
  txSignature: text('tx_signature'),
  recipientAccountCreated: boolean('recipient_account_created'),
  reviewNote: text('review_note'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  checkCount: integer('check_count').default(0).notNull(),
}, (t) => ({
  subjectValid: check('floor_arena_withdrawals_subject_valid', sql`${t.subjectKind} IN ('human','agent') AND ((${t.subjectKind} = 'agent') = (${t.subjectAgentId} IS NOT NULL))`),
  assetValid: check('floor_arena_withdrawals_asset_valid', sql`${t.asset} IN ('USDC','SOL')`),
  amountValid: check('floor_arena_withdrawals_amount_valid', sql`((${t.amountMode} = 'exact' AND ${t.requestedAtomic} IS NOT NULL AND ${t.requestedAtomic} > 0) OR (${t.amountMode} = 'max' AND ${t.requestedAtomic} IS NULL)) AND (${t.amountAtomic} IS NULL OR ${t.amountAtomic} > 0)`),
  stateValid: check('floor_arena_withdrawals_state_valid', sql`${t.state} IN ('requested','dispatching','sent','confirmed','cancelled','refused','failed','unknown','failed_no_send','needs_review')`),
  dispatchStamp: check('floor_arena_withdrawals_dispatch_stamp', sql`${t.state} IN ('requested','cancelled','refused') OR (${t.amountAtomic} IS NOT NULL AND ${t.dispatchedAt} IS NOT NULL)`),
  sentSignature: check('floor_arena_withdrawals_sent_signature', sql`${t.state} NOT IN ('sent','confirmed') OR ${t.txSignature} IS NOT NULL`),
  codesShape: check('floor_arena_withdrawals_codes_shape', sql`(${t.errorCode} IS NULL OR ${t.errorCode} ~ '^[a-z0-9_.:-]{1,64}$') AND ${t.idempotencyKey} ~ '^[A-Za-z0-9_-]{8,64}$'`),
  agentIdemUq: uniqueIndex('floor_arena_withdrawals_agent_idem_uq').on(t.agentId, t.idempotencyKey),
  // One open withdrawal per agent (FLOOR_ARENA_WITHDRAW_OPEN_STATES).
  oneOpenUq: uniqueIndex('floor_arena_withdrawals_one_open_uq').on(t.agentId).where(sql`${t.state} IN ('requested','dispatching','sent','unknown')`),
  // One chain signature belongs to one row (I7: a reused signature never confirms a second row).
  txUq: uniqueIndex('floor_arena_withdrawals_tx_uq').on(t.txSignature).where(sql`${t.txSignature} IS NOT NULL`),
  stateIdx: index('floor_arena_withdrawals_state_idx').on(t.state, t.requestedAt),
  agentRequestedIdx: index('floor_arena_withdrawals_agent_requested_idx').on(t.agentId, t.requestedAt.desc()),
  dispatchedIdx: index('floor_arena_withdrawals_dispatched_idx').on(t.dispatchedAt).where(sql`${t.dispatchedAt} IS NOT NULL`),
}));

export type FloorDiscoveryMintRow = typeof floorDiscoveryMints.$inferSelect;
export type FloorArenaAgentRow = typeof floorArenaAgents.$inferSelect;
export type FloorArenaPositionRow = typeof floorArenaPositions.$inferSelect;
export type FloorArenaEventRow = typeof floorArenaEvents.$inferSelect;
export type FloorArenaReportRow = typeof floorArenaReports.$inferSelect;
export type FloorArenaParamChangeRow = typeof floorArenaParamChanges.$inferSelect;
export type FloorArenaPrivateMintRow = typeof floorArenaPrivateMints.$inferSelect;
export type FloorArenaAddonCallRow = typeof floorArenaAddonCalls.$inferSelect;
export type FloorArenaWithdrawAddressRow = typeof floorArenaWithdrawAddresses.$inferSelect;
export type FloorArenaWithdrawChallengeRow = typeof floorArenaWithdrawChallenges.$inferSelect;
export type FloorArenaWithdrawalRow = typeof floorArenaWithdrawals.$inferSelect;
