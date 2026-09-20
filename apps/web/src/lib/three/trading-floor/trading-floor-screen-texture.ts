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
 * A PUBLIC LIVE P&L BOARD for the house traders. Founder, 2026-09-20: "our
 * house agents that are going to be trading should have a public p&l board ...
 * put a screen in to show our house bots trading live." Wins and losses alike.
 *
 * THIS FILE PREVIOUSLY ENFORCED THE OPPOSITE, and the correction is worth
 * keeping written down. A peer session relayed a "no surface may claim a house
 * trader is profitable, no P&L" rule; it was adopted without asking the
 * founder, and a day of work went into gates around it — including a sanitiser
 * here that banned "$", "%", every money word and every signed number. The
 * founder's answer was "i never made this rule that you speak of". A rule
 * relayed by a peer is not a founder decision.
 *
 * ── WHAT THE SANITISER IS FOR NOW ───────────────────────────────────────────
 * Text that comes from OUTSIDE still cannot be trusted with a wall in the game
 * world, so `sanitiseScreenText` remains, scoped to hygiene: strip control and
 * zero-width characters, fold look-alikes, cap length, and reject wallet
 * addresses (base58 and EVM). Money words and currency now DRAW.
 *
 * NUMBERS ARE NEVER TEXT. Every figure on this board is formatted here from a
 * TYPED field (`formatSignedUsd`, `formatCount`) and drawn through `value()`,
 * which does not run the untrusted-text pass. No money figure is ever pasted
 * from a server string, and `trading-floor-screen-texture.test.ts` greps this
 * source to prove no literal money figure is hard-coded in it. The realised
 * figure itself is computed server-side over the FULL verified history — a
 * truncated window once flipped Genesis from -5.20 to +8.87 USD.
 *
 * THERE IS NO CHART. A sparkline of scoring tiers lived here for eight layout
 * passes and was deleted when every qualifier moved to the 15px legibility
 * floor: it was the only element with no honesty function, and at the height
 * left for it all three tiers rendered as the same 4px stub, which Codex
 * round 6 caught. A chart that cannot show its own distinctions is decoration
 * impersonating data. The P&L is the number, stated plainly.
 */

import { TRADING_FLOOR_SCREEN } from './trading-floor-room';

/**
 * Realised performance for one house trader, computed SERVER-SIDE.
 *
 * Every field is typed and numeric: the board formats them, so no money figure
 * is ever pasted from a server string. `basis` and `note` are the only free
 * text and they still go through `sanitiseScreenText`.
 *
 * Optional on purpose. A slot with no closed position has nothing realised to
 * report, and a route that has not shipped the block yet must render a board
 * rather than a blank wall.
 */
export interface FloorScreenRealised {
  readonly closedPositions: number;
  readonly wins: number;
  readonly losses: number;
  readonly realisedUsd: number;
  /** NULL, not 0, when nothing has closed — a missing extreme and a flat one
   *  are different facts and the board must not merge them. */
  readonly bestUsd: number | null;
  readonly worstUsd: number | null;
  readonly openPositions: number;
  /**
   * The route's machine codes for HOW the figure was computed, plus the
   * window. These compose the disclosure through the branded path, so the
   * board states the method from data it can check rather than from prose.
   */
  readonly basisCode: string;
  readonly costBasis: string;
  readonly noExitHours: number;
  /**
   * The route's human sentence. FALLBACK ONLY, for a route whose codes this
   * board does not recognise: then the prose is all we have, and it is
   * untrusted text that goes through `sanitiseScreenText`.
   */
  readonly note: string;
  /**
   * TRUE when the route reported unpriced legs, which means the headline figure
   * does not cover every fill. A partial number presented as final is the one
   * dishonesty a P&L board can commit while every figure in it is technically
   * correct, so it is drawn.
   */
  readonly partial: boolean;
  /**
   * Swaps with USDC on neither side (`unclassifiedLegs`). They cannot be valued
   * on the USDC leg at all, so they are excluded from the headline rather than
   * estimated — and the count is drawn, because a figure that silently omits
   * positions is the same lie as a partial one presented as final.
   */
  readonly excludedNonUsdc: number;
  /**
   * FIFO lots written off as a TOTAL LOSS after the no-exit window — how a rug
   * is recorded. Drawn whenever it is above zero, because it is the single
   * number most likely to be missing from a reader's mental model of the
   * headline: without the write-off rule Genesis reads profitable, since its
   * worst position never produced a sell leg.
   */
  readonly noExitClosures: number;
}

/**
 * THREE outcomes, because they are three different facts and a money board may
 * not merge them (orchestrator decision, 2026-09-20).
 *
 * `undefined` used to cover all three, which meant a desk whose figures failed
 * the runtime guard rendered "NO CLOSED POSITIONS YET" — a true statement about
 * a fresh desk and a false one about a broken read. Saying "this trader has not
 * closed anything" when the truth is "we could not read its figures" is the
 * same class of unearned claim as printing a partial number as final.
 *
 *   ready       — a valid block with at least one closed position.
 *   none        — a VALID block reporting zero closed positions. A real fact.
 *   unavailable — the block is missing, or any field failed the type guard.
 */
export type FloorScreenRealisedState =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'none' }
  | ({ readonly kind: 'ready' } & FloorScreenRealised);

export interface FloorScreenSlot {
  /** Lineup label, e.g. "Genesis". Sanitised again at draw time. */
  readonly label: string;
  readonly status: 'live' | 'stopped' | 'waiting';
  readonly verified: number;
  readonly scored: number;
  /** Pre-formatted age, e.g. "4m ago". Never a timestamp, never a price. */
  readonly lastTradeLabel: string;
  /** Omitted entirely by a caller that knows nothing about P&L, which the draw
   *  treats as `unavailable` — the honest reading of "no block". */
  readonly realised?: FloorScreenRealisedState;
}

export interface FloorScreenData {
  readonly phase: 'connecting' | 'error' | 'ready';
  readonly slots: readonly FloorScreenSlot[];
  /**
   * Wall clock for the header, pre-formatted, e.g. "14:32 UTC". Passed in
   * rather than read here so the drawing stays pure and the test can pin it.
   * UTC, not local: the board is a shared public surface and a local reading
   * would be a different fact for every player looking at the same wall.
   */
  readonly clockLabel: string;
  /**
   * Bottom tape, newest entry first, one string per recent trade, e.g.
   * "ANSEM PUMPSWAP 4M". Venue and age only — see `trading-floor-screen-data`
   * for why a real ticker symbol is usually not available and never safe.
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
 * Exported so the legibility test can DERIVE which strings are disclosures
 * rather than list them.
 *
 * The first version of that test selected by four substrings, and the
 * `(PARTIAL)` caption — the most load-bearing qualifier on the card — was
 * invisible to its own floor because nobody had added it to the list. Same
 * enumeration-versus-derivation defect Codex found twice in the signature.
 * `COLOR.muted` IS the "this is secondary text" decision, so the test reads
 * the decision instead of guessing at its consequences.
 */
export const COLOR = {
  background: '#050d16',
  headerBar: '#0b1a28',
  headerText: '#d7f2ff',
  headerSub: '#5f93b4',
  card: '#091624',
  cardEdge: '#1d3b52',
  label: '#e8f7ff',
  value: '#bfe9ff',
  muted: '#6d92ab',
  live: '#3ddc97',
  stopped: '#ffc457',
  waiting: '#54728a',
  tickerBar: '#081420',
  /** P&L up. Same green as the LIVE pill — a live desk and a desk in profit
   *  read as the same kind of good, which is the point of a floor board. */
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
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁯﻿̀-ͯ]/g;

/** A base58 run long enough to be a Solana address. */
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{32,64}/g;
/** An EVM address. Base58 excludes 0/I/O/l, so hex needs its own pass. */
const HEX_ADDRESS = /0x[0-9a-fA-F]{6,}/g;

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
  const text = String(raw ?? '')
    // NFKC folds fullwidth and mathematical look-alikes onto plain ASCII, so a
    // label cannot carry an address past the pass below in another alphabet.
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    // Addresses go BEFORE any case change: base58 excludes `0 O I l`, so
    // upper-casing first would split a real address into sub-32-character
    // pieces and let it through.
    .replace(HEX_ADDRESS, ' ')
    .replace(BASE58_RUN, ' ')
    .replace(DISALLOWED, ' ')
    .replace(WHITESPACE, ' ')
    .trim()
    .toUpperCase();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}.` : text;
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
 * brand symbol is not exported, so the only ways to obtain one are
 * `formatSignedUsd`, `formatCount`, and the `label` tag below.
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
  return brand(`${sign}$${Math.abs(value).toFixed(2)}`);
}

/** Whole counts from a NUMBER. */
export function formatCount(value: number): BoardValue {
  return brand(Number.isFinite(value) ? String(Math.trunc(value)) : '-');
}

/**
 * The method, composed from the route's CODES rather than its prose.
 *
 * The board says how the figure was computed in its own words, keyed on a
 * machine code it recognises. That is stronger than echoing `note`: prose is
 * free server text, so echoing it means the wall asserts whatever the route
 * last wrote, while a code the board does not recognise falls through to the
 * prose fallback and is visibly a fallback.
 *
 * Each phrase is branded at module scope by the `label` tag with no
 * interpolation, which is exactly what the tag is for: a literal this module
 * wrote, admitted to the unsanitised path by construction.
 */
const BASIS_PHRASE: Readonly<Record<string, BoardValue>> = {
  gross_usdc_leg: label`GROSS REALISED ON THE USDC LEG, EXCLUDES NETWORK FEES`,
};
const COST_BASIS_PHRASE: Readonly<Record<string, BoardValue>> = {
  round_trip_fifo: label`ROUND TRIPS MATCHED FIFO BY TOKEN UNITS`,
};

/** Hard ceiling on the basis sentence. Not a display budget — a runaway-input
 *  guard. The route's own note is 161 characters. */
const BASIS_MAX_CHARS = 240;

/**
 * Word-wrap the basis sentence.
 *
 * A basis note is the one string on this board that must NOT be truncated to
 * fit: its whole job is to complete the money claim above it. The route's note
 * grew to 161 characters ("...round trips are matched FIFO by token units; a
 * position with no exit after 24 hours counts as a total loss.") and a 64-char
 * cap cut it mid-word and ended it with a full stop, so it read as a complete
 * sentence that happened to say less. That is worse than no note at all.
 *
 * Monospace, so a character budget IS a width budget. Over `maxLines` the last
 * line ends in "..." — visible, rather than silently complete.
 */
export function wrapBasis(
  sentence: string,
  charsPerLine: number,
  maxLines: number,
): string[] {
  const words = sentence.slice(0, BASIS_MAX_CHARS).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (candidate.length <= charsPerLine) {
      line = candidate;
      continue;
    }
    if (line.length > 0) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line.length > 0) lines.push(line);
  const truncated =
    lines.join(' ').length < sentence.trim().slice(0, BASIS_MAX_CHARS).length;
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1]!;
    lines[lines.length - 1] =
      last.length + 3 <= charsPerLine ? `${last}...` : `${last.slice(0, charsPerLine - 3)}...`;
  }
  return lines;
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

const STATUS_LABEL: Record<FloorScreenSlot['status'], string> = {
  live: 'LIVE',
  stopped: 'STOPPED',
  waiting: 'NOT RUNNING YET',
};

const STATUS_COLOR: Record<FloorScreenSlot['status'], string> = {
  live: COLOR.live,
  stopped: COLOR.stopped,
  waiting: COLOR.waiting,
};

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
 * Draw a BOARD-FORMATTED number. Deliberately skips the untrusted-text pass.
 *
 * These strings are built in this module by `formatSignedUsd` / `formatCount`
 * from typed numeric fields, so there is nothing to sanitise — and running them
 * through the label pass would be wrong in both directions: it upper-cases, and
 * it has no reason to touch the "$" this board exists to show. The split is the
 * invariant: untrusted text goes through `text()`, numbers go through
 * `value()`, and nothing reaches `value()` that did not come from a number.
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
 * Vertical budget, retuned for the 313 px canvas. The board went 650 → 540 →
 * 520 wu tall across three orchestrator revisions (canvas 392 → 325 → 313), so
 * these numbers have been re-derived three times rather than nudged.
 *
 * The header and ticker bars are FIXED height, so every pixel the canvas loses
 * comes out of the cards: header 46 → 40 → 38, ticker 44 → 38 → 36, card body
 * 272 → 225 → 221.
 *
 * The card's internal offsets are hand-placed, so a height change is NOT a
 * constant swap. At 325 the ORIGINAL offsets put the LAST row at y + 174 and
 * the sparkline top at y + 129, i.e. the chart drawn THROUGH the text.
 * `drawFloorScreen` measures nothing, so nothing complained — the bounds test
 * pins only the canvas edges. The paint-order test in the spec file is what
 * catches that class now. Current clearance between the LAST baseline and the
 * sparkline bed: 23 px.
 */
const HEADER_H = 38;
const TICKER_H = 36;
/** 430, not 330: the card now carries a signed USD figure as its headline plus
 *  four two-column rows. Two slots at 430 + an 18 gap still centre inside the
 *  980 px of usable canvas, and `drawFloorScreen` shrinks them for a third. */
const CARD_MAX_W = 430;
const CARD_GAP = 18;
/** Card row baselines, from the card's top edge. */
const ROW_LABEL_Y = 24;
const ROW_STATUS_Y = 46;
const ROW_PNL_CAPTION_Y = 66;
const ROW_PNL_VALUE_Y = 90;
const ROW_WL_Y = 112;
const ROW_EXTREMES_Y = 132;
const ROW_COUNTS_Y = 152;
/** Per-slot disclosures share ONE row: excluded count left, rug write-offs
 *  right. Both are per-slot facts, unlike the basis, which is identical for
 *  every slot and therefore drawn once for the whole board. */
const ROW_DISCLOSURE_Y_FROM_BOTTOM = 5;
/**
 * Board-level basis band, above the ticker.
 *
 * The note is a CONSTANT from the route — the same sentence for every slot —
 * so drawing it per card cost two or three copies of 161 characters and was
 * the reason it did not fit. Once, full width, is both honest and cheap: at
 * 10px monospace the board has ~163 characters per line against the card's
 * ~65, so the sentence that needed three cramped lines per card needs two
 * comfortable ones for the whole board.
 */
const BASIS_BAND_H = 52;
const BASIS_LINE_H = 16;
/** 130, from 980px of usable width at 12px monospace (~7.2px/char = 136), with
 *  margin. THREE lines now, because 12px costs ~26% of the characters 10px fit
 *  and the method sentence must never be the thing that gets cut. */
const BASIS_CHARS_PER_LINE = 105;
const BASIS_MAX_LINES = 3;
/**
 * FLOOR for every disclosure: the basis band, the excluded count and the
 * write-off count. 12 canvas px is 7.1 screen px at the measured spawn scale,
 * just above the 6-7px legibility floor. Pinned by a test, because this is the
 * number that makes the money claim qualified rather than bare.
 */
const DISCLOSURE_MIN_PX = 15;
const DISCLOSURE_FONT = `${DISCLOSURE_MIN_PX}px "Courier New", monospace`;

export function drawFloorScreen(
  ctx: FloorScreenContext,
  data: FloorScreenData,
): void {
  const W = FLOOR_SCREEN_CANVAS.width;
  const H = FLOOR_SCREEN_CANVAS.height;

  ctx.globalAlpha = 1;
  ctx.fillStyle = COLOR.background;
  ctx.fillRect(0, 0, W, H);

  // Header.
  ctx.fillStyle = COLOR.headerBar;
  ctx.fillRect(0, 0, W, HEADER_H);
  ctx.fillStyle = COLOR.live;
  ctx.fillRect(0, HEADER_H - 3, W, 3);
  text(ctx, 'CLAWVILLE TRADING FLOOR', 22, 27, {
    font: 'bold 22px "Courier New", monospace',
    color: COLOR.headerText,
    max: 40,
  });
  // Clock hard right, section title inboard of it. The clock is refreshed by
  // the scene's 30 s tick, so it is a minute-resolution clock on purpose:
  // printing seconds would advertise a precision the redraw budget cannot pay
  // for, and a stuck second hand reads as a dead board.
  text(ctx, data.clockLabel, W - 22, 26, {
    font: 'bold 16px "Courier New", monospace',
    color: COLOR.headerText,
    align: 'right',
    max: 12,
  });
  // W − 118, not W − 132: the clock is 9 characters at 16px Courier (~87 px)
  // plus the 22 px margin, so the section title clears it by 9 px.
  text(ctx, 'HOUSE TRADER BOARD', W - 118, 26, {
    font: '14px "Courier New", monospace',
    color: COLOR.headerSub,
    align: 'right',
    max: 30,
  });

  const bodyTop = HEADER_H + 10;
  // The basis band sits between the cards and the ticker, so the cards give up
  // its height rather than the note being squeezed into each of them.
  const bodyBottom = H - TICKER_H - BASIS_BAND_H - 4;
  const bodyHeight = bodyBottom - bodyTop;

  if (data.phase !== 'ready' || data.slots.length === 0) {
    // "Connecting" is the honest state while the query is in flight. It is
    // never a spinner and never an empty card: an empty card would imply a
    // paired trader with no trades, which is a different fact.
    const message =
      data.phase === 'error'
        ? 'FLOOR DATA UNAVAILABLE'
        : data.phase === 'ready'
          ? 'NO HOUSE TRADERS LISTED'
          : 'CONNECTING TO THE FLOOR';
    text(ctx, message, W / 2, bodyTop + bodyHeight / 2, {
      font: 'bold 26px "Courier New", monospace',
      color: COLOR.muted,
      align: 'center',
      max: 40,
    });
    drawTicker(ctx, data, W, H);
    return;
  }

  const count = data.slots.length;
  const available = W - 44;
  const cardW = Math.min(
    CARD_MAX_W,
    (available - CARD_GAP * (count - 1)) / count,
  );
  const rowW = cardW * count + CARD_GAP * (count - 1);
  let x = (W - rowW) / 2;

  for (const slot of data.slots) {
    drawCard(ctx, slot, x, bodyTop, cardW, bodyHeight);
    x += cardW + CARD_GAP;
  }

  drawBasisBand(ctx, data, W, bodyBottom + BASIS_LINE_H);
  drawTicker(ctx, data, W, H);
}

function drawCard(
  ctx: FloorScreenContext,
  slot: FloorScreenSlot,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.fillStyle = COLOR.card;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COLOR.cardEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.fillStyle = STATUS_COLOR[slot.status];
  ctx.fillRect(x, y, 6, h);

  const pad = 18;
  // 16, not 18. Courier advances ~0.6em, so bold 26px is ~15.6 px/char against
  // `CARD_MAX_W - 2 * pad` = 294 px of usable card. `drawFloorScreen` measures
  // no text, so the truncation length IS the overflow guard.
  text(ctx, slot.label, x + pad, y + ROW_LABEL_Y, {
    font: 'bold 26px "Courier New", monospace',
    color: COLOR.label,
    max: 16,
  });
  text(ctx, STATUS_LABEL[slot.status], x + pad, y + ROW_STATUS_Y, {
    font: 'bold 14px "Courier New", monospace',
    color: STATUS_COLOR[slot.status],
    max: 20,
  });

  // ── THE HEADLINE: realised P&L ────────────────────────────────────────────
  // A slot with no block at all is UNAVAILABLE, not empty: "no block" is a
  // statement about our read, never about the trader.
  const state: FloorScreenRealisedState = slot.realised ?? { kind: 'unavailable' };
  const realised = state.kind === 'ready' ? state : null;
  const small = DISCLOSURE_FONT;
  const right = x + w - pad;

  text(
    ctx,
    realised?.partial ? 'REALISED P&L (PARTIAL)' : 'REALISED P&L',
    x + pad,
    y + ROW_PNL_CAPTION_Y,
    // DISCLOSURE font, not a caption font. "(PARTIAL)" is the single most
    // load-bearing qualification on the card — it says the big number above it
    // does not cover every fill — so it belongs to the same legibility floor as
    // the band. The brief named the band and the two count lines; this is the
    // same class and was left at 11px, which is 6.5 screen px at the 768
    // contract, under the floor. Sweeping the class, not the instance.
    { font: DISCLOSURE_FONT, color: COLOR.muted, max: 24 },
  );
  if (realised) {
    value(ctx, formatSignedUsd(realised.realisedUsd), right, y + ROW_PNL_VALUE_Y, {
      font: 'bold 30px "Courier New", monospace',
      color: pnlColor(realised.realisedUsd),
      align: 'right',
    });
    value(
      ctx,
      label`W ${formatCount(realised.wins)}  L ${formatCount(realised.losses)}`,
      x + pad,
      y + ROW_WL_Y,
      // 15px, not 13: the derived legibility test caught this one, which my
      // hand-written substring list had missed exactly as it missed the
      // caption. Wins and losses ARE part of the qualification — a headline
      // without its win/loss split invites the reader to assume a streak.
      { font: `bold ${DISCLOSURE_MIN_PX}px "Courier New", monospace`, color: COLOR.value },
    );
    // CLOSED and OPEN together: both are position counts, and pairing them is
    // what frees the counts row below to hold ONE left-aligned string. `OPEN`
    // used to sit at `x + pad` on the merged row and painted straight over
    // `VERIFIED` — Codex round 7 P1, invisible to a paint-order pin that only
    // watched text against later RECTS.
    value(
      ctx,
      label`CLOSED ${formatCount(realised.closedPositions)}  OPEN ${formatCount(realised.openPositions)}`,
      right,
      y + ROW_WL_Y,
      { font: small, color: COLOR.muted, align: 'right' },
    );
    // A null extreme prints as "-", never as $0.00: "no worst trade yet" and
    // "worst trade broke even" are different facts. `formatSignedUsd` owns that
    // dash now, so the null case cannot be spelled differently in two places.
    value(
      ctx,
      label`BEST ${formatSignedUsd(realised.bestUsd)}`,
      x + pad,
      y + ROW_EXTREMES_Y,
      { font: small, color: realised.bestUsd === null ? COLOR.muted : pnlColor(realised.bestUsd) },
    );
    value(
      ctx,
      label`WORST ${formatSignedUsd(realised.worstUsd)}`,
      right,
      y + ROW_EXTREMES_Y,
      {
        font: small,
        color: realised.worstUsd === null ? COLOR.muted : pnlColor(realised.worstUsd),
        align: 'right',
      },
    );
  } else {
    // Two different absences, two different words. NEITHER is a zero: "$0.00"
    // would claim a flat result, which is a third fact again.
    //   none        -> the desk really has closed nothing. About the TRADER.
    //   unavailable -> we could not read its figures. About OUR READ.
    text(
      ctx,
      state.kind === 'none' ? 'NO CLOSED POSITIONS YET' : 'P&L UNAVAILABLE',
      right,
      y + ROW_PNL_VALUE_Y - 6,
      {
        font: 'bold 15px "Courier New", monospace',
        color: COLOR.muted,
        align: 'right',
        max: 26,
      },
    );
  }

  // COUNTS and LAST share one row now. Every de-emphasised string on this card
  // is at the disclosure floor, and eight rows at 15px overflowed the card by
  // 24px before anything else was drawn — merging the two count rows is what
  // bought the height back without dropping a fact.
  // ONE left string, ONE right string. Three left-aligned columns on a 394px
  // card were fragile at 15px: "VERIFIED 1234" and "SCORED 1234" and a 16
  // character "time unavailable" collide at their worst case, and the worst
  // case is a real state this board renders.
  value(
    ctx,
    label`VERIFIED ${formatCount(slot.verified)} / SCORED ${formatCount(slot.scored)}`,
    x + pad,
    y + ROW_COUNTS_Y,
    { font: small, color: COLOR.muted },
  );
  text(ctx, slot.lastTradeLabel, right, y + ROW_COUNTS_Y, {
    font: small,
    color: COLOR.value,
    align: 'right',
    max: 20,
  });

  // SPARKLINE REMOVED 2026-09-20 for the 15px disclosure floor. Signed off by
  // the orchestrator and recorded in FOUNDER-REVIEW.md.
  //
  // It was squeezed 54 → 44 → 32 → 26 → 22 → 12 → 10 px across eight layout
  // passes, and at 15px disclosures the card has no room for it at all. It was
  // the only element on the card with no honesty function: scoring-TIER shape,
  // which the tape (recent trades, newest first) and the counts already carry
  // between them. A chart small enough to be unreadable is decoration
  // impersonating data, which on a money board is its own small dishonesty.
  // tf3d-interior2 and I pre-agreed this ordering: drop the sparkline before
  // the disclosure, because the disclosure is the only thing that qualifies
  // the number above it.

  // Per-slot disclosures, one row, both only when they have something to say.
  if (realised) {
    const disclosureY = y + h - ROW_DISCLOSURE_Y_FROM_BOTTOM;
    const tiny = DISCLOSURE_FONT;
    if (realised.excludedNonUsdc > 0) {
      value(
        ctx,
        // SHORTER at 15px, deliberately. At 9px per character the long forms
        // were 333px and 189px against 394px of usable card and would have
        // overlapped each other. The alternatives were a second disclosure row
        // (which the card cannot afford) or deleting the sparkline; keeping the
        // fact and shortening its wording costs the least. The band below
        // spells out what "non-USDC" and "no-exit" mean, in full, at 15px.
        label`${formatCount(realised.excludedNonUsdc)} NON-USDC EXCLUDED`,
        x + pad,
        disclosureY,
        { font: tiny, color: COLOR.stopped },
      );
    }
    // A total loss booked by a TIMER rather than by a sell. Drawn even when the
    // board-level basis sentence explains the rule, because a reader who takes
    // in one card must still see that a write-off is inside its headline.
    if (realised.noExitClosures > 0) {
      value(
        ctx,
        label`${formatCount(realised.noExitClosures)} NO-EXIT WRITE-OFF`,
        x + w - pad,
        disclosureY,
        { font: tiny, color: COLOR.stopped, align: 'right' },
      );
    }
  }
}


/**
 * The basis sentence, ONCE for the whole board.
 *
 * Taken from the first slot that has figures. The note is a constant on the
 * route, so every ready slot carries the same string; reading it from the data
 * rather than hard-coding it means the board cannot state a method the server
 * is no longer using. If nothing is ready there is no money on screen, so
 * there is nothing to qualify.
 */
function drawBasisBand(
  ctx: FloorScreenContext,
  data: FloorScreenData,
  W: number,
  firstLineY: number,
): void {
  const first = data.slots.find((slot) => slot.realised?.kind === 'ready');
  const realised = first?.realised?.kind === 'ready' ? first.realised : null;
  if (!realised) return;
  const font = DISCLOSURE_FONT;

  // PREFERRED: composed from typed codes, drawn through the branded path.
  //
  // `noExitClosures` is deliberately NOT here even though it belongs to the
  // same disclosure: it is PER-SLOT, and this band speaks for the whole board.
  // One desk's write-offs printed across the floor would attribute them to
  // every trader on it. It stays on the card, beside the excluded count.
  const composed = composeMethod(realised);
  if (composed) {
    wrapBoardValues(composed, BASIS_CHARS_PER_LINE, BASIS_MAX_LINES).forEach(
      (line, index) => {
        value(ctx, line, 22, firstLineY + index * BASIS_LINE_H, {
          font,
          color: COLOR.muted,
        });
      },
    );
    return;
  }

  // FALLBACK: the route used codes this board does not know, so its prose is
  // all we have. Untrusted text, so it goes through the sanitised path.
  const note = realised.note;
  if (note.trim().length === 0) return;
  wrapBasis(note, BASIS_CHARS_PER_LINE, BASIS_MAX_LINES).forEach((line, index) => {
    text(ctx, line, 22, firstLineY + index * BASIS_LINE_H, {
      font,
      color: COLOR.muted,
      // The wrap already fits the width; this only bounds a runaway input, and
      // must stay ABOVE `BASIS_CHARS_PER_LINE` or it would re-introduce the
      // mid-word truncation this band exists to fix.
      max: BASIS_CHARS_PER_LINE + 4,
    });
  });
}

/**
 * The method as branded phrases, or null when a code is unrecognised.
 *
 * All-or-nothing: a half-composed method would state the parts the board
 * happens to know and silently drop the rest, which is the truncation defect
 * again wearing a different shape.
 */
function composeMethod(realised: FloorScreenRealised): BoardValue[] | null {
  const basis = BASIS_PHRASE[realised.basisCode];
  const cost = COST_BASIS_PHRASE[realised.costBasis];
  if (!basis || !cost || !Number.isFinite(realised.noExitHours)) return null;
  return [
    basis,
    cost,
    label`NO EXIT AFTER ${formatCount(realised.noExitHours)} HOURS = TOTAL LOSS`,
  ];
}

/**
 * Join branded phrases with " / " and wrap them, keeping the brand.
 *
 * Re-branding each output line is sound because every input was branded and
 * wrapping only splits on spaces: no character enters here that was not
 * already admitted to the unsanitised path.
 */
function wrapBoardValues(
  parts: readonly BoardValue[],
  charsPerLine: number,
  maxLines: number,
): BoardValue[] {
  // PHRASE-ATOMIC packing, not word wrap. A method clause split across a line
  // break ("... = TOTAL / LOSS") is harder to read than the same clause moved
  // whole to the next line, and each part here IS one clause. Breaking between
  // clauses is free; breaking inside one costs the reader.
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    const candidate = line.length === 0 ? part : `${line} / ${part}`;
    if (candidate.length <= charsPerLine) {
      line = candidate;
      continue;
    }
    if (line.length > 0) lines.push(line);
    line = part;
  }
  if (line.length > 0) lines.push(line);
  // A single clause longer than a line still has to break somewhere, and a
  // run over the line budget falls back to the word wrapper rather than
  // overflowing the canvas.
  return lines
    .flatMap((one) =>
      one.length <= charsPerLine ? [one] : wrapBasis(one, charsPerLine, maxLines),
    )
    .slice(0, maxLines)
    .map(brand);
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

  // The tape is the recent trades themselves, newest first — the cards already
  // carry the counts, so repeating them here spent the one wide row on nothing
  // new. Entries are venue + age (and a listed token symbol when there is one);
  // see `trading-floor-screen-data.ts` for why never a price and never a mint.
  const line =
    data.tape.length > 0
      ? data.tape.join('   ///   ')
      : 'LIVE TRADE TAPE STANDING BY';
  // Static, not a marquee: a scrolling ticker would need a per-frame redraw and
  // a per-frame texture upload, which is the one thing this board must not do.
  //
  // 95, not 150. 17px Courier is ~10.2 px/char and the row starts at x = 22 on
  // a 1024 px canvas, so 150 characters would have run ~500 px off the edge.
  // The truncation IS the overflow guard: `drawFloorScreen` measures no text.
  text(ctx, line, 22, y + 24, {
    font: '15px "Courier New", monospace',
    color: COLOR.value,
    max: 95,
  });
}
