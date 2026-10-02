import { Hono } from 'hono';
import { createRateLimiter, getClientIp, type RateLimiter } from '../middleware/rate-limit';
import {
  buildArenaHouseBoard,
  defaultHouseBoardDeps,
  type ArenaHouseBoardResponse,
  type HouseBoardDeps,
} from '../services/floor-arena/house-board';

/**
 * P15 T1: GET /api/floor/arena/house-board, the five house-agent columns of
 * the Trading Floor big screen (ops/house-traders/arena-review/P15_PLAN_2026-10-02.md §1).
 *
 * Public: no session middleware. index.ts mounts this router at
 * `/api/floor/arena` BEFORE the arena router and BEFORE `/api/floor`, whose
 * `use('*', sessionMiddleware)` can append a Set-Cookie to a public body
 * (the same reason as routes/floor-arena.ts).
 *
 * PARITY (E5): a read only. A human sees it on the board; a connected or hosted
 * agent reads the same JSON. It moves no money and needs no identity.
 *
 * 60 requests a minute per IP. One in-process cache entry for 10 s: calls
 * inside 10 s share one read, and calls that arrive together on a cold cache
 * share one in-flight read. A failed read is not kept.
 */

export const FLOOR_ARENA_HOUSE_BOARD_CACHE_MS = 10_000;
const MAX_AGE_S = 10;

export interface FloorArenaHouseBoardRouteDeps extends HouseBoardDeps {
  now(): Date;
}

export const defaultFloorArenaHouseBoardRouteDeps: FloorArenaHouseBoardRouteDeps = {
  ...defaultHouseBoardDeps,
  now: () => new Date(),
};

export interface FloorArenaHouseBoardRouteOptions {
  /** A fresh limiter per router instance (tests). Default: 60 requests a minute per IP. */
  limiter?: () => RateLimiter;
}

export function createFloorArenaHouseBoardRoutes(
  deps: FloorArenaHouseBoardRouteDeps = defaultFloorArenaHouseBoardRouteDeps,
  options: FloorArenaHouseBoardRouteOptions = {},
) {
  const routes = new Hono();
  const limiter = (options.limiter ?? (() => createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 })))();
  let cached: { expiresAt: number; body: Promise<ArenaHouseBoardResponse> } | null = null;

  function load(now: Date): Promise<ArenaHouseBoardResponse> {
    const nowMs = now.getTime();
    if (cached && cached.expiresAt > nowMs) return cached.body;
    const entry = { expiresAt: nowMs + FLOOR_ARENA_HOUSE_BOARD_CACHE_MS, body: buildArenaHouseBoard(deps, now) };
    cached = entry;
    // A failed read is removed, so the next call reads again.
    entry.body.catch(() => {
      if (cached === entry) cached = null;
    });
    return entry.body;
  }

  routes.get('/house-board', async (c) => {
    if (!limiter.check(getClientIp(c.req.raw.headers))) {
      return c.json({ error: 'Too many requests.', code: 'rate_limited' }, 429);
    }
    const body = await load(deps.now());
    // Set only on success, so an edge never caches an error body.
    c.header('Cache-Control', `public, max-age=${MAX_AGE_S}`);
    return c.json(body);
  });

  return routes;
}

export const floorArenaHouseBoardRoutes = createFloorArenaHouseBoardRoutes();
