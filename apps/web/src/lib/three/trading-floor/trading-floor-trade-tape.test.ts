import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ARENA_TAPE_LIMIT,
  buildTapeSources,
  classifyArenaTapeItem,
  createTapeChipTransform,
  drawTapeAtlas,
  formatTapeSignedUsd,
  formatTapeUsd,
  readArenaTape,
  reconcileTapeChips,
  tapeCellRect,
  tapeCellUv,
  tapeChipPhase,
  tapeTraderName,
  TAPE_CHIP_COLOR,
  TAPE_ENTRY_LANE,
  TAPE_EXIT_LANE,
  TAPE_LANE_YAW,
  TAPE_POP_MIN_SCALE,
  writeTapeChipTransform,
  TAPE_ACTION_MAX_CHARS,
  TAPE_AMOUNT_MAX_CHARS,
  TAPE_ATLAS_HEIGHT,
  TAPE_ATLAS_WIDTH,
  TAPE_BOB,
  TAPE_CELL_HEIGHT,
  TAPE_CELL_WIDTH,
  TAPE_CHIP_HEIGHT,
  TAPE_CHIP_WIDTH,
  TAPE_LANES,
  TAPE_LANE_X,
  TAPE_LIFETIME_MS,
  TAPE_MAX_CHIPS,
  TAPE_PER_LANE,
  TAPE_POP,
  TAPE_POP_RISE,
  TAPE_TRADER_MAX_CHARS,
  TAPE_Y,
  TAPE_Z_END,
  TAPE_Z_START,
  type ArenaTapeItem,
  type TapeChip,
} from './trading-floor-trade-tape';
import {
  TRADING_FLOOR_CAMERA_Z_MAX,
  TRADING_FLOOR_DESK_INNER_X,
  TRADING_FLOOR_MONITOR,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_SCREEN,
  TRADING_FLOOR_SCREEN_SURROUND_FACE_Z,
  TRADING_FLOOR_SOLIDS,
} from './trading-floor-room';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINT = '7xKXtg2CW3eTA1hqzVfKp8mKQqZ9rPfLmNbVcXyZaQw1';
const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const at = (secondsAfterT0: number) => new Date(T0 + secondsAfterT0 * 1000).toISOString();

/** One tape row as the contract describes it (docs/trading-floor-arena.md §5). */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    at: at(0),
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

/** An exit row. */
function exit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return row({ id: 'x1', type: 'exit', side: 'sell', symbol: 'WIF', pnlUsd: 1.237, pnlMult: 1.06, reason: 'tp', ...overrides });
}

function item(overrides: Partial<ArenaTapeItem> = {}): ArenaTapeItem {
  return {
    id: 'e1',
    atMs: T0,
    agentName: 'Genesis',
    type: 'entry',
    symbol: 'BONK',
    usd: 20,
    pnlUsd: null,
    ...overrides,
  };
}

function chip(overrides: Partial<TapeChip> = {}): TapeChip {
  return {
    key: 'id',
    lane: 0,
    seed: 0.3,
    kind: 'gain',
    trader: 'GENESIS',
    action: 'SELL WIF',
    amount: '+$1.24',
    releasedAtMs: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

describe('readArenaTape', () => {
  test('reads the bare array and the two envelopes, and nothing else', () => {
    const expected = readArenaTape([row()]);
    expect(expected).toHaveLength(1);
    expect(readArenaTape({ items: [row()] })).toEqual(expected);
    expect(readArenaTape({ tape: [row()] })).toEqual(expected);
    for (const junk of [undefined, null, 'tape', 7, {}, { items: 'x' }]) {
      expect(readArenaTape(junk)).toEqual([]);
    }
  });

  test('carries exactly the fields a face or the board row draws — never the mint', () => {
    const [read] = readArenaTape([row()]);
    expect(read).toEqual({
      id: 'e1',
      atMs: T0,
      agentName: 'Genesis',
      type: 'entry',
      symbol: 'BONK',
      usd: 20,
      pnlUsd: null,
    });
    expect(JSON.stringify(read)).not.toContain(MINT);
  });

  test('a row with no id, an unknown side, or no object at all is dropped', () => {
    const read = readArenaTape([
      row({ id: '' }),
      row({ id: 7 }),
      row({ id: 'a', type: 'swap' }),
      null,
      'row',
      row({ id: 'ok' }),
    ]);
    expect(read.map((value) => value.id)).toEqual(['ok']);
  });

  test('one tape id is one row, first wins', () => {
    const read = readArenaTape([row({ id: 'same', agentName: 'First' }), row({ id: 'same', agentName: 'Second' })]);
    expect(read).toHaveLength(1);
    expect(read[0]!.agentName).toBe('First');
  });

  test('newest first; an undated or unparsable time sorts last and is kept', () => {
    const read = readArenaTape([
      row({ id: 'old', at: at(-600) }),
      row({ id: 'undated', at: null }),
      row({ id: 'garbage', at: 'yesterday' }),
      row({ id: 'new', at: at(0) }),
    ]);
    expect(read.map((value) => value.id)).toEqual(['new', 'old', 'undated', 'garbage']);
    expect(read[2]!.atMs).toBeNull();
    expect(read[3]!.atMs).toBeNull();
  });

  test('a money field that is not a finite number is unknown, never 0', () => {
    const [read] = readArenaTape([exit({ usd: '20', pnlUsd: Number.NaN })]);
    expect(read!.usd).toBeNull();
    expect(read!.pnlUsd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

describe('classifyArenaTapeItem', () => {
  test('an entry is a BUY of the token for the ticket, never a P&L', () => {
    expect(classifyArenaTapeItem(item())).toEqual({ kind: 'buy', action: 'BUY BONK', amount: '$20.00' });
  });

  test('an exit with a positive result is a GAIN, a negative one a LOSS', () => {
    expect(classifyArenaTapeItem(item({ type: 'exit', symbol: 'WIF', pnlUsd: 1.237 }))).toEqual({
      kind: 'gain',
      action: 'SELL WIF',
      amount: '+$1.24',
    });
    expect(classifyArenaTapeItem(item({ type: 'exit', symbol: 'WIF', pnlUsd: -0.87 }))).toEqual({
      kind: 'loss',
      action: 'SELL WIF',
      amount: '-$0.87',
    });
  });

  test('a realised ZERO is flat and prints unsigned — it is neither', () => {
    expect(classifyArenaTapeItem(item({ type: 'exit', pnlUsd: 0 }))).toMatchObject({
      kind: 'flat',
      amount: '$0.00',
    });
  });

  // "SELL WIF $20.00" would read as "sold for $20", a figure we were not given.
  test('an exit the route could not price is flat and shows no figure at all', () => {
    expect(classifyArenaTapeItem(item({ type: 'exit', symbol: 'WIF', pnlUsd: null }))).toEqual({
      kind: 'flat',
      action: 'SELL WIF',
      amount: '',
    });
  });

  test('no symbol states the side alone; no ticket states no figure', () => {
    expect(classifyArenaTapeItem(item({ symbol: null })).action).toBe('BUY');
    expect(classifyArenaTapeItem(item({ symbol: '' })).action).toBe('BUY');
    expect(classifyArenaTapeItem(item({ usd: null })).amount).toBe('');
    expect(classifyArenaTapeItem(item({ usd: 0 })).amount).toBe('');
  });

  // The symbol is DexScreener text. Sanitised BEFORE it is cut, or a truncated
  // address would be a printable fragment the address strip no longer sees.
  test('a symbol that is an address is dropped, and one hidden by an invisible char too', () => {
    expect(classifyArenaTapeItem(item({ symbol: MINT })).action).toBe('BUY');
    const split = `${MINT.slice(0, 20)}​${MINT.slice(20)}`;
    expect(classifyArenaTapeItem(item({ symbol: split })).action).toBe('BUY');
    expect(classifyArenaTapeItem(item({ symbol: 'ｂｏｎｋ' })).action).toBe('BUY BONK');
  });

  test('side, token and signed money fit the cell without losing cents', () => {
    for (const [pnlUsd, expected] of [
      [6.97, '+$6.97'],
      [-3.21, '-$3.21'],
      [12.5, '+$12.50'],
      [-999.99, '-$999.99'],
      [-99_999.99, '-$99,999.99'],
      [9_999_999, '+$10.0M'],
    ] as const) {
      const face = classifyArenaTapeItem(item({ type: 'exit', pnlUsd }));
      expect(face.amount).toBe(expected);
      expect(face.amount.length).toBeLessThanOrEqual(TAPE_AMOUNT_MAX_CHARS);
    }
    // Every magnitude fits the row WITHOUT being cut: the drawn amount is the
    // formatter's whole output, at every power of ten and just below it.
    for (let power = -2; power <= 16; power++) {
      for (const magnitude of [10 ** power, 10 ** power - 0.004, 10 ** power * 9.9996]) {
        for (const pnlUsd of [magnitude, -magnitude]) {
          const face = classifyArenaTapeItem(item({ type: 'exit', pnlUsd }));
          expect({ pnlUsd, amount: face.amount, fits: face.amount.length <= TAPE_AMOUNT_MAX_CHARS }).toEqual({
            pnlUsd,
            amount: formatTapeSignedUsd(pnlUsd),
            fits: true,
          });
        }
      }
    }
    const long = classifyArenaTapeItem(item({ type: 'exit', symbol: 'SUPERLONGSYMBOL', pnlUsd: 1 }));
    expect(long.action).toBe('SELL SUPERLON');
    expect(long.action.length).toBeLessThanOrEqual(TAPE_ACTION_MAX_CHARS);
  });
});

describe('trader labels', () => {
  test('names are sanitised before they are shortened', () => {
    expect(tapeTraderName('Ｇｅｎｅｓｉｓ')).toBe('GENESIS');
    expect(tapeTraderName('ClawVille\u0000 Runner')).toBe('RUNNER');
    expect(tapeTraderName('Mid-Cap Climber')).toBe('MID-CAP CL');
    for (const name of [MINT, '0x' + 'ab'.repeat(20)]) {
      expect(tapeTraderName(name)).toBe('TRADER');
      expect(tapeTraderName(name.slice(0, 12) + '​' + name.slice(12))).toBe('TRADER');
    }
    for (const name of ['Genesis\n🎲', 'Very Long Trader Name', '']) {
      const label = tapeTraderName(name);
      expect(label).toMatch(/^[\x20-\x7e]+$/);
      expect(label.length).toBeLessThanOrEqual(TAPE_TRADER_MAX_CHARS);
    }
  });
});

describe('money formatting', () => {
  // Codex review 2026-09-30: amounts from 1,000 up were rounded to whole
  // dollars with no mark, and the builder then CUT anything past 13 characters
  // ("+$1,000,000,000" -> "+$1,000,000,0", a different figure).
  test('exact to the cent below 100,000, compact above, and never cut', () => {
    expect(formatTapeUsd(12.5)).toBe('$12.50');
    expect(formatTapeUsd(0.004)).toBe('$0.00');
    expect(formatTapeUsd(1234.6)).toBe('$1,234.60');
    expect(formatTapeUsd(99_999.99)).toBe('$99,999.99');
    expect(formatTapeUsd(99_999.996)).toBe('$100.0K');
    expect(formatTapeUsd(123_456)).toBe('$123.5K');
    expect(formatTapeUsd(999_960)).toBe('$1.0M');
    expect(formatTapeUsd(1.2e9)).toBe('$1.2B');
    expect(formatTapeUsd(1e18)).toBe('N/A');
    expect(formatTapeUsd(Number.NaN)).toBe('N/A');
    expect(formatTapeSignedUsd(-1.5)).toBe('-$1.50');
    expect(formatTapeSignedUsd(1.5)).toBe('+$1.50');
    expect(formatTapeSignedUsd(0)).toBe('$0.00');
    expect(formatTapeSignedUsd(1e18)).toBe('N/A');
  });
});

// ---------------------------------------------------------------------------
// Source list
// ---------------------------------------------------------------------------

describe('buildTapeSources', () => {
  test('entries fly down the left lane, exits down the right', () => {
    expect(TAPE_ENTRY_LANE).toBe(0);
    expect(TAPE_EXIT_LANE).toBe(1);
    const sources = buildTapeSources([row({ id: 'e', at: at(0) }), exit({ id: 'x', at: at(-5) })]);
    expect(sources.map((value) => [value.key, value.lane, value.kind])).toEqual([
      ['e', 0, 'buy'],
      ['x', 1, 'gain'],
    ]);
  });

  test('each lane holds its own newest six: a run of up to 18 entries still leaves six exits', () => {
    const entries = Array.from({ length: 18 }, (_unused, index) =>
      row({ id: `e${index}`, at: at(-index) }),
    );
    const exits = Array.from({ length: 6 }, (_unused, index) =>
      exit({ id: `x${index}`, at: at(-100 - index) }),
    );
    const sources = buildTapeSources([...entries, ...exits]);
    expect(sources.filter((value) => value.lane === TAPE_ENTRY_LANE)).toHaveLength(TAPE_PER_LANE);
    expect(sources.filter((value) => value.lane === TAPE_EXIT_LANE)).toHaveLength(TAPE_PER_LANE);
    expect(sources.length).toBeLessThanOrEqual(TAPE_MAX_CHIPS);
    // Newest of each side.
    expect(sources.filter((value) => value.lane === 0).map((value) => value.key)).toEqual([
      'e0', 'e1', 'e2', 'e3', 'e4', 'e5',
    ]);
  });

  // The limit of the claim, pinned so nobody reads the lanes as guaranteed:
  // 24 entries in a row fill the window and the exit lane is empty.
  test('a run longer than 18 entries leaves the exit lane short, and says nothing false', () => {
    const entries = Array.from({ length: 24 }, (_unused, index) =>
      row({ id: `e${index}`, at: at(-index) }),
    );
    const sources = buildTapeSources([...entries, exit({ id: 'old-exit', at: at(-500) })]);
    expect(sources.filter((value) => value.lane === TAPE_ENTRY_LANE)).toHaveLength(TAPE_PER_LANE);
    // The route window is 24 rows; the 25th (the exit) is outside it in the
    // live feed, and inside it here only because the fixture passes it.
    expect(sources.filter((value) => value.lane === TAPE_EXIT_LANE)).toHaveLength(1);
    expect(buildTapeSources(entries).filter((value) => value.lane === TAPE_EXIT_LANE)).toHaveLength(0);
  });

  test('both surfaces ask for enough rows to fill both lanes', () => {
    expect(ARENA_TAPE_LIMIT).toBe(24);
    expect(ARENA_TAPE_LIMIT).toBeGreaterThanOrEqual(TAPE_MAX_CHIPS);
  });

  test('ONE tape row never becomes two objects in the room', () => {
    expect(buildTapeSources([row({ id: 'same' }), row({ id: 'same' })])).toHaveLength(1);
  });

  test('the mint never reaches a chip face', () => {
    for (const source of buildTapeSources([row(), exit(), row({ id: 'n', symbol: MINT })])) {
      expect(`${source.trader} ${source.action} ${source.amount}`).not.toContain(MINT.slice(0, 5).toUpperCase());
      expect(`${source.trader} ${source.action} ${source.amount}`).not.toContain(MINT.slice(0, 5));
    }
  });

  test('no data and no rows both yield an empty tape, never a throw', () => {
    expect(buildTapeSources(undefined)).toEqual([]);
    expect(buildTapeSources([])).toEqual([]);
    expect(buildTapeSources({ items: [] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

describe('reconcileTapeChips', () => {
  const now = 1_000_000;

  test('THE FIRST FILL SEEDS: the hall is already moving, and nothing pops', () => {
    const sources = buildTapeSources([
      row({ id: 'g1', at: at(-100) }),
      row({ id: 'g2', at: at(-200) }),
      row({ id: 'g3', at: at(-300) }),
    ]);
    const chips = reconcileTapeChips([], sources, now);
    const phases = chips.map((c) => tapeChipPhase(c, now));

    // Every seeded chip is past its first traverse, so none of them pops.
    for (const phase of phases) expect(phase.cycle).toBeGreaterThanOrEqual(1);
    // And they are spread along the lane rather than stacked at the wall.
    expect(phases.map((p) => Number(p.phase.toFixed(4)))).toEqual(
      [0, 1 / 3, 2 / 3].map((v) => Number(v.toFixed(4))),
    );
  });

  test('a row that arrives LATER enters at the wall and pops', () => {
    const first = reconcileTapeChips([], buildTapeSources([row({ id: 'a', at: at(-60) })]), now);
    const later = reconcileTapeChips(
      first,
      buildTapeSources([row({ id: 'fresh', at: at(0) }), row({ id: 'a', at: at(-60) })]),
      now + 5_000,
    );
    const fresh = later.find((c) => c.key === 'fresh')!;
    const phase = tapeChipPhase(fresh, now + 5_000);
    expect(phase.cycle).toBe(0);
    expect(phase.phase).toBe(0);
    expect(phase.phase).toBeLessThan(TAPE_POP);
  });

  test('a surviving row keeps its flight across a poll', () => {
    const sources = buildTapeSources([row({ id: 'a' })]);
    const first = reconcileTapeChips([], sources, now);
    const second = reconcileTapeChips(first, sources, now + 15_000);
    expect(second[0]!.releasedAtMs).toBe(first[0]!.releasedAtMs);
  });

  test('a poll that changed nothing returns the SAME array, so no atlas repaint', () => {
    const first = reconcileTapeChips([], buildTapeSources([row({ id: 'a' })]), now);
    const second = reconcileTapeChips(first, buildTapeSources([row({ id: 'a' })]), now + 15_000);
    expect(second).toBe(first);
  });

  test('an emptied payload clears the tape, and stays empty without churning', () => {
    const first = reconcileTapeChips([], buildTapeSources([row({ id: 'a' })]), now);
    const cleared = reconcileTapeChips(first, [], now);
    expect(cleared).toEqual([]);
    expect(reconcileTapeChips(cleared, [], now)).toBe(cleared);
  });

  test('a chip whose FACE changed keeps flying rather than restarting', () => {
    const before = reconcileTapeChips([], buildTapeSources([exit({ id: 'a', pnlUsd: null })]), now);
    expect(before[0]!.kind).toBe('flat');
    const after = reconcileTapeChips(
      before,
      buildTapeSources([exit({ id: 'a', pnlUsd: 2 })]),
      now + 30_000,
    );
    expect(after[0]!.kind).toBe('gain');
    expect(after[0]!.amount).toBe('+$2.00');
    expect(after[0]!.releasedAtMs).toBe(before[0]!.releasedAtMs);
  });

  test('a changed ACTION alone repaints the atlas', () => {
    const before = reconcileTapeChips([], buildTapeSources([row({ id: 'a', symbol: 'BONK' })]), now);
    const after = reconcileTapeChips(before, buildTapeSources([row({ id: 'a', symbol: 'WIF' })]), now);
    expect(after).not.toBe(before);
    expect(after[0]!.action).toBe('BUY WIF');
  });
});

// ---------------------------------------------------------------------------
// Flight geometry — the part that has to be right, computed not asserted
// ---------------------------------------------------------------------------

/** Every corner of a chip at `nowMs`, in world space. Mirrors exactly what the
 *  component writes into the position attribute. */
function corners(c: TapeChip, nowMs: number): { x: number; y: number; z: number }[] {
  const out = createTapeChipTransform();
  writeTapeChipTransform(c, nowMs, out);
  if (!out.visible) return [];
  const ex = out.rightX * out.halfWidth;
  const ez = out.rightZ * out.halfWidth;
  return [
    { x: out.x - ex, y: out.y - out.halfHeight, z: out.z - ez },
    { x: out.x + ex, y: out.y - out.halfHeight, z: out.z + ez },
    { x: out.x - ex, y: out.y + out.halfHeight, z: out.z - ez },
    { x: out.x + ex, y: out.y + out.halfHeight, z: out.z + ez },
  ];
}

/** A fine sweep of one full traverse for both lanes, including the pop. */
function sweep(callback: (c: TapeChip, nowMs: number) => void): void {
  for (let lane = 0; lane < TAPE_LANES; lane++) {
    for (const seed of [0, 0.25, 0.5, 0.75, 0.99]) {
      // Cycle 0 exercises the pop; cycle 2 exercises the settled flight.
      for (const baseCycle of [0, 2]) {
        for (let step = 0; step <= 400; step++) {
          const nowMs =
            (baseCycle + step / 400) * TAPE_LIFETIME_MS - 1e-6 * (step === 400 ? 1 : 0);
          callback(chip({ lane, seed, releasedAtMs: 0 }), nowMs);
        }
      }
    }
  }
}

describe('flight geometry', () => {
  test('a chip never reaches the desk row', () => {
    let worst = 0;
    sweep((c, nowMs) => {
      for (const corner of corners(c, nowMs)) worst = Math.max(worst, Math.abs(corner.x));
    });
    expect(worst).toBeLessThan(TRADING_FLOOR_DESK_INNER_X);
    // Rotated half-width; the existing 10 wu desk margin remains mandatory.
    const deskBound = TRADING_FLOOR_DESK_INNER_X - 10 -
      Math.cos(TAPE_LANE_YAW) * TAPE_CHIP_WIDTH / 2;
    expect(deskBound).toBeCloseTo(896.9282040536, 6);
    expect(TAPE_LANE_X).toBeLessThan(deskBound);
    expect(TRADING_FLOOR_DESK_INNER_X - worst).toBeGreaterThan(10);
  });

  test('a chip never reaches the board, its surround or the door wall', () => {
    let nearest = Number.POSITIVE_INFINITY;
    let furthest = Number.NEGATIVE_INFINITY;
    sweep((c, nowMs) => {
      for (const corner of corners(c, nowMs)) {
        nearest = Math.min(nearest, corner.z);
        furthest = Math.max(furthest, corner.z);
      }
    });
    expect(nearest).toBeGreaterThan(TRADING_FLOOR_SCREEN_SURROUND_FACE_Z);
    expect(nearest).toBeGreaterThan(TRADING_FLOOR_SCREEN.z);
    // Clear of the chase camera's own Z clamp, so the tape never flies into
    // the lens when the player stands at the door.
    expect(furthest).toBeLessThan(TRADING_FLOOR_CAMERA_Z_MAX - 300);
  });

  test('a chip flies above every walking player and every floor-standing prop', () => {
    const AVATAR_HEIGHT = 270;
    const TALLEST_PROP = TRADING_FLOOR_MONITOR.height; // 300, the kiosk
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    sweep((c, nowMs) => {
      for (const corner of corners(c, nowMs)) {
        lowest = Math.min(lowest, corner.y);
        highest = Math.max(highest, corner.y);
      }
    });
    expect(lowest).toBeGreaterThan(AVATAR_HEIGHT);
    expect(lowest).toBeGreaterThan(TALLEST_PROP);
    expect(highest).toBeLessThan(TRADING_FLOOR_ROOM.height);
    // Bound all seeds and pop scales analytically, not just sampled seeds.
    const lowestBound = TAPE_Y - TAPE_BOB - Math.max(
      TAPE_CHIP_HEIGHT / 2,
      TAPE_POP_RISE + TAPE_POP_MIN_SCALE * TAPE_CHIP_HEIGHT / 2,
    );
    expect(lowestBound).toBeGreaterThan(TALLEST_PROP + 50);
    expect(lowest).toBeGreaterThanOrEqual(lowestBound);
    expect(TAPE_Y).toBeLessThanOrEqual(420);
    // The Y clearance is what removes the need for ANY XZ keep-out against the
    // desks, chairs, dais and kiosk — so pin the margin, not just the sign.
    expect(lowest - TALLEST_PROP).toBeGreaterThan(50);
  });

  test('the corner pillars run floor to ceiling, so the lane clears them in XZ', () => {
    // Every other solid is cleared in Y by the test above. The four pillars are
    // the exception: they are full-height, so this one is an XZ separation.
    const pillars = TRADING_FLOOR_SOLIDS.filter(
      (s) => s.halfX === 55 && s.halfZ === 55,
    );
    expect(pillars).toHaveLength(4);
    sweep((c, nowMs) => {
      for (const corner of corners(c, nowMs)) {
        for (const pillar of pillars) {
          const insideX = Math.abs(corner.x - pillar.centerX) < pillar.halfX;
          const insideZ = Math.abs(corner.z - pillar.centerZ) < pillar.halfZ;
          expect(insideX && insideZ).toBe(false);
        }
      }
    });
  });

  test('THE BOARD IS NEVER OCCLUDED FROM THE SPAWN', () => {
    // The chase camera at the spawn sits on the room's centre line, at the back
    // of its own Z clamp. Project the ray through every corner of every chip
    // onto the board plane: if the landing |x| is outside the board's own half
    // width the chip cannot cover it, WHATEVER the camera's pitch — the camera
    // is at x 0, so its height cancels out of the x projection entirely.
    const cameraZ = TRADING_FLOOR_CAMERA_Z_MAX;
    const boardHalfWidth = TRADING_FLOOR_SCREEN.width / 2;
    let closest = Number.POSITIVE_INFINITY;
    sweep((c, nowMs) => {
      for (const corner of corners(c, nowMs)) {
        const t = (TRADING_FLOOR_SCREEN.z - cameraZ) / (corner.z - cameraZ);
        // Behind the camera or past the board is not an occluder.
        if (t <= 1) continue;
        closest = Math.min(closest, Math.abs(t * corner.x));
      }
    });
    expect(closest).toBeGreaterThan(boardHalfWidth);
    // The inner corner is farther from the camera because of the inward yaw.
    // Its X projection does not depend on Y, including at the new flight height.
    const halfX = Math.cos(TAPE_LANE_YAW) * TAPE_CHIP_WIDTH / 2;
    const halfZ = Math.sin(TAPE_LANE_YAW) * TAPE_CHIP_WIDTH / 2;
    const projection = (cameraZ - TRADING_FLOOR_SCREEN.z) /
      (cameraZ - (TAPE_Z_START - halfZ));
    const boardBound = halfX + (boardHalfWidth + 15) / projection;
    expect(boardBound).toBeCloseTo(873.0862276225, 6);
    expect(projection).toBeCloseTo(1.088, 3);
    expect(TAPE_LANE_X).toBeGreaterThan(boardBound);
    expect(closest).toBeCloseTo((TAPE_LANE_X - halfX) * projection, 6);
    expect(closest - boardHalfWidth).toBeGreaterThan(15);
  });

  test('the flight is continuous: z rises monotonically across one traverse', () => {
    const out = createTapeChipTransform();
    const c = chip({ releasedAtMs: 0, seed: 0 });
    let previous = Number.NEGATIVE_INFINITY;
    for (let step = 0; step < 200; step++) {
      writeTapeChipTransform(c, (step / 200) * TAPE_LIFETIME_MS, out);
      expect(out.z).toBeGreaterThan(previous);
      previous = out.z;
    }
    expect(previous).toBeLessThan(TAPE_Z_END);
  });

  test('a chip wraps back to the wall instead of leaving an empty hall', () => {
    const out = createTapeChipTransform();
    const c = chip({ releasedAtMs: 0 });
    writeTapeChipTransform(c, TAPE_LIFETIME_MS * 0.999, out);
    const beforeWrap = out.z;
    writeTapeChipTransform(c, TAPE_LIFETIME_MS * 1.001, out);
    expect(beforeWrap).toBeGreaterThan(TAPE_Z_END - 10);
    expect(out.z).toBeLessThan(TAPE_Z_START + 10);
  });

  test('a chip fades in and out, and is never fully bright at either end', () => {
    const out = createTapeChipTransform();
    const c = chip({ releasedAtMs: 0 });
    writeTapeChipTransform(c, 0, out);
    expect(out.alpha).toBe(0);
    writeTapeChipTransform(c, TAPE_LIFETIME_MS * 0.5, out);
    expect(out.alpha).toBe(1);
    writeTapeChipTransform(c, TAPE_LIFETIME_MS * 0.999, out);
    expect(out.alpha).toBeLessThan(0.05);
    // Normal blending fades opacity without changing the saturated fill.
    expect([out.red, out.green, out.blue]).toEqual([...TAPE_CHIP_COLOR.gain]);
  });

  test('the POP is first cycle only, and it grows rather than overshoots', () => {
    const out = createTapeChipTransform();
    const c = chip({ releasedAtMs: 0, seed: 0 });
    writeTapeChipTransform(c, TAPE_LIFETIME_MS * TAPE_POP * 0.01, out);
    const entry = out.halfWidth;
    expect(entry).toBeLessThan(TAPE_CHIP_WIDTH / 2);

    writeTapeChipTransform(c, TAPE_LIFETIME_MS * TAPE_POP, out);
    expect(out.halfWidth).toBeCloseTo(TAPE_CHIP_WIDTH / 2, 6);
    expect(out.halfHeight).toBeCloseTo(TAPE_CHIP_HEIGHT / 2, 6);

    // Second traverse: same phase, already full size — the pop does not repeat.
    writeTapeChipTransform(c, TAPE_LIFETIME_MS * (1 + TAPE_POP * 0.01), out);
    expect(out.halfWidth).toBeCloseTo(TAPE_CHIP_WIDTH / 2, 6);
  });

  test('the pop also RISES, so an arriving visitor sees the new trade move', () => {
    const out = createTapeChipTransform();
    const c = chip({ releasedAtMs: 0, seed: 0 });
    writeTapeChipTransform(c, 1, out);
    const entryY = out.y;
    writeTapeChipTransform(c, TAPE_LIFETIME_MS * TAPE_POP, out);
    expect(out.y - entryY).toBeGreaterThan(TAPE_POP_RISE * 0.5);
  });

  test('the idle bob stays inside its stated amplitude', () => {
    const out = createTapeChipTransform();
    for (const seed of [0, 0.33, 0.9]) {
      const c = chip({ releasedAtMs: 0, seed });
      for (let step = 0; step <= 100; step++) {
        writeTapeChipTransform(c, TAPE_LIFETIME_MS * (1 + step / 100), out);
        expect(Math.abs(out.y - TAPE_Y)).toBeLessThanOrEqual(TAPE_BOB + 1e-9);
      }
    }
  });

  test('an unreleased chip is invisible rather than placed at NaN', () => {
    const out = createTapeChipTransform();
    writeTapeChipTransform(chip({ releasedAtMs: 10_000 }), 5_000, out);
    expect(out.visible).toBe(false);
    expect(out.alpha).toBe(0);
    writeTapeChipTransform(chip({ releasedAtMs: Number.NaN }), 5_000, out);
    expect(out.visible).toBe(false);
  });

  test('an out-of-range lane falls back to lane 0 instead of writing NaN', () => {
    const out = createTapeChipTransform();
    writeTapeChipTransform(chip({ lane: 7, releasedAtMs: 0 }), TAPE_LIFETIME_MS * 0.5, out);
    expect(out.x).toBe(-TAPE_LANE_X);
    expect(Number.isFinite(out.y)).toBe(true);
    expect(Number.isFinite(out.z)).toBe(true);
  });

  test('the flight loop allocates nothing: the caller owns the record', () => {
    const out = createTapeChipTransform();
    const before = { ...out };
    writeTapeChipTransform(chip({ releasedAtMs: 0 }), TAPE_LIFETIME_MS * 0.5, out);
    expect(out).not.toEqual(before);
    // Same object back, mutated in place.
    expect(typeof out.x).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

interface RecordedText {
  text: string;
  x: number;
  y: number;
  font: string;
  fillStyle: string;
}

function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  texts: RecordedText[];
  clears: { x: number; y: number; w: number; h: number }[];
  fills: { x: number; y: number; w: number; h: number; fillStyle: string }[];
} {
  const texts: RecordedText[] = [];
  const fills: { x: number; y: number; w: number; h: number; fillStyle: string }[] = [];
  const clears: { x: number; y: number; w: number; h: number }[] = [];
  const state = { font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textAlign: '', textBaseline: '' };
  const ctx = {
    ...state,
    clearRect: (x: number, y: number, w: number, h: number) => clears.push({ x, y, w, h }),
    fillRect(this: { fillStyle: string }, x: number, y: number, w: number, h: number) {
      fills.push({ x, y, w, h, fillStyle: this.fillStyle });
    },
    strokeRect: () => undefined,
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, font: (this as { font: string }).font, fillStyle: (this as { fillStyle: string }).fillStyle });
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, texts, fills, clears };
}

/** Courier advances ~0.6em. Approximate on purpose: there is no 2D context in
 *  the runner, and the point is to catch a string RUNNING INTO THE NEXT CELL,
 *  which is a whole cell wide, not a pixel. */
function approximateWidth(text: string, font: string): number {
  const px = Number(font.match(/(\d+)px/)?.[1] ?? 16);
  return text.length * px * 0.6;
}
describe('drawTapeAtlas', () => {
  /** The widest face each row can hold. */
  const widest = (index: number) =>
    chip({
      key: `k${index}`,
      lane: index % TAPE_LANES,
      trader: 'W'.repeat(TAPE_TRADER_MAX_CHARS),
      action: 'W'.repeat(TAPE_ACTION_MAX_CHARS),
      amount: 'W'.repeat(TAPE_AMOUNT_MAX_CHARS),
    });

  test('every glyph stays inside its OWN cell — no bleed onto a neighbour', () => {
    const chips: TapeChip[] = Array.from({ length: TAPE_MAX_CHIPS }, (_, index) => widest(index));
    const { ctx, texts } = recordingContext();
    drawTapeAtlas(ctx, chips);

    expect(texts).toHaveLength(TAPE_MAX_CHIPS * 3);
    for (let index = 0; index < TAPE_MAX_CHIPS; index++) {
      const rect = tapeCellRect(index);
      for (const drawn of texts.slice(index * 3, index * 3 + 3)) {
        const px = Number(drawn.font.match(/(\d+)px/)?.[1] ?? 16);
        expect(drawn.x).toBeGreaterThanOrEqual(rect.x);
        // The glyph BOX, not the baseline: 0.72 em above, 0.2 em below, inside
        // the 5 px slab inset.
        expect(drawn.y - 0.72 * px).toBeGreaterThanOrEqual(rect.y + 5);
        expect(drawn.y + 0.2 * px).toBeLessThanOrEqual(rect.y + rect.height - 5);
        const right = drawn.x + approximateWidth(drawn.text, drawn.font);
        expect(right).toBeLessThanOrEqual(rect.x + rect.width);
      }
    }
  });

  test('the three rows of a face never overlap each other', () => {
    const { ctx, texts } = recordingContext();
    drawTapeAtlas(ctx, [widest(0)]);
    const boxes = texts.map((drawn) => {
      const px = Number(drawn.font.match(/(\d+)px/)?.[1] ?? 16);
      return { top: drawn.y - 0.72 * px, bottom: drawn.y + 0.2 * px };
    });
    expect(boxes).toHaveLength(3);
    for (let index = 1; index < boxes.length; index++) {
      expect(boxes[index]!.top).toBeGreaterThan(boxes[index - 1]!.bottom);
    }
  });

  test('the face reads trader, action, amount — and an empty amount is not painted', () => {
    const { ctx, texts } = recordingContext();
    drawTapeAtlas(ctx, [chip(), chip({ key: 'b', action: 'SELL WIF', amount: '' })]);
    expect(texts.map((drawn) => drawn.text)).toEqual(['GENESIS', 'SELL WIF', '+$1.24', 'GENESIS', 'SELL WIF']);
  });

  test('the atlas clears to transparent, so a recycled cell cannot ghost', () => {
    const { ctx, clears } = recordingContext();
    drawTapeAtlas(ctx, [chip()]);
    expect(clears[0]).toEqual({ x: 0, y: 0, w: TAPE_ATLAS_WIDTH, h: TAPE_ATLAS_HEIGHT });
  });

  test('the slab has an opaque tintable fill and dark high-contrast text', () => {
    for (const kind of ['gain', 'loss', 'buy'] as const) {
      const { ctx, fills, texts } = recordingContext();
      drawTapeAtlas(ctx, [chip({ kind })]);
      expect(fills[0]!.fillStyle).toBe('#ffffff');
      expect(fills[0]!.w * fills[0]!.h / (TAPE_CELL_WIDTH * TAPE_CELL_HEIGHT)).toBeGreaterThan(0.85);
      expect(texts.map((t) => t.fillStyle)).toEqual(['#071018', '#071018', '#071018']);
      const rgb = TAPE_CHIP_COLOR[kind];
      const max = Math.max(...rgb);
      const min = Math.min(...rgb);
      expect((max - min) / max).toBeGreaterThan(0.95);
      // Linear vertex colour multiplies the sRGB-decoded atlas texel.
      const textLinear = [7, 16, 24].map((v) =>
        v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      const ink = rgb[0] * textLinear[0]! * 0.2126 +
        rgb[1] * textLinear[1]! * 0.7152 + rgb[2] * textLinear[2]! * 0.0722;
      expect((luminance + 0.05) / (ink + 0.05)).toBeGreaterThan(4.5);
    }
    expect(TAPE_CHIP_COLOR.gain[1]).toBeGreaterThan(TAPE_CHIP_COLOR.gain[0] * 10);
    expect(TAPE_CHIP_COLOR.loss[0]).toBeGreaterThan(TAPE_CHIP_COLOR.loss[1] * 10);
    expect(TAPE_CHIP_COLOR.buy[1]).toBeGreaterThan(TAPE_CHIP_COLOR.buy[0] * 10);
    expect(TAPE_CHIP_COLOR.buy[2]).toBeGreaterThan(TAPE_CHIP_COLOR.buy[0] * 10);
  });

  test('the single material uses normal blending and an alpha canvas', () => {
    const source = readFileSync(join(import.meta.dir, 'trading-floor-trade-tape-mesh.tsx'), 'utf8');
    expect(source).toContain('blending: THREE.NormalBlending');
    expect(source).toContain("getContext('2d', { alpha: true })");
    expect(source.match(/new THREE.MeshBasicMaterial\(/g)).toHaveLength(1);
    expect(source.match(/<mesh\s/g)).toHaveLength(1);
  });

  test('the mesh reads the arena tape through the shared limit', () => {
    const source = readFileSync(join(import.meta.dir, 'trading-floor-trade-tape-mesh.tsx'), 'utf8');
    expect(source).toContain('useFloorArenaTape(ARENA_TAPE_LIMIT, active)');
    expect(source).not.toContain('useHouseTraders');
  });

  test('more chips than cells never paints past the atlas', () => {
    const chips = Array.from({ length: TAPE_MAX_CHIPS + 9 }, (_, index) =>
      chip({ key: `k${index}` }),
    );
    const { ctx, texts } = recordingContext();
    drawTapeAtlas(ctx, chips);
    expect(texts).toHaveLength(TAPE_MAX_CHIPS * 3);
    for (const drawn of texts) {
      expect(drawn.x).toBeLessThan(TAPE_ATLAS_WIDTH);
      expect(drawn.y).toBeLessThan(TAPE_ATLAS_HEIGHT);
    }
  });
});

describe('atlas layout', () => {
  test('the grid holds every quad and no cell overlaps another', () => {
    expect(TAPE_ATLAS_WIDTH * TAPE_ATLAS_HEIGHT).toBeGreaterThanOrEqual(
      TAPE_MAX_CHIPS * TAPE_CELL_WIDTH * TAPE_CELL_HEIGHT,
    );
    const seen = new Set<string>();
    for (let index = 0; index < TAPE_MAX_CHIPS; index++) {
      const rect = tapeCellRect(index);
      expect(rect.x + rect.width).toBeLessThanOrEqual(TAPE_ATLAS_WIDTH);
      expect(rect.y + rect.height).toBeLessThanOrEqual(TAPE_ATLAS_HEIGHT);
      const key = `${rect.x}:${rect.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test('the cell aspect matches the chip aspect, so no glyph is stretched', () => {
    expect(TAPE_CELL_WIDTH / TAPE_CELL_HEIGHT).toBeCloseTo(
      TAPE_CHIP_WIDTH / TAPE_CHIP_HEIGHT,
      6,
    );
  });

  test('UVs are in range and flipped for the CanvasTexture', () => {
    for (let index = 0; index < TAPE_MAX_CHIPS; index++) {
      const uv = tapeCellUv(index);
      for (const value of [uv.u0, uv.u1, uv.vTop, uv.vBottom]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(uv.u1).toBeGreaterThan(uv.u0);
      // v is flipped: canvas row 0 is the TOP of the image, which is v = 1.
      expect(uv.vTop).toBeGreaterThan(uv.vBottom);
      const rect = tapeCellRect(index);
      expect(uv.vTop).toBeCloseTo(1 - rect.y / TAPE_ATLAS_HEIGHT, 6);
    }
  });
});
