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
 * ── WHAT THIS BOARD IS ──────────────────────────────────────────────────────
 * The TRADING ARENA leaderboard (founder, 2026-09-30: "ranked on a P&L
 * leaderboard on the floor TV"). A header with the contest name, a PAPER
 * marker, the countdown and a UTC clock; the prize line; a ranked table of up
 * to `FLOOR_SCREEN_MAX_ROWS` agents (house and player alike, house rows tagged
 * because they are shown but cannot win); one line stating how the figures
 * are made; and a static tape of the newest arena entries and exits.
 *
 * It replaced the two-card LIVE house-trader board on 2026-09-30. That board
 * read `/api/floor/house-traders` (on-chain verified swaps); this one reads the
 * arena's PAPER ledger. The Exchange panel still shows the live house traders,
 * and the card board's history (the P&L disclosures, the risk-pause word, the
 * basis band) is in git and in `3dStructure.md` §9h.
 *
 * ── THE RULES THAT CARRIED OVER ─────────────────────────────────────────────
 * PAPER IS SAID ON THE WALL, twice: in the title and in the basis line. A P&L
 * figure a reader could take for real money is the one dishonesty this board
 * can commit while every number on it is correct.
 *
 * NUMBERS ARE NEVER TEXT. Every figure is formatted here from a TYPED field
 * (`formatSignedUsd`, `formatCount`, …) and drawn through `value()`, which does
 * not run the untrusted-text pass. No money figure is ever pasted from a server
 * string, and the test greps this source to prove no literal money figure is
 * hard-coded in it — the $20 ticket and the cost percentages arrive as numbers
 * from `@clawville/shared`.
 *
 * TEXT FROM OUTSIDE IS SANITISED AT THE DRAW SITE: agent names, template names,
 * the contest name and the tape. `sanitiseScreenText` strips control and
 * zero-width characters, folds look-alikes, caps length and rejects wallet
 * addresses (base58 and EVM). Player-chosen agent names make that pass matter
 * more now than it did for two house desks.
 *
 * LEGIBILITY FLOOR: nothing on the board is drawn below 15 canvas px
 * (`BOARD_MIN_PX`), and everything is BOLD (see `FONT_SMALL`). The contract
 * viewport is a 1366 x 768 laptop. A 2026-09-19 measurement gave 0.593 screen
 * px per canvas px from the spawn; projecting the plane with the rig constants
 * on 2026-09-30 gives 0.52 (camera clamped at z 1088), so 15 canvas px is about
 * 7.8 screen px there — at the 6-7 px floor, not above it with room to spare.
 */

import { TRADING_FLOOR_SCREEN } from './trading-floor-room';

/**
 * Why a row carries a tag.
 *
 *   house    — a ClawVille house agent. Ranked with everyone so players can
 *              measure themselves against it, never eligible for a prize.
 *   no-prize — a PLAYER row the route marked `eligible: false`. Without the
 *              tag a reader would take its place for a prize place.
 *   null     — an eligible player row.
 */
export type FloorScreenRowTag = 'house' | 'no-prize' | null;

/**
 * One leaderboard row, in DRAWABLE form.
 *
 * Every number is a plain number and may be NaN: the data layer maps an
 * unreadable field to NaN rather than to 0, and the formatters print NaN as
 * `N/A` (money) or `-` (counts). A zero would be a claim about the agent; NaN
 * is a statement about our read.
 */
export interface FloorScreenRow {
  readonly rank: number;
  /** Agent name. Player-chosen text, sanitised again at draw time. */
  readonly name: string;
  readonly tag: FloorScreenRowTag;
  /** Template display name, e.g. "Genesis". Sanitised again at draw time. */
  readonly template: string;
  readonly realisedUsd: number;
  /** Closed positions in the window. */
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly openPositions: number;
}

export interface FloorScreenPrize {
  readonly place: number;
  readonly amount: number;
}

export interface FloorScreenContest {
  /** Contest name from the route. Untrusted, sanitised at draw time. */
  readonly title: string;
  /**
   * Pre-formatted, e.g. "ENDS IN 4D 03H 12M". Null when either end of the
   * window is unreadable: a countdown to a guessed time is worse than none.
   */
  readonly countdownLabel: string | null;
  /** Empty unless every prize is in a token this board recognises. */
  readonly prizes: readonly FloorScreenPrize[];
}

/**
 * How the figures are made. NUMBERS, not a sentence: the board composes the
 * line itself, so it can only state a method that matches the constants the
 * engine runs on.
 */
export interface FloorScreenBasis {
  readonly positionUsd: number;
  readonly buyCostPct: number;
  readonly sellCostPct: number;
}

export interface FloorScreenData {
  readonly phase: 'connecting' | 'error' | 'ready';
  /** Ranked, at most `FLOOR_SCREEN_MAX_ROWS`. */
  readonly rows: readonly FloorScreenRow[];
  /** TRUE when ANY player agent is on the full board, not only the top rows. */
  readonly hasPlayerAgents: boolean;
  /** Null while the contest route is loading or failing. */
  readonly contest: FloorScreenContest | null;
  readonly basis: FloorScreenBasis;
  /**
   * Wall clock for the header, pre-formatted, e.g. "14:32 UTC". Passed in
   * rather than read here so the drawing stays pure and the test can pin it.
   * UTC, not local: the board is a shared public surface and a local reading
   * would be a different fact for every player looking at the same wall.
   */
  readonly clockLabel: string;
  /**
   * Bottom tape, newest first, one string per arena entry or exit, e.g.
   * "GENESIS BUY BONK $20.00 4M". Built from typed fields by the data layer.
   */
  readonly tape: readonly string[];
}

/**
 * LOGICAL canvas size — the coordinate space every number below is written in.
 *
 * The backing store may be twice this on a high-DPR display (the scene scales
 * the context by `pickCanvasScale`), but the drawing code never learns that:
 * one coordinate space, one set of hand-tuned offsets, one truncation budget.
 *
 * DERIVED from `TRADING_FLOOR_SCREEN`, not re-typed. These were two hand-written
 * pairs through three board resizes and drifted on the third (`325` here against
 * `392` there, caught by a pin mid-round). A test can only catch a drift that
 * has already happened; deriving means there is one literal pair in the repo and
 * the two cannot disagree. The plane geometry is the natural owner, so the
 * arrow points geometry → drawing.
 */
export const FLOOR_SCREEN_CANVAS = Object.freeze({
  width: TRADING_FLOOR_SCREEN.canvasWidth,
  height: TRADING_FLOOR_SCREEN.canvasHeight,
});

/** Table rows the canvas has room for. The data layer slices to this. */
export const FLOOR_SCREEN_MAX_ROWS = 8;

/**
 * Backing-store multiplier for the canvas, capped at 2.
 *
 * The board is 1700 wu wide in a room 2200 wu deep, so a player reading it from
 * mid-room sees roughly 3 device pixels per logical texel and a player at the
 * kiosk sees far more than that — the glyph edges are the visible cost, not the
 * glyph size. Doubling the backing store halves that softness for roughly 4 MB
 * more GPU memory at the current board size (a full `FLOOR_SCREEN_CANVAS` RGBA
 * buffer, times four) and one larger upload per redraw, which is at most every
 * 15 s.
 *
 * The threshold is 1.5, not 2: Windows at 150% scaling reports 1.5 and is
 * exactly the desktop case where the extra texels show. A 1.0 or 1.25 desktop —
 * the Iris Xe floor — stays on the single-size path and pays nothing.
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
 * muted for secondary text) instead of re-typing hex literals.
 */
export const COLOR = {
  background: '#050d16',
  headerBar: '#0b1a28',
  headerText: '#d7f2ff',
  label: '#e8f7ff',
  value: '#bfe9ff',
  muted: '#6d92ab',
  /** Accent rules and the "launch yours" call to action. */
  live: '#3ddc97',
  /** Prizes and the countdown: the two things about the contest itself. */
  prize: '#ffc457',
  /** Zebra stripe behind every second row, so a row reads across 980 px. */
  rowStripe: '#0a1826',
  divider: '#1d3b52',
  /** Tag pills. Light text on a mid-tone fill, never dark on dark. */
  houseTagFill: '#123a55',
  noPrizeTagFill: '#3a2e10',
  tickerBar: '#081420',
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
 * design — it would strip the "$" — so "only pass numbers you formatted here"
 * was a convention held by comments, and a convention is one careless edit away
 * from a server string on a wall in the game world. `BoardValue` makes that
 * edit a COMPILE ERROR: the type is unforgeable outside this module because the
 * brand symbol is not exported, so the only ways to obtain one are the
 * `format*` functions in this module, the `label` tag below, and `cleaned`
 * (text that already passed `sanitiseScreenText`).
 */
declare const BOARD_VALUE: unique symbol;
export type BoardValue = string & { readonly [BOARD_VALUE]: true };

const brand = (text: string): BoardValue => text as BoardValue;

/**
 * Compose a caption from LITERAL text and branded values: label`W ${count}`.
 *
 * A tagged template is the tightest fit for what the board actually draws —
 * fixed captions around computed numbers. The literal halves arrive as a
 * `TemplateStringsArray`, which only a template literal at the call site
 * produces, and every interpolation must already be a `BoardValue`. So a server
 * string cannot be spliced into a caption without first passing through a
 * formatter, and there is no code path that "just concatenates".
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
 * Three outcomes, three meanings, never merged: `null` is "nothing closed yet"
 * and prints a dash; a non-finite number is bad data and prints N/A; everything
 * else is a figure. A zero from any of those three would be a claim.
 */
export function formatSignedUsd(value: number | null): BoardValue {
  if (value === null) return brand('-');
  if (!Number.isFinite(value)) return brand('N/A');
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const magnitude = Math.abs(value);
  // Cents below 100,000, so every realistic paper figure prints exactly and the
  // widest ("-$99999.99", 10 characters) fits its column. Above that, compact
  // notation rather than a longer string: an absurd figure (an engine bug) must
  // still not run into the template column (Codex review, 2026-09-30).
  // The ROUNDED cents decide, not the raw value: 99999.996 rounds to
  // "100000.00", one character past the widest exact string.
  const cents = magnitude.toFixed(2);
  if (Number(cents) < COMPACT_FROM) return brand(`${sign}$${cents}`);
  const compact = compactMagnitude(magnitude);
  return brand(compact === null ? 'N/A' : `${sign}$${compact}`);
}

/**
 * Whole counts from a NUMBER. At 100,000 and above, whole thousands or
 * millions ("121K", "3M"): a W/L pair of two such counts is at most 9
 * characters and stays inside its column, where two raw 6-digit counts would
 * overrun the TRADES column beside it.
 */
export function formatCount(value: number): BoardValue {
  // A NEGATIVE count is bad data, not a figure, and two of them ("-99999/
  // -99999") would also overrun the W/L column into TRADES.
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
 * whose chip row has the same problem in 13 characters. Conventional notation
 * that reads as rounded; it is only reached by figures no paper ticket can
 * produce.
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
 * "$20.50". For the ticket size, which is a price rather than a result, so a
 * sign would be wrong.
 */
export function formatUsd(value: number): BoardValue {
  if (!Number.isFinite(value)) return brand('N/A');
  const magnitude = Math.abs(value);
  return brand(
    Number.isInteger(magnitude) ? `$${magnitude}` : `$${magnitude.toFixed(2)}`,
  );
}

/** A percentage from a NUMBER: 2.5 -> "2.5%", 1 -> "1%". */
export function formatPercent(value: number): BoardValue {
  if (!Number.isFinite(value)) return brand('-');
  return brand(`${Number(value.toFixed(2))}%`);
}

/**
 * A whole amount with thousands separators: 1000000 -> "1,000,000". Grouped
 * by hand rather than `toLocaleString`, so the wall does not depend on which
 * ICU data the runtime shipped with.
 */
export function formatAmount(value: number): BoardValue {
  if (!Number.isFinite(value)) return brand('-');
  const whole = String(Math.trunc(Math.abs(value)));
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return brand(value < 0 ? `-${grouped}` : grouped);
}

/** 1 -> "1ST", 2 -> "2ND", 3 -> "3RD", 11 -> "11TH". */
export function formatOrdinal(value: number): BoardValue {
  if (!Number.isFinite(value) || value < 1) return brand('-');
  const n = Math.trunc(value);
  const lastTwo = n % 100;
  const last = n % 10;
  const suffix =
    lastTwo >= 11 && lastTwo <= 13
      ? 'TH'
      : last === 1
        ? 'ST'
        : last === 2
          ? 'ND'
          : last === 3
            ? 'RD'
            : 'TH';
  return brand(`${n}${suffix}`);
}

/**
 * "#1" for a readable rank, "-" otherwise. Never "#0" and never "#NaN". Capped
 * at 9999: the column is right-aligned at x 62, and "#99999" would start left
 * of the canvas. A top-8 table showing a five-digit rank is bad data anyway.
 */
export function formatRank(value: number): BoardValue {
  return brand(
    Number.isFinite(value) && value >= 1 && value < 10_000 ? `#${Math.trunc(value)}` : '-',
  );
}

/**
 * The one producer of a `BoardValue` that starts from outside text, and only
 * after the untrusted-text pass. What comes out of `sanitiseScreenText` is exactly what
 * `text()` would have painted, so admitting it to the branded path adds no
 * character the wall could not already show. It exists for one job — joining a
 * server string to a literal that uses a glyph the sanitiser drops (the " · "
 * separator in the title) — and it must never be handed anything else.
 */
function cleaned(raw: string, maxLength: number): BoardValue {
  return brand(sanitiseScreenText(raw, maxLength));
}

/**
 * Join branded parts with a branded separator, keeping the brand. Sound
 * because every input was branded and joining adds nothing else.
 */
function joinValues(parts: readonly BoardValue[], separator: BoardValue): BoardValue {
  return brand(parts.join(separator));
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

// ── drawing ─────────────────────────────────────────────────────────────────

function text(
  ctx: FloorScreenContext,
  value: string,
  x: number,
  y: number,
  {
    font,
    color,
    align = 'left',
    max = 26,
  }: { font: string; color: string; align?: CanvasTextAlign; max?: number },
): void {
  const safe = sanitiseScreenText(value, max);
  if (safe.length === 0) return;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(safe, x, y);
}

/**
 * Draw a BOARD-FORMATTED string. Deliberately skips the untrusted-text pass.
 *
 * These strings are built in this module from typed numeric fields, module
 * literals, or sanitised text (`cleaned`), so there is nothing to sanitise —
 * and running them through the label pass would be wrong in both directions:
 * it upper-cases, and it drops the "·" the title and the prize line use. The
 * split is the invariant: untrusted text goes through `text()`, formatted
 * values go through `value()`, and the `BoardValue` brand is what proves which
 * is which.
 */
function value(
  ctx: FloorScreenContext,
  drawn: BoardValue,
  x: number,
  y: number,
  { font, color, align = 'left' }: { font: string; color: string; align?: CanvasTextAlign },
): void {
  if (drawn.length === 0) return;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(drawn, x, y);
}

/**
 * The legibility floor for EVERY string on the board, in canvas px. Pinned by a
 * test that reads the font of every `fillText`. At the 0.52 screen px per canvas
 * px projected from the spawn, 15 is about 7.8 screen px on the 1366 x 768
 * contract viewport — which is why it must also be bold.
 */
export const BOARD_MIN_PX = 15;
const MONO = '"Courier New", monospace';
const FONT_TITLE = `bold 22px ${MONO}`;
const FONT_HEADER = `bold 16px ${MONO}`;
/**
 * EVERY font on this board is bold, and the small one most of all. At the
 * spawn the board is minified about 1.9:1 (0.52 screen px per canvas px at
 * 1366 x 768), and a REGULAR Courier New stroke is under one texel wide, so it
 * can fall between texture samples and vanish: the template column read
 * "GENZSIS" and "LATZ BLOOMER" on staging while the bold TRADER column beside
 * it, one pixel larger, read correctly (verifier B, shot b-02). Bold strokes
 * are about twice as wide; the advance is the same 0.6 em, so no layout moves.
 * Mipmaps were tried alongside and reverted: they broke OTHER bold cells at
 * the spawn ("LANDTKST1"); see `trading-floor-screen.tsx`. At ~5 screen px per
 * capital, bold + single-level is the state with a clean real-GPU shot.
 */
const FONT_SMALL = `bold ${BOARD_MIN_PX}px ${MONO}`;
const FONT_ROW = `bold 16px ${MONO}`;
const FONT_PNL = `bold 18px ${MONO}`;
const FONT_MESSAGE = `bold 26px ${MONO}`;

/**
 * VERTICAL LAYOUT, logical px. Hand-placed, so a canvas height change is NOT a
 * constant swap: re-derive every baseline and rerun the paint-order and
 * overlap pins, which are what catch a row drawn through its neighbour.
 *
 *   0..38     header bar (title, countdown, clock)
 *   59        prize line + "HOUSE AGENTS NOT ELIGIBLE"
 *   81        column captions, divider at 87
 *   107..254  8 rows at a 21 px pitch
 *   272       basis line
 *   277..313  ticker bar
 *
 * The tightest gap is row 8 against the basis line: the 18 px P&L's box ends at
 * 257.6 and the basis box starts at 261.2 (estimator figures, see the test).
 */
const HEADER_H = 38;
const TICKER_H = 36;
const PRIZE_Y = 59;
const COLUMNS_Y = 81;
const DIVIDER_Y = 87;
const FIRST_ROW_Y = 107;
const ROW_PITCH = 21;
/** A stripe spans one pitch, starting this far above the row's baseline. */
const STRIPE_ABOVE_BASELINE = 15;
const BASIS_Y = 272;

/**
 * COLUMNS, logical px. Courier advances ~0.6em, so a character is 9.6 px at
 * 16 px and 9 px at 15 px. `drawFloorScreen` measures nothing, so the
 * character caps below ARE the overflow guard for the text columns.
 */
const MARGIN_X = 22;
const COL_RANK_RIGHT = 62;
const COL_NAME_X = 78;
/** 16 bold 16 px characters = 153.6 px, ending at 231.6, clear of the tag. */
const NAME_MAX_CHARS = 16;
const COL_TAG_X = 244;
const COL_TEMPLATE_X = 336;
/** 16 characters at 15 px = 144 px, ending at 480, clear of the P&L caption
 *  at 532. 16 fits the longest shipped template name, "Mid-Cap Climber". */
const TEMPLATE_MAX_CHARS = 16;
const COL_PNL_RIGHT = 640;
const COL_TRADES_RIGHT = 760;
const COL_WL_RIGHT = 880;
const COL_OPEN_RIGHT = 1002;
/** Contest names are cut here, leaving room for the " · PAPER" suffix. */
const TITLE_MAX_CHARS = 22;
/**
 * The prize line's room: from x 22 to 15 px short of "HOUSE AGENTS NOT
 * ELIGIBLE" (25 characters at 9 px, right-aligned at 1002, so it starts at
 * 777). (777 - 15 - 22) / 9 = 82 characters of bold 15 px Courier.
 */
const PRIZE_MAX_CHARS = 82;
/**
 * Ticker width in characters. 15 px Courier is 9 px/char and the row starts at
 * x = 22 on a 1024 px canvas, so 95 characters end at 877; `drawFloorScreen`
 * measures no text, so this cap IS the overflow guard.
 */
const TICKER_MAX_CHARS = 95;
/** The sanitiser collapses runs of spaces, so a wider joiner would paint as
 *  this one anyway. */
const TICKER_JOINER = ' /// ';

const TAG_LABEL: Record<Exclude<FloorScreenRowTag, null>, BoardValue> = {
  house: label`HOUSE`,
  'no-prize': label`NO PRIZE`,
};
const TAG_FILL: Record<Exclude<FloorScreenRowTag, null>, string> = {
  house: COLOR.houseTagFill,
  'no-prize': COLOR.noPrizeTagFill,
};
const TAG_TEXT: Record<Exclude<FloorScreenRowTag, null>, string> = {
  house: COLOR.value,
  'no-prize': COLOR.prize,
};

export function drawFloorScreen(
  ctx: FloorScreenContext,
  data: FloorScreenData,
): void {
  const W = FLOOR_SCREEN_CANVAS.width;
  const H = FLOOR_SCREEN_CANVAS.height;

  ctx.globalAlpha = 1;
  ctx.fillStyle = COLOR.background;
  ctx.fillRect(0, 0, W, H);

  drawHeader(ctx, data, W);

  if (data.phase !== 'ready') {
    // "Connecting" is the honest state while the query is in flight. Never an
    // empty table: an empty table would say no agent has traded, which is a
    // claim about the arena rather than about our read.
    text(
      ctx,
      data.phase === 'error' ? 'ARENA DATA UNAVAILABLE' : 'CONNECTING TO THE ARENA',
      W / 2,
      (COLUMNS_Y + BASIS_Y) / 2,
      { font: FONT_MESSAGE, color: COLOR.muted, align: 'center', max: 40 },
    );
    drawTicker(ctx, data, W, H);
    return;
  }

  drawColumnCaptions(ctx, W);

  const rows = data.rows.slice(0, FLOOR_SCREEN_MAX_ROWS);

  // Every background first, then every string, so no fill can land on text
  // already painted. The tag pills are the one fill drawn per row, and they
  // sit in their own column below the previous row's glyphs. Stripes only
  // under real rows: a striped empty row reads as a ranked agent with no name.
  for (let index = 1; index < rows.length; index += 2) {
    ctx.fillStyle = COLOR.rowStripe;
    ctx.fillRect(
      MARGIN_X - 8,
      FIRST_ROW_Y + index * ROW_PITCH - STRIPE_ABOVE_BASELINE,
      W - 2 * (MARGIN_X - 8),
      ROW_PITCH,
    );
  }

  rows.forEach((row, index) => drawRow(ctx, row, FIRST_ROW_Y + index * ROW_PITCH));

  // The call to action. Only when NO player agent is anywhere on the board —
  // a player ranked 40th still means the arena has players — and only in a
  // free row, so it never displaces a ranked agent.
  if (!data.hasPlayerAgents && rows.length < FLOOR_SCREEN_MAX_ROWS) {
    value(
      ctx,
      label`NO PLAYER TRADERS YET · LAUNCH YOUR TRADER AT THE KIOSK`,
      W / 2,
      FIRST_ROW_Y + rows.length * ROW_PITCH,
      { font: FONT_ROW, color: COLOR.live, align: 'center' },
    );
  }

  // The method, whenever a figure is on the wall. Composed from NUMBERS, so
  // the line cannot state a ticket size or a cost the engine is not using.
  if (rows.length > 0) {
    const { positionUsd, buyCostPct, sellCostPct } = data.basis;
    value(
      ctx,
      label`PAPER TRADES · ${formatUsd(positionUsd)} PER POSITION · REALISED P&L AFTER ${formatPercent(buyCostPct)} BUY + ${formatPercent(sellCostPct)} SELL COSTS`,
      MARGIN_X,
      BASIS_Y,
      { font: FONT_SMALL, color: COLOR.muted },
    );
  }

  drawTicker(ctx, data, W, H);
}

function drawHeader(ctx: FloorScreenContext, data: FloorScreenData, W: number): void {
  ctx.fillStyle = COLOR.headerBar;
  ctx.fillRect(0, 0, W, HEADER_H);
  ctx.fillStyle = COLOR.live;
  ctx.fillRect(0, HEADER_H - 3, W, 3);

  // "PAPER" is part of the TITLE, not a footnote: it is the first word a
  // reader needs before any figure below it means anything.
  // Sanitised FIRST, then tested: a name that is nothing but an address or an
  // emoji sanitises to "" and must fall back rather than paint "· PAPER".
  const title = cleaned(data.contest ? data.contest.title : '', TITLE_MAX_CHARS);
  value(
    ctx,
    title.length > 0 ? label`${title} · PAPER` : label`TRADING ARENA · PAPER`,
    MARGIN_X,
    27,
    { font: FONT_TITLE, color: COLOR.headerText },
  );

  // Clock hard right, countdown inboard of it. Both are minute resolution on
  // purpose: the scene redraws every 30 s, and a stuck second hand reads as a
  // dead board. `max: 14` fits "CLOCK OFFLINE" whole; the previous 12 cut it
  // to "CLOCK OFFLI." on the one state that most needs to be read.
  text(ctx, data.clockLabel, W - MARGIN_X, 26, {
    font: FONT_HEADER,
    color: COLOR.headerText,
    align: 'right',
    max: 14,
  });
  // W - 162: the clock's worst case is 13 characters at 9.6 px (124.8 px) plus
  // the 22 px margin, so the countdown's right edge sits 15 px clear of it.
  if (data.contest?.countdownLabel) {
    text(ctx, data.contest.countdownLabel, W - 162, 26, {
      font: FONT_HEADER,
      color: COLOR.prize,
      align: 'right',
      // 24 fits "STARTS IN 27000D 03H 12M", the longest the 2100 plausibility
      // bound allows; at 9.6 px/char it starts at x 632, clear of the title.
      max: 24,
    });
  }

  if (data.contest && data.contest.prizes.length > 0) {
    const places = data.contest.prizes.map(
      (prize) => label`${formatOrdinal(prize.place)} ${formatAmount(prize.amount)}`,
    );
    const line = label`PRIZES  ${joinValues(places, label` · `)} $CLAWVILLE`;
    // ALL OR NOTHING, like the data layer's prize read: a line too long for
    // its room is dropped whole, never cut (a cut prize line misstates a
    // prize) and never drawn through the note beside it. Codex review round
    // 4: three prizes of 1e18 ran off the canvas. The shipped line is 60.
    if (line.length > PRIZE_MAX_CHARS) return;
    value(ctx, line, MARGIN_X, PRIZE_Y, { font: FONT_SMALL, color: COLOR.prize });
    // House agents are ranked in the same table, so the prize line must say
    // they cannot take a place — otherwise a house row at #1 reads as the
    // winner of 1,000,000.
    text(ctx, 'HOUSE AGENTS NOT ELIGIBLE', W - MARGIN_X, PRIZE_Y, {
      font: FONT_SMALL,
      color: COLOR.muted,
      align: 'right',
      max: 30,
    });
  }
}

function drawColumnCaptions(ctx: FloorScreenContext, W: number): void {
  const caption = { font: FONT_SMALL, color: COLOR.muted } as const;
  text(ctx, '#', COL_RANK_RIGHT, COLUMNS_Y, { ...caption, align: 'right' });
  text(ctx, 'TRADER', COL_NAME_X, COLUMNS_Y, caption);
  text(ctx, 'TEMPLATE', COL_TEMPLATE_X, COLUMNS_Y, caption);
  text(ctx, 'REALISED P&L', COL_PNL_RIGHT, COLUMNS_Y, { ...caption, align: 'right' });
  text(ctx, 'TRADES', COL_TRADES_RIGHT, COLUMNS_Y, { ...caption, align: 'right' });
  text(ctx, 'W/L', COL_WL_RIGHT, COLUMNS_Y, { ...caption, align: 'right' });
  text(ctx, 'OPEN', COL_OPEN_RIGHT, COLUMNS_Y, { ...caption, align: 'right' });
  ctx.fillStyle = COLOR.divider;
  ctx.fillRect(MARGIN_X - 8, DIVIDER_Y, W - 2 * (MARGIN_X - 8), 1.5);
}

function drawRow(ctx: FloorScreenContext, row: FloorScreenRow, y: number): void {
  if (row.tag) {
    // 0.6em per character at 15 px, plus 5 px of pill each side.
    const width = TAG_LABEL[row.tag].length * 9 + 10;
    ctx.fillStyle = TAG_FILL[row.tag];
    ctx.fillRect(COL_TAG_X - 5, y - 13, width, 17);
  }

  value(ctx, formatRank(row.rank), COL_RANK_RIGHT, y, {
    font: FONT_ROW,
    color: COLOR.value,
    align: 'right',
  });
  // Same order as the title: a name that sanitises to nothing still gets
  // words, or the row reads as a rank with no agent. "NAME NOT SHOWN", not
  // "UNNAMED": the server accepts any script (`\p{L}`), so a Cyrillic or CJK
  // name is a real name this ASCII face cannot paint. The words describe our
  // wall, not the agent.
  const name = sanitiseScreenText(row.name, NAME_MAX_CHARS);
  text(ctx, name.length > 0 ? name : 'NAME NOT SHOWN', COL_NAME_X, y, {
    font: FONT_ROW,
    color: COLOR.label,
    max: NAME_MAX_CHARS,
  });
  if (row.tag) {
    value(ctx, TAG_LABEL[row.tag], COL_TAG_X, y, {
      font: FONT_SMALL,
      color: TAG_TEXT[row.tag],
    });
  }
  text(ctx, row.template, COL_TEMPLATE_X, y, {
    font: FONT_SMALL,
    color: COLOR.value,
    max: TEMPLATE_MAX_CHARS,
  });
  value(ctx, formatSignedUsd(row.realisedUsd), COL_PNL_RIGHT, y, {
    font: FONT_PNL,
    color: pnlColor(row.realisedUsd),
    align: 'right',
  });
  value(ctx, formatCount(row.trades), COL_TRADES_RIGHT, y, {
    font: FONT_ROW,
    color: COLOR.value,
    align: 'right',
  });
  value(ctx, label`${formatCount(row.wins)}/${formatCount(row.losses)}`, COL_WL_RIGHT, y, {
    font: FONT_ROW,
    color: COLOR.value,
    align: 'right',
  });
  value(ctx, formatCount(row.openPositions), COL_OPEN_RIGHT, y, {
    font: FONT_ROW,
    color: COLOR.value,
    align: 'right',
  });
}

function drawTicker(
  ctx: FloorScreenContext,
  data: FloorScreenData,
  W: number,
  H: number,
): void {
  const y = H - TICKER_H;
  ctx.fillStyle = COLOR.tickerBar;
  ctx.fillRect(0, y, W, TICKER_H);
  ctx.fillStyle = COLOR.live;
  ctx.fillRect(0, y, W, 2);

  // Newest arena entries and exits, the same feed the 3D tape flies through
  // the hall. The token SYMBOL is the one the route sends; a mint is never
  // drawn, and every entry passes the address strip.
  //
  // WHOLE ENTRIES ONLY. The line used to be joined and then cut at the
  // character cap, which ended it mid-entry ("DIP HUNTER SE.") and, with money
  // on the tape, can cut a figure into a different figure ("-$3.21" into
  // "-$3.2."). Entries are packed while they fit, and one that does not fit is
  // left for the next redraw rather than shown in part.
  let line = '';
  for (const entry of data.tape) {
    const safe = sanitiseScreenText(entry, Number.MAX_SAFE_INTEGER);
    if (safe.length === 0 || safe.length > TICKER_MAX_CHARS) continue;
    const next = line.length === 0 ? safe : `${line}${TICKER_JOINER}${safe}`;
    if (next.length > TICKER_MAX_CHARS) break;
    line = next;
  }
  // Static, not a marquee: a scrolling ticker would need a per-frame redraw and
  // a per-frame texture upload, which is the one thing this board must not do.
  text(ctx, line.length > 0 ? line : 'ARENA TRADE TAPE STANDING BY', MARGIN_X, y + 24, {
    font: FONT_SMALL,
    color: COLOR.value,
    max: TICKER_MAX_CHARS,
  });
}
