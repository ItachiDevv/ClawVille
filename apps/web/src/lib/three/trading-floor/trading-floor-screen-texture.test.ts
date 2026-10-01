import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_PAPER_COSTS,
  FLOOR_ARENA_POSITION_USD,
} from '@clawville/shared';

import {
  BOARD_MIN_PX,
  COLOR,
  drawFloorScreen,
  FLOOR_SCREEN_CANVAS,
  FLOOR_SCREEN_MAX_ROWS,
  formatAmount,
  formatCount,
  formatOrdinal,
  formatPercent,
  formatRank,
  formatSignedUsd,
  formatUsd,
  pickCanvasScale,
  pnlColor,
  sanitiseScreenText,
  type FloorScreenContest,
  type FloorScreenContext,
  type FloorScreenData,
  type FloorScreenRow,
} from './trading-floor-screen-texture';
import {
  buildFloorScreenData,
  contestCountdownLabel,
  floorClockLabel,
  floorScreenSignature,
  type ArenaQueryInput,
  type FloorScreenInputs,
} from './trading-floor-screen-data';
import { TRADING_FLOOR_SCREEN } from './trading-floor-room';
import { buildTapeSources } from './trading-floor-trade-tape';

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

/**
 * An APPROXIMATE glyph box for a `fillText` call.
 *
 * The anchor point is not the text. tf3d-audit broke the first version of the
 * paint-order pin twice with that: (1) glyphs sit ABOVE the baseline, so a bed
 * whose top edge lands just above the baseline covers the glyph body while
 * leaving the anchor outside the rect — the pin went quiet on a WORSE version
 * of the bug it was built for; (2) right-aligned text anchors at its RIGHT
 * edge and every glyph is to the left of it, so the pin watched the one column
 * where the glyphs are not.
 *
 * Crude on purpose. A monospace advance of 0.6em and a 0.72/0.2 cap-height
 * split are estimates, not metrics — no 2D context exists in this runtime to
 * measure with. The point is to compare a BOX against a rect instead of a
 * point against a rect; being approximately right about the glyph body beats
 * being exactly right about a corner of it.
 */
function textBox(t: Extract<Painted, { kind: 'text' }>) {
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

function boxHitsRect(
  box: ReturnType<typeof textBox>,
  rect: Extract<Painted, { kind: 'rect' }>,
): boolean {
  return (
    box.left < rect.x + rect.w &&
    box.right > rect.x &&
    box.top < rect.y + rect.h &&
    box.bottom > rect.y
  );
}

/**
 * THE TWO GEOMETRY PINS, as functions so every board state can be swept by both
 * without copying their loops — a copied loop is how one of them would quietly
 * stop being run. The layout is hand-placed and `drawFloorScreen` measures
 * nothing, so these are what catch a row drawn through its neighbour.
 */
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

/**
 * Every pair of strings, both ways. The estimator is PESSIMISTIC on purpose
 * (0.72 em rise against Courier New's real 0.572 em cap height), so a pass here
 * has margin; do not loosen it to make a new layout fit (memory:
 * gotchas/canvas-paint-pin-estimator-false-positive.md).
 */
function assertNoTextOverlap(painted: Painted[]): void {
  const texts = painted.filter(
    (p): p is Extract<Painted, { kind: 'text' }> => p.kind === 'text',
  );
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = textBox(texts[i]!);
      const b = textBox(texts[j]!);
      const overlap =
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      expect({
        a: texts[i]!.value.slice(0, 24),
        b: texts[j]!.value.slice(0, 24),
        overlap,
      }).toEqual({
        a: texts[i]!.value.slice(0, 24),
        b: texts[j]!.value.slice(0, 24),
        overlap: false,
      });
    }
  }
}

function recorder() {
  const strings: string[] = [];
  const rects: Array<[number, number, number, number]> = [];
  /** Paint ORDER, so the test can catch a fill landing on top of earlier text. */
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
      rects.push([x, y, w, h]);
      painted.push({ kind: 'rect', x, y, w, h, fill: String(context.fillStyle) });
    },
    strokeRect: () => undefined,
    fillText: (value: string, x: number, y: number) => {
      strings.push(value);
      // `fillStyle` too: the legibility test DERIVES the disclosure set from
      // the colour the drawing chose, rather than from a list of substrings
      // somebody has to remember to extend.
      // `font` and `textAlign` are read back off the fake context at the moment
      // of the call: the drawing code sets both immediately before every
      // `fillText`, and without them a text record cannot be turned into a box.
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
  return { context: context as unknown as FloorScreenContext, strings, rects, painted };
}



/** A base58 run long enough to be a Solana address. */
const ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,64}/;
/** An EVM address. Base58 excludes 0/I/O/l, so hex needs its own assertion. */
const HEX_ADDRESS = /0x[0-9a-fA-F]{6,}/i;
/** Control and zero-width characters, which render as tofu or hide content. */
const INVISIBLE = /[\u0000-\u001f­​-‏‪-‮﻿]/;

/**
 * What must hold for EVERY string the board draws, under the current rule.
 * Renamed from `assertClean`, which meant "no money" — the opposite of the
 * product — so the name could not be left pointing at the old belief.
 */
/**
 * "Did this address survive, in any readable form?" — the detector the obvious
 * checks get wrong.
 *
 * `not.toContain(address)` FAILS TO FIRE on the real leak: the output is
 * uppercased and the composed character is dropped entirely, so what paints is
 * the address MINUS ONE LETTER and an `includes` on the whole string reports
 * clean. A base58 regex over the output fails too, because base58 excludes `O`
 * and an uppercased address breaks into short runs at every `O`. A
 * strip-the-spaces-then-look-for-a-long-run check fires on legitimate copy,
 * since ordinary copy is long once its spaces are gone.
 *
 * So: slide a 16-character window over the address and assert none of them
 * survives anywhere, comparing against the drawn text with its non-alphanumerics
 * removed so a leak split by a SPACE is still caught. A window that long cannot
 * occur in real copy by accident, and a leak that drops or splits a character
 * still leaves whole windows either side of the damage.
 *
 * KNOWN LIMIT, stated so nobody over-trusts it: 16 is sound for ONE splitter,
 * because a 44-character address cut once always leaves a run of at least 22 on
 * the long side. Marks spaced CLOSER than 16 would defeat it — a mark every 8
 * characters leaves no 16-character run intact. Any fixed window can be beaten
 * that way, so the dense shapes are covered by the exact-output assertion in
 * the callers (`expect(out).toBe('NOTE')`), which has no blind spot at all.
 * This helper is the backstop on the DRAW path, where an exact expectation is
 * not available.
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

function assertDrawable(strings: string[]) {
  expect(strings.length).toBeGreaterThan(0);
  for (const value of strings) {
    expect({
      value,
      base58: ADDRESS.test(value),
      hex: HEX_ADDRESS.test(value),
      invisible: INVISIBLE.test(value),
      // 95 is the widest string the board is DESIGNED to draw (the ticker's
      // cap), so anything longer is a runaway. It was 64 while the widest
      // string was a card label; the arena board's basis line is 77 and its
      // prize line 60, both by design.
      tooLong: value.length > 95,
    }).toEqual({ value, base58: false, hex: false, invisible: false, tooLong: false });
  }
}


// ---------------------------------------------------------------------------
// Drawable fixtures
// ---------------------------------------------------------------------------

/** A drawable row. The default is a LOSS on purpose: a loss is the case most
 *  likely to be got wrong by a change that only ever looked at a win. */
function row(overrides: Partial<FloorScreenRow> = {}): FloorScreenRow {
  return {
    rank: 1,
    name: 'Genesis',
    tag: 'house',
    template: 'Genesis',
    realisedUsd: -5.2,
    trades: 10,
    wins: 4,
    losses: 6,
    openPositions: 1,
    ...overrides,
  };
}

const CONTEST: FloorScreenContest = {
  title: 'Trading Arena Week 1',
  countdownLabel: 'ENDS IN 3D 15H 59M',
  prizes: [
    { place: 1, amount: 1_000_000 },
    { place: 2, amount: 500_000 },
    { place: 3, amount: 250_000 },
  ],
};

const BASIS = { positionUsd: 20, buyCostPct: 2.5, sellCostPct: 1 } as const;

/** Every `draw` supplies every field, so a new drawn field can never slip onto
 *  the board without passing the hygiene gate below. */
function board(
  data: Partial<FloorScreenData> & Pick<FloorScreenData, 'phase'>,
): FloorScreenData {
  return {
    rows: [],
    hasPlayerAgents: false,
    contest: CONTEST,
    basis: BASIS,
    clockLabel: '14:32 UTC',
    tape: [],
    ...data,
  };
}

function draw(data: Parameters<typeof board>[0]) {
  const rec = recorder();
  drawFloorScreen(rec.context, board(data));
  return rec;
}

/** The five house agents plus two players, as the live board will look. */
function liveRows(): FloorScreenRow[] {
  return [
    row({ rank: 1, name: 'Runner', template: 'Runner', realisedUsd: 12.4, trades: 9, wins: 6, losses: 3 }),
    row({ rank: 2, name: 'alice trader', tag: null, template: 'Genesis', realisedUsd: 3.05, trades: 4, wins: 3, losses: 1, openPositions: 2 }),
    row({ rank: 3, name: 'Genesis', template: 'Genesis', realisedUsd: 0, trades: 2, wins: 1, losses: 1, openPositions: 0 }),
    row({ rank: 4, name: 'Dip Hunter', template: 'Dip Hunter', realisedUsd: -1.1 }),
    row({ rank: 5, name: 'Mid-Cap Climber', template: 'Mid-Cap Climber', realisedUsd: -2.75 }),
    row({ rank: 6, name: 'Late Bloomer', template: 'Late Bloomer', realisedUsd: -4.4 }),
    row({ rank: 7, name: 'bob', tag: null, template: 'Runner', realisedUsd: -19.9, trades: 1, wins: 0, losses: 1 }),
  ];
}

/**
 * The widest thing each position can hold, all at once: a full table of the
 * widest rank, name, tag, template, P&L and counts, the longest countdown and
 * clock words, a title cut at its cap, and a full tape. Names use spaces so the
 * address strip does not eat them (a 40-letter base58 run IS an address).
 */
function worstCaseBoard(): FloorScreenData {
  return board({
    phase: 'ready',
    rows: Array.from({ length: FLOOR_SCREEN_MAX_ROWS }, (_unused, index) =>
      row({
        rank: 100 + index,
        name: 'WWWWWWW '.repeat(5),
        tag: index % 2 === 0 ? 'no-prize' : 'house',
        template: 'MMMMMMM '.repeat(5),
        realisedUsd: -12345.67,
        trades: 99999,
        wins: 99999,
        losses: 99999,
        openPositions: 99,
      }),
    ),
    hasPlayerAgents: true,
    contest: {
      title: 'TTTTTTT '.repeat(8),
      countdownLabel: 'STARTS IN 27000D 03H 12M',
      prizes: CONTEST.prizes,
    },
    clockLabel: 'CLOCK OFFLINE',
    tape: Array.from({ length: 12 }, () => 'MID-CAP CL SELL WWWWWWWW -$19.80 12M'),
  });
}

function fontPx(font: string): number {
  return Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? Number.NaN);
}

// ---------------------------------------------------------------------------
// Wire fixtures (the data half)
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const MINT = '7xKXtg2CW3eTA1hqzVfKp8mKQqZ9rPfLmNbVcXyZaQw1';

const ready = (data: unknown): ArenaQueryInput => ({ data, isLoading: false, isError: false });
const LOADING: ArenaQueryInput = { data: undefined, isLoading: true, isError: false };
const failed = (data?: unknown): ArenaQueryInput => ({ data, isLoading: false, isError: true });

/** A leaderboard row as the ROUTE sends it (`services/floor-arena/leaderboard.ts`). */
function wireRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rank: 1,
    agentId: 'house:genesis',
    name: 'Genesis',
    kind: 'house',
    templateId: 'genesis',
    realisedUsd: -5.2,
    trades: 10,
    wins: 4,
    losses: 6,
    deaths: 1,
    openPositions: 1,
    lastTradeAt: '2026-10-01T11:50:00.000Z',
    eligible: false,
    ...overrides,
  };
}

/** The contest body as the ROUTE sends it (`services/floor-arena/contest.ts`),
 *  including the two fields that tick on every request. */
function contestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contest: { ...FLOOR_ARENA_CONTEST },
    status: 'live',
    secondsLeft: 316_799,
    top: [],
    house: [],
    generatedAt: '2026-10-01T12:00:00.000Z',
    ...overrides,
  };
}

const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/** A tape row as the contract describes it (docs/trading-floor-arena.md §5). */
function tapeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    at: minutesAgo(4),
    agentId: 'house:genesis',
    agentName: 'Genesis',
    kind: 'house',
    type: 'entry',
    mint: MINT,
    symbol: 'BONK',
    side: 'buy',
    usd: 20,
    pnlUsd: null,
    pnlMult: null,
    reason: null,
    ...overrides,
  };
}

function inputs(overrides: Partial<FloorScreenInputs> = {}): FloorScreenInputs {
  return {
    leaderboard: ready({ rows: [wireRow()] }),
    contest: ready(contestBody()),
    tape: ready([]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Hygiene: text from outside never reaches the wall unfiltered
// ---------------------------------------------------------------------------

describe('Trading Floor board — untrusted text hygiene', () => {
  test('a normal board draws nothing an outside string could poison', () => {
    assertDrawable(
      draw({ phase: 'ready', rows: liveRows(), hasPlayerAgents: true, tape: ['GENESIS BUY BONK $20.00 4M'] })
        .strings,
    );
  });

  test('every loading, error and empty state is clean too', () => {
    assertDrawable(draw({ phase: 'connecting' }).strings);
    assertDrawable(draw({ phase: 'error' }).strings);
    assertDrawable(draw({ phase: 'ready' }).strings);
    assertDrawable(draw({ phase: 'ready', contest: null }).strings);
    assertDrawable(draw({ phase: 'ready', rows: [row()] }).strings);
  });

  // Player-chosen agent names made this matter more than it did for two house
  // desks: every name, template, contest title and tape entry is outside text.
  test('a wallet address in any outside string never reaches the board', () => {
    const solana = MINT;
    const evm = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
    for (const address of [solana, evm]) {
      const hostile = draw({
        phase: 'ready',
        rows: [row({ name: `Genesis ${address}`, template: address })],
        contest: { ...CONTEST, title: `Arena ${address}` },
        tape: [`GENESIS BUY ${address} 4M`],
      });
      assertDrawable(hostile.strings);
      assertAddressAbsent(hostile.strings, address);
    }
  });

  test('a name the wall cannot paint still gets words, and they describe the wall', () => {
    // A real name in a script the ASCII face cannot draw.
    expect(draw({ phase: 'ready', rows: [row({ name: 'Трейдер', tag: null })] }).strings).toContain(
      'NAME NOT SHOWN',
    );
  });

  test('a name that is nothing but an address still gets a word', () => {
    const drawn = draw({ phase: 'ready', rows: [row({ name: MINT })] });
    expect(drawn.strings).toContain('NAME NOT SHOWN');
    assertAddressAbsent(drawn.strings, MINT);
  });

  // AN ADDRESS SPLIT BY AN INVISIBLE CHARACTER. NFKC COMPOSES `p` + U+0301
  // into one character the strip does not know, so `BASE58_RUN` saw a 19 and a
  // 24 and matched neither, and the shipped function returned, verbatim,
  // "NOTE 7XKXTG2CW87D97TXJSD BD5JBKHETQA83TZRUJOSGASU". NFKD keeps the mark
  // separate and `INVISIBLE` deletes it. (tfs-audit + tfs-api, 2026-09-20.)
  //
  // THE DETECTOR IS THE OTHER HALF OF THIS TEST. `not.toContain(address)` does
  // not fire on that leak — the output is uppercased and the composed
  // character is dropped — so the exact output is asserted instead.
  test.each([
    ['a combining acute', 0x0301],
    ['a zero-width space', 0x200b],
    ['a soft hyphen', 0x00ad],
    ['a word joiner', 0x2060],
    // Unicode PROPERTIES, not a hand-listed range set: these two were outside
    // the old list and split a base58 run exactly like a combining acute.
    ['a high combining mark U+1AB0', 0x1ab0],
    ['a variation selector U+FE0F', 0xfe0f],
  ])('an address split by %s still never reaches the board', (_name, codePoint) => {
    const address = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const head = address.slice(0, 20);
    const tail = address.slice(20);
    const split = `note ${head}${String.fromCharCode(codePoint)}${tail}`;

    const out = sanitiseScreenText(split, 200);
    expect(out).toBe('NOTE');
    expect(out).not.toContain(head.toUpperCase());
    expect(out).not.toContain(tail.toUpperCase());
    assertAddressAbsent([out], address);

    // And through the real draw path, on a player's agent name.
    const drawn = draw({ phase: 'ready', rows: [row({ name: split, tag: null })] });
    assertDrawable(drawn.strings);
    assertAddressAbsent(drawn.strings, address);
  });

  // THE DENSE SHAPE, which no fixed-width window detector can catch: a mark
  // every 8 characters leaves no 16-character run intact. Exact output only.
  test('an address peppered with combining marks is still removed entirely', () => {
    const address = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const acute = String.fromCharCode(0x0301);
    const peppered = address.replace(/(.{8})/g, `$1${acute}`);
    expect(sanitiseScreenText(`note ${peppered}`, 200)).toBe('NOTE');

    const drawn = draw({ phase: 'ready', rows: [row({ name: `note ${peppered}` })] });
    assertDrawable(drawn.strings);
    for (let i = 0; i + 8 <= address.length; i += 8) {
      const piece = address.slice(i, i + 8).toUpperCase();
      for (const value of drawn.strings) {
        expect({ piece, present: value.replace(/[^A-Za-z0-9]/g, '').includes(piece) }).toEqual({
          piece,
          present: false,
        });
      }
    }
  });

  // THREE SHAPES THAT REACHED THE WALL on the house-trader board, pinned by
  // EXACT OUTPUT. The `0x` prefix was once matched case-sensitively and ran
  // BEFORE `toUpperCase()`; unprefixed hex was seen by neither pass.
  test.each([
    ['an UPPERCASE 0X prefix', 'note 0XdeadBEEF1234567890abcdef'],
    ['a lowercase 0x prefix', 'note 0xdeadBEEF1234567890abcdef'],
    ['hex with no prefix at all', 'note deadBEEF1234567890abcdef1234'],
  ])('%s never reaches the board', (_name, input) => {
    expect(sanitiseScreenText(input, 200)).toBe('NOTE');
    const drawn = draw({ phase: 'ready', rows: [row({ name: input })] });
    assertDrawable(drawn.strings);
    for (const value of drawn.strings) {
      expect(value).not.toMatch(/[0-9A-F]{20,}/);
    }
  });

  // ONE PASS MUST NOT CUT ANOTHER PASS'S TOKEN (Codex round 3): every pattern
  // matches on the INTACT text and the union is deleted.
  test('a hex run inside a base58 run cannot split it into printable halves', () => {
    const spliced = `note ${'G'.repeat(12)}${'a'.repeat(20)}${'H'.repeat(12)}`;
    expect(sanitiseScreenText(spliced, 200)).toBe('NOTE');
    const drawn = draw({ phase: 'ready', rows: [row({ template: spliced })] });
    for (const value of drawn.strings) {
      expect(value).not.toMatch(/G{8,}|H{8,}/);
    }
  });

  // THE UPPER BOUND WAS A TAIL: `{32,64}` left the last 24 characters of an
  // 88-character run printable.
  test('a base58 run longer than an address leaves no tail', () => {
    const address = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const doubled = `note ${address}${address}`;
    expect(sanitiseScreenText(doubled, 200)).toBe('NOTE');
  });

  test('fullwidth look-alikes are still folded onto ASCII', () => {
    expect(sanitiseScreenText('ＧＥＮＥＳＩＳ', 40)).toBe('GENESIS');
    expect(sanitiseScreenText('Café desk', 40)).toBe('CAFE DESK');
  });

  test('invisible characters and unrenderable glyphs are stripped', () => {
    const drawn = draw({
      phase: 'ready',
      rows: [row({ name: 'Gen​esis\u0000 🚀', tag: null })],
    });
    assertDrawable(drawn.strings);
    expect(drawn.strings).toContain('GENESIS');
  });

  test('an over-long label is truncated rather than overflowing its column', () => {
    expect(sanitiseScreenText('A'.repeat(80), 16).length).toBeLessThanOrEqual(16);
  });

  test('the sanitiser is linear on a hostile-length input', () => {
    const started = performance.now();
    sanitiseScreenText('A1'.repeat(60_000));
    sanitiseScreenText('1'.repeat(60_000));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  // MONEY DRAWS. The board publishes P&L (founder, 2026-09-20).
  test.each([
    ['a dollar figure in a label', '$GENESIS', '$GENESIS'],
    ['a percentage', 'UP 40%', 'UP 40%'],
    ['a signed number', '+420', '+420'],
    ['a money word', 'PROFIT RUN', 'PROFIT RUN'],
    ['an underscore compound', 'UP_10', 'UP 10'],
  ])('%s survives the sanitiser — the board publishes money', (_name, input, expected) => {
    expect(sanitiseScreenText(input, 40)).toBe(expected);
  });

  test('every shipped label survives unchanged', () => {
    for (const [input, expected] of [
      ['Trading Arena Week 1', 'TRADING ARENA WEEK 1'],
      ['ENDS IN 3D 15H 59M', 'ENDS IN 3D 15H 59M'],
      ['HOUSE AGENTS NOT ELIGIBLE', 'HOUSE AGENTS NOT ELIGIBLE'],
      ['Mid-Cap Climber', 'MID-CAP CLIMBER'],
      ['GENESIS BUY BONK $20.00 4M', 'GENESIS BUY BONK $20.00 4M'],
      ['RUNNER SELL WIF +$2.14 12M', 'RUNNER SELL WIF +$2.14 12M'],
      ['REALISED P&L', 'REALISED P&L'],
      ['14:32 UTC', '14:32 UTC'],
    ] as const) {
      expect(sanitiseScreenText(input, 44)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// PROVENANCE. Every money figure is formatted here from a typed number.
// ---------------------------------------------------------------------------

describe('Trading Floor board — money comes from typed fields only', () => {
  test('the formatters print NaN as a marker, never as a zero', () => {
    expect(String(formatSignedUsd(Number.NaN))).toBe('N/A');
    expect(String(formatSignedUsd(null))).toBe('-');
    expect(String(formatSignedUsd(0))).toBe('$0.00');
    expect(String(formatSignedUsd(2.144))).toBe('+$2.14');
    expect(String(formatSignedUsd(-19.8))).toBe('-$19.80');
    expect(String(formatUsd(20))).toBe('$20');
    expect(String(formatUsd(20.5))).toBe('$20.50');
    expect(String(formatUsd(Number.NaN))).toBe('N/A');
    expect(String(formatPercent(2.5))).toBe('2.5%');
    expect(String(formatPercent(1))).toBe('1%');
    expect(String(formatPercent(Number.NaN))).toBe('-');
    expect(String(formatAmount(1_000_000))).toBe('1,000,000');
    expect(String(formatAmount(250_000))).toBe('250,000');
    expect(String(formatAmount(999))).toBe('999');
    expect(String(formatAmount(Number.NaN))).toBe('-');
    expect(String(formatRank(1))).toBe('#1');
    expect(String(formatRank(0))).toBe('-');
    expect(String(formatRank(Number.NaN))).toBe('-');
  });

  // Codex review 2026-09-30: a finite but absurd figure ("+$1000000000.00",
  // 15 characters) started left of its column and ran into the template name.
  // Realistic paper figures print exactly; beyond 100,000 they go compact.
  test('large figures and counts go compact instead of running out of their column', () => {
    expect(String(formatSignedUsd(99_999.99))).toBe('+$99999.99');
    expect(String(formatSignedUsd(-99_999.99))).toBe('-$99999.99');
    expect(String(formatSignedUsd(100_000))).toBe('+$100.0K');
    // The rounded cents decide the branch, so nothing prints wider than the
    // widest exact string.
    expect(String(formatSignedUsd(99_999.996))).toBe('+$100.0K');
    expect(String(formatSignedUsd(-99_999.994))).toBe('-$99999.99');
    expect(String(formatSignedUsd(1e9))).toBe('+$1.0B');
    expect(String(formatSignedUsd(-2.5e12))).toBe('-$2.5T');
    expect(String(formatSignedUsd(1e18))).toBe('N/A');
    expect(String(formatCount(99_999))).toBe('99999');
    expect(String(formatCount(120_960))).toBe('121K');
    expect(String(formatCount(999_499))).toBe('999K');
    expect(String(formatCount(999_500))).toBe('1M');
    expect(String(formatCount(1e9))).toBe('-');
    expect(String(formatCount(-1))).toBe('-');
    expect(String(formatCount(-99_999))).toBe('-');
    expect(String(formatRank(9999))).toBe('#9999');
    expect(String(formatRank(10_000))).toBe('-');
  });

  test('ordinals read as places, including the teens', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map((n) => String(formatOrdinal(n)))).toEqual([
      '1ST', '2ND', '3RD', '4TH', '11TH', '12TH', '13TH', '21ST', '22ND', '23RD', '101ST', '111TH',
    ]);
    expect(String(formatOrdinal(0))).toBe('-');
  });

  test('a row whose figures are unreadable says so, never $0.00 or a zero count', () => {
    const drawn = draw({
      phase: 'ready',
      rows: [
        row({
          rank: Number.NaN,
          realisedUsd: Number.NaN,
          trades: Number.NaN,
          wins: Number.NaN,
          losses: Number.NaN,
          openPositions: Number.NaN,
        }),
      ],
    });
    expect(drawn.strings).toContain('N/A');
    expect(drawn.strings).toContain('-/-');
    expect(drawn.strings).not.toContain('$0.00');
    expect(drawn.strings).not.toContain('0');
    expect(drawn.strings.join(' | ')).not.toContain('NAN');
  });

  // A caller can build `FloorScreenData` by hand — that is why the sanitiser
  // lives at the draw site — so the draw must survive "numbers" that are
  // strings. The formatters' `Number.isFinite` is the boundary.
  test('a hostile string in a numeric field cannot reach fillText as money', () => {
    const poisoned = {
      ...row(),
      rank: '1 WINNER' as unknown as number,
      realisedUsd: '+$999,999.00 PROFIT' as unknown as number,
      trades: MINT as unknown as number,
      wins: '<script>' as unknown as number,
    } as FloorScreenRow;
    const joined = draw({ phase: 'ready', rows: [poisoned] }).strings.join(' | ');
    expect(joined).not.toContain('999,999');
    expect(joined).not.toContain('PROFIT');
    expect(joined).not.toContain('<script>');
    expect(joined).not.toContain('WINNER');
    expect(joined).toContain('N/A');
    assertAddressAbsent(joined.split(' | '), MINT);
  });

  // The BRAND. `value()` skips the untrusted-text pass by design, and a
  // `value()` handed a bare literal or an untagged template is what an edit
  // that routes server text around the sanitiser looks like.
  test('value() is never called with a bare string or untagged template', () => {
    const source = readFileSync(
      join(import.meta.dir, 'trading-floor-screen-texture.ts'),
      'utf8',
    );
    const calls = [...source.matchAll(/value\(\s*ctx,\s*([^\n]{0,24})/g)].map(
      (hit) => hit[1]!.trim(),
    );
    expect(calls.length).toBeGreaterThan(8);
    for (const argument of calls) {
      const literal = /^['"`]/.test(argument);
      expect({ argument, literal }).toEqual({ argument, literal: false });
    }
  });

  // A money figure in the SOURCE would be a figure nobody computed. The $20
  // ticket and the cost percentages arrive as numbers from `@clawville/shared`.
  test('the drawing code contains no hard-coded money figure', () => {
    const source = readFileSync(
      join(import.meta.dir, 'trading-floor-screen-texture.ts'),
      'utf8',
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
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
    const painted = draw({ phase: 'ready', rows: liveRows() }).painted;
    const fillOf = (value: string) =>
      painted.find((p) => p.kind === 'text' && p.value === value)?.fill;
    expect(fillOf('+$12.40')).toBe(COLOR.gain);
    expect(fillOf('-$19.90')).toBe(COLOR.drop);
    expect(fillOf('$0.00')).toBe(COLOR.value);
  });
});

// ---------------------------------------------------------------------------
// What the board shows
// ---------------------------------------------------------------------------

describe('Trading Floor board — what it actually shows', () => {
  test('the header names the contest, says PAPER, counts down and keeps the clock', () => {
    const { strings } = draw({ phase: 'ready', rows: liveRows() });
    expect(strings).toContain('TRADING ARENA WEEK 1 · PAPER');
    expect(strings).toContain('ENDS IN 3D 15H 59M');
    expect(strings).toContain('14:32 UTC');
  });

  test('the prize line states the places, the amounts and the token', () => {
    const { strings } = draw({ phase: 'ready', rows: liveRows() });
    expect(strings).toContain(
      'PRIZES  1ST 1,000,000 · 2ND 500,000 · 3RD 250,000 $CLAWVILLE',
    );
    // House agents are ranked in the same table, so the prize line must say
    // they cannot place.
    expect(strings).toContain('HOUSE AGENTS NOT ELIGIBLE');
  });

  // Codex review round 4: three prizes of 1e18 ran off the canvas edge.
  test('a prize line too long for its room is dropped whole, never cut or overlapped', () => {
    for (const prizes of [
      [1, 2, 3].map((place) => ({ place, amount: 1e18 })),
      Array.from({ length: 10 }, (_unused, index) => ({ place: index + 1, amount: 250_000 })),
    ]) {
      const rec = recorder();
      drawFloorScreen(rec.context, board({ phase: 'ready', rows: liveRows(), contest: { ...CONTEST, prizes } }));
      expect(rec.strings.join(' | ')).not.toContain('PRIZES');
      expect(rec.strings).not.toContain('HOUSE AGENTS NOT ELIGIBLE');
      assertNoTextOverlap(rec.painted);
      for (const painted of rec.painted) {
        if (painted.kind !== 'text') continue;
        const box = textBox(painted);
        expect(box.right).toBeLessThanOrEqual(FLOOR_SCREEN_CANVAS.width);
      }
    }
    // The longest line that still fits is drawn, and clears the note beside it.
    const wide = [1, 2, 3, 4].map((place) => ({ place, amount: 999_999 }));
    const rec = recorder();
    drawFloorScreen(rec.context, board({ phase: 'ready', rows: liveRows(), contest: { ...CONTEST, prizes: wide } }));
    const line = rec.strings.find((value) => value.startsWith('PRIZES'));
    expect(line?.length).toBeLessThanOrEqual(82);
    expect(rec.strings).toContain('HOUSE AGENTS NOT ELIGIBLE');
    assertNoTextOverlap(rec.painted);
  });

  test('with no contest data the header still says PAPER and names nothing it lacks', () => {
    const { strings } = draw({ phase: 'ready', rows: liveRows(), contest: null });
    expect(strings).toContain('TRADING ARENA · PAPER');
    expect(strings.join(' | ')).not.toContain('PRIZES');
    expect(strings.join(' | ')).not.toContain('ENDS IN');
    expect(strings).toContain('14:32 UTC');
  });

  test('a contest title that sanitises to nothing falls back rather than painting "· PAPER"', () => {
    const { strings } = draw({ phase: 'ready', contest: { ...CONTEST, title: MINT } });
    expect(strings).toContain('TRADING ARENA · PAPER');
    expect(strings).not.toContain('· PAPER');
  });

  test('every column of a row is on the board', () => {
    const { strings } = draw({ phase: 'ready', rows: [row()] });
    for (const expected of ['#1', 'GENESIS', 'HOUSE', '-$5.20', '10', '4/6', '1']) {
      expect(strings).toContain(expected);
    }
    for (const caption of ['#', 'TRADER', 'TEMPLATE', 'REALISED P&L', 'TRADES', 'W/L', 'OPEN']) {
      expect(strings).toContain(caption);
    }
  });

  test('house rows are tagged HOUSE, eligible players carry no tag', () => {
    const { strings } = draw({ phase: 'ready', rows: liveRows(), hasPlayerAgents: true });
    expect(strings.filter((value) => value === 'HOUSE')).toHaveLength(5);
    expect(strings).not.toContain('NO PRIZE');
    expect(strings).toContain('ALICE TRADER');
  });

  test('an ineligible player is tagged NO PRIZE so its place is not read as a prize place', () => {
    const { strings } = draw({ phase: 'ready', rows: [row({ tag: 'no-prize', name: 'carol' })] });
    expect(strings).toContain('NO PRIZE');
    expect(strings).not.toContain('HOUSE');
  });

  test('the call to action shows only while no player agent is on the board', () => {
    const cta = 'NO PLAYER TRADERS YET · LAUNCH YOUR TRADER AT THE KIOSK';
    const houseOnly = liveRows().filter((value) => value.tag === 'house');
    expect(draw({ phase: 'ready', rows: houseOnly }).strings).toContain(cta);
    expect(draw({ phase: 'ready', rows: [] }).strings).toContain(cta);
    expect(
      draw({ phase: 'ready', rows: houseOnly, hasPlayerAgents: true }).strings,
    ).not.toContain(cta);
    // Never over a ranked agent: a full table has no free row for it.
    const full = Array.from({ length: FLOOR_SCREEN_MAX_ROWS }, (_unused, index) =>
      row({ rank: index + 1 }),
    );
    expect(draw({ phase: 'ready', rows: full }).strings).not.toContain(cta);
  });

  test('the call to action sits in the first free row', () => {
    const cta = 'NO PLAYER TRADERS YET · LAUNCH YOUR TRADER AT THE KIOSK';
    const houseOnly = liveRows().filter((value) => value.tag === 'house');
    const painted = draw({ phase: 'ready', rows: houseOnly }).painted;
    const rowY = (value: string) =>
      painted.find((p) => p.kind === 'text' && p.value === value)?.y ?? Number.NaN;
    const lastRank = rowY(`#${houseOnly.length}`);
    expect(rowY(cta)).toBeGreaterThan(lastRank);
  });

  test('at most FLOOR_SCREEN_MAX_ROWS rows are drawn', () => {
    const many = Array.from({ length: 20 }, (_unused, index) => row({ rank: index + 1 }));
    const { strings } = draw({ phase: 'ready', rows: many });
    expect(strings).toContain(`#${FLOOR_SCREEN_MAX_ROWS}`);
    expect(strings).not.toContain(`#${FLOOR_SCREEN_MAX_ROWS + 1}`);
  });

  test('the method line is composed from the numbers, and only when a figure is up', () => {
    const line =
      'PAPER TRADES · $20 PER POSITION · REALISED P&L AFTER 2.5% BUY + 1% SELL COSTS';
    expect(draw({ phase: 'ready', rows: [row()] }).strings).toContain(line);
    expect(draw({ phase: 'ready', rows: [] }).strings).not.toContain(line);
    // A different engine constant is a different sentence: nothing is typed in.
    expect(
      draw({
        phase: 'ready',
        rows: [row()],
        basis: { positionUsd: 25, buyCostPct: 3, sellCostPct: 1.5 },
      }).strings,
    ).toContain('PAPER TRADES · $25 PER POSITION · REALISED P&L AFTER 3% BUY + 1.5% SELL COSTS');
  });

  test('a board with no data says it is connecting, never an empty table', () => {
    const connecting = draw({ phase: 'connecting' }).strings;
    expect(connecting).toContain('CONNECTING TO THE ARENA');
    expect(connecting).not.toContain('TRADER');
    expect(draw({ phase: 'error' }).strings).toContain('ARENA DATA UNAVAILABLE');
    // The header still reads in every phase.
    expect(connecting).toContain('TRADING ARENA WEEK 1 · PAPER');
    expect(connecting).toContain('14:32 UTC');
  });

  test('the bottom tape draws the arena entries and exits, or says it is standing by', () => {
    const tape = ['GENESIS BUY BONK $20.00 4M', 'RUNNER SELL WIF +$2.14 12M'];
    // The sanitiser collapses runs of spaces, so the joiner paints as " /// ".
    expect(draw({ phase: 'ready', rows: [row()], tape }).strings).toContain(
      'GENESIS BUY BONK $20.00 4M /// RUNNER SELL WIF +$2.14 12M',
    );
    expect(draw({ phase: 'ready', rows: [row()] }).strings).toContain(
      'ARENA TRADE TAPE STANDING BY',
    );
  });

  // Found on the Skia preview: the line was joined and then cut at 95
  // characters, which ended it "DIP HUNTER SE." — and with money on the tape a
  // cut can turn "-$3.21" into "-$3.2.", a different figure.
  test('the ticker packs whole entries and never cuts one, least of all a figure', () => {
    const tape = [
      'RUNNER SELL WIF +$2.14 2M',
      'GENESIS BUY BONK $20.00 4M',
      'DIP HUNTER SELL POPCAT -$3.21 12M',
      'ALICE TRAD BUY MOODENG $20.00 15M',
    ];
    const drawn = draw({ phase: 'ready', rows: [row()], tape }).strings;
    const line = drawn.find((value) => value.startsWith('RUNNER SELL WIF'))!;
    expect(line).toBe(
      'RUNNER SELL WIF +$2.14 2M /// GENESIS BUY BONK $20.00 4M /// DIP HUNTER SELL POPCAT -$3.21 12M',
    );
    expect(line.length).toBeLessThanOrEqual(95);
    // Every entry on the line is WHOLE: it is one of the inputs, unchanged.
    for (const part of line.split(' /// ')) expect(tape).toContain(part);
    // A first entry too long for the row is skipped rather than cut.
    const skipped = draw({ phase: 'ready', rows: [row()], tape: ['O'.repeat(120), tape[0]!] }).strings;
    expect(skipped).toContain('RUNNER SELL WIF +$2.14 2M');
  });

  test('stripes sit only under real rows', () => {
    const stripes = (count: number) =>
      draw({
        phase: 'ready',
        rows: Array.from({ length: count }, (_unused, index) => row({ rank: index + 1 })),
      }).painted.filter((p) => p.kind === 'rect' && p.fill === COLOR.rowStripe).length;
    expect(stripes(0)).toBe(0);
    expect(stripes(1)).toBe(0);
    expect(stripes(5)).toBe(2);
    expect(stripes(FLOOR_SCREEN_MAX_ROWS)).toBe(FLOOR_SCREEN_MAX_ROWS / 2);
  });
});

// ---------------------------------------------------------------------------
// Geometry: the hand-placed layout, pinned
// ---------------------------------------------------------------------------

describe('Trading Floor board — layout', () => {
  test('no later fill paints over text already on the board, in any phase', () => {
    for (const data of [
      worstCaseBoard(),
      board({ phase: 'ready', rows: liveRows() }),
      board({ phase: 'ready', rows: liveRows().slice(0, 5) }),
      board({ phase: 'ready', rows: [] }),
      board({ phase: 'connecting' }),
      board({ phase: 'error', contest: null }),
    ]) {
      const rec = recorder();
      drawFloorScreen(rec.context, data);
      assertNoFillOverText(rec.painted);
    }
  });

  test('no two strings share space, even with every column at its widest', () => {
    for (const data of [
      worstCaseBoard(),
      board({ phase: 'ready', rows: liveRows().slice(0, 5) }),
      board({ phase: 'connecting' }),
    ]) {
      const rec = recorder();
      drawFloorScreen(rec.context, data);
      assertNoTextOverlap(rec.painted);
    }
  });

  test('absurd figures still keep to their columns and the canvas', () => {
    for (const scale of [-1e4, 1e4 - 0.0005, 1e5, 1e8, 1e11, 1e14, 1e17]) {
      const rec = recorder();
      drawFloorScreen(
        rec.context,
        board({
          phase: 'ready',
          rows: Array.from({ length: FLOOR_SCREEN_MAX_ROWS }, (_unused, index) =>
            row({
              rank: 9990 + index,
              name: 'WWWWWWW '.repeat(5),
              tag: 'no-prize',
              template: 'MMMMMMM '.repeat(5),
              realisedUsd: (index % 2 === 0 ? -1 : 1) * scale * 9.99,
              trades: scale * 9.99,
              wins: scale * 9.99,
              losses: scale * 9.99,
              openPositions: scale,
            }),
          ),
        }),
      );
      assertNoFillOverText(rec.painted);
      assertNoTextOverlap(rec.painted);
      for (const painted of rec.painted) {
        if (painted.kind !== 'text') continue;
        const box = textBox(painted);
        expect({ value: painted.value, inside: box.left >= 0 && box.right <= FLOOR_SCREEN_CANVAS.width }).toEqual({
          value: painted.value,
          inside: true,
        });
      }
    }
  });

  test('the worst case really is at its caps', () => {
    const { strings } = draw(worstCaseBoard());
    // The name and template columns truncate rather than overflow.
    expect(strings).toContain('WWWWWWW WWWWWWW.');
    expect(strings).toContain('MMMMMMM MMMMMMM.');
    expect(strings).toContain('-$12345.67');
    expect(strings).toContain('99999/99999');
    expect(strings).toContain('#100');
    expect(strings).toContain('CLOCK OFFLINE');
    expect(strings).toContain('STARTS IN 27000D 03H 12M');
  });

  // Found while re-deriving the header: the clock was capped at 12 characters,
  // so its own failure word painted as "CLOCK OFFLI." — on the one state that
  // most needs to be read.
  test('the offline clock word is drawn whole', () => {
    expect(draw({ phase: 'ready', clockLabel: 'CLOCK OFFLINE' }).strings).toContain(
      'CLOCK OFFLINE',
    );
  });

  test('nothing on the board is drawn below the legibility floor', () => {
    for (const data of [worstCaseBoard(), board({ phase: 'connecting' })]) {
      const rec = recorder();
      drawFloorScreen(rec.context, data);
      for (const painted of rec.painted) {
        if (painted.kind !== 'text') continue;
        expect({ value: painted.value, px: fontPx(painted.font) >= BOARD_MIN_PX }).toEqual({
          value: painted.value,
          px: true,
        });
      }
    }
    expect(BOARD_MIN_PX).toBe(15);
  });

  // Verifier B, staging 9dc59f73 (shot b-02): at the spawn's ~1.9:1
  // minification the REGULAR 15 px template column read "GENZSIS" and
  // "LATZ BLOOMER" while the BOLD 16 px name column beside it read correctly.
  // A regular Courier stroke is under one texel and falls between samples.
  test('every string on the board is bold, so no stroke is thinner than a texel', () => {
    for (const data of [
      worstCaseBoard(),
      board({ phase: 'ready', rows: liveRows(), tape: ['GENESIS BUY BONK $20.00 4M'] }),
      board({ phase: 'connecting' }),
      board({ phase: 'error', contest: null }),
    ]) {
      const rec = recorder();
      drawFloorScreen(rec.context, data);
      for (const painted of rec.painted) {
        if (painted.kind !== 'text') continue;
        expect({ value: painted.value, bold: painted.font.startsWith('bold ') }).toEqual({
          value: painted.value,
          bold: true,
        });
      }
    }
  });

  // Mipmaps were tried and REVERTED on real-GPU evidence (2026-09-30): with
  // trilinear sampling, bold cells that had read correctly single-level broke
  // at the spawn ("LANDTKST1", "NO PRIZR", local c-10b vs staging c-00b). At
  // ~5 screen px per capital, any resample moves the damage; bold +
  // single-level is the state with a clean real-GPU shot. Pinned so a later
  // "obvious" mipmap fix has to read why it was taken out.
  test('the board texture is single-level (mipmaps were tried and reverted)', () => {
    const source = readFileSync(join(import.meta.dir, 'trading-floor-screen.tsx'), 'utf8');
    expect(source).toContain('texture.generateMipmaps = false;');
    expect(source).toContain('texture.minFilter = THREE.LinearFilter;');
    expect(source).not.toContain('LinearMipmapLinearFilter');
  });

  test('the whole board fits the declared canvas', () => {
    const rec = recorder();
    drawFloorScreen(rec.context, worstCaseBoard());
    for (const [x, y, w, h] of rec.rects) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(FLOOR_SCREEN_CANVAS.width + 0.001);
      expect(y + h).toBeLessThanOrEqual(FLOOR_SCREEN_CANVAS.height + 0.001);
    }
    for (const painted of rec.painted) {
      if (painted.kind !== 'text') continue;
      const box = textBox(painted);
      expect({ value: painted.value.slice(0, 20), inside: box.left >= 0 && box.right <= FLOOR_SCREEN_CANVAS.width && box.top >= 0 && box.bottom <= FLOOR_SCREEN_CANVAS.height }).toEqual({
        value: painted.value.slice(0, 20),
        inside: true,
      });
    }
  });

  // The pin above is only worth its line if the CHECKER catches the shapes we
  // care about. These three all passed the first anchor-point version; two of
  // them were found by tf3d-audit attacking it rather than by me writing it.
  describe('the paint-order checker itself', () => {
    // `fill` is irrelevant to geometry but part of the record shape now that
    // the legibility test derives from colour.
    const left = (value: string, x: number, y: number, size = 14) =>
      ({
        kind: 'text',
        x,
        y,
        value,
        font: `${size}px mono`,
        align: 'left',
        fill: '#000',
      }) as const;
    const right = (value: string, x: number, y: number, size = 16) =>
      ({
        kind: 'text',
        x,
        y,
        value,
        font: `bold ${size}px mono`,
        align: 'right',
        fill: '#000',
      }) as const;
    const rect = (x: number, y: number, w: number, h: number) =>
      ({ kind: 'rect', x, y, w, h }) as const;

    test('catches a bed that lands ON the baseline — the original bug', () => {
      expect(boxHitsRect(textBox(left('LAST', 100, 144)), rect(90, 140, 200, 46))).toBe(
        true,
      );
    });

    test('catches a bed that lands ABOVE the baseline, over the glyph body', () => {
      // Anchor at y 144 is OUTSIDE a rect spanning 119..139, but a 14px glyph
      // body runs from ~133.9 up, so the text is more obscured, not less. The
      // anchor version reported this clean.
      const box = textBox(left('LAST', 100, 144));
      expect(box.top).toBeLessThan(139);
      expect(boxHitsRect(box, rect(90, 119, 200, 20))).toBe(true);
    });

    test('catches a rect over right-aligned glyphs that stops short of the anchor', () => {
      // The clock is drawn right-aligned at W − 22, so its glyphs run LEFT from
      // there. A rect covering the run but ending before the anchor column
      // contains no anchor at all.
      const box = textBox(right('14:32 UTC', 1002, 27));
      expect(box.right).toBeCloseTo(1002, 5);
      expect(box.left).toBeLessThan(950);
      expect(boxHitsRect(box, rect(900, 14, 80, 20))).toBe(true);
    });

    // Non-vacuity for the TEXT-OVER-TEXT pin: the exact round-7 shape, two
    // strings at the same x and y, must be detected.
    test('detects two strings drawn at the same position', () => {
      const a = textBox(left('VERIFIED 12', 18, 152, 15));
      const b = textBox(left('OPEN 1', 18, 152, 15));
      const overlap =
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      expect(overlap).toBe(true);
      // And two on the same row that genuinely clear each other do not fire.
      const far = textBox(left('4M AGO', 300, 152, 15));
      expect(a.left < far.right && a.right > far.left).toBe(false);
    });

    test('does not fire on a rect that genuinely clears the glyphs', () => {
      expect(boxHitsRect(textBox(left('LAST', 100, 138)), rect(90, 161, 200, 44))).toBe(
        false,
      );
      expect(
        boxHitsRect(textBox(right('14:32 UTC', 1002, 27)), rect(0, 40, 600, 60)),
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// The data half: the three arena payloads -> the drawable shape
// ---------------------------------------------------------------------------

describe('Trading Floor board — leaderboard mapping', () => {
  test('reads the route envelope and the bare array the panel hook returns', () => {
    const fromEnvelope = buildFloorScreenData(inputs(), NOW);
    const fromArray = buildFloorScreenData(inputs({ leaderboard: ready([wireRow()]) }), NOW);
    expect(fromEnvelope.rows).toEqual(fromArray.rows);
    expect(fromEnvelope.rows[0]).toEqual({
      rank: 1,
      name: 'Genesis',
      tag: 'house',
      template: 'Genesis',
      realisedUsd: -5.2,
      trades: 10,
      wins: 4,
      losses: 6,
      openPositions: 1,
    });
  });

  test('loading and a never-answered error are their own phases, never an empty table', () => {
    expect(buildFloorScreenData(inputs({ leaderboard: LOADING }), NOW).phase).toBe('connecting');
    expect(buildFloorScreenData(inputs({ leaderboard: ready(undefined) }), NOW).phase).toBe(
      'connecting',
    );
    expect(buildFloorScreenData(inputs({ leaderboard: failed() }), NOW).phase).toBe('error');
  });

  // ONE RULE FOR THE ROOM (lead, 2026-10-01): a failed refetch keeps the LAST
  // GOOD data, as react-query does and as the 3D tape and the floor status
  // label already draw it; only a query that never had data shows the error.
  test('a failed refetch keeps the last good table, and costs no redraw', () => {
    const good = inputs({ leaderboard: ready({ rows: [wireRow()] }) });
    const failedAfterData = inputs({ leaderboard: failed({ rows: [wireRow()] }) });
    const kept = buildFloorScreenData(failedAfterData, NOW);
    expect(kept.phase).toBe('ready');
    expect(kept.rows).toEqual(buildFloorScreenData(good, NOW).rows);
    // The error alone moves nothing the board draws, so no repaint.
    expect(floorScreenSignature(failedAfterData)).toBe(floorScreenSignature(good));
  });

  test('rows are drawn in rank order, an unreadable rank last, capped at the table', () => {
    const rows = [
      wireRow({ rank: 3, agentId: 'c', name: 'C' }),
      wireRow({ rank: 'x', agentId: 'z', name: 'Z' }),
      wireRow({ rank: 1, agentId: 'a', name: 'A' }),
      wireRow({ rank: 2, agentId: 'b', name: 'B' }),
      ...Array.from({ length: 10 }, (_unused, index) =>
        wireRow({ rank: 4 + index, agentId: `n${index}`, name: `N${index}` }),
      ),
    ];
    const data = buildFloorScreenData(inputs({ leaderboard: ready(rows) }), NOW);
    expect(data.rows).toHaveLength(FLOOR_SCREEN_MAX_ROWS);
    expect(data.rows.slice(0, 3).map((value) => value.name)).toEqual(['A', 'B', 'C']);
    expect(data.rows.map((value) => value.name)).not.toContain('Z');
  });

  test('the panel hook maps a missing rank to 0; "#0" is not a place', () => {
    const data = buildFloorScreenData(inputs({ leaderboard: ready([wireRow({ rank: 0 })]) }), NOW);
    expect(Number.isNaN(data.rows[0]!.rank)).toBe(true);
  });

  test('a player anywhere on the board, not only in the top rows, silences the call to action', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_unused, index) =>
        wireRow({ rank: index + 1, agentId: `house:${index}` }),
      ),
      wireRow({ rank: 40, agentId: 'u1', name: 'late player', kind: 'user', eligible: true }),
    ];
    const data = buildFloorScreenData(inputs({ leaderboard: ready(rows) }), NOW);
    expect(data.rows.every((value) => value.tag === 'house')).toBe(true);
    expect(data.hasPlayerAgents).toBe(true);
    expect(buildFloorScreenData(inputs(), NOW).hasPlayerAgents).toBe(false);
  });

  test('a name that is the agent id is no name — an identifier never goes on the wall', () => {
    const id = '5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
    const data = buildFloorScreenData(
      inputs({ leaderboard: ready([wireRow({ agentId: id, name: id, kind: 'user', eligible: true })]) }),
      NOW,
    );
    expect(data.rows[0]!.name).toBe('');
    const { strings } = draw({ ...data, phase: 'ready' });
    expect(strings).toContain('NAME NOT SHOWN');
    expect(strings.join(' ')).not.toContain('5B1C2D3E');
  });

  test('the template column shows the display name, from the shared templates', () => {
    const rows = [
      wireRow({ templateId: 'midcap-climber' }),
      wireRow({ rank: 2, agentId: 'x', templateId: 'no-such-template' }),
    ];
    const data = buildFloorScreenData(inputs({ leaderboard: ready(rows) }), NOW);
    expect(data.rows.map((value) => value.template)).toEqual(['Mid-Cap Climber', 'no-such-template']);
  });

  test('tags: house, ineligible player, eligible player', () => {
    const rows = [
      wireRow({ rank: 1, kind: 'house', eligible: false }),
      wireRow({ rank: 2, agentId: 'u1', kind: 'user', eligible: true }),
      wireRow({ rank: 3, agentId: 'u2', kind: 'user', eligible: false }),
      wireRow({ rank: 4, agentId: 'u3', kind: 'robot', eligible: true }),
    ];
    const data = buildFloorScreenData(inputs({ leaderboard: ready(rows) }), NOW);
    expect(data.rows.map((value) => value.tag)).toEqual(['house', null, 'no-prize', null]);
  });

  // Codex review round 2: `trades - wins` counted a zero-P&L close as a loss
  // while the tape calls it flat. The board reads the route's `losses` only.
  test('losses come from the route only, so a flat close is neither a win nor a loss', () => {
    const read = (overrides: Record<string, unknown>) =>
      buildFloorScreenData(inputs({ leaderboard: ready([wireRow(overrides)]) }), NOW).rows[0]!;
    // Three closes: one win, one loss, one flat.
    const flat = read({ trades: 3, wins: 1, losses: 1 });
    expect(flat.losses).toBe(1);
    const drawn = draw({ phase: 'ready', rows: [flat] }).strings;
    expect(drawn).toContain('1/1');
    expect(drawn).not.toContain('1/2');
    // Absent: printed "-", never derived.
    const absent = read({ trades: 10, wins: 4, losses: undefined });
    expect(Number.isNaN(absent.losses)).toBe(true);
    expect(draw({ phase: 'ready', rows: [absent] }).strings).toContain('4/-');
    expect(Number.isNaN(read({ losses: '2' }).losses)).toBe(true);
  });

  test('a numeric STRING is refused, not coerced: it prints N/A, never a figure', () => {
    const data = buildFloorScreenData(
      inputs({ leaderboard: ready([wireRow({ realisedUsd: '-5.20', openPositions: '2' })]) }),
      NOW,
    );
    expect(Number.isNaN(data.rows[0]!.realisedUsd)).toBe(true);
    expect(Number.isNaN(data.rows[0]!.openPositions)).toBe(true);
  });

  test('a row that is not an object is dropped rather than drawn as a blank', () => {
    const data = buildFloorScreenData(
      inputs({ leaderboard: ready([null, 'x', 7, wireRow()]) }),
      NOW,
    );
    expect(data.rows).toHaveLength(1);
  });

  test('the method line comes from the engine constants, not from a second copy', () => {
    expect(buildFloorScreenData(inputs(), NOW).basis).toEqual({
      positionUsd: FLOOR_ARENA_POSITION_USD,
      buyCostPct: FLOOR_ARENA_PAPER_COSTS.buy_haircut_pct,
      sellCostPct: FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct,
    });
  });
});

describe('Trading Floor board — contest header', () => {
  test('reads the route body and the shipped contest constant', () => {
    const contest = buildFloorScreenData(inputs(), NOW).contest;
    expect(contest).toEqual({
      title: 'Trading Arena Week 1',
      countdownLabel: 'ENDS IN 3D 15H 59M',
      prizes: [
        { place: 1, amount: 1_000_000 },
        { place: 2, amount: 500_000 },
        { place: 3, amount: 250_000 },
      ],
    });
  });

  test('a flattened contest view reads the same', () => {
    const flat = buildFloorScreenData(inputs({ contest: ready({ ...FLOOR_ARENA_CONTEST }) }), NOW);
    expect(flat.contest).toEqual(buildFloorScreenData(inputs(), NOW).contest);
  });

  test('prizes are all or nothing: one unknown token drops the whole line', () => {
    const prizes = (list: unknown) =>
      buildFloorScreenData(
        inputs({ contest: ready(contestBody({ contest: { ...FLOOR_ARENA_CONTEST, prizes: list } })) }),
        NOW,
      ).contest!.prizes;
    expect(
      prizes([
        { place: 1, amount: 1_000_000, token: '$CLAWVILLE' },
        { place: 2, amount: 500_000, token: 'USDC' },
      ]),
    ).toEqual([]);
    expect(prizes([{ place: 1, amount: '1000000', token: '$CLAWVILLE' }])).toEqual([]);
    expect(prizes([{ place: 0, amount: 5, token: '$CLAWVILLE' }])).toEqual([]);
    expect(prizes([])).toEqual([]);
    expect(prizes('lots')).toEqual([]);
    // Out of order on the wire, in order on the wall.
    expect(
      prizes([
        { place: 2, amount: 5, token: '$CLAWVILLE' },
        { place: 1, amount: 9, token: '$CLAWVILLE' },
      ]),
    ).toEqual([
      { place: 1, amount: 9 },
      { place: 2, amount: 5 },
    ]);
  });

  // The panel hook (`hooks/use-floor-arena.ts` `readContest`) sends
  // `{ contest: {...} | null, status, top, house }`. A null block must leave
  // the header generic rather than paint an empty title.
  test("the panel hook's view reads the same, and its null contest block leaves the header generic", () => {
    const view = {
      contest: {
        name: FLOOR_ARENA_CONTEST.name,
        startsAt: FLOOR_ARENA_CONTEST.startsAt,
        endsAt: FLOOR_ARENA_CONTEST.endsAt,
        prizes: FLOOR_ARENA_CONTEST.prizes.map((prize) => ({ ...prize })),
      },
      status: 'live',
      top: [],
      house: [],
    };
    expect(buildFloorScreenData(inputs({ contest: ready(view) }), NOW).contest).toEqual(
      buildFloorScreenData(inputs(), NOW).contest,
    );
    const empty = buildFloorScreenData(
      inputs({ contest: ready({ ...view, contest: null }) }),
      NOW,
    );
    expect(empty.contest?.countdownLabel).toBeNull();
    expect(empty.contest?.prizes).toEqual([]);
    expect(draw({ ...empty }).strings).toContain('TRADING ARENA · PAPER');
  });

  test('a loading contest leaves the header generic, a failed refetch keeps the last good one', () => {
    expect(buildFloorScreenData(inputs({ contest: LOADING }), NOW).contest).toBeNull();
    // Static configuration: its last good value is still true after a failure.
    expect(buildFloorScreenData(inputs({ contest: failed(contestBody()) }), NOW).contest?.title).toBe(
      'Trading Arena Week 1',
    );
  });

  describe('the countdown', () => {
    const start = Date.parse(FLOOR_ARENA_CONTEST.startsAt);
    const end = Date.parse(FLOOR_ARENA_CONTEST.endsAt);

    test('before, during and after the window', () => {
      expect(contestCountdownLabel(start, end, Date.parse('2026-09-30T18:47:30.000Z'))).toBe(
        'STARTS IN 3H 12M',
      );
      expect(contestCountdownLabel(start, end, NOW)).toBe('ENDS IN 3D 15H 59M');
      expect(contestCountdownLabel(start, end, end - 45 * 60_000)).toBe('ENDS IN 45M');
      expect(contestCountdownLabel(start, end, end - (26 * 60 + 3) * 60_000)).toBe(
        'ENDS IN 1D 02H 03M',
      );
      expect(contestCountdownLabel(start, end, end - 30_000)).toBe('ENDS IN UNDER 1M');
      expect(contestCountdownLabel(start, end, end)).toBe('ENDS IN UNDER 1M');
      expect(contestCountdownLabel(start, end, end + 1)).toBe('CONTEST ENDED');
    });

    test('floors, so it can run behind the true time but never ahead of it', () => {
      // 59 min 59 s left reads 59M, not 1H.
      expect(contestCountdownLabel(start, end, end - 3_599_000)).toBe('ENDS IN 59M');
    });

    test('a countdown to a guessed time is worse than none', () => {
      expect(contestCountdownLabel(null, end, NOW)).toBeNull();
      expect(contestCountdownLabel(start, null, NOW)).toBeNull();
      expect(contestCountdownLabel(end, start, NOW)).toBeNull();
      for (const hostile of [Number.NaN, 1e20, 8.64e15, -1]) {
        expect(contestCountdownLabel(start, end, hostile)).toBeNull();
      }
      const broken = buildFloorScreenData(
        inputs({
          contest: ready(
            contestBody({ contest: { ...FLOOR_ARENA_CONTEST, endsAt: '+275760-09-13T00:00:00.000Z' } }),
          ),
        }),
        NOW,
      );
      expect(broken.contest?.countdownLabel).toBeNull();
      expect(draw({ ...broken }).strings.join(' | ')).not.toContain('ENDS IN');
    });
  });
});

describe('Trading Floor board — the bottom tape', () => {
  const tapeFor = (rows: unknown[], nowMs = NOW) =>
    buildFloorScreenData(inputs({ tape: ready(rows) }), nowMs).tape;

  test('an entry names the agent, the side, the token and the ticket', () => {
    expect(tapeFor([tapeRow()])).toEqual(['GENESIS BUY BONK $20.00 4M']);
  });

  // The panel hook's `readTapeItem` output: the same keys, no mint, `at` may
  // be null. The board must read it exactly as it reads the route's rows.
  test("the panel hook's tape items read the same as the route's rows", () => {
    const hookItem = { id: 'e1', at: minutesAgo(4), agentName: 'Genesis', type: 'entry', symbol: 'BONK', usd: 20, pnlUsd: null };
    expect(tapeFor([hookItem])).toEqual(tapeFor([tapeRow()]));
    expect(tapeFor([{ ...hookItem, at: null }])).toEqual(['GENESIS BUY BONK $20.00 RECENT']);
  });

  test('an exit carries its signed result', () => {
    expect(
      tapeFor([
        tapeRow({ id: 'x1', type: 'exit', side: 'sell', agentName: 'Runner', symbol: 'WIF', pnlUsd: 2.144, at: minutesAgo(12) }),
        tapeRow({ id: 'x2', type: 'exit', side: 'sell', agentName: 'Dip Hunter', symbol: 'POPCAT', pnlUsd: -3.21, at: minutesAgo(15) }),
      ]),
    ).toEqual(['RUNNER SELL WIF +$2.14 12M', 'DIP HUNTER SELL POPCAT -$3.21 15M']);
  });

  test('an unpriced exit states the side and no figure', () => {
    expect(
      tapeFor([tapeRow({ type: 'exit', side: 'sell', symbol: 'WIF', pnlUsd: null, at: minutesAgo(2) })]),
    ).toEqual(['GENESIS SELL WIF 2M']);
  });

  test('the mint never reaches the wall, and a symbol that is an address is dropped', () => {
    const tape = tapeFor([tapeRow({ symbol: MINT }), tapeRow({ id: 'e2', symbol: null })]);
    expect(tape).toEqual(['GENESIS BUY $20.00 4M', 'GENESIS BUY $20.00 4M']);
    assertAddressAbsent([...tape], MINT);
  });

  test('entries run newest first; an undated one is kept, last, and never dated', () => {
    expect(
      tapeFor([
        tapeRow({ id: 'old', at: minutesAgo(120) }),
        tapeRow({ id: 'undated', at: null, agentName: 'Runner' }),
        tapeRow({ id: 'new', at: minutesAgo(2) }),
      ]),
    ).toEqual(['GENESIS BUY BONK $20.00 2M', 'GENESIS BUY BONK $20.00 2H', 'RUNNER BUY BONK $20.00 RECENT']);
  });

  test('a future time never reads as a trade that just happened', () => {
    const at = (ms: number) => new Date(ms).toISOString();
    expect(tapeFor([tapeRow({ at: at(NOW + 59_000) })])).toEqual(['GENESIS BUY BONK $20.00 NOW']);
    expect(tapeFor([tapeRow({ at: at(NOW + 61_000) })])).toEqual([
      'GENESIS BUY BONK $20.00 TIME UNKNOWN',
    ]);
    expect(tapeFor([tapeRow({ at: '2099-01-01T00:00:00.000Z' })])).toEqual([
      'GENESIS BUY BONK $20.00 TIME UNKNOWN',
    ]);
    expect(tapeFor([tapeRow({ at: '+275760-09-13T00:00:00.000Z' })])).toEqual([
      'GENESIS BUY BONK $20.00 TIME UNKNOWN',
    ]);
  });

  // The same bad `nowMs` reaches three formatters and only the clock fails
  // loudly; the others would paint "NaNM" without an error anywhere.
  test('a hostile clock cannot blank the board or paint NaN anywhere on it', () => {
    for (const hostile of [Number.NaN, 1e20, 8.64e15, -62167219200001]) {
      const build = () =>
        buildFloorScreenData(
          inputs({ leaderboard: ready([wireRow()]), tape: ready([tapeRow()]) }),
          hostile,
        );
      expect(build).not.toThrow();
      const data = build();
      expect(data.clockLabel).toBe('CLOCK OFFLINE');
      expect(data.contest?.countdownLabel).toBeNull();
      expect(data.tape).toEqual(['GENESIS BUY BONK $20.00 TIME UNKNOWN']);
      const drawn = draw({ ...data });
      expect(drawn.strings.join(' | ')).not.toContain('NAN');
      assertDrawable(drawn.strings);
    }
  });

  test('the tape is bounded, and runs independently of the leaderboard', () => {
    const many = Array.from({ length: 40 }, (_unused, index) =>
      tapeRow({ id: `t${index}`, at: minutesAgo(index + 1) }),
    );
    expect(tapeFor(many)).toHaveLength(12);
    // The table is still connecting; the tape it already has is still drawn.
    expect(
      buildFloorScreenData(inputs({ leaderboard: LOADING, tape: ready([tapeRow()]) }), NOW).tape,
    ).toEqual(['GENESIS BUY BONK $20.00 4M']);
  });

  // coolerTrading's auditor: on a tape refetch ERROR the 3D tape kept its chips
  // and the board cleared its row, so the room gave two answers for one feed.
  // Both now keep the last good rows; only a tape that never answered is empty.
  test('a failed tape refetch keeps the last good tape row, and costs no redraw', () => {
    const good = inputs({ tape: ready([tapeRow()]) });
    const failedAfterData = inputs({ tape: failed([tapeRow()]) });
    expect(buildFloorScreenData(failedAfterData, NOW).tape).toEqual(['GENESIS BUY BONK $20.00 4M']);
    expect(floorScreenSignature(failedAfterData)).toBe(floorScreenSignature(good));
    // The 3D tape reads the same `data`, so it shows the same row.
    expect(buildTapeSources([tapeRow()]).map((source) => source.key)).toEqual(['e1']);
  });

  test('a tape that never answered is empty and says it is standing by', () => {
    const data = buildFloorScreenData(inputs({ tape: failed() }), NOW);
    expect(data.tape).toEqual([]);
    expect(draw({ ...data }).strings).toContain('ARENA TRADE TAPE STANDING BY');
    // And the 3D tape has no chips for it.
    expect(buildTapeSources(undefined)).toEqual([]);
  });
});

describe('Trading Floor board — the header clock', () => {
  test('is UTC and minute-resolution, so every player reads the same wall', () => {
    expect(floorClockLabel(Date.parse('2026-09-19T14:32:45.000Z'))).toBe('14:32 UTC');
    expect(floorClockLabel(Date.parse('2026-09-19T00:05:00.000Z'))).toBe('00:05 UTC');
  });

  test('a broken clock says so instead of printing NaN on the wall', () => {
    expect(floorClockLabel(Number.NaN)).toBe('CLOCK OFFLINE');
    expect(floorClockLabel(Number.POSITIVE_INFINITY)).toBe('CLOCK OFFLINE');
  });

  // Found by tf3d-audit. Two DIFFERENT failures hide behind `Number.isFinite`,
  // and the second one is the dangerous one because it does not throw.
  test('a finite but unusable time never throws and never paints a fake time', () => {
    // Past the max time value: `toISOString` throws, and the only caller is the
    // board's single redraw effect, so a throw is a blank board.
    expect(() => floorClockLabel(1e20)).not.toThrow();
    expect(floorClockLabel(1e20)).toBe('CLOCK OFFLINE');
    expect(floorClockLabel(8.64e15 + 1)).toBe('CLOCK OFFLINE');

    // Representable, does NOT throw, but the year is outside 0000-9999 so
    // `toISOString` returns the 27-character expanded form and slice(11, 16)
    // reads "13T00". That string would have gone on the wall as a time.
    expect(new Date(8.64e15).toISOString()).toBe('+275760-09-13T00:00:00.000Z');
    expect(floorClockLabel(8.64e15)).toBe('CLOCK OFFLINE');
    expect(floorClockLabel(253402300800000)).toBe('CLOCK OFFLINE'); // year 10000
    expect(floorClockLabel(-62167219200001)).toBe('CLOCK OFFLINE'); // year -1
  });

  test('the edges of the plausible range still read as a clock', () => {
    expect(floorClockLabel(4102444799999)).toBe('23:59 UTC'); // 2099-12-31
    expect(floorClockLabel(1)).toBe('00:00 UTC'); // 1970-01-01
    expect(floorClockLabel(4102444800000)).toBe('CLOCK OFFLINE'); // 2100-01-01
    expect(floorClockLabel(0)).toBe('CLOCK OFFLINE');
    expect(floorClockLabel(-1)).toBe('CLOCK OFFLINE');
  });
});

describe('Trading Floor board — redraw signature', () => {
  test('does NOT change when a refetch returns the same board', () => {
    expect(floorScreenSignature(inputs())).toBe(floorScreenSignature(inputs()));
  });

  // The load-bearing exclusion (memory: canvas-texture-signature-ticking-field).
  // The contest body carries two fields that move on EVERY request; letting
  // either into the signature is a full redraw plus a whole-texture upload
  // every poll, forever, for identical pixels.
  test('the contest body fields that tick on every request do not repaint the board', () => {
    const a = inputs({ contest: ready(contestBody({ secondsLeft: 100, generatedAt: '2026-10-01T12:00:00.000Z' })) });
    const b = inputs({ contest: ready(contestBody({ secondsLeft: 70, generatedAt: '2026-10-01T12:00:30.000Z' })) });
    expect(floorScreenSignature(a)).toBe(floorScreenSignature(b));
  });

  test('fields the board does not draw do not repaint it', () => {
    const a = inputs({ leaderboard: ready([wireRow({ lastTradeAt: '2026-10-01T11:00:00.000Z', deaths: 1 })]) });
    const b = inputs({ leaderboard: ready([wireRow({ lastTradeAt: '2026-10-01T11:59:00.000Z', deaths: 3 })]) });
    expect(floorScreenSignature(a)).toBe(floorScreenSignature(b));
    const c = inputs({ tape: ready([tapeRow({ pnlMult: 1.1, reason: 'tp', mint: MINT })]) });
    const d = inputs({ tape: ready([tapeRow({ pnlMult: 1.3, reason: 'time', mint: 'other' })]) });
    expect(floorScreenSignature(c)).toBe(floorScreenSignature(d));
  });

  test('changes when anything the table draws changes', () => {
    const base = floorScreenSignature(inputs());
    for (const change of [
      { realisedUsd: -5.21 },
      { rank: 2 },
      { trades: 11 },
      { wins: 5 },
      { openPositions: 2 },
      { name: 'Genesis II' },
      { templateId: 'runner' },
      { kind: 'user', eligible: true },
    ]) {
      expect({
        change,
        moved: floorScreenSignature(inputs({ leaderboard: ready([wireRow(change)]) })) !== base,
      }).toEqual({ change, moved: true });
    }
  });

  test('changes when the contest header or the tape changes', () => {
    const base = floorScreenSignature(inputs());
    expect(
      floorScreenSignature(
        inputs({ contest: ready(contestBody({ contest: { ...FLOOR_ARENA_CONTEST, name: 'Week 2' } })) }),
      ),
    ).not.toBe(base);
    expect(floorScreenSignature(inputs({ tape: ready([tapeRow()]) }))).not.toBe(base);
    expect(
      floorScreenSignature(inputs({ tape: ready([tapeRow({ type: 'exit', pnlUsd: 1 })]) })),
    ).not.toBe(floorScreenSignature(inputs({ tape: ready([tapeRow({ type: 'exit', pnlUsd: 2 })]) })));
  });

  test('loading, error and ready have their own signatures', () => {
    const signatures = new Set([
      floorScreenSignature(inputs({ leaderboard: LOADING })),
      floorScreenSignature(inputs({ leaderboard: failed() })),
      floorScreenSignature(inputs()),
    ]);
    expect(signatures.size).toBe(3);
  });

  // THE PIXELS are what is load-bearing, not the signature string: fields the
  // board does not draw must change nothing a player can see.
  test('a payload with extra undrawn fields paints exactly the same board', () => {
    const paint = (payload: FloorScreenInputs) => {
      const rec = recorder();
      drawFloorScreen(rec.context, buildFloorScreenData(payload, NOW));
      return rec.painted;
    };
    const plain = inputs({ tape: ready([tapeRow()]) });
    const noisy = inputs({
      leaderboard: ready({ rows: [wireRow({ extra: 'x', deaths: 9, lastTradeAt: null })], generatedAt: 'now' }),
      tape: ready([tapeRow({ pnlMult: 3, reason: 'manual', kind: 'user' })]),
    });
    expect(paint(noisy)).toEqual(paint(plain));
  });
});

describe('Trading Floor board — canvas sizing', () => {
  test('the drawing space is derived from the plane, not re-typed', () => {
    // This pair drifted once already (325 against 392). `FLOOR_SCREEN_CANVAS`
    // is now DERIVED, so this asserts the wiring rather than hoping to catch a
    // divergence after the fact — re-typing either literal breaks it.
    expect(TRADING_FLOOR_SCREEN.canvasWidth).toBe(FLOOR_SCREEN_CANVAS.width);
    expect(TRADING_FLOOR_SCREEN.canvasHeight).toBe(FLOOR_SCREEN_CANVAS.height);
  });

  test('the drawing space matches the plane it is stretched onto', () => {
    // The aspect is the assertion that still has teeth after deriving: the
    // canvas can be any resolution, but a mismatch against the plane shows up
    // as text stretched on the wall, which no unit test of the drawing sees.
    // `trading-floor-room.test.ts` pins this from the geometry side; this is
    // the same invariant read from the side that owns the pixels.
    //
    // NOT an exact-equality contract, and it cannot be: the canvas is whole
    // pixels and the plane is not. 1700/520 = 3.269231 against 1024/313 =
    // 3.271565 is a 0.07% stretch, far below anything visible. The precision-2
    // tolerance (0.005 absolute) is the deliberate slack, so read a failure as
    // "somebody changed one side by a real amount", never as a rounding drift.
    const plane = TRADING_FLOOR_SCREEN.width / TRADING_FLOOR_SCREEN.height;
    const canvas = FLOOR_SCREEN_CANVAS.width / FLOOR_SCREEN_CANVAS.height;
    expect(canvas).toBeCloseTo(plane, 2);
    expect(Math.abs(canvas / plane - 1)).toBeLessThan(0.005);
  });

  // DO NOT DELETE THIS AS REDUNDANT. tf3d-seats' real-GLB test asserts the
  // SHIPPED bytes' scene `extras` against these same constants, and it is the
  // authority when the two disagree — it validates the asset players load.
  // But it is STRUCTURALLY BLIND to the failure that actually shipped this
  // session:
  //
  //   script edited, constants NOT edited, no re-export
  //     → asset still carries the old rect, which still matches the constants
  //     → the extras test passes GREEN
  //     → only this test goes red
  //
  // That is the 20 wu tape-clip defect, caught in the window between the
  // script's mtime and the GLB's. The pair covers script↔constants here and
  // asset↔constants there, and transitively script↔asset; drop either and one
  // edge goes dark. Secondary benefit: the two fail on different repairs —
  // "update the script" versus "re-export the asset" — and this one costs no
  // GLB decode.
  //
  // The THIRD copy of this rect, and the only one that cannot be derived: the
  // asset pipeline authors the surround, so the GLB's opening and the runtime
  // plane are produced by different programs. `trading-floor-room.ts` states
  // the contract in prose — "these numbers and the `SCREEN_*` constants in
  // build-interior.mjs must agree or the plane floats inside its own frame" —
  // and until now nothing enforced it (tf3d-audit grepped: zero hits for
  // `SCREEN_H`). It went wrong in flight this session: the script sat at
  // 520/360 while the room said 540/340, which would have rendered the bottom
  // 20 wu of live canvas, the TAPE row's end, behind the bottom bezel. The
  // aspect pins could not see it because they compare the canvas to the plane,
  // and neither knows the frame exists.
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
    expect(pickCanvasScale(2)).toBe(2);
    expect(pickCanvasScale(3)).toBe(2);
    expect(pickCanvasScale(Number.NaN)).toBe(1);
  });
});
