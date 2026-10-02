'use client';

import { useQuery } from '@tanstack/react-query';
import { FLOOR_ARENA_HOUSE_AGENTS, type FloorArenaAgentStatus } from '@clawville/shared';

import { FloorArenaApiError, readStatsByWindow, type FloorArenaStatsByWindow } from '@/hooks/use-floor-arena';

// P15 T1: the web hook of GET /api/floor/arena/house-board, the five house-agent
// columns of the Trading Floor big screen (ops/house-traders/arena-review/P15_PLAN_2026-10-02.md §1).
// The board and the walk-up panel read it. A connected agent reads the same
// public route, so nothing here is the only way to see it.
//
// Reader rule (as in use-floor-arena.ts): a figure the wire did not send in a
// readable form is `null`, never a made-up 0. The view always holds five
// columns in FLOOR_ARENA_HOUSE_AGENTS order, so the board can index them.

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const PATH = '/api/floor/arena/house-board';

/** The board re-reads the route this often while the tab is visible (the server caches 10 s). */
export const FLOOR_ARENA_HOUSE_BOARD_POLL_MS = 15_000;

export const floorArenaHouseBoardKey = ['floor-arena', 'house-board'] as const;

export interface FloorArenaHouseBoardExits {
  /** First take-profit leg as a multiple (1.1 = +10%); null when off or unreadable. */
  tpMult: number | null;
  stopMult: number | null;
  maxHoldS: number | null;
}

export interface FloorArenaHouseBoardScan {
  at: string;
  evaluated: number | null;
  passed: number | null;
  held: number | null;
  topSkip: Array<{ code: string; count: number | null }>;
}

export interface FloorArenaHouseBoardWatching {
  at: string;
  /** `***` when the content mask hid it (then `masked` is true); null when unknown. */
  symbol: string | null;
  masked: boolean;
}

export interface FloorArenaHouseBoardOpen {
  symbol: string | null;
  openedAt: string | null;
  sizeUsd: number | null;
  lastMarkMult: number | null;
  masked: boolean;
}

export interface FloorArenaHouseBoardAgentView {
  id: string;
  name: string;
  templateId: string;
  /** From the agent row; null when the row is missing or unreadable (never a guess). */
  mode: 'paper' | 'live' | null;
  status: FloorArenaAgentStatus | null;
  paramsVersion: number | null;
  exits: FloorArenaHouseBoardExits | null;
  stats: FloorArenaStatsByWindow;
  /** Newest scan; null when older than 15 min or unreadable. */
  scan: FloorArenaHouseBoardScan | null;
  /** Newest coin that passed every rule; null when older than 10 min or unreadable. */
  watching: FloorArenaHouseBoardWatching | null;
  /** At most five open positions, newest first. */
  open: FloorArenaHouseBoardOpen[];
}

export interface FloorArenaHouseBoardView {
  agents: FloorArenaHouseBoardAgentView[];
  contest: { startsAt: string | null; endsAt: string | null };
  generatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Wire readers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A finite number, or null. A numeric string counts (Postgres `numeric` reaches JSON as a string). */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function countOrNull(value: unknown): number | null {
  const parsed = num(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readExits(value: unknown): FloorArenaHouseBoardExits | null {
  const row = record(value);
  if (!row) return null;
  return { tpMult: num(row.tpMult), stopMult: num(row.stopMult), maxHoldS: num(row.maxHoldS) };
}

function readScan(value: unknown): FloorArenaHouseBoardScan | null {
  const row = record(value);
  const at = str(row?.at);
  if (!row || !at) return null;
  const topSkip: FloorArenaHouseBoardScan['topSkip'] = [];
  for (const item of Array.isArray(row.topSkip) ? row.topSkip : []) {
    const entry = record(item);
    const code = str(entry?.code);
    if (entry && code) topSkip.push({ code, count: countOrNull(entry.count) });
  }
  return { at, evaluated: countOrNull(row.evaluated), passed: countOrNull(row.passed), held: countOrNull(row.held), topSkip };
}

function readWatching(value: unknown): FloorArenaHouseBoardWatching | null {
  const row = record(value);
  const at = str(row?.at);
  if (!row || !at) return null;
  return { at, symbol: str(row.symbol), masked: row.masked === true };
}

function readOpen(value: unknown): FloorArenaHouseBoardOpen | null {
  const row = record(value);
  if (!row) return null;
  return {
    symbol: str(row.symbol),
    openedAt: str(row.openedAt),
    sizeUsd: num(row.sizeUsd),
    lastMarkMult: num(row.lastMarkMult),
    masked: row.masked === true,
  };
}

function readMode(value: unknown): 'paper' | 'live' | null {
  return value === 'paper' || value === 'live' ? value : null;
}

function readStatus(value: unknown): FloorArenaAgentStatus | null {
  return value === 'active' || value === 'paused' || value === 'stopped' ? value : null;
}

/**
 * The route body as a view: five columns in FLOOR_ARENA_HOUSE_AGENTS order. A
 * column the wire did not send keeps its house id, name and template with
 * every live field null.
 */
export function readHouseBoard(body: unknown): FloorArenaHouseBoardView {
  const root = record(body) ?? {};
  const wire = new Map<string, Record<string, unknown>>();
  for (const item of Array.isArray(root.agents) ? root.agents : []) {
    const row = record(item);
    const id = str(row?.id);
    if (row && id && !wire.has(id)) wire.set(id, row);
  }
  const agents = FLOOR_ARENA_HOUSE_AGENTS.map((house): FloorArenaHouseBoardAgentView => {
    const row = wire.get(house.id) ?? {};
    const open: FloorArenaHouseBoardOpen[] = [];
    for (const item of Array.isArray(row.open) ? row.open : []) {
      const parsed = readOpen(item);
      if (parsed) open.push(parsed);
    }
    return {
      id: house.id,
      name: str(row.name) ?? house.name,
      templateId: house.templateId,
      mode: readMode(row.mode),
      status: readStatus(row.status),
      paramsVersion: countOrNull(row.paramsVersion),
      exits: readExits(row.exits),
      stats: readStatsByWindow(row.stats),
      scan: readScan(row.scan),
      watching: readWatching(row.watching),
      open: open.slice(0, 5),
    };
  });
  const contest = record(root.contest);
  return {
    agents,
    contest: { startsAt: str(contest?.startsAt), endsAt: str(contest?.endsAt) },
    generatedAt: str(root.generatedAt),
  };
}

// ---------------------------------------------------------------------------
// Fetcher + query
// ---------------------------------------------------------------------------

/** Same request and error style as use-floor-arena.ts: a refusal throws FloorArenaApiError (branch on code / status). */
export async function fetchFloorArenaHouseBoard(): Promise<FloorArenaHouseBoardView> {
  const response = await fetch(`${API_URL}${PATH}`, { method: 'GET', credentials: 'include' });
  const parsed = record(await response.json().catch(() => null)) ?? {};
  if (!response.ok) {
    const message = typeof parsed.error === 'string' ? parsed.error : `Request failed: ${response.status}`;
    throw new FloorArenaApiError(message, response.status, parsed.code, []);
  }
  return readHouseBoard(parsed);
}

export function floorArenaHouseBoardQueryOptions() {
  return {
    queryKey: floorArenaHouseBoardKey,
    queryFn: fetchFloorArenaHouseBoard,
    staleTime: FLOOR_ARENA_HOUSE_BOARD_POLL_MS,
    refetchInterval: FLOOR_ARENA_HOUSE_BOARD_POLL_MS,
    refetchIntervalInBackground: false,
  } as const;
}

/** The five house-agent columns. Polls every 15 s, only while the tab is visible. */
export function useFloorArenaHouseBoard(enabled: boolean) {
  return useQuery({ ...floorArenaHouseBoardQueryOptions(), enabled });
}
