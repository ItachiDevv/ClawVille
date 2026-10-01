import { sql, type SQL } from 'drizzle-orm';
import { db } from '@clawville/database';
import { FLOOR_ARENA_CONTEST } from '@clawville/shared';

/**
 * Trading Floor Arena leaderboard (docs/trading-floor-arena.md D6, §5).
 *
 * Score = realised paper P&L in USD of CLOSED positions. Windows:
 *   contest: opened at or after startsAt and at or before endsAt, whatever the close time (D30: a
 *            position still open at the end counts when it closes, so a losing one cannot drop out)
 *   24h:     closed in the last 24 hours
 *   all:     every closed position
 * trades = closed positions in the window, wins = P&L > 0, losses = P&L < 0
 * (a flat close, P&L = 0, is neither), deaths = P&L multiple <= 0.5.
 * P&L is pnl_usd / pnl_mult. An 'unresolved' close (no usable price for 30 min, pnl_usd NULL)
 * counts nowhere on 24h and all; on the contest window (D31) it counts as a loss of its open
 * stake: P&L = realised_usd - size_usd (realised_usd = gross proceeds of earlier TP legs).
 * openPositions and lastTradeAt are current facts, not windowed.
 * Rank: realisedUsd desc (compared in whole cents), then trades desc, then created_at asc.
 * `eligible` (prize eligibility, contest window only; Codex r2 #6, rule 6 as amended by D30) =
 * a USER agent, created by the contest end (enrolled), with at least ONE qualifying trade: a
 * closed position opened inside the window, whatever its close time (the same set as the
 * score). House agents are shown but never eligible; a user agent with no qualifying trade is
 * shown with eligible:false, so it can never take a prize place.
 *
 * The SQL does the aggregation; the ranking is the pure `rankArenaLeaderboard`,
 * which the fixture tests pin.
 */

export const ARENA_LEADERBOARD_WINDOWS = ['contest', '24h', 'all'] as const;
export type ArenaLeaderboardWindow = (typeof ARENA_LEADERBOARD_WINDOWS)[number];
export const ARENA_DEATH_MULT = 0.5;

export interface ArenaWindowBounds {
  openedFrom: Date | null;
  openedTo: Date | null;
  closedFrom: Date | null;
  closedTo: Date | null;
  /** D31: an 'unresolved' close scores as a loss of its open stake. Contest window only. */
  unresolvedAsLoss: boolean;
}

export interface ArenaContestWindow {
  id?: string;
  startsAt: string;
  endsAt: string;
}

export interface ArenaAgentAggregate {
  agentId: string;
  name: string;
  kind: 'house' | 'user';
  templateId: string;
  createdAt: Date;
  /** The contest the agent enrolled in at launch (null when launched after it ended). */
  contestId: string | null;
  realisedUsd: number;
  trades: number;
  wins: number;
  losses: number;
  deaths: number;
  openPositions: number;
  /** Open positions opened inside the window (D30 provisional standings); every open position off the contest window. */
  windowOpenPositions: number;
  lastTradeAt: Date | null;
}

export interface ArenaLeaderboardRow {
  rank: number;
  agentId: string;
  name: string;
  kind: 'house' | 'user';
  templateId: string;
  realisedUsd: number;
  trades: number;
  wins: number;
  losses: number;
  deaths: number;
  openPositions: number;
  lastTradeAt: string | null;
  eligible: boolean;
}

export function isArenaLeaderboardWindow(value: unknown): value is ArenaLeaderboardWindow {
  return typeof value === 'string' && (ARENA_LEADERBOARD_WINDOWS as readonly string[]).includes(value);
}

export function resolveLeaderboardBounds(
  window: ArenaLeaderboardWindow,
  now: Date,
  contest: ArenaContestWindow = FLOOR_ARENA_CONTEST,
): ArenaWindowBounds {
  if (window === 'contest') {
    const endsAt = new Date(contest.endsAt);
    return {
      openedFrom: new Date(contest.startsAt), openedTo: endsAt, closedFrom: null, closedTo: null, unresolvedAsLoss: true,
    };
  }
  const plain = { openedFrom: null, openedTo: null, closedTo: null, unresolvedAsLoss: false };
  if (window === '24h') return { ...plain, closedFrom: new Date(now.getTime() - 24 * 3_600_000) };
  return { ...plain, closedFrom: null };
}

/** Whole cents, so a float sum like 0.1 + 0.2 cannot break a tie. */
export function toCents(usd: number): number {
  return Math.round(usd * 100);
}

export function isContestEligible(
  row: Pick<ArenaAgentAggregate, 'kind' | 'createdAt' | 'trades' | 'contestId'>,
  window: ArenaLeaderboardWindow,
  contest: ArenaContestWindow = FLOOR_ARENA_CONTEST,
): boolean {
  // Codex r3 #6: enrolment is explicit. Launch writes contest_id only while the
  // contest is open, and eligibility requires THIS contest's id.
  return window === 'contest'
    && row.kind === 'user'
    && row.contestId !== null
    && row.contestId === (contest.id ?? FLOOR_ARENA_CONTEST.id)
    && row.createdAt.getTime() <= new Date(contest.endsAt).getTime()
    && row.trades >= 1;
}

export function rankArenaLeaderboard(
  rows: readonly ArenaAgentAggregate[],
  window: ArenaLeaderboardWindow,
  contest: ArenaContestWindow = FLOOR_ARENA_CONTEST,
): ArenaLeaderboardRow[] {
  const sorted = [...rows].sort((a, b) =>
    toCents(b.realisedUsd) - toCents(a.realisedUsd)
    || b.trades - a.trades
    || a.createdAt.getTime() - b.createdAt.getTime()
    || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  return sorted.map((row, index) => ({
    rank: index + 1,
    agentId: row.agentId,
    name: row.name,
    kind: row.kind,
    templateId: row.templateId,
    realisedUsd: toCents(row.realisedUsd) / 100,
    trades: row.trades,
    wins: row.wins,
    losses: row.losses,
    deaths: row.deaths,
    openPositions: row.openPositions,
    lastTradeAt: row.lastTradeAt ? row.lastTradeAt.toISOString() : null,
    eligible: isContestEligible(row, window, contest),
  }));
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// Raw-sql timestamps go in as ISO strings with an explicit cast (repo rule).
function openedInWindowParts(bounds: ArenaWindowBounds): SQL[] {
  const parts: SQL[] = [];
  if (bounds.openedFrom) parts.push(sql`p.opened_at >= ${bounds.openedFrom.toISOString()}::timestamptz`);
  if (bounds.openedTo) parts.push(sql`p.opened_at <= ${bounds.openedTo.toISOString()}::timestamptz`);
  return parts;
}

/** SQL predicate: the position is a closed trade that counts in this window. */
export function closedInWindowSql(bounds: ArenaWindowBounds): SQL {
  const parts: SQL[] = [
    sql`p.status = 'closed'`,
    // The closed_pnl CHECK allows pnl_usd NULL only on an 'unresolved' close.
    bounds.unresolvedAsLoss ? sql`(p.pnl_usd IS NOT NULL OR p.exit_reason = 'unresolved')` : sql`p.pnl_usd IS NOT NULL`,
    ...openedInWindowParts(bounds),
  ];
  if (bounds.closedFrom) parts.push(sql`p.closed_at >= ${bounds.closedFrom.toISOString()}::timestamptz`);
  if (bounds.closedTo) parts.push(sql`p.closed_at <= ${bounds.closedTo.toISOString()}::timestamptz`);
  return sql.join(parts, sql` AND `);
}

/** SQL predicate: a position opened inside the window that is still open (D30 provisional standings). */
export function openInWindowSql(bounds: ArenaWindowBounds): SQL {
  return sql.join([sql`p.status = 'open'`, ...openedInWindowParts(bounds)], sql` AND `);
}

/**
 * The P&L in USD a window scores for one counted position. D31: on the contest window an
 * 'unresolved' close loses its open stake: realised_usd (gross proceeds of earlier TP legs)
 * minus size_usd, the formula the engine books for a normal close, with 0 proceeds for the rest.
 */
export function windowPnlUsdSql(bounds: ArenaWindowBounds): SQL {
  return bounds.unresolvedAsLoss ? sql`COALESCE(p.pnl_usd, p.realised_usd - p.size_usd)` : sql`p.pnl_usd`;
}

/** The P&L multiple of one counted position (deaths), by the same D31 rule (size_usd > 0 by CHECK). */
export function windowPnlMultSql(bounds: ArenaWindowBounds): SQL {
  return bounds.unresolvedAsLoss ? sql`COALESCE(p.pnl_mult, p.realised_usd / p.size_usd)` : sql`p.pnl_mult`;
}

type AggregateSqlRow = {
  agent_id: string;
  name: string;
  kind: 'house' | 'user';
  template_id: string;
  created_at: Date | string;
  contest_id: string | null;
  realised_usd: string | number | null;
  trades: string | number;
  wins: string | number;
  losses: string | number;
  deaths: string | number;
  open_positions: string | number;
  window_open_positions: string | number;
  last_trade_at: Date | string | null;
};

/** The aggregate query: one row per agent (optionally only `agentIds`). */
export function arenaAggregatesSql(
  window: ArenaLeaderboardWindow,
  now: Date,
  agentIds: readonly string[] | null = null,
): SQL {
  const bounds = resolveLeaderboardBounds(window, now);
  const inWindow = closedInWindowSql(bounds);
  const pnlUsd = windowPnlUsdSql(bounds);
  const pnlMult = windowPnlMultSql(bounds);
  const agentFilter = agentIds === null
    ? sql``
    : agentIds.length === 0
      ? sql`WHERE false`
      : sql`WHERE a.id IN (${sql.join(agentIds.map((id) => sql`${id}`), sql`, `)})`;
  return sql`
    SELECT
      a.id AS agent_id,
      a.name,
      a.kind,
      a.template_id,
      a.created_at,
      a.contest_id,
      COALESCE(SUM(${pnlUsd}) FILTER (WHERE ${inWindow}), 0) AS realised_usd,
      COUNT(p.id) FILTER (WHERE ${inWindow}) AS trades,
      COUNT(p.id) FILTER (WHERE ${inWindow} AND ${pnlUsd} > 0) AS wins,
      COUNT(p.id) FILTER (WHERE ${inWindow} AND ${pnlUsd} < 0) AS losses,
      COUNT(p.id) FILTER (WHERE ${inWindow} AND ${pnlMult} <= ${ARENA_DEATH_MULT}) AS deaths,
      COUNT(p.id) FILTER (WHERE p.status = 'open') AS open_positions,
      COUNT(p.id) FILTER (WHERE ${openInWindowSql(bounds)}) AS window_open_positions,
      MAX(COALESCE(p.closed_at, p.opened_at)) AS last_trade_at
    FROM floor_arena_agents a
    LEFT JOIN floor_arena_positions p ON p.agent_id = a.id
    ${agentFilter}
    GROUP BY a.id, a.name, a.kind, a.template_id, a.created_at, a.contest_id
  `;
}

/** One aggregate row per agent (optionally only `agentIds`). */
export async function readArenaAggregates(
  window: ArenaLeaderboardWindow,
  now: Date,
  agentIds: readonly string[] | null = null,
): Promise<ArenaAgentAggregate[]> {
  const rows = await db.execute<AggregateSqlRow>(arenaAggregatesSql(window, now, agentIds));
  // Both driver shapes (postgres-js array, `{ rows }`); same rule as queries.ts rowsOf.
  const list: AggregateSqlRow[] = Array.isArray(rows)
    ? rows
    : Array.isArray((rows as { rows?: unknown }).rows) ? (rows as unknown as { rows: AggregateSqlRow[] }).rows : [];
  return list.map((row) => ({
    agentId: row.agent_id,
    name: row.name,
    kind: row.kind,
    templateId: row.template_id,
    createdAt: toDate(row.created_at) ?? new Date(0),
    contestId: typeof row.contest_id === 'string' ? row.contest_id : null,
    realisedUsd: toNumber(row.realised_usd),
    trades: toNumber(row.trades),
    wins: toNumber(row.wins),
    losses: toNumber(row.losses),
    deaths: toNumber(row.deaths),
    openPositions: toNumber(row.open_positions),
    windowOpenPositions: toNumber(row.window_open_positions),
    lastTradeAt: toDate(row.last_trade_at),
  }));
}

export interface ArenaBoard {
  rows: ArenaLeaderboardRow[];
  /** Sum of `windowOpenPositions` over every agent (on the contest window: the D30 provisional count). */
  windowOpenPositions: number;
}

const LEADERBOARD_CACHE_MS = 10_000;
const leaderboardCache = new Map<ArenaLeaderboardWindow, { expiresAt: number; board: ArenaBoard }>();

/** Ranked board for a window plus its open window positions, cached 10 s in process. */
export async function readArenaBoard(
  window: ArenaLeaderboardWindow,
  now: Date = new Date(),
): Promise<ArenaBoard> {
  const cached = leaderboardCache.get(window);
  if (cached && cached.expiresAt > now.getTime()) return cached.board;
  const aggregates = await readArenaAggregates(window, now);
  const board: ArenaBoard = {
    rows: rankArenaLeaderboard(aggregates, window),
    windowOpenPositions: aggregates.reduce((sum, row) => sum + row.windowOpenPositions, 0),
  };
  leaderboardCache.set(window, { expiresAt: now.getTime() + LEADERBOARD_CACHE_MS, board });
  return board;
}

/** Ranked board for a window, cached 10 s in process. */
export async function readArenaLeaderboard(
  window: ArenaLeaderboardWindow,
  now: Date = new Date(),
): Promise<ArenaLeaderboardRow[]> {
  return (await readArenaBoard(window, now)).rows;
}

/** Test seam. */
export function _resetArenaLeaderboardCacheForTest(): void {
  leaderboardCache.clear();
}
