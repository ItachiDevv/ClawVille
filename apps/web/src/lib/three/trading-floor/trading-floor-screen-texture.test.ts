import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FLOOR_ARENA_MAX_OPEN_POSITIONS,
  FLOOR_ARENA_PAPER_COSTS,
  FLOOR_ARENA_POSITION_USD,
  FLOOR_ARENA_TEMPLATES,
} from '@clawville/shared';

import {
  BOARD_MIN_PX,
  COLOR,
  COLUMN_BIG_CHARS,
  COLUMN_LINE_CHARS,
  compactMagnitude,
  drawFloorScreen,
  FLOOR_SCREEN_CANVAS,
  FLOOR_SCREEN_COIN_WORD,
  FLOOR_SCREEN_COLUMNS,
  FLOOR_SCREEN_SKIP_WORDS,
  FLOOR_SCREEN_STRATEGY_WORDS,
  FLOOR_SCREEN_PAGE_MS,
  floorScreenLineCount,
  formatCount,
  formatExitRule,
  formatMarkMultiple,
  formatPercent,
  formatSignedUsd,
  formatUsd,
  pickCanvasScale,
  pnlColor,
  sanitiseScreenText,
  skipWord,
  type FloorScreenColumn,
  type FloorScreenContext,
  type FloorScreenData,
  type FloorScreenExits,
  type FloorScreenLeaderRow,
  type FloorScreenSize,
} from './trading-floor-screen-texture';
import { TRADING_FLOOR_SCREEN } from './trading-floor-room';
import { tapeSymbol } from './trading-floor-trade-tape';

// P15 T2 (ops/house-traders/arena-review/P15_PLAN_2026-10-02.md §1 + §6): the
// big screen is five equal house-agent columns. Failing-first tests. The lead
// confirmed the plan corrections on 2026-10-02 (names 24 px only up to 12
// characters, scan line `<passed>/<evaluated> OK`, the three footer forms,
// FLOOR_ARENA_MAX_OPEN_POSITIONS, the exit-line fallbacks, the skip words, the
// countdown with minutes, a missing row prints N/A or "-"); each is pinned here.

/**
 * Recording 2D context. `drawFloorScreen` never measures or reads back, so a
 * recorder is a complete stand-in for the real canvas and the test exercises
 * the SHIPPING draw code rather than a parallel description of it.
 */
type Painted =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill?: string }
  | {
      kind: 'text';
      x: number;
      y: number;
      value: string;
      font: string;
      align: CanvasTextAlign;
      fill: string;
    };
type PaintedText = Extract<Painted, { kind: 'text' }>;
type PaintedRect = Extract<Painted, { kind: 'rect' }>;

/**
 * An APPROXIMATE glyph box for a `fillText` call: a 0.6 em monospace advance
 * and a pessimistic 0.72 / 0.2 em rise and drop. No 2D context exists in this
 * runtime to measure with; a box beats an anchor point (an anchor misses
 * right-aligned glyphs and glyph bodies above the baseline).
 */
function textBox(t: PaintedText) {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(t.font)?.[1] ?? 14);
  const width = 0.6 * size * t.value.length;
  const left =
    t.align === 'right' ? t.x - width : t.align === 'center' ? t.x - width / 2 : t.x;
  return {
    left,
    right: left + width,
    top: t.y - size * 0.72,
    bottom: t.y + size * 0.2,
  };
}

function boxHitsRect(box: ReturnType<typeof textBox>, rect: PaintedRect): boolean {
  return (
    box.left < rect.x + rect.w &&
    box.right > rect.x &&
    box.top < rect.y + rect.h &&
    box.bottom > rect.y
  );
}

/** No fill painted AFTER a string may cover it. */
function assertNoFillOverText(painted: Painted[]): void {
  for (let i = 0; i < painted.length; i += 1) {
    const drawn = painted[i]!;
    if (drawn.kind !== 'text') continue;
    const box = textBox(drawn);
    for (let j = i + 1; j < painted.length; j += 1) {
      const later = painted[j]!;
      if (later.kind !== 'rect') continue;
      const covered = boxHitsRect(box, later);
      expect({ text: drawn.value, covered }).toEqual({ text: drawn.value, covered: false });
    }
  }
}

/** Every pair of strings, both ways. Pessimistic estimator; do not loosen it. */
function assertNoTextOverlap(painted: Painted[]): void {
  const texts = painted.filter((p): p is PaintedText => p.kind === 'text');
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = textBox(texts[i]!);
      const b = textBox(texts[j]!);
      const overlap =
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      expect({ a: texts[i]!.value, b: texts[j]!.value, overlap }).toEqual({
        a: texts[i]!.value,
        b: texts[j]!.value,
        overlap: false,
      });
    }
  }
}

function recorder() {
  const strings: string[] = [];
  const painted: Painted[] = [];
  const context = {
    fillStyle: '' as string,
    strokeStyle: '' as string,
    lineWidth: 0,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    globalAlpha: 1,
    fillRect: (x: number, y: number, w: number, h: number) => {
      painted.push({ kind: 'rect', x, y, w, h, fill: String(context.fillStyle) });
    },
    strokeRect: () => undefined,
    fillText: (value: string, x: number, y: number) => {
      strings.push(value);
      painted.push({
        kind: 'text',
        x,
        y,
        value,
        font: context.font,
        align: context.textAlign,
        fill: String(context.fillStyle),
      });
    },
  };
  return { context: context as unknown as FloorScreenContext, strings, painted };
}

/** A base58 run long enough to be a Solana address. */
const ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,64}/;
const HEX_ADDRESS = /0x[0-9a-fA-F]{6,}/i;
const INVISIBLE = /[\u0000-\u001f­​-‏‪-‮﻿]/;

/**
 * "Did this address survive, in any readable form?" A 16-character window
 * slides over the address and none may survive anywhere in the drawn text
 * (non-alphanumerics removed, so a leak split by a space is still caught).
 */
function assertAddressAbsent(strings: string[], address: string): void {
  const upper = address.toUpperCase();
  const haystack = strings
    .map((value) => value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())
    .join(' ');
  for (let i = 0; i + 16 <= upper.length; i += 1) {
    const window = upper.slice(i, i + 16);
    expect({ window, present: haystack.includes(window) }).toEqual({ window, present: false });
  }
}

/** The widest string the board draws by design is the footer (75 characters at 22 px). */
function assertDrawable(strings: string[]) {
  expect(strings.length).toBeGreaterThan(0);
  for (const value of strings) {
    expect({
      value,
      base58: ADDRESS.test(value),
      hex: HEX_ADDRESS.test(value),
      invisible: INVISIBLE.test(value),
      nan: /NAN/i.test(value),
      tooLong: value.length > 75,
    }).toEqual({ value, base58: false, hex: false, invisible: false, nan: false, tooLong: false });
  }
}

function fontPx(font: string): number {
  return Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? Number.NaN);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The 1024 x 313 canvas the plan lays out against (R1 keeps 313 too). */
const SIZE: FloorScreenSize = { width: 1024, height: 313 };
const HEADER_H = 36;
const FOOTER_H = 28;
const GUTTER = 6;

const BASIS = {
  positionUsd: 20,
  buyCostPct: 2.5,
  sellCostPct: 1,
  maxOpen: 5,
} as const;

const MINT = '7xKXtg2CW3eTA1hqzVfKp8mKQqZ9rPfLmNbVcXyZaQw1';

/** One drawable column. The P&L default is a LOSS on purpose. */
function column(overrides: Partial<FloorScreenColumn> = {}): FloorScreenColumn {
  return {
    name: 'Genesis',
    templateId: 'genesis',
    mode: 'paper',
    status: 'active',
    known: true,
    exits: { tpMult: 1.1, stopMult: null, maxHoldS: 900 },
    scan: { evaluated: 412, passed: 3, topSkipCode: 'liq' },
    watching: { symbol: 'BONK' },
    openCount: 2,
    newest: { symbol: 'BONK', markMult: 1.04 },
    realisedUsd: -5.2,
    wins: 7,
    losses: 10,
    ...overrides,
  };
}

/** The five house agents with their template exits, as the live board will look. */
function houseColumns(overrides: Partial<FloorScreenColumn> = {}): FloorScreenColumn[] {
  return FLOOR_ARENA_TEMPLATES.map((template) =>
    column({
      name: template.displayName,
      templateId: template.id,
      exits: {
        tpMult: template.params.exits.tp[0]?.[0] ?? null,
        stopMult: template.params.exits.stop_mult,
        maxHoldS: template.params.exits.max_hold_s,
      },
      ...overrides,
    }),
  );
}

function board(data: Partial<FloorScreenData> = {}): FloorScreenData {
  return {
    phase: 'ready',
    page: 'house',
    columns: houseColumns(),
    leaderboard: { phase: 'ready', rows: [] },
    window: 'contest',
    countdownLabel: 'ENDS IN 3D 15H 59M',
    clockLabel: '14:32 UTC',
    basis: BASIS,
    ...data,
  };
}

function draw(data: Partial<FloorScreenData> = {}, size: FloorScreenSize = SIZE) {
  const rec = recorder();
  drawFloorScreen(rec.context, board(data), size);
  return rec;
}

/** Texts whose baseline sits in the column body (between header and footer). */
function bodyTexts(painted: Painted[], size: FloorScreenSize = SIZE): PaintedText[] {
  return painted.filter(
    (p): p is PaintedText => p.kind === 'text' && p.y > HEADER_H && p.y < size.height - FOOTER_H,
  );
}

function columnIndexOf(box: ReturnType<typeof textBox>, size: FloorScreenSize): number {
  return Math.floor((box.left + box.right) / 2 / (size.width / FLOOR_SCREEN_COLUMNS));
}

/** The strings drawn in column `index`, top to bottom. */
function columnStrings(painted: Painted[], index: number, size: FloorScreenSize = SIZE): string[] {
  return bodyTexts(painted, size)
    .filter((t) => columnIndexOf(textBox(t), size) === index)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((t) => t.value);
}

function footerText(painted: Painted[], size: FloorScreenSize = SIZE): string[] {
  return painted
    .filter((p): p is PaintedText => p.kind === 'text' && p.y >= size.height - FOOTER_H)
    .map((t) => t.value);
}

function headerTexts(painted: Painted[]): string[] {
  return painted
    .filter((p): p is PaintedText => p.kind === 'text' && p.y <= HEADER_H)
    .map((t) => t.value);
}

/**
 * Plan §6: every glyph box inside its own column (the 6 px gutter on each
 * side), between the header and the footer.
 */
function assertColumnsContained(painted: Painted[], size: FloorScreenSize = SIZE): void {
  const width = size.width / FLOOR_SCREEN_COLUMNS;
  for (const t of bodyTexts(painted, size)) {
    // The one full-width string: the message before the first data, when no column is drawn.
    if (t.value === 'CONNECTING TO THE ARENA' || t.value === 'ARENA DATA UNAVAILABLE') continue;
    const box = textBox(t);
    const index = columnIndexOf(box, size);
    const inside =
      index >= 0 &&
      index < FLOOR_SCREEN_COLUMNS &&
      box.left >= index * width + GUTTER - 1e-6 &&
      box.right <= (index + 1) * width - GUTTER + 1e-6 &&
      box.top >= HEADER_H &&
      box.bottom <= size.height - FOOTER_H;
    expect({ value: t.value, index, inside }).toEqual({ value: t.value, index, inside: true });
  }
}

/** Every string and every fill inside the canvas. */
function assertInsideCanvas(painted: Painted[], size: FloorScreenSize = SIZE): void {
  for (const p of painted) {
    if (p.kind === 'rect') {
      const inside =
        p.x >= 0 && p.y >= 0 && p.x + p.w <= size.width + 1e-3 && p.y + p.h <= size.height + 1e-3;
      expect({ rect: [p.x, p.y, p.w, p.h], inside }).toEqual({ rect: [p.x, p.y, p.w, p.h], inside: true });
      continue;
    }
    const box = textBox(p);
    const inside = box.left >= 0 && box.right <= size.width && box.top >= 0 && box.bottom <= size.height;
    expect({ value: p.value, inside }).toEqual({ value: p.value, inside: true });
  }
}

const EXTREME_EXITS: FloorScreenExits[] = [
  { tpMult: 1.01, stopMult: 0.99, maxHoldS: 60 },
  { tpMult: 10, stopMult: 0.3, maxHoldS: 86_400 },
  { tpMult: 10, stopMult: null, maxHoldS: 86_400 },
  { tpMult: null, stopMult: 0.3, maxHoldS: 5_400 },
  { tpMult: Number.NaN, stopMult: Number.NaN, maxHoldS: Number.NaN },
];

/** The widest thing each line can hold, all at once (plan §6 fixture sweep). */
function extremeColumns(): FloorScreenColumn[] {
  return [
    column({
      name: 'MID-CAP CLIMBER',
      templateId: 'midcap-climber',
      status: 'stopped',
      exits: EXTREME_EXITS[1]!,
      scan: { evaluated: 99_999, passed: 99_999, topSkipCode: 'source_not_tradeable' },
      watching: { symbol: 'WWWWWWWW' },
      openCount: 99_999,
      newest: { symbol: 'MMMMMMMM', markMult: 999.4 },
      realisedUsd: -99_999.99,
      wins: 99_999,
      losses: 99_999,
    }),
    column({
      name: 'W'.repeat(13),
      templateId: 'runner',
      mode: 'live',
      status: 'paused',
      exits: EXTREME_EXITS[0]!,
      scan: { evaluated: 100_000, passed: 1e9, topSkipCode: 'chg24h_max' },
      watching: null,
      newest: { symbol: 'WWWWWWWW', markMult: 1e9 },
      realisedUsd: 99_999.99,
    }),
    column({
      name: 'WWWWWWW '.repeat(5),
      templateId: 'dip-hunter',
      mode: null,
      status: null,
      known: false,
      exits: null,
      scan: null,
      watching: null,
      openCount: Number.NaN,
      newest: null,
      realisedUsd: null,
      wins: Number.NaN,
      losses: Number.NaN,
    }),
    column({
      name: '',
      templateId: 'no-such-template',
      mode: 'live',
      status: null,
      exits: EXTREME_EXITS[3]!,
      scan: { evaluated: 99_999, passed: 0, topSkipCode: 'not-a-code' },
      watching: null,
      newest: { symbol: '', markMult: 9.996 },
      realisedUsd: 1e12,
    }),
    column({
      name: 'LATE BLOOMER',
      templateId: 'late-bloomer',
      status: 'stopped',
      exits: EXTREME_EXITS[4]!,
      scan: null,
      watching: { symbol: 'MMMMMMMM' },
      newest: { symbol: 'WWWWWWWW', markMult: 99.96 },
      realisedUsd: Number.NaN,
    }),
  ];
}

/** Every board shape the geometry pins sweep. */
function sweepBoards(): FloorScreenData[] {
  const boards: FloorScreenData[] = [
    board(),
    board({ columns: extremeColumns() }),
    board({ columns: extremeColumns().reverse(), window: '24h', countdownLabel: 'STARTS IN 27000D 03H 12M', clockLabel: 'CLOCK OFFLINE' }),
    board({ columns: houseColumns({ mode: 'live' }) }),
    board({ columns: houseColumns({ known: false, mode: null, status: null, exits: null, scan: null, watching: null, openCount: Number.NaN, newest: null, realisedUsd: null, wins: Number.NaN, losses: Number.NaN }) }),
    board({ phase: 'connecting', columns: [] }),
    board({ phase: 'error', columns: [], countdownLabel: null }),
  ];
  for (const exits of EXTREME_EXITS) boards.push(board({ columns: houseColumns({ exits }) }));
  for (const realisedUsd of [99_999.99, -99_999.99, 0, null, Number.NaN]) {
    boards.push(board({ columns: houseColumns({ realisedUsd, wins: 99_999, losses: 99_999 }) }));
  }
  const codes = Object.keys(FLOOR_SCREEN_SKIP_WORDS);
  for (let i = 0; i < codes.length; i += FLOOR_SCREEN_COLUMNS) {
    const chunk = codes.slice(i, i + FLOOR_SCREEN_COLUMNS);
    boards.push(
      board({
        columns: houseColumns().map((c, k) => ({
          ...c,
          watching: null,
          scan: { evaluated: 99_999, passed: 99_999, topSkipCode: chunk[k] ?? null },
        })),
      }),
    );
  }
  return boards;
}

const HEIGHTS = [313, 346, 260] as const;

// ---------------------------------------------------------------------------
// Hygiene: text from outside never reaches the wall unfiltered
// ---------------------------------------------------------------------------

describe('Trading Floor board — untrusted text hygiene', () => {
  test('a normal board and every loading or error state draw only clean strings', () => {
    assertDrawable(draw().strings);
    assertDrawable(draw({ phase: 'connecting', columns: [] }).strings);
    assertDrawable(draw({ phase: 'error', columns: [] }).strings);
    for (const data of sweepBoards()) {
      const rec = recorder();
      drawFloorScreen(rec.context, data, SIZE);
      assertDrawable(rec.strings);
    }
  });

  test('a wallet address in a name or a symbol never reaches the board', () => {
    const evm = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
    for (const address of [MINT, evm]) {
      const hostile = draw({
        columns: houseColumns({
          name: `Genesis ${address}`,
          watching: { symbol: address },
          newest: { symbol: address, markMult: 1.2 },
        }),
        clockLabel: `14:32 ${address}`,
        countdownLabel: `ENDS ${address}`,
      });
      assertDrawable(hostile.strings);
      assertAddressAbsent(hostile.strings, address);
    }
  });

  test('a symbol that sanitises to nothing prints COIN, never a blank or a fragment', () => {
    const drawn = draw({
      columns: houseColumns({ watching: { symbol: MINT }, newest: { symbol: '​', markMult: 1.04 } }),
    });
    expect(drawn.strings).toContain('WATCH COIN');
    expect(drawn.strings).toContain('COIN 1.04X');
    expect(FLOOR_SCREEN_COIN_WORD).toBe('COIN');
  });

  test('a name the wall cannot paint still gets words, and they describe the wall', () => {
    const drawn = draw({ columns: houseColumns({ name: 'Трейдер' }) });
    expect(columnStrings(drawn.painted, 0)[0]).toBe('NAME NOT SHOWN');
    expect(columnStrings(draw({ columns: houseColumns({ name: MINT }) }).painted, 0)[0]).toBe(
      'NAME NOT SHOWN',
    );
  });

  // AN ADDRESS SPLIT BY AN INVISIBLE CHARACTER (tfs-audit + tfs-api,
  // 2026-09-20): NFKC composed `p` + U+0301 into one character the strip did
  // not know, and the two halves printed. Exact output, not a window detector.
  test.each([
    ['a combining acute', 0x0301],
    ['a zero-width space', 0x200b],
    ['a soft hyphen', 0x00ad],
    ['a word joiner', 0x2060],
    ['a high combining mark U+1AB0', 0x1ab0],
    ['a variation selector U+FE0F', 0xfe0f],
  ])('an address split by %s still never reaches the board', (_name, codePoint) => {
    const address = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const split = `note ${address.slice(0, 20)}${String.fromCharCode(codePoint)}${address.slice(20)}`;
    expect(sanitiseScreenText(split, 200)).toBe('NOTE');
    const drawn = draw({ columns: houseColumns({ name: split }) });
    assertDrawable(drawn.strings);
    assertAddressAbsent(drawn.strings, address);
  });

  test('an address peppered with combining marks is still removed entirely', () => {
    const address = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const peppered = address.replace(/(.{8})/g, `$1${String.fromCharCode(0x0301)}`);
    expect(sanitiseScreenText(`note ${peppered}`, 200)).toBe('NOTE');
  });

  test.each([
    ['an UPPERCASE 0X prefix', 'note 0XdeadBEEF1234567890abcdef'],
    ['a lowercase 0x prefix', 'note 0xdeadBEEF1234567890abcdef'],
    ['hex with no prefix at all', 'note deadBEEF1234567890abcdef1234'],
  ])('%s never reaches the board', (_name, input) => {
    expect(sanitiseScreenText(input, 200)).toBe('NOTE');
  });

  test('a hex run inside a base58 run cannot split it into printable halves', () => {
    expect(sanitiseScreenText(`note ${'G'.repeat(12)}${'a'.repeat(20)}${'H'.repeat(12)}`, 200)).toBe('NOTE');
  });

  test('a base58 run longer than an address leaves no tail', () => {
    const address = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    expect(sanitiseScreenText(`note ${address}${address}`, 200)).toBe('NOTE');
  });

  test('look-alikes fold, invisibles go, length is capped, and the pass is linear', () => {
    expect(sanitiseScreenText('ＧＥＮＥＳＩＳ', 40)).toBe('GENESIS');
    expect(sanitiseScreenText('Café desk', 40)).toBe('CAFE DESK');
    expect(sanitiseScreenText('Gen​esis\u0000 🚀', 40)).toBe('GENESIS');
    expect(sanitiseScreenText('A'.repeat(80), 16).length).toBeLessThanOrEqual(16);
    const started = performance.now();
    sanitiseScreenText('A1'.repeat(60_000));
    sanitiseScreenText('1'.repeat(60_000));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test.each([
    ['a dollar figure in a label', '$GENESIS', '$GENESIS'],
    ['a percentage', 'UP 40%', 'UP 40%'],
    ['a signed number', '+420', '+420'],
    ['an underscore compound', 'UP_10', 'UP 10'],
  ])('%s survives the sanitiser — the board publishes money', (_name, input, expected) => {
    expect(sanitiseScreenText(input, 40)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// The exports other files import stay exactly as they were
// ---------------------------------------------------------------------------

describe('Trading Floor board — exports the trade tape imports', () => {
  test('sanitiseScreenText and compactMagnitude keep their names and behaviour', () => {
    expect(typeof sanitiseScreenText).toBe('function');
    expect(typeof compactMagnitude).toBe('function');
    expect(sanitiseScreenText('Mid-Cap Climber')).toBe('MID-CAP CLIMBER');
    // Default cap 26: 25 characters and a cut mark. (A bare 'A' run would be a
    // base58 address and sanitise to nothing.)
    expect(sanitiseScreenText('WWWWW '.repeat(8))).toBe('WWWWW WWWWW WWWWW WWWWW W.');
    expect(compactMagnitude(123_456)).toBe('123.5K');
    expect(compactMagnitude(1.2e6)).toBe('1.2M');
    expect(compactMagnitude(999.9e12)).toBe('999.9T');
    expect(compactMagnitude(1e18)).toBeNull();
    // The tape still reaches them through its own import.
    const tape = readFileSync(join(import.meta.dir, 'trading-floor-trade-tape.ts'), 'utf8');
    expect(tape).toContain("import { compactMagnitude, sanitiseScreenText } from './trading-floor-screen-texture';");
    expect(tapeSymbol('$PEPE')).toBe('PEPE');
  });
});

// ---------------------------------------------------------------------------
// PROVENANCE. Every figure is formatted here from a typed number.
// ---------------------------------------------------------------------------

describe('Trading Floor board — numbers come from typed fields only', () => {
  test('the formatters print NaN as a marker, never as a zero', () => {
    expect(String(formatSignedUsd(Number.NaN))).toBe('N/A');
    expect(String(formatSignedUsd(null))).toBe('-');
    expect(String(formatSignedUsd(0))).toBe('$0.00');
    expect(String(formatSignedUsd(7.77))).toBe('+$7.77');
    expect(String(formatSignedUsd(-19.8))).toBe('-$19.80');
    expect(String(formatUsd(20))).toBe('$20');
    expect(String(formatUsd(20.5))).toBe('$20.50');
    expect(String(formatUsd(Number.NaN))).toBe('N/A');
    expect(String(formatUsd(123_456.78))).toBe('$123.5K');
    expect(String(formatUsd(1e30))).toBe('N/A');
    expect(String(formatPercent(2.5))).toBe('2.5%');
    expect(String(formatPercent(1))).toBe('1%');
    expect(String(formatPercent(Number.NaN))).toBe('-');
    expect(String(formatCount(Number.NaN))).toBe('-');
    expect(String(formatCount(-1))).toBe('-');
  });

  test('P&L +/-$99,999.99 prints exactly; larger goes compact; counts go K/M above 99,999', () => {
    expect(String(formatSignedUsd(99_999.99))).toBe('+$99999.99');
    expect(String(formatSignedUsd(-99_999.99))).toBe('-$99999.99');
    expect(String(formatSignedUsd(100_000))).toBe('+$100.0K');
    expect(String(formatSignedUsd(99_999.996))).toBe('+$100.0K');
    expect(String(formatSignedUsd(1e18))).toBe('N/A');
    expect(String(formatCount(99_999))).toBe('99999');
    expect(String(formatCount(100_000))).toBe('100K');
    expect(String(formatCount(999_500))).toBe('1M');
    expect(String(formatCount(1e9))).toBe('-');
  });

  // Lead decision 2026-10-02: the exit line tries TP SL HOLD, then TP SL, then
  // the tight "TP+x% SL-y%", then TP alone; whole percents; out of bounds N/A.
  test('the exit rule: template rules, then the fallbacks at the parameter bounds', () => {
    const rule = (exits: FloorScreenExits | null) => String(formatExitRule(exits));
    expect(rule({ tpMult: 1.1, stopMult: null, maxHoldS: 900 })).toBe('TP +10% 15M');
    expect(rule({ tpMult: 1.2, stopMult: null, maxHoldS: 900 })).toBe('TP +20% 15M');
    expect(rule({ tpMult: 1.08, stopMult: 0.9, maxHoldS: 7_200 })).toBe('TP +8% SL -10%');
    expect(rule({ tpMult: 1.1, stopMult: null, maxHoldS: 3_600 })).toBe('TP +10% 1H');
    expect(rule({ tpMult: 1.1, stopMult: null, maxHoldS: 1_800 })).toBe('TP +10% 30M');
    expect(rule({ tpMult: 1.1, stopMult: null, maxHoldS: 5_400 })).toBe('TP +10% 90M');
    // Bounds: tp 1.01..10, stop 0.3..0.99, hold 60..86400.
    expect(rule({ tpMult: 10, stopMult: 0.3, maxHoldS: 86_400 })).toBe('TP+900% SL-70%');
    expect(rule({ tpMult: 10, stopMult: null, maxHoldS: 86_400 })).toBe('TP +900% 24H');
    expect(rule({ tpMult: 1.01, stopMult: 0.99, maxHoldS: 60 })).toBe('TP +1% SL -1%');
    expect(rule({ tpMult: 1.01, stopMult: null, maxHoldS: 60 })).toBe('TP +1% 1M');
    // No take-profit leg, an unreadable leg, an unreadable hold, no exits at all.
    expect(rule({ tpMult: null, stopMult: 0.9, maxHoldS: 900 })).toBe('NO TP SL -10%');
    expect(rule({ tpMult: null, stopMult: null, maxHoldS: 900 })).toBe('NO TP 15M');
    expect(rule({ tpMult: Number.NaN, stopMult: null, maxHoldS: 900 })).toBe('TP N/A 15M');
    expect(rule({ tpMult: 1.1, stopMult: Number.NaN, maxHoldS: Number.NaN })).toBe('TP +10% SL N/A');
    expect(rule({ tpMult: 1.1, stopMult: null, maxHoldS: null })).toBe('TP +10%');
    expect(rule(null)).toBe('EXITS N/A');
    // A value no bound allows never prints a long figure.
    expect(rule({ tpMult: 1e9, stopMult: -4, maxHoldS: 1e12 })).toBe('TP N/A SL N/A');
    for (const exits of EXTREME_EXITS) expect(rule(exits).length).toBeLessThanOrEqual(COLUMN_LINE_CHARS);
  });

  test('the mark multiple fits five characters and says N/A when unreadable', () => {
    const mult = (value: number) => String(formatMarkMultiple(value));
    expect(mult(1.04)).toBe('1.04X');
    expect(mult(0)).toBe('0.00X');
    expect(mult(9.996)).toBe('10.0X');
    expect(mult(99.96)).toBe('100X');
    expect(mult(999.4)).toBe('999X');
    expect(mult(999.6)).toBe('999X+');
    expect(mult(1e9)).toBe('999X+');
    expect(mult(Number.NaN)).toBe('N/A');
    expect(mult(-1)).toBe('N/A');
    for (const value of [0, 1.04, 9.996, 99.96, 999.4, 1e9]) expect(mult(value).length).toBeLessThanOrEqual(5);
  });

  test('value() is never called with a bare string or untagged template', () => {
    const source = readFileSync(join(import.meta.dir, 'trading-floor-screen-texture.ts'), 'utf8');
    const calls = [...source.matchAll(/value\(\s*ctx,\s*([^\n]{0,24})/g)].map((hit) => hit[1]!.trim());
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const argument of calls) {
      const literal = /^['"`]/.test(argument);
      expect({ argument, literal }).toEqual({ argument, literal: false });
    }
  });

  // A money figure in the SOURCE would be a figure nobody computed. The $20
  // position and the cost percentages arrive as numbers from `@clawville/shared`.
  test('the drawing code contains no hard-coded money figure or percentage', () => {
    const source = readFileSync(join(import.meta.dir, 'trading-floor-screen-texture.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/\$\d/);
    expect(code).not.toMatch(/['"`][^'"`]*\bUSD\s*\d/i);
    expect(code).not.toMatch(/\d(\.\d+)?%/);
    const dollarLiterals = code.match(/\$(?!\{)[^{]/g) ?? [];
    expect(dollarLiterals.every((hit) => /\$\D/.test(hit))).toBe(true);
  });

  test('colour follows the sign, and flat is neither', () => {
    expect(pnlColor(1)).toBe(COLOR.gain);
    expect(pnlColor(-1)).toBe(COLOR.drop);
    expect(pnlColor(0)).toBe(COLOR.value);
    expect(pnlColor(Number.NaN)).toBe(COLOR.muted);
    const painted = draw({
      columns: [
        column({ realisedUsd: 7.77 }),
        column({ realisedUsd: -5.2 }),
        column({ realisedUsd: 0 }),
        column({ realisedUsd: null }),
        column({ realisedUsd: Number.NaN }),
      ],
    }).painted;
    const fillOf = (value: string) =>
      painted.find((p) => p.kind === 'text' && p.value === value)?.fill;
    expect(fillOf('+$7.77')).toBe(COLOR.gain);
    expect(fillOf('-$5.20')).toBe(COLOR.drop);
    expect(fillOf('$0.00')).toBe(COLOR.value);
    expect(fillOf('N/A')).toBe(COLOR.muted);
  });
});

// ---------------------------------------------------------------------------
// What the board shows
// ---------------------------------------------------------------------------

describe('Trading Floor board — five house-agent columns', () => {
  test('one column per house agent, in template order, with the plan §1 lines', () => {
    const { painted } = draw();
    expect(floorScreenLineCount(SIZE.height)).toBe(9);
    expect(columnStrings(painted, 0)).toEqual([
      'GENESIS',
      'PAPER',
      'ACTIVE',
      'BUSIEST YOUNG',
      'TP +10% 15M',
      '3/412 OK',
      'WATCH BONK',
      'OPEN 2 OF 5',
      'BONK 1.04X',
      '-$5.20',
    ]);
    expect(FLOOR_ARENA_TEMPLATES.map((_t, i) => columnStrings(painted, i)[0])).toEqual([
      'GENESIS',
      'RUNNER',
      'DIP HUNTER',
      'MIDCAP CLIMBER',
      'LATE BLOOMER',
    ]);
    expect(columnStrings(painted, 1)[4]).toBe('TP +20% 15M');
    expect(columnStrings(painted, 2)[4]).toBe('TP +8% SL -10%');
    expect(columnStrings(painted, 3)[4]).toBe('TP +10% 1H');
    expect(columnStrings(painted, 4)[4]).toBe('TP +10% 30M');
  });

  test('the column centres are the agent spots: column i spans 1024/5 canvas px', () => {
    // Board x -1275 + 510 i .. -1275 + 510 (i + 1) on the 2550 wu board maps to
    // canvas 204.8 i .. 204.8 (i + 1); centre x -1020, -510, 0, 510, 1020.
    const { painted } = draw();
    const names = bodyTexts(painted).filter((t) => fontPx(t.font) === 24 || t.value === 'MIDCAP CLIMBER');
    const centres = FLOOR_ARENA_TEMPLATES.map((_t, i) => {
      const t = names.find((n) => columnIndexOf(textBox(n), SIZE) === i)!;
      const box = textBox(t);
      return (box.left + box.right) / 2;
    });
    const boardX = centres.map((x) => Math.round((x / SIZE.width - 0.5) * 2550));
    expect(boardX).toEqual([-1020, -510, 0, 510, 1020]);
  });

  test('no player leaderboard row, no #1 rank, no prize line and no tape row', () => {
    const joined = draw().strings.join(' | ');
    for (const gone of ['#1', 'PRIZES', '$CLAWVILLE', 'TRADER', 'NOT ELIGIBLE', '///', 'NO PRIZE', 'STANDING BY', 'LAUNCH YOUR TRADER']) {
      expect({ gone, present: joined.includes(gone) }).toEqual({ gone, present: false });
    }
    expect(Object.keys(board()).sort()).toEqual(
      ['basis', 'clockLabel', 'columns', 'countdownLabel', 'leaderboard', 'page', 'phase', 'window'].sort(),
    );
  });

  // Lead decision (1): 24 px up to 12 characters, else 22 px up to 14; a name
  // over 14 drops its hyphen first ("MID-CAP CLIMBER" -> "MIDCAP CLIMBER").
  test('names: 24 px up to 12 characters, else 22 px up to 14, hyphen dropped past 14', () => {
    const { painted } = draw();
    const nameFont = (index: number) =>
      bodyTexts(painted).find((t) => columnIndexOf(textBox(t), SIZE) === index)!.font;
    expect(fontPx(nameFont(0))).toBe(24); // GENESIS
    expect(fontPx(nameFont(4))).toBe(24); // LATE BLOOMER, 12
    expect(fontPx(nameFont(3))).toBe(22); // MIDCAP CLIMBER, 14
    const named = (name: string) => {
      const drawn = draw({ columns: [column({ name })] }).painted;
      const first = bodyTexts(drawn)[0]!;
      return [first.value, fontPx(first.font)];
    };
    expect(named('Mid-Cap Climber')).toEqual(['MIDCAP CLIMBER', 22]);
    expect(named('WWWWWWWWWWWW')).toEqual(['WWWWWWWWWWWW', 24]);
    expect(named('WWWWWWWWWWWWW')).toEqual(['WWWWWWWWWWWWW', 22]);
    expect(named('Very Long House Agent Name')).toEqual(['VERY LONG HOU.', 22]);
    expect(named('')).toEqual(['NAME NOT SHOWN', 22]);
    expect(COLUMN_BIG_CHARS).toBe(12);
    expect(COLUMN_LINE_CHARS).toBe(14);
  });

  test('mode pill + status word: PAPER pills, a green LIVE pill, N/A for a missing row', () => {
    const { painted, strings } = draw({
      columns: [
        column({ mode: 'paper', status: 'active' }),
        column({ mode: 'live', status: 'paused' }),
        column({ mode: 'paper', status: 'stopped' }),
        column({ mode: null, status: 'active' }),
        column({ mode: null, status: null, known: false }),
      ],
    });
    expect(columnStrings(painted, 0).slice(1, 3)).toEqual(['PAPER', 'ACTIVE']);
    expect(columnStrings(painted, 1).slice(1, 3)).toEqual(['LIVE', 'PAUSED']);
    expect(columnStrings(painted, 2).slice(1, 3)).toEqual(['PAPER', 'STOPPED']);
    expect(columnStrings(painted, 3)[1]).toBe('ACTIVE');
    expect(columnStrings(painted, 4)[1]).toBe('N/A');
    const live = painted.find((p): p is PaintedText => p.kind === 'text' && p.value === 'LIVE' && p.y > HEADER_H)!;
    expect(live.fill).toBe(COLOR.livePillText);
    const liveBox = textBox(live);
    const pill = painted.find(
      (p): p is PaintedRect => p.kind === 'rect' && p.fill === COLOR.livePill && boxHitsRect(liveBox, p),
    );
    expect(pill).toBeDefined();
    expect(COLOR.livePill).toBe(COLOR.live);
    const paperPills = painted.filter((p) => p.kind === 'rect' && p.fill === COLOR.paperPill);
    expect(paperPills).toHaveLength(2);
    expect(strings.filter((s) => s === 'PAPER')).toHaveLength(2);
  });

  test('the strategy words: one per template id, at most 14, no numbers', () => {
    expect(FLOOR_SCREEN_STRATEGY_WORDS).toEqual({
      genesis: 'BUSIEST YOUNG',
      runner: 'NEW, HOT, CALM',
      'dip-hunter': 'BUYS THE DIP',
      'midcap-climber': 'STEADY CLIMB',
      'late-bloomer': 'WAKING UP',
    });
    expect(Object.keys(FLOOR_SCREEN_STRATEGY_WORDS).sort()).toEqual(FLOOR_ARENA_TEMPLATES.map((t) => t.id).sort());
    for (const words of Object.values(FLOOR_SCREEN_STRATEGY_WORDS)) {
      // Letters, spaces and the commas of the plan's runner copy. No digit, no
      // "$" or "%": a threshold on the wall would go stale when a filter moves.
      expect({ words, ok: /^[A-Z][A-Z ,]*$/.test(words) && words.length <= COLUMN_LINE_CHARS }).toEqual({ words, ok: true });
    }
    const { painted } = draw();
    expect(FLOOR_ARENA_TEMPLATES.map((_t, i) => columnStrings(painted, i)[3])).toEqual([
      'BUSIEST YOUNG',
      'NEW, HOT, CALM',
      'BUYS THE DIP',
      'STEADY CLIMB',
      'WAKING UP',
    ]);
  });

  // Lead decision (2): `<passed>/<evaluated> OK`, exact up to 99,999, K/M above.
  test('the scan line is <passed>/<evaluated> OK, and fits at 99,999', () => {
    const scanLine = (c: Partial<FloorScreenColumn>) =>
      columnStrings(draw({ columns: [column(c)] }).painted, 0)[5];
    expect(scanLine({})).toBe('3/412 OK');
    expect(scanLine({ scan: { evaluated: 99_999, passed: 99_999, topSkipCode: null } })).toBe('99999/99999 OK');
    expect(scanLine({ scan: { evaluated: 120_960, passed: 100_000, topSkipCode: null } })).toBe('100K/121K OK');
    expect(scanLine({ scan: { evaluated: Number.NaN, passed: Number.NaN, topSkipCode: null } })).toBe('-/- OK');
    expect(scanLine({ scan: null })).toBe('NO RECENT SCAN');
    expect('99999/99999 OK'.length).toBeLessThanOrEqual(COLUMN_LINE_CHARS);
  });

  // Lead decision: fixed words of at most 9 characters, OTHER for an unknown code.
  test('watching beats the top skip; a skip prints a fixed word, never the raw code', () => {
    const watchLine = (c: Partial<FloorScreenColumn>) =>
      columnStrings(draw({ columns: [column(c)] }).painted, 0)[6];
    expect(watchLine({})).toBe('WATCH BONK');
    expect(watchLine({ watching: { symbol: 'WWWWWWWW' } })).toBe('WATCH WWWWWWWW');
    expect(watchLine({ watching: { symbol: '' } })).toBe('WATCH COIN');
    expect(watchLine({ watching: null })).toBe('SKIP LIQUIDITY');
    expect(watchLine({ watching: null, scan: { evaluated: 9, passed: 0, topSkipCode: 'chg1h_max' } })).toBe('SKIP 1H MOVE');
    expect(watchLine({ watching: null, scan: { evaluated: 9, passed: 0, topSkipCode: 'mint_freeze_x' } })).toBe('SKIP OTHER');
    expect(watchLine({ watching: null, scan: { evaluated: 9, passed: 0, topSkipCode: null } })).toBe('-');
    expect(watchLine({ watching: null, scan: null })).toBe('-');
    expect(String(skipWord('liq'))).toBe('LIQUIDITY');
    expect(String(skipWord('__proto__'))).toBe('OTHER');
    expect(String(skipWord('constructor'))).toBe('OTHER');
  });

  test('every engine fail code has a skip word of at most 9 characters', () => {
    // The engine list lives in the API; reading its source keeps the two from drifting.
    const filters = readFileSync(
      join(import.meta.dir, '../../../../../api/src/services/floor-arena/filters.ts'),
      'utf8',
    );
    const block = /FLOOR_ARENA_FAIL_CODES = \[([\s\S]*?)\] as const/.exec(filters)?.[1] ?? '';
    const codes = [...block.matchAll(/'([a-z0-9_]+)'/g)].map((hit) => hit[1]!);
    expect(codes.length).toBeGreaterThan(20);
    expect(Object.keys(FLOOR_SCREEN_SKIP_WORDS).sort()).toEqual([...codes].sort());
    for (const word of [...Object.values(FLOOR_SCREEN_SKIP_WORDS), 'OTHER']) {
      expect({ word, ok: /^[A-Z0-9][A-Z0-9 ]*$/.test(word) && word.length <= 9 }).toEqual({ word, ok: true });
    }
    expect(FLOOR_SCREEN_SKIP_WORDS.liq).toBe('LIQUIDITY');
  });

  // Lead decision: "OF n" is FLOOR_ARENA_MAX_OPEN_POSITIONS (via basis.maxOpen).
  test('the open count reads OPEN n OF the platform cap', () => {
    const openLine = (c: Partial<FloorScreenColumn>, maxOpen = 5) =>
      columnStrings(draw({ columns: [column(c)], basis: { ...BASIS, maxOpen } }).painted, 0)[7];
    expect(openLine({})).toBe('OPEN 2 OF 5');
    expect(openLine({ openCount: 0 })).toBe('OPEN 0 OF 5');
    expect(openLine({}, 3)).toBe('OPEN 2 OF 3');
    expect(openLine({ openCount: 99_999 })).toBe('OPEN 99999');
    expect(BASIS.maxOpen).toBe(FLOOR_ARENA_MAX_OPEN_POSITIONS);
  });

  test('the newest open trade: symbol and mark, COIN when masked, a plain line when none', () => {
    const newestLine = (c: Partial<FloorScreenColumn>) =>
      columnStrings(draw({ columns: [column(c)] }).painted, 0)[8];
    expect(newestLine({})).toBe('BONK 1.04X');
    expect(newestLine({ newest: { symbol: '', markMult: 1.04 } })).toBe('COIN 1.04X');
    expect(newestLine({ newest: { symbol: 'WWWWWWWW', markMult: 999.4 } })).toBe('WWWWWWWW 999X');
    expect(newestLine({ newest: { symbol: 'BONK', markMult: Number.NaN } })).toBe('BONK N/A');
    expect(newestLine({ newest: null, openCount: 0 })).toBe('NO OPEN TRADE');
    const painted = draw({ columns: [column({ newest: { symbol: 'BONK', markMult: 0.8 } })] }).painted;
    expect(painted.find((p) => p.kind === 'text' && p.value === 'BONK 0.80X')?.fill).toBe(COLOR.drop);
  });

  test('realised P&L is 24 px in gain or drop colour; NaN prints N/A, unknown prints -', () => {
    const pnl = (realisedUsd: number | null) => {
      const t = bodyTexts(draw({ columns: [column({ realisedUsd })] }).painted).sort((a, b) => b.y - a.y)[0]!;
      return [t.value, fontPx(t.font)];
    };
    expect(pnl(7.77)).toEqual(['+$7.77', 24]);
    expect(pnl(-99_999.99)).toEqual(['-$99999.99', 24]);
    expect(pnl(Number.NaN)).toEqual(['N/A', 24]);
    expect(pnl(null)).toEqual(['-', 24]);
  });

  // Lead decision: a missing row prints N/A or "-", never zeros.
  test('a missing agent row prints N/A or "-", never a zero', () => {
    const missing = column({
      name: 'Runner',
      known: false,
      mode: null,
      status: null,
      exits: null,
      scan: null,
      watching: null,
      openCount: Number.NaN,
      newest: null,
      realisedUsd: null,
      wins: Number.NaN,
      losses: Number.NaN,
    });
    const lines = columnStrings(draw({ columns: [missing] }).painted, 0);
    expect(lines).toEqual(['RUNNER', 'N/A', 'BUSIEST YOUNG', 'EXITS N/A', '-', '-', 'OPEN - OF 5', '-', '-']);
    for (const value of lines) {
      expect({ value, zero: /(^|[^0-9.])0([^0-9.]|$)|\$0\.00/.test(value) }).toEqual({ value, zero: false });
    }
  });

  test('wins and losses only when a tenth line fits', () => {
    expect(columnStrings(draw().painted, 0)).not.toContain('7W 10L');
    const tall = { width: 1024, height: 346 } as const;
    expect(floorScreenLineCount(tall.height)).toBe(10);
    expect(columnStrings(draw({}, tall).painted, 0, tall).at(-1)).toBe('7W 10L');
    expect(columnStrings(draw({ columns: [column({ wins: 99_999, losses: 99_999 })] }, tall).painted, 0, tall).at(-1)).toBe(
      '99999W 99999L',
    );
  });

  test('a smaller canvas drops lines from the end of the list and never shrinks the font', () => {
    const short = { width: 1024, height: 260 } as const;
    expect(floorScreenLineCount(260)).toBe(7);
    expect(floorScreenLineCount(72)).toBe(0);
    expect(floorScreenLineCount(98)).toBe(1);
    const lines = columnStrings(draw({}, short).painted, 0, short);
    expect(lines).toEqual(['GENESIS', 'PAPER', 'ACTIVE', 'BUSIEST YOUNG', 'TP +10% 15M', '3/412 OK', 'WATCH BONK', 'OPEN 2 OF 5']);
    for (const t of draw({}, short).painted) {
      if (t.kind === 'text') expect(fontPx(t.font)).toBeGreaterThanOrEqual(BOARD_MIN_PX);
    }
  });

  test('before the first data the board says CONNECTING or UNAVAILABLE, never an empty grid', () => {
    const connecting = draw({ phase: 'connecting', columns: [] });
    expect(connecting.strings).toContain('CONNECTING TO THE ARENA');
    expect(connecting.strings).toContain('HOUSE AGENTS · PAPER');
    expect(connecting.strings).toContain('14:32 UTC');
    expect(bodyTexts(connecting.painted).map((t) => t.value)).toEqual(['CONNECTING TO THE ARENA']);
    expect(draw({ phase: 'error', columns: [] }).strings).toContain('ARENA DATA UNAVAILABLE');
    expect(footerText(connecting.painted)).toEqual([]);
  });
});

describe('Trading Floor board — header and footer', () => {
  test('header: HOUSE AGENTS · PAPER, the countdown with minutes, a dot, the UTC clock', () => {
    expect(headerTexts(draw().painted)).toEqual([
      'HOUSE AGENTS · PAPER',
      '14:32 UTC',
      '·',
      'ENDS IN 3D 15H 59M',
    ]);
    expect(headerTexts(draw({ countdownLabel: null }).painted)).toEqual(['HOUSE AGENTS · PAPER', '14:32 UTC']);
  });

  test('any live column makes it PAPER + LIVE; only live columns make it LIVE', () => {
    const mixed = houseColumns();
    mixed[1] = { ...mixed[1]!, mode: 'live' };
    expect(headerTexts(draw({ columns: mixed }).painted)[0]).toBe('HOUSE AGENTS · PAPER + LIVE');
    expect(headerTexts(draw({ columns: houseColumns({ mode: 'live' }) }).painted)[0]).toBe('HOUSE AGENTS · LIVE');
    // A missing mode is no claim either way; the arena is paper.
    expect(headerTexts(draw({ columns: houseColumns({ mode: null }) }).painted)[0]).toBe('HOUSE AGENTS · PAPER');
  });

  // Lead decision (3): three footer forms, figures from the constants, CONTEST or 24H.
  test('footer: all paper, mixed, all live; CONTEST while it runs, else 24H', () => {
    const mixed = houseColumns();
    mixed[1] = { ...mixed[1]!, mode: 'live' };
    expect(footerText(draw().painted)).toEqual([
      'PAPER: $20 A POSITION, 2.5% BUY + 1% SELL COSTS. P&L = REALISED, CONTEST',
    ]);
    expect(footerText(draw({ window: '24h' }).painted)).toEqual([
      'PAPER: $20 A POSITION, 2.5% BUY + 1% SELL COSTS. P&L = REALISED, 24H',
    ]);
    expect(footerText(draw({ columns: mixed }).painted)).toEqual([
      'PAPER COLUMNS: $20 EACH, 2.5% BUY + 1% SELL COSTS. P&L = REALISED, CONTEST',
    ]);
    expect(footerText(draw({ columns: mixed, window: '24h' }).painted)).toEqual([
      'PAPER COLUMNS: $20 EACH, 2.5% BUY + 1% SELL COSTS. P&L = REALISED, 24H',
    ]);
    expect(footerText(draw({ columns: houseColumns({ mode: 'live' }) }).painted)).toEqual(['P&L = REALISED, CONTEST']);
    expect(footerText(draw({ columns: houseColumns({ mode: 'live' }), window: '24h' }).painted)).toEqual([
      'P&L = REALISED, 24H',
    ]);
    // A different engine constant is a different sentence: nothing is typed in.
    expect(footerText(draw({ basis: { ...BASIS, positionUsd: 25, buyCostPct: 3, sellCostPct: 1.5 } }).painted)).toEqual([
      'PAPER: $25 A POSITION, 3% BUY + 1.5% SELL COSTS. P&L = REALISED, CONTEST',
    ]);
    // An unreadable figure says N/A; a line too wide for the canvas falls back
    // to one that still says PAPER, never a cut figure and never off the canvas.
    expect(footerText(draw({ basis: { ...BASIS, positionUsd: 1e30 } }).painted)).toEqual([
      'PAPER: N/A A POSITION, 2.5% BUY + 1% SELL COSTS. P&L = REALISED, CONTEST',
    ]);
    expect(footerText(draw({ basis: { ...BASIS, positionUsd: 123_456.78 } }).painted)).toEqual([
      'PAPER TRADES. P&L = REALISED, CONTEST',
    ]);
    const mixedWide = houseColumns();
    mixedWide[0] = { ...mixedWide[0]!, mode: 'live' };
    expect(footerText(draw({ columns: mixedWide, basis: { ...BASIS, positionUsd: 123_456.78 } }).painted)).toEqual([
      'PAPER COLUMNS. P&L = REALISED, CONTEST',
    ]);
    expect(BASIS.positionUsd).toBe(FLOOR_ARENA_POSITION_USD);
    expect(BASIS.buyCostPct).toBe(FLOOR_ARENA_PAPER_COSTS.buy_haircut_pct);
    expect(BASIS.sellCostPct).toBe(FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct);
  });

  test('PAPER is on the wall three times on an all-paper board: header, pills, footer', () => {
    const { painted, strings } = draw();
    expect(headerTexts(painted)[0]).toContain('PAPER');
    expect(strings.filter((s) => s === 'PAPER')).toHaveLength(5);
    expect(footerText(painted)[0]).toStartWith('PAPER:');
  });

  test('the offline clock word and the longest countdown are drawn whole', () => {
    const texts = headerTexts(draw({ clockLabel: 'CLOCK OFFLINE', countdownLabel: 'STARTS IN 27000D 03H 12M' }).painted);
    expect(texts).toContain('CLOCK OFFLINE');
    expect(texts).toContain('STARTS IN 27000D 03H 12M');
  });
});

// ---------------------------------------------------------------------------
// Geometry: the hand-placed layout, pinned
// ---------------------------------------------------------------------------

describe('Trading Floor board — layout', () => {
  test('every glyph box sits inside its own column across the fixture sweep', () => {
    for (const height of HEIGHTS) {
      const size = { width: 1024, height };
      for (const data of sweepBoards()) {
        const rec = recorder();
        drawFloorScreen(rec.context, data, size);
        assertColumnsContained(rec.painted, size);
        assertInsideCanvas(rec.painted, size);
      }
    }
  });

  test('pills stay inside their column', () => {
    const width = SIZE.width / FLOOR_SCREEN_COLUMNS;
    for (const data of sweepBoards()) {
      const rec = recorder();
      drawFloorScreen(rec.context, data, SIZE);
      for (const p of rec.painted) {
        // Body rects only: the header accent rule shares the LIVE green.
        if (p.kind !== 'rect' || p.y <= HEADER_H || (p.fill !== COLOR.paperPill && p.fill !== COLOR.livePill)) continue;
        const index = Math.floor((p.x + p.w / 2) / width);
        const inside = p.x >= index * width + GUTTER - 1e-6 && p.x + p.w <= (index + 1) * width - GUTTER + 1e-6;
        expect({ pill: [p.x, p.w], inside }).toEqual({ pill: [p.x, p.w], inside: true });
      }
    }
  });

  test('no later fill paints over text, and no two strings share space', () => {
    for (const height of HEIGHTS) {
      for (const data of sweepBoards()) {
        const rec = recorder();
        drawFloorScreen(rec.context, data, { width: 1024, height });
        assertNoFillOverText(rec.painted);
        assertNoTextOverlap(rec.painted);
      }
    }
  });

  test('every string is bold and at least 22 px; names and P&L are 24 px', () => {
    expect(BOARD_MIN_PX).toBe(22);
    for (const data of sweepBoards()) {
      const rec = recorder();
      drawFloorScreen(rec.context, data, SIZE);
      for (const p of rec.painted) {
        if (p.kind !== 'text') continue;
        expect({ value: p.value, px: fontPx(p.font) >= BOARD_MIN_PX, bold: p.font.startsWith('bold ') }).toEqual({
          value: p.value,
          px: true,
          bold: true,
        });
      }
    }
    const fonts = new Set(draw().painted.filter((p): p is PaintedText => p.kind === 'text').map((p) => fontPx(p.font)));
    expect([...fonts].sort()).toEqual([22, 24]);
  });

  test('every column line keeps the 14-character budget (12 at 24 px)', () => {
    for (const data of sweepBoards()) {
      const rec = recorder();
      drawFloorScreen(rec.context, data, SIZE);
      for (const t of bodyTexts(rec.painted)) {
        if (t.value.startsWith('CONNECTING') || t.value.startsWith('ARENA DATA')) continue;
        const budget = fontPx(t.font) === 24 ? COLUMN_BIG_CHARS : COLUMN_LINE_CHARS;
        expect({ value: t.value, fits: t.value.length <= budget }).toEqual({ value: t.value, fits: true });
      }
    }
  });

  test('the row pitch is 26 and the first line sits under the header', () => {
    const ys = [...new Set(bodyTexts(draw().painted).filter((t) => columnIndexOf(textBox(t), SIZE) === 0).map((t) => t.y))];
    expect(ys).toEqual([60, 86, 112, 138, 164, 190, 216, 242, 268]);
  });

  // Mipmaps were tried and REVERTED on real-GPU evidence (2026-09-30).
  test('the board texture is single-level (mipmaps were tried and reverted)', () => {
    const source = readFileSync(join(import.meta.dir, 'trading-floor-screen.tsx'), 'utf8');
    expect(source).toContain('texture.generateMipmaps = false;');
    expect(source).toContain('texture.minFilter = THREE.LinearFilter;');
    expect(source).not.toContain('LinearMipmapLinearFilter');
  });

  test('the board component reads the house-board, leaderboard and contest hooks, no tape', () => {
    const source = readFileSync(join(import.meta.dir, 'trading-floor-screen.tsx'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toContain('useFloorArenaHouseBoard(active)');
    expect(code).toContain('useFloorArenaContest(active)');
    expect(code).toContain("useFloorArenaLeaderboard('contest', active)");
    expect(code).not.toContain('useFloorArenaTape');
    // The page comes from the clock (floorScreenPage), redrawn by a timer: no per-frame state.
    expect(code).toContain('floorScreenPage(');
    // Redraw only on a signature change or the 30 s tick: no frame callback,
    // no per-frame allocation, no drei text, no instanced shader material.
    expect(code).not.toContain('useFrame');
    expect(code).not.toMatch(/<Text\b|<Billboard\b|InstancedMesh|ShaderMaterial/);
  });

  describe('the paint-order checker itself', () => {
    const left = (value: string, x: number, y: number, size = 14) =>
      ({ kind: 'text', x, y, value, font: `${size}px mono`, align: 'left', fill: '#000' }) as const;
    const right = (value: string, x: number, y: number, size = 16) =>
      ({ kind: 'text', x, y, value, font: `bold ${size}px mono`, align: 'right', fill: '#000' }) as const;
    const rect = (x: number, y: number, w: number, h: number) => ({ kind: 'rect', x, y, w, h }) as const;

    test('catches a bed on the baseline and a bed over the glyph body', () => {
      expect(boxHitsRect(textBox(left('LAST', 100, 144)), rect(90, 140, 200, 46))).toBe(true);
      expect(boxHitsRect(textBox(left('LAST', 100, 144)), rect(90, 119, 200, 20))).toBe(true);
    });

    test('catches a rect over right-aligned glyphs that stops short of the anchor', () => {
      const box = textBox(right('14:32 UTC', 1002, 27));
      expect(box.right).toBeCloseTo(1002, 5);
      expect(boxHitsRect(box, rect(900, 14, 80, 20))).toBe(true);
    });

    test('detects two strings at the same position, not two that clear each other', () => {
      const a = textBox(left('VERIFIED 12', 18, 152, 15));
      const b = textBox(left('OPEN 1', 18, 152, 15));
      expect(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top).toBe(true);
      const far = textBox(left('4M AGO', 300, 152, 15));
      expect(a.left < far.right && a.right > far.left).toBe(false);
      expect(boxHitsRect(textBox(left('LAST', 100, 138)), rect(90, 161, 200, 44))).toBe(false);
    });
  });
});

describe('Trading Floor board — canvas sizing', () => {
  test('the drawing space is derived from the plane, not re-typed', () => {
    expect(TRADING_FLOOR_SCREEN.canvasWidth).toBe(FLOOR_SCREEN_CANVAS.width);
    expect(TRADING_FLOOR_SCREEN.canvasHeight).toBe(FLOOR_SCREEN_CANVAS.height);
  });

  // The column budget (14 characters at 22 px, 12 at 24 px) is derived for a
  // 1024 px canvas (plan request W1). A wider or narrower canvas is a layout
  // change, not a constant swap.
  test('the canvas stays 1024 wide, and the column budget fits the column', () => {
    expect(FLOOR_SCREEN_CANVAS.width).toBe(1024);
    const inner = FLOOR_SCREEN_CANVAS.width / FLOOR_SCREEN_COLUMNS - 2 * GUTTER;
    expect(COLUMN_LINE_CHARS * 0.6 * BOARD_MIN_PX).toBeLessThanOrEqual(inner);
    expect(COLUMN_BIG_CHARS * 0.6 * 24).toBeLessThanOrEqual(inner);
    expect(floorScreenLineCount(FLOOR_SCREEN_CANVAS.height)).toBeGreaterThanOrEqual(9);
  });

  test('the drawing space matches the plane it is stretched onto', () => {
    const plane = TRADING_FLOOR_SCREEN.width / TRADING_FLOOR_SCREEN.height;
    const canvas = FLOOR_SCREEN_CANVAS.width / FLOOR_SCREEN_CANVAS.height;
    expect(Math.abs(canvas / plane - 1)).toBeLessThan(0.005);
  });

  // DO NOT DELETE AS REDUNDANT: it is the only pin between the build script's
  // surround and the runtime plane (see the history in git).
  test('the GLB surround and the runtime plane frame the same rect', () => {
    const script = readFileSync(
      join(import.meta.dir, '../../../../../../scripts/trading-floor/build-interior.mjs'),
      'utf8',
    );
    const constant = (name: string): number => {
      const found = new RegExp(`const ${name} = (-?\\d+(?:\\.\\d+)?)`).exec(script);
      expect({ name, found: found !== null }).toEqual({ name, found: true });
      return Number(found![1]);
    };
    expect(constant('SCREEN_W')).toBe(TRADING_FLOOR_SCREEN.width);
    expect(constant('SCREEN_H')).toBe(TRADING_FLOOR_SCREEN.height);
    expect(constant('SCREEN_BOTTOM_Y')).toBe(TRADING_FLOOR_SCREEN.bottomY);
  });

  test('the backing store doubles only where it shows, and never past 2x', () => {
    expect(pickCanvasScale(1)).toBe(1);
    expect(pickCanvasScale(1.25)).toBe(1);
    expect(pickCanvasScale(1.5)).toBe(2);
    expect(pickCanvasScale(3)).toBe(2);
    expect(pickCanvasScale(Number.NaN)).toBe(1);
  });

  test('drawFloorScreen defaults to the shipped canvas', () => {
    const a = recorder();
    drawFloorScreen(a.context, board());
    const b = recorder();
    drawFloorScreen(b.context, board(), FLOOR_SCREEN_CANVAS);
    expect(a.painted).toEqual(b.painted);
  });
});

// ---------------------------------------------------------------------------
// Page B: the arena contest leaderboard (founder order 2026-10-02, rotation)
// ---------------------------------------------------------------------------

function leaderRow(overrides: Partial<FloorScreenLeaderRow> = {}): FloorScreenLeaderRow {
  return { rank: 1, name: 'alice trader', realisedUsd: 12.4, trades: 9, ...overrides };
}

function leaderBoard(rows: FloorScreenLeaderRow[]): Partial<FloorScreenData> {
  return { page: 'leaderboard', leaderboard: { phase: 'ready', rows } };
}

function worstLeaderRows(count = 12): FloorScreenLeaderRow[] {
  return Array.from({ length: count }, (_unused, i) =>
    leaderRow({ rank: 9990 + i, name: 'WWWWWWW '.repeat(5), realisedUsd: i % 2 ? 99_999.99 : -99_999.99, trades: 99_999 }),
  );
}

describe('Trading Floor board — page B, the contest leaderboard', () => {
  test('pages rotate every 15 s', () => {
    expect(FLOOR_SCREEN_PAGE_MS).toBe(15_000);
  });

  test('the header names the page; the countdown and the clock stay', () => {
    expect(headerTexts(draw(leaderBoard([leaderRow()])).painted)).toEqual([
      'LEADERBOARD · CONTEST',
      '14:32 UTC',
      '·',
      'ENDS IN 3D 15H 59M',
    ]);
    expect(headerTexts(draw().painted)[0]).toBe('HOUSE AGENTS · PAPER');
  });

  test('rows show rank, trader name, realised P&L and trades under the captions', () => {
    const { strings, painted } = draw(
      leaderBoard([leaderRow(), leaderRow({ rank: 2, name: 'Runner', realisedUsd: -5.2, trades: 17 })]),
    );
    for (const expected of ['#', 'TRADER', 'REALISED P&L', 'TRADES', '#1', 'ALICE TRADER', '+$12.40', '9', '#2', 'RUNNER', '-$5.20', '17']) {
      expect({ expected, present: strings.includes(expected) }).toEqual({ expected, present: true });
    }
    for (const gone of ['BUSIEST YOUNG', 'WATCH BONK', 'OPEN 2 OF 5', 'ACTIVE']) expect(strings).not.toContain(gone);
    const fill = (value: string) => painted.find((p) => p.kind === 'text' && p.value === value)?.fill;
    expect(fill('+$12.40')).toBe(COLOR.gain);
    expect(fill('-$5.20')).toBe(COLOR.drop);
    expect(footerText(painted)).toEqual(['PAPER: $20 A POSITION, 2.5% BUY + 1% SELL COSTS. P&L = REALISED, CONTEST']);
  });

  test('an empty leaderboard says NO TRADERS YET, never fake rows', () => {
    const { strings } = draw(leaderBoard([]));
    expect(strings).toContain('NO TRADERS YET');
    expect(strings).not.toContain('#1');
    expect(strings).not.toContain('TRADER');
  });

  test('before the first leaderboard data it says CONNECTING or UNAVAILABLE', () => {
    expect(draw({ page: 'leaderboard', leaderboard: { phase: 'connecting', rows: [] } }).strings).toContain('CONNECTING TO THE ARENA');
    expect(draw({ page: 'leaderboard', leaderboard: { phase: 'error', rows: [] } }).strings).toContain('ARENA DATA UNAVAILABLE');
  });

  test('a masked or unpaintable name says NAME NOT SHOWN; an address never prints; NaN prints N/A', () => {
    const drawn = draw(
      leaderBoard([
        leaderRow({ name: MINT }),
        leaderRow({ rank: 2, name: 'Трейдер' }),
        leaderRow({ rank: Number.NaN, name: 'bob', realisedUsd: Number.NaN, trades: Number.NaN }),
      ]),
    );
    expect(drawn.strings.filter((s) => s === 'NAME NOT SHOWN')).toHaveLength(2);
    assertAddressAbsent(drawn.strings, MINT);
    assertDrawable(drawn.strings);
    expect(drawn.strings).toContain('N/A');
    expect(drawn.strings).toContain('-');
    expect(drawn.strings).not.toContain('$0.00');
  });

  test('rows fill the lines under the captions: 8 at 313, never more', () => {
    const many = Array.from({ length: 20 }, (_unused, i) => leaderRow({ rank: i + 1, name: `T${i + 1}` }));
    const { strings } = draw(leaderBoard(many));
    expect(strings).toContain('#8');
    expect(strings).not.toContain('#9');
  });

  test('every string is bold, at least 22 px, inside the canvas, with no overlap and no fill over text', () => {
    for (const height of HEIGHTS) {
      const size = { width: 1024, height };
      for (const rows of [worstLeaderRows(), [leaderRow()], []]) {
        for (const extra of [{}, { clockLabel: 'CLOCK OFFLINE', countdownLabel: 'STARTS IN 27000D 03H 12M' }]) {
          const rec = recorder();
          drawFloorScreen(rec.context, board({ ...leaderBoard(rows), ...extra }), size);
          for (const p of rec.painted) {
            if (p.kind !== 'text') continue;
            expect({ value: p.value, px: fontPx(p.font) >= BOARD_MIN_PX, bold: p.font.startsWith('bold ') }).toEqual({
              value: p.value,
              px: true,
              bold: true,
            });
          }
          assertInsideCanvas(rec.painted, size);
          assertNoTextOverlap(rec.painted);
          assertNoFillOverText(rec.painted);
        }
      }
    }
    const { strings } = draw(leaderBoard(worstLeaderRows()));
    expect(strings).toContain('WWWWWWW WWWWWWW WWWWWWW.');
    expect(strings).toContain('-$99999.99');
    expect(strings).toContain('99999');
    expect(strings).toContain('#9990');
  });
});
