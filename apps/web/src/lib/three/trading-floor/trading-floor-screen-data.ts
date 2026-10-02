/**
 * trading-floor-screen-data.ts
 *
 * Turns the two queries the big board reads into the drawable shape
 * `drawFloorScreen` needs, plus the redraw signature (P15 T2, plan
 * `ops/house-traders/arena-review/P15_PLAN_2026-10-02.md` §1):
 *
 *   - the house board, `GET /api/floor/arena/house-board`, through the T1 hook
 *     `hooks/use-floor-arena-house-board.ts` (five columns, house order);
 *   - the contest, `GET /api/floor/arena/contest`, through the existing hook,
 *     ONLY as the fallback contest window (the house board carries its own).
 *
 * Kept apart from `trading-floor-screen-texture.ts` so the drawing code stays
 * free of app types, and apart from the React component so both halves are
 * unit-testable. Every input is typed `unknown` and read BY KEY: the hooks'
 * readers are a convenience, not the board's correctness boundary. The only
 * value imports are `@clawville/shared` constants and the pure tape module;
 * nothing from the hooks module (react-query, the wallet adapter) reaches the
 * 3D scene chunk through this file.
 *
 * WHAT IS DELIBERATELY NOT CARRIED ACROSS: `generatedAt`, every event `at`
 * (scan, watching, `openedAt`), `paramsVersion`, `held`, `sizeUsd`, the `all`
 * window, `trades`, `deaths`, `openPositions` and `lastTradeAt`. The board does
 * not draw them, and the ones that tick would repaint the whole board every
 * poll for identical pixels. The countdown and the P&L window come from the
 * contest window and the scene's 30 s clock instead.
 */

import {
  FLOOR_ARENA_HOUSE_AGENTS,
  FLOOR_ARENA_MAX_OPEN_POSITIONS,
  FLOOR_ARENA_PAPER_COSTS,
  FLOOR_ARENA_PARAM_BOUNDS,
  FLOOR_ARENA_POSITION_USD,
  type FloorArenaBound,
  type FloorArenaHouseAgent,
} from '@clawville/shared';

import {
  FLOOR_SCREEN_COIN_WORD,
  type FloorScreenBasis,
  type FloorScreenColumn,
  type FloorScreenData,
  type FloorScreenExits,
  type FloorScreenScan,
  type FloorScreenWindow,
} from './trading-floor-screen-texture';
import {
  classifyArenaTapeItem,
  readArenaTape,
  tapeSymbol,
  tapeTraderName,
  type ArenaTapeItem,
} from './trading-floor-trade-tape';

/** What the board needs from one react-query result. A `UseQueryResult` is
 *  assignable as it stands, so the component passes the results in. */
export interface ArenaQueryInput {
  readonly data: unknown;
  readonly isLoading: boolean;
  readonly isError: boolean;
}

export interface FloorScreenInputs {
  /** The T1 house-board query. Absent reads as never fetched (connecting). */
  readonly houseBoard?: ArenaQueryInput;
  /** The contest query: the fallback contest window. */
  readonly contest: ArenaQueryInput;
  /**
   * COMPATIBILITY ONLY, removed with plan request W5: the room owner's
   * `trading-floor-decor.test.ts` still calls
   * `buildFloorScreenData({ leaderboard, contest, tape }, now).tape`. `tape`
   * feeds only the `tape` result field, which the board does not draw and the
   * signature does not read; `leaderboard` is ignored.
   */
  readonly tape?: ArenaQueryInput;
  readonly leaderboard?: ArenaQueryInput;
}

/** The board data plus the tape lines kept for the decor test (W5). */
export type FloorScreenBuild = FloorScreenData & { readonly tape: readonly string[] };

const NEVER_FETCHED: ArenaQueryInput = Object.freeze({
  data: undefined,
  isLoading: true,
  isError: false,
});

/** Newest N entries of the compatibility tape. */
const BOARD_TAPE_LIMIT = 12;

/** The symbol part of a column line: "WATCH " + 8 fits the 14-character budget. */
const SYMBOL_CHARS = 8;

/**
 * The footer and the open count, from the constants the ENGINE runs on. Not
 * re-typed: the wall cannot state a method the engine has stopped using.
 * `maxOpen` is the platform cap (lead decision 2026-10-02): the house-board
 * payload carries no live `max_open`, and no agent can hold more than the cap.
 */
const BASIS: FloorScreenBasis = Object.freeze({
  positionUsd: FLOOR_ARENA_POSITION_USD,
  buyCostPct: FLOOR_ARENA_PAPER_COSTS.buy_haircut_pct,
  sellCostPct: FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct,
  maxOpen: FLOOR_ARENA_MAX_OPEN_POSITIONS,
});

// ── time ────────────────────────────────────────────────────────────────────

/**
 * The only times this board will reason about: after the epoch and before 2100.
 * Deliberately PLAUSIBILITY, not representability: the expanded `±YYYYYY` year
 * form shifts `slice(11, 16)` to "13T00", and age arithmetic on an absurd time
 * reports "99979284D" with a straight face. It bounds the contest timestamps
 * too: they come from the API, and `Date.parse('+275760-09-13T00:00:00.000Z')`
 * is finite.
 */
const MAX_PLAUSIBLE_TIME_MS = 4102444800000; // 2100-01-01T00:00:00.000Z, exclusive

function isPlausibleTime(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0 && ms < MAX_PLAUSIBLE_TIME_MS;
}

/** ONE definition of "the clock is usable", read by the clock, the countdown,
 *  the P&L window and the tape ages. */
function isUsableClock(nowMs: number): boolean {
  return isPlausibleTime(nowMs);
}

/** Clock skew we forgive on a trade timestamp (compatibility tape only). */
const FUTURE_SKEW_MS = 60_000;

function isDatableTradeTime(atMs: number, nowMs: number): boolean {
  return isPlausibleTime(atMs) && atMs <= nowMs + FUTURE_SKEW_MS;
}

/** Length of the ordinary `YYYY-MM-DDTHH:mm:ss.sssZ` form. */
const ISO_LENGTH = 24;

/**
 * Header clock, UTC and minute-resolution. `toISOString` rather than a locale
 * format: the wall must not depend on the machine, and the scene redraws on a
 * 30 s tick, so the reading is minute-grained anyway.
 */
export function floorClockLabel(nowMs: number): string {
  // The length check is an ASSERTION of the plausibility bound: `slice(11, 16)`
  // is only correct for the ordinary 24-character form.
  if (!isUsableClock(nowMs)) return 'CLOCK OFFLINE';
  const iso = new Date(nowMs).toISOString();
  return iso.length === ISO_LENGTH ? `${iso.slice(11, 16)} UTC` : 'CLOCK OFFLINE';
}

/** Tape-width age: "NOW", "4M", "2H", "3D" (compatibility tape only). */
function shortAge(atMs: number | null, nowMs: number): string {
  if (atMs === null) return 'RECENT';
  if (!isUsableClock(nowMs) || !isDatableTradeTime(atMs, nowMs)) return 'TIME UNKNOWN';
  const ageMs = Math.max(0, nowMs - atMs);
  if (ageMs < 60_000) return 'NOW';
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}M`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}H`;
  return `${Math.floor(ageMs / 86_400_000)}D`;
}

function span(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return 'UNDER 1M';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}D ${pad(hours)}H ${pad(minutes)}M`;
  if (hours > 0) return `${hours}H ${pad(minutes)}M`;
  return `${minutes}M`;
}

/**
 * "STARTS IN 3H 12M", "ENDS IN 4D 03H 12M", "CONTEST ENDED", or null. Minute
 * resolution (lead decision 2026-10-02: the countdown keeps its minutes) and
 * FLOORED, so it can run behind the true time but never ahead of it. Null when
 * the clock or either end of the window is unusable, or the window is inverted.
 */
export function contestCountdownLabel(
  startsAtMs: number | null,
  endsAtMs: number | null,
  nowMs: number,
): string | null {
  if (startsAtMs === null || endsAtMs === null || endsAtMs <= startsAtMs) return null;
  if (!isUsableClock(nowMs)) return null;
  if (nowMs < startsAtMs) return `STARTS IN ${span(startsAtMs - nowMs)}`;
  if (nowMs <= endsAtMs) return `ENDS IN ${span(endsAtMs - nowMs)}`;
  return 'CONTEST ENDED';
}

// ── readers ─────────────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return isPlausibleTime(ms) ? ms : null;
}

/** Money: null when nothing was sent ("-"), NaN when it is not a finite number ("N/A"). */
function money(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

/** A count: a non-negative safe integer, else NaN ("-"). A numeric STRING is refused. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : Number.NaN;
}

/**
 * An exit parameter inside its bound (`FLOOR_ARENA_PARAM_BOUNDS`), null when
 * OFF, NaN when unreadable or outside the bound (it prints N/A, never a figure
 * no rule allows).
 */
function bounded(value: unknown, bound: FloorArenaBound): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= bound.min && value <= bound.max
    ? value
    : Number.NaN;
}

/** A coin symbol as the board may print it: masked or unreadable -> COIN. */
function boardSymbol(raw: unknown, masked: unknown): string {
  if (masked === true) return FLOOR_SCREEN_COIN_WORD;
  // The tape's symbol rule: no `$`, no decimal number, no 5+ digit run, cut first.
  const shown = tapeSymbol(typeof raw === 'string' ? raw : null, SYMBOL_CHARS);
  return shown.length > 0 ? shown : FLOOR_SCREEN_COIN_WORD;
}

function readExits(value: unknown): FloorScreenExits | null {
  const exits = record(value);
  if (!exits) return null;
  const bounds = FLOOR_ARENA_PARAM_BOUNDS.exits;
  return {
    tpMult: bounded(exits.tpMult, bounds.tp_multiple),
    stopMult: bounded(exits.stopMult, bounds.stop_mult),
    maxHoldS: bounded(exits.maxHoldS, bounds.max_hold_s),
  };
}

function readScan(value: unknown): FloorScreenScan | null {
  const scan = record(value);
  if (!scan) return null;
  const top = Array.isArray(scan.topSkip) ? record(scan.topSkip[0]) : null;
  return {
    evaluated: count(scan.evaluated),
    passed: count(scan.passed),
    topSkipCode: typeof top?.code === 'string' && top.code.length > 0 ? top.code : null,
  };
}

interface WindowStats {
  readonly realisedUsd: number | null;
  readonly wins: number;
  readonly losses: number;
}

function readWindowStats(stats: Record<string, unknown> | null, key: string): WindowStats {
  const slice = record(stats?.[key]);
  return {
    realisedUsd: money(slice?.realisedUsd),
    wins: count(slice?.wins),
    losses: count(slice?.losses),
  };
}

/** A column with BOTH P&L windows; the clock picks one in `buildFloorScreenData`. */
type ProjectedColumn = Omit<FloorScreenColumn, keyof WindowStats> & {
  readonly contest: WindowStats;
  readonly last24h: WindowStats;
};

function readColumn(house: FloorArenaHouseAgent, raw: Record<string, unknown> | null): ProjectedColumn {
  const mode = raw?.mode === 'paper' || raw?.mode === 'live' ? raw.mode : null;
  const status =
    raw?.status === 'active' || raw?.status === 'paused' || raw?.status === 'stopped'
      ? raw.status
      : null;
  // The payload's rule: a missing house row has null mode and status. Every
  // live figure of such a column prints N/A or "-", never a zero.
  const known = mode !== null || status !== null;
  const open = known && Array.isArray(raw?.open) ? raw.open.slice(0, FLOOR_ARENA_MAX_OPEN_POSITIONS) : null;
  const first = open ? record(open[0]) : null;
  const watching = known ? record(raw?.watching) : null;
  const stats = known ? record(raw?.stats) : null;
  const name = typeof raw?.name === 'string' && raw.name.length > 0 ? raw.name : house.name;
  return {
    name,
    templateId: house.templateId,
    mode,
    status,
    known,
    exits: known ? readExits(raw?.exits) : null,
    scan: known ? readScan(raw?.scan) : null,
    watching: watching ? { symbol: boardSymbol(watching.symbol, watching.masked) } : null,
    openCount: open ? open.length : Number.NaN,
    newest: first
      ? {
          symbol: boardSymbol(first.symbol, first.masked),
          // No mark yet is no figure: N/A, not 1.00X.
          markMult: money(first.lastMarkMult) ?? Number.NaN,
        }
      : null,
    contest: readWindowStats(stats, 'contest'),
    last24h: readWindowStats(stats, 'last24h'),
  };
}

/**
 * Five columns in `FLOOR_ARENA_HOUSE_AGENTS` order (= `FLOOR_ARENA_TEMPLATES`
 * order), whatever order the wire used. A house agent the wire did not send
 * keeps its name and template with every live field unknown.
 */
function readColumns(data: unknown): ProjectedColumn[] {
  const agents = record(data)?.agents;
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of Array.isArray(agents) ? agents : []) {
    const row = record(item);
    const id = typeof row?.id === 'string' ? row.id : null;
    if (row && id && !byId.has(id)) byId.set(id, row);
  }
  return FLOOR_ARENA_HOUSE_AGENTS.map((house) => readColumn(house, byId.get(house.id) ?? null));
}

interface ContestWindow {
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

/** `{ contest: { startsAt, endsAt } }` (both hooks) or a flattened view. */
function readContestWindow(data: unknown): ContestWindow | null {
  const outer = record(data);
  if (!outer) return null;
  const contest = record(outer.contest) ?? outer;
  const startsAtMs = isoMs(contest.startsAt);
  const endsAtMs = isoMs(contest.endsAt);
  return startsAtMs !== null && endsAtMs !== null && endsAtMs > startsAtMs
    ? { startsAtMs, endsAtMs }
    : null;
}

// ── projection: ONE list of what the board draws ────────────────────────────

/**
 * EVERYTHING the board draws, minus the clock. Consumed by the drawable builder
 * AND by the redraw signature, so the trigger cannot forget a field the draw
 * starts showing. Both P&L windows are in it: the clock picks one, and the
 * scene's 30 s tick repaints when it flips.
 *
 * ONE RULE FOR THE WHOLE ROOM (lead, 2026-10-01): a failed refetch keeps the
 * LAST GOOD data (react-query keeps `data` through an error), and only a query
 * that has NEVER had data shows "ARENA DATA UNAVAILABLE". `isError` is not read
 * for a query that has data, so an error alone costs no redraw.
 *
 * ONE CONTEST WINDOW (lead decision 2026-10-02): the house board's own window
 * first, because the server computed `stats.contest` over it; the contest hook
 * second. The countdown and the P&L window read the same one.
 */
function project(inputs: FloorScreenInputs) {
  const board = inputs.houseBoard ?? NEVER_FETCHED;
  const phase: FloorScreenData['phase'] =
    board.data !== undefined ? 'ready' : board.isError ? 'error' : 'connecting';
  return {
    phase,
    columns: phase === 'ready' ? readColumns(board.data) : [],
    window: readContestWindow(board.data) ?? readContestWindow(inputs.contest.data),
  };
}

function contestRunning(window: ContestWindow | null, nowMs: number): boolean {
  return (
    window !== null &&
    isUsableClock(nowMs) &&
    nowMs >= window.startsAtMs &&
    nowMs <= window.endsAtMs
  );
}

function tapeLine(item: ArenaTapeItem, nowMs: number): string {
  const face = classifyArenaTapeItem(item);
  return [tapeTraderName(item.agentName), face.action, face.amount, shortAge(item.atMs, nowMs)]
    .filter((part) => part.length > 0)
    .join(' ');
}

export function buildFloorScreenData(inputs: FloorScreenInputs, nowMs: number): FloorScreenBuild {
  const projected = project(inputs);
  const running = contestRunning(projected.window, nowMs);
  const windowKey: FloorScreenWindow = running ? 'contest' : '24h';
  return {
    phase: projected.phase,
    columns: projected.columns.map(({ contest, last24h, ...column }) => ({
      ...column,
      ...(running ? contest : last24h),
    })),
    window: windowKey,
    countdownLabel: projected.window
      ? contestCountdownLabel(projected.window.startsAtMs, projected.window.endsAtMs, nowMs)
      : null,
    clockLabel: floorClockLabel(nowMs),
    basis: BASIS,
    tape: inputs.tape
      ? readArenaTape(inputs.tape.data)
          .slice(0, BOARD_TAPE_LIMIT)
          .map((item) => tapeLine(item, nowMs))
      : [],
  };
}

/**
 * A stable string that changes exactly when something the board DRAWS changes,
 * apart from the clock. `nowMs` is not in it, and neither is any field that
 * ticks on its own, so a poll that changed nothing costs no canvas redraw and
 * no texture upload. NaN is kept apart from null ("N/A" against "-"):
 * `JSON.stringify` would print both as `null`.
 */
export function floorScreenSignature(inputs: FloorScreenInputs): string {
  return JSON.stringify(project(inputs), (_key, value: unknown) =>
    typeof value === 'number' && !Number.isFinite(value) ? String(value) : value,
  );
}
