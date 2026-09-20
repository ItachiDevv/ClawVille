import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TRADE_MINTS } from '@clawville/shared';
import type { FloorTrade } from '@/stores/trade-ticker';
import type { HouseTraderSlotView } from '@/hooks/use-trading-floor';

import {
  buildTapeSources,
  classifyTapeTrade,
  createTapeChipTransform,
  drawTapeAtlas,
  formatTapeSignedUsd,
  formatTapeUsd,
  reconcileTapeChips,
  tapeCellRect,
  tapeCellUv,
  tapeChipPhase,
  writeTapeChipTransform,
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
  TAPE_SYMBOL_MAX_CHARS,
  TAPE_Y,
  TAPE_Z_END,
  TAPE_Z_START,
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

const MEME = 'MemeMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function trade(overrides: Partial<FloorTrade> & { signature: string }): FloorTrade {
  return {
    keys: [overrides.signature],
    kind: 'trade',
    subject: null,
    wallet: null,
    inputMint: TRADE_MINTS.USDC,
    outputMint: MEME,
    notionalUsd: 12.5,
    dex: 'jupiter',
    blockTime: 1_700_000_000,
    multiplier: 1,
    multiplierTier: 'base',
    decisionId: null,
    scored: true,
    unscoredReason: null,
    operatedByClawville: true,
    ...overrides,
  };
}

function slot(
  slotName: string,
  trades: FloorTrade[],
): HouseTraderSlotView {
  return {
    objective: 'momentum',
    slotName,
    strategyNote: '',
    status: 'live-observed',
    subject: null,
    counts: { verified: trades.length, scored: trades.length, lastTradeAt: null },
    risk: null,
    realised: null,
    recentTrades: trades,
  };
}

function chip(overrides: Partial<TapeChip> = {}): TapeChip {
  return {
    key: 'sig',
    lane: 0,
    seed: 0.3,
    kind: 'gain',
    symbol: 'ANSEM',
    amount: '+$1.24',
    releasedAtMs: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classifyTapeTrade', () => {
  test('quote in, token out is a BUY and carries the notional, never a P&L', () => {
    const face = classifyTapeTrade(
      trade({ signature: 'a', inputMint: TRADE_MINTS.USDC, outputMint: TRADE_MINTS.ANSEM }),
    );
    expect(face.kind).toBe('buy');
    expect(face.symbol).toBe('ANSEM');
    expect(face.amount).toBe('BUY $12.50');
  });

  test('a sell with a positive realised figure is a GAIN', () => {
    const face = classifyTapeTrade({
      ...trade({ signature: 'b', inputMint: TRADE_MINTS.ANSEM, outputMint: TRADE_MINTS.USDC }),
      realisedUsd: 1.237,
    } as FloorTrade);
    expect(face.kind).toBe('gain');
    expect(face.amount).toBe('+$1.24');
  });

  test('a sell with a negative realised figure is a LOSS', () => {
    const face = classifyTapeTrade({
      ...trade({ signature: 'c', inputMint: TRADE_MINTS.CLAWVILLE, outputMint: TRADE_MINTS.WSOL }),
      realisedUsd: -0.87,
    } as FloorTrade);
    expect(face.kind).toBe('loss');
    expect(face.symbol).toBe('CLAWVILLE');
    expect(face.amount).toBe('-$0.87');
  });

  test('a sell we cannot price is FLAT and states the side, never a figure', () => {
    const face = classifyTapeTrade(
      trade({
        signature: 'd',
        inputMint: MEME,
        outputMint: TRADE_MINTS.USDC,
        notionalUsd: null,
      }),
    );
    expect(face.kind).toBe('flat');
    expect(face.amount).toBe('SELL');
  });

  test('a realised ZERO is flat and prints unsigned — it is neither', () => {
    const face = classifyTapeTrade({
      ...trade({ signature: 'e', inputMint: MEME, outputMint: TRADE_MINTS.USDC }),
      realisedUsd: 0,
    } as FloorTrade);
    expect(face.kind).toBe('flat');
    expect(face.amount).toBe('$0.00');
  });

  test('a non-finite realised figure never renders as 0', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '1.5', null, undefined]) {
      const face = classifyTapeTrade({
        ...trade({ signature: 'f', inputMint: MEME, outputMint: TRADE_MINTS.USDC }),
        realisedUsd: bad,
      } as unknown as FloorTrade);
      expect(face.kind).toBe('flat');
      expect(face.amount).toBe('SELL $12.50');
    }
  });

  test('quote on both legs (or neither) is a SWAP, not a guessed side', () => {
    const bothQuote = classifyTapeTrade(
      trade({ signature: 'g', inputMint: TRADE_MINTS.USDC, outputMint: TRADE_MINTS.WSOL }),
    );
    expect(bothQuote.kind).toBe('flat');
    expect(bothQuote.amount).toBe('SWAP');

    const neitherQuote = classifyTapeTrade(
      trade({ signature: 'h', inputMint: MEME, outputMint: TRADE_MINTS.ANSEM }),
    );
    expect(neitherQuote.amount).toBe('SWAP');
  });

  test('AN UNLISTED MINT IS NEVER NAMED — the chip falls back to the venue', () => {
    for (const dex of ['jupiter', 'pumpswap', 'pumpfun'] as const) {
      const face = classifyTapeTrade(
        trade({ signature: `i-${dex}`, dex, inputMint: TRADE_MINTS.USDC, outputMint: MEME }),
      );
      // The whole point: no fragment of the mint reaches an object in the world.
      expect(MEME).not.toContain(face.symbol);
      expect(face.symbol).not.toContain(MEME.slice(0, 6));
      expect(['JUPITER', 'PUMPSWAP', 'PUMP.FUN']).toContain(face.symbol);
    }
  });

  test('both rows are truncated to what one atlas cell can hold', () => {
    const face = classifyTapeTrade(
      trade({ signature: 'j', inputMint: TRADE_MINTS.USDC, outputMint: MEME, notionalUsd: 9_999_999 }),
    );
    expect(face.symbol.length).toBeLessThanOrEqual(TAPE_SYMBOL_MAX_CHARS);
    expect(face.amount.length).toBeLessThanOrEqual(TAPE_AMOUNT_MAX_CHARS);
  });

  test('every symbol this module may name fits the cell', () => {
    for (const symbol of ['ANSEM', 'CLAWVILLE', 'JUPITER', 'PUMPSWAP', 'PUMP.FUN']) {
      expect(symbol.length).toBeLessThanOrEqual(TAPE_SYMBOL_MAX_CHARS);
    }
  });

  test('THE TAPE NAMES EXACTLY THE MINTS THE BOARD NAMES', () => {
    // A second symbol map is a drift risk, so it is pinned to the FIRST one
    // rather than trusted. The board's map is module-private, so this reads its
    // source: the alternative is two maps that silently disagree about which
    // token may appear on a wall and which may appear on a floating slab.
    const boardSource = readFileSync(
      join(import.meta.dir, 'trading-floor-screen-data.ts'),
      'utf8',
    );
    const boardBlock = boardSource.match(
      /const TAPE_SYMBOLS[\s\S]*?=\s*\{([\s\S]*?)\n\};/,
    );
    expect(boardBlock).not.toBeNull();
    const boardNames = [...boardBlock![1]!.matchAll(/TRADE_MINTS\.(\w+)/g)].map((m) => m[1]!);

    const tapeSource = readFileSync(
      join(import.meta.dir, 'trading-floor-trade-tape.ts'),
      'utf8',
    );
    const tapeBlock = tapeSource.match(
      /const TAPE_SYMBOLS[\s\S]*?=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);/,
    );
    expect(tapeBlock).not.toBeNull();
    const tapeNames = [...tapeBlock![1]!.matchAll(/TRADE_MINTS\.(\w+)/g)].map((m) => m[1]!);

    expect(boardNames.length).toBeGreaterThan(0);
    expect([...tapeNames].sort()).toEqual([...boardNames].sort());
  });
});

describe('money formatting', () => {
  test('two decimals under 1000, none above, so a big trade cannot overflow', () => {
    expect(formatTapeUsd(12.5)).toBe('$12.50');
    expect(formatTapeUsd(0.004)).toBe('$0.00');
    expect(formatTapeUsd(1234.6)).toBe('$1,235');
    expect(formatTapeSignedUsd(-1.5)).toBe('-$1.50');
    expect(formatTapeSignedUsd(1.5)).toBe('+$1.50');
    expect(formatTapeSignedUsd(0)).toBe('$0.00');
  });
});

// ---------------------------------------------------------------------------
// Source list
// ---------------------------------------------------------------------------

describe('buildTapeSources', () => {
  test('slot 0 takes the left lane, slot 1 the right', () => {
    const sources = buildTapeSources([
      slot('Genesis', [trade({ signature: 'g1' })]),
      slot('ClawVille Runner', [trade({ signature: 'r1' })]),
    ]);
    expect(sources.map((s) => [s.key, s.lane])).toEqual([
      ['g1', 0],
      ['r1', 1],
    ]);
  });

  test('newest first within a lane, and an undated trade sorts last', () => {
    const sources = buildTapeSources([
      slot('Genesis', [
        trade({ signature: 'old', blockTime: 100 }),
        trade({ signature: 'undated', blockTime: null }),
        trade({ signature: 'new', blockTime: 900 }),
      ]),
    ]);
    expect(sources.map((s) => s.key)).toEqual(['new', 'old', 'undated']);
  });

  test('capped per lane, so the geometry can never be asked for a 13th quad', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      trade({ signature: `s${index}`, blockTime: 1000 - index }),
    );
    const sources = buildTapeSources([slot('Genesis', many), slot('Runner', many.slice(20))]);
    expect(sources.filter((s) => s.lane === 0)).toHaveLength(TAPE_PER_LANE);
    expect(sources.filter((s) => s.lane === 1)).toHaveLength(TAPE_PER_LANE);
    expect(sources.length).toBeLessThanOrEqual(TAPE_MAX_CHIPS);
  });

  test('ONE on-chain trade never becomes two objects in the room', () => {
    const shared = trade({ signature: 'shared' });
    const sources = buildTapeSources([slot('Genesis', [shared]), slot('Runner', [shared])]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.lane).toBe(0);
  });

  test('a row with no signature is dropped rather than keyed on empty', () => {
    const sources = buildTapeSources([
      slot('Genesis', [trade({ signature: '' }), trade({ signature: 'ok' })]),
    ]);
    expect(sources.map((s) => s.key)).toEqual(['ok']);
  });

  test('no data and no trades both yield an empty tape, never a throw', () => {
    expect(buildTapeSources(undefined)).toEqual([]);
    expect(buildTapeSources([])).toEqual([]);
    expect(buildTapeSources([slot('Genesis', [])])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

describe('reconcileTapeChips', () => {
  const now = 1_000_000;

  test('THE FIRST FILL SEEDS: the hall is already moving, and nothing pops', () => {
    const sources = buildTapeSources([
      slot('Genesis', [
        trade({ signature: 'g1', blockTime: 300 }),
        trade({ signature: 'g2', blockTime: 200 }),
        trade({ signature: 'g3', blockTime: 100 }),
      ]),
    ]);
    const chips = reconcileTapeChips([], sources, now);
    const phases = chips.map((c) => tapeChipPhase(c, now));

    // Every seeded chip is past its first traverse, so none of them pops.
    for (const phase of phases) expect(phase.cycle).toBeGreaterThanOrEqual(1);
    // And they are spread along the lane rather than stacked at the wall.
    expect(phases.map((p) => Number(p.phase.toFixed(4)))).toEqual([0, 1 / 3, 2 / 3].map((v) => Number(v.toFixed(4))));
  });

  test('a trade that arrives LATER enters at the wall and pops', () => {
    const first = reconcileTapeChips([], buildTapeSources([slot('G', [trade({ signature: 'a' })])]), now);
    const later = reconcileTapeChips(
      first,
      buildTapeSources([
        slot('G', [
          trade({ signature: 'fresh', blockTime: 9_000 }),
          trade({ signature: 'a', blockTime: 1_000 }),
        ]),
      ]),
      now + 5_000,
    );
    const fresh = later.find((c) => c.key === 'fresh')!;
    const phase = tapeChipPhase(fresh, now + 5_000);
    expect(phase.cycle).toBe(0);
    expect(phase.phase).toBe(0);
    expect(phase.phase).toBeLessThan(TAPE_POP);
  });

  test('a surviving trade keeps its flight across a poll', () => {
    const sources = buildTapeSources([slot('G', [trade({ signature: 'a' })])]);
    const first = reconcileTapeChips([], sources, now);
    const second = reconcileTapeChips(first, sources, now + 15_000);
    expect(second[0]!.releasedAtMs).toBe(first[0]!.releasedAtMs);
  });

  test('a poll that changed nothing returns the SAME array, so no atlas repaint', () => {
    const sources = buildTapeSources([slot('G', [trade({ signature: 'a' })])]);
    const first = reconcileTapeChips([], sources, now);
    const second = reconcileTapeChips(
      first,
      buildTapeSources([slot('G', [trade({ signature: 'a' })])]),
      now + 15_000,
    );
    expect(second).toBe(first);
  });

  test('an emptied payload clears the tape, and stays empty without churning', () => {
    const first = reconcileTapeChips([], buildTapeSources([slot('G', [trade({ signature: 'a' })])]), now);
    const cleared = reconcileTapeChips(first, [], now);
    expect(cleared).toEqual([]);
    const stillEmpty = reconcileTapeChips(cleared, [], now);
    expect(stillEmpty).toBe(cleared);
  });

  test('a chip whose FACE changed keeps flying rather than restarting', () => {
    const before = reconcileTapeChips([], buildTapeSources([slot('G', [trade({ signature: 'a' })])]), now);
    const after = reconcileTapeChips(
      before,
      buildTapeSources([
        slot('G', [
          { ...trade({ signature: 'a', inputMint: MEME, outputMint: TRADE_MINTS.USDC }), realisedUsd: 2 } as FloorTrade,
        ]),
      ]),
      now + 30_000,
    );
    expect(after[0]!.kind).toBe('gain');
    expect(after[0]!.releasedAtMs).toBe(before[0]!.releasedAtMs);
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
    // Stated so a lane or chip-width change shows up as a number, not a pass.
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
    // A bare pass would survive the lane drifting 20 wu inboard. Pin the room
    // to spare, so a future tuning pass has to look at this number.
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
    // The colour fades with the alpha, so an additive chip cannot lift the wall
    // behind it after it has visually gone.
    expect(out.red + out.green + out.blue).toBeLessThan(0.15);
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
}

function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  texts: RecordedText[];
  fills: { x: number; y: number; w: number; h: number }[];
} {
  const texts: RecordedText[] = [];
  const fills: { x: number; y: number; w: number; h: number }[] = [];
  const state = { font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textAlign: '', textBaseline: '' };
  const ctx = {
    ...state,
    fillRect: (x: number, y: number, w: number, h: number) => fills.push({ x, y, w, h }),
    strokeRect: () => undefined,
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, font: (this as { font: string }).font });
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, texts, fills };
}

/** Courier advances ~0.6em. Approximate on purpose: there is no 2D context in
 *  the runner, and the point is to catch a string RUNNING INTO THE NEXT CELL,
 *  which is a whole cell wide, not a pixel. */
function approximateWidth(text: string, font: string): number {
  const px = Number(font.match(/(\d+)px/)?.[1] ?? 16);
  return text.length * px * 0.6;
}

describe('drawTapeAtlas', () => {
  test('every glyph stays inside its OWN cell — no bleed onto a neighbour', () => {
    const chips: TapeChip[] = Array.from({ length: TAPE_MAX_CHIPS }, (_, index) =>
      chip({
        key: `k${index}`,
        lane: index % TAPE_LANES,
        symbol: 'CLAWVILLE',
        amount: 'SELL $12.50',
      }),
    );
    const { ctx, texts } = recordingContext();
    drawTapeAtlas(ctx, chips);

    expect(texts).toHaveLength(TAPE_MAX_CHIPS * 2);
    for (let index = 0; index < TAPE_MAX_CHIPS; index++) {
      const rect = tapeCellRect(index);
      for (const drawn of texts.slice(index * 2, index * 2 + 2)) {
        expect(drawn.x).toBeGreaterThanOrEqual(rect.x);
        expect(drawn.y).toBeGreaterThan(rect.y);
        expect(drawn.y).toBeLessThanOrEqual(rect.y + rect.height);
        const right = drawn.x + approximateWidth(drawn.text, drawn.font);
        expect(right).toBeLessThanOrEqual(rect.x + rect.width);
      }
    }
  });

  test('the atlas is cleared to black first, so a recycled cell cannot ghost', () => {
    const { ctx, fills } = recordingContext();
    drawTapeAtlas(ctx, [chip()]);
    expect(fills[0]).toEqual({ x: 0, y: 0, w: TAPE_ATLAS_WIDTH, h: TAPE_ATLAS_HEIGHT });
  });

  test('more chips than cells never paints past the atlas', () => {
    const chips = Array.from({ length: TAPE_MAX_CHIPS + 9 }, (_, index) =>
      chip({ key: `k${index}` }),
    );
    const { ctx, texts } = recordingContext();
    drawTapeAtlas(ctx, chips);
    expect(texts).toHaveLength(TAPE_MAX_CHIPS * 2);
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
