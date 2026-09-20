import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  drawFloorScreen,
  FLOOR_SCREEN_CANVAS,
  formatSignedUsd,
  pickCanvasScale,
  pnlColor,
  sanitiseScreenText,
  COLOR,
  wrapBasis,
  type FloorScreenContext,
  type FloorScreenData,
  type FloorScreenRealised,
  type FloorScreenRealisedState,
  type FloorScreenSlot,
} from './trading-floor-screen-texture';
import {
  buildFloorScreenData as rawBuildFloorScreenData,
  floorClockLabel,
  floorScreenSignature as rawFloorScreenSignature,
} from './trading-floor-screen-data';
import type { RiskFreshness } from '@/components/game/trading-floor/house-trader-risk';

/**
 * DEFAULT FRESHNESS for the tests that are not about expiry: the response was
 * fetched at the instant it is being read, so `heldSeconds` is 0 and only the
 * block's own `ageSeconds` counts. Every fixture sits well inside the 150 s
 * budget, so these calls behave exactly as they did before expiry existed.
 * The expiry tests pass their own clock explicitly.
 *
 * Wrapping rather than editing twenty call sites keeps the PRODUCTION
 * signatures strict: `freshness` is a required parameter there precisely so a
 * new caller cannot forget it, which is the same reason `frozen` is required
 * on `resolveTradingFloorInteraction`.
 */
const FRESH: RiskFreshness = { nowMs: 0, dataUpdatedAt: 0 };

function buildFloorScreenData(
  slots: Parameters<typeof rawBuildFloorScreenData>[0],
  state: Parameters<typeof rawBuildFloorScreenData>[1],
  nowMs: number,
  dataUpdatedAt: number = nowMs,
) {
  // DEFAULTS TO `nowMs`, not to zero. Fetched at the instant it is read, so
  // `heldSeconds` is 0 and only the block's own `ageSeconds` counts. Defaulting
  // to 0 against a real wall-clock `nowMs` made every fixture look 56 years
  // stale and expired the lot.
  return rawBuildFloorScreenData(slots, state, nowMs, dataUpdatedAt);
}

function floorScreenSignature(
  slots: Parameters<typeof rawFloorScreenSignature>[0],
  state: Parameters<typeof rawFloorScreenSignature>[1],
  freshness: RiskFreshness = FRESH,
) {
  return rawFloorScreenSignature(slots, state, freshness);
}
import { TRADING_FLOOR_SCREEN } from './trading-floor-room';
import { HOUSE_TRADER_LINEUP, TRADE_MINTS } from '@clawville/shared';
import type { HouseTraderSlotView } from '@/hooks/use-trading-floor';
import type { FloorTrade } from '@/stores/trade-ticker';

/**
 * Recording 2D context. `drawFloorScreen` never measures or reads back, so a
 * recorder is a complete stand-in for the real canvas and the test exercises
 * the SHIPPING draw code rather than a parallel description of it.
 */
type Painted =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
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
 * THE TWO GEOMETRY PINS, as functions so a new board state can be swept by both
 * without copying their loops.
 *
 * They were inline in one test each when the card had one live layout. The
 * status word can now say "PAUSED: RISK LIMIT" — 18 characters where "LIVE" was
 * four — so every state has to be swept, and a copied loop is how one of them
 * would quietly stop being.
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
 * `focus` narrows the sweep to pairs involving a named string. It exists for
 * the NARROWEST card the layout produces — a three-slot board at 314 px — where
 * the estimator reports a 0.6 px collision between the `(PARTIAL)` caption and
 * the 30 px headline that the real metrics do not have: Courier New's cap
 * height is 0.572 em against the estimator's 0.72, so the headline's true top
 * is 70.5 and the caption's true bottom is 68.4, two pixels clear. Rather than
 * loosen the estimator, which exists to be pessimistic, a new string is swept
 * against every other string at every width and the full pairwise sweep runs at
 * the one and two-slot widths the lineup actually produces.
 */
function assertNoTextOverlap(
  painted: Painted[],
  focus?: (value: string) => boolean,
): void {
  const texts = painted.filter(
    (p): p is Extract<Painted, { kind: 'text' }> => p.kind === 'text',
  );
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      if (focus && !focus(texts[i]!.value) && !focus(texts[j]!.value)) continue;
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
      painted.push({ kind: 'rect', x, y, w, h });
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

function slot(overrides: Partial<FloorScreenSlot> = {}): FloorScreenSlot {
  return {
    label: 'Genesis',
    status: 'live',
    verified: 12,
    scored: 8,
    lastTradeLabel: '4m ago',
    ...overrides,
  };
}

/** The drawable realised block. Genesis's real staging figure is negative, and
 *  the default is negative on purpose: a loss is the case most likely to be got
 *  wrong by a change that only ever looked at a win. */
function realised(
  overrides: Partial<FloorScreenRealised> = {},
): FloorScreenRealisedState {
  return {
    kind: 'ready',
    closedPositions: 10,
    wins: 4,
    losses: 6,
    realisedUsd: -5.2,
    bestUsd: 2.4,
    worstUsd: -3.1,
    openPositions: 1,
    basisCode: 'gross_usdc_leg',
    costBasis: 'round_trip_fifo',
    noExitHours: 24,
    note: 'Gross realised on the USDC leg; excludes network fees and rent',
    partial: false,
    excludedNonUsdc: 0,
    noExitClosures: 0,
    ...overrides,
  };
}

/** Narrow to the READY arm, asserting the state on the way. Every use of this
 *  is a test that means "this input should have produced figures". */
function ready(state: FloorScreenRealisedState | undefined) {
  expect(state?.kind).toBe('ready');
  return state as Extract<FloorScreenRealisedState, { kind: 'ready' }>;
}

/** The shape as it arrives ON THE WIRE, which is NOT the drawable shape: the
 *  route sends `basis` (a machine code) plus `note`, and the leg counters that
 *  become `partial`. */
function fullRealised(): Record<string, unknown> {
  return {
    closedPositions: 10,
    wins: 4,
    losses: 6,
    realisedUsd: -5.2,
    bestUsd: 2.4,
    worstUsd: -3.1,
    openPositions: 1,
    basis: 'gross_usdc_leg',
    note: 'Gross realised on the USDC leg; excludes network fees and rent',
    preBindIncluded: false,
    unpricedLegs: 0,
    unclassifiedLegs: 0,
    computedAt: '2026-09-20T12:00:00.000Z',
  };
}

/** Every `draw` call supplies the clock and tape, so a new drawn field can
 *  never slip into the board without passing the banned-token gate below. */
function board(
  data: Omit<FloorScreenData, 'clockLabel' | 'tape'> &
    Partial<Pick<FloorScreenData, 'clockLabel' | 'tape'>>,
): FloorScreenData {
  return { clockLabel: '14:32 UTC', tape: [], ...data };
}

function draw(data: Parameters<typeof board>[0]) {
  const rec = recorder();
  drawFloorScreen(rec.context, board(data));
  return rec;
}

// ---------------------------------------------------------------------------
// THE RULE, AS IT ACTUALLY IS (founder, 2026-09-20): the board is a PUBLIC LIVE
// P&L board. Money DRAWS. What this block gates is the two things that are
// still true: a wallet address never reaches the wall, and every money figure
// comes from a TYPED field rather than from server text.
//
// This file previously asserted the opposite, in detail, because a peer session
// relayed a "no P&L" rule that was never the founder's. The tests are the
// record of what we believe, so they had to move too.
// ---------------------------------------------------------------------------

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
 * since the basis band is 46 characters once its spaces are gone.
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
      tooLong: value.length > 64,
    }).toEqual({ value, base58: false, hex: false, invisible: false, tooLong: false });
  }
}

describe('Trading Floor board — untrusted text hygiene', () => {
  test('a normal board draws nothing an outside string could poison', () => {
    assertDrawable(
      draw({
        phase: 'ready',
        slots: [slot(), slot({ label: 'ClawVille Runner', status: 'stopped' })],
      }).strings,
    );
  });

  test('every loading and empty state is clean too', () => {
    assertDrawable(draw({ phase: 'connecting', slots: [] }).strings);
    assertDrawable(draw({ phase: 'error', slots: [] }).strings);
    assertDrawable(draw({ phase: 'ready', slots: [] }).strings);
    assertDrawable(draw({ phase: 'ready', slots: [slot()] }).strings);
  });

  // The reason the sanitiser still exists. Labels, venue names and the basis
  // note are server text on a wall in the game world.
  test('a wallet address in a label never reaches the board', () => {
    const solana = '7xKXtg2CW3eTA1hqzVfKp8mKQqZ9rPfLmNbVcXyZaQw1';
    const evm = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
    const hostile = draw({
      phase: 'ready',
      slots: [
        slot({ label: `Genesis ${solana}`, lastTradeLabel: solana }),
        slot({ label: `Genesis ${evm}`, lastTradeLabel: evm }),
      ],
    });
    assertDrawable(hostile.strings);
    expect(hostile.strings.join(' ')).not.toContain(solana.slice(0, 16));
    expect(hostile.strings.join(' ')).not.toContain(evm.slice(0, 16));
  });

  test('an address hidden in the basis note never reaches the board', () => {
    const solana = '7xKXtg2CW3eTA1hqzVfKp8mKQqZ9rPfLmNbVcXyZaQw1';
    const drawn = draw({
      phase: 'ready',
      // An unrecognised code forces the PROSE fallback, which is the only path
      // where server text reaches the band and therefore the only one where
      // the sanitiser still matters.
      slots: [
        slot({ realised: realised({ costBasis: 'unknown', note: `gross ${solana}` }) }),
      ],
    });
    assertDrawable(drawn.strings);
    expect(drawn.strings.join(' ')).not.toContain(solana.slice(0, 16));
  });

  // AN ADDRESS SPLIT BY AN INVISIBLE CHARACTER. The header's `pro<ZWSP>fit`
  // note says the fix is "strip invisibles before anything tokenises" — and for
  // a COMBINING MARK that was being undone by the `.normalize()` running ahead
  // of the strip. NFKC COMPOSES `p` + U+0301 into one character the strip does
  // not know, so `BASE58_RUN` saw a 19 and a 24 and matched neither, and
  // `DISALLOWED` turned the composed character into a SPACE. The shipped
  // function returned, verbatim:
  //
  //   "NOTE 7XKXTG2CW87D97TXJSD BD5JBKHETQA83TZRUJOSGASU"
  //
  // A whole wallet address, readable, on a wall in the game world, out of the
  // one function whose job is to keep it off. NFKD keeps the mark separate and
  // `INVISIBLE` already covers U+0300-U+036F. (tfs-audit + tfs-api, both ends
  // chose NFKD so the two sanitisers agree.)
  //
  // THE DETECTOR IS THE OTHER HALF OF THIS TEST. Do NOT assert
  // `not.toContain(address)`: the output is UPPERCASED and the composed
  // character is dropped entirely, so the leaked string is the address minus
  // one letter and a naive `includes` reports clean on text that plainly shows
  // it. My first probe did exactly that and called this bug fixed. Assert on
  // what survives instead: with the address stripped there is nothing left but
  // the prefix.
  test.each([
    ['a combining acute', 0x0301],
    ['a zero-width space', 0x200b],
    ['a soft hyphen', 0x00ad],
    ['a word joiner', 0x2060],
    // WIDENED 2026-09-20 from a hand-listed range set to the Unicode
    // PROPERTIES `\p{M}`, `\p{Cf}`, `\p{Cc}`, `\p{Zl}`, `\p{Zp}` and
    // `\p{Default_Ignorable_Code_Point}`. The old list was an enumeration of
    // the shapes we happened to have thought of, and these two were outside
    // it: U+1AB0 is a combining mark beyond the U+0300-U+036F block the list
    // named, and U+FE0F is a variation selector, which is also a mark. Both
    // split a base58 run exactly like a combining acute. Properties are the
    // derived form of the same idea and cannot be short by omission.
    ['a high combining mark U+1AB0', 0x1ab0],
    ['a variation selector U+FE0F', 0xfe0f],
  ])('an address split by %s still never reaches the board', (_name, codePoint) => {
    const address = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const head = address.slice(0, 20);
    const tail = address.slice(20);
    const split = `note ${head}${String.fromCharCode(codePoint)}${tail}`;

    const out = sanitiseScreenText(split, 200);
    // The address is GONE, not merely unmatched: only the prefix survives.
    expect(out).toBe('NOTE');
    // The two HALVES the split creates, named explicitly: these are the exact
    // strings the leak painted either side of its space.
    expect(out).not.toContain(head.toUpperCase());
    expect(out).not.toContain(tail.toUpperCase());
    // No long alphanumeric run survives once the splitting space is removed.
    expect(out.replace(/[^A-Za-z0-9]/g, '')).not.toMatch(/[A-Za-z0-9]{32,}/);
    assertAddressAbsent([out], address);

    // And through the real draw path, not just the function. The 32-run check
    // is deliberately NOT repeated over the whole board here: the basis band is
    // 46 characters once its spaces are gone, so that assertion fires on
    // legitimate copy. `assertAddressAbsent` is the board-safe form.
    const drawn = draw({ phase: 'ready', slots: [slot({ label: split })] });
    assertDrawable(drawn.strings);
    assertAddressAbsent(drawn.strings, address);
    for (const value of drawn.strings) {
      expect(value).not.toContain(head.toUpperCase());
      expect(value).not.toContain(tail.toUpperCase());
    }
  });

  // THE DENSE SHAPE, which no fixed-width window detector can catch. A mark
  // every 8 characters leaves no 16-character run intact, so `assertAddressAbsent`
  // would report clean whatever happened. The assertion here is therefore the
  // EXACT output, which has no blind spot: if a single fragment survived, the
  // string would not be "NOTE".
  //
  // It also exercises something the single-splitter cases do not: that the
  // strip handles REPEATED marks rather than only the first. NFKD decomposes
  // each one independently and `INVISIBLE` is a global replace, so the run
  // rejoins completely and `BASE58_RUN` sees the whole address.
  test('an address peppered with combining marks is still removed entirely', () => {
    const address = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const acute = String.fromCharCode(0x0301);
    const peppered = address.replace(/(.{8})/g, `$1${acute}`);
    expect(peppered.length).toBeGreaterThan(address.length + 3);

    const out = sanitiseScreenText(`note ${peppered}`, 200);
    expect(out).toBe('NOTE');

    const drawn = draw({ phase: 'ready', slots: [slot({ label: `note ${peppered}` })] });
    assertDrawable(drawn.strings);
    // Every 8-character piece is gone too, not merely the long runs.
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

  // THREE SHAPES THAT REACHED THE WALL, each pinned by EXACT OUTPUT rather
  // than by a detector. tfs-audit proved the first two against this file and
  // Codex found the same at ingest; the third came out of probing for the set
  // instead of the reported members.
  //
  // Exact output is the assertion that has no sample to be outside of. Every
  // detector in this file has now been fooled once: `includes` by a dropped
  // character, a base58 regex by upper-casing, a long-run check by legitimate
  // copy, and a 16-character window by dense marks. `toBe('NOTE')` cannot be.
  test.each([
    // The digits were case-insensitive; the `0x` PREFIX was a literal lowercase
    // pair, and the strip runs BEFORE `toUpperCase()`. So `0x…` was caught and
    // `0X…` printed in full: "NOTE 0XDEADBEEF1234567890ABCDEF".
    ['an UPPERCASE 0X prefix', 'note 0XdeadBEEF1234567890abcdef'],
    ['a lowercase 0x prefix', 'note 0xdeadBEEF1234567890abcdef'],
    // Neither hex pass saw this one: no `0x` for `HEX_ADDRESS`, and the run
    // contains `0`, which base58 excludes.
    ['hex with no prefix at all', 'note deadBEEF1234567890abcdef1234'],
  ])('%s never reaches the board', (_name, input) => {
    expect(sanitiseScreenText(input, 200)).toBe('NOTE');
    const drawn = draw({ phase: 'ready', slots: [slot({ label: input })] });
    assertDrawable(drawn.strings);
    for (const value of drawn.strings) {
      expect(value).not.toMatch(/[0-9A-F]{20,}/);
    }
  });

  // ONE PASS MUST NOT CUT ANOTHER PASS'S TOKEN. `G`x12 + `a`x20 + `H`x12 is a
  // 44-character base58 run whose middle 20 characters are also a hex run. With
  // sequential replaces the bare-hex pass blanked the middle FIRST, leaving two
  // 12-character pieces that were each under the base58 minimum and printed:
  // "NOTE GGGGGGGGGGGG HHHHHHHHHHHH". Self-inflicted, by the bare-hex pass
  // added to close a different hole. The strip now matches every pattern on the
  // INTACT text and deletes the union, so there is no ordering question left to
  // get wrong. (Codex round 3.)
  test('a hex run inside a base58 run cannot split it into printable halves', () => {
    const spliced = `note ${'G'.repeat(12)}${'a'.repeat(20)}${'H'.repeat(12)}`;
    expect(sanitiseScreenText(spliced, 200)).toBe('NOTE');
    const drawn = draw({ phase: 'ready', slots: [slot({ label: spliced })] });
    assertDrawable(drawn.strings);
    for (const value of drawn.strings) {
      expect(value).not.toMatch(/G{8,}|H{8,}/);
    }
  });

  // THE UPPER BOUND WAS A TAIL. `{32,64}` with `/g` consumed the first 64
  // characters of an 88-character run and left the remaining 24 under the
  // minimum, so they were not matched and they printed:
  // "NOTE BD5JBKHETQA83TZRUJOSGASU". A run being LONGER than an address is not
  // a reason to publish part of it.
  test('a base58 run longer than an address leaves no tail', () => {
    const address = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const doubled = `note ${address}${address}`;
    expect(sanitiseScreenText(doubled, 200)).toBe('NOTE');
    assertAddressAbsent([sanitiseScreenText(doubled, 200)], address);
  });

  // The fold NFKD is still there to do, unchanged by the switch: a label may
  // not smuggle an address through in another alphabet.
  test('fullwidth look-alikes are still folded onto ASCII', () => {
    expect(sanitiseScreenText('ＧＥＮＥＳＩＳ', 40)).toBe('GENESIS');
    // And an accent now reads as its letter rather than losing its place to a
    // space, which is what NFKC did here.
    expect(sanitiseScreenText('Café desk', 40)).toBe('CAFE DESK');
  });

  test('invisible characters and unrenderable glyphs are stripped', () => {
    const drawn = draw({
      phase: 'ready',
      slots: [slot({ label: 'Gen​esis\u0000 🚀' })],
    });
    assertDrawable(drawn.strings);
  });

  test('an over-long label is truncated rather than overflowing the card', () => {
    expect(sanitiseScreenText('A'.repeat(80), 18).length).toBeLessThanOrEqual(18);
  });

  test('the sanitiser is linear on a hostile-length input', () => {
    const started = performance.now();
    sanitiseScreenText('A1'.repeat(60_000));
    sanitiseScreenText('1'.repeat(60_000));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  // MONEY NOW DRAWS. These are the strings the previous rule destroyed; they
  // are here so a future reader cannot mistake the old behaviour for intent.
  test.each([
    ['a dollar figure in a label', '$GENESIS', '$GENESIS'],
    ['a percentage', 'UP 40%', 'UP 40%'],
    ['a signed number', '+420', '+420'],
    ['a money word', 'PROFIT RUN', 'PROFIT RUN'],
    ['a currency code', 'USD 100', 'USD 100'],
    ['an underscore compound', 'UP_10', 'UP 10'],
  ])('%s now survives — the board publishes money', (_name, input, expected) => {
    expect(sanitiseScreenText(input, 40)).toBe(expected);
  });

  test('every shipped label still survives unchanged', () => {
    for (const [input, expected] of [
      ['PUMP.FUN', 'PUMP.FUN'],
      ['4m ago', '4M AGO'],
      ['ANSEM PUMPSWAP 4M', 'ANSEM PUMPSWAP 4M'],
      ['14:32 UTC', '14:32 UTC'],
      ['ClawVille Runner', 'CLAWVILLE RUNNER'],
      ['NOT RUNNING YET', 'NOT RUNNING YET'],
      ['gross, excludes network fees', 'GROSS, EXCLUDES NETWORK FEES'],
    ] as const) {
      expect(sanitiseScreenText(input, 44)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// PROVENANCE. Every money figure on this board is formatted here from a typed
// numeric field. Nothing is pasted from server text, and nothing is a literal.
// ---------------------------------------------------------------------------

describe('Trading Floor board — money comes from typed fields only', () => {
  // THREE absences, three words (orchestrator decision, 2026-09-20). Saying
  // "this trader has not closed anything" when the truth is "we could not read
  // its figures" is a false claim about the TRADER, made by a board that cannot
  // tell the difference. Neither is ever a zero.
  test('a missing realised block reads P&L UNAVAILABLE, not empty', () => {
    const joined = draw({ phase: 'ready', slots: [slot()] }).strings.join(' | ');
    expect(joined).not.toContain('$');
    expect(joined).toContain('P&L UNAVAILABLE');
    expect(joined).not.toContain('NO CLOSED POSITIONS YET');
  });

  test('a block that fails the runtime guard reads P&L UNAVAILABLE', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const broken = buildFloorScreenData(
      [
        {
          ...view(),
          realised: { ...fullRealised(), realisedUsd: Number.NaN },
        } as unknown as HouseTraderSlotView,
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(broken.slots[0]!.realised?.kind).toBe('unavailable');
    const joined = draw({
      phase: 'ready',
      slots: [slot({ realised: broken.slots[0]!.realised })],
    }).strings.join(' | ');
    expect(joined).toContain('P&L UNAVAILABLE');
    expect(joined).not.toContain('NO CLOSED POSITIONS YET');
    expect(joined).not.toContain('$0.00');
  });

  test('a VALID block with nothing closed reads NO CLOSED POSITIONS YET', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const fresh = buildFloorScreenData(
      [
        {
          ...view(),
          realised: { ...fullRealised(), closedPositions: 0, realisedUsd: 0 },
        } as unknown as HouseTraderSlotView,
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(fresh.slots[0]!.realised?.kind).toBe('none');
    const joined = draw({
      phase: 'ready',
      slots: [slot({ realised: fresh.slots[0]!.realised })],
    }).strings.join(' | ');
    expect(joined).toContain('NO CLOSED POSITIONS YET');
    expect(joined).not.toContain('P&L UNAVAILABLE');
    expect(joined).not.toContain('$0.00');
  });

  test('P&L is drawn when the typed block is present', () => {
    const joined = draw({
      phase: 'ready',
      slots: [slot({ realised: realised({ realisedUsd: -5.2, wins: 3, losses: 7 }) })],
    }).strings.join(' | ');
    expect(joined).toContain('-$5.20');
    expect(joined).toContain('W 3');
    expect(joined).toContain('L 7');
  });

  // `String(...)` is not noise: `formatSignedUsd` returns a BRANDED type, so a
  // bare string literal is not assignable to it and `toBe('+$8.87')` is itself
  // a type error. That is the brand doing its job at the assertion site.
  test('a gain is signed and a loss is signed, both published alike', () => {
    expect(String(formatSignedUsd(8.87))).toBe('+$8.87');
    expect(String(formatSignedUsd(-5.2))).toBe('-$5.20');
    expect(String(formatSignedUsd(0))).toBe('$0.00');
    expect(String(formatSignedUsd(Number.NaN))).toBe('N/A');
    // Three outcomes, three meanings: null is "nothing closed", non-finite is
    // bad data, and neither is allowed to become a zero.
    expect(String(formatSignedUsd(null))).toBe('-');
  });

  test('colour follows the sign, and flat is neither', () => {
    expect(pnlColor(1)).toBe(pnlColor(99));
    expect(pnlColor(-1)).toBe(pnlColor(-99));
    expect(pnlColor(1)).not.toBe(pnlColor(-1));
    expect(pnlColor(0)).not.toBe(pnlColor(1));
    expect(pnlColor(0)).not.toBe(pnlColor(-1));
  });

  test('best and worst are drawn from their own fields', () => {
    const joined = draw({
      phase: 'ready',
      slots: [slot({ realised: realised({ bestUsd: 12.5, worstUsd: -9.75 }) })],
    }).strings.join(' | ');
    expect(joined).toContain('BEST +$12.50');
    expect(joined).toContain('WORST -$9.75');
  });

  test('positions left out of the figure are counted on the card', () => {
    const joined = draw({
      phase: 'ready',
      slots: [slot({ realised: realised({ excludedNonUsdc: 3 }) })],
    }).strings.join(' | ');
    expect(joined).toContain('3 NON-USDC EXCLUDED');
  });

  test('no excluded line when nothing was left out', () => {
    const joined = draw({
      phase: 'ready',
      slots: [slot({ realised: realised({ excludedNonUsdc: 0 }) })],
    }).strings.join(' | ');
    expect(joined).not.toContain('EXCLUDED');
  });

  test('unpriced legs mark the headline PARTIAL, excluded legs do not', () => {
    const partial = draw({
      phase: 'ready',
      slots: [slot({ realised: realised({ partial: true }) })],
    }).strings.join(' | ');
    expect(partial).toContain('REALISED P&L (PARTIAL)');
    const excludedOnly = draw({
      phase: 'ready',
      slots: [slot({ realised: realised({ excludedNonUsdc: 2 }) })],
    }).strings.join(' | ');
    expect(excludedOnly).toContain('REALISED P&L');
    expect(excludedOnly).not.toContain('(PARTIAL)');
  });

  test('the two leg counters map to their own meanings', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const state = { isLoading: false, isError: false };
    const build = (legs: Record<string, unknown>) =>
      buildFloorScreenData(
        [
          {
            ...view(),
            realised: { ...fullRealised(), ...legs },
          } as unknown as HouseTraderSlotView,
        ],
        state,
        now,
      ).slots[0]!.realised;
    // THREE causes of PARTIAL now. `excludedNonUsdc` became a real field on the
    // route, so it is read directly instead of being inferred from
    // `unclassifiedLegs` as it was when the board had to guess the shape.
    expect(ready(build({ unpricedLegs: 2 })).partial).toBe(true);
    expect(ready(build({ unpricedLegs: 2 })).excludedNonUsdc).toBe(0);
    expect(ready(build({ unclassifiedLegs: 3 })).partial).toBe(true);
    expect(ready(build({ unclassifiedLegs: 3 })).excludedNonUsdc).toBe(0);
    // The real field drives BOTH the partial caption and its own count line.
    expect(ready(build({ excludedNonUsdc: 4 })).excludedNonUsdc).toBe(4);
    expect(ready(build({ excludedNonUsdc: 4 })).partial).toBe(true);
    // All three clear -> a complete figure.
    expect(ready(build({})).partial).toBe(false);
  });

  // THE CASE THE COUNTERS CANNOT SEE. The route sets `partial` when
  // `computedOverTrades` disagrees with `counts.verified` — a figure computed
  // over a truncated read — and in that state every exclusion counter is ZERO.
  // The derived condition would call it complete and the board would present a
  // truncated figure as final, which is the defect that once flipped Genesis
  // from -5.20 to +8.87 USD.
  test('the server partial flag wins even with every counter at zero', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const built = buildFloorScreenData(
      [
        {
          ...view(),
          realised: {
            ...fullRealised(),
            partial: true,
            unpricedLegs: 0,
            unclassifiedLegs: 0,
            excludedNonUsdc: 0,
          },
        } as unknown as HouseTraderSlotView,
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(ready(built.slots[0]!.realised).partial).toBe(true);
    const joined = draw({
      phase: 'ready',
      slots: [slot({ realised: built.slots[0]!.realised })],
    }).strings.join(' | ');
    expect(joined).toContain('REALISED P&L (PARTIAL)');
  });

  test('the derived condition still catches an older payload with no flag', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const legacy = { ...fullRealised(), unpricedLegs: 2 };
    delete (legacy as Record<string, unknown>).partial;
    const built = buildFloorScreenData(
      [{ ...view(), realised: legacy } as unknown as HouseTraderSlotView],
      { isLoading: false, isError: false },
      now,
    );
    expect(ready(built.slots[0]!.realised).partial).toBe(true);
  });

  test('a stringy flag does not flip the caption', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const built = buildFloorScreenData(
      [
        {
          ...view(),
          realised: { ...fullRealised(), partial: 'false' },
        } as unknown as HouseTraderSlotView,
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(ready(built.slots[0]!.realised).partial).toBe(false);
  });

  test('rug write-offs are carried through and drawn', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const built = buildFloorScreenData(
      [
        {
          ...view(),
          realised: { ...fullRealised(), noExitClosures: 2 },
        } as unknown as HouseTraderSlotView,
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(ready(built.slots[0]!.realised).noExitClosures).toBe(2);
    const joined = draw({
      phase: 'ready',
      slots: [slot({ realised: realised({ noExitClosures: 2 }) })],
    }).strings.join(' | ');
    // A total loss booked by a TIMER, not by a sell. Without this rule Genesis
    // reads profitable, because its worst position never produced a sell leg.
    expect(joined).toContain('2 NO-EXIT WRITE-OFF');
  });

  test('no write-off line when nothing was written off', () => {
    const joined = draw({
      phase: 'ready',
      slots: [slot({ realised: realised({ noExitClosures: 0 }) })],
    }).strings.join(' | ');
    expect(joined).not.toContain('NO-EXIT WRITE-OFF');
  });

  // The route's real sentence, 161 characters. It was being drawn at max 64,
  // which cut it mid-word AND left it ending in a full stop — a complete-looking
  // sentence that had lost the FIFO rule and the 24-hour write-off entirely.
  const ROUTE_NOTE =
    'Gross realised on the USDC leg, excludes network fees. Round trips are matched FIFO by token units; ' +
    'a position with no exit after 24 hours counts as a total loss.';

  test('the whole basis sentence reaches the board, method intact', () => {
    const joined = draw({
      phase: 'ready',
      slots: [slot({ realised: realised({ note: ROUTE_NOTE }) })],
    }).strings.join(' ');
    // Read the window from the NOTE, never hard-coded: the rule is the route's
    // to change, and a test that pins 24 would pass while the board lied.
    const hours = /after (\d+) hours/i.exec(ROUTE_NOTE)![1]!;
    expect(joined).toContain('FIFO');
    expect(joined).toContain(`${hours} HOURS`);
    expect(joined).toContain('TOTAL LOSS');
    expect(joined).toContain('EXCLUDES NETWORK FEES');
    // And it does not end mid-word pretending to be finished.
    expect(joined).not.toContain('ROUND.');
  });

  test('the basis wraps rather than truncating, and is drawn once per board', () => {
    const drawn = draw({
      phase: 'ready',
      slots: [
        slot({ realised: realised({ note: ROUTE_NOTE }) }),
        slot({ label: 'ClawVille Runner', realised: realised({ note: ROUTE_NOTE }) }),
      ],
    });
    const basisLines = drawn.strings.filter((s) => s.includes('FIFO') || s.includes('TOTAL LOSS'));
    expect(basisLines.length).toBeGreaterThan(0);
    // TWO slots, but the sentence is a route CONSTANT: drawing it per card was
    // what made it not fit. It belongs to the board, so it appears once.
    expect(drawn.strings.filter((s) => s.includes('FIFO'))).toHaveLength(1);
  });

  test('wrapBasis breaks on words and marks a real overflow', () => {
    expect(wrapBasis('one two three four', 9, 3)).toEqual(['one two', 'three', 'four']);
    // Fits exactly: no ellipsis, nothing lost.
    expect(wrapBasis('abc def', 7, 1)).toEqual(['abc def']);
    // Genuinely too long for the lines allowed -> visible ellipsis, never a
    // silent stop. "..." not a unicode ellipsis, which the sanitiser strips.
    const clipped = wrapBasis('alpha beta gamma delta epsilon', 11, 1);
    expect(clipped).toHaveLength(1);
    expect(clipped[0]!.endsWith('...')).toBe(true);
  });

  // LEGIBILITY FLOOR, measured not guessed. tf3d-interior2 measured the board
  // from the spawn at 0.593 screen px per canvas px: the old 10px band read at
  // 5.9px and the 9px disclosure at 5.3px, both under the 6-7px floor, while
  // the 30px headline read at 17.8px. A money figure that is legible while its
  // qualification is not is an UNQUALIFIED money figure.
  // LEGIBILITY FLOOR, measured not guessed. tf3d-interior2 measured the board
  // from the spawn at 0.593 screen px per canvas px; the contract viewport is a
  // 1366x768 laptop, where 15 canvas px is 7.6 screen px. A money figure that is
  // legible while its qualification is not is an UNQUALIFIED money figure.
  //
  // THE SET IS DERIVED, NOT LISTED. The first version selected by four
  // substrings and the `(PARTIAL)` caption was invisible to its own floor,
  // because nobody had added it. Two sources now, both read off the drawing:
  //   - every string the drawing chose to render in COLOR.muted, which IS the
  //     "this is secondary text" decision; and
  //   - every string that appears ONLY when a realised block is present,
  //     obtained by differencing against the same board with no figures.
  test('no disclosure text is drawn below the legibility floor, in ANY state', () => {
    // FOUR boards, not one. The selector used to examine only the ready
    // fixture, so "NO CLOSED POSITIONS YET" and "P&L UNAVAILABLE" could have
    // sat at 10px unnoticed - they are drawn in the absence branches the test
    // never rendered. Codex round 7. The fallback-prose path is here too, so
    // one loop covers every path that can put a qualifier on the wall.
    const boards: Array<[string, FloorScreenData]> = [
      [
        'ready',
        board({
          phase: 'ready',
          slots: [
            slot({
              realised: realised({ excludedNonUsdc: 2, noExitClosures: 1, partial: true }),
            }),
          ],
        }),
      ],
      ['none', board({ phase: 'ready', slots: [slot({ realised: { kind: 'none' } })] })],
      [
        'unavailable',
        board({ phase: 'ready', slots: [slot({ realised: { kind: 'unavailable' } })] }),
      ],
      [
        'fallback prose',
        board({
          phase: 'ready',
          slots: [
            slot({
              realised: realised({
                costBasis: 'some_unknown_method',
                note: 'Net after venue fees',
              }),
            }),
          ],
        }),
      ],
      // THE RISK STATES. "PAUSED: RISK LIMIT" is the most load-bearing word on
      // the card when it is present: a reader who cannot make it out reads a
      // live P&L card for a desk that is not trading, which is the same
      // unqualified money figure the `(PARTIAL)` caption was raised for. The
      // status word joined the disclosure class the day it could say this.
      [
        'paused',
        board({ phase: 'ready', slots: [slot({ status: 'paused', realised: realised() })] }),
      ],
      [
        'fault',
        board({ phase: 'ready', slots: [slot({ status: 'fault', realised: realised() })] }),
      ],
    ];

    // Baseline for the "emitted by the realised builders" half of the
    // derivation: strings a card shows with no figures at all.
    const baseline = new Set(
      draw({ phase: 'ready', slots: [slot({ realised: { kind: 'none' } })] }).strings,
    );

    let checked = 0;
    for (const [name, data] of boards) {
      const rec = recorder();
      drawFloorScreen(rec.context, data);
      const disclosures = rec.painted.filter(
        (p): p is Extract<Painted, { kind: 'text' }> =>
          p.kind === 'text' &&
          (p.fill === COLOR.muted || !baseline.has(p.value)),
      );
      expect({ name, found: disclosures.length > 0 }).toEqual({ name, found: true });
      for (const drawn of disclosures) {
        const px = Number(/(\d+(?:\.\d+)?)px/.exec(drawn.font)![1]);
        expect({ name, text: drawn.value.slice(0, 36), px, ok: px >= 15 }).toEqual({
          name,
          text: drawn.value.slice(0, 36),
          px,
          ok: true,
        });
        checked += 1;
      }
    }
    // Guard: a derivation that selects nothing passes vacuously.
    expect(checked).toBeGreaterThan(10);
  });

  // THE FALLBACK PATH HAS ITS OWN FLOOR, and the test above never reached it:
  // it only ever drew the COMPOSED band. An unrecognised code routes the
  // route's prose through the sanitised path instead, and a note like
  // "NET AFTER VENUE FEES" would have been just as invisible at 10px as the
  // composed method was. Codex round 6 named exactly that case.
  test('the fallback prose note also clears the legibility floor', () => {
    const rec = recorder();
    drawFloorScreen(
      rec.context,
      board({
        phase: 'ready',
        slots: [
          slot({
            realised: realised({
              costBasis: 'some_unknown_method',
              note: 'Net after venue fees',
            }),
          }),
        ],
      }),
    );
    const note = rec.painted.filter(
      (p): p is Extract<Painted, { kind: 'text' }> =>
        p.kind === 'text' && p.value.includes('NET AFTER VENUE FEES'),
    );
    expect(note).toHaveLength(1);
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(note[0]!.font)![1]);
    expect({ px, ok: px >= 15 }).toEqual({ px, ok: true });
    // And it is muted, so the derived selector above would catch it too.
    expect(note[0]!.fill).toBe(COLOR.muted);
  });

  test('a method clause is never split across a line break', () => {
    const rec = recorder();
    drawFloorScreen(
      rec.context,
      board({ phase: 'ready', slots: [slot({ realised: realised() })] }),
    );
    const joined = rec.strings.join(' | ');
    // Each clause moves whole to the next line rather than breaking inside.
    expect(joined).toContain('NO EXIT AFTER 24 HOURS = TOTAL LOSS');
    expect(joined).not.toContain('= TOTAL | LOSS');
  });

  test('the method is COMPOSED from typed codes, not echoed from prose', () => {
    const joined = draw({
      phase: 'ready',
      slots: [slot({ realised: realised() })],
    }).strings.join(' | ');
    // The board's own words, keyed on the route's machine codes.
    expect(joined).toContain('GROSS REALISED ON THE USDC LEG, EXCLUDES NETWORK FEES');
    expect(joined).toContain('ROUND TRIPS MATCHED FIFO BY TOKEN UNITS');
    expect(joined).toContain('NO EXIT AFTER 24 HOURS = TOTAL LOSS');
  });

  test('an unrecognised code falls back to the route prose, visibly', () => {
    const joined = draw({
      phase: 'ready',
      slots: [slot({ realised: realised({ costBasis: 'some_new_method' }) })],
    }).strings.join(' | ');
    // Composition is ALL-OR-NOTHING: a half-composed method would state the
    // parts we know and silently drop the rest, which is the truncation
    // defect again in a different shape.
    expect(joined).not.toContain('ROUND TRIPS MATCHED FIFO BY TOKEN UNITS');
    expect(joined).toContain('GROSS REALISED ON THE USDC LEG; EXCLUDES NETWORK FEES AND RENT');
  });

  // The audit bar's item 4, at the DRAW site rather than the data site. The
  // data guard already refuses these, but a caller can build `FloorScreenData`
  // by hand — that is the whole reason the sanitiser lives at the draw site —
  // so the board must survive a realised block whose "numbers" are strings.
  test('a hostile string in a realised field cannot reach fillText as money', () => {
    const poisoned = {
      kind: 'ready' as const,
      closedPositions: 10,
      wins: '9999' as unknown as number,
      losses: '<script>' as unknown as number,
      realisedUsd: '+$999,999.00 PROFIT' as unknown as number,
      bestUsd: '7xKXtg2CW3eTA1hqzVfKp8mKQqZ9rPfLmNbVcXyZaQw1' as unknown as number,
      worstUsd: Number.NaN,
      openPositions: '2' as unknown as number,
      note: 'gross',
      partial: false,
      excludedNonUsdc: 0,
    } as unknown as FloorScreenRealisedState;
    const drawn = draw({ phase: 'ready', slots: [slot({ realised: poisoned })] });
    const joined = drawn.strings.join(' | ');

    // No server string reaches the wall as a figure.
    expect(joined).not.toContain('999,999');
    expect(joined).not.toContain('PROFIT');
    expect(joined).not.toContain('<script>');
    // A non-number formats as the explicit unavailable marker, never as 0.00.
    expect(joined).toContain('N/A');
    expect(joined).not.toContain('$0.00');
    // And the address in a "number" field never lands.
    assertDrawable(drawn.strings);
  });

  // The BRAND. `value()` skips the untrusted-text pass by design, so "only pass
  // numbers you formatted here" used to be a convention held by a comment. It
  // is now a type: `BoardValue`'s symbol is not exported, so the only ways to
  // obtain one are the two formatters and the `label` tag. A future edit that
  // passes a server string into the unsanitised path is a COMPILE error.
  //
  // The grep below is the belt to that braces: it fails if a `value()` call is
  // ever handed a bare literal or an untagged template, which is what such an
  // edit looks like before the type error is noticed.
  test('value() is never called with a bare string or untagged template', () => {
    const source = readFileSync(
      join(import.meta.dir, 'trading-floor-screen-texture.ts'),
      'utf8',
    );
    // Every call site, second argument captured. `value(` also appears as the
    // function's own declaration, which the `ctx,` prefix excludes.
    const calls = [...source.matchAll(/value\(\s*ctx,\s*([^\n]{0,24})/g)].map(
      (hit) => hit[1]!.trim(),
    );
    expect(calls.length).toBeGreaterThan(5);
    for (const argument of calls) {
      // BANNED: a string literal or an untagged template. A branded VARIABLE is
      // legitimate — `drawBasisBand` passes wrapped lines — and the BRAND is
      // what proves those came from a formatter. This grep is the belt: it
      // catches the shape such an edit takes before anyone reads the type
      // error. Allow-listing the producers here failed on the first legitimate
      // variable, which is how a useful grep starts getting deleted.
      const literal = /^['"`]/.test(argument);
      expect({ argument, literal }).toEqual({ argument, literal: false });
    }
  });

  // The grep. A money figure in the SOURCE would be a figure nobody computed.
  test('the drawing code contains no hard-coded money figure', () => {
    const source = readFileSync(
      join(import.meta.dir, 'trading-floor-screen-texture.ts'),
      'utf8',
    );
    // Strip comments: the file DOCUMENTS the -5.20/+8.87 window incident, and
    // prose about a number is not a number on the wall.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/\$\d/);
    expect(code).not.toMatch(/['"`][^'"`]*\bUSD\s*\d/i);
    // The only "$" the drawing code may contain is the one in the formatter and
    // in replacement patterns, both of which are template syntax, not a figure.
    const dollarLiterals = code.match(/\$(?!\{)[^{]/g) ?? [];
    expect(dollarLiterals.every((hit) => /\$\D/.test(hit))).toBe(true);
  });

  test('the data layer refuses a half-populated or non-numeric realised block', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const state = { isLoading: false, isError: false };
    const build = (realisedValue: unknown) =>
      buildFloorScreenData(
        [{ ...view(), realised: realisedValue } as HouseTraderSlotView],
        state,
        now,
      ).slots[0]!.realised;

    // A BROKEN read is 'unavailable' — a statement about our read.
    expect(build(undefined)?.kind).toBe('unavailable');
    expect(build({ closedPositions: 4 })?.kind).toBe('unavailable');
    expect(build({ ...fullRealised(), realisedUsd: '-5.20' })?.kind).toBe('unavailable');
    expect(build({ ...fullRealised(), realisedUsd: Number.NaN })?.kind).toBe('unavailable');
    // A VALID block reporting nothing closed is 'none' — about the TRADER.
    expect(build({ ...fullRealised(), closedPositions: 0 })?.kind).toBe('none');
    expect(ready(build(fullRealised())).realisedUsd).toBe(-5.2);
    // A missing basis falls back rather than drawing a figure with no basis.
    const noBasis = { ...fullRealised(), note: '' };
    expect(ready(build(noBasis)).note).toBe(
      'Gross realised on the USDC leg; excludes network fees and rent',
    );
  });
});
describe('Trading Floor board — what it actually shows', () => {
  test('the header, the statuses and the counts are all on the board', () => {
    const { strings } = draw({
      phase: 'ready',
      slots: [slot({ label: 'Genesis', status: 'live', verified: 12, scored: 8 })],
    });
    const joined = strings.join(' | ');
    expect(joined).toContain('CLAWVILLE TRADING FLOOR');
    expect(joined).toContain('GENESIS');
    expect(joined).toContain('LIVE');
    expect(joined).toContain('VERIFIED');
    expect(joined).toContain('12');
    expect(joined).toContain('SCORED');
    expect(joined).toContain('8');
    expect(joined).toContain('4M AGO');
  });

  test('each of the five statuses gets its own words', () => {
    const read = (status: FloorScreenSlot['status']) =>
      draw({ phase: 'ready', slots: [slot({ status })] }).strings.join(' | ');
    expect(read('live')).toContain('LIVE');
    expect(read('stopped')).toContain('STOPPED');
    expect(read('waiting')).toContain('NOT RUNNING YET');
    // A risk pause and a failed risk READ are two different facts, so they get
    // two different words. Merging them would put an unearned claim on a wall.
    expect(read('paused')).toContain('PAUSED: RISK LIMIT');
    expect(read('fault')).toContain('FAULT');
    // And a paused card never also says LIVE: the status word is one word.
    expect(read('paused')).not.toContain('| LIVE |');
    // The hygiene gate, on a card with no basis band: that band wraps at 105
    // characters by design and would trip the 64-character runaway guard, which
    // is a rule about labels rather than about the method sentence.
    for (const status of ['paused', 'fault'] as const) {
      assertDrawable(draw({ phase: 'ready', slots: [slot({ status })] }).strings);
    }
  });

  test('a board with no data says it is connecting, never shows an empty card', () => {
    const connecting = draw({ phase: 'connecting', slots: [] }).strings.join(' | ');
    expect(connecting).toContain('CONNECTING TO THE FLOOR');
    const failed = draw({ phase: 'error', slots: [] }).strings.join(' | ');
    expect(failed).toContain('FLOOR DATA UNAVAILABLE');
  });

  // THE SPARKLINE IS GONE. It was squeezed across eight layout passes and at
  // 15px disclosures the card has no room for it. It was the only element with
  // no honesty function - scoring-TIER shape, which the tape and the counts
  // already carry - and a chart too small to read is decoration impersonating
  // data. These two tests pinned its behaviour; this one pins its ABSENCE, so
  // a future reader does not restore it without re-reading why it went.
  // THE CHART IS GONE, field and all. It was squeezed across eight layout
  // passes; at the height left for it Codex round 6 measured all three scoring
  // tiers rendering as the same 4px stub, and a chart that cannot show its own
  // distinctions is decoration impersonating data. This pins the ABSENCE at
  // the type level - `FloorScreenSlot` has no `spark` - so restoring it is a
  // deliberate act with a reason attached, not a quiet re-add.
  // THE PRODUCTION MAPPER, not the test's own fixture. Checking `slot()` only
  // proved that I had edited my own helper — Codex round 7 called that out. The
  // assertion that means something is on what `buildFloorScreenData` actually
  // projects from a full wire payload WITH trade data, which is where a chart
  // field would come back from.
  test('the production mapper emits no chart data from a busy desk', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const projected = buildFloorScreenData(
      [
        view({
          recentTrades: Array.from({ length: 7 }, (_, index) =>
            trade(index % 2 ? 2 : 1, `sig-${index}`, {
              dex: 'jupiter',
              blockTime: 1_700_000_000 + index,
            }),
          ),
        }),
      ],
      { isLoading: false, isError: false },
      now,
    ).slots[0]!;
    expect(Object.keys(projected)).not.toContain('spark');
    expect(JSON.stringify(projected)).not.toContain('spark');
    // NOT asserting the absence of "NO TRADES YET" any more: that string used
    // to be the empty CHART's placeholder, and it is now a legitimate
    // last-trade LABEL for a desk with no `lastTradeAt`. Asserting its absence
    // would fail on correct output — the shape proof is the rect-count test.
    expect(draw({ phase: 'ready', slots: [projected] }).strings.length).toBeGreaterThan(5);
  });

  // RECT COUNT, kept from the original absence pin. A chart is the only thing
  // on this card whose number of filled rectangles varies with the DATA, so a
  // constant rect count across a busy desk and an idle one is the shape-level
  // proof that no chart came back. It is driven through the real data layer,
  // since the drawable slot no longer has a field a test could set directly.
  test('the card draws the same rectangles whether the desk is busy or idle', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const state = { isLoading: false, isError: false };
    const build = (count: number) =>
      buildFloorScreenData(
        [
          view({
            recentTrades: Array.from({ length: count }, (_, index) =>
              trade(1, `sig-${index}`, { dex: 'jupiter', blockTime: 1_700_000_000 + index }),
            ),
          }),
        ],
        state,
        now,
      );
    const busy = recorder();
    drawFloorScreen(busy.context, build(7));
    const idle = recorder();
    drawFloorScreen(idle.context, build(0));
    expect(busy.rects.length).toBe(idle.rects.length);
  });

  test('the header carries the clock in every phase', () => {
    for (const phase of ['connecting', 'error', 'ready'] as const) {
      const joined = draw({
        phase,
        slots: phase === 'ready' ? [slot()] : [],
      }).strings.join(' | ');
      expect(joined).toContain('CLAWVILLE TRADING FLOOR');
      expect(joined).toContain('14:32 UTC');
    }
  });

  test('the bottom tape draws the recent trades, not the counts again', () => {
    const joined = draw({
      phase: 'ready',
      slots: [slot()],
      tape: ['ANSEM PUMPSWAP 4M', 'JUPITER 9M'],
    }).strings.join(' | ');
    expect(joined).toContain('ANSEM PUMPSWAP 4M');
    expect(joined).toContain('JUPITER 9M');
  });

  test('an empty tape says the tape is standing by', () => {
    const joined = draw({ phase: 'ready', slots: [slot()], tape: [] }).strings.join(
      ' | ',
    );
    expect(joined).toContain('LIVE TRADE TAPE STANDING BY');
  });

  // The shipped lineup is one slot, but the board must already be right on the
  // day a second is paired — including the case where the new desk is live and
  // has not traded yet, which is a valid state and NOT an error.
  test('a two-slot lineup draws both, including a live slot with zero trades', () => {
    const { strings } = draw({
      phase: 'ready',
      slots: [
        slot({ label: 'Genesis', status: 'live', verified: 12, scored: 8 }),
        slot({
          label: 'ClawVille Runner',
          status: 'live',
          verified: 0,
          scored: 0,
          lastTradeLabel: 'no trades yet',
        }),
      ],
      tape: ['ANSEM PUMPSWAP 4M'],
    });
    const joined = strings.join(' | ');
    expect(joined).toContain('GENESIS');
    expect(joined).toContain('CLAWVILLE RUNNER');
    expect(joined).toContain('NO TRADES YET');
    expect(joined).not.toContain('CONNECTING TO THE FLOOR');
    expect(joined).not.toContain('FLOOR DATA UNAVAILABLE');
    assertDrawable(strings);
  });

  // THE REFLOW PIN. The card's row offsets are hand-placed, so a canvas height
  // change silently moves text under the sparkline: at 325 px the OLD offsets
  // put the LAST row at y + 174 and the sparkline bed at y + 149, i.e. the bed
  // painted straight over the text. `drawFloorScreen` measures nothing and the
  // bounds test below only pins the canvas edges, so neither would have caught
  // it. The bed is filled AFTER the card text, which is exactly what makes the
  // ordering assertion able to see the collision.
  test('no later fill paints over text already on the board', () => {
    const rec = recorder();
    drawFloorScreen(
      rec.context,
      board({
        phase: 'ready',
        slots: [slot(), slot({ label: 'ClawVille Runner' })],
        tape: ['ANSEM PUMPSWAP 4M'],
      }),
    );
    assertNoFillOverText(rec.painted);
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

  // TEXT OVER TEXT. The paint-order pin watched text against later RECTS and
  // was blind to two strings sharing a position: when the counts and last-trade
  // rows merged, "OPEN 1" drew at the same x and y as "VERIFIED 12" and painted
  // straight over it on EVERY ready card. Codex round 7 found it; nothing in
  // this file could have. Colour is irrelevant — two glyph boxes overlapping is
  // the defect regardless of which is on top.
  test('no two strings share space on the board', () => {
    const rec = recorder();
    drawFloorScreen(
      rec.context,
      board({
        phase: 'ready',
        slots: [
          // PAUSED on the worst card: the widest status word this row can hold
          // (18 characters where LIVE is 4) beside the widest counts, the
          // longest last-trade label and both per-slot disclosures.
          slot({
            status: 'paused',
            verified: 1234,
            scored: 1234,
            lastTradeLabel: 'time unavailable',
            realised: realised({ excludedNonUsdc: 2, noExitClosures: 1, partial: true }),
          }),
          slot({ label: 'ClawVille Runner', status: 'fault', realised: { kind: 'none' } }),
        ],
      }),
    );
    assertNoTextOverlap(rec.painted);
  });

  // FEATURE_GATE: trading_floor_board_three_slot_full_sweep
  // Status: the FULL pairwise overlap sweep runs at the card widths the live
  //   lineup produces. At three slots (cardW 314.67px, usable 278.67px) only
  //   the new status word is swept, because TWO pairs collide there and neither
  //   is reachable with a two-trader lineup. One is an estimator artifact
  //   (caption vs headline, 0.6px); the other is REAL (the two disclosure
  //   strings need 342px and have 278.67px, a 63.3px overrun) and needs a
  //   second disclosure row or shorter wording, not a tolerance change. Both
  //   are pinned to an exact set by the test below, so this gate cannot go
  //   vacuous and a third collision cannot hide behind them.
  // Metric to graduate: HOUSE_TRADER_LINEUP.length > 2 — i.e. a third house
  //   trader is paired and the 314px card becomes a width players actually see.
  // Current reading: HOUSE_TRADER_LINEUP.length === 2 (Genesis, ClawVille
  //   Runner) as of 2026-09-20.
  // Review deadline: fires on its own. `STRICT_SWEEP_MAX_SLOTS` below reads the
  //   lineup constant, so adding a third entry switches the full sweep on at
  //   three slots in the same run, with no human step and no date to miss.
  // On deadline: that sweep WILL go red on the disclosure pair, because that
  //   overlap is arithmetic rather than estimator slack. The card is then
  //   re-derived for the 314px width: a second disclosure row, or wording short
  //   enough that two strings fit 278.67px. Do NOT loosen `textBox` to make it
  //   pass — the estimator is pessimistic on purpose and has caught two real
  //   bugs, and it is not what is failing here.
  // Evidence it fits today and ONLY today: `drawCard`'s own comment records
  //   that the shortened wording (`n NON-USDC EXCLUDED` / `n NO-EXIT
  //   WRITE-OFF`, 171px each) was measured against **394px of usable card**,
  //   which is the TWO-slot width. A three-slot card has 278.67px, so the same
  //   two strings need 342px and overrun by 63.3px. The wording was never sized
  //   for three.
  // Reference: 3dStructure.md §9h; .claude/memory/threejs/gotchas/
  //   canvas-paint-pin-estimator-false-positive.md
  const STRICT_SWEEP_MAX_SLOTS = HOUSE_TRADER_LINEUP.length > 2 ? 3 : 2;

  // THE NEW STATUS WORDS, through BOTH geometry pins and at every card width.
  // "PAUSED: RISK LIMIT" is 18 characters where "LIVE" was four, so it is the
  // widest string that row has ever carried; the three-slot board is the
  // narrowest card the layout produces (314 px against 430 px).
  test.each([1, 2, 3])(
    'the paused and fault cards clear the layout on a %i-slot board',
    (count) => {
      for (const status of ['paused', 'fault'] as const) {
        const rec = recorder();
        drawFloorScreen(
          rec.context,
          board({
            phase: 'ready',
            slots: Array.from({ length: count }, (_unused, index) =>
              slot({
                label: index === 0 ? 'Genesis' : 'ClawVille Runner',
                // The FIRST card carries the verdict and the rest stay live, so
                // one board exercises the widest word beside the ordinary one.
                status: index === 0 ? status : 'live',
                realised: realised({ excludedNonUsdc: 2, noExitClosures: 1, partial: true }),
              }),
            ),
            tape: ['ANSEM PUMPSWAP 4M'],
          }),
        );
        const word = status === 'paused' ? 'PAUSED: RISK LIMIT' : 'FAULT';
        expect(rec.strings.join(' | ')).toContain(word);
        assertNoFillOverText(rec.painted);
        // The FULL pairwise sweep at the widths the lineup produces, and only
        // the new word beyond them. The boundary is DERIVED from the lineup
        // constant, so a third house trader turns the strict sweep on here by
        // itself — see the FEATURE_GATE above for why three slots is currently
        // outside it.
        if (count <= STRICT_SWEEP_MAX_SLOTS) assertNoTextOverlap(rec.painted);
        else assertNoTextOverlap(rec.painted, (value) => value === word);
        // And the whole board still fits the declared canvas.
        for (const [x, y, w, h] of rec.rects) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(x + w).toBeLessThanOrEqual(FLOOR_SCREEN_CANVAS.width + 0.001);
          expect(y + h).toBeLessThanOrEqual(FLOOR_SCREEN_CANVAS.height + 0.001);
        }
      }
    },
  );

  // THE DEFERRAL, PINNED TO AN EXACT SET rather than left as a prose note.
  //
  // Two pairs collide at the three-slot width and they are NOT the same kind of
  // problem. Writing the set down is what stops the gate above going vacuous:
  // if a re-derive clears them this test goes red and says "lift the gate", and
  // if a THIRD pair starts colliding it goes red too, which a focused sweep
  // would never have noticed.
  //
  //   1. `REALISED P&L (PARTIAL)` vs the 30px headline. 0.6px by the estimator,
  //      and an ARTIFACT: Courier's cap height is 0.572em against the 0.72em
  //      this file models, so the real gap is about 2px of clearance.
  //   2. `n NON-USDC EXCLUDED` vs `n NO-EXIT WRITE-OFF`. **63.3px, and REAL.**
  //      Two 19-character strings at 9px per character need 342px; a three-slot
  //      card has 278.67px between its padding. No cap-height slack touches a
  //      number that size. The shortened wording in `drawCard` was measured
  //      against the TWO-slot card's 394px, which is why it fits today and only
  //      today. This one needs a second disclosure row or shorter words, not a
  //      tolerance change, and the FEATURE_GATE above is what will force it.
  test('the three-slot width has exactly the two known collisions, no more', () => {
    const rec = recorder();
    drawFloorScreen(
      rec.context,
      board({
        phase: 'ready',
        slots: Array.from({ length: 3 }, (_unused, index) =>
          slot({
            label: index === 0 ? 'Genesis' : 'ClawVille Runner',
            status: index === 0 ? 'paused' : 'live',
            realised: realised({ excludedNonUsdc: 2, noExitClosures: 1, partial: true }),
          }),
        ),
        tape: ['ANSEM PUMPSWAP 4M'],
      }),
    );
    const texts = rec.painted.filter(
      (p): p is Extract<Painted, { kind: 'text' }> => p.kind === 'text',
    );
    const collisions = new Set<string>();
    for (let i = 0; i < texts.length; i += 1) {
      for (let j = i + 1; j < texts.length; j += 1) {
        const a = textBox(texts[i]!);
        const b = textBox(texts[j]!);
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
          collisions.add([texts[i]!.value, texts[j]!.value].sort().join(' || '));
        }
      }
    }
    expect([...collisions].sort()).toEqual([
      '-$5.20 || REALISED P&L (PARTIAL)',
      '1 NO-EXIT WRITE-OFF || 2 NON-USDC EXCLUDED',
    ]);
  });

  // THE FIGURES STAY. A paused desk's P&L is real; it has simply stopped
  // moving. Blanking it would lose the fact the reader came for, and the founder
  // asked for a pause NOTICE, not a pause screen.
  test('a paused card still paints its P&L, unchanged from the live card', () => {
    const figures = (status: FloorScreenSlot['status']) =>
      draw({ phase: 'ready', slots: [slot({ status, realised: realised() })] })
        .strings.filter((value) => value.includes('$') || value.startsWith('W '));
    expect(figures('paused')).toEqual(figures('live'));
    expect(figures('paused').join(' ')).toContain('-$5.20');
  });

  test('the whole board fits the declared canvas', () => {
    const { rects } = draw({ phase: 'ready', slots: [slot(), slot(), slot()] });
    for (const [x, y, w, h] of rects) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(FLOOR_SCREEN_CANVAS.width + 0.001);
      expect(y + h).toBeLessThanOrEqual(FLOOR_SCREEN_CANVAS.height + 0.001);
    }
  });
});

// ---------------------------------------------------------------------------
// The data half: the live payload -> the drawable shape.
// ---------------------------------------------------------------------------

function trade(
  multiplier: 1 | 1.5 | 2,
  signature: string,
  overrides: Partial<FloorTrade> = {},
): FloorTrade {
  return {
    kind: 'trade',
    keys: [`t:${signature}`],
    signature,
    subject: { type: 'agent', id: 'agent-1', avatarName: 'Genesis' },
    wallet: null,
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    notionalUsd: 12.5,
    dex: 'jupiter',
    blockTime: 1_700_000_000,
    multiplier,
    multiplierTier: multiplier === 2 ? 'ansem' : multiplier === 1.5 ? 'clawville' : 'base',
    decisionId: null,
    scored: true,
    unscoredReason: null,
    operatedByClawville: true,
    operator: 'clawville',
    ...overrides,
  } as FloorTrade;
}

function view(overrides: Partial<HouseTraderSlotView> = {}): HouseTraderSlotView {
  return {
    objective: 'momentum-board',
    slotName: 'Genesis',
    strategyNote: 'Momentum on small-cap memecoins.',
    status: 'live-observed',
    subject: { type: 'agent', id: 'agent-1', avatarName: 'Genesis' },
    counts: { verified: 12, scored: 8, lastTradeAt: null },
    // The route's OWN empty view: a paired desk that has closed nothing. It is
    // the default here because it is the default there, so a test that says
    // nothing about P&L exercises the state most slots are actually in.
    //
    // Expressed as a DELTA on `fullRealised()` and cast, deliberately. The
    // route's type keeps growing — it gained `openCostUsd`, `costBasis`,
    // `noExitHours` and four more mid-session — and a second hand-written copy
    // of the wire shape would need chasing every time. The board reads BY KEY
    // and ignores fields it does not know, so a fixture carrying the keys the
    // board reads is the honest model of what it consumes.
    realised: {
      ...fullRealised(),
      closedPositions: 0,
      wins: 0,
      losses: 0,
      realisedUsd: 0,
      bestUsd: null,
      worstUsd: null,
      openPositions: 0,
      computedAt: null,
    } as unknown as HouseTraderSlotView['realised'],
    // NULL by default, which is what the route serves today. Every assertion
    // written before the field existed keeps meaning what it meant.
    risk: null,
    recentTrades: [],
    ...overrides,
  };
}

/** A paused verdict as the hook hands it over, already validated. */
function riskView(
  overrides: Partial<NonNullable<HouseTraderSlotView['risk']>> = {},
): NonNullable<HouseTraderSlotView['risk']> {
  return {
    state: 'paused',
    reason: 'daily_loss_floor',
    detail: 'Daily loss floor reached.',
    dayLossUsd: 9.99,
    dayLossCapUsd: 20,
    roomNeededUsd: 10.25,
    at: '2026-09-20T10:40:00.000Z',
    ageSeconds: 42,
    ...overrides,
  };
}

describe('Trading Floor board — data mapping', () => {
  const now = Date.parse('2026-09-19T12:00:00.000Z');

  test('loading and error states never claim a trader is running', () => {
    expect(
      buildFloorScreenData(undefined, { isLoading: true, isError: false }, now).phase,
    ).toBe('connecting');
    expect(
      buildFloorScreenData([], { isLoading: false, isError: true }, now).phase,
    ).toBe('error');
  });

  test('the three server statuses map to the three board statuses', () => {
    const data = buildFloorScreenData(
      [
        view({ status: 'live-observed' }),
        view({ objective: 'a', status: 'stopped' }),
        view({ objective: 'b', status: 'not-yet-running' }),
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(data.slots.map((s) => s.status)).toEqual(['live', 'stopped', 'waiting']);
  });

  test('the age label is derived, never a raw timestamp', () => {
    const data = buildFloorScreenData(
      [
        view({
          counts: {
            verified: 3,
            scored: 1,
            lastTradeAt: new Date(now - 7 * 60_000).toISOString(),
          },
        }),
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(data.slots[0]!.lastTradeLabel).toBe('7m ago');
  });

  test('a slot with no trades reads as "no trades yet", not as zero minutes', () => {
    const data = buildFloorScreenData(
      [view()],
      { isLoading: false, isError: false },
      now,
    );
    expect(data.slots[0]!.lastTradeLabel).toBe('no trades yet');
  });

  // The sparkline is scoring TIER, not notional. A bar chart of trade SIZE
  // reads as a bar chart of money even with no axis on it.
  test('no notional, wallet or subject id survives into the drawable shape', () => {
    const data = buildFloorScreenData(
      [view({ recentTrades: [trade(2, 'sig')] })],
      { isLoading: false, isError: false },
      now,
    );
    const serialised = JSON.stringify(data);
    expect(serialised).not.toContain('12.5');
    expect(serialised).not.toContain('agent-1');
    expect(serialised).not.toContain('So11111111111111111111111111111111111111112');
    // And the strategy note stays on the Exchange panel, which is where it fits.
    expect(serialised).not.toContain('Momentum');
  });

  // ── THE RISK VERDICT ON THE WALL (founder, 2026-09-20) ────────────────────

  test('a paused verdict replaces the LIVE word and nothing else', () => {
    const data = buildFloorScreenData(
      [view({ risk: riskView() })],
      { isLoading: false, isError: false },
      now,
    );
    expect(data.slots[0]!.status).toBe('paused');
    // The rest of the card is untouched — same counts, same age, same block.
    const plain = buildFloorScreenData([view()], { isLoading: false, isError: false }, now);
    expect({ ...data.slots[0]!, status: 'live' }).toEqual(plain.slots[0]!);
  });

  test('a fault maps to FAULT and is never folded into the pause', () => {
    const data = buildFloorScreenData(
      [view({ risk: riskView({ state: 'fault', reason: 'price_feed_down' }) })],
      { isLoading: false, isError: false },
      now,
    );
    expect(data.slots[0]!.status).toBe('fault');
  });

  test('a live verdict, a null block and an absent field are the same board', () => {
    const state = { isLoading: false, isError: false };
    const { risk: _absent, ...withoutRisk } = view();
    const statuses = [
      buildFloorScreenData([view({ risk: riskView({ state: 'live', reason: 'ok' }) })], state, now),
      buildFloorScreenData([view({ risk: null })], state, now),
      buildFloorScreenData([withoutRisk as HouseTraderSlotView], state, now),
    ].map((data) => data.slots[0]!.status);
    expect(statuses).toEqual(['live', 'live', 'live']);
  });

  // PAIRING FIRST. A stopped or unpaired desk already says why it is idle; a
  // risk word over the top of that would replace a true statement with a
  // narrower one that is not the reason the desk is not trading. The panel
  // applies the same precedence through the same resolver.
  test('a verdict never overrides a stopped or unpaired desk', () => {
    const state = { isLoading: false, isError: false };
    const read = (status: HouseTraderSlotView['status']) =>
      buildFloorScreenData([view({ status, risk: riskView() })], state, now).slots[0]!.status;
    expect(read('stopped')).toBe('stopped');
    expect(read('not-yet-running')).toBe('waiting');
    expect(read('live-observed')).toBe('paused');
  });

  test('the verdict carries no prose, no timestamp and no figures onto the wall', () => {
    const data = buildFloorScreenData(
      [
        view({
          risk: riskView({
            detail: 'Daily loss floor reached; resumes after the UTC reset.',
          }),
        }),
      ],
      { isLoading: false, isError: false },
      now,
    );
    const serialised = JSON.stringify(data);
    // The board says the WORD. The detail, the cap arithmetic and the verdict
    // time are the panel's to render: the board has one row for this and a
    // wall is read from across a hall.
    expect(serialised).not.toContain('resumes after');
    expect(serialised).not.toContain('10.25');
    expect(serialised).not.toContain('2026-09-20T10:40');
    expect(serialised).not.toContain('daily_loss_floor');
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

  // The same bad `nowMs` reaches THREE formatters and only the clock fails
  // loudly. The card age and the tape age produce "NaNd ago" and "NaNM", which
  // are not errors anywhere — they are just painted on a wall in the world.
  test('a hostile clock cannot blank the board or paint NaN anywhere on it', () => {
    const traded = view({
      counts: { verified: 3, scored: 1, lastTradeAt: '2026-09-19T11:00:00.000Z' },
      recentTrades: [trade(1, 'x', { dex: 'jupiter', blockTime: 1_700_000_000 })],
    });
    for (const hostile of [Number.NaN, 1e20, 8.64e15, -62167219200001]) {
      const build = () =>
        buildFloorScreenData([traded], { isLoading: false, isError: false }, hostile);
      expect(build).not.toThrow();
      const data = build();
      expect(data.clockLabel).toBe('CLOCK OFFLINE');
      expect(data.slots[0]!.lastTradeLabel).toBe('time unavailable');
      // NOT "RECENT". The trade carries a good time, but a broken clock means
      // we cannot say how long ago it was, so recency is not ours to claim.
      expect(data.tape).toEqual(['JUPITER TIME UNKNOWN']);

      const drawn = draw({ ...data, slots: [...data.slots], tape: [...data.tape] });
      expect(drawn.strings.join(' | ')).not.toContain('NAN');
      assertDrawable(drawn.strings);
    }
  });

  // THE REACHABLE ONE. `lastTradeAt` and `blockTime` come from the API, and a
  // future timestamp clamps to zero age through `Math.max(0, …)`, so before the
  // plausibility bound a trade dated year 275760 rendered as "now" — the board
  // asserting a house trader had just traded. An unearned claim reached through
  // arithmetic rather than wording, which is the rule this board exists for.
  test('an implausible TRADE time never reads as a trade that just happened', () => {
    const now = Date.parse('2026-09-19T12:00:00.000Z');
    const future = buildFloorScreenData(
      [
        view({
          counts: { verified: 3, scored: 1, lastTradeAt: '+275760-09-13T00:00:00.000Z' },
          recentTrades: [trade(1, 'f', { dex: 'jupiter', blockTime: 8.64e12 })],
        }),
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(Number.isFinite(Date.parse('+275760-09-13T00:00:00.000Z'))).toBe(true);
    expect(future.slots[0]!.lastTradeLabel).toBe('time unavailable');
    expect(future.slots[0]!.lastTradeLabel).not.toBe('now');
    expect(future.tape).toEqual(['JUPITER TIME UNKNOWN']);

    // Pre-epoch is equally implausible for a ClawVille trade.
    const past = buildFloorScreenData(
      [
        view({
          counts: { verified: 1, scored: 0, lastTradeAt: '1969-07-20T20:17:00.000Z' },
          recentTrades: [trade(1, 'p', { dex: 'pumpswap', blockTime: -1 })],
        }),
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(past.slots[0]!.lastTradeLabel).toBe('time unavailable');
    expect(past.tape).toEqual(['PUMPSWAP TIME UNKNOWN']);
  });

  // CODEX ROUND 3, and the plausibility bound did not cover it: 2099-01-01 is
  // inside 1970..2100, so it passed, and `Math.max(0, nowMs - atMs)` clamped
  // the negative age to zero. The card said "now" — the board asserting a house
  // trader had just traded, off a server-supplied timestamp. Fixed clock, so
  // this cannot rot into a passing test in 2099.
  test('a FUTURE trade time never reads as a trade that just happened', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const future = buildFloorScreenData(
      [
        view({
          counts: { verified: 3, scored: 1, lastTradeAt: '2099-01-01T00:00:00.000Z' },
          recentTrades: [
            trade(1, 'fut', {
              dex: 'jupiter',
              blockTime: Math.floor(Date.parse('2099-01-01T00:00:00.000Z') / 1000),
            }),
          ],
        }),
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(future.slots[0]!.lastTradeLabel).not.toBe('now');
    expect(future.slots[0]!.lastTradeLabel).toBe('time unavailable');
    expect(future.tape).toEqual(['JUPITER TIME UNKNOWN']);
  });

  // The bound is RELATIVE to the clock, so these are the two sides of 60 s.
  test('59 seconds ahead is forgiven — chain time and our clock differ by seconds', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const skewed = buildFloorScreenData(
      [
        view({
          counts: {
            verified: 1,
            scored: 1,
            lastTradeAt: new Date(now + 59_000).toISOString(),
          },
          recentTrades: [
            trade(1, 'skew', { dex: 'jupiter', blockTime: Math.floor(now / 1000) + 59 }),
          ],
        }),
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(skewed.slots[0]!.lastTradeLabel).toBe('now');
    expect(skewed.tape).toEqual(['JUPITER NOW']);
  });

  test('61 seconds ahead is refused', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const beyond = buildFloorScreenData(
      [
        view({
          counts: {
            verified: 1,
            scored: 1,
            lastTradeAt: new Date(now + 61_000).toISOString(),
          },
          recentTrades: [
            trade(1, 'far', { dex: 'jupiter', blockTime: Math.floor(now / 1000) + 61 }),
          ],
        }),
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(beyond.slots[0]!.lastTradeLabel).toBe('time unavailable');
    expect(beyond.tape).toEqual(['JUPITER TIME UNKNOWN']);
  });

  test('an undated trade still says RECENT, which provenance earns', () => {
    const now = Date.parse('2026-09-19T12:00:00.000Z');
    const data = buildFloorScreenData(
      [view({ recentTrades: [trade(1, 'u', { dex: 'jupiter', blockTime: null })] })],
      { isLoading: false, isError: false },
      now,
    );
    expect(data.tape).toEqual(['JUPITER RECENT']);
  });

  test('a usable clock still ages both the card and the tape', () => {
    const now = Date.parse('2026-09-19T12:00:00.000Z');
    const data = buildFloorScreenData(
      [
        view({
          counts: {
            verified: 3,
            scored: 1,
            lastTradeAt: new Date(now - 7 * 60_000).toISOString(),
          },
          recentTrades: [
            trade(1, 'y', { dex: 'jupiter', blockTime: Math.floor((now - 120_000) / 1000) }),
          ],
        }),
      ],
      { isLoading: false, isError: false },
      now,
    );
    expect(data.slots[0]!.lastTradeLabel).toBe('7m ago');
    expect(data.tape).toEqual(['JUPITER 2M']);
  });

  test('every phase carries a clock', () => {
    const now = Date.parse('2026-09-19T14:32:00.000Z');
    const state = { isLoading: false, isError: false };
    expect(buildFloorScreenData(undefined, { ...state, isLoading: true }, now).clockLabel)
      .toBe('14:32 UTC');
    expect(buildFloorScreenData([], { ...state, isError: true }, now).clockLabel).toBe(
      '14:32 UTC',
    );
    expect(buildFloorScreenData([view()], state, now).clockLabel).toBe('14:32 UTC');
  });
});

describe('Trading Floor board — the bottom tape', () => {
  const now = Date.parse('2026-09-19T12:00:00.000Z');
  const state = { isLoading: false, isError: false };
  const at = (minutesAgo: number) => Math.floor((now - minutesAgo * 60_000) / 1000);

  function tapeFor(trades: FloorTrade[]): readonly string[] {
    return buildFloorScreenData([view({ recentTrades: trades })], state, now).tape;
  }

  test('a listed token is named; an unlisted one shows the venue only', () => {
    expect(
      tapeFor([
        trade(2, 'a', {
          inputMint: TRADE_MINTS.USDC,
          outputMint: TRADE_MINTS.ANSEM,
          dex: 'pumpswap',
          blockTime: at(4),
        }),
      ]),
    ).toEqual(['ANSEM PUMPSWAP 4M']);

    expect(
      tapeFor([
        trade(1, 'b', {
          inputMint: TRADE_MINTS.WSOL,
          outputMint: '7xKXtg2CW3eTA1hqzVfKp8mKQqZ9rPfLmNbVcXyZaQw1',
          dex: 'jupiter',
          blockTime: at(9),
        }),
      ]),
    ).toEqual(['JUPITER 9M']);
  });

  // The whole reason the tape does not reuse the panel's `symbolForMint`.
  test('an unlisted mint never puts a chain identifier on the wall', () => {
    const mint = '7xKXtg2CW3eTA1hqzVfKp8mKQqZ9rPfLmNbVcXyZaQw1';
    const tape = tapeFor([
      trade(1, 'c', { inputMint: TRADE_MINTS.WSOL, outputMint: mint, blockTime: at(1) }),
    ]);
    expect(tape.join(' ')).not.toContain(mint.slice(0, 5));
    assertDrawable(
      draw({ phase: 'ready', slots: [slot()], tape: [...tape] }).strings,
    );
  });

  test('the token side is read off whichever leg is not the quote', () => {
    // Selling the listed token back into USDC still names the listed token.
    expect(
      tapeFor([
        trade(2, 'd', {
          inputMint: TRADE_MINTS.CLAWVILLE,
          outputMint: TRADE_MINTS.USDC,
          dex: 'pumpfun',
          blockTime: at(30),
        }),
      ]),
    ).toEqual(['CLAWVILLE PUMP.FUN 30M']);
  });

  test('entries run newest first across every slot', () => {
    const data = buildFloorScreenData(
      [
        view({
          recentTrades: [
            trade(1, 'old', { dex: 'jupiter', blockTime: at(120) }),
          ],
        }),
        view({
          objective: 'second',
          recentTrades: [trade(1, 'new', { dex: 'pumpswap', blockTime: at(2) })],
        }),
      ],
      state,
      now,
    );
    expect(data.tape).toEqual(['PUMPSWAP 2M', 'JUPITER 2H']);
  });

  test('a trade row carrying realised USD puts it on the tape, signed', () => {
    expect(
      tapeFor([
        trade(1, 'm', {
          dex: 'pumpswap',
          blockTime: at(3),
          realisedUsd: -1.25,
        } as Partial<FloorTrade>),
      ]),
    ).toEqual(['PUMPSWAP 3M -$1.25']);
  });

  test('a trade row without the field omits it rather than printing zero', () => {
    expect(tapeFor([trade(1, 'n', { dex: 'pumpswap', blockTime: at(3) })])).toEqual([
      'PUMPSWAP 3M',
    ]);
  });

  test('an undated trade is kept and labelled, never dropped and never dated', () => {
    expect(
      tapeFor([trade(1, 'e', { dex: 'jupiter', blockTime: null })]),
    ).toEqual(['JUPITER RECENT']);
  });

  test('the tape is bounded even when a desk has been busy', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      trade(1, `sig-${index}`, { dex: 'jupiter', blockTime: at(index + 1) }),
    );
    expect(tapeFor(many).length).toBe(12);
  });

  test('no tape at all in the loading and error phases', () => {
    expect(buildFloorScreenData(undefined, { isLoading: true, isError: false }, now).tape)
      .toEqual([]);
    expect(buildFloorScreenData([], { isLoading: false, isError: true }, now).tape).toEqual(
      [],
    );
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

describe('Trading Floor board — redraw signature', () => {
  test('changes when a count changes', () => {
    const before = floorScreenSignature([view()], { isLoading: false, isError: false });
    const after = floorScreenSignature(
      [view({ counts: { verified: 13, scored: 8, lastTradeAt: null } })],
      { isLoading: false, isError: false },
    );
    expect(after).not.toBe(before);
  });

  test('does NOT change when a refetch returns the same board', () => {
    const state = { isLoading: false, isError: false };
    expect(floorScreenSignature([view()], state)).toBe(
      floorScreenSignature([view()], state),
    );
  });

  // The tape reads venue and block time, which the counts do not cover: a
  // confirmation that fills in a block time changes the bottom row and nothing
  // else, and the board has to redraw for it.
  test('changes when only a tape field changes', () => {
    const state = { isLoading: false, isError: false };
    const pending = floorScreenSignature(
      [view({ recentTrades: [trade(1, 'sig', { blockTime: null })] })],
      state,
    );
    const confirmed = floorScreenSignature(
      [view({ recentTrades: [trade(1, 'sig', { blockTime: 1_700_000_000 })] })],
      state,
    );
    expect(confirmed).not.toBe(pending);
    const elsewhere = floorScreenSignature(
      [view({ recentTrades: [trade(1, 'sig', { dex: 'pumpswap' })] })],
      state,
    );
    expect(elsewhere).not.toBe(
      floorScreenSignature([view({ recentTrades: [trade(1, 'sig')] })], state),
    );
  });

  // CODEX ROUND 4. The signature omitted the realised block entirely, so a
  // refreshed response that changed the P&L did not repaint until the 30 s
  // clock tick — a money board holding fresh data and showing a stale figure.
  describe('the realised block reaches the redraw trigger', () => {
    const state = { isLoading: false, isError: false };
    const sign = (realisedOverrides: Record<string, unknown>) =>
      floorScreenSignature(
        [
          {
            ...view(),
            realised: { ...fullRealised(), ...realisedOverrides },
          } as unknown as HouseTraderSlotView,
        ],
        state,
      );

    test('identical data produces an identical signature', () => {
      expect(sign({})).toBe(sign({}));
    });

    test.each([
      ['partial', { partial: true }],
      ['realisedUsd', { realisedUsd: -6.4 }],
      ['wins', { wins: 5 }],
      ['losses', { losses: 7 }],
      ['closedPositions', { closedPositions: 11 }],
      ['openPositions', { openPositions: 3 }],
      ['bestUsd', { bestUsd: 9.1 }],
      ['worstUsd', { worstUsd: -9.1 }],
      ['noExitClosures', { noExitClosures: 2 }],
      ['excludedNonUsdc', { excludedNonUsdc: 4 }],
      ['basisCode', { basis: 'some_other_basis' }],
      ['costBasis', { costBasis: 'some_other_method' }],
      ['noExitHours', { noExitHours: 48 }],
      ['note', { note: 'a different sentence' }],
    ])('a change in %s changes the signature', (_name, overrides) => {
      expect(sign(overrides)).not.toBe(sign({}));
    });

    test('a change in AVAILABILITY changes the signature', () => {
      // ready -> none -> unavailable are three different boards.
      const readySig = sign({});
      const noneSig = sign({ closedPositions: 0 });
      const brokenSig = sign({ realisedUsd: Number.NaN });
      expect(noneSig).not.toBe(readySig);
      expect(brokenSig).not.toBe(readySig);
      expect(brokenSig).not.toBe(noneSig);
    });
  });

  // CODEX ROUND 5: the same defect as round 4, one level down. The per-trade
  // part of the signature was hand-enumerated, so when the TAPE grew a
  // realised USD figure the trigger did not, and a trade whose only change was
  // its realised amount repainted nothing until the 30 s tick.
  describe('every tape input reaches the redraw trigger', () => {
    const state = { isLoading: false, isError: false };
    const sign = (overrides: Partial<FloorTrade>) =>
      floorScreenSignature(
        [view({ recentTrades: [trade(1, 'sig', overrides)] })],
        state,
      );

    test('identical trades produce an identical signature', () => {
      expect(sign({})).toBe(sign({}));
    });

    test.each([
      ['realisedUsd', { realisedUsd: -1.25 } as Partial<FloorTrade>],
      ['dex', { dex: 'pumpswap' } as Partial<FloorTrade>],
      ['blockTime', { blockTime: 1_700_000_999 } as Partial<FloorTrade>],
      ['inputMint', { inputMint: TRADE_MINTS.ANSEM } as Partial<FloorTrade>],
      ['outputMint', { outputMint: TRADE_MINTS.CLAWVILLE } as Partial<FloorTrade>],
      ['multiplier', { multiplier: 2 } as Partial<FloorTrade>],
    ])('a change in one trade\'s %s changes the signature', (_name, overrides) => {
      expect(sign(overrides)).not.toBe(sign({}));
    });

    test('a realised figure appearing on a trade changes the signature', () => {
      // The exact round-5 case: same trade, same venue, same time, and the
      // tape gains "-$1.25". Before the fix these two were identical strings.
      const without = sign({});
      const with_ = sign({ realisedUsd: -1.25 } as Partial<FloorTrade>);
      expect(with_).not.toBe(without);
    });
  });

  // THE RISK VERDICT REACHES THE TRIGGER. The status word changes with it, so a
  // desk that goes paused between two polls must repaint within one poll rather
  // than waiting up to 30 s for the clock tick — the board would be showing
  // LIVE for a desk that cannot trade, which is the failure this feature ends.
  describe('the risk block reaches the redraw trigger', () => {
    const state = { isLoading: false, isError: false };
    const sign = (risk: HouseTraderSlotView['risk']) =>
      floorScreenSignature([view({ risk })], state);

    test('identical verdicts produce an identical signature', () => {
      expect(sign(riskView())).toBe(sign(riskView()));
    });

    test.each([
      ['state', riskView({ state: 'fault' })],
      ['reason', riskView({ reason: 'at_max_positions' })],
    ])('a change in %s changes the signature', (_name, next) => {
      expect(sign(next)).not.toBe(sign(riskView()));
    });

    test('a verdict appearing or clearing changes the signature', () => {
      const none = sign(null);
      expect(sign(riskView())).not.toBe(none);
      expect(sign(riskView({ state: 'fault' }))).not.toBe(none);
    });

    // A LIVE verdict and NO verdict draw the same card, so they sign the same
    // and the board does not repaint between them. That changed when `reason`
    // started being nulled alongside an unshown display: before, a live block
    // leaked its `ok` into the trigger and bought a repaint for identical
    // pixels. Asserted rather than left implicit, because it looks like a
    // missing case until you notice the two boards are the same board.
    test('a live verdict and no verdict are one board, so one signature', () => {
      expect(sign(riskView({ state: 'live', reason: 'ok' }))).toBe(sign(null));
    });

    // THE STAGING CASE. An absent field and an explicit null are the same
    // board, so they must be the same trigger. (The signature STRING format
    // changed when the projection landed, which costs nothing: the signature is
    // recomputed from live data on every render and is never compared against
    // one from a previous deploy. What has to hold is the DRAWN PIXELS, pinned
    // by the test below.)
    test('an absent field and an explicit null produce one signature', () => {
      const { risk: _absent, ...withoutRisk } = view();
      expect(floorScreenSignature([withoutRisk as HouseTraderSlotView], state)).toBe(
        sign(null),
      );
    });

    // THE REPAINT-STORM PIN, and the reason the signature does NOT stringify
    // the whole wire block. `ageSeconds` counts up on every poll, so a derived
    // signature that included it would change every 15 s forever, and every
    // change is a full canvas redraw plus a 1.28 MB texture upload (5.13 MB on
    // the 2x backing store) for pixels that are identical. `at` moves with it.
    // The board draws neither.
    test('a field that only moves with the clock does not repaint the board', () => {
      const base = sign(riskView());
      // BOTH SIDES OF THE EXPIRY BUDGET, deliberately. 42 s and 100 s are the
      // same board, so the ticking age must not repaint it. Crossing 150 s is
      // a different board and has its own test below; using 9_999 here (as an
      // earlier version did) was asserting that expiry does NOT work.
      expect(sign(riskView({ ageSeconds: 100 }))).toBe(base);
      expect(sign(riskView({ at: '2026-09-20T23:59:00.000Z' }))).toBe(base);
      // Nor do the panel's figures and prose, which the BOARD does not draw.
      expect(sign(riskView({ detail: 'something else entirely' }))).toBe(base);
      expect(sign(riskView({ dayLossUsd: 88.5, roomNeededUsd: 4, dayLossCapUsd: 90 }))).toBe(base);
    });

    // And the trigger is DERIVED from the same projection the draw reads, so a
    // risk field the board starts drawing cannot be one the trigger forgot.
    test('the signature is derived from the drawn projection, not hand-listed', () => {
      const source = readFileSync(
        join(import.meta.dir, 'trading-floor-screen-data.ts'),
        'utf8',
      );
      expect(source).toContain('JSON.stringify(readRiskForBoard(slot, freshness))');
      // `readRiskForBoard` feeds the DRAW too, which is what makes the
      // derivation worth anything.
      expect(source).toContain('readRiskForBoard(slot, freshness).display');
    });

    // And the DRAW is identical too, not just the trigger.
    test('a payload without the field draws exactly what a null verdict draws', () => {
      const now = Date.parse('2026-09-20T12:00:00.000Z');
      const { risk: _absent, ...withoutRisk } = view();
      const paint = (slots: HouseTraderSlotView[]) => {
        const rec = recorder();
        drawFloorScreen(rec.context, buildFloorScreenData(slots, state, now));
        return rec.painted;
      };
      expect(paint([withoutRisk as HouseTraderSlotView])).toEqual(paint([view({ risk: null })]));
    });
  });

  // CLIENT-SIDE EXPIRY. react-query KEEPS the last good data when a refetch
  // fails or hangs, so without this a route outage during a pause leaves
  // PAUSED on the wall for as long as the player stands there, fed by a dead
  // feed. The client budget is the server's own 150 s applied to the SUM of
  // the report's age and how long we have held the response. (Codex round 2.)
  describe('a verdict expires in the client when the feed stops', () => {
    const state = { isLoading: false, isError: false };
    const FETCHED = Date.parse('2026-09-20T12:00:00.000Z');
    const at = (heldSeconds: number) => ({
      nowMs: FETCHED + heldSeconds * 1000,
      dataUpdatedAt: FETCHED,
    });
    const statusAt = (heldSeconds: number, ageSeconds = 40) =>
      buildFloorScreenData(
        [view({ risk: riskView({ ageSeconds }) })],
        state,
        FETCHED + heldSeconds * 1000,
        FETCHED,
      ).slots[0]!.status;

    test('holds the pause while the sum is inside the budget', () => {
      expect(statusAt(0)).toBe('paused');
      expect(statusAt(100)).toBe('paused');
      // 40 + 110 = 150 exactly. The budget is "> 150", so the edge still holds.
      expect(statusAt(110)).toBe('paused');
    });

    test('drops the pause once the sum passes the budget', () => {
      // 40 + 111 = 151. The desk reverts to its pairing word, LIVE, which is
      // the honest reading: we have stopped being told anything, which is not
      // the same as being told the risk read failed.
      expect(statusAt(111)).toBe('live');
      expect(statusAt(10_000)).toBe('live');
    });

    test('an expired FAULT also reverts, and never becomes a pause', () => {
      const expired = buildFloorScreenData(
        [view({ risk: riskView({ state: 'fault', ageSeconds: 40 }) })],
        state,
        FETCHED + 200_000,
        FETCHED,
      ).slots[0]!.status;
      expect(expired).toBe('live');
    });

    // ONE BIT reaches the trigger, never the ticking age: the signature moves
    // exactly once, when the verdict crosses the budget, and is stable either
    // side of it. That is what keeps a 15 s poll from repainting the board.
    test('expiry flips the signature exactly once', () => {
      const slots = [view({ risk: riskView({ ageSeconds: 40 }) })];
      const live = floorScreenSignature(slots, state, at(0));
      expect(floorScreenSignature(slots, state, at(100))).toBe(live);
      const expired = floorScreenSignature(slots, state, at(111));
      expect(expired).not.toBe(live);
      expect(floorScreenSignature(slots, state, at(9_999))).toBe(expired);
    });

    // A clock we cannot reason about must not expire a live pause on its own
    // authority; the server is still the primary decider.
    test('an unusable clock holds the verdict rather than dropping it', () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const held = buildFloorScreenData(
          [view({ risk: riskView({ ageSeconds: 40 }) })],
          state,
          bad,
          FETCHED,
        ).slots[0]!.status;
        expect({ bad, held }).toEqual({ bad, held: 'paused' });
      }
    });

    // A response dated in the FUTURE is clock skew, not extra freshness.
    test('a future fetch time is clamped rather than credited', () => {
      const skewed = buildFloorScreenData(
        [view({ risk: riskView({ ageSeconds: 40 }) })],
        state,
        FETCHED,
        FETCHED + 600_000,
      ).slots[0]!.status;
      expect(skewed).toBe('paused');
    });
  });

  test('ignores fields the board does not draw', () => {
    const state = { isLoading: false, isError: false };
    expect(
      floorScreenSignature([view({ strategyNote: 'something else entirely' })], state),
    ).toBe(floorScreenSignature([view()], state));
  });

  test('loading and error have their own signatures', () => {
    expect(floorScreenSignature(undefined, { isLoading: true, isError: false })).toBe(
      'connecting',
    );
    expect(floorScreenSignature([view()], { isLoading: false, isError: true })).toBe(
      'error',
    );
  });
});
