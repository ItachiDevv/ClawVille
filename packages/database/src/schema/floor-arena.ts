/**
 * Trading Floor Arena (paper contest) tables. Contract:
 * `docs/trading-floor-arena.md` §4. Migration: `0070_floor_arena.sql`
 * (idempotent, applied by the CI migrate gate, NEVER db:push).
 *
 * PAPER ONLY. No table here holds money, a ClawToken balance or a wallet
 * secret; `numeric` P&L columns are paper USD. The live Floor board keeps
 * reading `verified_trades` and never these tables.
 *
 * The value sets in the CHECK constraints are the `FLOOR_ARENA_*` arrays in
 * `@clawville/shared` (constants/floor-arena.ts). drizzle-kit 0.24 does not
 * emit CHECKs, so the migration adds them in guarded DO blocks; the `check()`
 * entries here document them and keep the two in one place per table.
 */
import { sql } from 'drizzle-orm';
import {
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
  typeValid: check('floor_arena_events_type_valid', sql`${t.type} IN ('scan','pass','skip','entry','exit','param_change','report','status','addon')`),
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

export type FloorDiscoveryMintRow = typeof floorDiscoveryMints.$inferSelect;
export type FloorArenaAgentRow = typeof floorArenaAgents.$inferSelect;
export type FloorArenaPositionRow = typeof floorArenaPositions.$inferSelect;
export type FloorArenaEventRow = typeof floorArenaEvents.$inferSelect;
export type FloorArenaReportRow = typeof floorArenaReports.$inferSelect;
export type FloorArenaParamChangeRow = typeof floorArenaParamChanges.$inferSelect;
export type FloorArenaPrivateMintRow = typeof floorArenaPrivateMints.$inferSelect;
export type FloorArenaAddonCallRow = typeof floorArenaAddonCalls.$inferSelect;
