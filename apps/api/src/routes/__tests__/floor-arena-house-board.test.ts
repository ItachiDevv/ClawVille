import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { FLOOR_ARENA_HOUSE_AGENTS } from '@clawville/shared';
import {
  FLOOR_ARENA_HOUSE_BOARD_CACHE_MS,
  createFloorArenaHouseBoardRoutes,
  type FloorArenaHouseBoardRouteDeps,
} from '../floor-arena-house-board';

/**
 * P15 T1: GET /api/floor/arena/house-board (plan §1). Public, no session, 60 requests a minute
 * per IP, a 10 s in-process cache, `Cache-Control: public, max-age=10`.
 * Failing-first tests: written before the route exists.
 */

const NOW = new Date('2026-10-02T12:00:00Z');

function makeDeps(options: { failFirst?: boolean } = {}) {
  let clock = NOW.getTime();
  let fail = options.failFirst === true;
  const hits = { houseAgents: 0, stats: 0, open: 0, signals: 0 };
  const deps: FloorArenaHouseBoardRouteDeps = {
    now: () => new Date(clock),
    readHouseAgents: async () => {
      hits.houseAgents += 1;
      if (fail) {
        fail = false;
        throw new Error('database down');
      }
      return [];
    },
    readStats: async (agentIds) => {
      hits.stats += 1;
      const zero = { realisedUsd: 0, trades: 0, wins: 0, losses: 0, deaths: 0, openPositions: 0, lastTradeAt: null };
      return new Map(agentIds.map((id) => [id, { all: zero, last24h: zero, contest: zero }]));
    },
    readOpenPositions: async () => {
      hits.open += 1;
      return [];
    },
    readSignals: async () => {
      hits.signals += 1;
      return new Map();
    },
  };
  return { deps, hits, advance: (ms: number) => { clock += ms; } };
}

const IP = { 'cf-connecting-ip': '203.0.113.7' };

describe('GET /house-board', () => {
  test('200, public cache header, five agents, no Set-Cookie even with a cookie present', async () => {
    const { deps } = makeDeps();
    const routes = createFloorArenaHouseBoardRoutes(deps);
    const response = await routes.request('/house-board', { headers: { ...IP, Cookie: 'auth_session=not-a-real-session' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=10');
    expect(response.headers.get('set-cookie')).toBeNull();
    const body = await response.json() as { version: number; agents: Array<{ id: string }>; generatedAt: string };
    expect(body.version).toBe(1);
    expect(body.agents.map((agent) => agent.id)).toEqual(FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.id));
    expect(body.generatedAt).toBe(NOW.toISOString());
  });

  test('429 after 60 requests in a minute from one IP; another IP still gets 200', async () => {
    const { deps } = makeDeps();
    const routes = createFloorArenaHouseBoardRoutes(deps);
    for (let index = 0; index < 60; index += 1) {
      expect((await routes.request('/house-board', { headers: IP })).status).toBe(200);
    }
    const limited = await routes.request('/house-board', { headers: IP });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'rate_limited' });
    expect(limited.headers.get('cache-control')).toBeNull();
    expect((await routes.request('/house-board', { headers: { 'cf-connecting-ip': '198.51.100.9' } })).status).toBe(200);
  });

  test('two calls inside 10 s hit the deps once; a call after 10 s reads again', async () => {
    expect(FLOOR_ARENA_HOUSE_BOARD_CACHE_MS).toBe(10_000);
    const { deps, hits, advance } = makeDeps();
    const routes = createFloorArenaHouseBoardRoutes(deps);
    const first = await (await routes.request('/house-board', { headers: IP })).json() as { generatedAt: string };
    advance(9_999);
    const second = await (await routes.request('/house-board', { headers: IP })).json() as { generatedAt: string };
    expect(hits).toEqual({ houseAgents: 1, stats: 1, open: 5, signals: 1 });
    expect(second.generatedAt).toBe(first.generatedAt);
    advance(2);
    await routes.request('/house-board', { headers: IP });
    expect(hits).toEqual({ houseAgents: 2, stats: 2, open: 10, signals: 2 });
  });

  test('two concurrent calls on a cold cache share one read', async () => {
    const { deps, hits } = makeDeps();
    const routes = createFloorArenaHouseBoardRoutes(deps);
    const [a, b] = await Promise.all([
      routes.request('/house-board', { headers: IP }),
      routes.request('/house-board', { headers: IP }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(hits.houseAgents).toBe(1);
    expect(hits.signals).toBe(1);
  });

  test('a failed read is not cached and sends no public cache header', async () => {
    const { deps, hits } = makeDeps({ failFirst: true });
    const routes = createFloorArenaHouseBoardRoutes(deps);
    const failed = await routes.request('/house-board', { headers: IP });
    expect(failed.status).toBe(500);
    expect(failed.headers.get('cache-control')).toBeNull();
    const retried = await routes.request('/house-board', { headers: IP });
    expect(retried.status).toBe(200);
    expect(hits.houseAgents).toBe(2);
  });

  test('mounted before a router with a session-style `use(*)`, the public GET never picks up its cookie', async () => {
    // Mirrors index.ts: the house board is mounted at '/api/floor/arena' BEFORE '/api/floor',
    // whose router registers use('*', sessionMiddleware) at '/api/floor/*'.
    const parent = new Hono();
    const floor = new Hono();
    floor.use('*', async (c, next) => { c.header('Set-Cookie', 'auth_session=refreshed', { append: true }); await next(); });
    floor.get('/state', (c) => c.json({}));
    parent.route('/api/floor/arena', createFloorArenaHouseBoardRoutes(makeDeps().deps));
    parent.route('/api/floor', floor);
    const response = await parent.request('/api/floor/arena/house-board', { headers: IP });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  test('index.ts mounts the house board at /api/floor/arena before the arena router and before /api/floor', () => {
    const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    const board = source.indexOf("app.route('/api/floor/arena', floorArenaHouseBoardRoutes);");
    const arena = source.indexOf("app.route('/api/floor/arena', floorArenaRoutes);");
    const floor = source.indexOf("app.route('/api/floor', tradingFloorRoutes);");
    expect(board).toBeGreaterThan(-1);
    expect(arena).toBeGreaterThan(board);
    expect(floor).toBeGreaterThan(board);
    expect(source).toContain("import { floorArenaHouseBoardRoutes } from './routes/floor-arena-house-board';");
  });
});
