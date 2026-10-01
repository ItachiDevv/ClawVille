'use client';

import { useEffect, useRef } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  FLOOR_ARENA_EVENT_TYPES,
  FLOOR_ARENA_PROVISION_STATES,
  FLOOR_ARENA_SUGGESTION_STATES,
  validateFloorArenaParams,
  type FloorArenaAgentStatus,
  type FloorArenaEventType,
  type FloorArenaExits,
  type FloorArenaParams,
  type FloorArenaProvisionState,
  type FloorArenaSuggestion,
  type FloorArenaSuggestionState,
} from '@clawville/shared';

import { ApiError } from '@/lib/api';
import { useFloorArenaUi } from '@/stores/floor-arena-ui';

// Data layer for the Trading Floor Arena (paper contest). Every route lives
// under `/api/floor/arena`; the contract is docs/trading-floor-arena.md §5.
// This is the HUMAN path. A connected agent reaches the same routes through
// its tools, so nothing here is the only way to act.

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const BASE = '/api/floor/arena';

/** The decision stream re-reads the route this often while it is on screen. */
export const FLOOR_ARENA_EVENTS_POLL_MS = 5_000;
/** How many decision events the client keeps per agent, newest first. */
export const FLOOR_ARENA_EVENTS_KEEP = 200;
const EVENTS_PAGE = 100;
const BOARD_POLL_MS = 30_000;
/**
 * The contest leaderboard also feeds the 3D board on the Trading Floor wall,
 * which the lead set to a 15 s cadence. One shared key, so the panel and the
 * board read one poll.
 */
export const FLOOR_ARENA_LEADERBOARD_POLL_MS = 15_000;
/** The floor tape moves fastest of the public reads; one small JSON per 15 s. */
export const FLOOR_ARENA_TAPE_POLL_MS = 15_000;
const PROFILE_POLL_MS = 15_000;
const ME_POLL_MS = 10_000;
/** Faster while ClawPump provisioning is pending, so the wallet shows soon. */
const ME_PROVISION_POLL_MS = 3_000;

export type FloorArenaLeaderboardWindow = 'contest' | '24h' | 'all';

export const floorArenaKeys = {
  all: ['floor-arena'] as const,
  templates: ['floor-arena', 'templates'] as const,
  leaderboard: (range: FloorArenaLeaderboardWindow) => ['floor-arena', 'leaderboard', range] as const,
  agent: (id: string) => ['floor-arena', 'agent', id] as const,
  events: (id: string) => ['floor-arena', 'events', id] as const,
  /** The owner's FULL stream (GET /me/events): a key of its own, never mixed with the public one. */
  myEvents: (id: string) => ['floor-arena', 'my-events', id] as const,
  discovery: ['floor-arena', 'discovery'] as const,
  contest: ['floor-arena', 'contest'] as const,
  addons: ['floor-arena', 'addons'] as const,
  tape: (limit: number) => ['floor-arena', 'tape', limit] as const,
  me: ['floor-arena', 'me'] as const,
};

// ---------------------------------------------------------------------------
// View types. Every money figure is `number | null`: null means the client
// could not read it, and the UI says so instead of printing $0.00.
// ---------------------------------------------------------------------------

/**
 * One window of an agent's stats. Every figure is `null` when the route did
 * not send a readable one, so the UI prints "-" or "n/a" and never a made-up
 * 0. `trades` counts closed positions; `wins` closed above zero P&L, `losses`
 * below it, so a break-even close is in neither.
 */
export interface FloorArenaAgentStats {
  realisedUsd: number | null;
  trades: number | null;
  wins: number | null;
  losses: number | null;
  /** Closes the engine counts as a near-total loss (a dead coin). */
  deaths: number | null;
  openPositions: number | null;
  lastTradeAt: string | null;
}

/** The route sends every agent's stats for three windows at once. */
export interface FloorArenaStatsByWindow {
  all: FloorArenaAgentStats;
  last24h: FloorArenaAgentStats;
  contest: FloorArenaAgentStats;
}

/**
 * One public leaderboard row. The 3D board reads these too, so a count the
 * route did not send is `null` (drawn as "-"), never a made-up 0. `losses`
 * comes from the route (closes with P&L below zero) and is never derived as
 * `trades - wins`, which would count a break-even close as a loss.
 */
export interface FloorArenaLeaderboardRow {
  rank: number | null;
  agentId: string;
  name: string;
  kind: 'house' | 'user';
  templateId: string;
  realisedUsd: number | null;
  trades: number | null;
  wins: number | null;
  losses: number | null;
  /** Closes the engine counts as a near-total loss. */
  deaths: number | null;
  openPositions: number | null;
  lastTradeAt: string | null;
  eligible: boolean;
}

export interface FloorArenaPositionView {
  id: string;
  mint: string;
  symbol: string | null;
  status: 'open' | 'closed';
  openedAt: string | null;
  closedAt: string | null;
  sizeUsd: number | null;
  entryPriceUsd: number | null;
  lastMarkMult: number | null;
  peakMult: number | null;
  remainingFraction: number | null;
  realisedUsd: number | null;
  pnlUsd: number | null;
  pnlMult: number | null;
  exitReason: string | null;
  paramsVersion: number | null;
  /**
   * The exits frozen when the position opened (`entry_features.exits`), which
   * the engine uses instead of the agent's current rules. Null when the route
   * did not send them (a player's public profile leaves `entryFeatures` out).
   */
  entryExits: FloorArenaExits | null;
}

export interface FloorArenaReportView {
  id: string;
  periodStart: string | null;
  periodEnd: string | null;
  summary: string;
  observations: string[];
  suggestion: FloorArenaSuggestion | null;
  suggestionState: FloorArenaSuggestionState;
  /** `stats.suggestionCheck.tuner`; null on a report written before the field existed. */
  tuner: FloorArenaTunerCheck | null;
}

export const FLOOR_ARENA_TUNER_DECISIONS = ['changed', 'suggested', 'none'] as const;
export const FLOOR_ARENA_TUNER_REASONS = [
  'below_sample',
  'no_candidate',
  'not_significant',
  'rate_limited',
  'changed',
  'suggested',
  'params_changed',
  'not_tunable',
  'waiting_checkpoint',
  'budget_spent',
] as const;

/**
 * Why the tuner changed, suggested or kept the rules in one report (D33). The
 * server tests only at checkpoints (trade counts on the current rules):
 * `waiting_checkpoint` means no test ran and `needed` is the next checkpoint;
 * `budget_spent` means these rules used every checkpoint and nothing changes
 * until the rules change.
 */
export interface FloorArenaTunerCheck {
  decision: (typeof FLOOR_ARENA_TUNER_DECISIONS)[number];
  reason: (typeof FLOOR_ARENA_TUNER_REASONS)[number];
  /** Closed trades the check used, and the count it needs (null when none applies). */
  n: number | null;
  needed: number | null;
  /** The best filter change the check found, or null when it found none. `edge`
   *  is the kept mean multiple minus the excluded mean multiple. */
  best: { path: string; from: unknown; to: unknown; edge: number | null } | null;
  /** The shuffle-test p, the checkpoint it ran at, and the p it had to reach. */
  p: number | null;
  checkpoint: number | null;
  alpha: number | null;
}

export interface FloorArenaParamChangeView {
  id: string;
  at: string | null;
  source: string;
  changes: Array<{ path: string; from: unknown; to: unknown }>;
  paramsVersion: number | null;
  reason: string | null;
}

export interface FloorArenaEventView {
  /** The route's id as a string; `seq` is the same id as a number for order. */
  id: string;
  seq: number;
  at: string | null;
  type: FloorArenaEventType | 'other';
  mint: string | null;
  summary: string;
  /** Realised P&L of an exit when the event carries one; null otherwise. */
  pnlUsd: number | null;
}

/** The public agent (`toPublicAgent` on the API): never an owner id or a secret. */
export interface FloorArenaAgentView {
  id: string;
  name: string;
  kind: 'house' | 'user';
  templateId: string;
  /** Null when the stored rules did not pass the shared validator. */
  params: FloorArenaParams | null;
  paramsVersion: number | null;
  mode: 'paper' | 'live';
  status: FloorArenaAgentStatus;
  seated: boolean;
  seatIndex: number | null;
  /** The public ClawPump wallet that pays for add-ons, once provisioned. */
  paymentAddress: string | null;
  provisionState: FloorArenaProvisionState;
}

export interface FloorArenaProfileView {
  agent: FloorArenaAgentView;
  stats: FloorArenaStatsByWindow;
  openPositions: FloorArenaPositionView[];
  closedPositions: FloorArenaPositionView[];
  latestReport: FloorArenaReportView | null;
  paramChanges: FloorArenaParamChangeView[];
}

export interface FloorArenaMyAddon {
  id: string;
  name: string;
  vendor: string;
  priceUsd: number | null;
  enabled: boolean;
  dailyCapUsd: number | null;
  spentTodayUsd: number | null;
  lastCallAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
}

export interface FloorArenaMyAgent extends FloorArenaAgentView {
  provisionError: string | null;
  /** USDC in the agent's wallet; null when unknown (not provisioned or not read). */
  walletUsdc: number | null;
  addons: FloorArenaMyAddon[];
  autoApplySuggestions: boolean;
  stats: FloorArenaStatsByWindow;
  latestReport: FloorArenaReportView | null;
}

export interface FloorArenaMeView {
  agent: FloorArenaMyAgent | null;
}

export interface FloorArenaHouseStats {
  agentId: string;
  templateId: string;
  name: string;
  stats: FloorArenaStatsByWindow;
}

export interface FloorArenaDiscoveryRow {
  mint: string;
  symbol: string | null;
  firstSeenAt: string | null;
  firstSource: string | null;
  mcapUsd: number | null;
  liqUsd: number | null;
}

export interface FloorArenaContestPrize {
  place: number;
  amount: number;
  token: string;
}

export interface FloorArenaContestView {
  /** The contest block as the route sends it; the 3D board reads it by key. */
  contest: { name: string; startsAt: string; endsAt: string; prizes: FloorArenaContestPrize[] } | null;
  status: 'upcoming' | 'live' | 'ended' | null;
  /**
   * D30: null until the contest ends; then 'provisional' while a position
   * opened inside the window is still open (it can still change the score),
   * and 'final' once the last of them has closed.
   */
  standings: 'provisional' | 'final' | null;
  /** Positions opened inside the window that are still open; null until the end. */
  openWindowPositions: number | null;
  /** Top 10 eligible player agents on the contest window. */
  top: FloorArenaLeaderboardRow[];
  /** House agents on the same window, for comparison; never eligible. */
  house: FloorArenaLeaderboardRow[];
}

/** One entry or exit on the floor-wide tape (the 3D board and trade tape). */
export interface FloorArenaTapeItem {
  id: string;
  at: string | null;
  agentName: string;
  type: 'entry' | 'exit';
  symbol: string | null;
  usd: number | null;
  pnlUsd: number | null;
}

// ---------------------------------------------------------------------------
// Wire readers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A finite number, or null. Postgres `numeric` columns reach JSON as strings,
 * so a numeric string counts; anything else is "we do not know", never 0.
 */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A count: a non-negative safe integer, else 0. Counts are never money. */
function count(value: unknown): number {
  return countOrNull(value) ?? 0;
}

/** A count, or null when the wire did not send a readable one. */
function countOrNull(value: unknown): number | null {
  const parsed = num(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function idString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function list<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    const parsed = read(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function readStats(value: unknown): FloorArenaAgentStats {
  const row = record(value) ?? {};
  return {
    realisedUsd: num(row.realisedUsd),
    trades: countOrNull(row.trades),
    wins: countOrNull(row.wins),
    losses: countOrNull(row.losses),
    deaths: countOrNull(row.deaths),
    openPositions: countOrNull(row.openPositions),
    lastTradeAt: str(row.lastTradeAt),
  };
}

/** A missing window reads as unknown money (null), never as a flat $0.00. */
export function readStatsByWindow(value: unknown): FloorArenaStatsByWindow {
  const row = record(value) ?? {};
  return { all: readStats(row.all), last24h: readStats(row.last24h), contest: readStats(row.contest) };
}

export function readLeaderboardRow(value: unknown): FloorArenaLeaderboardRow | null {
  const row = record(value);
  const agentId = str(row?.agentId);
  if (!row || !agentId) return null;
  const rank = countOrNull(row.rank);
  return {
    rank: rank !== null && rank >= 1 ? rank : null,
    agentId,
    name: str(row.name) ?? agentId,
    kind: row.kind === 'house' ? 'house' : 'user',
    templateId: str(row.templateId) ?? '',
    realisedUsd: num(row.realisedUsd),
    trades: countOrNull(row.trades),
    wins: countOrNull(row.wins),
    losses: countOrNull(row.losses),
    deaths: countOrNull(row.deaths),
    openPositions: countOrNull(row.openPositions),
    lastTradeAt: str(row.lastTradeAt),
    eligible: row.eligible === true,
  };
}

export function readPosition(value: unknown): FloorArenaPositionView | null {
  const row = record(value);
  const id = idString(row?.id);
  const mint = str(row?.mint);
  if (!row || !id || !mint) return null;
  return {
    id,
    mint,
    symbol: str(row.symbol),
    status: row.status === 'closed' ? 'closed' : 'open',
    openedAt: str(row.openedAt),
    closedAt: str(row.closedAt),
    sizeUsd: num(row.sizeUsd),
    entryPriceUsd: num(row.entryPriceUsd),
    lastMarkMult: num(row.lastMarkMult),
    peakMult: num(row.peakMult),
    remainingFraction: num(row.remainingFraction),
    realisedUsd: num(row.realisedUsd),
    pnlUsd: num(row.pnlUsd),
    pnlMult: num(row.pnlMult),
    exitReason: str(row.exitReason),
    paramsVersion: num(row.paramsVersion),
    entryExits: readExits(record(row.entryFeatures)?.exits),
  };
}

/** Same acceptance rule as the engine's `exitsOf`: a tp list and a max hold. */
function readExits(value: unknown): FloorArenaExits | null {
  const row = record(value);
  if (!row || !Array.isArray(row.tp) || typeof row.max_hold_s !== 'number') return null;
  const tp: Array<[number, number]> = [];
  for (const leg of row.tp) {
    const multiple = Array.isArray(leg) ? num(leg[0]) : null;
    const fraction = Array.isArray(leg) ? num(leg[1]) : null;
    if (multiple === null || fraction === null) return null;
    tp.push([multiple, fraction]);
  }
  const optional = (input: unknown): number | null | undefined => (input === null || input === undefined ? null : num(input) ?? undefined);
  const stop = optional(row.stop_mult);
  const trail = optional(row.trail_from_peak);
  const arm = optional(row.trail_arm_mult);
  if (stop === undefined || trail === undefined || arm === undefined) return null;
  return { tp, stop_mult: stop, trail_from_peak: trail, trail_arm_mult: arm, max_hold_s: row.max_hold_s };
}

export function readReport(value: unknown): FloorArenaReportView | null {
  const row = record(value);
  const id = idString(row?.id);
  if (!row || !id) return null;
  const suggestion = record(row.suggestion);
  const stats = record(row.stats);
  // The analysis writes its observations into `stats`; a top-level list wins
  // if the route ever lifts them out.
  const observations = Array.isArray(row.observations)
    ? row.observations
    : Array.isArray(stats?.observations)
      ? stats.observations
      : [];
  return {
    id,
    periodStart: str(row.periodStart),
    periodEnd: str(row.periodEnd),
    summary: typeof row.summary === 'string' ? row.summary : '',
    observations: observations.filter((line): line is string => typeof line === 'string' && line.length > 0),
    suggestion: suggestion && str(suggestion.path)
      ? {
          path: suggestion.path as string,
          from: suggestion.from,
          to: suggestion.to,
          reason: typeof suggestion.reason === 'string' ? suggestion.reason : '',
        }
      : null,
    suggestionState: (FLOOR_ARENA_SUGGESTION_STATES as readonly string[]).includes(row.suggestionState as string)
      ? (row.suggestionState as FloorArenaSuggestionState)
      : 'none',
    tuner: readTunerCheck(record(stats?.suggestionCheck)?.tuner),
  };
}

/** `stats.suggestionCheck.tuner`. Absent, or an unknown decision or reason, reads as null (no line). */
export function readTunerCheck(value: unknown): FloorArenaTunerCheck | null {
  const row = record(value);
  if (!row) return null;
  const decision = FLOOR_ARENA_TUNER_DECISIONS.find((known) => known === row.decision);
  const reason = FLOOR_ARENA_TUNER_REASONS.find((known) => known === row.reason);
  if (!decision || !reason) return null;
  const best = record(row.best);
  return {
    decision,
    reason,
    n: num(row.n),
    needed: num(row.needed),
    best: best && str(best.path) ? { path: best.path as string, from: best.from, to: best.to, edge: num(best.edge) } : null,
    p: num(row.p),
    checkpoint: num(row.checkpoint),
    alpha: num(row.alpha),
  };
}

function readParamChange(value: unknown): FloorArenaParamChangeView | null {
  const row = record(value);
  const id = idString(row?.id);
  if (!row || !id) return null;
  return {
    id,
    at: str(row.at),
    source: str(row.source) ?? 'unknown',
    changes: list(row.changes, (item) => {
      const change = record(item);
      const path = str(change?.path);
      return change && path ? { path, from: change.from, to: change.to } : null;
    }),
    paramsVersion: num(row.paramsVersion),
    reason: str(row.reason),
  };
}

export function readEvent(value: unknown): FloorArenaEventView | null {
  const row = record(value);
  const id = idString(row?.id);
  const seq = num(row?.id);
  if (!row || !id || seq === null) return null;
  const data = record(row.data);
  return {
    id,
    seq,
    at: str(row.at),
    type: (FLOOR_ARENA_EVENT_TYPES as readonly string[]).includes(row.type as string)
      ? (row.type as FloorArenaEventType)
      : 'other',
    mint: str(row.mint),
    summary: typeof row.summary === 'string' ? row.summary : '',
    pnlUsd: num(data?.pnlUsd ?? data?.pnl_usd),
  };
}

function readParams(value: unknown): FloorArenaParams | null {
  const result = validateFloorArenaParams(value);
  return result.ok ? result.params : null;
}

/**
 * True while the ClawPump agent is being set up. `creating` means a server
 * process holds the setup claim right now; to the player it is the same wait.
 */
export function floorArenaProvisionInProgress(state: FloorArenaProvisionState): boolean {
  return state === 'pending' || state === 'creating';
}

function readProvisionState(value: unknown): FloorArenaProvisionState | null {
  return (FLOOR_ARENA_PROVISION_STATES as readonly string[]).includes(value as string)
    ? (value as FloorArenaProvisionState)
    : null;
}

function readAgent(value: unknown): FloorArenaAgentView | null {
  const row = record(value);
  const id = str(row?.id);
  if (!row || !id) return null;
  return {
    id,
    name: str(row.name) ?? id,
    kind: row.kind === 'house' ? 'house' : 'user',
    templateId: str(row.templateId) ?? '',
    params: readParams(row.params),
    paramsVersion: num(row.paramsVersion),
    mode: row.mode === 'live' ? 'live' : 'paper',
    status: row.status === 'paused' ? 'paused' : row.status === 'stopped' ? 'stopped' : 'active',
    seated: row.seated === true,
    seatIndex: num(row.seatIndex),
    paymentAddress: str(row.paymentAddress),
    provisionState: readProvisionState(row.provisionState) ?? 'none',
  };
}

function readMyAddon(value: unknown): FloorArenaMyAddon | null {
  const row = record(value);
  const id = str(row?.id);
  if (!row || !id) return null;
  return {
    id,
    name: str(row.name) ?? id,
    vendor: str(row.vendor) ?? '',
    priceUsd: num(row.priceUsd),
    enabled: row.enabled === true,
    dailyCapUsd: num(row.dailyCapUsd),
    spentTodayUsd: num(row.spentTodayUsd),
    lastCallAt: str(row.lastCallAt),
    lastOk: typeof row.lastOk === 'boolean' ? row.lastOk : null,
    lastError: str(row.lastError),
  };
}

/**
 * GET /me: the public agent plus the owner-only fields the route sends beside
 * it (payment address, provisioning, wallet balance, add-on spend, stats and
 * the latest report).
 */
export function readMe(body: Record<string, unknown>): FloorArenaMeView {
  const agent = readAgent(body.agent);
  if (!agent) return { agent: null };
  const provision = record(body.provision);
  const wallet = record(body.wallet);
  return {
    agent: {
      ...agent,
      paymentAddress: str(body.paymentAddress) ?? agent.paymentAddress,
      provisionState: readProvisionState(provision?.state) ?? agent.provisionState,
      provisionError: str(provision?.error),
      walletUsdc: num(wallet?.usdc),
      addons: list(body.addons, readMyAddon),
      autoApplySuggestions: record(body.agent)?.autoApplySuggestions === true,
      stats: readStatsByWindow(body.stats),
      latestReport: readReport(body.latestReport),
    },
  };
}

export function readProfile(body: Record<string, unknown>): FloorArenaProfileView | null {
  const agent = readAgent(body.agent);
  if (!agent) return null;
  return {
    agent,
    stats: readStatsByWindow(body.stats),
    openPositions: list(body.openPositions, readPosition),
    closedPositions: list(body.closedPositions, readPosition),
    latestReport: readReport(body.latestReport),
    paramChanges: list(body.paramChanges, readParamChange),
  };
}

function readPrize(value: unknown): FloorArenaContestPrize | null {
  const row = record(value);
  const place = num(row?.place);
  const amount = num(row?.amount);
  const token = str(row?.token);
  return place !== null && amount !== null && token ? { place, amount, token } : null;
}

export function readContest(body: Record<string, unknown>): FloorArenaContestView {
  const contest = record(body.contest);
  const name = str(contest?.name);
  const startsAt = str(contest?.startsAt);
  const endsAt = str(contest?.endsAt);
  return {
    contest: contest && name && startsAt && endsAt
      ? { name, startsAt, endsAt, prizes: list(contest.prizes, readPrize) }
      : null,
    status: body.status === 'upcoming' || body.status === 'live' || body.status === 'ended' ? body.status : null,
    standings: body.standings === 'provisional' || body.standings === 'final' ? body.standings : null,
    openWindowPositions: countOrNull(body.openWindowPositions),
    top: list(body.top, readLeaderboardRow),
    house: list(body.house, readLeaderboardRow),
  };
}

export function readTapeItem(value: unknown): FloorArenaTapeItem | null {
  const row = record(value);
  const id = idString(row?.id);
  if (!row || !id || (row.type !== 'entry' && row.type !== 'exit')) return null;
  return {
    id,
    at: str(row.at),
    agentName: str(row.agentName) ?? '',
    type: row.type,
    symbol: str(row.symbol),
    usd: num(row.usd),
    pnlUsd: num(row.pnlUsd),
  };
}

/**
 * Newest first, one row per id, at most `keep` rows. Returns `previous` itself
 * when nothing new arrived, so an idle poll does not re-render the stream.
 */
export function mergeFloorArenaEvents(
  previous: readonly FloorArenaEventView[],
  incoming: readonly FloorArenaEventView[],
  keep: number = FLOOR_ARENA_EVENTS_KEEP,
): FloorArenaEventView[] {
  const known = new Set(previous.map((event) => event.id));
  const fresh = incoming.filter((event) => !known.has(event.id));
  if (fresh.length === 0) return previous as FloorArenaEventView[];
  const seen = new Set<string>();
  const merged: FloorArenaEventView[] = [];
  for (const event of [...fresh, ...previous].sort((a, b) => b.seq - a.seq)) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
    if (merged.length >= keep) break;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * `ApiError` plus the validator's error list from a 400 `invalid_params`.
 * Branch on `code` / `status`, never on `message`.
 */
export class FloorArenaApiError extends ApiError {
  readonly errors: string[];

  constructor(message: string, status: number, code: unknown, errors: string[]) {
    super(message, status, code);
    this.name = 'FloorArenaApiError';
    this.errors = errors;
  }
}

async function request(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_URL}${BASE}${path}`, {
    method,
    credentials: 'include',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const parsed = record(await response.json().catch(() => null)) ?? {};
  if (!response.ok) {
    const message = typeof parsed.error === 'string'
      ? parsed.error
      : typeof parsed.message === 'string'
        ? parsed.message
        : `Request failed: ${response.status}`;
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.filter((line): line is string => typeof line === 'string')
      : [];
    throw new FloorArenaApiError(message, response.status, parsed.code, errors);
  }
  return parsed;
}

export function floorArenaErrorCode(error: unknown): string | null {
  return error instanceof ApiError && typeof error.code === 'string' ? error.code : null;
}

/** Anonymous (401) or a tier that cannot own an arena agent (403). */
function isNotEligible(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/** Plain-words copy for a refused arena write. */
export function floorArenaErrorCopy(error: unknown): string {
  const code = floorArenaErrorCode(error);
  if (code === 'guest_not_allowed') return 'Create a free account to run an arena trader.';
  if (code === 'already_have_agent') return 'You already run an arena trader. Open it from the arena.';
  if (code === 'invalid_params') return 'Some rules are outside their limits. Check the fields marked below.';
  if (code === 'live_not_available') return 'Live trading is not open yet. Paper trading is open now.';
  if (code === 'rate_limited') return 'Too many requests. Wait a moment and try again.';
  if (code === 'addon_cap_exceeded') return 'The daily caps of the add-ons you turned on add up to more than the limit.';
  if (code === 'unknown_addon') return 'One of those add-ons is no longer offered. Reload and choose again.';
  if (code === 'unknown_template') return 'That template is no longer offered. Pick another one.';
  if (code === 'params_conflict') return 'Your rules changed somewhere else at the same time. Reload them and try again.';
  if (code === 'suggestion_not_pending') return 'That suggestion was already answered.';
  if (code === 'suggestion_stale') return 'You changed that rule after the report, so the suggestion no longer applies.';
  if (code === 'agent_stopped') return 'This trader is stopped, so it cannot be paused or resumed.';
  if (code === 'name_reserved') return 'That name belongs to a house trader. Type another name for your trader.';
  if (code === 'name_needs_letter') return 'Use at least one letter, so the name does not look like a number.';
  if (code === 'name_not_allowed') return 'This name is not allowed. Type another name for your trader.';
  if (code === 'invalid_body') return 'Some details were not accepted. Check the name and the numbers, then try again.';
  if (code === 'no_agent' || (error instanceof ApiError && error.status === 404)) return 'You do not run an arena trader yet.';
  if (error instanceof ApiError && error.status === 401) return 'Your session ended. Sign in again.';
  // The shared auth middleware answers 403 with a NUMERIC code (no avatar, or
  // an agent session that has not proved its avatar), so no string code here.
  if (error instanceof ApiError && error.status === 403) {
    return 'This account cannot run an arena trader yet. It needs an avatar of its own.';
  }
  return 'The request could not be completed. Try again.';
}

// ---------------------------------------------------------------------------
// Seat sync (called by the 3D room, outside React and outside any frame loop)
// ---------------------------------------------------------------------------

let seatChain: Promise<void> = Promise.resolve();
let seatWritesPending = 0;
/**
 * `agentId:seatIndex` of the last reconcile write, so GET /me repairs a seat at
 * most once per sit. Without it a server that keeps answering "not seated"
 * (a failing write, a refused seat) would loop: write, re-read, write again.
 */
let reconciledFor: string | null = null;

/**
 * How long after a sit the desk panel opens. The panel freezes the room's
 * player controller, and the controller is what moves the avatar onto the
 * chair on the frame AFTER the sit, so opening at once would leave the avatar
 * sitting down in the aisle behind the panel. 1.2 s lets it reach the chair and
 * start the sit clip first.
 */
export const FLOOR_ARENA_DESK_PANEL_DELAY_MS = 1_200;
let deskPanelTimer: ReturnType<typeof setTimeout> | null = null;

type SeatBody = { seated: true; seatIndex: number } | { seated: false };

function enqueueSeatWrite(body: SeatBody): void {
  seatWritesPending += 1;
  // One write at a time and in order, so a quick sit then stand can never land
  // as stand then sit on the server.
  seatChain = seatChain.then(async () => {
    try {
      await request('POST', '/me/seat', body);
    } catch (error) {
      // Refused for want of an account or an agent: stop writing until GET /me
      // says otherwise. Any other failure is retried by the next GET /me read.
      if (isNotEligible(error) || (error instanceof ApiError && error.status === 404)) {
        useFloorArenaUi.getState().setMyAgent('none');
      }
    } finally {
      seatWritesPending -= 1;
      useFloorArenaUi.getState().noteSeatWriteSettled();
    }
  });
}

/**
 * The room calls this on every seat TRANSITION: sit (desk index), stand or
 * leave the room (-1). A sit opens "My trader" after
 * FLOOR_ARENA_DESK_PANEL_DELAY_MS; the arena section shows the launch flow
 * there instead when the player has no arena agent.
 *
 * The server write goes out only when GET /me has already said the player has
 * an agent. Otherwise `fetchMe` reconciles the seat when it answers, so a guest
 * or a player with no agent never sends a request that can only be refused.
 * Closing the tab sends nothing on purpose: the agent keeps its desk (spec D7).
 */
export function reportTradingFloorSeat(seatIndex: number): void {
  const ui = useFloorArenaUi.getState();
  if (ui.localSeatIndex === seatIndex) return;
  reconciledFor = null;
  ui.setLocalSeatIndex(seatIndex);
  if (deskPanelTimer !== null) {
    clearTimeout(deskPanelTimer);
    deskPanelTimer = null;
  }
  if (seatIndex >= 0) {
    deskPanelTimer = setTimeout(() => {
      deskPanelTimer = null;
      // Still in THAT seat: a stand or a room exit in between cancels it.
      if (useFloorArenaUi.getState().localSeatIndex === seatIndex) useFloorArenaUi.getState().openArena('desk');
    }, FLOOR_ARENA_DESK_PANEL_DELAY_MS);
  }
  if (ui.myAgent !== 'present') return;
  enqueueSeatWrite(seatIndex >= 0 ? { seated: true, seatIndex } : { seated: false });
}

/** Test seam: waits for every queued seat write to settle. */
export function flushFloorArenaSeatWritesForTest(): Promise<void> {
  return seatChain;
}

/** Test seam: forgets the last reconcile and any pending panel, as a fresh page load would. */
export function resetFloorArenaSeatSyncForTest(): void {
  reconciledFor = null;
  if (deskPanelTimer !== null) clearTimeout(deskPanelTimer);
  deskPanelTimer = null;
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchMe(): Promise<FloorArenaMeView> {
  let view: FloorArenaMeView;
  try {
    view = readMe(await request('GET', '/me'));
  } catch (error) {
    if (isNotEligible(error)) useFloorArenaUi.getState().setMyAgent('none');
    throw error;
  }
  const ui = useFloorArenaUi.getState();
  ui.setMyAgent(view.agent ? 'present' : 'none');
  // RECONCILE, in the fetcher and not in an effect, so it runs even when the
  // panel closed before this answer arrived. Only toward the local seat: a
  // server seat with no local sitter is the agent keeping its desk after the
  // tab closed (spec D7), and that is left alone.
  const agent = view.agent;
  const local = ui.localSeatIndex;
  const key = agent ? `${agent.id}:${local}` : null;
  if (
    agent &&
    local >= 0 &&
    seatWritesPending === 0 &&
    reconciledFor !== key &&
    (!agent.seated || agent.seatIndex !== local)
  ) {
    reconciledFor = key;
    enqueueSeatWrite({ seated: true, seatIndex: local });
  }
  return view;
}

async function fetchEventsPage(
  client: QueryClient,
  key: readonly unknown[],
  path: string,
): Promise<FloorArenaEventView[]> {
  const previous = client.getQueryData<FloorArenaEventView[]>(key) ?? [];
  const cursor = previous[0]?.id ?? null;
  const query = cursor
    ? `?after=${encodeURIComponent(cursor)}&limit=${EVENTS_PAGE}`
    : `?limit=${EVENTS_PAGE}`;
  const body = await request('GET', `${path}${query}`);
  return mergeFloorArenaEvents(previous, list(body.events, readEvent));
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function noRetryOnRefusal(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 1;
}

/** Live stats of the five house agents, keyed by template id. */
export function useFloorArenaTemplates(enabled: boolean) {
  return useQuery({
    queryKey: floorArenaKeys.templates,
    queryFn: async (): Promise<FloorArenaHouseStats[]> => {
      const body = await request('GET', '/templates');
      return list(body.houseAgents, (item) => {
        const row = record(item);
        const agentId = str(row?.id);
        const templateId = str(row?.templateId);
        if (!row || !agentId || !templateId) return null;
        return { agentId, templateId, name: str(row.name) ?? agentId, stats: readStatsByWindow(row.stats) };
      });
    },
    enabled,
    staleTime: BOARD_POLL_MS,
    refetchInterval: BOARD_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

export function useFloorArenaLeaderboard(range: FloorArenaLeaderboardWindow, enabled: boolean) {
  return useQuery({
    queryKey: floorArenaKeys.leaderboard(range),
    queryFn: async () => {
      const body = await request('GET', `/leaderboard?window=${range}`);
      return list(body.rows, readLeaderboardRow);
    },
    enabled,
    staleTime: FLOOR_ARENA_LEADERBOARD_POLL_MS,
    refetchInterval: FLOOR_ARENA_LEADERBOARD_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

export function useFloorArenaAgent(agentId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: floorArenaKeys.agent(agentId ?? ''),
    queryFn: async () => {
      const profile = readProfile(await request('GET', `/agents/${encodeURIComponent(agentId!)}`));
      if (!profile) throw new ApiError('The agent profile was unreadable.', 502);
      return profile;
    },
    enabled: enabled && agentId !== null,
    staleTime: PROFILE_POLL_MS,
    refetchInterval: PROFILE_POLL_MS,
    refetchIntervalInBackground: false,
    retry: noRetryOnRefusal,
  });
}

/**
 * The PUBLIC decision stream of any agent, newest first. Each poll asks only
 * for events after the newest one already held (`after` cursor) and merges
 * them in, so a quiet agent costs one small empty response every 5 s. For a
 * player's agent the route sends only buys, sells, rule changes and status
 * changes; the owner reads the full stream with `useFloorArenaMyEvents`.
 */
export function useFloorArenaEvents(agentId: string | null, enabled: boolean) {
  const client = useQueryClient();
  const key = floorArenaKeys.events(agentId ?? '');
  return useQuery({
    queryKey: key,
    queryFn: () => fetchEventsPage(client, key, `/agents/${encodeURIComponent(agentId!)}/events`),
    enabled: enabled && agentId !== null,
    staleTime: FLOOR_ARENA_EVENTS_POLL_MS,
    refetchInterval: FLOOR_ARENA_EVENTS_POLL_MS,
    refetchIntervalInBackground: false,
    retry: noRetryOnRefusal,
  });
}

/**
 * The owner's FULL decision stream (GET /me/events: skips, scans, reports and
 * add-on calls too). `agentId` only keys the cache, so a new agent starts a
 * fresh stream; the route resolves the agent from the session.
 */
export function useFloorArenaMyEvents(agentId: string | null, enabled: boolean) {
  const client = useQueryClient();
  const key = floorArenaKeys.myEvents(agentId ?? '');
  return useQuery({
    queryKey: key,
    queryFn: () => fetchEventsPage(client, key, '/me/events'),
    enabled: enabled && agentId !== null,
    staleTime: FLOOR_ARENA_EVENTS_POLL_MS,
    refetchInterval: FLOOR_ARENA_EVENTS_POLL_MS,
    refetchIntervalInBackground: false,
    retry: noRetryOnRefusal,
  });
}

export function useFloorArenaDiscovery(enabled: boolean) {
  return useQuery({
    queryKey: floorArenaKeys.discovery,
    queryFn: async () => {
      const body = await request('GET', '/discovery?limit=20');
      return list(body.mints, (item): FloorArenaDiscoveryRow | null => {
        const row = record(item);
        const mint = str(row?.mint);
        if (!row || !mint) return null;
        const snapshot = record(row.snapshot);
        return {
          mint,
          symbol: str(row.symbol),
          firstSeenAt: str(row.firstSeenAt),
          firstSource: str(row.firstSource),
          mcapUsd: num(snapshot?.mcap ?? row.mcap),
          liqUsd: num(snapshot?.liqUsd ?? row.liqUsd),
        };
      });
    },
    enabled,
    staleTime: BOARD_POLL_MS,
    refetchInterval: BOARD_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

export function useFloorArenaContest(enabled: boolean) {
  return useQuery({
    queryKey: floorArenaKeys.contest,
    queryFn: async (): Promise<FloorArenaContestView> => readContest(await request('GET', '/contest')),
    enabled,
    staleTime: BOARD_POLL_MS * 2,
    refetchInterval: BOARD_POLL_MS * 2,
    refetchIntervalInBackground: false,
  });
}

export interface FloorArenaAddonView {
  id: string;
  vendor: string;
  name: string;
  priceUsd: number;
  minIntervalS: number;
  note: string;
}

export interface FloorArenaAddonCatalog {
  addons: FloorArenaAddonView[];
  /** False while the server's add-on payments are switched off: choices are saved but nothing is bought. */
  paymentsEnabled: boolean;
}

/** The vetted paid add-on catalog. Rarely changes, so no poll. */
export function useFloorArenaAddons(enabled: boolean) {
  return useQuery({
    queryKey: floorArenaKeys.addons,
    queryFn: async (): Promise<FloorArenaAddonCatalog> => {
      const body = await request('GET', '/addons');
      const addons = list(body.addons, (item): FloorArenaAddonView | null => {
        const row = record(item);
        const id = str(row?.id);
        const priceUsd = num(row?.priceUsd);
        const minIntervalS = num(row?.minIntervalS);
        if (!row || !id || priceUsd === null || minIntervalS === null || minIntervalS <= 0) return null;
        return {
          id,
          vendor: str(row.vendor) ?? '',
          name: str(row.name) ?? id,
          priceUsd,
          minIntervalS,
          note: typeof row.note === 'string' ? row.note : '',
        };
      });
      return { addons, paymentsEnabled: body.paymentsEnabled === true };
    },
    enabled,
    staleTime: 5 * 60_000,
  });
}

/**
 * Floor-wide entries and exits, newest first, for the 3D board and the 3D
 * trade tape (one shared key per `limit`, so both read one poll).
 */
export function useFloorArenaTape(limit: number, enabled: boolean) {
  return useQuery({
    queryKey: floorArenaKeys.tape(limit),
    queryFn: async (): Promise<FloorArenaTapeItem[]> => {
      const body = await request('GET', `/tape?limit=${limit}`);
      return list(Array.isArray(body.items) ? body.items : body.tape, readTapeItem);
    },
    enabled,
    staleTime: FLOOR_ARENA_TAPE_POLL_MS,
    refetchInterval: FLOOR_ARENA_TAPE_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/**
 * The viewer's own arena agent, or `{ agent: null }`. Polls faster while the
 * ClawPump agent is still provisioning, and re-reads after each seat write.
 */
export function useFloorArenaMe(enabled: boolean) {
  const seatWriteVersion = useFloorArenaUi((state) => state.seatWriteVersion);
  const baseline = useRef(seatWriteVersion);
  const query = useQuery({
    queryKey: floorArenaKeys.me,
    queryFn: fetchMe,
    enabled,
    staleTime: 5_000,
    refetchInterval: (current) =>
      current.state.data?.agent && floorArenaProvisionInProgress(current.state.data.agent.provisionState)
        ? ME_PROVISION_POLL_MS
        : ME_POLL_MS,
    refetchIntervalInBackground: false,
    retry: noRetryOnRefusal,
  });
  const { refetch } = query;

  useEffect(() => {
    if (seatWriteVersion === baseline.current) return;
    baseline.current = seatWriteVersion;
    if (enabled) void refetch();
  }, [enabled, refetch, seatWriteVersion]);

  return query;
}

// ---------------------------------------------------------------------------
// Mutations. Each one refreshes the viewer's agent and its public profile.
// ---------------------------------------------------------------------------

function useArenaMutation<TInput>(
  write: (input: TInput) => Promise<Record<string, unknown>>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: floorArenaKeys.me });
      void client.invalidateQueries({ queryKey: ['floor-arena', 'agent'] });
      void client.invalidateQueries({ queryKey: ['floor-arena', 'events'] });
      void client.invalidateQueries({ queryKey: ['floor-arena', 'my-events'] });
    },
  });
}

export interface FloorArenaAddonChoice {
  id: string;
  enabled: boolean;
  dailyCapUsd: number;
}

export interface FloorArenaLaunchInput {
  templateId: string;
  params: FloorArenaParams;
  addons: FloorArenaAddonChoice[];
  name?: string;
}

export interface FloorArenaLaunchResult {
  agentId: string | null;
  agentName: string | null;
  paymentAddress: string | null;
}

export function useLaunchFloorArenaAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: FloorArenaLaunchInput): Promise<FloorArenaLaunchResult> => {
      const body = await request('POST', '/me/launch', {
        templateId: input.templateId,
        params: input.params,
        mode: 'paper',
        addons: input.addons
          .filter((addon) => addon.enabled)
          .map((addon) => ({ id: addon.id, dailyCapUsd: addon.dailyCapUsd })),
        ...(input.name ? { name: input.name } : {}),
      });
      const agent = record(body.agent);
      return {
        agentId: str(agent?.id),
        agentName: str(agent?.name),
        paymentAddress: str(body.paymentAddress),
      };
    },
    onSuccess: () => {
      useFloorArenaUi.getState().setMyAgent('present');
      void client.invalidateQueries({ queryKey: floorArenaKeys.me });
      void client.invalidateQueries({ queryKey: ['floor-arena', 'leaderboard'] });
    },
  });
}

export function usePatchFloorArenaParams() {
  return useArenaMutation((input: { params: FloorArenaParams; reason?: string }) =>
    request('PATCH', '/me/params', input.reason ? { params: input.params, reason: input.reason } : { params: input.params }),
  );
}

/** Only for the desk panel's "Leave the desk" button. The room uses `reportTradingFloorSeat`. */
export function useSetFloorArenaSeat() {
  return useArenaMutation((input: SeatBody) => request('POST', '/me/seat', input));
}

export function useSetFloorArenaStatus() {
  return useArenaMutation((input: { status: 'active' | 'paused' }) => request('POST', '/me/status', input));
}

export function usePatchFloorArenaAddons() {
  return useArenaMutation((input: { addons: FloorArenaAddonChoice[] }) =>
    request('PATCH', '/me/addons', {
      addons: input.addons.map((addon) => ({ id: addon.id, enabled: addon.enabled, dailyCapUsd: addon.dailyCapUsd })),
    }),
  );
}

export function useFloorArenaSuggestionAction() {
  return useArenaMutation((input: { reportId: string; action: 'apply' | 'dismiss' }) =>
    request('POST', `/me/suggestions/${encodeURIComponent(input.reportId)}`, { action: input.action }),
  );
}

export function usePatchFloorArenaSettings() {
  return useArenaMutation((input: { autoApplySuggestions: boolean }) => request('PATCH', '/me/settings', input));
}
