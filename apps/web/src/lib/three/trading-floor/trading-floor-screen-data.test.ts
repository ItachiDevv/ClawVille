import { describe, expect, test } from 'bun:test';

import {
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_HOUSE_AGENTS,
  FLOOR_ARENA_MAX_OPEN_POSITIONS,
  FLOOR_ARENA_PAPER_COSTS,
  FLOOR_ARENA_PARAM_BOUNDS,
  FLOOR_ARENA_POSITION_USD,
  FLOOR_ARENA_TEMPLATES,
} from '@clawville/shared';

import { readHouseBoard } from '@/hooks/use-floor-arena-house-board';
import {
  buildFloorScreenData,
  contestCountdownLabel,
  floorClockLabel,
  floorScreenSignature,
  type ArenaQueryInput,
  type FloorScreenInputs,
} from './trading-floor-screen-data';
import {
  drawFloorScreen,
  FLOOR_SCREEN_COLUMNS,
  type FloorScreenContext,
} from './trading-floor-screen-texture';

// P15 T2 (ops/house-traders/arena-review/P15_PLAN_2026-10-02.md §1 + §6): the
// data half of the five-column board. Failing-first tests. Inputs are the T1
// hook's view (`readHouseBoard`) and the existing contest hook's view, so the
// board is tested against the shapes the component really passes in.

const NOW = Date.parse('2026-10-01T12:00:00.000Z'); // inside the contest window
const BEFORE = Date.parse('2026-09-30T18:00:00.000Z');
const AFTER = Date.parse('2026-10-06T00:00:00.000Z');
const MINT = '7xKXtg2CW3eTA1hqzVfKp8mKQqZ9rPfLmNbVcXyZaQw1';
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const ready = (data: unknown): ArenaQueryInput => ({ data, isLoading: false, isError: false });
const LOADING: ArenaQueryInput = { data: undefined, isLoading: true, isError: false };
const failed = (data?: unknown): ArenaQueryInput => ({ data, isLoading: false, isError: true });

function stats(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { realisedUsd: 0, trades: 0, wins: 0, losses: 0, deaths: 0, openPositions: 0, lastTradeAt: null, ...overrides };
}

/** One house agent as GET /api/floor/arena/house-board sends it (plan §1). */
function wireAgent(houseId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const house = FLOOR_ARENA_HOUSE_AGENTS.find((h) => h.id === houseId)!;
  return {
    id: house.id,
    name: house.name,
    templateId: house.templateId,
    mode: 'paper',
    status: 'active',
    paramsVersion: 1,
    exits: { tpMult: 1.1, stopMult: null, maxHoldS: 900 },
    stats: {
      all: stats({ realisedUsd: -40, trades: 30, wins: 10, losses: 20 }),
      last24h: stats({ realisedUsd: -1.5, trades: 3, wins: 1, losses: 2, lastTradeAt: minutesAgo(30) }),
      contest: stats({ realisedUsd: 7.77, trades: 17, wins: 7, losses: 10, lastTradeAt: minutesAgo(30) }),
    },
    scan: { at: minutesAgo(2), evaluated: 412, passed: 3, held: 1, topSkip: [{ code: 'liq', count: 300 }, { code: 'age', count: 50 }] },
    watching: { at: minutesAgo(1), symbol: 'BONK' },
    open: [
      { symbol: 'BONK', openedAt: minutesAgo(5), sizeUsd: 20, lastMarkMult: 1.04 },
      { symbol: 'WIF', openedAt: minutesAgo(9), sizeUsd: 20, lastMarkMult: 0.97 },
    ],
    ...overrides,
  };
}

function wireBody(
  agentOverrides: Record<string, Record<string, unknown>> = {},
  bodyOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    agents: FLOOR_ARENA_HOUSE_AGENTS.map((house) => wireAgent(house.id, agentOverrides[house.id])),
    contest: { startsAt: FLOOR_ARENA_CONTEST.startsAt, endsAt: FLOOR_ARENA_CONTEST.endsAt },
    generatedAt: '2026-10-01T12:00:00.000Z',
    ...bodyOverrides,
  };
}

/** The view the T1 hook hands the component. */
const view = (agentOverrides: Record<string, Record<string, unknown>> = {}, bodyOverrides: Record<string, unknown> = {}) =>
  readHouseBoard(wireBody(agentOverrides, bodyOverrides));

/** The contest hook's view (`use-floor-arena.ts` `readContest`). */
function contestView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contest: {
      name: FLOOR_ARENA_CONTEST.name,
      startsAt: FLOOR_ARENA_CONTEST.startsAt,
      endsAt: FLOOR_ARENA_CONTEST.endsAt,
      prizes: FLOOR_ARENA_CONTEST.prizes.map((prize) => ({ ...prize })),
    },
    status: 'live',
    standings: null,
    openWindowPositions: null,
    top: [],
    house: [],
    ...overrides,
  };
}

function inputs(overrides: Partial<FloorScreenInputs> = {}): FloorScreenInputs {
  return { houseBoard: ready(view()), contest: ready(contestView()), ...overrides };
}

function recorder() {
  const painted: Array<{ value: string; x: number; y: number; font: string }> = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    globalAlpha: 1,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    fillText: (value: string, x: number, y: number) => {
      painted.push({ value, x, y, font: context.font });
    },
  };
  return { context: context as unknown as FloorScreenContext, painted };
}

const SIZE = { width: 1024, height: 313 } as const;

/** Draw what the data layer built, and return every string. */
function drawn(payload: FloorScreenInputs, nowMs = NOW) {
  const rec = recorder();
  drawFloorScreen(rec.context, buildFloorScreenData(payload, nowMs), SIZE);
  return rec.painted;
}

/** The strings of column `index`, top to bottom (centred lines and pill pairs). */
function columnLines(payload: FloorScreenInputs, index: number, nowMs = NOW): string[] {
  const width = SIZE.width / FLOOR_SCREEN_COLUMNS;
  return drawn(payload, nowMs)
    .filter((p) => p.y > 36 && p.y < SIZE.height - 28)
    .filter((p) => {
      const px = Number(/(\d+)px/.exec(p.font)?.[1]);
      // Pill pairs are left-aligned from inside the column; centred lines sit on the centre.
      return p.x >= index * width && p.x < (index + 1) * width && px > 0;
    })
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((p) => p.value);
}

function footer(payload: FloorScreenInputs, nowMs = NOW): string {
  return drawn(payload, nowMs).find((p) => p.y >= SIZE.height - 28)?.value ?? '';
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

describe('Trading Floor board data — the five house-agent columns', () => {
  test('five columns, in house-agent order, which is the template order', () => {
    expect(FLOOR_ARENA_HOUSE_AGENTS.map((h) => h.templateId)).toEqual(FLOOR_ARENA_TEMPLATES.map((t) => t.id));
    const data = buildFloorScreenData(inputs(), NOW);
    expect(data.phase).toBe('ready');
    expect(data.columns.map((c) => c.templateId)).toEqual(FLOOR_ARENA_TEMPLATES.map((t) => t.id));
    expect(data.columns.map((c) => c.name)).toEqual(FLOOR_ARENA_HOUSE_AGENTS.map((h) => h.name));
  });

  test('a column carries exactly what the board draws, read from the T1 view', () => {
    const data = buildFloorScreenData(inputs(), NOW);
    expect(data.columns[0]).toEqual({
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
      realisedUsd: 7.77,
      wins: 7,
      losses: 10,
    });
    expect(columnLines(inputs(), 0)).toEqual([
      'GENESIS',
      'PAPER',
      'ACTIVE',
      'BUSIEST YOUNG',
      'TP +10% 15M',
      '3/412 OK',
      'WATCH BONK',
      'OPEN 2 OF 5',
      'BONK 1.04X',
      '+$7.77',
    ]);
  });

  test('the column order comes from the house list, not from the wire order', () => {
    const body = wireBody();
    const reversed = { ...body, agents: [...(body.agents as unknown[])].reverse() };
    const data = buildFloorScreenData(inputs({ houseBoard: ready(reversed) }), NOW);
    expect(data.columns.map((c) => c.templateId)).toEqual(FLOOR_ARENA_TEMPLATES.map((t) => t.id));
  });

  test('no player row, no rank, no prize: the board data has none of those fields', () => {
    const data = buildFloorScreenData(inputs(), NOW);
    expect(Object.keys(data).sort()).toEqual(
      ['basis', 'clockLabel', 'columns', 'countdownLabel', 'phase', 'tape', 'window'].sort(),
    );
    const joined = drawn(inputs()).map((p) => p.value).join(' | ');
    for (const gone of ['#1', 'PRIZES', '$CLAWVILLE', 'NOT ELIGIBLE', 'TRADING ARENA WEEK 1']) {
      expect({ gone, present: joined.includes(gone) }).toEqual({ gone, present: false });
    }
  });

  // Lead decision: a missing row prints N/A or "-", never zeros.
  test('a house agent the wire did not send keeps its name and prints N/A or "-", never zeros', () => {
    const body = wireBody();
    const withoutRunner = { ...body, agents: (body.agents as Array<{ id: string }>).filter((a) => a.id !== 'house:runner') };
    const payload = inputs({ houseBoard: ready(readHouseBoard(withoutRunner)) });
    const data = buildFloorScreenData(payload, NOW);
    expect(data.columns[1]).toEqual({
      name: 'Runner',
      templateId: 'runner',
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
    });
    expect(columnLines(payload, 1)).toEqual(['RUNNER', 'N/A', 'NEW, HOT, CALM', 'EXITS N/A', '-', '-', 'OPEN - OF 5', '-', '-']);
  });

  test('a masked or unreadable symbol prints COIN', () => {
    const payload = inputs({
      houseBoard: ready(
        view({
          'house:genesis': {
            watching: { at: minutesAgo(1), symbol: '***', masked: true },
            open: [{ symbol: '***', masked: true, openedAt: minutesAgo(5), sizeUsd: 20, lastMarkMult: 1.04 }],
          },
          'house:runner': {
            watching: { at: minutesAgo(1), symbol: MINT },
            open: [{ symbol: '$500', openedAt: minutesAgo(5), sizeUsd: 20, lastMarkMult: 1.2 }],
          },
          'house:dip-hunter': {
            watching: { at: minutesAgo(1), symbol: null },
            open: [{ symbol: '1.5M', openedAt: minutesAgo(5), sizeUsd: 20, lastMarkMult: 1 }],
          },
          'house:midcap-climber': {
            watching: { at: minutesAgo(1), symbol: 'ABCDEFGHIJKL' },
            open: [{ symbol: 'POPCAT', openedAt: minutesAgo(5), sizeUsd: 20, lastMarkMult: null }],
          },
        }),
      ),
    });
    const data = buildFloorScreenData(payload, NOW);
    expect(data.columns.map((c) => c.watching?.symbol)).toEqual(['COIN', 'COIN', 'COIN', 'ABCDEFGH', 'BONK']);
    expect(data.columns.map((c) => c.newest?.symbol)).toEqual(['COIN', 'COIN', 'COIN', 'POPCAT', 'BONK']);
    expect(columnLines(payload, 0)[6]).toBe('WATCH COIN');
    expect(columnLines(payload, 0)[8]).toBe('COIN 1.04X');
    expect(columnLines(payload, 3)[8]).toBe('POPCAT N/A');
    expect(drawn(payload).map((p) => p.value).join(' ')).not.toContain('***');
  });

  test('no scan in the last 15 minutes reads NO RECENT SCAN; a skip shows the top code word', () => {
    const payload = inputs({
      houseBoard: ready(view({ 'house:genesis': { scan: null }, 'house:runner': { watching: null } })),
    });
    expect(columnLines(payload, 0)[5]).toBe('NO RECENT SCAN');
    expect(columnLines(payload, 0)[6]).toBe('WATCH BONK');
    expect(columnLines(payload, 1)[6]).toBe('SKIP LIQUIDITY');
  });

  test('the exit rule comes from the LIVE params; a value outside the bounds is unreadable', () => {
    const exitsOf = (exits: unknown) =>
      buildFloorScreenData(inputs({ houseBoard: ready(view({ 'house:genesis': { exits } })) }), NOW).columns[0]!.exits;
    const tp = FLOOR_ARENA_PARAM_BOUNDS.exits.tp_multiple;
    const stop = FLOOR_ARENA_PARAM_BOUNDS.exits.stop_mult;
    const hold = FLOOR_ARENA_PARAM_BOUNDS.exits.max_hold_s;
    expect(exitsOf({ tpMult: tp.min, stopMult: stop.max, maxHoldS: hold.min })).toEqual({ tpMult: 1.01, stopMult: 0.99, maxHoldS: 60 });
    expect(exitsOf({ tpMult: tp.max, stopMult: stop.min, maxHoldS: hold.max })).toEqual({ tpMult: 10, stopMult: 0.3, maxHoldS: 86_400 });
    const out = exitsOf({ tpMult: 10.5, stopMult: 0.29, maxHoldS: 59 })!;
    expect([out.tpMult, out.stopMult, out.maxHoldS].every((v) => Number.isNaN(v))).toBe(true);
    expect(exitsOf({ tpMult: null, stopMult: null, maxHoldS: 900 })).toEqual({ tpMult: null, stopMult: null, maxHoldS: 900 });
    expect(exitsOf(null)).toBeNull();
    const tuned = inputs({ houseBoard: ready(view({ 'house:dip-hunter': { exits: { tpMult: 1.08, stopMult: 0.9, maxHoldS: 7_200 } } })) });
    expect(columnLines(tuned, 2)[4]).toBe('TP +8% SL -10%');
  });

  test('the open count reads OF FLOOR_ARENA_MAX_OPEN_POSITIONS', () => {
    const data = buildFloorScreenData(inputs(), NOW);
    expect(data.basis.maxOpen).toBe(FLOOR_ARENA_MAX_OPEN_POSITIONS);
    const none = inputs({ houseBoard: ready(view({ 'house:genesis': { open: [] } })) });
    expect(columnLines(none, 0).slice(7, 9)).toEqual([`OPEN 0 OF ${FLOOR_ARENA_MAX_OPEN_POSITIONS}`, 'NO OPEN TRADE']);
  });

  test('the method numbers come from the engine constants, not from a second copy', () => {
    expect(buildFloorScreenData(inputs(), NOW).basis).toEqual({
      positionUsd: FLOOR_ARENA_POSITION_USD,
      buyCostPct: FLOOR_ARENA_PAPER_COSTS.buy_haircut_pct,
      sellCostPct: FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct,
      maxOpen: FLOOR_ARENA_MAX_OPEN_POSITIONS,
    });
  });

  test('NaN and non-number figures print N/A or "-", never a made-up number', () => {
    const payload = inputs({
      houseBoard: ready({
        ...view(),
        agents: view().agents.map((agent, index) =>
          index === 0
            ? {
                ...agent,
                stats: { ...agent.stats, contest: { ...agent.stats.contest, realisedUsd: Number.NaN, wins: Number.NaN } },
                scan: agent.scan && { ...agent.scan, evaluated: '412' as unknown as number },
              }
            : agent,
        ),
      }),
    });
    const column = buildFloorScreenData(payload, NOW).columns[0]!;
    expect(Number.isNaN(column.realisedUsd)).toBe(true);
    expect(Number.isNaN(column.scan!.evaluated)).toBe(true);
    const lines = columnLines(payload, 0);
    expect(lines[9]).toBe('N/A');
    expect(lines[5]).toBe('3/- OK');
    expect(lines.join(' ')).not.toMatch(/NAN/i);
  });
});

// ---------------------------------------------------------------------------
// The window: contest while it runs, else 24h, by the clock
// ---------------------------------------------------------------------------

describe('Trading Floor board data — the P&L window and the contest window', () => {
  test('P&L is the contest window while the contest runs, else the last 24 hours', () => {
    const during = buildFloorScreenData(inputs(), NOW);
    expect(during.window).toBe('contest');
    expect([during.columns[0]!.realisedUsd, during.columns[0]!.wins, during.columns[0]!.losses]).toEqual([7.77, 7, 10]);
    for (const at of [BEFORE, AFTER]) {
      const outside = buildFloorScreenData(inputs(), at);
      expect(outside.window).toBe('24h');
      expect([outside.columns[0]!.realisedUsd, outside.columns[0]!.wins, outside.columns[0]!.losses]).toEqual([-1.5, 1, 2]);
    }
    const start = Date.parse(FLOOR_ARENA_CONTEST.startsAt);
    const end = Date.parse(FLOOR_ARENA_CONTEST.endsAt);
    expect(buildFloorScreenData(inputs(), start).window).toBe('contest');
    expect(buildFloorScreenData(inputs(), end).window).toBe('contest');
    expect(buildFloorScreenData(inputs(), end + 1).window).toBe('24h');
    expect(buildFloorScreenData(inputs(), start - 1).window).toBe('24h');
    // A clock the board cannot trust is not "inside the contest".
    expect(buildFloorScreenData(inputs(), Number.NaN).window).toBe('24h');
  });

  test('the footer names the same window the figures are from', () => {
    expect(footer(inputs(), NOW)).toEndWith('P&L = REALISED, CONTEST');
    expect(footer(inputs(), AFTER)).toEndWith('P&L = REALISED, 24H');
    expect(columnLines(inputs(), 0, AFTER)[9]).toBe('-$1.50');
  });

  // Lead decision: one window, from the house-board data first (the server
  // computed `stats.contest` over it), the contest hook as the fallback.
  test('the contest window comes from the house board first, the contest hook second', () => {
    const shiftedEnd = '2026-10-01T12:30:00.000Z';
    const own = inputs({
      houseBoard: ready(view({}, { contest: { startsAt: FLOOR_ARENA_CONTEST.startsAt, endsAt: shiftedEnd } })),
    });
    expect(buildFloorScreenData(own, NOW).countdownLabel).toBe('ENDS IN 30M');
    expect(buildFloorScreenData(own, Date.parse(shiftedEnd) + 60_000).window).toBe('24h');
    const fallback = inputs({ houseBoard: ready(view({}, { contest: null })) });
    expect(buildFloorScreenData(fallback, NOW).countdownLabel).toBe('ENDS IN 3D 15H 59M');
    expect(buildFloorScreenData(fallback, NOW).window).toBe('contest');
    const neither = inputs({ houseBoard: ready(view({}, { contest: null })), contest: ready(contestView({ contest: null })) });
    expect(buildFloorScreenData(neither, NOW).countdownLabel).toBeNull();
    expect(buildFloorScreenData(neither, NOW).window).toBe('24h');
    // Before the first house-board data the header still counts down from the contest hook.
    expect(buildFloorScreenData(inputs({ houseBoard: LOADING }), NOW).countdownLabel).toBe('ENDS IN 3D 15H 59M');
    // A flattened contest view reads the same.
    const flat = inputs({ houseBoard: ready(view({}, { contest: null })), contest: ready({ ...FLOOR_ARENA_CONTEST }) });
    expect(buildFloorScreenData(flat, NOW).countdownLabel).toBe('ENDS IN 3D 15H 59M');
  });

  // Lead decision: the countdown keeps its minutes.
  test('the countdown keeps minutes, floors, and is null for a guessed time', () => {
    const start = Date.parse(FLOOR_ARENA_CONTEST.startsAt);
    const end = Date.parse(FLOOR_ARENA_CONTEST.endsAt);
    expect(contestCountdownLabel(start, end, Date.parse('2026-09-30T18:47:30.000Z'))).toBe('STARTS IN 3H 12M');
    expect(contestCountdownLabel(start, end, NOW)).toBe('ENDS IN 3D 15H 59M');
    expect(contestCountdownLabel(start, end, end - 45 * 60_000)).toBe('ENDS IN 45M');
    expect(contestCountdownLabel(start, end, end - (26 * 60 + 3) * 60_000)).toBe('ENDS IN 1D 02H 03M');
    expect(contestCountdownLabel(start, end, end - 3_599_000)).toBe('ENDS IN 59M');
    expect(contestCountdownLabel(start, end, end - 30_000)).toBe('ENDS IN UNDER 1M');
    expect(contestCountdownLabel(start, end, end + 1)).toBe('CONTEST ENDED');
    expect(contestCountdownLabel(null, end, NOW)).toBeNull();
    expect(contestCountdownLabel(end, start, NOW)).toBeNull();
    for (const hostile of [Number.NaN, 1e20, 8.64e15, -1]) expect(contestCountdownLabel(start, end, hostile)).toBeNull();
    const broken = inputs({
      houseBoard: ready(view({}, { contest: { startsAt: FLOOR_ARENA_CONTEST.startsAt, endsAt: '+275760-09-13T00:00:00.000Z' } })),
      contest: ready(contestView({ contest: null })),
    });
    expect(buildFloorScreenData(broken, NOW).countdownLabel).toBeNull();
  });

  test('the header clock is UTC, minute resolution, and says CLOCK OFFLINE when unusable', () => {
    expect(floorClockLabel(Date.parse('2026-09-19T14:32:45.000Z'))).toBe('14:32 UTC');
    expect(floorClockLabel(Date.parse('2026-09-19T00:05:00.000Z'))).toBe('00:05 UTC');
    expect(floorClockLabel(4102444799999)).toBe('23:59 UTC');
    for (const hostile of [Number.NaN, Number.POSITIVE_INFINITY, 1e20, 8.64e15, 253402300800000, 4102444800000, 0, -1]) {
      expect(() => floorClockLabel(hostile)).not.toThrow();
      expect(floorClockLabel(hostile)).toBe('CLOCK OFFLINE');
    }
  });

  test('a hostile clock cannot blank the board or paint NaN on it', () => {
    for (const hostile of [Number.NaN, 1e20, 8.64e15, -62167219200001]) {
      expect(() => buildFloorScreenData(inputs(), hostile)).not.toThrow();
      const data = buildFloorScreenData(inputs(), hostile);
      expect(data.clockLabel).toBe('CLOCK OFFLINE');
      expect(data.countdownLabel).toBeNull();
      expect(drawn(inputs(), hostile).map((p) => p.value).join(' | ')).not.toMatch(/NAN/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Phases and the last good data
// ---------------------------------------------------------------------------

describe('Trading Floor board data — phases', () => {
  test('loading and a never-answered error are their own phases, never an empty grid', () => {
    expect(buildFloorScreenData(inputs({ houseBoard: LOADING }), NOW).phase).toBe('connecting');
    expect(buildFloorScreenData(inputs({ houseBoard: LOADING }), NOW).columns).toEqual([]);
    expect(buildFloorScreenData(inputs({ houseBoard: failed() }), NOW).phase).toBe('error');
    expect(drawn(inputs({ houseBoard: failed() })).map((p) => p.value)).toContain('ARENA DATA UNAVAILABLE');
  });

  test('a failed refetch keeps the last good columns, and costs no redraw', () => {
    const good = inputs();
    const failedAfterData = inputs({ houseBoard: failed(view()) });
    expect(buildFloorScreenData(failedAfterData, NOW)).toEqual(buildFloorScreenData(good, NOW));
    expect(floorScreenSignature(failedAfterData)).toBe(floorScreenSignature(good));
    // A failed contest refetch keeps its last window too.
    expect(floorScreenSignature(inputs({ contest: failed(contestView()) }))).toBe(floorScreenSignature(good));
  });
});

// ---------------------------------------------------------------------------
// Redraw signature
// ---------------------------------------------------------------------------

describe('Trading Floor board data — redraw signature', () => {
  test('does NOT change when a refetch returns the same board', () => {
    expect(floorScreenSignature(inputs())).toBe(floorScreenSignature(inputs()));
  });

  // The load-bearing exclusion: generatedAt and every event `at` move on
  // every poll; letting one in is a full redraw plus a texture upload per poll.
  test('ignores generatedAt, event times and every field the board does not draw', () => {
    const later = (m: number) => new Date(NOW + m * 60_000).toISOString();
    const moved = inputs({
      houseBoard: ready(
        view(
          {
            'house:genesis': {
              paramsVersion: 4,
              scan: { at: later(3), evaluated: 412, passed: 3, held: 9, topSkip: [{ code: 'liq', count: 1 }] },
              watching: { at: later(2), symbol: 'BONK' },
              open: [
                { symbol: 'BONK', openedAt: later(1), sizeUsd: 19, lastMarkMult: 1.04 },
                { symbol: 'WIF', openedAt: later(1), sizeUsd: 21, lastMarkMult: 0.5 },
              ],
              stats: {
                all: stats({ realisedUsd: 999, trades: 999 }),
                last24h: stats({ realisedUsd: -1.5, trades: 99, wins: 1, losses: 2, deaths: 4, openPositions: 3, lastTradeAt: later(1) }),
                contest: stats({ realisedUsd: 7.77, trades: 99, wins: 7, losses: 10, deaths: 4, openPositions: 3, lastTradeAt: later(1) }),
              },
            },
          },
          { generatedAt: later(9) },
        ),
      ),
      contest: ready(contestView({ status: 'ended', openWindowPositions: 3, top: [{ rank: 1 }] })),
    });
    expect(floorScreenSignature(moved)).toBe(floorScreenSignature(inputs()));
  });

  test('changes when anything a column draws changes, in either P&L window', () => {
    const base = floorScreenSignature(inputs());
    const changes: Array<Record<string, unknown>> = [
      { name: 'Genesis II' },
      { mode: 'live' },
      { status: 'paused' },
      { exits: { tpMult: 1.2, stopMult: null, maxHoldS: 900 } },
      { exits: { tpMult: 1.1, stopMult: 0.9, maxHoldS: 900 } },
      { exits: { tpMult: 1.1, stopMult: null, maxHoldS: 1_800 } },
      { scan: { at: minutesAgo(2), evaluated: 413, passed: 3, held: 1, topSkip: [{ code: 'liq', count: 300 }] } },
      { scan: { at: minutesAgo(2), evaluated: 412, passed: 4, held: 1, topSkip: [{ code: 'liq', count: 300 }] } },
      { scan: { at: minutesAgo(2), evaluated: 412, passed: 3, held: 1, topSkip: [{ code: 'age', count: 300 }] } },
      { scan: null },
      { watching: { at: minutesAgo(1), symbol: 'WIF' } },
      { watching: null },
      { open: [{ symbol: 'BONK', openedAt: minutesAgo(5), sizeUsd: 20, lastMarkMult: 1.05 }] },
      { open: [] },
      { stats: { all: stats(), last24h: stats({ realisedUsd: -1.5, wins: 1, losses: 2 }), contest: stats({ realisedUsd: 7.78, wins: 7, losses: 10 }) } },
      { stats: { all: stats(), last24h: stats({ realisedUsd: -1.6, wins: 1, losses: 2 }), contest: stats({ realisedUsd: 7.77, wins: 7, losses: 10 }) } },
      { stats: { all: stats(), last24h: stats({ realisedUsd: -1.5, wins: 1, losses: 3 }), contest: stats({ realisedUsd: 7.77, wins: 7, losses: 10 }) } },
    ];
    for (const change of changes) {
      const moved = floorScreenSignature(inputs({ houseBoard: ready(view({ 'house:genesis': change })) }));
      expect({ change, moved: moved !== base }).toEqual({ change, moved: true });
    }
    const window = floorScreenSignature(
      inputs({ houseBoard: ready(view({}, { contest: { startsAt: FLOOR_ARENA_CONTEST.startsAt, endsAt: '2026-10-02T00:00:00Z' } })) }),
    );
    expect(window).not.toBe(base);
  });

  test('an unreadable figure and an absent one are different signatures (N/A against -)', () => {
    const at = (realisedUsd: unknown) =>
      floorScreenSignature({
        houseBoard: ready({
          ...view(),
          agents: view().agents.map((a, i) =>
            i === 0 ? { ...a, stats: { ...a.stats, contest: { ...a.stats.contest, realisedUsd } } } : a,
          ),
        }),
        contest: ready(contestView()),
      });
    expect(at(Number.NaN)).not.toBe(at(null));
  });

  test('loading, error and ready have their own signatures', () => {
    expect(
      new Set([
        floorScreenSignature(inputs({ houseBoard: LOADING })),
        floorScreenSignature(inputs({ houseBoard: failed() })),
        floorScreenSignature(inputs()),
      ]).size,
    ).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Compatibility: the room owner's decor test still reads `.tape` (request W5)
// ---------------------------------------------------------------------------

describe('Trading Floor board data — the tape field kept for the decor test', () => {
  const tapeRow = (overrides: Record<string, unknown> = {}) => ({
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
    ...overrides,
  });

  test('the legacy call shape still returns today\'s tape lines', () => {
    const query = (data: unknown) => ({ data, isLoading: false, isError: false });
    const data = buildFloorScreenData(
      {
        leaderboard: query({ rows: [] }),
        contest: query(null),
        tape: query({
          items: [
            tapeRow(),
            tapeRow({ id: 'x1', type: 'exit', side: 'sell', agentName: 'Runner', symbol: 'WIF', pnlUsd: 2.144, at: minutesAgo(12) }),
          ],
        }),
      },
      NOW,
    );
    expect(data.tape).toEqual(['GENESIS BUY BONK $20.00 4M', 'RUNNER SELL WIF +$2.14 12M']);
    expect(data.phase).toBe('connecting');
  });

  test('the tape is bounded to 12, never drawn, and never repaints the board', () => {
    const many = Array.from({ length: 40 }, (_unused, i) => tapeRow({ id: `t${i}`, at: minutesAgo(i + 1) }));
    const withTape = inputs({ tape: ready(many) });
    expect(buildFloorScreenData(withTape, NOW).tape).toHaveLength(12);
    expect(buildFloorScreenData(inputs(), NOW).tape).toEqual([]);
    expect(floorScreenSignature(withTape)).toBe(floorScreenSignature(inputs()));
    expect(drawn(withTape).map((p) => p.value).join(' | ')).not.toContain('BUY BONK $20.00');
  });
});
