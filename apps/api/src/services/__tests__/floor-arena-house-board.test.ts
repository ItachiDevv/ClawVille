import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_HOUSE_AGENTS,
  FLOOR_ARENA_TEMPLATES,
  cloneFloorArenaParams,
  floorArenaTemplateById,
} from '@clawville/shared';
import {
  HOUSE_BOARD_OPEN_MAX,
  HOUSE_BOARD_SCAN_MAX_AGE_MS,
  HOUSE_BOARD_WATCH_MAX_AGE_MS,
  buildArenaHouseBoard,
  houseSignalsSql,
  mapHouseSignalRow,
  type ArenaHouseSignals,
  type HouseBoardDeps,
} from '../floor-arena/house-board';
import type { ArenaAgentRecord, ArenaAgentStats, ArenaPosition } from '../floor-arena/queries';

/**
 * P15 T1: the public house-board payload (plan §1 "New API (task T1), exact shape").
 * Failing-first tests: written before house-board.ts exists.
 */

const NOW = new Date('2026-10-02T12:00:00Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
// A hate-slur ticker the content mask must hide (the same fixture as floor-arena-routes.test.ts).
const SLUR_SYMBOL = 'N.I.G.G.A';
const FORBIDDEN_KEYS = [
  'mint', 'source', 'wallet', 'paymentAddress', 'clawpumpAgentId', 'clawpumpWallet', 'ownerUserId', 'avatarId',
  'addons', 'params', 'entryFeatures', 'provisionState', 'provisionError',
];

function houseRow(id: string, overrides: Partial<ArenaAgentRecord> = {}): ArenaAgentRecord {
  const house = FLOOR_ARENA_HOUSE_AGENTS.find((agent) => agent.id === id)!;
  return {
    id,
    kind: 'house',
    ownerUserId: 'owner-should-never-leak',
    avatarId: 'avatar-should-never-leak',
    name: house.name,
    templateId: house.templateId,
    params: cloneFloorArenaParams(floorArenaTemplateById(house.templateId)!.params),
    paramsVersion: 1,
    mode: 'paper',
    status: 'active',
    seated: true,
    seatIndex: null,
    seatedAt: null,
    clawpumpAgentId: 'cp-agent-should-never-leak',
    clawpumpWallet: 'WalletShouldNeverLeak111111111111111111111',
    provisionState: 'ready',
    provisionError: null,
    provisionAttempts: 0,
    provisionNextAt: null,
    addons: [],
    autoApplySuggestions: false,
    contestId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function stats(realisedUsd: number, trades: number): ArenaAgentStats {
  return { realisedUsd, trades, wins: trades, losses: 0, deaths: 0, openPositions: 0, lastTradeAt: null };
}

let positionSeq = 0;
function position(openedAt: string, symbol: string | null, overrides: Partial<ArenaPosition> = {}): ArenaPosition {
  positionSeq += 1;
  return {
    id: `pos-${positionSeq}`,
    mint: `MintShouldNeverLeak${positionSeq}`,
    symbol,
    source: 'ds:token-profiles',
    openedAt,
    sizeUsd: 20,
    tokens: 1000,
    entryPriceUsd: 0.02,
    entryFillSource: 'quote',
    entryFeatures: { mcap: 1 },
    paramsVersion: 1,
    peakMult: 1.1,
    lastMarkMult: 1.04,
    lastMarkAt: openedAt,
    remainingFraction: 1,
    realisedUsd: 0,
    status: 'open',
    closedAt: null,
    exitReason: null,
    exitFillSource: null,
    pnlUsd: null,
    pnlMult: null,
    ...overrides,
  };
}

interface FakeInput {
  rows?: ArenaAgentRecord[];
  signals?: Map<string, ArenaHouseSignals>;
  open?: Record<string, ArenaPosition[]>;
}

function fakeDeps(input: FakeInput = {}) {
  const openCalls: Array<{ agentId: string; limit: number }> = [];
  const statsCalls: Array<readonly string[]> = [];
  const signalCalls: Array<readonly string[]> = [];
  const deps: HouseBoardDeps = {
    readHouseAgents: async () => input.rows ?? [],
    readStats: async (agentIds) => {
      statsCalls.push(agentIds);
      return new Map(agentIds.map((id, index) => [id, { all: stats(index + 1, 10), last24h: stats(index, 5), contest: stats(index + 0.5, 3) }]));
    },
    readOpenPositions: async (agentId, limit) => {
      openCalls.push({ agentId, limit });
      return input.open?.[agentId] ?? [];
    },
    readSignals: async (agentIds) => {
      signalCalls.push(agentIds);
      return input.signals ?? new Map();
    },
  };
  return { deps, openCalls, statsCalls, signalCalls };
}

function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      collectKeys(item, out);
    }
  }
  return out;
}

describe('house board: five columns in template order', () => {
  test('always 5 agents in FLOOR_ARENA_TEMPLATES order, even when no house row exists', async () => {
    const { deps } = fakeDeps();
    const board = await buildArenaHouseBoard(deps, NOW);
    expect(board.version).toBe(1);
    expect(board.agents).toHaveLength(5);
    expect(board.agents.map((agent) => agent.id)).toEqual(FLOOR_ARENA_TEMPLATES.map((template) => template.houseAgentId));
    expect(board.agents.map((agent) => agent.id)).toEqual(FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.id));
    expect(board.agents.map((agent) => agent.templateId)).toEqual(FLOOR_ARENA_TEMPLATES.map((template) => template.id));
    // Our house name, not masked (the same rule as GET /templates).
    expect(board.agents.map((agent) => agent.name)).toEqual(FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.name));
    expect(board.contest).toEqual({ startsAt: FLOOR_ARENA_CONTEST.startsAt, endsAt: FLOOR_ARENA_CONTEST.endsAt });
    expect(board.generatedAt).toBe(NOW.toISOString());
  });

  test('a missing house row gives nulls, never zeros and never a guessed mode', async () => {
    const { deps } = fakeDeps({ rows: [houseRow('house:genesis'), houseRow('house:runner')] });
    const board = await buildArenaHouseBoard(deps, NOW);
    const dip = board.agents.find((agent) => agent.id === 'house:dip-hunter')!;
    expect(dip.mode).toBeNull();
    expect(dip.status).toBeNull();
    expect(dip.paramsVersion).toBeNull();
    expect(dip.exits).toBeNull();
    expect(dip.scan).toBeNull();
    expect(dip.watching).toBeNull();
    expect(dip.open).toEqual([]);
    const genesis = board.agents.find((agent) => agent.id === 'house:genesis')!;
    expect(genesis.mode).toBe('paper');
    expect(genesis.status).toBe('active');
    expect(genesis.paramsVersion).toBe(1);
  });

  test('mode, status and paramsVersion come from the row', async () => {
    const { deps } = fakeDeps({
      rows: [
        houseRow('house:genesis', { mode: 'live', paramsVersion: 7 }),
        houseRow('house:runner', { mode: 'paper', status: 'paused' }),
        houseRow('house:late-bloomer', { status: 'stopped' }),
      ],
    });
    const board = await buildArenaHouseBoard(deps, NOW);
    const byId = new Map(board.agents.map((agent) => [agent.id, agent]));
    expect(byId.get('house:genesis')!.mode).toBe('live');
    expect(byId.get('house:genesis')!.paramsVersion).toBe(7);
    expect(byId.get('house:runner')!.mode).toBe('paper');
    expect(byId.get('house:runner')!.status).toBe('paused');
    expect(byId.get('house:late-bloomer')!.status).toBe('stopped');
  });

  test('exits are the first TP leg, the stop and the hold time of the LIVE row params', async () => {
    const tuned = cloneFloorArenaParams(floorArenaTemplateById('genesis')!.params);
    tuned.exits.tp = [[1.25, 0.5], [2, 0.5]];
    tuned.exits.stop_mult = 0.85;
    tuned.exits.max_hold_s = 1_200;
    const noTp = cloneFloorArenaParams(floorArenaTemplateById('dip-hunter')!.params);
    noTp.exits.tp = [];
    const { deps } = fakeDeps({
      rows: [houseRow('house:genesis', { params: tuned }), houseRow('house:runner'), houseRow('house:dip-hunter', { params: noTp })],
    });
    const board = await buildArenaHouseBoard(deps, NOW);
    const byId = new Map(board.agents.map((agent) => [agent.id, agent]));
    expect(byId.get('house:genesis')!.exits).toEqual({ tpMult: 1.25, stopMult: 0.85, maxHoldS: 1_200 });
    const runner = floorArenaTemplateById('runner')!.params.exits;
    expect(byId.get('house:runner')!.exits).toEqual({ tpMult: runner.tp[0]![0], stopMult: runner.stop_mult, maxHoldS: runner.max_hold_s });
    expect(byId.get('house:dip-hunter')!.exits).toEqual({
      tpMult: null, stopMult: noTp.exits.stop_mult, maxHoldS: noTp.exits.max_hold_s,
    });
  });

  test('stats are the reader values for all three windows, asked once for the five ids', async () => {
    const { deps, statsCalls } = fakeDeps();
    const board = await buildArenaHouseBoard(deps, NOW);
    expect(statsCalls).toEqual([FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.id)]);
    expect(board.agents[0]!.stats.all.realisedUsd).toBe(1);
    expect(board.agents[1]!.stats.last24h.realisedUsd).toBe(1);
    expect(board.agents[2]!.stats.contest.trades).toBe(3);
  });
});

describe('house board: scanning and watching', () => {
  test('scan newer than 15 min is shown; older is null', async () => {
    expect(HOUSE_BOARD_SCAN_MAX_AGE_MS).toBe(15 * MIN);
    const signals = new Map<string, ArenaHouseSignals>([
      ['house:genesis', {
        scanAt: ago(15 * MIN - 1_000),
        scanData: { evaluated: 412, passed: 3, held: 2, failCounts: { liq: 300 }, top: [['liq', 300], ['mcap', 80]] },
        passAt: null, passSymbol: null,
      }],
      ['house:runner', {
        scanAt: ago(15 * MIN + 1_000),
        scanData: { evaluated: 9, passed: 0, held: 0, failCounts: {}, top: [] },
        passAt: null, passSymbol: null,
      }],
    ]);
    const { deps, signalCalls } = fakeDeps({ rows: [houseRow('house:genesis'), houseRow('house:runner')], signals });
    const board = await buildArenaHouseBoard(deps, NOW);
    expect(signalCalls).toEqual([FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.id)]);
    expect(board.agents[0]!.scan).toEqual({
      at: ago(15 * MIN - 1_000), evaluated: 412, passed: 3, held: 2,
      topSkip: [{ code: 'liq', count: 300 }, { code: 'mcap', count: 80 }],
    });
    expect(board.agents[1]!.scan).toBeNull();
  });

  test('topSkip keeps known fail codes only, and an unreadable scan is null', async () => {
    const signals = new Map<string, ArenaHouseSignals>([
      ['house:genesis', {
        scanAt: ago(MIN),
        scanData: { evaluated: 5, passed: 0, held: 0, top: [['private:secret-feed', 4], ['window', 3], ['<b>x</b>', 2], ['liq', -1]] },
        passAt: null, passSymbol: null,
      }],
      ['house:runner', { scanAt: ago(MIN), scanData: { evaluated: 'many' }, passAt: null, passSymbol: null }],
    ]);
    const { deps } = fakeDeps({ signals });
    const board = await buildArenaHouseBoard(deps, NOW);
    expect(board.agents[0]!.scan!.topSkip).toEqual([{ code: 'window', count: 3 }]);
    expect(board.agents[1]!.scan).toBeNull();
  });

  test('watching newer than 10 min is shown with its symbol; older is null', async () => {
    expect(HOUSE_BOARD_WATCH_MAX_AGE_MS).toBe(10 * MIN);
    const signals = new Map<string, ArenaHouseSignals>([
      ['house:genesis', { scanAt: null, scanData: null, passAt: ago(10 * MIN - 1_000), passSymbol: 'BONK' }],
      ['house:runner', { scanAt: null, scanData: null, passAt: ago(10 * MIN + 1_000), passSymbol: 'WIF' }],
      ['house:dip-hunter', { scanAt: null, scanData: null, passAt: ago(MIN), passSymbol: null }],
    ]);
    const { deps } = fakeDeps({ signals });
    const board = await buildArenaHouseBoard(deps, NOW);
    expect(board.agents[0]!.watching).toEqual({ at: ago(10 * MIN - 1_000), symbol: 'BONK' });
    expect(board.agents[1]!.watching).toBeNull();
    // A pass with no discovery row: the column still says it watches a coin, with no symbol.
    expect(board.agents[2]!.watching).toEqual({ at: ago(MIN), symbol: null });
  });
});

describe('house board: content mask and private fields', () => {
  test('a masked symbol reads *** with masked: true (watching and open); a clean one has no masked key', async () => {
    const signals = new Map<string, ArenaHouseSignals>([
      ['house:genesis', { scanAt: null, scanData: null, passAt: ago(MIN), passSymbol: SLUR_SYMBOL }],
      ['house:runner', { scanAt: null, scanData: null, passAt: ago(MIN), passSymbol: 'BONK' }],
    ]);
    const { deps } = fakeDeps({
      signals,
      open: { 'house:genesis': [position(ago(2 * MIN), SLUR_SYMBOL), position(ago(3 * MIN), 'WIF')] },
    });
    const board = await buildArenaHouseBoard(deps, NOW);
    expect(board.agents[0]!.watching).toEqual({ at: ago(MIN), symbol: '***', masked: true });
    expect(board.agents[1]!.watching).toEqual({ at: ago(MIN), symbol: 'BONK' });
    expect(board.agents[0]!.open[0]).toMatchObject({ symbol: '***', masked: true });
    expect(board.agents[0]!.open[1]!.symbol).toBe('WIF');
    expect('masked' in board.agents[0]!.open[1]!).toBe(false);
    expect(JSON.stringify(board)).not.toContain(SLUR_SYMBOL);
  });

  test('a deep key scan finds no mint, source, wallet, payment address, ClawPump id or owner id', async () => {
    const signals = new Map<string, ArenaHouseSignals>(FLOOR_ARENA_HOUSE_AGENTS.map((house) => [house.id, {
      scanAt: ago(MIN),
      scanData: { evaluated: 1, passed: 1, held: 1, failCounts: { liq: 1 }, top: [['liq', 1]], source: 'private:secret', mint: 'X' },
      passAt: ago(MIN),
      passSymbol: 'BONK',
    }]));
    const open = Object.fromEntries(FLOOR_ARENA_HOUSE_AGENTS.map((house) => [house.id, [position(ago(MIN), 'WIF')]]));
    const { deps } = fakeDeps({ rows: FLOOR_ARENA_HOUSE_AGENTS.map((house) => houseRow(house.id)), signals, open });
    const board = await buildArenaHouseBoard(deps, NOW);
    const keys = collectKeys(board);
    for (const forbidden of FORBIDDEN_KEYS) expect(keys.has(forbidden)).toBe(false);
    const text = JSON.stringify(board);
    expect(text).not.toContain('MintShouldNeverLeak');
    expect(text).not.toContain('WalletShouldNeverLeak');
    expect(text).not.toContain('cp-agent-should-never-leak');
    expect(text).not.toContain('owner-should-never-leak');
    expect(text).not.toContain('private:secret');
    expect(Object.keys(board.agents[0]!.open[0]!).sort()).toEqual(['lastMarkMult', 'openedAt', 'sizeUsd', 'symbol']);
  });
});

describe('house board: open positions', () => {
  test('at most 5, newest first, asked with limit 5', async () => {
    expect(HOUSE_BOARD_OPEN_MAX).toBe(5);
    const shuffled = [
      position(ago(7 * MIN), 'G'), position(ago(1 * MIN), 'A'), position(ago(5 * MIN), 'E'), position(ago(3 * MIN), 'C'),
      position(ago(6 * MIN), 'F'), position(ago(2 * MIN), 'B'), position(ago(4 * MIN), 'D'),
    ];
    const { deps, openCalls } = fakeDeps({ rows: [houseRow('house:genesis')], open: { 'house:genesis': shuffled } });
    const board = await buildArenaHouseBoard(deps, NOW);
    expect(openCalls.map((call) => call.limit)).toEqual([5, 5, 5, 5, 5]);
    expect(openCalls.map((call) => call.agentId)).toEqual(FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.id));
    expect(board.agents[0]!.open.map((item) => item.symbol)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(board.agents[0]!.open[0]).toEqual({ symbol: 'A', openedAt: ago(MIN), sizeUsd: 20, lastMarkMult: 1.04 });
  });
});

describe('house board: the newest scan + pass SQL read', () => {
  test('one LATERAL read per agent on (agent_id, id desc), with the discovery symbol join', () => {
    const query = new PgDialect().sqlToQuery(houseSignalsSql(['house:genesis', 'house:runner'], new Date(NOW.getTime() - 17 * MIN)));
    const text = query.sql.replace(/\s+/g, ' ');
    expect(text).toContain('LEFT JOIN LATERAL');
    expect(text.match(/ORDER BY e\.id DESC LIMIT 1/g)).toHaveLength(2);
    expect(text).toContain("e.type = 'scan'");
    expect(text).toContain("e.type = 'pass'");
    expect(text).toContain('LEFT JOIN floor_discovery_mints d ON d.mint = p.mint');
    expect(text).not.toContain('SELECT *');
    expect(query.params).toContain('house:genesis');
    expect(query.params).toContain('house:runner');
  });

  test('a row maps to the signal shape: jsonb text parsed, symbol sanitised, no mint kept', () => {
    const signal = mapHouseSignalRow({
      agent_id: 'house:genesis',
      scan_at: new Date(NOW.getTime() - MIN),
      scan_data: JSON.stringify({ evaluated: 3, passed: 1, held: 0, top: [] }),
      pass_at: NOW.toISOString(),
      pass_symbol: 'BO NK​🚀',
    });
    expect(signal).toEqual({
      scanAt: ago(MIN),
      scanData: { evaluated: 3, passed: 1, held: 0, top: [] },
      passAt: NOW.toISOString(),
      passSymbol: 'BONK',
    });
    expect(mapHouseSignalRow({ agent_id: 'house:runner', scan_at: null, scan_data: null, pass_at: null, pass_symbol: null })).toEqual({
      scanAt: null, scanData: null, passAt: null, passSymbol: null,
    });
  });
});
