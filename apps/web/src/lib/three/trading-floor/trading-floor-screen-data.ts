/**
 * trading-floor-screen-data.ts
 *
 * Turns the three Trading Arena queries the big board reads —
 * `GET /api/floor/arena/leaderboard?window=contest`, `GET /api/floor/arena/contest`
 * and `GET /api/floor/arena/tape` — into the small, drawable shape
 * `drawFloorScreen` needs, plus the redraw signature.
 *
 * Kept apart from `trading-floor-screen-texture.ts` so the drawing code stays
 * free of app types, and apart from the React component so both halves are
 * unit-testable. Every input is typed `unknown` and read BY KEY: the hooks'
 * normalisers are a convenience for the panel, not the board's correctness
 * boundary, and a field that is not the type the board draws never reaches it.
 * The only value imports are `@clawville/shared` constants and the pure tape
 * module; nothing from the hooks module (react-query, the wallet adapter)
 * reaches the 3D scene chunk through this file.
 *
 * WHAT IS DELIBERATELY NOT CARRIED ACROSS:
 *   - `agentId`. An identifier never goes on the board, and a name that EQUALS
 *     the id (the panel hook's fallback for a missing name) is treated as no
 *     name at all.
 *   - `lastTradeAt`, `deaths`. The table has no column for them.
 *   - Any mint. The tape reader never reads it; only the route's `symbol`
 *     names a token, after the address strip.
 *   - `secondsLeft` / `generatedAt` on the contest body. They tick on every
 *     request, and a ticking field in the signature repaints the whole board
 *     every poll for identical pixels. The countdown is derived from
 *     `startsAt` / `endsAt` and the scene's 30 s clock instead.
 */

import {
  FLOOR_ARENA_PAPER_COSTS,
  FLOOR_ARENA_POSITION_USD,
  floorArenaTemplateById,
} from '@clawville/shared';

import {
  FLOOR_SCREEN_MAX_ROWS,
  type FloorScreenBasis,
  type FloorScreenData,
  type FloorScreenPrize,
  type FloorScreenRow,
  type FloorScreenRowTag,
} from './trading-floor-screen-texture';
import {
  classifyArenaTapeItem,
  readArenaTape,
  tapeTraderName,
  type ArenaTapeItem,
} from './trading-floor-trade-tape';

/** What the board needs from one react-query result. A `UseQueryResult` is
 *  assignable as it stands, so the component passes the three results in. */
export interface ArenaQueryInput {
  readonly data: unknown;
  readonly isLoading: boolean;
  readonly isError: boolean;
}

export interface FloorScreenInputs {
  readonly leaderboard: ArenaQueryInput;
  readonly contest: ArenaQueryInput;
  readonly tape: ArenaQueryInput;
}

/** Newest N entries on the board's bottom row. The row truncates at 95
 *  characters (about three entries) anyway; this only bounds the work. */
const BOARD_TAPE_LIMIT = 12;

/**
 * The method line, from the constants the ENGINE runs on. Not re-typed here:
 * the board's "$20 PER POSITION" and "2.5% BUY + 1% SELL COSTS" are the same
 * numbers the paper fills use, so the wall cannot state a method the engine
 * has stopped using.
 */
const BASIS: FloorScreenBasis = Object.freeze({
  positionUsd: FLOOR_ARENA_POSITION_USD,
  buyCostPct: FLOOR_ARENA_PAPER_COSTS.buy_haircut_pct,
  sellCostPct: FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct,
});

/** The one prize token the board will name. A prize in any other token is not
 *  a claim the board makes, so the whole prize line is dropped instead. */
const PRIZE_TOKEN = '$CLAWVILLE';

// ── time ────────────────────────────────────────────────────────────────────

/**
 * The only times this board will reason about: after the epoch and before 2100.
 *
 * Deliberately PLAUSIBILITY, not representability. The ECMAScript max time
 * value (8.64e15) only stops `toISOString` from throwing and leaves two silent
 * wrongs behind it: the expanded `±YYYYYY` year form, whose extra three
 * characters shift `slice(11, 16)` to "13T00", and age arithmetic that reports
 * "99979284D" with a straight face. Neither is an error anywhere. Both would be
 * painted on a wall in the game world.
 *
 * It bounds the TRADE and CONTEST timestamps too, not just the clock: they come
 * from the API, and `Date.parse('+275760-09-13T00:00:00.000Z')` is finite.
 */
const MAX_PLAUSIBLE_TIME_MS = 4102444800000; // 2100-01-01T00:00:00.000Z, exclusive

function isPlausibleTime(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0 && ms < MAX_PLAUSIBLE_TIME_MS;
}

/**
 * ONE definition of "the clock is usable", read by the header clock, the
 * countdown and the tape age.
 *
 * It exists because they fail differently on the same bad input and only one
 * of those failures is loud: an unusable `nowMs` makes `toISOString` throw, but
 * it makes the age arithmetic produce `NaN`, and `${Math.floor(NaN / 60_000)}M`
 * is the string "NaNM" — which is not an error anywhere, it is just painted on
 * the wall.
 */
function isUsableClock(nowMs: number): boolean {
  return isPlausibleTime(nowMs);
}

/** Clock skew we will forgive on a trade timestamp. Server time and our clock
 *  disagree by SECONDS, so 60 s is already generous; the bound is RELATIVE to
 *  the clock, which is the only way a plausible-looking 2099 is caught. */
const FUTURE_SKEW_MS = 60_000;

/**
 * A trade time we will DATE: plausible, and not in the future. A future time
 * clamps to zero age through `Math.max(0, …)` and would read "NOW" — a board
 * claiming an agent had just traded, reached through arithmetic.
 */
function isDatableTradeTime(atMs: number, nowMs: number): boolean {
  return isPlausibleTime(atMs) && atMs <= nowMs + FUTURE_SKEW_MS;
}

/** Length of the ordinary `YYYY-MM-DDTHH:mm:ss.sssZ` form. The expanded
 *  `±YYYYYY` year form is 27 and every index after the year moves. */
const ISO_LENGTH = 24;

/**
 * Header clock, UTC and minute-resolution.
 *
 * `toISOString` rather than `toLocaleTimeString`: the board is redrawn from the
 * scene's 30 s tick, so the reading is already minute-grained, and a locale
 * format would vary by machine — including between a test runner and a browser.
 */
export function floorClockLabel(nowMs: number): string {
  // `isUsableClock` already bounds this to 1970-2100, so the length check
  // below cannot fire today. It stays as an ASSERTION of that bound: the
  // `slice(11, 16)` offsets are only correct for the ordinary 24-character
  // form, and a widened bound would return the expanded `±YYYYYY` form, whose
  // slice reads "13T00" — a string that looks like a time on a wall.
  if (!isUsableClock(nowMs)) return 'CLOCK OFFLINE';
  const iso = new Date(nowMs).toISOString();
  return iso.length === ISO_LENGTH ? `${iso.slice(11, 16)} UTC` : 'CLOCK OFFLINE';
}

/** Tape-width age: "NOW", "4M", "2H", "3D". */
function shortAge(atMs: number | null, nowMs: number): string {
  // RECENT = we never had a time and the feed vouches for recency. TIME
  // UNKNOWN = we had inputs and could not produce a trustworthy reading.
  // Falling back to RECENT after a failed reading would present a substitute
  // for a reading we could not make, and on the tape it sits in the same
  // column as "4M", where it reads as "moments ago". (tf3d-audit, 2026-09-19.)
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
 * "STARTS IN 3H 12M", "ENDS IN 4D 03H 12M", "CONTEST ENDED", or null.
 *
 * Minute resolution and FLOORED, like any countdown: the board redraws every
 * 30 s, so it can be up to half a minute behind, never ahead. Null — nothing
 * drawn — when the clock or either end of the window is unusable, or the
 * window is inverted: a countdown to a guessed time is worse than none.
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

/**
 * A finite NUMBER, or NaN. Not 0: every figure on this board is a claim, and
 * the formatters print NaN as `N/A` (money) or `-` (counts). A numeric STRING
 * is refused on purpose, as it was on the house-trader board: the route sends
 * numbers, and a string where a number belongs means we cannot vouch for it.
 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return isPlausibleTime(ms) ? ms : null;
}

/** A drawable row plus its `kind`, which only the call to action reads. */
interface ReadRow {
  readonly kind: 'house' | 'user' | null;
  readonly row: FloorScreenRow;
}

function readRow(raw: unknown): ReadRow | null {
  const wire = record(raw);
  if (!wire) return null;
  const kind = wire.kind === 'house' || wire.kind === 'user' ? wire.kind : null;
  const agentId = typeof wire.agentId === 'string' ? wire.agentId : '';
  const rawName = typeof wire.name === 'string' ? wire.name : '';
  const templateId = typeof wire.templateId === 'string' ? wire.templateId : '';
  const rank = num(wire.rank);
  const tag: FloorScreenRowTag =
    kind === 'house' ? 'house' : kind === 'user' && wire.eligible === false ? 'no-prize' : null;
  return {
    kind,
    row: {
      // The panel hook maps a missing rank to 0; "#0" is not a place.
      rank: rank >= 1 ? rank : Number.NaN,
      name: rawName === agentId ? '' : rawName,
      tag,
      template: floorArenaTemplateById(templateId)?.displayName ?? templateId,
      realisedUsd: num(wire.realisedUsd),
      trades: num(wire.trades),
      wins: num(wire.wins),
      // The route's `losses` (closes with `pnl_usd < 0`) and NOTHING derived.
      // `trades - wins` looked exact and is not: `trades` counts a zero-P&L
      // close too, which the tape calls flat, so one flat close would read
      // "0/1" here beside a slate chip (Codex review round 2). Absent prints
      // "-".
      losses: num(wire.losses),
      openPositions: num(wire.openPositions),
    },
  };
}

/** Every readable row, in rank order. Accepts the bare array the panel hook
 *  returns or the route's `{ rows }` envelope. */
function readLeaderboard(data: unknown): ReadRow[] {
  const list: unknown = Array.isArray(data) ? data : record(data)?.rows;
  if (!Array.isArray(list)) return [];
  const rows = list
    .map(readRow)
    .filter((read): read is ReadRow => read !== null);
  // Stable, and an unreadable rank sorts LAST rather than first: the route's
  // own order is kept among ties and among the unranked.
  const order = (read: ReadRow) => (Number.isFinite(read.row.rank) ? read.row.rank : Infinity);
  return rows.sort((a, b) => {
    const delta = order(a) - order(b);
    // Infinity - Infinity is NaN; two unranked rows keep the route's order.
    return Number.isNaN(delta) ? 0 : delta;
  });
}

interface ProjectedContest {
  readonly title: string;
  readonly startsAtMs: number | null;
  readonly endsAtMs: number | null;
  readonly prizes: readonly FloorScreenPrize[];
}

/**
 * The contest header. Reads the route's nested `contest` block or a flattened
 * view, so a panel hook that flattens it does not blank the header.
 *
 * Prizes are ALL-OR-NOTHING: one prize in an unknown token, or with an
 * unreadable place or amount, drops the whole line. A partial prize line would
 * state the places the board happens to read and silently lose the rest.
 */
function readContest(data: unknown): ProjectedContest | null {
  const outer = record(data);
  if (!outer) return null;
  const contest = record(outer.contest) ?? outer;
  const prizes: FloorScreenPrize[] = [];
  let prizesReadable = Array.isArray(contest.prizes) && contest.prizes.length > 0;
  if (prizesReadable) {
    for (const raw of contest.prizes as unknown[]) {
      const prize = record(raw);
      const place = num(prize?.place);
      const amount = num(prize?.amount);
      if (
        !prize ||
        prize.token !== PRIZE_TOKEN ||
        !Number.isInteger(place) ||
        place < 1 ||
        !(amount > 0)
      ) {
        prizesReadable = false;
        break;
      }
      prizes.push({ place, amount });
    }
  }
  return {
    title: typeof contest.name === 'string' ? contest.name : '',
    startsAtMs: isoMs(contest.startsAt),
    endsAtMs: isoMs(contest.endsAt),
    prizes: prizesReadable ? prizes.sort((a, b) => a.place - b.place) : [],
  };
}

// ── projection: ONE list of what the board draws ────────────────────────────

/**
 * EVERYTHING the board draws, minus the clock. Consumed by the drawable
 * builder AND by the redraw signature, so the trigger cannot forget a field
 * the draw starts showing (derived, not enumerated: two hand-kept lists are
 * how the house-trader board's realised block and tape once repainted late).
 *
 * The clock is the ONE input left out, deliberately: the countdown and the
 * tape ages move with it, and the scene's 30 s tick repaints for those.
 *
 * ONE RULE FOR THE WHOLE ROOM (lead, 2026-10-01): a failed refetch keeps the
 * LAST GOOD data — react-query keeps `data` through an error, and the 3D tape
 * and the floor status label already draw it — and only a query that has
 * NEVER had data shows "ARENA DATA UNAVAILABLE" / "STANDING BY". The board used
 * to clear its table and tape row on any error while the 3D tape kept its
 * chips, so the room gave two answers for one feed. `isError` is therefore not
 * read for a query that has data, which also means an error alone moves
 * nothing in this projection and costs no redraw.
 */
function project(inputs: FloorScreenInputs) {
  const board = inputs.leaderboard;
  const phase: FloorScreenData['phase'] =
    board.data !== undefined ? 'ready' : board.isError ? 'error' : 'connecting';
  const all = phase === 'ready' ? readLeaderboard(board.data) : [];
  return {
    phase,
    rows: all.slice(0, FLOOR_SCREEN_MAX_ROWS).map((read) => read.row),
    // Over the WHOLE board, not the drawn slice: a player ranked 40th still
    // means the arena has players, and the call to action would be false.
    hasPlayerAgents: all.some((read) => read.kind === 'user'),
    contest: readContest(inputs.contest.data),
    // Undefined (never fetched) reads as an empty tape; a failed refetch keeps
    // the last good rows, exactly as the 3D tape keeps its chips.
    tape: readArenaTape(inputs.tape.data).slice(0, BOARD_TAPE_LIMIT),
  };
}

function tapeLine(item: ArenaTapeItem, nowMs: number): string {
  const face = classifyArenaTapeItem(item);
  return [tapeTraderName(item.agentName), face.action, face.amount, shortAge(item.atMs, nowMs)]
    .filter((part) => part.length > 0)
    .join(' ');
}

export function buildFloorScreenData(
  inputs: FloorScreenInputs,
  nowMs: number,
): FloorScreenData {
  const projected = project(inputs);
  const contest = projected.contest;
  return {
    phase: projected.phase,
    rows: projected.rows,
    hasPlayerAgents: projected.hasPlayerAgents,
    contest: contest
      ? {
          title: contest.title,
          countdownLabel: contestCountdownLabel(contest.startsAtMs, contest.endsAtMs, nowMs),
          prizes: contest.prizes,
        }
      : null,
    basis: BASIS,
    clockLabel: floorClockLabel(nowMs),
    tape: projected.tape.map((item) => tapeLine(item, nowMs)),
  };
}

/**
 * A stable string that changes exactly when something the board DRAWS changes,
 * apart from the clock. The redraw trigger: `nowMs` is not in it, and neither
 * is any field that ticks on its own (`secondsLeft`, `generatedAt`), so a poll
 * that changed nothing costs no canvas redraw and no texture upload.
 */
export function floorScreenSignature(inputs: FloorScreenInputs): string {
  return JSON.stringify(project(inputs));
}
