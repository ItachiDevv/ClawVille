import { sql, type SQL } from 'drizzle-orm';
import { db } from '@clawville/database';
import {
  FLOOR_ARENA_ADDONS,
  FLOOR_ARENA_EVENT_SUMMARY_MAX,
  FLOOR_ARENA_HARD_RULES,
  FLOOR_ARENA_WITHDRAW_COUNTED_STATES,
  FLOOR_ARENA_WITHDRAW_LIMITS,
  FLOOR_ARENA_WITHDRAW_OPEN_STATES,
  buildFloorArenaWithdrawAddressMessage,
  type FLOOR_ARENA_WITHDRAW_REFUSAL_CODES,
  type FLOOR_ARENA_WITHDRAW_REQUEST_CODES,
  type FloorArenaAgentAddon,
  type FloorArenaAgentKind,
  type FloorArenaAgentStatus,
  type FloorArenaEventType,
  type FloorArenaParamChangeSource,
  type FloorArenaParams,
  type FloorArenaProvisionState,
  type FloorArenaSuggestion,
  type FloorArenaSuggestionState,
  type FloorArenaWithdrawAddressProof,
  type FloorArenaWithdrawAmountMode,
  type FloorArenaWithdrawAsset,
  type FloorArenaWithdrawRevokeReason,
  type FloorArenaWithdrawState,
  type FloorArenaWithdrawSubjectKind,
} from '@clawville/shared';
// Type only: clawpump-writer imports this module at run time (isArenaClawPumpOwnedBy).
import type { ClawPumpArenaWalletLive } from '../clawpump-writer';
import { readArenaAggregates, toCents, type ArenaAgentAggregate, type ArenaLeaderboardWindow } from './leaderboard';

/**
 * Trading Floor Arena data access (docs/trading-floor-arena.md §4, §5).
 *
 * Raw SQL on the §4 contract table and column names. Every timestamp goes in
 * as an ISO string with an explicit `::timestamptz` cast and every jsonb as a
 * JSON string with `::jsonb` (repo rule for raw sql params).
 *
 * PUBLIC shapes (`ArenaPublicAgent`, positions, events, reports, discovery)
 * never carry `owner_user_id` or `avatar_id`. The ClawPump WALLET address is
 * public on purpose: it is the address a player pays to fund add-ons.
 */

export type ArenaAgentKind = FloorArenaAgentKind;
export type ArenaAgentStatus = FloorArenaAgentStatus;
export type ArenaProvisionState = FloorArenaProvisionState;
export type ArenaEventType = FloorArenaEventType;
export type ArenaParamChangeSource = FloorArenaParamChangeSource;
export type ArenaSuggestionState = FloorArenaSuggestionState;
export type ArenaAgentAddon = FloorArenaAgentAddon;
export type ArenaSuggestion = FloorArenaSuggestion;

/** Full row. INTERNAL: carries owner and avatar ids; never serialise it as is. */
export interface ArenaAgentRecord {
  id: string;
  kind: ArenaAgentKind;
  ownerUserId: string | null;
  avatarId: string | null;
  name: string;
  templateId: string;
  params: FloorArenaParams;
  paramsVersion: number;
  mode: 'paper' | 'live';
  status: ArenaAgentStatus;
  seated: boolean;
  seatIndex: number | null;
  seatedAt: Date | null;
  clawpumpAgentId: string | null;
  clawpumpWallet: string | null;
  provisionState: ArenaProvisionState;
  provisionError: string | null;
  provisionAttempts: number;
  provisionNextAt: Date | null;
  addons: ArenaAgentAddon[];
  autoApplySuggestions: boolean;
  contestId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ArenaAgentStats {
  realisedUsd: number;
  trades: number;
  wins: number;
  /** Closed with pnl_usd < 0; a flat close counts in neither wins nor losses. */
  losses: number;
  deaths: number;
  openPositions: number;
  lastTradeAt: string | null;
}

export interface ArenaPublicAgent {
  id: string;
  kind: ArenaAgentKind;
  name: string;
  templateId: string;
  params: FloorArenaParams;
  paramsVersion: number;
  mode: 'paper' | 'live';
  status: ArenaAgentStatus;
  seated: boolean;
  seatIndex: number | null;
  seatedAt: string | null;
  /** Public ClawPump wallet (the add-on payment address), or null until provisioned. */
  paymentAddress: string | null;
  provisionState: ArenaProvisionState;
  addons: ArenaAgentAddon[];
  autoApplySuggestions: boolean;
  contestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArenaPosition {
  id: string;
  mint: string;
  symbol: string | null;
  source: string | null;
  openedAt: string;
  sizeUsd: number;
  tokens: number;
  entryPriceUsd: number;
  entryFillSource: string | null;
  entryFeatures: unknown;
  paramsVersion: number;
  peakMult: number;
  lastMarkMult: number | null;
  lastMarkAt: string | null;
  remainingFraction: number;
  realisedUsd: number;
  status: 'open' | 'closed';
  closedAt: string | null;
  exitReason: string | null;
  exitFillSource: string | null;
  pnlUsd: number | null;
  pnlMult: number | null;
}

export interface ArenaEvent {
  id: number;
  at: string;
  type: ArenaEventType;
  mint: string | null;
  summary: string;
  data: unknown;
}

export interface ArenaReport {
  id: string;
  agentId: string;
  periodStart: string;
  periodEnd: string;
  stats: unknown;
  summary: string;
  suggestion: ArenaSuggestion | null;
  suggestionState: ArenaSuggestionState;
  createdAt: string;
}

export interface ArenaParamChange {
  id: number;
  at: string;
  source: ArenaParamChangeSource;
  changes: unknown;
  paramsVersion: number;
  reason: string | null;
}

export interface ArenaDiscoveryRow {
  mint: string;
  symbol: string | null;
  name: string | null;
  firstSeenAt: string;
  firstSource: string;
  sources: string[];
  lastSeenAt: string;
  snapshot: unknown;
  snapshotAt: string | null;
  chainVerdict: unknown;
  chainCheckedAt: string | null;
}

type Row = Record<string, unknown>;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** postgres-js returns an array; other drivers return `{ rows }`. Accept both. */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const inner = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(inner) ? (inner as T[]) : [];
}

async function rows<T extends Row = Row>(query: SQL, executor: typeof db | Tx = db): Promise<T[]> {
  const result = await executor.execute<T>(query);
  return rowsOf<T>(result);
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function date(value: unknown): Date | null {
  const text = iso(value);
  return text === null ? null : new Date(text);
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

export function parseAgentAddons(value: unknown): ArenaAgentAddon[] {
  const list = json(value);
  if (!Array.isArray(list)) return [];
  const out: ArenaAgentAddon[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, enabled, dailyCapUsd } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0) continue;
    out.push({ id, enabled: enabled === true, dailyCapUsd: numOrNull(dailyCapUsd) ?? 0 });
  }
  return out;
}

export function mapAgentRow(row: Row): ArenaAgentRecord {
  return {
    id: String(row.id),
    kind: row.kind === 'house' ? 'house' : 'user',
    ownerUserId: str(row.owner_user_id),
    avatarId: str(row.avatar_id),
    name: String(row.name ?? ''),
    templateId: String(row.template_id ?? ''),
    params: json(row.params) as FloorArenaParams,
    paramsVersion: num(row.params_version),
    mode: row.mode === 'live' ? 'live' : 'paper',
    status: (row.status === 'paused' || row.status === 'stopped') ? row.status : 'active',
    seated: row.seated === true,
    seatIndex: numOrNull(row.seat_index),
    seatedAt: date(row.seated_at),
    clawpumpAgentId: str(row.clawpump_agent_id),
    clawpumpWallet: str(row.clawpump_wallet),
    provisionState: (['none', 'pending', 'creating', 'ready', 'failed'] as const).find((s) => s === row.provision_state) ?? 'none',
    provisionError: str(row.provision_error),
    provisionAttempts: num(row.provision_attempts),
    provisionNextAt: date(row.provision_next_at),
    addons: parseAgentAddons(row.addons),
    autoApplySuggestions: row.auto_apply_suggestions === true,
    contestId: str(row.contest_id),
    createdAt: date(row.created_at) ?? new Date(0),
    updatedAt: date(row.updated_at) ?? new Date(0),
  };
}

/**
 * What anyone may see of ANOTHER player's arena agent (Codex r2 #1): strategy,
 * state and results only. No add-on settings, payment address, provisioning
 * state, auto-apply setting or reports: the owner reads those through /me.
 */
export interface ArenaPublicUserProfile {
  id: string;
  kind: 'user';
  name: string;
  templateId: string;
  params: FloorArenaParams;
  paramsVersion: number;
  mode: 'paper' | 'live';
  status: ArenaAgentStatus;
  seated: boolean;
  seatIndex: number | null;
  createdAt: string;
}

export function toPublicUserProfile(agent: ArenaAgentRecord): ArenaPublicUserProfile {
  return {
    id: agent.id,
    kind: 'user',
    name: agent.name,
    templateId: agent.templateId,
    params: agent.params,
    paramsVersion: agent.paramsVersion,
    mode: agent.mode,
    status: agent.status,
    seated: agent.seated,
    seatIndex: agent.seatIndex,
    createdAt: agent.createdAt.toISOString(),
  };
}

/** Event types anyone may read for a USER agent (Codex r2 #2). The owner reads every type via /me/events. */
export const ARENA_PUBLIC_USER_EVENT_TYPES: readonly ArenaEventType[] = ['entry', 'exit', 'param_change', 'status'];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * What names a player's add-on in free text: the engine's `private:<addon id>`
 * source (the id ends on a letter or digit, so "private:x." keeps its full
 * stop), any catalog add-on id, name or vendor. Case-insensitive; longest
 * alternatives first so a name wins over its vendor prefix.
 */
const ADDON_TERMS = [
  ...FLOOR_ARENA_ADDONS.flatMap((addon) => [addon.id, addon.name, addon.vendor]),
].filter((term) => term.trim().length >= 3).sort((a, b) => b.length - a.length);
const ADDON_IDS_PATTERN = new RegExp(
  ['private:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?', ...ADDON_TERMS.map(escapeRegExp)].join('|'),
  'gi',
);

/** Any add-on reference inside public free text becomes the generic 'addon'. */
export function redactArenaText(text: string): string {
  return text.replace(ADDON_IDS_PATTERN, 'addon');
}

/** An add-on source (`private:<addon id>` or a catalog id) becomes the generic 'addon'. */
export function redactArenaSource<T>(value: T): T | 'addon' {
  if (typeof value !== 'string') return value;
  ADDON_IDS_PATTERN.lastIndex = 0;
  return ADDON_IDS_PATTERN.test(value) ? 'addon' : value;
}

/** Every string inside `value` (nested objects and arrays, bounded depth) passes through redactArenaText. */
function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactArenaText(value);
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactDeep(item, depth + 1)]));
}

/**
 * A user agent's event as the public sees it: add-on references removed from
 * the summary and every string in `data`, `source` generic, no wallet or
 * add-on id fields. Lead decision (pre-freeze): a param_change's free-text
 * `reason` (player-typed or model-written) is DROPPED from public views; only
 * the source and the diff remain. An exit's `reason` ('tp', 'stop', ...) is a
 * fixed code, not free text, and stays.
 */
export function redactArenaEventForPublic(event: ArenaEvent): ArenaEvent {
  let data = event.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const copy = redactDeep(data) as Record<string, unknown>;
    if ('source' in copy) copy.source = redactArenaSource(copy.source);
    delete copy.paymentAddress;
    delete copy.addonId;
    if (event.type === 'param_change') delete copy.reason;
    data = copy;
  }
  return { ...event, summary: redactArenaText(event.summary), data };
}

/** A user agent's param change as the public sees it: source + diff only, no free-text reason. */
export function redactArenaParamChangeForPublic(change: ArenaParamChange): ArenaParamChange {
  return { ...change, reason: null, changes: redactDeep(change.changes) };
}

/** A user agent's position as the public sees it: no add-on source, no entry features. */
export function redactArenaPositionForPublic(position: ArenaPosition): ArenaPosition {
  return { ...position, source: redactArenaSource(position.source), entryFeatures: null };
}

/** The ONLY way an agent row leaves the API: owner and avatar ids are dropped here. */
export function toPublicAgent(agent: ArenaAgentRecord): ArenaPublicAgent {
  return {
    id: agent.id,
    kind: agent.kind,
    name: agent.name,
    templateId: agent.templateId,
    params: agent.params,
    paramsVersion: agent.paramsVersion,
    mode: agent.mode,
    status: agent.status,
    seated: agent.seated,
    seatIndex: agent.seatIndex,
    seatedAt: agent.seatedAt ? agent.seatedAt.toISOString() : null,
    paymentAddress: agent.provisionState === 'ready' ? agent.clawpumpWallet : null,
    provisionState: agent.provisionState,
    addons: agent.addons,
    autoApplySuggestions: agent.autoApplySuggestions,
    contestId: agent.contestId,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

export function toStats(aggregate: ArenaAgentAggregate | undefined): ArenaAgentStats {
  return {
    realisedUsd: aggregate ? toCents(aggregate.realisedUsd) / 100 : 0,
    trades: aggregate?.trades ?? 0,
    wins: aggregate?.wins ?? 0,
    losses: aggregate?.losses ?? 0,
    deaths: aggregate?.deaths ?? 0,
    openPositions: aggregate?.openPositions ?? 0,
    lastTradeAt: aggregate?.lastTradeAt ? aggregate.lastTradeAt.toISOString() : null,
  };
}

function mapPosition(row: Row): ArenaPosition {
  return {
    id: String(row.id),
    mint: String(row.mint),
    symbol: sanitizeArenaSymbol(row.symbol),
    source: str(row.source),
    openedAt: iso(row.opened_at) ?? new Date(0).toISOString(),
    sizeUsd: num(row.size_usd),
    tokens: num(row.tokens),
    entryPriceUsd: num(row.entry_price_usd),
    entryFillSource: str(row.entry_fill_source),
    entryFeatures: json(row.entry_features),
    paramsVersion: num(row.params_version),
    peakMult: num(row.peak_mult),
    lastMarkMult: numOrNull(row.last_mark_mult),
    lastMarkAt: iso(row.last_mark_at),
    remainingFraction: num(row.remaining_fraction),
    realisedUsd: num(row.realised_usd),
    status: row.status === 'closed' ? 'closed' : 'open',
    closedAt: iso(row.closed_at),
    exitReason: str(row.exit_reason),
    exitFillSource: str(row.exit_fill_source),
    pnlUsd: numOrNull(row.pnl_usd),
    pnlMult: numOrNull(row.pnl_mult),
  };
}

function mapEvent(row: Row): ArenaEvent {
  return {
    id: num(row.id),
    at: iso(row.at) ?? new Date(0).toISOString(),
    type: String(row.type) as ArenaEventType,
    mint: str(row.mint),
    summary: String(row.summary ?? ''),
    data: json(row.data),
  };
}

function parseSuggestion(value: unknown): ArenaSuggestion | null {
  const parsed = json(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { path, from, to, reason } = parsed as Record<string, unknown>;
  if (typeof path !== 'string' || path.length === 0) return null;
  return { path, from, to, reason: typeof reason === 'string' ? reason : '' };
}

export function mapReport(row: Row): ArenaReport {
  const states: readonly ArenaSuggestionState[] = ['none', 'pending', 'applied', 'dismissed', 'auto_applied', 'rejected'];
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    periodStart: iso(row.period_start) ?? new Date(0).toISOString(),
    periodEnd: iso(row.period_end) ?? new Date(0).toISOString(),
    stats: json(row.stats),
    summary: String(row.summary ?? ''),
    suggestion: parseSuggestion(row.suggestion),
    suggestionState: states.find((s) => s === row.suggestion_state) ?? 'none',
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function mapParamChange(row: Row): ArenaParamChange {
  return {
    id: num(row.id),
    at: iso(row.at) ?? new Date(0).toISOString(),
    source: String(row.source) as ArenaParamChangeSource,
    changes: json(row.changes),
    paramsVersion: num(row.params_version),
    reason: str(row.reason),
  };
}

function mapDiscovery(row: Row): ArenaDiscoveryRow {
  const sources = json(row.sources);
  return {
    mint: String(row.mint),
    symbol: sanitizeArenaSymbol(row.symbol),
    name: sanitizeArenaTokenName(row.name),
    firstSeenAt: iso(row.first_seen_at) ?? new Date(0).toISOString(),
    firstSource: sanitizeSourceTag(row.first_source) ?? 'unknown',
    sources: Array.isArray(sources) ? sources.map(sanitizeSourceTag).filter((s): s is string => s !== null) : [],
    lastSeenAt: iso(row.last_seen_at) ?? new Date(0).toISOString(),
    snapshot: publicSnapshot(json(row.snapshot)),
    snapshotAt: iso(row.snapshot_at),
    chainVerdict: publicChainVerdict(json(row.chain_verdict)),
    chainCheckedAt: iso(row.chain_checked_at),
  };
}

/** Discovery source tags are ours (`dexscreener`, `clawpump`, ...); anything else is dropped. */
function sanitizeSourceTag(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9:_-]{1,40}$/.test(value) ? value : null;
}

/** Token names are vendor text: letters, digits, spaces and `$ . _ - ' &` only, at most 32 chars. */
export function sanitizeArenaTokenName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.normalize('NFKC').replace(/[^\p{L}\p{N} $._'&-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 32).trim();
  return clean.length > 0 ? clean : null;
}

const SNAPSHOT_NUMBER_KEYS = [
  'priceUsd', 'mcap', 'liqUsd', 'pairCreatedAt', 'ageS', 'chg5m', 'chg1h', 'chg6h', 'chg24h', 'txns1h', 'vol1h', 'volOverMcap',
] as const;

/** Public snapshot: the approved DexScreener numbers plus a base58 pair address and a plain dex id. No vendor text. */
export function publicSnapshot(value: unknown): Record<string, number | string | null> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const out: Record<string, number | string | null> = {};
  for (const key of SNAPSHOT_NUMBER_KEYS) out[key] = numOrNull(record[key]);
  const pair = record.pairAddress;
  out.pairAddress = typeof pair === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pair) ? pair : null;
  const dex = record.dexId;
  out.dexId = typeof dex === 'string' && /^[a-z0-9_-]{1,32}$/.test(dex) ? dex : null;
  return out;
}

const HARD_RULE_IDS: ReadonlySet<string> = new Set(FLOOR_ARENA_HARD_RULES.map((rule) => rule.id));

/** Public chain verdict: {pass, fails (known hard-rule ids only), checkedAt}; never `error` or internal fields (Codex r2 #8). */
export function publicChainVerdict(value: unknown): { pass: boolean; fails: string[]; checkedAt: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.pass !== 'boolean') return null;
  const fails = Array.isArray(record.fails)
    ? record.fails.filter((fail): fail is string => typeof fail === 'string' && HARD_RULE_IDS.has(fail))
    : [];
  return { pass: record.pass, fails, checkedAt: iso(record.checkedAt) };
}

/** Event summaries are <= 280 chars (contract §4). */
export function clampSummary(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= FLOOR_ARENA_EVENT_SUMMARY_MAX ? clean : `${clean.slice(0, FLOOR_ARENA_EVENT_SUMMARY_MAX - 1)}…`;
}

// ─── Agents ────────────────────────────────────────────────────────────────

export async function readArenaAgent(agentId: string): Promise<ArenaAgentRecord | null> {
  const list = await rows(sql`SELECT * FROM floor_arena_agents WHERE id = ${agentId} LIMIT 1`);
  return list[0] ? mapAgentRow(list[0]) : null;
}

export async function readArenaAgentByOwner(userId: string): Promise<ArenaAgentRecord | null> {
  const list = await rows(sql`
    SELECT * FROM floor_arena_agents WHERE owner_user_id = ${userId} AND kind = 'user' LIMIT 1
  `);
  return list[0] ? mapAgentRow(list[0]) : null;
}

export async function readArenaHouseAgents(): Promise<ArenaAgentRecord[]> {
  const list = await rows(sql`SELECT * FROM floor_arena_agents WHERE kind = 'house' ORDER BY id ASC`);
  return list.map(mapAgentRow);
}

export interface InsertUserAgentInput {
  id: string;
  ownerUserId: string;
  avatarId: string;
  name: string;
  templateId: string;
  params: FloorArenaParams;
  addons: ArenaAgentAddon[];
  contestId: string | null;
}

/** Inserts the account's one user agent. Returns null when the account already has one. */
export async function insertUserArenaAgent(input: InsertUserAgentInput): Promise<ArenaAgentRecord | null> {
  return db.transaction(async (tx) => {
    // ON CONFLICT DO NOTHING with no target covers the partial unique index on
    // owner_user_id (kind = 'user'), which is the cross-process backstop to the
    // route's in-process keyed mutex.
    const inserted = await rows(sql`
      INSERT INTO floor_arena_agents (
        id, kind, owner_user_id, avatar_id, name, template_id, params, params_version,
        mode, status, seated, provision_state, addons, auto_apply_suggestions, contest_id,
        created_at, updated_at
      ) VALUES (
        ${input.id}, 'user', ${input.ownerUserId}::uuid, ${input.avatarId}::uuid, ${input.name},
        ${input.templateId}, ${JSON.stringify(input.params)}::jsonb, 1,
        'paper', 'active', false, 'pending', ${JSON.stringify(input.addons)}::jsonb, false, ${input.contestId},
        now(), now()
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `, tx);
    if (!inserted[0]) return null;
    await tx.execute(sql`
      INSERT INTO floor_arena_param_changes (agent_id, at, source, changes, params_version, reason)
      VALUES (${input.id}, now(), 'user', '[]'::jsonb, 1, ${`Launched from template ${input.templateId}`})
    `);
    await tx.execute(sql`
      INSERT INTO floor_arena_events (agent_id, at, type, summary, data)
      VALUES (${input.id}, now(), 'status',
        ${clampSummary(`${input.name} launched from the ${input.templateId} template in paper mode`)},
        ${JSON.stringify({ templateId: input.templateId, mode: 'paper' })}::jsonb)
    `);
    return mapAgentRow(inserted[0]);
  });
}

export interface ParamUpdateInput {
  agentId: string;
  expectedVersion: number;
  params: FloorArenaParams;
  changes: Array<{ path: string; from: unknown; to: unknown }>;
  source: ArenaParamChangeSource;
  reason: string | null;
  summary: string;
  /** When set, the report's suggestion moves to this state in the same transaction. */
  report?: { id: string; state: 'applied' | 'auto_applied' };
}

export type ParamUpdateResult =
  | { ok: true; paramsVersion: number }
  | { ok: false; reason: 'version_conflict' | 'report_not_pending' };

class ParamUpdateAbort extends Error {
  constructor(readonly reason: 'version_conflict' | 'report_not_pending') {
    super(reason);
  }
}

/**
 * Optimistic params write: bumps params_version only if nobody changed it
 * since `expectedVersion`, and writes the change row and the event in the same
 * transaction. With `report`, the suggestion must still be PENDING, and it
 * moves to its new state in the same transaction (or nothing is written).
 */
export async function updateArenaAgentParams(input: ParamUpdateInput): Promise<ParamUpdateResult> {
  try {
    const paramsVersion = await db.transaction((tx) => writeParamsLocked(tx, input));
    return { ok: true, paramsVersion };
  } catch (error) {
    if (error instanceof ParamUpdateAbort) return { ok: false, reason: error.reason };
    throw error;
  }
}

async function writeParamsLocked(tx: Tx, input: ParamUpdateInput): Promise<number> {
  if (input.report) {
    const claimed = await rows(sql`
      UPDATE floor_arena_reports SET suggestion_state = ${input.report.state}
      WHERE id = ${input.report.id}::uuid AND agent_id = ${input.agentId} AND suggestion_state = 'pending'
      RETURNING id
    `, tx);
    if (!claimed[0]) throw new ParamUpdateAbort('report_not_pending');
  }
  const updated = await rows(sql`
    UPDATE floor_arena_agents
    SET params = ${JSON.stringify(input.params)}::jsonb,
        params_version = params_version + 1,
        updated_at = now()
    WHERE id = ${input.agentId} AND params_version = ${input.expectedVersion}
    RETURNING params_version
  `, tx);
  if (!updated[0]) throw new ParamUpdateAbort('version_conflict');
  const version = num(updated[0].params_version);
  await tx.execute(sql`
    INSERT INTO floor_arena_param_changes (agent_id, at, source, changes, params_version, reason)
    VALUES (${input.agentId}, now(), ${input.source}, ${JSON.stringify(input.changes)}::jsonb, ${version}, ${input.reason})
  `);
  await tx.execute(sql`
    INSERT INTO floor_arena_events (agent_id, at, type, summary, data)
    VALUES (${input.agentId}, now(), 'param_change', ${clampSummary(input.summary)},
      ${JSON.stringify({ source: input.source, paramsVersion: version, changes: input.changes, reason: input.reason })}::jsonb)
  `);
  return version;
}

/** One column update plus one event, atomically. `set` is a fixed SQL fragment built by the callers below. */
/**
 * The per-agent lock that serialises add-on payment with the owner's state
 * changes (Codex r17 #2). Reservation, pre-dispatch confirmation and every
 * seat/status/add-on write take it FIRST, then touch the agent row, so the lock
 * order is the same everywhere (no deadlock).
 */
function addonLock(agentId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`floor-arena-addon:${agentId}`}, 0))`;
}

async function updateAgentWithEvent(
  agentId: string,
  set: SQL,
  event: { type: ArenaEventType; summary: string; data: unknown },
): Promise<ArenaAgentRecord | null> {
  return db.transaction(async (tx) => {
    // Lock BEFORE the update (same order as the payment path): a stand-up,
    // pause or add-on change waits for an in-flight confirmation and vice versa.
    await tx.execute(addonLock(agentId));
    const updated = await rows(sql`
      UPDATE floor_arena_agents SET ${set}, updated_at = now() WHERE id = ${agentId} RETURNING *
    `, tx);
    if (!updated[0]) return null;
    await tx.execute(sql`
      INSERT INTO floor_arena_events (agent_id, at, type, summary, data)
      VALUES (${agentId}, now(), ${event.type}, ${clampSummary(event.summary)}, ${JSON.stringify(event.data ?? null)}::jsonb)
    `);
    return mapAgentRow(updated[0]);
  });
}

export function setArenaAgentSeat(agentId: string, seated: boolean, seatIndex: number | null, summary: string) {
  const set = seated
    ? sql`seated = true, seat_index = ${seatIndex}, seated_at = now()`
    : sql`seated = false, seat_index = NULL, seated_at = NULL`;
  return updateAgentWithEvent(agentId, set, { type: 'status', summary, data: { seated, seatIndex } });
}

export function setArenaAgentStatus(agentId: string, status: 'active' | 'paused', summary: string) {
  return updateAgentWithEvent(agentId, sql`status = ${status}`, { type: 'status', summary, data: { status } });
}

export function setArenaAgentAddons(agentId: string, addons: ArenaAgentAddon[], summary: string) {
  return updateAgentWithEvent(agentId, sql`addons = ${JSON.stringify(addons)}::jsonb`, {
    type: 'addon', summary, data: { addons },
  });
}

export function setArenaAgentAutoApply(agentId: string, autoApply: boolean, summary: string) {
  return updateAgentWithEvent(agentId, sql`auto_apply_suggestions = ${autoApply}`, {
    // A report setting, so a 'report' event: private for a user agent (owner sees it via /me/events).
    type: 'report', summary, data: { autoApplySuggestions: autoApply },
  });
}

export async function insertArenaEvent(
  agentId: string,
  event: { type: ArenaEventType; summary: string; data?: unknown; mint?: string | null },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO floor_arena_events (agent_id, at, type, mint, summary, data)
    VALUES (${agentId}, now(), ${event.type}, ${event.mint ?? null}, ${clampSummary(event.summary)},
      ${JSON.stringify(event.data ?? null)}::jsonb)
  `);
}

export async function readAvatarName(avatarId: string): Promise<string | null> {
  const list = await rows(sql`SELECT name FROM avatars WHERE id = ${avatarId}::uuid LIMIT 1`);
  return list[0] ? str(list[0].name) : null;
}

// ─── Reports ───────────────────────────────────────────────────────────────

export async function readArenaReport(reportId: string): Promise<ArenaReport | null> {
  const list = await rows(sql`SELECT * FROM floor_arena_reports WHERE id = ${reportId}::uuid LIMIT 1`);
  return list[0] ? mapReport(list[0]) : null;
}

export async function readLatestArenaReport(agentId: string): Promise<ArenaReport | null> {
  const list = await rows(sql`
    SELECT * FROM floor_arena_reports WHERE agent_id = ${agentId} ORDER BY created_at DESC LIMIT 1
  `);
  return list[0] ? mapReport(list[0]) : null;
}

/** Moves a PENDING suggestion to `state`. Returns false when it was no longer pending. */
export async function setArenaReportSuggestionState(
  reportId: string,
  agentId: string,
  state: 'dismissed' | 'rejected' | 'applied',
): Promise<boolean> {
  const updated = await rows(sql`
    UPDATE floor_arena_reports SET suggestion_state = ${state}
    WHERE id = ${reportId}::uuid AND agent_id = ${agentId} AND suggestion_state = 'pending'
    RETURNING id
  `);
  return updated.length > 0;
}

// ─── Public reads ──────────────────────────────────────────────────────────

export async function readArenaPositions(agentId: string, status: 'open' | 'closed', limit: number): Promise<ArenaPosition[]> {
  const order = status === 'open' ? sql`opened_at DESC` : sql`closed_at DESC NULLS LAST`;
  const list = await rows(sql`
    SELECT * FROM floor_arena_positions WHERE agent_id = ${agentId} AND status = ${status}
    ORDER BY ${order} LIMIT ${limit}
  `);
  return list.map(mapPosition);
}

export async function readArenaParamChanges(agentId: string, limit: number): Promise<ArenaParamChange[]> {
  const list = await rows(sql`
    SELECT * FROM floor_arena_param_changes WHERE agent_id = ${agentId} ORDER BY id DESC LIMIT ${limit}
  `);
  return list.map(mapParamChange);
}

/**
 * Decision stream, oldest first. With `after`, the events newer than that id;
 * without it, the latest `limit` events.
 */
export async function readArenaEvents(
  agentId: string,
  after: number | null,
  limit: number,
  types: readonly ArenaEventType[] | null = null,
): Promise<ArenaEvent[]> {
  const typeFilter = types === null
    ? sql``
    : sql`AND type IN (${sql.join(types.map((type) => sql`${type}`), sql`, `)})`;
  if (after !== null) {
    const list = await rows(sql`
      SELECT * FROM floor_arena_events WHERE agent_id = ${agentId} AND id > ${after} ${typeFilter}
      ORDER BY id ASC LIMIT ${limit}
    `);
    return list.map(mapEvent);
  }
  const list = await rows(sql`
    SELECT * FROM floor_arena_events WHERE agent_id = ${agentId} ${typeFilter} ORDER BY id DESC LIMIT ${limit}
  `);
  return list.map(mapEvent).reverse();
}

export async function readArenaDiscovery(limit: number, now: Date): Promise<ArenaDiscoveryRow[]> {
  const list = await rows(sql`
    SELECT mint, symbol, name, first_seen_at, first_source, sources, last_seen_at, snapshot, snapshot_at,
      chain_verdict, chain_checked_at
    FROM floor_discovery_mints
    WHERE expires_at > ${now.toISOString()}::timestamptz
    ORDER BY first_seen_at DESC
    LIMIT ${limit}
  `);
  return list.map(mapDiscovery);
}

export async function readArenaAgentStats(
  agentIds: readonly string[],
  now: Date,
): Promise<Map<string, Record<'all' | 'last24h' | 'contest', ArenaAgentStats>>> {
  const windows: Array<[ArenaLeaderboardWindow, 'all' | 'last24h' | 'contest']> = [
    ['all', 'all'], ['24h', 'last24h'], ['contest', 'contest'],
  ];
  const results = await Promise.all(windows.map(([window]) => readArenaAggregates(window, now, agentIds)));
  const out = new Map<string, Record<'all' | 'last24h' | 'contest', ArenaAgentStats>>();
  for (const id of agentIds) {
    const entry = {} as Record<'all' | 'last24h' | 'contest', ArenaAgentStats>;
    windows.forEach(([, key], index) => {
      entry[key] = toStats(results[index]!.find((row) => row.agentId === id));
    });
    out.set(id, entry);
  }
  return out;
}

// ─── Add-on ledger ─────────────────────────────────────────────────────────

export interface ArenaAddonCallStat {
  addonId: string;
  /** Sum of price_usd booked in the UTC day that starts at `dayStart`. */
  spentTodayUsd: number;
  /** Last attempt at any time, ok or not (the min-interval clock). */
  lastAt: Date | null;
  lastOk: boolean | null;
  lastError: string | null;
  /**
   * Every attempt ever booked for this agent and add-on whose pay request MAY have left this process (drives the
   * dedupe rotation). Rows in ARENA_ADDON_NOT_SENT_ERRORS are left out (O1, 2026-10-01).
   */
  callsTotal: number;
}

/**
 * O1 (X402_PAID_TEST_2026-10-01): ledger errors of add-on rows whose x402 pay POST never left this process, so
 * ClawPump never saw that body. They must not advance the dedupe rotation, or the next SENT call repeats the last
 * sent body (2 values) inside ClawPump's 3-12 min replay window. 'released_before_pay' = confirmArenaAddonDispatch;
 * the rest = `ClawPumpWriterError(code).message` for codes x402PayViaClawPump / sendJson throw before the POST's
 * fetch (pinned by floor-arena-addons.test.ts). An HTTP status or vendor code (sent or maybe sent) never matches.
 * Money fields (spent_today, last_*) do NOT use this list.
 */
export const ARENA_ADDON_NOT_SENT_ERRORS: readonly string[] = Object.freeze([
  'released_before_pay',
  'clawpump_budget_exhausted',
  'clawpump_not_configured',
  'clawpump_invalid_base_url',
  'clawpump_invalid_agent_id',
  'clawpump_invalid_input',
  'clawpump_host_not_allowed',
  'clawpump_not_arena_agent',
  'clawpump_agent_running',
  'clawpump_agent_not_stopped',
  'clawpump_x402_not_enabled',
]);

export async function readArenaAddonStats(
  agentId: string,
  dayStart: Date,
  executor: typeof db | Tx = db,
): Promise<ArenaAddonCallStat[]> {
  // 'reserved' rows count at their catalog price (a reservation is spend until finalised).
  const list = await rows(sql`
    WITH agg AS (
      SELECT addon_id,
        COALESCE(SUM(price_usd) FILTER (WHERE at >= ${dayStart.toISOString()}::timestamptz), 0) AS spent_today,
        COUNT(*) FILTER (WHERE error IS NULL OR error NOT IN (
          SELECT jsonb_array_elements_text(${JSON.stringify(ARENA_ADDON_NOT_SENT_ERRORS)}::jsonb)
        )) AS calls_total
      FROM floor_arena_addon_calls
      WHERE agent_id = ${agentId}
      GROUP BY addon_id
    ), last AS (
      SELECT DISTINCT ON (addon_id) addon_id, at, ok, error
      FROM floor_arena_addon_calls
      WHERE agent_id = ${agentId}
      ORDER BY addon_id, at DESC, id DESC
    )
    SELECT agg.addon_id, agg.spent_today, agg.calls_total,
      last.at AS last_at, last.ok AS last_ok, last.error AS last_error
    FROM agg JOIN last USING (addon_id)
  `, executor);
  return list.map((row) => ({
    addonId: String(row.addon_id),
    spentTodayUsd: num(row.spent_today),
    callsTotal: num(row.calls_total),
    lastAt: date(row.last_at),
    lastOk: typeof row.last_ok === 'boolean' ? row.last_ok : null,
    lastError: str(row.last_error),
  }));
}

export type ArenaAddonReserveCheck =
  | { ok: true }
  | {
    ok: false;
    /** 'underfunded' and 'withdraw_pending' come only from the locked reservation (P5 D34-i), never from the pure check. */
    reason: 'interval' | 'addon_cap' | 'agent_cap' | 'agent_changed' | 'underfunded' | 'withdraw_pending';
    spentUsd: number;
    capUsd: number;
  };

export type ArenaAddonReservation =
  | { reserved: true; id: number; callNumber: number }
  | { reserved: false; check: Exclude<ArenaAddonReserveCheck, { ok: true }> };

/**
 * Codex r2 #3: reserve an add-on payment BEFORE paying. One transaction takes
 * the per-agent advisory lock, re-reads today's ledger (reservations included),
 * runs `check`, and only then inserts a 'reserved' row priced at the catalog
 * price. Two containers therefore serialise on the lock and the second sees
 * the first reservation. `callNumber` = this add-on's SENT-call count before
 * this row (`callsTotal`: every booked call whose pay request may have left
 * this process; rows in ARENA_ADDON_NOT_SENT_ERRORS are not counted, O1), the
 * dedupe rotation index.
 *
 * Codex r3 #10: the same transaction re-reads the AGENT row `FOR SHARE` (a
 * concurrent PATCH /me/addons waits for this commit) and aborts with
 * 'agent_changed' unless the agent is still active, SEATED, provisioned, on
 * the same ClawPump agent, and the add-on is still enabled. `check` receives
 * the CURRENT daily cap, not the one the tick read earlier.
 *
 * P5 D34-i (I5, conservation with withdrawals): under the SAME lock as the
 * withdraw admission, the open withdrawal holds (readArenaOpenWithdrawHold) and
 * this agent's open 'reserved' rows are subtracted from `walletUsdc` (the value
 * the tick read). An open USDC 'max' row whose amount is not fixed yet refuses
 * 'withdraw_pending'; too little left refuses 'underfunded'. A non-finite
 * `walletUsdc` counts as underfunded (fail closed).
 */
export async function reserveArenaAddonCall(input: {
  agentId: string;
  addonId: string;
  clawpumpAgentId: string;
  at: Date;
  priceUsd: number;
  dayStart: Date;
  /** The wallet USDC (UI units) the tick read before this reservation (P5 D34-i). */
  walletUsdc: number;
  check: (stats: ArenaAddonCallStat[], currentCapUsd: number) => ArenaAddonReserveCheck;
}): Promise<ArenaAddonReservation> {
  return db.transaction(async (tx) => {
    await tx.execute(addonLock(input.agentId));
    const current = (await rows(sql`
      SELECT status, seated, provision_state, clawpump_agent_id, addons FROM floor_arena_agents
      WHERE id = ${input.agentId} AND kind = 'user'
      FOR SHARE
    `, tx))[0];
    const addon = current ? parseAgentAddons(current.addons).find((entry) => entry.id === input.addonId) : undefined;
    // Money audit M1: standing up (seated false) stops paid calls like pausing does.
    if (!current || current.status !== 'active' || current.seated !== true || current.provision_state !== 'ready'
      || current.clawpump_agent_id !== input.clawpumpAgentId || !addon?.enabled) {
      return { reserved: false, check: { ok: false, reason: 'agent_changed', spentUsd: 0, capUsd: 0 } };
    }
    const hold = await readArenaOpenWithdrawHold(input.agentId, tx);
    if (hold.usdcMaxPending) {
      return { reserved: false, check: { ok: false, reason: 'withdraw_pending', spentUsd: 0, capUsd: 0 } };
    }
    const open = (await rows(sql`
      SELECT COALESCE(SUM(price_usd), 0) AS reserved_usd FROM floor_arena_addon_calls
      WHERE agent_id = ${input.agentId} AND state = 'reserved'
    `, tx))[0];
    const left = input.walletUsdc - Number(hold.usdcAtomic) / 1e6 - num(open?.reserved_usd);
    if (!Number.isFinite(left) || left + 1e-9 < input.priceUsd) {
      return { reserved: false, check: { ok: false, reason: 'underfunded', spentUsd: 0, capUsd: 0 } };
    }
    const stats = await readArenaAddonStats(input.agentId, input.dayStart, tx);
    const verdict = input.check(stats, addon.dailyCapUsd);
    if (!verdict.ok) return { reserved: false, check: verdict };
    const inserted = await rows(sql`
      INSERT INTO floor_arena_addon_calls (agent_id, addon_id, at, price_usd, ok, error, mints, response_ref, state)
      VALUES (${input.agentId}, ${input.addonId}, ${input.at.toISOString()}::timestamptz, ${input.priceUsd},
        false, NULL, 0, NULL, 'reserved')
      RETURNING id
    `, tx);
    const callNumber = stats.find((row) => row.addonId === input.addonId)?.callsTotal ?? 0;
    return { reserved: true, id: num(inserted[0]!.id), callNumber };
  });
}

/**
 * Codex r17 #1/#2: the LAST check before the x402 pay is dispatched. A short
 * transaction takes the same per-agent lock as the owner's seat/status/add-on
 * writes, re-reads the agent row (active, seated, provisioned, same ClawPump
 * agent, add-on enabled) and the engine pause. If anything fails it RELEASES the
 * committed reservation (state done, price 0, error 'released_before_pay') in
 * the same transaction, so it costs nothing against the cap; nothing was paid.
 * A state change that commits after this transaction can no longer stop the
 * payment: that window is the network send itself and is accepted.
 */
export async function confirmArenaAddonDispatch(input: {
  reservationId: number;
  agentId: string;
  addonId: string;
  clawpumpAgentId: string;
  paused: () => boolean;
}): Promise<{ ok: true } | { ok: false; reason: 'paused' | 'agent_changed' }> {
  return db.transaction(async (tx) => {
    await tx.execute(addonLock(input.agentId));
    const current = (await rows(sql`
      SELECT status, seated, provision_state, clawpump_agent_id, addons FROM floor_arena_agents
      WHERE id = ${input.agentId} AND kind = 'user'
      FOR SHARE
    `, tx))[0];
    const addon = current ? parseAgentAddons(current.addons).find((entry) => entry.id === input.addonId) : undefined;
    const reason = input.paused()
      ? 'paused'
      : (!current || current.status !== 'active' || current.seated !== true || current.provision_state !== 'ready'
        || current.clawpump_agent_id !== input.clawpumpAgentId || !addon?.enabled)
        ? 'agent_changed'
        : null;
    if (reason === null) return { ok: true };
    await tx.execute(sql`
      UPDATE floor_arena_addon_calls
      SET state = 'done', price_usd = 0, ok = false, error = 'released_before_pay', mints = 0
      WHERE id = ${input.reservationId} AND state = 'reserved'
    `);
    return { ok: false, reason };
  });
}

/** Codex r17 #5: has this agent already booked the provider charge `ref` (a settlement tx)? */
export async function arenaAddonChargeRefSeen(agentId: string, ref: string): Promise<boolean> {
  const list = await rows(sql`
    SELECT 1 FROM floor_arena_addon_calls
    WHERE agent_id = ${agentId} AND response_ref = ${ref} AND state = 'done' AND price_usd > 0
    LIMIT 1
  `);
  return list.length > 0;
}

/**
 * Codex r17 #4: row-specific ownership proof for the ClawPump writer. True
 * only when `clawpumpAgentId` is the ClawPump agent of the USER arena row
 * `arenaAgentId`. Read fresh every time (no cache), so a re-pointed or deleted
 * row stops the writer at once.
 */
export async function isArenaClawPumpOwnedBy(clawpumpAgentId: string, arenaAgentId: string): Promise<boolean> {
  const list = await rows(sql`
    SELECT 1 FROM floor_arena_agents
    WHERE id = ${arenaAgentId} AND kind = 'user' AND clawpump_agent_id = ${clawpumpAgentId}
    LIMIT 1
  `);
  return list.length > 0;
}

/** Finalises a reservation with what was actually charged (0 for a duplicate or a refused call). */
export async function finalizeArenaAddonCall(
  id: number,
  result: { priceUsd: number; ok: boolean; error: string | null; mints: number; responseRef: string | null },
): Promise<void> {
  await db.execute(sql`
    UPDATE floor_arena_addon_calls
    SET state = 'done', price_usd = ${result.priceUsd}, ok = ${result.ok}, error = ${result.error},
        mints = ${result.mints}, response_ref = ${result.responseRef}
    WHERE id = ${id} AND state = 'reserved'
  `);
}

export interface ArenaAddonToken {
  mint: string;
  /** Already sanitised (`sanitizeArenaSymbol`), or null. */
  symbol: string | null;
}

/**
 * Upserts private mints for one agent. A new mint gets first_seen_at =
 * last_seen_at = `at`; a repeat sighting only moves last_seen_at (the engine
 * prunes a private mint after max(first_seen + 24 h, last_seen + 6 h)) and
 * fills a missing symbol. Returns how many mints were NEW.
 */
export async function insertArenaPrivateMints(
  agentId: string,
  addonId: string,
  tokens: readonly ArenaAddonToken[],
  at: Date,
): Promise<number> {
  if (tokens.length === 0) return 0;
  const iso = at.toISOString();
  const values = sql.join(
    tokens.map((token) => sql`(${agentId}, ${token.mint}, ${iso}::timestamptz, ${iso}::timestamptz, ${addonId}, ${token.symbol})`),
    sql`, `,
  );
  // `xmax = 0` is true only for a freshly inserted row, not for an updated one.
  const upserted = await rows(sql`
    INSERT INTO floor_arena_private_mints (agent_id, mint, first_seen_at, last_seen_at, source, symbol)
    VALUES ${values}
    ON CONFLICT (agent_id, mint) DO UPDATE
      SET last_seen_at = EXCLUDED.last_seen_at,
          symbol = COALESCE(floor_arena_private_mints.symbol, EXCLUDED.symbol)
    RETURNING (xmax = 0) AS inserted
  `);
  return upserted.filter((row) => row.inserted === true).length;
}

/**
 * Vendor text is untrusted: keep letters, digits and `$ . _ -` only (no emoji,
 * no control or format characters), at most 16 chars; empty becomes null.
 */
export function sanitizeArenaSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.normalize('NFKC').replace(/[^\p{L}\p{N}$._-]/gu, '').slice(0, 16);
  return clean.length > 0 ? clean : null;
}

export interface ArenaTapeItem {
  /** Stable across polls: `<type>:<event id>` (a TP leg exit is its own item). */
  id: string;
  at: string;
  agentId: string;
  agentName: string;
  kind: ArenaAgentKind;
  type: 'entry' | 'exit';
  mint: string;
  symbol: string | null;
  side: 'buy' | 'sell';
  /** Entry: position size. Exit: proceeds of this fill. */
  usd: number;
  /** Exit only, and only when the fill closed the position. */
  pnlUsd: number | null;
  pnlMult: number | null;
  /** 'unresolved' = closed after a >= 30-min quote outage: no sale was priced, so pnlUsd is null. */
  reason: 'tp' | 'stop' | 'trail' | 'time' | 'manual' | 'unresolved' | null;
}

const EXIT_REASONS = new Set(['tp', 'stop', 'trail', 'time', 'manual', 'unresolved']);

/** Null for a malformed row (no size on an entry, no proceeds on an exit): the tape skips it. */
export function mapTapeRow(row: Row): ArenaTapeItem | null {
  const type = row.type === 'exit' ? 'exit' : 'entry';
  const data = (json(row.data) ?? {}) as Record<string, unknown>;
  const reason = type === 'exit' && typeof data.reason === 'string' && EXIT_REASONS.has(data.reason)
    ? (data.reason as ArenaTapeItem['reason'])
    : null;
  // An 'unresolved' exit booked no sale: it shows on the tape with usd 0 and
  // pnl null. Any other row without a size or proceeds is malformed.
  const usd = numOrNull(type === 'entry' ? data.sizeUsd : data.proceedsUsd) ?? (reason === 'unresolved' ? 0 : null);
  if (usd === null) return null;
  return {
    id: `${type}:${num(row.id)}`,
    at: iso(row.at) ?? new Date(0).toISOString(),
    agentId: String(row.agent_id),
    agentName: String(row.agent_name ?? ''),
    kind: row.kind === 'house' ? 'house' : 'user',
    type,
    mint: String(row.mint ?? ''),
    symbol: sanitizeArenaSymbol(row.symbol),
    side: type === 'entry' ? 'buy' : 'sell',
    usd,
    pnlUsd: type === 'exit' ? numOrNull(data.pnlUsd) : null,
    pnlMult: type === 'exit' ? numOrNull(data.pnlMult) : null,
    reason,
  };
}

/** Newest entry and exit fills across ALL arena agents (house and user), newest first. */
export async function readArenaTape(limit: number): Promise<ArenaTapeItem[]> {
  const list = await rows(sql`
    SELECT e.id, e.at, e.agent_id, e.type, e.mint, e.data, a.name AS agent_name, a.kind, p.symbol
    FROM floor_arena_events e
    JOIN floor_arena_agents a ON a.id = e.agent_id
    LEFT JOIN LATERAL (
      SELECT symbol FROM floor_arena_positions
      WHERE id = CASE WHEN e.data->>'positionId' ~ '^[0-9a-fA-F-]{36}$' THEN (e.data->>'positionId')::uuid END
    ) p ON true
    WHERE e.type IN ('entry', 'exit') AND e.mint IS NOT NULL
    ORDER BY e.id DESC
    LIMIT ${limit}
  `);
  return list.map(mapTapeRow).filter((item): item is ArenaTapeItem => item !== null);
}

/**
 * User agents that may spend on add-ons right now (the add-on tick's work
 * list). Money audit M1: only SEATED agents. A standing agent opens no new
 * positions (D7), so it could not use the private mints it would pay for.
 */
export async function readArenaAddonAgents(): Promise<ArenaAgentRecord[]> {
  const list = await rows(sql`
    SELECT * FROM floor_arena_agents
    WHERE kind = 'user' AND status = 'active' AND seated = true AND provision_state = 'ready'
      AND clawpump_agent_id IS NOT NULL
      AND addons @> '[{"enabled": true}]'::jsonb
    ORDER BY id ASC
  `);
  return list.map(mapAgentRow);
}

/**
 * The R1 list: USER agents with a ClawPump agent, provision state ready or
 * failed, NO enabled add-on, and a row change at or after `since` (turning
 * add-ons off bumps updated_at); `since` null = every such agent (a new leader
 * term's full pass). Keyset pages by id after `afterId`, so no row limit.
 */
export async function readArenaX402RecentOff(since: Date | null, afterId: string, limit: number): Promise<string[]> {
  const list = await rows(sql`
    SELECT id FROM floor_arena_agents
    WHERE kind = 'user' AND provision_state IN ('ready', 'failed') AND clawpump_agent_id IS NOT NULL
      AND NOT (addons @> '[{"enabled": true}]'::jsonb)
      AND (${since ? since.toISOString() : null}::timestamptz IS NULL OR updated_at >= ${since ? since.toISOString() : null}::timestamptz)
      AND id > ${afterId}
    ORDER BY id ASC
    LIMIT ${limit}
  `);
  return list.map((row) => String(row.id));
}

/**
 * The x402 background sweep's page: every USER agent with a ClawPump agent in
 * provision state ready or failed, ids after `afterId` in id order (the
 * caller keeps the cursor and wraps to '' at the end).
 */
export async function readArenaX402SweepAgents(afterId: string, limit: number): Promise<string[]> {
  const list = await rows(sql`
    SELECT id FROM floor_arena_agents
    WHERE kind = 'user' AND provision_state IN ('ready', 'failed') AND clawpump_agent_id IS NOT NULL
      AND id > ${afterId}
    ORDER BY id ASC
    LIMIT ${limit}
  `);
  return list.map((row) => String(row.id));
}

/** Codex r21: the bounds of the x402 transaction (engine.ts openPosition pattern). */
export const ARENA_X402_TX_TIMEOUT_MS = 60_000;
export const ARENA_X402_STATEMENT_TIMEOUT_MS = 30_000;
let x402TxBoundMissingWarned = false;

/**
 * Codex r20 (2) / r21 / audit-money L: runs `fn` while holding the per-agent
 * x402 advisory lock ('floor-arena-x402:<id>') in a transaction that stays open
 * for the whole call (ClawPump calls included).
 * - pg_TRY_advisory_xact_lock: when another process (an old leader during a
 *   failover) holds it, this returns { acquired: false } at once; the caller
 *   skips the agent this tick, so the serial loop never waits behind it.
 * - Bounded like engine.ts openPosition: ONE first statement sets
 *   statement_timeout 30 s and, on PostgreSQL 17, resets transaction_timeout to
 *   0 and arms it at 60 s (a server before 17 keeps the statement bound only and
 *   we warn once). Each ClawPump HTTP call is bounded at 15 s by default
 *   (CLAWPUMP_HTTP_TIMEOUT_MS, at most 30 s), below the 60 s transaction bound;
 *   a section whose calls together pass 60 s is ended by Postgres (rolled back,
 *   lock released) and the next tick re-checks (Codex D32: x402 hygiene).
 * - A DIFFERENT key from the add-on row lock: route writes never wait on
 *   ClawPump. The row read inside is readArenaAgentLocked, its own SHORT
 *   transaction, so the add-on lock is never held across a ClawPump call.
 */
export async function tryWithArenaX402Lock<T>(
  agentId: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return db.transaction(async (tx) => {
    const bound = await rows<{ tx_bound: string | null }>(sql`
      SELECT set_config('statement_timeout', ${`${ARENA_X402_STATEMENT_TIMEOUT_MS}ms`}, true) AS statement_bound,
        CASE WHEN current_setting('transaction_timeout', true) IS NULL THEN NULL
             WHEN set_config('transaction_timeout', '0', true) IS NOT NULL
               THEN set_config('transaction_timeout', ${`${ARENA_X402_TX_TIMEOUT_MS}ms`}, true) END AS tx_bound
    `, tx);
    if (!bound[0]?.tx_bound && !x402TxBoundMissingWarned) {
      x402TxBoundMissingWarned = true;
      console.warn('[floor-arena] this Postgres has no transaction_timeout (needs 17): x402 transactions are bounded per statement only');
    }
    const got = (await rows<{ locked: boolean }>(sql`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`floor-arena-x402:${agentId}`}, 0)) AS locked
    `, tx))[0];
    if (got?.locked !== true) return { acquired: false } as const;
    return { acquired: true, value: await fn() } as const;
  });
}

/** The database clock (the R1 "changed since" watermark uses DB time, never the API host's clock). */
export async function readDbNow(): Promise<Date> {
  const list = await rows<{ now: unknown }>(sql`SELECT now() AS now`);
  const value = list[0]?.now;
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Codex r20 (1): the fair removal cursor's page. USER agents with a ClawPump
 * agent, provision state ready or failed, and NO enabled add-on, ids after
 * `afterId` in id order (paged, so it never stops at a row limit).
 */
export async function readArenaX402OffAgents(afterId: string, limit: number): Promise<string[]> {
  const list = await rows(sql`
    SELECT id FROM floor_arena_agents
    WHERE kind = 'user' AND provision_state IN ('ready', 'failed') AND clawpump_agent_id IS NOT NULL
      AND NOT (addons @> '[{"enabled": true}]'::jsonb)
      AND id > ${afterId}
    ORDER BY id ASC
    LIMIT ${limit}
  `);
  return list.map((row) => String(row.id));
}

/**
 * Codex r19: the agent row read under the per-agent advisory lock (the same
 * lock the seat, status and add-on writes take FIRST), so the read sees every
 * committed change. The leader reads this right before each x402 decision.
 */
export async function readArenaAgentLocked(agentId: string): Promise<ArenaAgentRecord | null> {
  return db.transaction(async (tx) => {
    await tx.execute(addonLock(agentId));
    const list = await rows(sql`SELECT * FROM floor_arena_agents WHERE id = ${agentId} LIMIT 1`, tx);
    return list[0] ? mapAgentRow(list[0]) : null;
  });
}

/**
 * Money audit N4: an operator re-provision. Resets a FAILED user agent (also
 * one that used all its attempts) to 'pending' with a fresh attempt budget, so
 * a ClawPump outage longer than the retry window never strands a launch.
 * Returns false for a house row, a missing row, or any state but 'failed'.
 */
export async function resetArenaProvision(agentId: string): Promise<boolean> {
  const updated = await rows(sql`
    UPDATE floor_arena_agents
    SET provision_state = 'pending', provision_attempts = 0, provision_next_at = NULL,
        provision_error = NULL, updated_at = now()
    WHERE id = ${agentId} AND kind = 'user' AND provision_state = 'failed'
    RETURNING id
  `);
  return updated.length > 0;
}

// ─── Provisioning ──────────────────────────────────────────────────────────

/** Due = pending/failed and not waiting, or 'creating' whose 10-minute lease ran out (a crashed claimer). */
export async function readArenaProvisionDue(now: Date, maxAttempts: number, limit: number): Promise<string[]> {
  const list = await rows(sql`
    SELECT id FROM floor_arena_agents
    WHERE kind = 'user' AND provision_state IN ('pending', 'failed', 'creating')
      AND provision_attempts < ${maxAttempts}
      AND (provision_next_at IS NULL OR provision_next_at <= ${now.toISOString()}::timestamptz)
    ORDER BY created_at ASC
    LIMIT ${limit}
  `);
  return list.map((row) => String(row.id));
}

/**
 * Codex r2 #4: the cross-process claim. ONE atomic UPDATE moves a due row to
 * 'creating' with a 10-minute lease (provision_next_at); only the process that
 * gets the row back may call ClawPump. A crashed claimer's row becomes due again
 * when the lease runs out. Returns the claimed row, or null (not due, or taken).
 */
export async function claimArenaProvision(agentId: string, now: Date, maxAttempts: number, leaseMs: number): Promise<ArenaAgentRecord | null> {
  const list = await rows(sql`
    UPDATE floor_arena_agents
    SET provision_state = 'creating',
        provision_next_at = ${new Date(now.getTime() + leaseMs).toISOString()}::timestamptz,
        updated_at = now()
    WHERE id = ${agentId} AND kind = 'user'
      AND provision_state IN ('pending', 'failed', 'creating')
      AND provision_attempts < ${maxAttempts}
      AND (provision_next_at IS NULL OR provision_next_at <= ${now.toISOString()}::timestamptz)
    RETURNING *
  `);
  return list[0] ? mapAgentRow(list[0]) : null;
}

/** Thrown when the ClawPump agent id already belongs to another arena row (unique index). */
export class ArenaClawPumpOwnedError extends Error {
  readonly code = 'clawpump_agent_owned';
  constructor() {
    super('clawpump_agent_owned');
    this.name = 'ArenaClawPumpOwnedError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Stores the ClawPump id ONLY if the row has none yet (first writer wins; a
 * house row can never be re-pointed), then returns what the row holds. A
 * caller that lost a cross-process race gets the WINNER's id and wallet back
 * and must continue with those, so the payment address and the paying agent
 * can never come from two different ClawPump agents.
 */
export async function saveArenaClawPumpAgent(
  agentId: string,
  clawpumpAgentId: string,
  wallet: string | null,
): Promise<{ clawpumpAgentId: string | null; clawpumpWallet: string | null }> {
  try {
    await db.execute(sql`
      UPDATE floor_arena_agents
      SET clawpump_agent_id = ${clawpumpAgentId}, clawpump_wallet = ${wallet}, updated_at = now()
      WHERE id = ${agentId} AND kind = 'user' AND clawpump_agent_id IS NULL
    `);
  } catch (error) {
    // floor_arena_agents_clawpump_agent_uq: that ClawPump agent is another row's.
    if (isUniqueViolation(error)) throw new ArenaClawPumpOwnedError();
    throw error;
  }
  const list = await rows(sql`
    SELECT clawpump_agent_id, clawpump_wallet FROM floor_arena_agents WHERE id = ${agentId} AND kind = 'user'
  `);
  return { clawpumpAgentId: str(list[0]?.clawpump_agent_id), clawpumpWallet: str(list[0]?.clawpump_wallet) };
}

/**
 * Codex r3 #11: completion and failure writes are FENCED by the claim. The
 * claim wrote provision_state 'creating' and a lease end in provision_next_at;
 * that pair is the claim token. A claimant whose lease expired and was
 * re-claimed by another process no longer matches it, so its late write
 * updates 0 rows and the caller drops it.
 */
function claimFence(lease: Date): SQL {
  return sql`provision_state = 'creating' AND provision_next_at = ${lease.toISOString()}::timestamptz`;
}

/** Ready only for the current claim AND the ClawPump id the row holds. False = fenced out or re-pointed. */
export async function markArenaProvisionReady(
  agentId: string,
  clawpumpAgentId: string,
  wallet: string,
  lease: Date,
): Promise<boolean> {
  const updated = await rows(sql`
    UPDATE floor_arena_agents
    SET provision_state = 'ready', provision_error = NULL, clawpump_wallet = ${wallet},
        provision_next_at = NULL, updated_at = now()
    WHERE id = ${agentId} AND kind = 'user' AND clawpump_agent_id = ${clawpumpAgentId} AND ${claimFence(lease)}
    RETURNING id
  `);
  return updated.length > 0;
}

/** Failed only for the current claim. False = a stale claimant (fenced out). */
export async function markArenaProvisionFailed(
  agentId: string,
  error: string,
  attempts: number,
  nextAt: Date | null,
  lease: Date,
): Promise<boolean> {
  const updated = await rows(sql`
    UPDATE floor_arena_agents
    SET provision_state = 'failed', provision_error = ${error.slice(0, 200)}, provision_attempts = ${attempts},
        provision_next_at = ${nextAt ? nextAt.toISOString() : null}::timestamptz, updated_at = now()
    WHERE id = ${agentId} AND kind = 'user' AND ${claimFence(lease)}
    RETURNING id
  `);
  return updated.length > 0;
}

// ─── Wallet withdraw (P5, D34) ─────────────────────────────────────────────
//
// REAL MONEY. Contract: ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md §0, §5.
// Request handlers write rows only (I4). The ONLY door to the transfer POST is the
// compare-and-set `requested -> dispatching` in admitArenaWithdrawal (I1); the
// 0074 guard trigger forbids every way back (I2). Caps, cooldown, one open row and
// idempotency are decided in Postgres under the locks (I6). Lock order everywhere:
// `floor-arena-addon:<agentId>` FIRST (the add-on lock, I5), then (admission only)
// `floor-arena-withdraw-cap`, then row locks. UTC-day bases: `requested_at` for the
// per-agent count and USDC cap, `dispatched_at` for the account-wide USDC cap.
// 'withdraw' events are owner-only: they stay out of ARENA_PUBLIC_USER_EVENT_TYPES.

/** floor_arena_withdraw_addresses row. INTERNAL: owner id, message and signature never leave the API as is. */
export interface ArenaWithdrawAddressRecord {
  id: string;
  agentId: string;
  ownerUserId: string;
  address: string;
  proofKind: FloorArenaWithdrawAddressProof;
  message: string | null;
  signature: string | null;
  challengeNonce: string | null;
  setBy: FloorArenaWithdrawSubjectKind;
  setByAgentId: string | null;
  createdAt: Date;
  activeAt: Date;
  revokedAt: Date | null;
  revokeReason: FloorArenaWithdrawRevokeReason | null;
}

/** floor_arena_withdrawals row. INTERNAL: carries the owner id and the idempotency key. */
export interface ArenaWithdrawalRecord {
  id: string;
  agentId: string;
  ownerUserId: string;
  subjectKind: FloorArenaWithdrawSubjectKind;
  subjectAgentId: string | null;
  idempotencyKey: string;
  asset: FloorArenaWithdrawAsset;
  amountMode: FloorArenaWithdrawAmountMode;
  requestedAtomic: bigint | null;
  amountAtomic: bigint | null;
  sourceClawpumpAgentId: string;
  sourceWallet: string;
  destination: string;
  addressId: string;
  state: FloorArenaWithdrawState;
  errorCode: string | null;
  preBalanceAtomic: bigint | null;
  preSolLamports: bigint | null;
  postBalanceAtomic: bigint | null;
  txSignature: string | null;
  recipientAccountCreated: boolean | null;
  reviewNote: string | null;
  requestedAt: Date;
  dispatchedAt: Date | null;
  sentAt: Date | null;
  finalizedAt: Date | null;
  lastCheckedAt: Date | null;
  checkCount: number;
}

/** A unique violation on floor_arena_withdrawals_tx_uq: that chain signature already belongs to another withdrawal. */
export class ArenaWithdrawTxReusedError extends Error {
  readonly code = 'tx_reused';
  constructor() {
    super('tx_reused');
    this.name = 'ArenaWithdrawTxReusedError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BIGINT = 2n ** 63n - 1n;
const DAY_MS = 24 * 60 * 60_000;
/** Same value as ARENA_WITHDRAW_DISPATCH_STALE_MS (contract §4, floor-arena/withdraw.ts). */
const WITHDRAW_DISPATCH_STALE_MS = 120_000;
/** Bounds of the per-agent withdraw try-lock transaction (contract §4 proof (5)). */
const WITHDRAW_LOCK_TX_TIMEOUT_MS = 150_000;
const WITHDRAW_LOCK_STATEMENT_TIMEOUT_MS = 30_000;
let withdrawTxBoundMissingWarned = false;

function bigOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : BigInt(String(value));
}

function mapWithdrawAddressRow(row: Row): ArenaWithdrawAddressRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    ownerUserId: String(row.owner_user_id),
    address: String(row.address),
    proofKind: String(row.proof_kind) as FloorArenaWithdrawAddressProof,
    message: str(row.message),
    signature: str(row.signature),
    challengeNonce: str(row.challenge_nonce),
    setBy: String(row.set_by) as FloorArenaWithdrawSubjectKind,
    setByAgentId: str(row.set_by_agent_id),
    createdAt: date(row.created_at) ?? new Date(0),
    activeAt: date(row.active_at) ?? new Date(0),
    revokedAt: date(row.revoked_at),
    revokeReason: (str(row.revoke_reason) as FloorArenaWithdrawRevokeReason | null),
  };
}

function mapWithdrawalRow(row: Row): ArenaWithdrawalRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    ownerUserId: String(row.owner_user_id),
    subjectKind: String(row.subject_kind) as FloorArenaWithdrawSubjectKind,
    subjectAgentId: str(row.subject_agent_id),
    idempotencyKey: String(row.idempotency_key),
    asset: String(row.asset) as FloorArenaWithdrawAsset,
    amountMode: String(row.amount_mode) as FloorArenaWithdrawAmountMode,
    requestedAtomic: bigOrNull(row.requested_atomic),
    amountAtomic: bigOrNull(row.amount_atomic),
    sourceClawpumpAgentId: String(row.source_clawpump_agent_id),
    sourceWallet: String(row.source_wallet),
    destination: String(row.destination),
    addressId: String(row.address_id),
    state: String(row.state) as FloorArenaWithdrawState,
    errorCode: str(row.error_code),
    preBalanceAtomic: bigOrNull(row.pre_balance_atomic),
    preSolLamports: bigOrNull(row.pre_sol_lamports),
    postBalanceAtomic: bigOrNull(row.post_balance_atomic),
    txSignature: str(row.tx_signature),
    recipientAccountCreated: typeof row.recipient_account_created === 'boolean' ? row.recipient_account_created : null,
    reviewNote: str(row.review_note),
    requestedAt: date(row.requested_at) ?? new Date(0),
    dispatchedAt: date(row.dispatched_at),
    sentAt: date(row.sent_at),
    finalizedAt: date(row.finalized_at),
    lastCheckedAt: date(row.last_checked_at),
    checkCount: num(row.check_count),
  };
}

/** The constraint of a unique violation (23505) anywhere in the cause chain; '' when unnamed; null when none. */
function uniqueViolationOn(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (record.code === '23505') {
      const name = record.constraint_name ?? record.constraint;
      return typeof name === 'string' ? name : '';
    }
    current = record.cause;
  }
  return null;
}

function stateIn(states: readonly string[]): SQL {
  return sql`state IN (${sql.join(states.map((state) => sql`${state}`), sql`, `)})`;
}

function bigParam(value: bigint | null): SQL {
  return sql`${value === null ? null : value.toString()}::bigint`;
}

function utcDayOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** "0.1 USDC" (no float math); "all free USDC" for a max row whose amount is not fixed yet. */
function withdrawAmountText(atomic: bigint | null, asset: FloorArenaWithdrawAsset): string {
  if (atomic === null) return `all free ${asset}`;
  const decimals = asset === 'USDC' ? FLOOR_ARENA_WITHDRAW_LIMITS.usdcDecimals : FLOOR_ARENA_WITHDRAW_LIMITS.solDecimals;
  const digits = atomic.toString().padStart(decimals + 1, '0');
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${digits.slice(0, digits.length - decimals)}${fraction ? `.${fraction}` : ''} ${asset}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/** A 'withdraw' event (owner feed only) in the caller's transaction. bigint values are written as strings. */
async function insertWithdrawEvent(tx: Tx, agentId: string, summary: string, data: unknown): Promise<void> {
  await tx.execute(sql`
    INSERT INTO floor_arena_events (agent_id, at, type, summary, data)
    VALUES (${agentId}, now(), 'withdraw', ${clampSummary(summary)},
      ${JSON.stringify(data ?? null, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))}::jsonb)
  `);
}

async function readCurrentWithdrawAddress(agentId: string, executor: typeof db | Tx): Promise<ArenaWithdrawAddressRecord | null> {
  const list = await rows(sql`
    SELECT * FROM floor_arena_withdraw_addresses WHERE agent_id = ${agentId} AND revoked_at IS NULL LIMIT 1
  `, executor);
  return list[0] ? mapWithdrawAddressRow(list[0]) : null;
}

async function readOpenWithdrawal(agentId: string, executor: typeof db | Tx): Promise<ArenaWithdrawalRecord | null> {
  const list = await rows(sql`
    SELECT * FROM floor_arena_withdrawals WHERE agent_id = ${agentId} AND ${stateIn(FLOOR_ARENA_WITHDRAW_OPEN_STATES)} LIMIT 1
  `, executor);
  return list[0] ? mapWithdrawalRow(list[0]) : null;
}

/**
 * Issues an address challenge (D34-d): deletes this agent's expired rows, then
 * refuses when 5 non-expired rows remain (a consumed but unexpired row still
 * counts, so issue + consume cannot loop without bound). The count and the
 * insert run under the per-agent add-on lock.
 */
export async function issueArenaWithdrawChallenge(input: {
  agentId: string;
  ownerUserId: string;
  address: string;
  nonce: string;
  now: Date;
}): Promise<{ ok: true; nonce: string; message: string; expiresAt: Date } | { ok: false; reason: 'too_many_challenges' }> {
  const expiresAt = new Date(input.now.getTime() + FLOOR_ARENA_WITHDRAW_LIMITS.challengeTtlMs);
  const message = buildFloorArenaWithdrawAddressMessage({
    agentId: input.agentId, userId: input.ownerUserId, address: input.address, nonce: input.nonce, expiresAt: expiresAt.toISOString(),
  });
  const nowIso = input.now.toISOString();
  return db.transaction(async (tx) => {
    await tx.execute(addonLock(input.agentId));
    await tx.execute(sql`
      DELETE FROM floor_arena_withdraw_challenges WHERE agent_id = ${input.agentId} AND expires_at <= ${nowIso}::timestamptz
    `);
    const live = await rows(sql`
      SELECT count(*)::int AS n FROM floor_arena_withdraw_challenges WHERE agent_id = ${input.agentId}
    `, tx);
    if (num(live[0]?.n) >= FLOOR_ARENA_WITHDRAW_LIMITS.maxLiveChallengesPerAgent) {
      return { ok: false, reason: 'too_many_challenges' } as const;
    }
    await tx.execute(sql`
      INSERT INTO floor_arena_withdraw_challenges (nonce, agent_id, owner_user_id, address, message, expires_at, created_at)
      VALUES (${input.nonce}, ${input.agentId}, ${input.ownerUserId}::uuid, ${input.address}, ${message},
        ${expiresAt.toISOString()}::timestamptz, ${nowIso}::timestamptz)
    `);
    return { ok: true, nonce: input.nonce, message, expiresAt } as const;
  });
}

/**
 * ONE statement: the challenge is spent here, before the caller verifies the
 * signature, so a nonce works at most once (single use). Null = unknown,
 * spent, expired, or bound to another user, agent or address.
 */
export async function consumeArenaWithdrawChallenge(input: {
  nonce: string;
  agentId: string;
  ownerUserId: string;
  address: string;
}): Promise<{ message: string } | null> {
  const list = await rows(sql`
    UPDATE floor_arena_withdraw_challenges SET consumed_at = now()
    WHERE nonce = ${input.nonce} AND agent_id = ${input.agentId} AND owner_user_id = ${input.ownerUserId}::uuid
      AND address = ${input.address} AND consumed_at IS NULL AND expires_at > now()
    RETURNING message
  `);
  return list[0] ? { message: String(list[0].message) } : null;
}

/** True when `address` is the ClawPump wallet of ANY arena agent (house or user): never a withdraw destination. */
export async function isArenaClawPumpWallet(address: string): Promise<boolean> {
  const list = await rows(sql`SELECT 1 FROM floor_arena_agents WHERE clawpump_wallet = ${address} LIMIT 1`);
  return list.length > 0;
}

/** The account's proved self-custody wallet (users.linked_wallet_pubkey) and when it was set; null when either is missing. */
export async function readArenaLinkedWallet(userId: string): Promise<{ address: string; linkedAt: Date } | null> {
  const list = await rows(sql`
    SELECT linked_wallet_pubkey, linked_wallet_at FROM users WHERE id = ${userId}::uuid LIMIT 1
  `);
  const address = str(list[0]?.linked_wallet_pubkey);
  const linkedAt = date(list[0]?.linked_wallet_at);
  return address && linkedAt ? { address, linkedAt } : null;
}

/** The agent's one non-revoked address (pending or active), or null. */
export async function readArenaWithdrawAddress(agentId: string): Promise<ArenaWithdrawAddressRecord | null> {
  return readCurrentWithdrawAddress(agentId, db);
}

/**
 * Sets the agent's withdraw address (D34-e). One transaction: add-on lock ->
 * agent row FOR SHARE (user row of this owner, provision ready) -> the current
 * address is revoked ('replaced') -> insert -> 'withdraw' event. `active_at`
 * is never before the row's `created_at` (CHECK): an `activeAt` in the past
 * means "active now".
 */
export async function setArenaWithdrawAddress(input: {
  agentId: string;
  ownerUserId: string;
  address: string;
  proofKind: FloorArenaWithdrawAddressProof;
  message: string | null;
  signature: string | null;
  challengeNonce: string | null;
  setBy: FloorArenaWithdrawSubjectKind;
  setByAgentId: string | null;
  activeAt: Date;
}): Promise<{ ok: true; address: ArenaWithdrawAddressRecord } | { ok: false; reason: 'same_address' | 'wallet_not_ready' }> {
  return db.transaction(async (tx) => {
    await tx.execute(addonLock(input.agentId));
    const agent = await rows(sql`
      SELECT 1 FROM floor_arena_agents
      WHERE id = ${input.agentId} AND kind = 'user' AND owner_user_id = ${input.ownerUserId}::uuid AND provision_state = 'ready'
      FOR SHARE
    `, tx);
    if (agent.length === 0) return { ok: false, reason: 'wallet_not_ready' } as const;
    const current = await readCurrentWithdrawAddress(input.agentId, tx);
    if (current?.address === input.address) return { ok: false, reason: 'same_address' } as const;
    if (current) {
      await tx.execute(sql`
        UPDATE floor_arena_withdraw_addresses SET revoked_at = now(), revoke_reason = 'replaced'
        WHERE id = ${current.id}::uuid AND revoked_at IS NULL
      `);
    }
    const inserted = await rows(sql`
      INSERT INTO floor_arena_withdraw_addresses (agent_id, owner_user_id, address, proof_kind, message, signature,
        challenge_nonce, set_by, set_by_agent_id, active_at)
      VALUES (${input.agentId}, ${input.ownerUserId}::uuid, ${input.address}, ${input.proofKind}, ${input.message},
        ${input.signature}, ${input.challengeNonce}, ${input.setBy}, ${input.setByAgentId},
        GREATEST(${input.activeAt.toISOString()}::timestamptz, now()))
      RETURNING *
    `, tx);
    const address = mapWithdrawAddressRow(inserted[0]!);
    await insertWithdrawEvent(tx, input.agentId,
      `Withdraw address ${shortAddress(address.address)} set; it works from ${address.activeAt.toISOString()}.`
        + (current ? ` It replaces ${shortAddress(current.address)}.` : ''),
      {
        action: 'address_set', addressId: address.id, address: address.address, proofKind: address.proofKind,
        setBy: address.setBy, activeAt: address.activeAt.toISOString(), replacedAddressId: current?.id ?? null,
      });
    return { ok: true, address } as const;
  });
}

/** Revokes an address at once (owner or admin), under the add-on lock, with a 'withdraw' event. */
export async function revokeArenaWithdrawAddress(input: {
  agentId: string;
  addressId: string;
  reason: 'owner' | 'admin';
}): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'already_revoked' }> {
  if (!UUID_RE.test(input.addressId)) return { ok: false, reason: 'not_found' };
  return db.transaction(async (tx) => {
    await tx.execute(addonLock(input.agentId));
    const found = (await rows(sql`
      SELECT address, revoked_at FROM floor_arena_withdraw_addresses
      WHERE id = ${input.addressId}::uuid AND agent_id = ${input.agentId}
      FOR UPDATE
    `, tx))[0];
    if (!found) return { ok: false, reason: 'not_found' } as const;
    if (found.revoked_at !== null && found.revoked_at !== undefined) return { ok: false, reason: 'already_revoked' } as const;
    await tx.execute(sql`
      UPDATE floor_arena_withdraw_addresses SET revoked_at = now(), revoke_reason = ${input.reason}
      WHERE id = ${input.addressId}::uuid AND revoked_at IS NULL
    `);
    await insertWithdrawEvent(tx, input.agentId,
      `Withdraw address ${shortAddress(String(found.address))} removed (${input.reason}).`,
      { action: 'address_revoked', addressId: input.addressId, reason: input.reason });
    return { ok: true } as const;
  });
}

export type ArenaWithdrawRequestResult =
  | { kind: 'created' | 'replay'; withdrawal: ArenaWithdrawalRecord }
  | {
    kind: 'refused';
    code: (typeof FLOOR_ARENA_WITHDRAW_REQUEST_CODES)[number];
    retryAt?: Date;
    activeAt?: Date;
    withdrawalId?: string;
  };

interface ArenaWithdrawRequestInput {
  agentId: string;
  ownerUserId: string;
  subjectKind: FloorArenaWithdrawSubjectKind;
  subjectAgentId: string | null;
  idempotencyKey: string;
  asset: FloorArenaWithdrawAsset;
  amountMode: FloorArenaWithdrawAmountMode;
  requestedAtomic: bigint | null;
  now: Date;
}

function replayOrConflict(existing: ArenaWithdrawalRecord, input: ArenaWithdrawRequestInput): ArenaWithdrawRequestResult {
  const same = existing.asset === input.asset && existing.amountMode === input.amountMode
    && existing.requestedAtomic === input.requestedAtomic;
  return same
    ? { kind: 'replay', withdrawal: existing }
    : { kind: 'refused', code: 'idempotency_conflict', withdrawalId: existing.id };
}

/**
 * A withdrawal request (contract §5, steps 1-8 in order): ONE transaction that
 * takes the add-on lock FIRST, so two requests of one agent serialise and the
 * second sees the first. Writes the row only (I4): nothing here reads the wallet
 * or calls ClawPump; the leader's admission does. `requested_at` = `now`, the
 * same clock as the cooldown and day checks. The source and the destination are
 * COPIED here (I3). A unique violation (a writer outside this lock) maps back to
 * replay / idempotency_conflict / withdrawal_open. A shape the table refuses
 * (exact without a positive int64 amount, max with an amount) is 'invalid_amount'.
 */
export async function requestArenaWithdrawal(input: ArenaWithdrawRequestInput): Promise<ArenaWithdrawRequestResult> {
  const shapeOk = input.amountMode === 'exact'
    ? input.requestedAtomic !== null && input.requestedAtomic > 0n && input.requestedAtomic <= MAX_BIGINT
    : input.amountMode === 'max' && input.requestedAtomic === null;
  if (!shapeOk) return { kind: 'refused', code: 'invalid_amount' };
  try {
    return await db.transaction((tx) => requestWithdrawalLocked(tx, input));
  } catch (error) {
    const constraint = uniqueViolationOn(error);
    if (constraint === 'floor_arena_withdrawals_agent_idem_uq') {
      const existing = (await rows(sql`
        SELECT * FROM floor_arena_withdrawals WHERE agent_id = ${input.agentId} AND idempotency_key = ${input.idempotencyKey} LIMIT 1
      `))[0];
      if (existing) return replayOrConflict(mapWithdrawalRow(existing), input);
    }
    if (constraint === 'floor_arena_withdrawals_one_open_uq') {
      const open = await readOpenWithdrawal(input.agentId, db);
      return { kind: 'refused', code: 'withdrawal_open', ...(open ? { withdrawalId: open.id } : {}) };
    }
    throw error;
  }
}

async function requestWithdrawalLocked(tx: Tx, input: ArenaWithdrawRequestInput): Promise<ArenaWithdrawRequestResult> {
  const limits = FLOOR_ARENA_WITHDRAW_LIMITS;
  await tx.execute(addonLock(input.agentId));
  // 1. Idempotency.
  const existing = (await rows(sql`
    SELECT * FROM floor_arena_withdrawals WHERE agent_id = ${input.agentId} AND idempotency_key = ${input.idempotencyKey} LIMIT 1
  `, tx))[0];
  if (existing) return replayOrConflict(mapWithdrawalRow(existing), input);
  // 2. The owner's provisioned USER row.
  const agent = (await rows(sql`
    SELECT clawpump_agent_id, clawpump_wallet FROM floor_arena_agents
    WHERE id = ${input.agentId} AND kind = 'user' AND owner_user_id = ${input.ownerUserId}::uuid AND provision_state = 'ready'
      AND clawpump_agent_id IS NOT NULL AND clawpump_wallet IS NOT NULL
    FOR SHARE
  `, tx))[0];
  if (!agent) return { kind: 'refused', code: 'wallet_not_ready' };
  // 3. An ACTIVE proved address.
  const address = await readCurrentWithdrawAddress(input.agentId, tx);
  if (!address) return { kind: 'refused', code: 'no_withdraw_address' };
  if (address.activeAt.getTime() > input.now.getTime()) return { kind: 'refused', code: 'address_pending', activeAt: address.activeAt };
  // 4. One open row per agent.
  const open = await readOpenWithdrawal(input.agentId, tx);
  if (open) return { kind: 'refused', code: 'withdrawal_open', withdrawalId: open.id };
  // 5-7. COUNTED rows: cooldown, the UTC-day count and the UTC-day USDC sum (requested_at basis).
  const dayStart = utcDayOf(input.now);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const inDay = sql`requested_at >= ${dayStart.toISOString()}::timestamptz AND requested_at < ${dayEnd.toISOString()}::timestamptz`;
  const counted = (await rows(sql`
    SELECT MAX(requested_at) AS latest_at,
      COUNT(*) FILTER (WHERE ${inDay})::int AS day_count,
      COALESCE(SUM(COALESCE(amount_atomic, requested_atomic)) FILTER (WHERE asset = 'USDC' AND ${inDay}), 0)::text AS day_usdc
    FROM floor_arena_withdrawals
    WHERE agent_id = ${input.agentId} AND ${stateIn(FLOOR_ARENA_WITHDRAW_COUNTED_STATES)}
  `, tx))[0];
  const latestAt = date(counted?.latest_at);
  if (latestAt && latestAt.getTime() > input.now.getTime() - limits.cooldownMs) {
    return { kind: 'refused', code: 'cooldown', retryAt: new Date(latestAt.getTime() + limits.cooldownMs) };
  }
  if (num(counted?.day_count) >= limits.agentDailyRequests) return { kind: 'refused', code: 'daily_count_cap', retryAt: dayEnd };
  if (input.asset === 'USDC' && input.amountMode === 'exact'
    && BigInt(String(counted?.day_usdc ?? '0')) + input.requestedAtomic! > BigInt(limits.agentDailyUsdcAtomic)) {
    return { kind: 'refused', code: 'agent_daily_cap' };
  }
  // 8. Insert: source and destination are copied from the agent row and the active address (I3).
  const inserted = await rows(sql`
    INSERT INTO floor_arena_withdrawals (agent_id, owner_user_id, subject_kind, subject_agent_id, idempotency_key, asset,
      amount_mode, requested_atomic, source_clawpump_agent_id, source_wallet, destination, address_id, requested_at)
    VALUES (${input.agentId}, ${input.ownerUserId}::uuid, ${input.subjectKind}, ${input.subjectAgentId}, ${input.idempotencyKey},
      ${input.asset}, ${input.amountMode}, ${bigParam(input.requestedAtomic)}, ${String(agent.clawpump_agent_id)},
      ${String(agent.clawpump_wallet)}, ${address.address}, ${address.id}::uuid, ${input.now.toISOString()}::timestamptz)
    RETURNING *
  `, tx);
  const withdrawal = mapWithdrawalRow(inserted[0]!);
  await insertWithdrawEvent(tx, input.agentId,
    `Withdrawal requested: ${withdrawAmountText(withdrawal.requestedAtomic, withdrawal.asset)} to ${shortAddress(withdrawal.destination)}.`,
    {
      action: 'requested', withdrawalId: withdrawal.id, asset: withdrawal.asset, amountMode: withdrawal.amountMode,
      requestedAtomic: withdrawal.requestedAtomic, subjectKind: withdrawal.subjectKind,
    });
  return { kind: 'created', withdrawal };
}

/** Cancels a row that is still 'requested' (the CAS loses to an admission that already moved it). */
export async function cancelArenaWithdrawal(
  agentId: string,
  withdrawalId: string,
): Promise<{ ok: true; withdrawal: ArenaWithdrawalRecord } | { ok: false; reason: 'not_found' | 'not_cancellable' }> {
  if (!UUID_RE.test(withdrawalId)) return { ok: false, reason: 'not_found' };
  return db.transaction(async (tx) => {
    await tx.execute(addonLock(agentId));
    const updated = (await rows(sql`
      UPDATE floor_arena_withdrawals SET state = 'cancelled', finalized_at = now()
      WHERE id = ${withdrawalId}::uuid AND agent_id = ${agentId} AND state = 'requested'
      RETURNING *
    `, tx))[0];
    if (!updated) {
      const exists = await rows(sql`
        SELECT 1 FROM floor_arena_withdrawals WHERE id = ${withdrawalId}::uuid AND agent_id = ${agentId}
      `, tx);
      return { ok: false, reason: exists.length > 0 ? 'not_cancellable' : 'not_found' } as const;
    }
    const withdrawal = mapWithdrawalRow(updated);
    await insertWithdrawEvent(tx, agentId, `Withdrawal of ${withdrawAmountText(withdrawal.requestedAtomic, withdrawal.asset)} cancelled.`,
      { action: 'cancelled', withdrawalId: withdrawal.id });
    return { ok: true, withdrawal } as const;
  });
}

/** The agent's withdrawals, newest request first. */
export async function readArenaWithdrawals(agentId: string, limit: number): Promise<ArenaWithdrawalRecord[]> {
  const list = await rows(sql`
    SELECT * FROM floor_arena_withdrawals WHERE agent_id = ${agentId} ORDER BY requested_at DESC LIMIT ${limit}
  `);
  return list.map(mapWithdrawalRow);
}

export async function readArenaWithdrawSummary(
  agentId: string,
): Promise<{ address: ArenaWithdrawAddressRecord | null; open: ArenaWithdrawalRecord | null }> {
  const [address, open] = await Promise.all([readCurrentWithdrawAddress(agentId, db), readOpenWithdrawal(agentId, db)]);
  return { address, open };
}

/** The leader's dispatch list: 'requested' rows, oldest request first. */
export async function readArenaWithdrawalsDue(limit: number): Promise<ArenaWithdrawalRecord[]> {
  const list = await rows(sql`
    SELECT * FROM floor_arena_withdrawals WHERE state = 'requested' ORDER BY requested_at ASC LIMIT ${limit}
  `);
  return list.map(mapWithdrawalRow);
}

/** The reconcile list: 'dispatching' older than 2 min, 'sent', 'unknown'; least recently checked first. */
export async function readArenaWithdrawalsToReconcile(now: Date, limit: number): Promise<ArenaWithdrawalRecord[]> {
  const staleBefore = new Date(now.getTime() - WITHDRAW_DISPATCH_STALE_MS).toISOString();
  const list = await rows(sql`
    SELECT * FROM floor_arena_withdrawals
    WHERE (state = 'dispatching' AND dispatched_at < ${staleBefore}::timestamptz) OR state IN ('sent', 'unknown')
    ORDER BY last_checked_at ASC NULLS FIRST, requested_at ASC
    LIMIT ${limit}
  `);
  return list.map(mapWithdrawalRow);
}

export type ArenaWithdrawAdmission =
  | { kind: 'dispatched'; withdrawal: ArenaWithdrawalRecord }
  | { kind: 'refused'; code: (typeof FLOOR_ARENA_WITHDRAW_REFUSAL_CODES)[number]; withdrawal: ArenaWithdrawalRecord }
  | { kind: 'wait'; reason: 'paused' | 'account_cap' }
  | { kind: 'gone' };

/** Final refusal in the admission transaction: state refused + code + finalized_at + a 'withdraw' event. */
async function refuseWithdrawalLocked(
  tx: Tx,
  row: ArenaWithdrawalRecord,
  code: (typeof FLOOR_ARENA_WITHDRAW_REFUSAL_CODES)[number],
): Promise<ArenaWithdrawAdmission> {
  const updated = (await rows(sql`
    UPDATE floor_arena_withdrawals SET state = 'refused', error_code = ${code}, finalized_at = now()
    WHERE id = ${row.id}::uuid AND state = 'requested'
    RETURNING *
  `, tx))[0];
  if (!updated) return { kind: 'gone' };
  const withdrawal = mapWithdrawalRow(updated);
  await insertWithdrawEvent(tx, row.agentId,
    `Withdrawal of ${withdrawAmountText(row.requestedAtomic, row.asset)} not sent: ${code}.`,
    { action: 'refused', withdrawalId: row.id, code });
  return { kind: 'refused', code, withdrawal };
}

/**
 * THE ONLY DOOR to the transfer POST (I1). One transaction: add-on lock
 * `floor-arena-addon:<agentId>` FIRST (I5: an add-on reservation and this
 * admission never interleave), then the account-wide cap lock, then the row
 * FOR UPDATE. Checks a-j of contract §5 in order; a refusal books 'refused' +
 * code + finalized_at + a 'withdraw' event in this transaction; 'wait' leaves
 * the row 'requested'. 'dispatched' = the compare-and-set
 * `requested -> dispatching` returned the row: only then may the caller POST,
 * once, to `withdrawal.destination` for `withdrawal.amountAtomic`.
 * `now` is the clock for the address activation (d); `dispatched_at` and the
 * account-wide day (i) both use the database clock of this transaction.
 */
export async function admitArenaWithdrawal(input: {
  withdrawalId: string;
  live: ClawPumpArenaWalletLive;
  destinationHasUsdcAccount: boolean;
  paused: () => boolean;
  now: Date;
}): Promise<ArenaWithdrawAdmission> {
  if (!UUID_RE.test(input.withdrawalId)) return { kind: 'gone' };
  // agent_id never changes (0074 guard trigger): this unlocked read only picks the lock key.
  const head = (await rows(sql`SELECT agent_id FROM floor_arena_withdrawals WHERE id = ${input.withdrawalId}::uuid`))[0];
  if (!head) return { kind: 'gone' };
  const agentId = String(head.agent_id);
  const limits = FLOOR_ARENA_WITHDRAW_LIMITS;
  return db.transaction(async (tx): Promise<ArenaWithdrawAdmission> => {
    await tx.execute(addonLock(agentId));
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('floor-arena-withdraw-cap', 0))`);
    // a. The row, locked; anything but 'requested' is gone (another leader, a cancel).
    const locked = (await rows(sql`SELECT * FROM floor_arena_withdrawals WHERE id = ${input.withdrawalId}::uuid FOR UPDATE`, tx))[0];
    if (!locked) return { kind: 'gone' };
    const row = mapWithdrawalRow(locked);
    if (row.state !== 'requested' || row.agentId !== agentId) return { kind: 'gone' };
    // b. The operator pause holds admission (the row waits).
    if (input.paused()) return { kind: 'wait', reason: 'paused' };
    // c. The same provisioned USER row and ClawPump wallet as at request time; the live read is of that wallet.
    const agent = await rows(sql`
      SELECT 1 FROM floor_arena_agents
      WHERE id = ${agentId} AND kind = 'user' AND provision_state = 'ready'
        AND clawpump_agent_id = ${row.sourceClawpumpAgentId} AND clawpump_wallet = ${row.sourceWallet}
      FOR SHARE
    `, tx);
    if (agent.length === 0) return refuseWithdrawalLocked(tx, row, 'agent_changed');
    if (input.live.address !== row.sourceWallet) return refuseWithdrawalLocked(tx, row, 'source_mismatch');
    // d. The address the row copied is still this agent's current, ACTIVE address (I3).
    const address = await rows(sql`
      SELECT 1 FROM floor_arena_withdraw_addresses
      WHERE id = ${row.addressId}::uuid AND agent_id = ${agentId} AND revoked_at IS NULL
        AND active_at <= ${input.now.toISOString()}::timestamptz AND address = ${row.destination}
    `, tx);
    if (address.length === 0) return refuseWithdrawalLocked(tx, row, 'address_revoked');
    // e. Gas (D34-b): the fee pre-check, plus the rent of a new USDC token account.
    const usdc = row.asset === 'USDC';
    const needLamports = BigInt(limits.feePrecheckLamports)
      + (usdc && !input.destinationHasUsdcAccount ? BigInt(limits.ataRentLamports) : 0n);
    if (input.live.solLamports < needLamports) return refuseWithdrawalLocked(tx, row, 'needs_sol');
    // f. Free balance. USDC: minus open add-on reservations and add-on calls the live read may not show yet (D34-i).
    let free: bigint;
    if (usdc) {
      const addonHeld = (await rows(sql`
        SELECT CEIL(1000000 * COALESCE(SUM(price_usd), 0))::bigint::text AS held FROM floor_arena_addon_calls
        WHERE agent_id = ${agentId}
          AND (state = 'reserved' OR at >= ${new Date(input.live.readAt.getTime() - 5_000).toISOString()}::timestamptz)
      `, tx))[0];
      free = input.live.usdcAtomic - BigInt(String(addonHeld?.held ?? '0'));
    } else {
      free = input.live.solLamports - BigInt(limits.solKeepLamports);
    }
    // g. The amount. USDC: this agent's COUNTED sum on the row's requested_at UTC day, this row excluded.
    let daySum = 0n;
    if (usdc) {
      const dayStart = utcDayOf(row.requestedAt);
      const daySumRow = (await rows(sql`
        SELECT COALESCE(SUM(COALESCE(amount_atomic, requested_atomic)), 0)::text AS sum FROM floor_arena_withdrawals
        WHERE agent_id = ${agentId} AND asset = 'USDC' AND id <> ${row.id}::uuid
          AND ${stateIn(FLOOR_ARENA_WITHDRAW_COUNTED_STATES)}
          AND requested_at >= ${dayStart.toISOString()}::timestamptz
          AND requested_at < ${new Date(dayStart.getTime() + DAY_MS).toISOString()}::timestamptz
      `, tx))[0];
      daySum = BigInt(String(daySumRow?.sum ?? '0'));
    }
    const dayCap = BigInt(limits.agentDailyUsdcAtomic);
    let amount: bigint;
    if (row.amountMode === 'exact' && row.requestedAtomic !== null) {
      amount = row.requestedAtomic;
    } else {
      amount = free;
      if (usdc && dayCap - daySum < amount) amount = dayCap - daySum;
    }
    // h. Minimum, balance, agent day cap (exact USDC).
    if (amount < BigInt(usdc ? limits.minUsdcAtomic : limits.minSolLamports)) return refuseWithdrawalLocked(tx, row, 'below_minimum');
    if (amount > free) return refuseWithdrawalLocked(tx, row, 'insufficient_balance');
    if (usdc && row.amountMode === 'exact' && daySum + amount > dayCap) return refuseWithdrawalLocked(tx, row, 'agent_daily_cap');
    // i. Account-wide USDC per UTC day (dispatched_at basis, database clock). Over it the row waits.
    if (usdc) {
      const accountRow = (await rows(sql`
        SELECT COALESCE(SUM(amount_atomic), 0)::text AS sum FROM floor_arena_withdrawals
        WHERE asset = 'USDC' AND ${stateIn(FLOOR_ARENA_WITHDRAW_COUNTED_STATES)}
          AND dispatched_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
          AND dispatched_at < (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + interval '1 day'
      `, tx))[0];
      if (BigInt(String(accountRow?.sum ?? '0')) + amount > BigInt(limits.accountDailyUsdcAtomic)) {
        return { kind: 'wait', reason: 'account_cap' };
      }
    }
    // j. The compare-and-set: the only way into 'dispatching'.
    const preBalance = usdc ? input.live.usdcAtomic : input.live.solLamports;
    const dispatched = (await rows(sql`
      UPDATE floor_arena_withdrawals
      SET state = 'dispatching', amount_atomic = ${bigParam(amount)}, pre_balance_atomic = ${bigParam(preBalance)},
          pre_sol_lamports = ${bigParam(input.live.solLamports)}, dispatched_at = now()
      WHERE id = ${row.id}::uuid AND state = 'requested'
      RETURNING *
    `, tx))[0];
    if (!dispatched) return { kind: 'gone' };
    const withdrawal = mapWithdrawalRow(dispatched);
    await insertWithdrawEvent(tx, agentId,
      `Sending ${withdrawAmountText(amount, row.asset)} to ${shortAddress(row.destination)}.`,
      { action: 'dispatching', withdrawalId: row.id, asset: row.asset, amountAtomic: amount });
    return { kind: 'dispatched', withdrawal };
  });
}

/**
 * The finalize compare-and-set: updates only WHERE id AND state = ANY(from);
 * sets finalized_at for a final state (every state outside the open set); one
 * 'withdraw' event in the same transaction. Null = CAS lost. A field left
 * undefined in `patch` is not changed. A unique violation on the signature
 * index throws ArenaWithdrawTxReusedError (nothing is written).
 */
export async function finalizeArenaWithdrawal(
  id: string,
  from: readonly FloorArenaWithdrawState[],
  patch: {
    state: FloorArenaWithdrawState;
    errorCode?: string | null;
    txSignature?: string | null;
    recipientAccountCreated?: boolean | null;
    postBalanceAtomic?: bigint | null;
    sentAt?: Date;
  },
  event: { summary: string; data?: unknown },
): Promise<ArenaWithdrawalRecord | null> {
  if (from.length === 0 || !UUID_RE.test(id)) return null;
  const sets: SQL[] = [sql`state = ${patch.state}`];
  if (patch.errorCode !== undefined) sets.push(sql`error_code = ${patch.errorCode}`);
  if (patch.txSignature !== undefined) sets.push(sql`tx_signature = ${patch.txSignature}`);
  if (patch.recipientAccountCreated !== undefined) sets.push(sql`recipient_account_created = ${patch.recipientAccountCreated}::boolean`);
  if (patch.postBalanceAtomic !== undefined) sets.push(sql`post_balance_atomic = ${bigParam(patch.postBalanceAtomic)}`);
  if (patch.sentAt !== undefined) sets.push(sql`sent_at = ${patch.sentAt.toISOString()}::timestamptz`);
  if (!(FLOOR_ARENA_WITHDRAW_OPEN_STATES as readonly string[]).includes(patch.state)) sets.push(sql`finalized_at = now()`);
  try {
    return await db.transaction(async (tx) => {
      const updated = (await rows(sql`
        UPDATE floor_arena_withdrawals SET ${sql.join(sets, sql`, `)}
        WHERE id = ${id}::uuid AND ${stateIn(from)}
        RETURNING *
      `, tx))[0];
      if (!updated) return null;
      const withdrawal = mapWithdrawalRow(updated);
      await insertWithdrawEvent(tx, withdrawal.agentId, event.summary,
        event.data ?? { action: withdrawal.state, withdrawalId: withdrawal.id, code: withdrawal.errorCode });
      return withdrawal;
    });
  } catch (error) {
    if (uniqueViolationOn(error) === 'floor_arena_withdrawals_tx_uq') throw new ArenaWithdrawTxReusedError();
    throw error;
  }
}

/**
 * Attaches a late signature (an old leader's result, or the one reconcile
 * match) ONLY to an 'unknown' row that has none. False = no such row. A
 * signature that another row already holds throws ArenaWithdrawTxReusedError.
 */
export async function attachArenaWithdrawalSignature(id: string, txSignature: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  try {
    const updated = await rows(sql`
      UPDATE floor_arena_withdrawals SET tx_signature = ${txSignature}
      WHERE id = ${id}::uuid AND state = 'unknown' AND tx_signature IS NULL
      RETURNING id
    `);
    return updated.length > 0;
  } catch (error) {
    if (uniqueViolationOn(error) === 'floor_arena_withdrawals_tx_uq') throw new ArenaWithdrawTxReusedError();
    throw error;
  }
}

/** A reconcile pass that decided nothing: last_checked_at = now, check_count + 1. */
export async function touchArenaWithdrawalCheck(id: string, now: Date): Promise<void> {
  if (!UUID_RE.test(id)) return;
  await db.execute(sql`
    UPDATE floor_arena_withdrawals SET last_checked_at = ${now.toISOString()}::timestamptz, check_count = check_count + 1
    WHERE id = ${id}::uuid
  `);
}

/** True when any withdrawal row already holds this chain signature. */
export async function arenaWithdrawSignatureUsed(txSignature: string): Promise<boolean> {
  const list = await rows(sql`SELECT 1 FROM floor_arena_withdrawals WHERE tx_signature = ${txSignature} LIMIT 1`);
  return list.length > 0;
}

/** SUM(price_usd) of this agent's add-on calls at or after `since`, any state (reconcile balance rule). */
export async function readArenaAddonSpentSince(agentId: string, since: Date): Promise<number> {
  const list = await rows(sql`
    SELECT COALESCE(SUM(price_usd), 0) AS spent FROM floor_arena_addon_calls
    WHERE agent_id = ${agentId} AND at >= ${since.toISOString()}::timestamptz
  `);
  return num(list[0]?.spent);
}

/**
 * The open-withdrawal hold (D34-i): per asset SUM(COALESCE(amount_atomic,
 * requested_atomic)) over OPEN rows; `usdcMaxPending` = an open USDC 'max' row
 * whose amount is not fixed yet (the add-on side refuses while it exists).
 */
export async function readArenaOpenWithdrawHold(
  agentId: string,
  executor: typeof db | Tx = db,
): Promise<{ usdcAtomic: bigint; solLamports: bigint; usdcMaxPending: boolean }> {
  const row = (await rows(sql`
    SELECT
      COALESCE(SUM(COALESCE(amount_atomic, requested_atomic)) FILTER (WHERE asset = 'USDC'), 0)::text AS usdc,
      COALESCE(SUM(COALESCE(amount_atomic, requested_atomic)) FILTER (WHERE asset = 'SOL'), 0)::text AS sol,
      COALESCE(bool_or(asset = 'USDC' AND amount_mode = 'max' AND amount_atomic IS NULL), false) AS usdc_max_pending
    FROM floor_arena_withdrawals
    WHERE agent_id = ${agentId} AND ${stateIn(FLOOR_ARENA_WITHDRAW_OPEN_STATES)}
  `, executor))[0];
  return {
    usdcAtomic: BigInt(String(row?.usdc ?? '0')),
    solLamports: BigInt(String(row?.sol ?? '0')),
    usdcMaxPending: row?.usdc_max_pending === true,
  };
}

/**
 * The leader's per-agent withdraw try-lock ('floor-arena-withdraw:<id>'), a copy
 * of tryWithArenaX402Lock with a 150 s transaction bound. It only keeps two
 * leaders from doing the same reads twice; it is NOT the money control (the
 * admission CAS is, contract §4 proof (5)). The local test server (Postgres 16)
 * has no transaction_timeout: the statement bound applies and we warn once.
 */
export async function tryWithArenaWithdrawLock<T>(
  agentId: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return db.transaction(async (tx) => {
    const bound = await rows<{ tx_bound: string | null }>(sql`
      SELECT set_config('statement_timeout', ${`${WITHDRAW_LOCK_STATEMENT_TIMEOUT_MS}ms`}, true) AS statement_bound,
        CASE WHEN current_setting('transaction_timeout', true) IS NULL THEN NULL
             WHEN set_config('transaction_timeout', '0', true) IS NOT NULL
               THEN set_config('transaction_timeout', ${`${WITHDRAW_LOCK_TX_TIMEOUT_MS}ms`}, true) END AS tx_bound
    `, tx);
    if (!bound[0]?.tx_bound && !withdrawTxBoundMissingWarned) {
      withdrawTxBoundMissingWarned = true;
      console.warn('[floor-arena] this Postgres has no transaction_timeout (needs 17): withdraw lock transactions are bounded per statement only');
    }
    const got = (await rows<{ locked: boolean }>(sql`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`floor-arena-withdraw:${agentId}`}, 0)) AS locked
    `, tx))[0];
    if (got?.locked !== true) return { acquired: false } as const;
    return { acquired: true, value: await fn() } as const;
  });
}

/** Admin list (full records; the route never returns message or signature text), newest request first. */
export async function readArenaWithdrawalsAdmin(input: {
  state: FloorArenaWithdrawState | null;
  limit: number;
}): Promise<ArenaWithdrawalRecord[]> {
  const list = await rows(sql`
    SELECT * FROM floor_arena_withdrawals
    WHERE (${input.state}::text IS NULL OR state = ${input.state}::text)
    ORDER BY requested_at DESC
    LIMIT ${input.limit}
  `);
  return list.map(mapWithdrawalRow);
}

/** Admin: 'sent' or 'unknown' -> 'needs_review' with a note. Never sends, never edits money fields. */
export async function markArenaWithdrawalNeedsReview(id: string, note: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  return db.transaction(async (tx) => {
    const updated = (await rows(sql`
      UPDATE floor_arena_withdrawals SET state = 'needs_review', review_note = ${note}, finalized_at = now()
      WHERE id = ${id}::uuid AND state IN ('sent', 'unknown')
      RETURNING agent_id
    `, tx))[0];
    if (!updated) return false;
    await insertWithdrawEvent(tx, String(updated.agent_id), 'An operator checks this withdrawal.',
      { action: 'needs_review', withdrawalId: id });
    return true;
  });
}
