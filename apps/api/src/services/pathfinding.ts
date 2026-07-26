/**
 * A* pathfinding for NPC navigation on a full-world tile grid (Phase 6.2, 2026-05-18;
 * grid grown 360 → 704 to span the whole 22528px world, P0 2026-07-01 — see COLS below).
 *
 * 2026-05-22: collider-aware rewrite. The previous version only blocked
 * BUILDING_TILE_ZONES with a fixed 11-tile pad — too narrow for the big
 * buildings (messaging-channels/api-integrations halfX=850 wu = 26.5 tiles)
 * and completely ignored the seven town-center prop AABBs (shisha-oasis,
 * bazaar-stall, auction-podium, quest-bounty-pavilion, marketplace-stall,
 * town-directory-sign, quest-npc, town-guide). NPCs would path THROUGH
 * those props, wedge against the server-side AABB clamp, and oscillate or
 * freeze.
 *
 * Now: every server collider from getServerColliders() is rasterized onto
 * the grid with its real half-extents plus a 4-tile safety margin. The
 * planner-side `isCollisionFreeWorld` + `findNearestWalkable` helpers let
 * the NPC simulation reject or snap candidate targets that pass the A* grid
 * check but still land inside an AABB (gap between coarse grid and the
 * pixel-accurate clamp).
 */

import {
  clampPosition2D,
  getServerColliders,
  WORLD_COLLIDER_MAP_HALF,
  WORLD_COLLIDER_TILE_SIZE,
  ENTITY_HALF_CHIBI,
} from '@clawville/shared';

const TILE = WORLD_COLLIDER_TILE_SIZE;
// P0 (2026-07-01) — grid grown 360 → FULL-WORLD (704) to fix a REAL bug
// (regress-auditor D3 baseline: enter_building on messaging-channels → null).
// The A* grid must span the whole 22528px world or any building beyond tile 360
// is unreachable. messaging-channels (Sandy's Treedome) sits at tile cx=482 /
// game-px (15200,11040) — ENTIRELY outside the old 360-tile grid, so findPath()
// clamped its endpoint to the grid edge (tile 359 ≈ 11488px), routing the body
// to the wrong place and returning no usable path → enter_building failed.
// DERIVED (drift-proof) from the shared world dims, NOT a literal: the harness/
// design-doc "576" is STALE — it predates the 2026-06-24 576→704 world grow
// (tilemap-data.ts MAP_COLS is 704 now; WORLD_COLLIDER_MAP_HALF is 11264). Tying
// the grid to (MAP_HALF*2)/TILE — the exact world-space `worldToTile` maps into —
// means it can NEVER drift from the world again and exactly covers every collider.
// SAFE for existing NPC pathing: the grid is built ONCE (getGrid memoizes), every
// access is bounds-checked, rasterization cost is collider-count-bound (not
// grid-area), and every tile in the old [0,360) region keeps an identical
// walkability value (same colliders, same worldToTile) — so paths that already
// worked are byte-identical; the change only ADDS reachability past tile 360.
const COLS = (WORLD_COLLIDER_MAP_HALF * 2) / TILE; // 22528 / 32 = 704 (full world)
const ROWS = COLS;

/** Extra tile padding added around every rasterized collider. Buffers the A*
 *  grid against the visible wall so NPCs don't pathfind to a tile that sits
 *  exactly at the AABB boundary (where the clamp then keeps shoving them
 *  back, oscillating). 4 tiles = 128 wu — enough that the clearance(3) check
 *  on candidate targets still has slack. */
const COLLIDER_SAFETY_TILES = 4;

/** Tile cost converters (world-space ↔ tile-index). */
function worldToTile(coord: number): number {
  // worldCoord in wu (centered at 0) → game-px (centered at MAP_HALF) → tile
  return Math.floor((coord + WORLD_COLLIDER_MAP_HALF) / TILE);
}

export interface PathNode {
  x: number; // pixel coord
  y: number; // pixel coord
}

/** Compute walkability grid: true = walkable, false = blocked.
 *
 *  Source of truth: getServerColliders() returns every building + prop
 *  AABB used by clampPosition2D at movement time. We rasterize each
 *  AABB's full extents onto the grid plus COLLIDER_SAFETY_TILES.
 *
 *  Skips walkable=true zones (lifting platforms, currently unused on the
 *  server) — those don't block XZ travel. */
function buildWalkabilityGrid(): boolean[][] {
  const grid: boolean[][] = [];
  for (let r = 0; r < ROWS; r++) {
    grid[r] = [];
    for (let c = 0; c < COLS; c++) {
      grid[r][c] = true;
    }
  }

  const colliders = getServerColliders();
  for (let i = 0; i < colliders.length; i++) {
    const col = colliders[i]!;
    if (col.walkable) continue;

    if (col.pathfindingRaster?.mode === 'cell-center-expanded-aabb') {
      // Mark a cell iff its CENTER intersects the collider expanded by the
      // typed per-collider padding. This is the exact Minkowski raster needed
      // by 128-wu maze lanes: +50 wu for the widest live body class
      // (humanoid), without the legacy +128 wu safety halo that would erase
      // every passage.
      const padding = col.pathfindingRaster.paddingWu;
      const minWorldX = col.centerX - col.halfX - padding;
      const maxWorldX = col.centerX + col.halfX + padding;
      const minWorldZ = col.centerZ - col.halfZ - padding;
      const maxWorldZ = col.centerZ + col.halfZ + padding;
      const c0 = Math.ceil((minWorldX + WORLD_COLLIDER_MAP_HALF - TILE / 2) / TILE);
      const c1 = Math.floor((maxWorldX + WORLD_COLLIDER_MAP_HALF - TILE / 2) / TILE);
      const r0 = Math.ceil((minWorldZ + WORLD_COLLIDER_MAP_HALF - TILE / 2) / TILE);
      const r1 = Math.floor((maxWorldZ + WORLD_COLLIDER_MAP_HALF - TILE / 2) / TILE);

      for (let r = r0; r <= r1; r++) {
        if (r < 0 || r >= ROWS) continue;
        const rowArr = grid[r]!;
        for (let c = c0; c <= c1; c++) {
          if (c < 0 || c >= COLS) continue;
          rowArr[c] = false;
        }
      }
      continue;
    }

    // Legacy path, intentionally byte-for-byte unchanged for every existing
    // building/prop: center tile plus ceil(real half-extent) and 4 safety tiles.
    const cTileX = worldToTile(col.centerX);
    const cTileZ = worldToTile(col.centerZ);
    const halfTileX = Math.ceil(col.halfX / TILE) + COLLIDER_SAFETY_TILES;
    const halfTileZ = Math.ceil(col.halfZ / TILE) + COLLIDER_SAFETY_TILES;

    const r0 = cTileZ - halfTileZ;
    const r1 = cTileZ + halfTileZ;
    const c0 = cTileX - halfTileX;
    const c1 = cTileX + halfTileX;
    for (let r = r0; r <= r1; r++) {
      if (r < 0 || r >= ROWS) continue;
      const rowArr = grid[r]!;
      for (let c = c0; c <= c1; c++) {
        if (c < 0 || c >= COLS) continue;
        rowArr[c] = false;
      }
    }
  }

  return grid;
}

// Cache the grid since it never changes
let cachedGrid: boolean[][] | null = null;
function getGrid(): boolean[][] {
  if (!cachedGrid) cachedGrid = buildWalkabilityGrid();
  return cachedGrid;
}

/**
 * Returns true if the given world-pixel coord is walkable AND has clearance
 * of `margin` tiles from any blocked tile. Used to reject wander targets
 * that land right at a building's exclusion boundary — NPCs otherwise
 * pathfind to that edge and stop there (cluster against building walls).
 */
export function hasClearance(x: number, y: number, margin: number = 3): boolean {
  const grid = getGrid();
  const c = Math.floor(x / TILE);
  const r = Math.floor(y / TILE);
  for (let dr = -margin; dr <= margin; dr++) {
    for (let dc = -margin; dc <= margin; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) return false;
      if (!grid[rr]![cc]) return false;
    }
  }
  return true;
}

/**
 * Test whether a game-pixel target lies OUTSIDE every world-collider AABB
 * (with the entity's own half-width expanding each collider via Minkowski
 * sum, matching clampPosition2D's semantics). This catches targets that
 * pass the coarse A* grid check but still sit inside a clamped AABB
 * (e.g. inside the per-axis pad-vs-extent gap exposed by RCA gap #2).
 *
 * Caller passes GAME-PIXEL coords (NPC sim coords). We convert to centered
 * world-space internally before consulting clampPosition2D.
 */
export function isCollisionFreeWorld(
  gamePxX: number,
  gamePxY: number,
  entityHalf: number = ENTITY_HALF_CHIBI,
): boolean {
  const wx = gamePxX - WORLD_COLLIDER_MAP_HALF;
  const wz = gamePxY - WORLD_COLLIDER_MAP_HALF;
  const clamped = clampPosition2D(wx, wz, entityHalf);
  return !clamped.hit;
}

/**
 * Test a pixel-space segment against the same AABB clamp used by movement.
 * A* validates tile nodes, but any segment from the live position to a waypoint
 * can still cross an AABB edge; reject those paths up front.
 */
export function isSegmentCollisionFree(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  entityHalf: number = ENTITY_HALF_CHIBI,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.ceil(dist / (TILE / 2)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = ax + dx * t;
    const y = ay + dy * t;
    if (!isCollisionFreeWorld(x, y, entityHalf)) return false;
  }
  return true;
}

export function isPathCollisionFree(
  startX: number,
  startY: number,
  path: readonly PathNode[],
  entityHalf: number = ENTITY_HALF_CHIBI,
): boolean {
  let ax = startX;
  let ay = startY;
  for (const wp of path) {
    if (!isSegmentCollisionFree(ax, ay, wp.x, wp.y, entityHalf)) return false;
    ax = wp.x;
    ay = wp.y;
  }
  return true;
}

interface AStarNode {
  col: number;
  row: number;
  g: number; // cost from start
  h: number; // heuristic to end
  f: number; // g + h
  parent: AStarNode | null;
}

/** Manhattan distance heuristic */
function heuristic(c1: number, r1: number, c2: number, r2: number): number {
  return Math.abs(c1 - c2) + Math.abs(r1 - r2);
}

/** Min-heap priority queue for A* */
class MinHeap {
  private items: AStarNode[] = [];

  get size() { return this.items.length; }

  push(node: AStarNode) {
    this.items.push(node);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): AStarNode | undefined {
    if (this.items.length === 0) return undefined;
    const min = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.sinkDown(0);
    }
    return min;
  }

  private bubbleUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[i]!.f >= this.items[parent]!.f) break;
      [this.items[i], this.items[parent]] = [this.items[parent]!, this.items[i]!];
      i = parent;
    }
  }

  private sinkDown(i: number) {
    const len = this.items.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < len && this.items[left]!.f < this.items[smallest]!.f) smallest = left;
      if (right < len && this.items[right]!.f < this.items[smallest]!.f) smallest = right;
      if (smallest === i) break;
      [this.items[i], this.items[smallest]] = [this.items[smallest]!, this.items[i]!];
      i = smallest;
    }
  }
}

// 4-directional neighbors
const DIRS = [
  [0, -1], [0, 1], [-1, 0], [1, 0],
  // diagonals (optional — cost sqrt(2))
  [-1, -1], [-1, 1], [1, -1], [1, 1],
];

/**
 * Find a path from pixel (startX, startY) to pixel (endX, endY).
 * Returns pixel-coord waypoints, or empty array if no path found.
 */
/**
 * Test/ops observability for A* volume (2026-07-26). `findPath` was measured at
 * 165-258 ms per call on the town graph, and the 200 ms sim tick shares the Bun
 * event loop with SSE and HTTP — so "which code paths call A*, and how often" is
 * a load-bearing invariant, not a nice-to-have. `npc-directed-route.test.ts`
 * asserts that `moveNpcs()` performs EXACTLY ZERO invocations.
 */
let findPathCalls = 0;
export function getFindPathCallCount(): number { return findPathCalls; }
export function resetFindPathCallCount(): void { findPathCalls = 0; }

export function findPath(startX: number, startY: number, endX: number, endY: number): PathNode[] {
  findPathCalls++;
  const grid = getGrid();

  // Convert pixel to tile coords
  const sc = Math.floor(startX / TILE);
  const sr = Math.floor(startY / TILE);
  const ec = Math.floor(endX / TILE);
  const er = Math.floor(endY / TILE);

  // Clamp to grid
  let startCol = Math.max(0, Math.min(COLS - 1, sc));
  let startRow = Math.max(0, Math.min(ROWS - 1, sr));
  let endCol = Math.max(0, Math.min(COLS - 1, ec));
  let endRow = Math.max(0, Math.min(ROWS - 1, er));

  // If start is blocked, hop to nearest walkable tile. Observed 2026-04-24:
  // NPCs that wandered into a 32-tile-wide building exclusion zone got
  // stranded — A* expands only into walkable neighbors, so a blocked-start
  // deep inside an exclusion zone has zero reachable neighbors and returns
  // empty. Treating a blocked start the same as a blocked end unsticks
  // NPCs automatically on their next plan tick.
  if (!grid[startRow]![startCol]) {
    const nearest = findNearestWalkableTile(startCol, startRow, grid);
    if (!nearest) return [];
    startCol = nearest.col;
    startRow = nearest.row;
  }

  // If end is blocked, find nearest walkable tile
  if (!grid[endRow]![endCol]) {
    const nearest = findNearestWalkableTile(endCol, endRow, grid);
    if (!nearest) return [];
    endCol = nearest.col;
    endRow = nearest.row;
  }

  if (startCol === endCol && startRow === endRow) {
    return [{ x: endX, y: endY }];
  }

  const open = new MinHeap();
  const closed = new Set<string>();
  const key = (c: number, r: number) => `${c},${r}`;

  const startNode: AStarNode = {
    col: startCol, row: startRow,
    g: 0, h: heuristic(startCol, startRow, endCol, endRow),
    f: heuristic(startCol, startRow, endCol, endRow),
    parent: null,
  };
  open.push(startNode);

  const gScores = new Map<string, number>();
  gScores.set(key(startCol, startRow), 0);

  let iterations = 0;
  // Safety cap on A* expansion — sized for the town-nav workload, NOT grid area.
  // 2026-07-04 (P3 slice-2 debug): the old 6000 cap was WRONG — it silently broke
  // 16 of the 100 building→building autonomous nav paths (measured). A* does NOT
  // just "explore toward the goal": every concave collider pocket (the town-center
  // prop cluster + the building ring) forces a wide frontier, so a cross-ring
  // target expands FAR more than its path length. Measured worst-case reachable
  // pair deployment-ops→mcp-tool-use needs 63,275 pops (path len ~267); memory-rag
  // from app-publishing needs ~12k. All 100 pairs ARE reachable — they only failed
  // because the cap fired first (findPath returned [] → the autonomous avatar could
  // never walk to memory-rag / mcp-tool-use, and a directive naming those buildings
  // produced no visible bias). Raised to cover the measured max with margin. This
  // path is called only at planning decision points (behaviorCooldown≈50s apart per
  // avatar), never per-tick, and the grid is memoized, so the worst-case cost is a
  // rare one-off — but it IS a bigger single A* run, so it is perf-flagged for the
  // world-presence owner (a corner-to-corner pathological request can still cap and
  // re-plan next tick, as before).
  const maxIterations = 80_000; // data-justified: measured building-nav max 63,275 pops

  while (open.size > 0 && iterations < maxIterations) {
    iterations++;
    const current = open.pop()!;
    const ck = key(current.col, current.row);

    if (current.col === endCol && current.row === endRow) {
      // Reconstruct path
      return reconstructPath(current, endX, endY);
    }

    if (closed.has(ck)) continue;
    closed.add(ck);

    for (const [dc, dr] of DIRS) {
      const nc = current.col + dc!;
      const nr = current.row + dr!;

      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      if (!grid[nr]![nc]) continue;
      if (closed.has(key(nc, nr))) continue;

      // Diagonal movement: check that both adjacent cardinal tiles are walkable
      if (dc !== 0 && dr !== 0) {
        if (!grid[current.row + dr!]![current.col] || !grid[current.row]![current.col + dc!]) continue;
      }

      const moveCost = (dc !== 0 && dr !== 0) ? 1.41 : 1;
      const tentG = current.g + moveCost;
      const nk = key(nc, nr);
      const existingG = gScores.get(nk);

      if (existingG !== undefined && tentG >= existingG) continue;

      gScores.set(nk, tentG);
      const h = heuristic(nc, nr, endCol, endRow);
      open.push({
        col: nc, row: nr,
        g: tentG, h, f: tentG + h,
        parent: current,
      });
    }
  }

  return []; // no path found
}

function reconstructPath(end: AStarNode, targetX: number, targetY: number): PathNode[] {
  const tilePath: AStarNode[] = [];
  let node: AStarNode | null = end;
  while (node) {
    tilePath.unshift(node);
    node = node.parent;
  }

  // Convert to pixel coords (tile center). Keep the raw A* waypoints rather
  // than direction-smoothing them: smoothed diagonals can create long segments
  // that cross between blocked AABB cells even when every tile node is valid.
  const pixelPath: PathNode[] = tilePath.map((n) => ({
    x: n.col * TILE + TILE / 2,
    y: n.row * TILE + TILE / 2,
  }));

  // Replace final waypoint with exact target position
  if (pixelPath.length > 0) {
    pixelPath[pixelPath.length - 1] = { x: targetX, y: targetY };
  }

  return pixelPath;
}

function findNearestWalkableTile(col: number, row: number, grid: boolean[][]): { col: number; row: number } | null {
  // Per-collider half-extents now feed the grid (2026-05-22). The biggest
  // building (messaging-channels) is halfX=850 wu = ceil(850/32)+4 = 31 tiles
  // half-extent. From a deep-center blocked tile the nearest walkable tile is
  // 31 tiles away. Old hard-coded 20 became too small once we rasterized real
  // extents — every messaging-channels-target was failing. 40 covers every
  // current collider with safety margin and is still <2 ms in the worst case.
  const maxRadius = 40;
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
        const nc = col + dc;
        const nr = row + dr;
        if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS && grid[nr]![nc]) {
          return { col: nc, row: nr };
        }
      }
    }
  }
  return null;
}

/**
 * Snap a candidate game-pixel target outward (spiral search) until we find
 * a point that passes BOTH the A* grid clearance check AND the
 * pixel-accurate AABB clamp test. Used by NPC planners to recover when a
 * first-choice target falls inside a collider — without this, the planner
 * would either reject the candidate (and burn its attempt budget) or
 * commit to a path whose final waypoint is unreachable.
 *
 * Returns the snapped game-px coord or null if nothing usable inside
 * `maxRadiusPx` (default 600 wu ≈ 18.75 tiles — large enough to escape any
 * prop AABB; small enough that the snapped point is still meaningfully
 * "near" the requested target).
 */
export function findNearestWalkable(
  gamePxX: number,
  gamePxY: number,
  entityHalf: number = ENTITY_HALF_CHIBI,
  maxRadiusPx: number = 600,
): { x: number; y: number } | null {
  // Quick win if the input is already valid.
  if (hasClearance(gamePxX, gamePxY, 3) && isCollisionFreeWorld(gamePxX, gamePxY, entityHalf)) {
    return { x: gamePxX, y: gamePxY };
  }

  const stepPx = TILE; // search at tile resolution
  const maxRadiusTiles = Math.ceil(maxRadiusPx / stepPx);
  // 8 cardinal+diagonal directions — same compass as DIRS above but typed
  // as (dx, dy) tile offsets. Per-tick allocations are unavoidable here
  // (planner-only, runs at most a few times per second across all NPCs).
  const DXY = [
    [0, -1], [1, -1], [1, 0], [1, 1],
    [0, 1], [-1, 1], [-1, 0], [-1, -1],
  ];

  for (let radius = 1; radius <= maxRadiusTiles; radius++) {
    // Walk the perimeter of the radius=N square. For each direction,
    // jitter the inner offset across [-radius, radius] so we cover the
    // whole ring rather than just 8 specific points.
    for (let i = 0; i < DXY.length; i++) {
      const dx = DXY[i]![0]!;
      const dy = DXY[i]![1]!;
      for (let offset = -radius; offset <= radius; offset++) {
        // Build a (dx*radius, dy*radius) ring-cell with offset on the
        // tangential axis. For pure cardinal (dx=0 OR dy=0) the offset
        // walks along the opposite axis; for diagonals it walks both.
        let tx: number;
        let ty: number;
        if (dx === 0) {
          tx = gamePxX + offset * stepPx;
          ty = gamePxY + dy * radius * stepPx;
        } else if (dy === 0) {
          tx = gamePxX + dx * radius * stepPx;
          ty = gamePxY + offset * stepPx;
        } else {
          tx = gamePxX + dx * radius * stepPx;
          ty = gamePxY + dy * radius * stepPx + offset * stepPx;
        }
        // Out-of-bounds map test — leave a 32 px margin off each edge.
        if (tx < 32 || tx > COLS * TILE - 32) continue;
        if (ty < 32 || ty > ROWS * TILE - 32) continue;
        if (!hasClearance(tx, ty, 3)) continue;
        if (!isCollisionFreeWorld(tx, ty, entityHalf)) continue;
        return { x: tx, y: ty };
      }
    }
  }
  return null;
}
