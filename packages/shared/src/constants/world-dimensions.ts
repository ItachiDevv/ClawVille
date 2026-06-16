// ---------------------------------------------------------------------------
// World dimensions — SINGLE SOURCE OF TRUTH for the spawn / center coordinates
// shared by the web client, the API, and the DB schema (via comment-pinned
// literals — see packages/database/src/schema/avatars.ts).
// ---------------------------------------------------------------------------
//
// WHY THIS FILE EXISTS (S3, 2026-06-16)
// -------------------------------------
// Land Phase 0 re-centered the CLIENT world from a 5120-px map (center 2560) to
// an 18432-px map (center 9216). The client spawn was updated in lockstep
// (`apps/web/src/stores/game.ts` + `apps/web/src/lib/pixi/tilemap-data.ts`),
// but the SERVER side was NOT: `avatars.position_x/y` still defaulted to 2560,
// the `/api/avatars/me` PATCH validator still rejected anything > 5120, and
// `apps/api/src/routes/world.ts` still spawned guests at (2560, 2560). The
// result was a logged-in player restoring a stale/corner-ward position on the
// new world. The fix makes the server + DB agree with the client via ONE shared
// constant so the value can never drift again.
//
// THESE MUST EQUAL the web client's `tilemap-data.ts` values:
//   WORLD_PX_WIDTH  === MAP_WIDTH  (= MAP_COLS 576 * TILE_SIZE 32 = 18432)
//   WORLD_PX_HEIGHT === MAP_HEIGHT (= MAP_ROWS 576 * TILE_SIZE 32 = 18432)
//   SPAWN_PX        === { x: MAP_WIDTH/2, y: MAP_HEIGHT/2 + 540 }
// The web store asserts this equality at module load (dev) — see game.ts.
// ---------------------------------------------------------------------------

/** World width in game-pixels (= MAP_COLS 576 × TILE_SIZE 32). */
export const WORLD_PX_WIDTH = 18432;
/** World height in game-pixels (= MAP_ROWS 576 × TILE_SIZE 32). */
export const WORLD_PX_HEIGHT = 18432;

/**
 * Geometric center of the world in game-pixels. Maps to Three.js world origin
 * (0, 0) via `worldX = gameX - WORLD_PX_WIDTH/2`. Nori (the town guide) stands
 * at world (0, +400), i.e. game-px (9216, 9616).
 */
export const WORLD_CENTER_PX = { x: 9216, y: 9216 } as const;

/**
 * Canonical player spawn in game-pixels: world center X, 540 wu SOUTH of center
 * (world Z = +540). That is ~140 wu south of Nori (world Z = +400) and clear of
 * the town-directory sign (world Z = -120). This is the value every layer must
 * agree on:
 *   - web client: `apps/web/src/stores/game.ts` SPAWN_PX (computed from MAP_*).
 *   - API in-world fallback: `apps/api/src/routes/world.ts` TOWN_CENTER_X/Y.
 *   - DB column defaults: `avatars.position_x/y` (literals; migration 0002).
 */
export const SPAWN_PX = { x: 9216, y: 9756 } as const;
