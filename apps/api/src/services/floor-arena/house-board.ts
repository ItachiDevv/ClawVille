import { sql, type SQL } from 'drizzle-orm';
import { db } from '@clawville/database';
import { FLOOR_ARENA_CONTEST, FLOOR_ARENA_HOUSE_AGENTS } from '@clawville/shared';
import { maskArenaFields, maskArenaPosition, type ArenaMasked } from './content-mask';
import { FLOOR_ARENA_FAIL_CODES } from './filters';
import {
  readArenaAgentStats,
  readArenaHouseAgents,
  readArenaPositions,
  rowsOf,
  sanitizeArenaSymbol,
  type ArenaAgentRecord,
  type ArenaAgentStats,
  type ArenaPosition,
} from './queries';

/**
 * P15 T1: the public house-board payload, GET /api/floor/arena/house-board
 * (ops/house-traders/arena-review/P15_PLAN_2026-10-02.md §1). One request
 * gives the five house-agent columns of the big screen on the Trading Floor.
 * Agents read the same payload; it is a read only and moves no money.
 *
 * Rules:
 * - Always five agents, in FLOOR_ARENA_HOUSE_AGENTS order (= template order).
 * - A missing house row gives null mode, status, paramsVersion and exits. The
 *   mode comes from the row only; this file never guesses it.
 * - `scan` is the newest 'scan' event, null when it is older than 15 min.
 *   `watching` is the newest 'pass' event, null when it is older than 10 min.
 * - `open` holds at most five open positions, newest first.
 * - Every coin symbol passes the content mask (masked -> `***`, `masked: true`).
 * - The payload never carries a mint, a source, a wallet or payment address,
 *   a ClawPump agent id or an owner id. Each object is built field by field.
 */

export const HOUSE_BOARD_VERSION = 1 as const;
export const HOUSE_BOARD_SCAN_MAX_AGE_MS = 15 * 60_000;
export const HOUSE_BOARD_WATCH_MAX_AGE_MS = 10 * 60_000;
export const HOUSE_BOARD_OPEN_MAX = 5;
/**
 * The SQL read looks back this far, so it never walks old events. The 2 min margin covers an
 * event whose `at` was set before its insert (an entry event: at most 60 s, the entry
 * transaction limit in engine.ts), so the id floor never cuts off a scan or pass in the window.
 */
const SIGNAL_LOOKBACK_MS = HOUSE_BOARD_SCAN_MAX_AGE_MS + 2 * 60_000;

const FAIL_CODES: ReadonlySet<string> = new Set(FLOOR_ARENA_FAIL_CODES);

export type ArenaHouseBoardStats = Record<'all' | 'last24h' | 'contest', ArenaAgentStats>;

export interface ArenaHouseBoardScan {
  at: string;
  evaluated: number;
  passed: number;
  held: number;
  topSkip: Array<{ code: string; count: number }>;
}

export type ArenaHouseBoardWatching = ArenaMasked<{ at: string; symbol: string | null }>;

export type ArenaHouseBoardOpen = ArenaMasked<{
  symbol: string | null;
  openedAt: string;
  sizeUsd: number;
  lastMarkMult: number | null;
}>;

export interface ArenaHouseBoardAgent {
  id: string;
  name: string;
  templateId: string;
  mode: 'paper' | 'live' | null;
  status: 'active' | 'paused' | 'stopped' | null;
  paramsVersion: number | null;
  exits: { tpMult: number | null; stopMult: number | null; maxHoldS: number | null } | null;
  stats: ArenaHouseBoardStats;
  scan: ArenaHouseBoardScan | null;
  watching: ArenaHouseBoardWatching | null;
  open: ArenaHouseBoardOpen[];
}

export interface ArenaHouseBoardResponse {
  version: typeof HOUSE_BOARD_VERSION;
  agents: ArenaHouseBoardAgent[];
  contest: { startsAt: string; endsAt: string };
  generatedAt: string;
}

/** The newest scan and pass of one agent, as the SQL read gives them. No mint is kept. */
export interface ArenaHouseSignals {
  scanAt: string | null;
  scanData: unknown;
  passAt: string | null;
  passSymbol: string | null;
}

export interface HouseBoardDeps {
  readHouseAgents(): Promise<ArenaAgentRecord[]>;
  readStats(agentIds: readonly string[], now: Date): Promise<Map<string, ArenaHouseBoardStats>>;
  readOpenPositions(agentId: string, limit: number): Promise<ArenaPosition[]>;
  readSignals(agentIds: readonly string[], now: Date): Promise<Map<string, ArenaHouseSignals>>;
}

export const defaultHouseBoardDeps: HouseBoardDeps = {
  readHouseAgents: readArenaHouseAgents,
  readStats: readArenaAgentStats,
  readOpenPositions: (agentId, limit) => readArenaPositions(agentId, 'open', limit),
  readSignals: (agentIds, now) => readArenaHouseSignals(agentIds, now),
};

// ─── Small readers ─────────────────────────────────────────────────────────

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function jsonOrNull(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

/** True when `at` is readable and not older than `maxAgeMs` at `now`. */
function fresh(at: string | null, now: Date, maxAgeMs: number): at is string {
  if (at === null) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && now.getTime() - ms <= maxAgeMs;
}

function emptyStats(): ArenaAgentStats {
  return { realisedUsd: 0, trades: 0, wins: 0, losses: 0, deaths: 0, openPositions: 0, lastTradeAt: null };
}

// ─── Column parts ──────────────────────────────────────────────────────────

/** First TP leg, stop and hold time of the row's LIVE params. A field that is off or unreadable is null. */
function exitsOf(row: ArenaAgentRecord): ArenaHouseBoardAgent['exits'] {
  const exits = (row.params as { exits?: unknown } | null)?.exits;
  if (!exits || typeof exits !== 'object' || Array.isArray(exits)) return null;
  const { tp, stop_mult: stopMult, max_hold_s: maxHoldS } = exits as Record<string, unknown>;
  const firstLeg = Array.isArray(tp) && Array.isArray(tp[0]) ? tp[0] : null;
  return {
    tpMult: firstLeg ? finiteOrNull(firstLeg[0]) : null,
    stopMult: finiteOrNull(stopMult),
    maxHoldS: finiteOrNull(maxHoldS),
  };
}

/** The scan event data `{evaluated, passed, held, top}`; null when a count is unreadable. */
function scanOf(signal: ArenaHouseSignals | undefined, now: Date): ArenaHouseBoardScan | null {
  if (!signal || !fresh(signal.scanAt, now, HOUSE_BOARD_SCAN_MAX_AGE_MS)) return null;
  const data = signal.scanData;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const evaluated = countOrNull(record.evaluated);
  const passed = countOrNull(record.passed);
  const held = countOrNull(record.held);
  if (evaluated === null || passed === null || held === null) return null;
  // Known fail codes only (filters.ts), so no free text reaches the public board.
  const topSkip: ArenaHouseBoardScan['topSkip'] = [];
  for (const entry of Array.isArray(record.top) ? record.top : []) {
    if (!Array.isArray(entry)) continue;
    const [code, count] = entry as unknown[];
    const n = countOrNull(count);
    if (typeof code === 'string' && FAIL_CODES.has(code) && n !== null) topSkip.push({ code, count: n });
  }
  return { at: signal.scanAt, evaluated, passed, held, topSkip };
}

function watchingOf(signal: ArenaHouseSignals | undefined, now: Date): ArenaHouseBoardWatching | null {
  if (!signal || !fresh(signal.passAt, now, HOUSE_BOARD_WATCH_MAX_AGE_MS)) return null;
  return maskArenaFields({ at: signal.passAt, symbol: signal.passSymbol }, ['symbol']);
}

/** Newest first, at most five; each item is built field by field (no mint, no source). */
function openOf(positions: readonly ArenaPosition[]): ArenaHouseBoardOpen[] {
  return [...positions]
    .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))
    .slice(0, HOUSE_BOARD_OPEN_MAX)
    .map((position) => maskArenaPosition({
      symbol: position.symbol,
      openedAt: position.openedAt,
      sizeUsd: position.sizeUsd,
      lastMarkMult: position.lastMarkMult,
    }));
}

// ─── The payload ───────────────────────────────────────────────────────────

export async function buildArenaHouseBoard(deps: HouseBoardDeps, now: Date): Promise<ArenaHouseBoardResponse> {
  const ids = FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.id);
  const [rows, stats, signals, open] = await Promise.all([
    deps.readHouseAgents(),
    deps.readStats(ids, now),
    deps.readSignals(ids, now),
    Promise.all(ids.map((id) => deps.readOpenPositions(id, HOUSE_BOARD_OPEN_MAX))),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const agents = FLOOR_ARENA_HOUSE_AGENTS.map((house, index): ArenaHouseBoardAgent => {
    const row = byId.get(house.id);
    const signal = signals.get(house.id);
    return {
      id: house.id,
      name: house.name,
      templateId: house.templateId,
      mode: row ? row.mode : null,
      status: row ? row.status : null,
      paramsVersion: row ? row.paramsVersion : null,
      exits: row ? exitsOf(row) : null,
      // Stats count positions, not the agent row. The reader gives one entry for each id it is
      // asked for, so the fallback below is the same zero result that reader gives an agent
      // with no positions.
      stats: stats.get(house.id) ?? { all: emptyStats(), last24h: emptyStats(), contest: emptyStats() },
      scan: scanOf(signal, now),
      watching: watchingOf(signal, now),
      open: openOf(open[index] ?? []),
    };
  });
  return {
    version: HOUSE_BOARD_VERSION,
    agents,
    contest: { startsAt: FLOOR_ARENA_CONTEST.startsAt, endsAt: FLOOR_ARENA_CONTEST.endsAt },
    generatedAt: now.toISOString(),
  };
}

// ─── The newest scan + pass per house agent (one SQL read) ─────────────────

/**
 * One LATERAL read per agent on the `(agent_id, id desc)` index. The id floor
 * `lo` is the first event at or after `since` (the `at` index), so an agent
 * with no recent scan or pass never walks its full event history. The
 * freshness rules (15 min, 10 min) are applied after the read.
 */
export function houseSignalsSql(agentIds: readonly string[], since: Date): SQL {
  const ids = sql.join(agentIds.map((id) => sql`(${id})`), sql`, `);
  return sql`
    WITH bound AS (
      SELECT COALESCE(
        (SELECT id FROM floor_arena_events WHERE at >= ${since.toISOString()}::timestamptz ORDER BY at ASC LIMIT 1),
        9223372036854775807
      ) AS lo
    )
    SELECT a.id AS agent_id, s.at AS scan_at, s.data AS scan_data, p.at AS pass_at, d.symbol AS pass_symbol
    FROM (VALUES ${ids}) AS a(id)
    CROSS JOIN bound
    LEFT JOIN LATERAL (
      SELECT e.at, e.data FROM floor_arena_events e
      WHERE e.agent_id = a.id AND e.type = 'scan' AND e.id >= bound.lo
      ORDER BY e.id DESC LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT e.at, e.mint FROM floor_arena_events e
      WHERE e.agent_id = a.id AND e.type = 'pass' AND e.id >= bound.lo
      ORDER BY e.id DESC LIMIT 1
    ) p ON true
    LEFT JOIN floor_discovery_mints d ON d.mint = p.mint
  `;
}

export function mapHouseSignalRow(row: Record<string, unknown>): ArenaHouseSignals {
  return {
    scanAt: isoOrNull(row.scan_at),
    scanData: jsonOrNull(row.scan_data),
    passAt: isoOrNull(row.pass_at),
    passSymbol: sanitizeArenaSymbol(row.pass_symbol),
  };
}

export async function readArenaHouseSignals(agentIds: readonly string[], now: Date): Promise<Map<string, ArenaHouseSignals>> {
  if (agentIds.length === 0) return new Map();
  const since = new Date(now.getTime() - SIGNAL_LOOKBACK_MS);
  const result = await db.execute<Record<string, unknown>>(houseSignalsSql(agentIds, since));
  return new Map(rowsOf<Record<string, unknown>>(result).map((row) => [String(row.agent_id), mapHouseSignalRow(row)]));
}
