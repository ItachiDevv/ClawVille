/**
 * trading-floor-screen-texture.ts
 *
 * The BIG BOARD on the Trading Floor's back wall, drawn into a 2D canvas that
 * the interior scene uploads as a `CanvasTexture`.
 *
 * Pure on purpose: no `three`, no React, no `fetch`. The scene owns the canvas,
 * the texture and the redraw schedule; this module only turns data into pixels.
 * That split is what lets `trading-floor-screen-texture.test.ts` drive the real
 * drawing code with a recording context and assert on every string that reaches
 * the board.
 *
 * ── WHAT THIS BOARD IS (P15 T2, 2026-10-02) ─────────────────────────────────
 * FIVE EQUAL HOUSE-AGENT COLUMNS, one per house agent in `FLOOR_ARENA_TEMPLATES`
 * order (founder 2026-10-01: "all trading on the big screen in the back of the
 * room"). Column i spans canvas x 204.8 i .. 204.8 (i + 1), so on the 2550 wu
 * board each column centre is an agent spot (x -1020, -510, 0, 510, 1020).
 * Each column, in priority order: name; mode pill + status; strategy words;
 * exit rule from the LIVE params; scan count; watching or top skip; open count;
 * newest open trade; realised P&L; wins / losses when a tenth line fits. A
 * smaller canvas drops lines from the END of that list and never shrinks the
 * font. A header ("HOUSE AGENTS · PAPER", countdown, UTC clock) and a footer
 * (how the figures are made) frame it. Plan:
 * `ops/house-traders/arena-review/P15_PLAN_2026-10-02.md` §1; lead decisions
 * of 2026-10-02 are pinned in the tests.
 *
 * It replaced the arena leaderboard board (player rows, prize line, tape row).
 * Players stay on the 3D tape, the LED ticker and the Exchange panel (Q2).
 *
 * ── THE RULES THAT CARRIED OVER ─────────────────────────────────────────────
 * PAPER IS SAID ON THE WALL: in the header, on each paper column's pill and in
 * the footer. A P&L figure a reader could take for real money is the one
 * dishonesty this board can commit while every number on it is correct.
 *
 * NUMBERS ARE NEVER TEXT. Every figure is formatted here from a TYPED field
 * (`formatSignedUsd`, `formatCount`, …) and drawn through `value()`; the
 * `BoardValue` brand makes any other path a compile error. The test greps this
 * source to prove no literal money figure is hard-coded in it — the $20
 * position and the cost percentages arrive as numbers from `@clawville/shared`.
 *
 * TEXT FROM OUTSIDE IS SANITISED AT THE DRAW SITE: names, symbols, the clock and
 * countdown labels pass `sanitiseScreenText` (through `cleaned`) here, so a
 * caller cannot route around it by building `FloorScreenData` by hand. A coin
 * symbol that is masked or unreadable prints COIN.
 *
 * LEGIBILITY FLOOR (P6, folded into P15): nothing is drawn below 22 canvas px
 * (`BOARD_MIN_PX`); names (up to 12 characters) and the P&L are 24 px, and
 * everything is BOLD. At about 0.52 screen px per canvas px from the spawn, a
 * 22 px bold capital is about 6.5 screen px (projection, not yet measured on
 * the resized room).
 */

import { TRADING_FLOOR_SCREEN } from './trading-floor-room';

export type FloorScreenMode = 'paper' | 'live';
export type FloorScreenStatus = 'active' | 'paused' | 'stopped';
/** Which stats window the P&L line shows: the contest while it runs, else 24 h. */
export type FloorScreenWindow = 'contest' | '24h';

/**
 * The exit rule of the LIVE params (the first take-profit leg). `null` is OFF
 * (no take-profit leg, no stop, no hold); NaN is a value we could not read or
 * that no parameter bound allows, and prints N/A.
 */
export interface FloorScreenExits {
  readonly tpMult: number | null;
  readonly stopMult: number | null;
  readonly maxHoldS: number | null;
}

export interface FloorScreenScan {
  /** Coins the newest scan looked at, and how many passed every rule. NaN = unreadable. */
  readonly evaluated: number;
  readonly passed: number;
  /** The engine code the most coins failed on (e.g. `liq`). Never drawn raw. */
  readonly topSkipCode: string | null;
}

export interface FloorScreenOpenTrade {
  /** Outside text; sanitised at draw time, COIN when it sanitises to nothing. */
  readonly symbol: string;
  /** Last mark as a multiple of the entry. NaN = no readable mark. */
  readonly markMult: number;
}

/**
 * One house-agent column, in DRAWABLE form. Every number may be NaN: the data
 * layer maps an unreadable field to NaN rather than to 0, and the formatters
 * print NaN as `N/A` or `-`. A zero would be a claim about the agent.
 */
export interface FloorScreenColumn {
  /** House name. Outside text, sanitised again at draw time. */
  readonly name: string;
  /** Picks the static strategy words. Never drawn. */
  readonly templateId: string;
  readonly mode: FloorScreenMode | null;
  readonly status: FloorScreenStatus | null;
  /**
   * False when the agent row is missing (mode and status both unknown). The
   * column then prints N/A or "-" for every live figure, never a zero.
   */
  readonly known: boolean;
  readonly exits: FloorScreenExits | null;
  /** Newest scan; null when there was none in the last 15 minutes. */
  readonly scan: FloorScreenScan | null;
  /** Newest coin that passed every rule; null when none in the last 10 minutes. */
  readonly watching: { readonly symbol: string } | null;
  /** Open positions (at most five). NaN when the row is missing. */
  readonly openCount: number;
  /** The newest open position; null when there is none. */
  readonly newest: FloorScreenOpenTrade | null;
  /** Realised P&L in the board's window. null = nothing to state ("-"), NaN = unreadable ("N/A"). */
  readonly realisedUsd: number | null;
  readonly wins: number;
  readonly losses: number;
}

/**
 * How the figures are made, as NUMBERS: the board composes the footer itself,
 * so it can only state a method that matches the constants the engine runs on.
 * `maxOpen` is the platform cap the open count is shown against.
 */
export interface FloorScreenBasis {
  readonly positionUsd: number;
  readonly buyCostPct: number;
  readonly sellCostPct: number;
  readonly maxOpen: number;
}

/**
 * The board ROTATES (founder order 2026-10-02): page A is the five house-agent
 * columns, page B the arena contest leaderboard, `FLOOR_SCREEN_PAGE_MS` each.
 * The page comes from the clock (`floorScreenPage` in the data module), so
 * there is no per-frame state; the scene's timer redraws on a page change.
 */
export type FloorScreenPage = 'house' | 'leaderboard';
export const FLOOR_SCREEN_PAGE_MS = 15_000;

/**
 * One contest-leaderboard row, DRAWABLE. NaN for any unreadable number (it
 * prints N/A or "-"); `name` is outside text, sanitised at draw time, and ""
 * when the route sent the agent id as the name.
 */
export interface FloorScreenLeaderRow {
  readonly rank: number;
  readonly name: string;
  readonly realisedUsd: number;
  readonly trades: number;
}

export interface FloorScreenLeaderboard {
  readonly phase: 'connecting' | 'error' | 'ready';
  /** Rank order, unranked last. Empty = "NO TRADERS YET", never fake rows. */
  readonly rows: readonly FloorScreenLeaderRow[];
}

export interface FloorScreenData {
  readonly phase: 'connecting' | 'error' | 'ready';
  /** Which page this redraw shows. */
  readonly page: FloorScreenPage;
  /** Five columns in house-agent order once ready; empty before the first data. */
  readonly columns: readonly FloorScreenColumn[];
  /** Page B. */
  readonly leaderboard: FloorScreenLeaderboard;
  readonly window: FloorScreenWindow;
  /**
   * Pre-formatted, e.g. "ENDS IN 4D 03H 12M". Null when either end of the
   * window is unreadable: a countdown to a guessed time is worse than none.
   */
  readonly countdownLabel: string | null;
  /**
   * Wall clock for the header, pre-formatted, e.g. "14:32 UTC". Passed in
   * rather than read here so the drawing stays pure and the test can pin it.
   */
  readonly clockLabel: string;
  readonly basis: FloorScreenBasis;
}

export interface FloorScreenSize {
  readonly width: number;
  readonly height: number;
}

/**
 * LOGICAL canvas size — the coordinate space every number below is written in.
 *
 * The backing store may be twice this on a high-DPR display (the scene scales
 * the context by `pickCanvasScale`), but the drawing code never learns that.
 *
 * DERIVED from `TRADING_FLOOR_SCREEN`, not re-typed: the plane geometry is the
 * natural owner, so the arrow points geometry → drawing. The column budget
 * below is laid out for a 1024 px width (plan request W1, pinned by a test);
 * the height sets how many column lines fit.
 */
export const FLOOR_SCREEN_CANVAS = Object.freeze({
  width: TRADING_FLOOR_SCREEN.canvasWidth,
  height: TRADING_FLOOR_SCREEN.canvasHeight,
});

/**
 * Backing-store multiplier for the canvas, capped at 2.
 *
 * Doubling the backing store halves the glyph-edge softness for roughly 4 MB
 * more GPU memory (a full `FLOOR_SCREEN_CANVAS` RGBA buffer, times four) and
 * one larger upload per redraw. The threshold is 1.5, not 2: Windows at 150%
 * scaling reports 1.5 and is exactly the desktop case where the extra texels
 * show. A 1.0 or 1.25 desktop — the Iris Xe floor — pays nothing.
 */
export function pickCanvasScale(devicePixelRatio: number): 1 | 2 {
  return Number.isFinite(devicePixelRatio) && devicePixelRatio >= 1.5 ? 2 : 1;
}

/**
 * The 2D surface the board needs. A structural subset of the DOM context, so
 * the real `CanvasRenderingContext2D` satisfies it and a recording fake in a
 * test can implement it in twenty lines.
 */
export type FloorScreenContext = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'globalAlpha'
  | 'fillRect'
  | 'strokeRect'
  | 'fillText'
>;

/**
 * Exported so the tests assert the colour DECISIONS (gain green, loss red,
 * muted for missing figures) instead of re-typing hex literals.
 */
export const COLOR = {
  background: '#050d16',
  headerBar: '#0b1a28',
  headerText: '#d7f2ff',
  label: '#e8f7ff',
  value: '#bfe9ff',
  muted: '#6d92ab',
  /** Accent rules. */
  live: '#3ddc97',
  /** The countdown and the strategy words. */
  prize: '#ffc457',
  divider: '#1d3b52',
  footerBar: '#081420',
  /** Mode pills. Light text on a mid-tone fill; dark text on the bright LIVE green. */
  paperPill: '#123a55',
  paperPillText: '#bfe9ff',
  livePill: '#3ddc97',
  livePillText: '#04130c',
  /** P&L up. */
  gain: '#3ddc97',
  /** P&L down. Losses are published as plainly as wins (founder, 2026-09-20). */
  drop: '#ff6b6b',
} as const;

// ── sanitisation ────────────────────────────────────────────────────────────

/**
 * Invisible characters. Stripped FIRST, and that order is the whole point: an
 * adversarial review of the first version showed `pro​fit` surviving the
 * token pass and only losing its zero-width space at the final
 * disallowed-character strip, which printed "PRO FIT" on the wall. Strip the
 * invisibles before anything looks for a token and the split cannot happen.
 * Combining marks go too, so `ṕnl` cannot hide either.
 */
const INVISIBLE =
  /[\p{M}\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

// ONE DELIBERATE DIFFERENCE FROM THE INGEST SANITISER: `\p{Cc}` is DELETED
// here, not replaced with a space, so `"floor\u0000reached"` becomes the single
// word `FLOORREACHED` rather than two. The ingest side spaces controls on
// purpose, because it is preserving an operator's sentence for a reader. This
// side is protecting a WALL, where a character that splits a base58 run into
// two sub-32 pieces is the whole attack, so deleting is the safer of the two
// and the cosmetic merge is the price. The two files differ on purpose.

/**
 * A base58 run long enough to be a Solana address.
 *
 * NO UPPER BOUND, and the `{32,64}` it replaced was a proven leak: with `/g`
 * the engine consumed the first 64 characters of an 88-character run and the
 * remaining 24 fell under the minimum, so they were not matched and they
 * PRINTED — `NOTE BD5JBKHETQA83TZRUJOSGASU` on the wall. An address strip has
 * no reason to leave a tail; a run being longer than an address is not a
 * reason to publish part of it.
 */
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{32,}/g;

/**
 * An EVM address. Base58 excludes 0/I/O/l, so hex needs its own pass.
 *
 * THE `i` IS LOAD-BEARING and its absence was a proven leak. The digits were
 * already case-insensitive via `[0-9a-fA-F]`, but the `0x` PREFIX was a literal
 * lowercase pair, and this strip runs BEFORE `toUpperCase()` — so `0xdead…` was
 * caught and `0Xdead…` walked through and printed in full. Found by tfs-audit
 * against this file after Codex found it at ingest; both ends now carry the
 * flag.
 */
const HEX_ADDRESS = /0x[0-9a-f]{6,}/gi;

/**
 * Hex with NO prefix at all, which neither pass above sees: `BASE58_RUN` cannot
 * match a run containing `0`, and `HEX_ADDRESS` needs its `0x`. An unprefixed
 * 40-character EVM address or a 64-character tx hash is still an identifier on
 * a wall.
 *
 * 20 is safe rather than aggressive: the class is only `[0-9a-f]`, so a
 * twenty-character run of nothing but hex digits does not occur in the board's
 * own copy. The longest real word here is "CLAWVILLE", and the basis band's
 * longest run is "EXCLUDES", neither of which is hex.
 */
const BARE_HEX_RUN = /[0-9a-f]{20,}/gi;

/**
 * Printable set for untrusted text. Money punctuation is INCLUDED now, because
 * the board publishes money; what stays out is anything the board's single
 * monospace face cannot render, which would land as tofu on a wall.
 */
const DISALLOWED = /[^A-Za-z0-9 .,:;/$%+\-()#'&]/g;
const WHITESPACE = /\s+/g;

/**
 * Hygiene for text that came from OUTSIDE: slot labels, venue names, notes.
 *
 * NOT a money filter. The board publishes P&L on purpose (founder, 2026-09-20).
 * What a label still may not carry is a wallet address — the public tape
 * already excludes signing material and a base58 run has no business on a wall
 * — plus invisible characters, unrenderable glyphs and unbounded length.
 *
 * Applied at the DRAW site, not the build site, so a caller cannot route around
 * it by constructing `FloorScreenData` by hand.
 */
export function sanitiseScreenText(raw: string, maxLength = 26): string {
  const folded = String(raw ?? '')
    // NFK**D**, and the D is the whole point. Both forms fold fullwidth and
    // mathematical look-alikes onto plain ASCII, which is what this call is
    // for; the difference is what they do to a combining mark, and NFKC
    // COMPOSES it into the letter before it. That defeats the strip on the very
    // next line, because the composed character is not in `INVISIBLE`, and the
    // consequence is a leak this function exists to prevent:
    //
    //   NFKC:  "…JSDp" + U+0301 + "bD5…"  ->  "…JSD BD5…"
    //
    // `p`+acute became one character, survived the strip, split the run into a
    // 19 and a 24 so `BASE58_RUN` matched neither, and `DISALLOWED` finally
    // turned it into a SPACE — painting a whole wallet address, with a gap in
    // the middle, on a wall in the game world. NFKD leaves the mark separate,
    // `INVISIBLE` deletes it (U+0300-U+036F is already in the class), the run
    // rejoins and the address is caught.
    //
    // This is the header's `pro<ZWSP>fit` defect reached with a combining mark,
    // and the header's own fix — strip invisibles before anything tokenises —
    // was being undone by the normalisation that ran ahead of it. NFKD also
    // reads better in ordinary text: "Café" becomes "CAFE", not "CAF E".
    // tfs-api's ingest sanitiser chose NFKD for the same reason; the two ends
    // agree deliberately.
    .normalize('NFKD')
    .replace(INVISIBLE, '');
  // Addresses go BEFORE any case change: base58 excludes `0 O I l`, so
  // upper-casing first would split a real address into sub-32-character pieces
  // and let it through.
  const text = stripAddressRuns(folded)
    .replace(DISALLOWED, ' ')
    .replace(WHITESPACE, ' ')
    .trim()
    .toUpperCase();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}.` : text;
}

/**
 * Remove every address run, MATCHING THEM ALL ON THE INTACT TEXT and deleting
 * the union.
 *
 * Sequential `.replace()` calls were the bug: each pass rewrites the string the
 * next one sees, so one pass can CUT A TOKEN the next would have caught. The
 * bare-hex pass did exactly that — `G`x12 + `a`x20 + `H`x12 is a 44-character
 * base58 run, the 20 `a`s in the middle are also a hex run, and replacing them
 * first left two 12-character pieces that were each under the base58 minimum
 * and printed: `GGGGGGGGGGGG HHHHHHHHHHHH`. I introduced that when I added the
 * bare-hex pass to close a different hole, which is the honest shape of it.
 * (Codex round 3.)
 *
 * Matching on the intact text removes the ordering question entirely rather
 * than answering it: there is no "right" order when two patterns overlap, only
 * an order whose failure nobody has found yet. Overlapping matches merge into
 * one span so a run covered by two patterns still yields a single space.
 */
function stripAddressRuns(text: string): string {
  const spans: Array<[number, number]> = [];
  for (const pattern of [HEX_ADDRESS, BARE_HEX_RUN, BASE58_RUN]) {
    // `matchAll` clones the regex, so these module-level `/g` patterns carry no
    // `lastIndex` between calls.
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  if (spans.length === 0) return text;

  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  let out = '';
  let cursor = 0;
  for (const [start, end] of merged) {
    out += `${text.slice(cursor, start)} `;
    cursor = end;
  }
  return out + text.slice(cursor);
}

// ── numbers: formatted from TYPED fields, never from server text ────────────

/**
 * A string the BOARD produced from a number. The unsanitised `value()` path
 * accepts nothing else.
 *
 * The brand is the enforcement. Money figures skip the untrusted-text pass by
 * design — it would strip the "·" and other board glyphs — so "only pass
 * numbers you formatted here" was a convention held by comments. `BoardValue`
 * makes the other edit a COMPILE ERROR: the brand symbol is not exported, so
 * the only ways to obtain one are the `format*` functions in this module, the
 * `label` tag below, and `cleaned` (text that already passed
 * `sanitiseScreenText`).
 */
declare const BOARD_VALUE: unique symbol;
export type BoardValue = string & { readonly [BOARD_VALUE]: true };

const brand = (text: string): BoardValue => text as BoardValue;

/**
 * Compose a caption from LITERAL text and branded values: label`W ${count}`.
 * The literal halves arrive as a `TemplateStringsArray`, which only a template
 * literal at the call site produces, and every interpolation must already be a
 * `BoardValue`, so a server string cannot be spliced in without a formatter.
 */
function label(
  strings: TemplateStringsArray,
  ...values: readonly BoardValue[]
): BoardValue {
  return brand(strings.reduce((out, part, i) => out + (values[i - 1] ?? '') + part));
}

/**
 * Signed USD from a NUMBER. The sign is always explicit — a bare "5.20" on a
 * P&L board is ambiguous in the one way that matters.
 *
 * Three outcomes, three meanings, never merged: `null` is "nothing to state"
 * and prints a dash; a non-finite number is bad data and prints N/A;
 * everything else is a figure. A zero from any of those three would be a claim.
 */
export function formatSignedUsd(value: number | null): BoardValue {
  if (value === null) return brand('-');
  if (!Number.isFinite(value)) return brand('N/A');
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const magnitude = Math.abs(value);
  // Cents below 100,000, so every realistic paper figure prints exactly and the
  // widest ("-$99999.99", 10 characters) fits the 12-character 24 px budget.
  // Above that, compact notation. The ROUNDED cents decide, not the raw value:
  // 99999.996 rounds to "100000.00", one character past the widest exact string.
  const cents = magnitude.toFixed(2);
  if (Number(cents) < COMPACT_FROM) return brand(`${sign}$${cents}`);
  const compact = compactMagnitude(magnitude);
  return brand(compact === null ? 'N/A' : `${sign}$${compact}`);
}

/**
 * Whole counts from a NUMBER: exact below 100,000 ("99999", five characters),
 * whole thousands or millions above ("121K", "3M"), "-" for bad data. Five
 * characters at most, so "99999/99999 OK" and "99999W 99999L" fit a column.
 */
export function formatCount(value: number): BoardValue {
  if (!Number.isFinite(value) || value < 0) return brand('-');
  const whole = Math.trunc(value);
  if (whole < COMPACT_FROM) return brand(String(whole));
  if (whole < 999_500) return brand(`${Math.round(whole / 1e3)}K`);
  if (whole < 999_500_000) return brand(`${Math.round(whole / 1e6)}M`);
  return brand('-');
}

/** Below this magnitude figures print in full; from it, compact. */
const COMPACT_FROM = 100_000;

/**
 * One-decimal compact magnitude: 123456 -> "123.5K", 1.2e6 -> "1.2M", up to
 * "999.9T"; null beyond, which callers print as N/A. Exported for the 3D tape,
 * whose chip row has the same problem in 13 characters.
 */
export function compactMagnitude(magnitude: number): string | null {
  for (const [size, unit] of COMPACT_UNITS) {
    const scaled = Math.round((magnitude / size) * 10) / 10;
    if (scaled < 1000) return `${scaled.toFixed(1)}${unit}`;
  }
  return null;
}

const COMPACT_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1e3, 'K'],
  [1e6, 'M'],
  [1e9, 'B'],
  [1e12, 'T'],
];

/**
 * Unsigned USD from a NUMBER, whole dollars when the value is whole: "$20",
 * "$20.50". For the position size, which is a price rather than a result.
 * From 100,000 compact ("$123.5K"), like the P&L: `String(1e30)` is "1e+30",
 * which is not a figure a wall should print.
 */
export function formatUsd(value: number): BoardValue {
  if (!Number.isFinite(value)) return brand('N/A');
  const magnitude = Math.abs(value);
  if (magnitude >= COMPACT_FROM) {
    const compact = compactMagnitude(magnitude);
    return brand(compact === null ? 'N/A' : `$${compact}`);
  }
  return brand(
    Number.isInteger(magnitude) ? `$${magnitude}` : `$${magnitude.toFixed(2)}`,
  );
}

/**
 * "#1" for a readable rank, "-" otherwise. Never "#0" and never "#NaN". Capped
 * at 9999 so the right-aligned rank column never starts left of the canvas.
 */
export function formatRank(value: number): BoardValue {
  return brand(
    Number.isFinite(value) && value >= 1 && value < 10_000 ? `#${Math.trunc(value)}` : '-',
  );
}

/** A percentage from a NUMBER: 2.5 -> "2.5%", 1 -> "1%". */
export function formatPercent(value: number): BoardValue {
  if (!Number.isFinite(value)) return brand('-');
  return brand(`${Number(value.toFixed(2))}%`);
}

/**
 * A mark as a multiple of the entry, at most five characters: "1.04X",
 * "10.0X", "100X", "999X+" past that; "N/A" for an unreadable or negative
 * mark. The ROUNDED value picks the form, so 9.996 prints "10.0X", not the
 * six-character "10.00X".
 */
export function formatMarkMultiple(value: number): BoardValue {
  if (!Number.isFinite(value) || value < 0) return brand('N/A');
  if (Number(value.toFixed(2)) < 10) return brand(`${value.toFixed(2)}X`);
  if (Number(value.toFixed(1)) < 100) return brand(`${value.toFixed(1)}X`);
  if (Math.round(value) < 1000) return brand(`${Math.round(value)}X`);
  return brand('999X+');
}

/** Take-profit percent from a multiple: 1.1 -> "10". Null when no bound allows it. */
function takeProfitPercent(multiple: number): BoardValue | null {
  if (!Number.isFinite(multiple) || multiple <= 1) return null;
  const percent = Math.round((multiple - 1) * 100);
  return percent >= 1 && percent <= 999 ? brand(String(percent)) : null;
}

/** Stop-loss percent from a multiple: 0.9 -> "10". Null when no bound allows it. */
function stopPercent(multiple: number): BoardValue | null {
  if (!Number.isFinite(multiple) || multiple <= 0 || multiple >= 1) return null;
  const percent = Math.round((1 - multiple) * 100);
  return percent >= 1 && percent <= 99 ? brand(String(percent)) : null;
}

/** Max hold: whole hours as "2H", else whole minutes as "15M"; null when unreadable. */
function formatHold(seconds: number): BoardValue | null {
  if (!Number.isFinite(seconds) || seconds < 60) return null;
  if (seconds % 3600 === 0 && seconds / 3600 <= 99) return brand(`${seconds / 3600}H`);
  const minutes = Math.round(seconds / 60);
  return minutes <= 999 ? brand(`${minutes}M`) : null;
}

/**
 * The exit line, from the LIVE params: "TP +10% 15M", "TP +8% SL -10%".
 *
 * Percents are whole: the parameters move on a 0.01 step, so whole percents
 * are exact, and an off-step value rounds to the nearest one. The line tries,
 * in order, "TP SL HOLD", "TP SL", the tight "TP+x% SL-y%" (the bound
 * extremes, "TP+900% SL-70%", are exactly 14), then the take-profit alone, and
 * keeps the first that fits the column. A take-profit of null is NO TP; a value
 * no bound allows prints N/A, never a long figure.
 */
export function formatExitRule(exits: FloorScreenExits | null): BoardValue {
  if (!exits) return label`EXITS N/A`;
  const tp = exits.tpMult === null ? null : takeProfitPercent(exits.tpMult);
  const tpWide =
    exits.tpMult === null ? label`NO TP` : tp ? label`TP +${tp}%` : label`TP N/A`;
  const tpTight =
    exits.tpMult === null ? label`NO TP` : tp ? label`TP+${tp}%` : label`TP N/A`;
  const sl = exits.stopMult === null ? null : stopPercent(exits.stopMult);
  const slWide =
    exits.stopMult === null ? null : sl ? label`SL -${sl}%` : label`SL N/A`;
  const slTight =
    exits.stopMult === null ? null : sl ? label`SL-${sl}%` : label`SL N/A`;
  const hold = exits.maxHoldS === null ? null : formatHold(exits.maxHoldS);
  const join = (...parts: ReadonlyArray<BoardValue | null>) =>
    joinValues(parts.filter((part): part is BoardValue => part !== null), label` `);
  return fit(
    COLUMN_LINE_CHARS,
    join(tpWide, slWide, hold),
    join(tpWide, slWide),
    join(tpTight, slTight),
    tpWide,
  );
}

/**
 * The one producer of a `BoardValue` that starts from outside text, and only
 * after the untrusted-text pass. What comes out of `sanitiseScreenText` is
 * exactly what the wall may show, so admitting it to the branded path adds no
 * character the wall could not already show.
 */
function cleaned(raw: string, maxLength: number): BoardValue {
  return brand(sanitiseScreenText(raw, maxLength));
}

/** Join branded parts with a branded separator, keeping the brand. */
function joinValues(parts: readonly BoardValue[], separator: BoardValue): BoardValue {
  return brand(parts.join(separator));
}

/** The first candidate that fits `budget` characters, else "-". Never a cut figure. */
function fit(budget: number, ...candidates: readonly BoardValue[]): BoardValue {
  return candidates.find((candidate) => candidate.length <= budget) ?? label`-`;
}

/**
 * Green up, red down, neutral flat. Exported so the test asserts the pairing
 * instead of re-deriving it from a colour literal.
 */
export function pnlColor(value: number): string {
  if (!Number.isFinite(value)) return COLOR.muted;
  if (value > 0) return COLOR.gain;
  if (value < 0) return COLOR.drop;
  return COLOR.value;
}

// ── board copy ──────────────────────────────────────────────────────────────

/** What a masked or unreadable coin symbol prints. */
export const FLOOR_SCREEN_COIN_WORD = 'COIN';

/**
 * Static strategy words, one per template id (board copy only, plan §1). No
 * numbers on purpose: the thresholds come from the LIVE params on the exit
 * line, so this copy cannot go stale when the house tuner moves a filter.
 */
export const FLOOR_SCREEN_STRATEGY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  genesis: 'BUSIEST YOUNG',
  runner: 'NEW, HOT, CALM',
  'dip-hunter': 'BUYS THE DIP',
  'midcap-climber': 'STEADY CLIMB',
  'late-bloomer': 'WAKING UP',
});

/**
 * One fixed word (at most 9 characters, so "SKIP " + word fits 14) per engine
 * fail code (`FLOOR_ARENA_FAIL_CODES` in the API's `floor-arena/filters.ts`;
 * a test reads that list so the two cannot drift). The raw code never reaches
 * the wall; an unknown code prints OTHER.
 */
export const FLOOR_SCREEN_SKIP_WORDS: Readonly<Record<string, string>> = Object.freeze({
  price: 'PRICE',
  mcap: 'MKT CAP',
  liq: 'LIQUIDITY',
  age: 'AGE',
  age_stale: 'AGE',
  vol_ratio: 'VOLUME',
  vol_ratio_max: 'VOLUME',
  chg5m: '5M MOVE',
  chg5m_max: '5M MOVE',
  chg1h: '1H MOVE',
  chg1h_max: '1H MOVE',
  chg6h: '6H MOVE',
  chg6h_max: '6H MOVE',
  chg24h: '24H MOVE',
  chg24h_max: '24H MOVE',
  txns: 'TRADES',
  txns_max: 'TRADES',
  top10: 'HOLDERS',
  top10_unknown: 'HOLDERS',
  window: 'NOT NEW',
  hard_rules: 'SAFETY',
  chain_pending: 'UNCHECKED',
  chain_verdict_stale: 'UNCHECKED',
  cooldown: 'COOLDOWN',
  source_not_tradeable: 'SOURCE',
});

function ownWord(table: Readonly<Record<string, string>>, key: string): string | null {
  return Object.prototype.hasOwnProperty.call(table, key) ? (table[key] ?? null) : null;
}

/** The skip word for an engine fail code; OTHER for a code the table does not know. */
export function skipWord(code: string): BoardValue {
  const word = ownWord(FLOOR_SCREEN_SKIP_WORDS, code);
  return word === null ? label`OTHER` : cleaned(word, SKIP_WORD_CHARS);
}

const SKIP_WORD_CHARS = 9;

// ── layout ──────────────────────────────────────────────────────────────────

/**
 * The legibility floor for EVERY string on the board, in canvas px (P6). Pinned
 * by a test that reads the font of every `fillText`. At the 0.52 screen px per
 * canvas px projected from the spawn, a 22 px bold capital is about 6.5 screen
 * px. Everything is BOLD: a regular Courier stroke is under one texel at that
 * minification and falls between samples ("GENZSIS", verifier B b-02).
 */
export const BOARD_MIN_PX = 22;
/** Names (up to 12 characters) and the P&L. */
const BOARD_BIG_PX = 24;
const MESSAGE_PX = 26;
const MONO = '"Courier New", monospace';
const fontOf = (px: number): string => `bold ${px}px ${MONO}`;
/** Courier New advances 0.6 em per character. */
const advance = (px: number): number => 0.6 * px;

export const FLOOR_SCREEN_COLUMNS = 5;
/** Clear space on each side of a column, inside the column. */
const COLUMN_GUTTER = 6;
/**
 * Character budget of a column line: (1024 / 5 - 2 * 6) / 13.2 = 14.6 at 22 px.
 * `drawFloorScreen` measures nothing, so these caps ARE the overflow guard.
 */
export const COLUMN_LINE_CHARS = 14;
/** At 24 px (14.4 px a character) the budget is 12 (plan §1). */
export const COLUMN_BIG_CHARS = 12;
/** The symbol part of a line: "WATCH " + 8 and "SYMBOL " + "1.04X" both fit 14. */
const SYMBOL_CHARS = 8;

/**
 * VERTICAL LAYOUT, logical px:
 *
 *   0..36            header bar (title, countdown, clock), accent at 33
 *   40 + 26 k        column line k (baseline 20 px below the slot top)
 *   H - 28 .. H      footer bar (how the figures are made)
 *
 * Lines per column = floor((H - 36 - 28 - 8) / 26): 9 at 313. The last line's
 * glyph box always ends above the footer: 26 n <= H - 72 puts it at H - 33.2.
 */
const HEADER_H = 36;
const HEADER_ACCENT_H = 3;
const HEADER_BASELINE = 26;
const FOOTER_H = 28;
const FOOTER_BASELINE_UP = 8;
const LINE_SLACK = 8;
const LINE_PITCH = 26;
const FIRST_BASELINE = HEADER_H + LINE_SLACK / 2 + 20;
const MARGIN_X = 16;
/** Pill bed around the mode word: 4 px each side, 18 px above the baseline, 24 tall. */
const PILL_PAD_X = 4;
const PILL_RISE = 18;
const PILL_H = 24;
/** Spaces between the pill and the status word. */
const PILL_GAP_CHARS = 2;
/** The header countdown is cut here: "STARTS IN 27000D 03H 12M" is the longest. */
const COUNTDOWN_MAX_CHARS = 24;
/** "CLOCK OFFLINE" whole. */
const CLOCK_MAX_CHARS = 14;

/** Column lines that fit a canvas of this height, in priority order. */
export function floorScreenLineCount(height: number): number {
  if (!Number.isFinite(height)) return 0;
  return Math.max(0, Math.floor((height - HEADER_H - FOOTER_H - LINE_SLACK) / LINE_PITCH));
}

// ── drawing ─────────────────────────────────────────────────────────────────

/**
 * Draw a BOARD-FORMATTED string. Deliberately skips the untrusted-text pass:
 * these strings are built in this module from typed numeric fields, module
 * literals, or sanitised text (`cleaned`). The `BoardValue` brand is what
 * proves which is which.
 */
function value(
  ctx: FloorScreenContext,
  drawn: BoardValue,
  x: number,
  y: number,
  { px, color, align = 'left' }: { px: number; color: string; align?: CanvasTextAlign },
): void {
  if (drawn.length === 0) return;
  ctx.font = fontOf(px);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(drawn, x, y);
}

interface Pill {
  readonly text: BoardValue;
  readonly fill: string;
  readonly color: string;
}

/** One column line. A line with a pill draws "PILL  TEXT" as one centred run. */
interface ColumnLine {
  readonly text: BoardValue;
  readonly px: number;
  readonly color: string;
  readonly pill: Pill | null;
}

const MODE_PILL: Readonly<Record<FloorScreenMode, Pill>> = {
  paper: { text: label`PAPER`, fill: COLOR.paperPill, color: COLOR.paperPillText },
  live: { text: label`LIVE`, fill: COLOR.livePill, color: COLOR.livePillText },
};
const STATUS_WORD: Readonly<Record<FloorScreenStatus, BoardValue>> = {
  active: label`ACTIVE`,
  paused: label`PAUSED`,
  stopped: label`STOPPED`,
};
const STATUS_COLOR: Readonly<Record<FloorScreenStatus, string>> = {
  active: COLOR.label,
  paused: COLOR.prize,
  stopped: COLOR.muted,
};

const line = (text: BoardValue, color: string, px: number = BOARD_MIN_PX): ColumnLine => ({
  text,
  px,
  color,
  pill: null,
});
const DASH = line(label`-`, COLOR.muted);

/**
 * The name rule (lead decision, 2026-10-02): 24 px when the name has 12
 * characters or fewer, else 22 px up to 14. A name over 14 drops its hyphens
 * first ("MID-CAP CLIMBER" -> "MIDCAP CLIMBER", 14); a longer one is cut.
 */
function nameLine(raw: string): ColumnLine {
  let name = sanitiseScreenText(raw, Number.MAX_SAFE_INTEGER);
  if (name.length > COLUMN_LINE_CHARS) name = name.replace(/-/g, '').replace(/ +/g, ' ').trim();
  // A name that sanitises to nothing still gets words, and they describe the
  // wall: the server accepts any script, so a CJK name is a real name this
  // ASCII face cannot paint.
  if (name.length === 0) return line(label`NAME NOT SHOWN`, COLOR.muted);
  if (name.length <= COLUMN_BIG_CHARS) {
    return line(cleaned(name, COLUMN_BIG_CHARS), COLOR.headerText, BOARD_BIG_PX);
  }
  return line(cleaned(name, COLUMN_LINE_CHARS), COLOR.headerText);
}

function modeLine(column: FloorScreenColumn): ColumnLine {
  const pill = column.mode === null ? null : MODE_PILL[column.mode];
  if (column.status === null && pill === null) return line(label`N/A`, COLOR.muted);
  return {
    text: column.status === null ? label`` : STATUS_WORD[column.status],
    px: BOARD_MIN_PX,
    color: column.status === null ? COLOR.muted : STATUS_COLOR[column.status],
    pill,
  };
}

/** A coin symbol as the wall may print it: sanitised, cut to 8, COIN when nothing is left. */
function symbolValue(raw: string): BoardValue {
  const shown = cleaned(raw, SYMBOL_CHARS);
  return shown.length > 0 ? shown : cleaned(FLOOR_SCREEN_COIN_WORD, SYMBOL_CHARS);
}

function scanLine(column: FloorScreenColumn): ColumnLine {
  if (!column.known) return DASH;
  if (column.scan === null) return line(label`NO RECENT SCAN`, COLOR.muted);
  // Lead decision: "<passed>/<evaluated> OK". The plan's "SCAN 412 3 OK" holds
  // only five digits in 14 characters; this form holds "99999/99999 OK".
  const { passed, evaluated } = column.scan;
  return line(
    fit(COLUMN_LINE_CHARS, label`${formatCount(passed)}/${formatCount(evaluated)} OK`),
    COLOR.value,
  );
}

function watchLine(column: FloorScreenColumn): ColumnLine {
  if (!column.known) return DASH;
  if (column.watching !== null) {
    return line(label`WATCH ${symbolValue(column.watching.symbol)}`, COLOR.label);
  }
  const code = column.scan?.topSkipCode ?? null;
  return code === null ? DASH : line(label`SKIP ${skipWord(code)}`, COLOR.value);
}

function openLine(column: FloorScreenColumn, basis: FloorScreenBasis): ColumnLine {
  const count = formatCount(column.openCount);
  return line(
    fit(COLUMN_LINE_CHARS, label`OPEN ${count} OF ${formatCount(basis.maxOpen)}`, label`OPEN ${count}`),
    COLOR.value,
  );
}

function newestLine(column: FloorScreenColumn): ColumnLine {
  if (!column.known) return DASH;
  if (column.newest === null) return line(label`NO OPEN TRADE`, COLOR.muted);
  const { symbol, markMult } = column.newest;
  return line(
    label`${symbolValue(symbol)} ${formatMarkMultiple(markMult)}`,
    pnlColor(markMult - 1),
  );
}

/** Every line of one column, in the plan §1 priority order. */
function columnLines(column: FloorScreenColumn, basis: FloorScreenBasis): ColumnLine[] {
  const words = ownWord(FLOOR_SCREEN_STRATEGY_WORDS, column.templateId);
  return [
    nameLine(column.name),
    modeLine(column),
    line(words === null ? label`` : cleaned(words, COLUMN_LINE_CHARS), COLOR.prize),
    line(formatExitRule(column.exits), column.exits ? COLOR.value : COLOR.muted),
    scanLine(column),
    watchLine(column),
    openLine(column, basis),
    newestLine(column),
    line(
      formatSignedUsd(column.realisedUsd),
      pnlColor(column.realisedUsd ?? Number.NaN),
      BOARD_BIG_PX,
    ),
    column.known
      ? line(label`${formatCount(column.wins)}W ${formatCount(column.losses)}L`, COLOR.value)
      : DASH,
  ];
}

/** Where a pill line starts: the whole "PILL  TEXT" run is centred on the column. */
function pillStart(entry: ColumnLine, pill: Pill, centerX: number): number {
  const chars =
    pill.text.length + (entry.text.length > 0 ? PILL_GAP_CHARS + entry.text.length : 0);
  return centerX - (chars * advance(entry.px)) / 2;
}

interface BoardModes {
  readonly anyLive: boolean;
  readonly anyPaper: boolean;
}

function boardModes(data: FloorScreenData): BoardModes {
  return {
    anyLive: data.columns.some((column) => column.mode === 'live'),
    anyPaper: data.columns.some((column) => column.mode === 'paper'),
  };
}

export function drawFloorScreen(
  ctx: FloorScreenContext,
  data: FloorScreenData,
  size: FloorScreenSize = FLOOR_SCREEN_CANVAS,
): void {
  const W = size.width;
  const H = size.height;
  const modes = boardModes(data);

  ctx.globalAlpha = 1;
  ctx.fillStyle = COLOR.background;
  ctx.fillRect(0, 0, W, H);

  drawHeader(ctx, data, W, modes);

  if (data.page === 'leaderboard') {
    drawLeaderboardPage(ctx, data, W, H);
    return;
  }

  if (data.phase !== 'ready') {
    // Only before the first data. Never an empty grid: an empty grid would say
    // the house agents are idle, which is a claim about them, not our read.
    value(
      ctx,
      data.phase === 'error' ? label`ARENA DATA UNAVAILABLE` : label`CONNECTING TO THE ARENA`,
      W / 2,
      (HEADER_H + H - FOOTER_H) / 2 + 9,
      { px: MESSAGE_PX, color: COLOR.muted, align: 'center' },
    );
    return;
  }

  const columnWidth = W / FLOOR_SCREEN_COLUMNS;
  const lineCount = floorScreenLineCount(H);
  const laid = data.columns
    .slice(0, FLOOR_SCREEN_COLUMNS)
    .map((column) => columnLines(column, data.basis).slice(0, lineCount));

  // Every background first, then every string, so no fill can land on text
  // already painted: the column rules, then the mode pills.
  ctx.fillStyle = COLOR.divider;
  for (let index = 1; index < FLOOR_SCREEN_COLUMNS; index += 1) {
    ctx.fillRect(
      index * columnWidth - 0.75,
      HEADER_H + LINE_SLACK / 2,
      1.5,
      Math.max(0, H - HEADER_H - FOOTER_H - LINE_SLACK),
    );
  }
  laid.forEach((lines, index) => {
    const centerX = (index + 0.5) * columnWidth;
    lines.forEach((entry, k) => {
      if (!entry.pill) return;
      const y = FIRST_BASELINE + k * LINE_PITCH;
      const start = pillStart(entry, entry.pill, centerX);
      ctx.fillStyle = entry.pill.fill;
      ctx.fillRect(
        start - PILL_PAD_X,
        y - PILL_RISE,
        entry.pill.text.length * advance(entry.px) + 2 * PILL_PAD_X,
        PILL_H,
      );
    });
  });

  laid.forEach((lines, index) => {
    const centerX = (index + 0.5) * columnWidth;
    lines.forEach((entry, k) => {
      const y = FIRST_BASELINE + k * LINE_PITCH;
      if (!entry.pill) {
        value(ctx, entry.text, centerX, y, { px: entry.px, color: entry.color, align: 'center' });
        return;
      }
      const start = pillStart(entry, entry.pill, centerX);
      value(ctx, entry.pill.text, start, y, { px: entry.px, color: entry.pill.color });
      value(ctx, entry.text, start + (entry.pill.text.length + PILL_GAP_CHARS) * advance(entry.px), y, {
        px: entry.px,
        color: entry.color,
      });
    });
  });

  drawFooter(ctx, data, W, H, modes);
}

function drawHeader(
  ctx: FloorScreenContext,
  data: FloorScreenData,
  W: number,
  modes: BoardModes,
): void {
  ctx.fillStyle = COLOR.headerBar;
  ctx.fillRect(0, 0, W, HEADER_H);
  ctx.fillStyle = COLOR.live;
  ctx.fillRect(0, HEADER_H - HEADER_ACCENT_H, W, HEADER_ACCENT_H);

  // "PAPER" is part of the TITLE: it is the first word a reader needs before
  // any figure below means anything. LIVE joins it when a column is live.
  const mode =
    modes.anyLive && modes.anyPaper
      ? label`PAPER + LIVE`
      : modes.anyLive
        ? label`LIVE`
        : label`PAPER`;
  const title =
    data.page === 'leaderboard' ? label`LEADERBOARD · CONTEST` : label`HOUSE AGENTS · ${mode}`;
  value(ctx, title, MARGIN_X, HEADER_BASELINE, {
    px: BOARD_MIN_PX,
    color: COLOR.headerText,
  });

  // Clock hard right, then a dot, then the countdown inboard of it. Both are
  // minute resolution on purpose: the scene redraws every 30 s, and a stuck
  // second hand reads as a dead board. Worst case ("STARTS IN 27000D 03H 12M ·
  // CLOCK OFFLINE", 40 characters) starts at x 480, clear of the title.
  const step = advance(BOARD_MIN_PX);
  const clock = cleaned(data.clockLabel, CLOCK_MAX_CHARS);
  value(ctx, clock, W - MARGIN_X, HEADER_BASELINE, {
    px: BOARD_MIN_PX,
    color: COLOR.headerText,
    align: 'right',
  });
  const countdown = cleaned(data.countdownLabel ?? '', COUNTDOWN_MAX_CHARS);
  if (countdown.length === 0) return;
  const clockLeft = W - MARGIN_X - clock.length * step;
  value(ctx, label`·`, clockLeft - 1.5 * step, HEADER_BASELINE, {
    px: BOARD_MIN_PX,
    color: COLOR.muted,
    align: 'center',
  });
  value(ctx, countdown, clockLeft - 3 * step, HEADER_BASELINE, {
    px: BOARD_MIN_PX,
    color: COLOR.prize,
    align: 'right',
  });
}

/**
 * The method, composed from NUMBERS, so the line cannot state a position size
 * or a cost the engine is not using. Three forms (lead decision, 2026-10-02):
 * all paper; mixed (it names the paper columns); all live (no paper claim).
 * The window word is the one the P&L figures are from.
 */
function drawFooter(
  ctx: FloorScreenContext,
  data: FloorScreenData,
  W: number,
  H: number,
  modes: BoardModes,
): void {
  ctx.fillStyle = COLOR.footerBar;
  ctx.fillRect(0, H - FOOTER_H, W, FOOTER_H);
  ctx.fillStyle = COLOR.divider;
  ctx.fillRect(0, H - FOOTER_H, W, 1.5);

  const windowWord = data.window === 'contest' ? label`CONTEST` : label`24H`;
  const { positionUsd, buyCostPct, sellCostPct } = data.basis;
  const usd = formatUsd(positionUsd);
  const buy = formatPercent(buyCostPct);
  const sell = formatPercent(sellCostPct);
  const budget = Math.floor((W - 2 * MARGIN_X) / advance(BOARD_MIN_PX));
  const method =
    !modes.anyLive
      ? fit(
          budget,
          label`PAPER: ${usd} A POSITION, ${buy} BUY + ${sell} SELL COSTS. P&L = REALISED, ${windowWord}`,
          label`PAPER TRADES. P&L = REALISED, ${windowWord}`,
        )
      : modes.anyPaper
        ? fit(
            budget,
            label`PAPER COLUMNS: ${usd} EACH, ${buy} BUY + ${sell} SELL COSTS. P&L = REALISED, ${windowWord}`,
            label`PAPER COLUMNS. P&L = REALISED, ${windowWord}`,
          )
        : label`P&L = REALISED, ${windowWord}`;
  value(ctx, method, MARGIN_X, H - FOOTER_BASELINE_UP, { px: BOARD_MIN_PX, color: COLOR.value });
}

// ── page B: the arena contest leaderboard ──────────────────────────────────

/** Leaderboard columns, logical px at 22 px (13.2 px a character). */
const LEADER_RANK_RIGHT = MARGIN_X + 66; // "#9999" ends here, starts at x 16
const LEADER_NAME_X = 100;
/** 24 characters end at x 416.8, clear of the P&L column's widest start (676). */
const LEADER_NAME_CHARS = 24;
const LEADER_PNL_FROM_RIGHT = 200;

/**
 * Page B, as the pre-P15 board showed it, at the 22 px floor: captions on the
 * first line, then one row per line (8 at 313): rank, trader, realised P&L,
 * trades. The rows are the contest-window leaderboard, house and player alike.
 */
function drawLeaderboardPage(
  ctx: FloorScreenContext,
  data: FloorScreenData,
  W: number,
  H: number,
): void {
  const board = data.leaderboard;
  const messageY = (HEADER_H + H - FOOTER_H) / 2 + 9;
  if (board.phase !== 'ready') {
    value(
      ctx,
      board.phase === 'error' ? label`ARENA DATA UNAVAILABLE` : label`CONNECTING TO THE ARENA`,
      W / 2,
      messageY,
      { px: MESSAGE_PX, color: COLOR.muted, align: 'center' },
    );
    return;
  }
  // The paper disclosure is on page B too: these are paper contest figures.
  const footer = { ...data, window: 'contest' as const };
  const paper: BoardModes = { anyLive: false, anyPaper: true };
  if (board.rows.length === 0) {
    value(ctx, label`NO TRADERS YET`, W / 2, messageY, {
      px: MESSAGE_PX,
      color: COLOR.muted,
      align: 'center',
    });
    drawFooter(ctx, footer, W, H, paper);
    return;
  }

  const pnlRight = W - MARGIN_X - LEADER_PNL_FROM_RIGHT;
  const tradesRight = W - MARGIN_X;
  const rows = board.rows.slice(0, Math.max(0, floorScreenLineCount(H) - 1));

  // Backgrounds first: the caption rule.
  ctx.fillStyle = COLOR.divider;
  ctx.fillRect(MARGIN_X, FIRST_BASELINE + 7, W - 2 * MARGIN_X, 1.5);

  const caption = { px: BOARD_MIN_PX, color: COLOR.muted } as const;
  value(ctx, label`#`, LEADER_RANK_RIGHT, FIRST_BASELINE, { ...caption, align: 'right' });
  value(ctx, label`TRADER`, LEADER_NAME_X, FIRST_BASELINE, caption);
  value(ctx, label`REALISED P&L`, pnlRight, FIRST_BASELINE, { ...caption, align: 'right' });
  value(ctx, label`TRADES`, tradesRight, FIRST_BASELINE, { ...caption, align: 'right' });

  rows.forEach((row, index) => {
    const y = FIRST_BASELINE + (index + 1) * LINE_PITCH;
    value(ctx, formatRank(row.rank), LEADER_RANK_RIGHT, y, {
      px: BOARD_MIN_PX,
      color: COLOR.value,
      align: 'right',
    });
    // A name that sanitises to nothing still gets words, and they describe
    // the wall (an id-name, an address, or a script this face cannot paint).
    const name = cleaned(row.name, LEADER_NAME_CHARS);
    value(ctx, name.length > 0 ? name : label`NAME NOT SHOWN`, LEADER_NAME_X, y, {
      px: BOARD_MIN_PX,
      color: name.length > 0 ? COLOR.label : COLOR.muted,
    });
    value(ctx, formatSignedUsd(row.realisedUsd), pnlRight, y, {
      px: BOARD_MIN_PX,
      color: pnlColor(row.realisedUsd),
      align: 'right',
    });
    value(ctx, formatCount(row.trades), tradesRight, y, {
      px: BOARD_MIN_PX,
      color: COLOR.value,
      align: 'right',
    });
  });

  drawFooter(ctx, footer, W, H, paper);
}
